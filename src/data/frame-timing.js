import { Tag } from '@xinonix/easi-js';

function invalid(message = 'Invalid or unsupported DICOM frame timing metadata.') { throw new Error(message); }
function attribute(set, id) { return set?.find?.(Tag.find(id)); }

function values(set, id) {
    const raw = attribute(set, id)?.value;
    if (raw == null || raw === '') return [];
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split('\\') : [raw];
    if (list.every(value => value == null || typeof value === 'string' && !value.trim())) return [];
    return list.map(value => {
        if (typeof value === 'string') {
            if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) invalid();
            value = Number(value);
        }
        if (typeof value !== 'number' || !Number.isFinite(value)) invalid();
        return value;
    });
}

function pointers(set, littleEndian) {
    const attr = attribute(set, '00280009');
    if (!attr) return [];
    const raw = attr.value;
    if (raw instanceof Uint8Array) {
        if (!raw.byteLength || raw.byteLength % 4 || raw.byteLength > 64) invalid();
        const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength), result = [];
        const endian = attr.transferSyntax?.IsLittleEndian ?? littleEndian;
        for (let offset = 0; offset < raw.byteLength; offset += 4) result.push(Tag.identifier(view.getUint16(offset, endian), view.getUint16(offset + 2, endian)));
        return result;
    }
    const list = Array.isArray(raw) ? raw : [raw];
    if (!list.length || list.length > 16 || list.some(value => typeof value !== 'string' || !/^[0-9a-fA-F]{8}$/.test(value))) invalid();
    return list.map(value => value.toUpperCase());
}

/** Retain recorded acquisition time separately from the display's chosen FPS. */
export function resolveFrameTiming(set, frameCount, { littleEndian = true } = {}) {
    if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > 4096 || typeof littleEndian !== 'boolean') invalid();
    const selected = pointers(set, littleEndian);
    const selectsFixed = selected.includes('00181063'), selectsVector = selected.includes('00181065');
    if (selectsFixed && selectsVector) invalid();
    // The Frame Increment Pointer selects the clock. An unused optional clock
    // must not invalidate the valid selected one, including malformed values.
    const fixed = selectsVector ? [] : values(set, '00181063');
    const vector = selectsFixed ? [] : values(set, '00181065');
    if (fixed.length > 1 || fixed.length && (fixed[0] < 0 || frameCount > 1 && fixed[0] === 0)) invalid();
    if (vector.length && (vector.length !== frameCount || vector[0] !== 0 || vector.slice(1).some(value => value <= 0))) invalid('Invalid DICOM Frame Time Vector metadata.');
    if (selectsFixed && !fixed.length || selectsVector && !vector.length) invalid();
    if (vector.length && !selectsVector && !selectsFixed) invalid();
    const mode = selectsVector ? 'vector' : fixed.length && (!selected.length || selectsFixed) ? 'fixed' : 'none';
    const frameTime = mode === 'fixed' ? fixed[0] : null;
    let offset = mode === 'none' ? null : 0;
    const frames = [];
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
        if (mode === 'vector') offset += vector[frameIndex];
        else if (mode === 'fixed') offset = frameIndex * frameTime;
        if (offset != null && (!Number.isFinite(offset) || offset > Number.MAX_SAFE_INTEGER)) invalid();
        frames.push({ frameIndex, timingMode: mode, acquisitionOffsetMs: offset,
            nextIntervalMs: mode === 'fixed' && frameTime > 0 ? frameTime :
                mode === 'vector' && frameIndex + 1 < frameCount ? vector[frameIndex + 1] : null });
    }
    return { mode, frameTime, frames };
}

function owner(frame) { return frame.sopUid ?? frame._record?.uid ?? null; }

/** Reordered spatial/temporal stacks cannot use the acquisition's native clock. */
export function nativePlaybackAvailable(frames) {
    if (!Array.isArray(frames) || frames.length < 2 || !['fixed', 'vector'].includes(frames[0]?.timingMode) || !owner(frames[0])) return false;
    const first = frames[0];
    return frames.every((frame, index) => frame.timingMode === first.timingMode && owner(frame) === owner(first) &&
        Number.isInteger(frame.frameIndex) && (!index || frame.frameIndex === frames[index - 1].frameIndex + 1) &&
        (index === frames.length - 1 && frame.timingMode === 'vector' || Number.isFinite(frame.nextIntervalMs) &&
            frame.nextIntervalMs > 0 && frame.nextIntervalMs <= 2147483647));
}

/** A vector has no declared final-to-first interval; native playback stops there. */
export function nativePlaybackInterval(frames, index) {
    if (!nativePlaybackAvailable(frames) || !Number.isInteger(index) || index < 0 || index >= frames.length) return null;
    if (index === frames.length - 1 && frames[index].timingMode === 'vector') return null;
    return frames[index].nextIntervalMs;
}
