export const MAX_ENCAPSULATED_BYTES = 256 * 1024 * 1024;
export const MAX_ENCAPSULATED_FRAGMENTS = 65536;
export const RLE_TRANSFER_SYNTAX = '1.2.840.10008.1.2.5';
export const PIXEL_ENCODING_ERROR_CODE = 'EASI_PIXEL_ENCODING_PROFILE';
export const JPEG_ALIGNMENT_WARNING = 'This source contains a nonstandard single JPEG alignment byte after a validated end marker. Original DICOM bytes are unchanged.';
const JPEG_SYNTAXES = new Set(['1.2.840.10008.1.2.4.50', '1.2.840.10008.1.2.4.51',
    '1.2.840.10008.1.2.4.57', '1.2.840.10008.1.2.4.70', '1.2.840.10008.1.2.4.80', '1.2.840.10008.1.2.4.81']);
const J2K_SYNTAXES = new Set(['1.2.840.10008.1.2.4.90', '1.2.840.10008.1.2.4.91']);
const JLS_SYNTAXES = new Set(['1.2.840.10008.1.2.4.80', '1.2.840.10008.1.2.4.81']);

export function pixelEncodingError(message) {
    const error = new Error(message);
    error.code = PIXEL_ENCODING_ERROR_CODE;
    return error;
}
function invalid(message) { return pixelEncodingError(`Invalid encapsulated Pixel Data: ${message}.`); }
function jpegPadByte(value) { return value === 0 || value === 0xFF; }

function bytesOf(input) {
    const value = typeof input?.access === 'function' ? input.access() : input;
    if (value instanceof Uint8Array) return value;
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    throw invalid('a materialized byte array is required');
}

function extendedTable(input, count, label) {
    if (Array.isArray(input)) {
        if (input.length !== count) throw invalid(`${label} count does not match Number of Frames`);
        return input.map(value => {
            if ((typeof value !== 'number' && typeof value !== 'bigint') || value < 0 ||
                value > Number.MAX_SAFE_INTEGER || (typeof value === 'number' && !Number.isSafeInteger(value))) {
                throw invalid(`${label} contains an unsafe offset or length`);
            }
            return Number(value);
        });
    }
    const bytes = bytesOf(input);
    if (bytes.byteLength !== count * 8) throw invalid(`${label} count does not match Number of Frames`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return Array.from({ length: count }, (_, index) => {
        const value = view.getBigUint64(index * 8, true);
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid(`${label} contains an unsafe offset or length`);
        return Number(value);
    });
}

/** Byte cursor across fragments; marker payloads are skipped by their declared lengths. */
class JpegCursor {
    constructor(fragments, bytes, start, stop) {
        this.fragments = fragments; this.bytes = bytes; this.index = start; this.stop = stop; this.offset = 0; this.position = 0;
    }
    read() {
        while (this.index < this.stop && this.offset === this.fragments[this.index].length) { this.index++; this.offset = 0; }
        if (this.index >= this.stop) throw invalid('a JPEG frame is incomplete');
        this.position++;
        return this.bytes[this.fragments[this.index].start + this.offset++];
    }
    skip(length) {
        while (length > 0) {
            if (this.index >= this.stop) throw invalid('a JPEG marker payload is truncated');
            const available = this.fragments[this.index].length - this.offset;
            const step = Math.min(available, length);
            this.offset += step; this.position += step; length -= step;
            if (length > 0 && this.offset === this.fragments[this.index].length) { this.index++; this.offset = 0; }
        }
    }
}

function jpegBoundary(fragments, bytes, start, stop, jpegLs = false) {
    const cursor = new JpegCursor(fragments, bytes, start, stop);
    if (cursor.read() !== 0xFF || cursor.read() !== 0xD8) throw invalid('a JPEG frame must start with SOI at a fragment boundary');
    let pending = null;
    while (true) {
        let marker = pending;
        pending = null;
        if (marker == null) {
            if (cursor.read() !== 0xFF) throw invalid('a JPEG marker is malformed');
            do { marker = cursor.read(); } while (marker === 0xFF);
        }
        if (marker === 0xD9) {
            const fragment = fragments[cursor.index];
            const remaining = fragment.length - cursor.offset;
            // Accept only the one alignment byte required by an odd-length
            // codestream in its final even-length fragment. Some legacy writers
            // leave that byte uninitialized; its value cannot extend the frame.
            if (remaining !== 0 && !(remaining === 1 && cursor.position % 2 === 1)) {
                throw invalid('a JPEG frame ends inside a fragment with extra data');
            }
            return { stop: cursor.index + 1, trim: remaining,
                encodingWarnings: remaining && !jpegPadByte(bytes[fragment.start + cursor.offset]) ? [JPEG_ALIGNMENT_WARNING] : [] };
        }
        if (marker === 0xD8 || marker === 0 || (marker >= 0xD0 && marker <= 0xD7) || marker < 0xC0 && marker !== 1) {
            throw invalid('a JPEG frame contains an unexpected marker');
        }
        if (marker === 1) continue; // TEM has no marker payload.
        const length = cursor.read() * 256 + cursor.read();
        if (length < 2) throw invalid('a JPEG marker length is invalid');
        cursor.skip(length - 2);
        if (marker !== 0xDA) continue;
        // Entropy bytes use FF00 stuffing and standalone restart markers.
        while (true) {
            if (cursor.read() !== 0xFF) continue;
            let code;
            do { code = cursor.read(); } while (code === 0xFF);
            if ((jpegLs ? code < 0x80 : code === 0) || code >= 0xD0 && code <= 0xD7) continue;
            pending = code;
            break;
        }
    }
}

/** Walk JPEG 2000 marker lengths and tile parts without treating opaque header payloads as markers. */
function j2kBoundary(fragments, bytes, start, stop) {
    const cursor = new JpegCursor(fragments, bytes, start, stop);
    if (cursor.read() !== 0xFF || cursor.read() !== 0x4F) throw invalid('a JPEG 2000 frame must start with SOC at a fragment boundary');
    const endByte = distance => {
        for (let fragment = stop - 1; fragment >= start; fragment--) {
            if (distance < fragments[fragment].length) return bytes[fragments[fragment].start + fragments[fragment].length - 1 - distance];
            distance -= fragments[fragment].length;
        }
        throw invalid('a JPEG 2000 codestream is truncated');
    };
    const trim = endByte(0) === 0 ? 1 : 0;
    if (endByte(trim) !== 0xD9 || endByte(trim + 1) !== 0xFF) throw invalid('a JPEG 2000 frame must end with EOC and at most one zero pad byte');
    const dataLength = fragments.slice(start, stop).reduce((sum, fragment) => sum + fragment.length, 0) - trim;
    let tileEnd = null, tileCount = 0, finalTile = false;
    while (true) {
        const markerStart = cursor.position;
        if (cursor.read() !== 0xFF) throw invalid('a JPEG 2000 marker is malformed');
        const marker = cursor.read();
        if (marker === 0xD9) {
            if (tileEnd !== null || tileCount === 0 || cursor.position !== dataLength) {
                throw invalid('JPEG 2000 EOC occurs before a complete frame boundary');
            }
            return { stop, trim };
        }
        if (marker === 0x93) {
            if (tileEnd === null || cursor.position > tileEnd) throw invalid('JPEG 2000 SOD has no bounded tile part');
            if (!finalTile) cursor.skip(tileEnd - cursor.position);
            else {
                // T.800 A.4.2 permits Psot=0 only for the last tile part. Its
                // packet data cannot contain FF90..FFFF except SOP/EPH markers
                // (A.8 and D.4); do not confuse stuffed bytes or SOP payloads
                // with an earlier EOC or another tile/codestream boundary.
                while (cursor.position < tileEnd) {
                    if (cursor.read() !== 0xFF) continue;
                    if (cursor.position >= tileEnd) throw invalid('JPEG 2000 final packet data is truncated');
                    const code = cursor.read();
                    if (code < 0x90 || code === 0x92) continue;
                    if (code !== 0x91 || cursor.position + 4 > tileEnd ||
                        cursor.read() !== 0 || cursor.read() !== 4) {
                        throw invalid('JPEG 2000 final packet data has an unexpected marker or SOP length');
                    }
                    cursor.skip(2); // Nsop is an opaque two-byte packet sequence number.
                }
            }
            tileEnd = null;
            continue;
        }
        if (marker === 0x4F || marker === 0x91 || marker === 0x92 || marker < 0x50 || marker > 0x90) {
            throw invalid('a JPEG 2000 frame contains an unexpected marker');
        }
        const length = cursor.read() * 256 + cursor.read();
        if (length < 2 || cursor.position + length - 2 > dataLength ||
            tileEnd !== null && cursor.position + length - 2 > tileEnd) throw invalid('a JPEG 2000 marker length exceeds its boundary');
        if (marker !== 0x90) { cursor.skip(length - 2); continue; }
        if (tileEnd !== null || length !== 10) throw invalid('a JPEG 2000 SOT segment is invalid');
        cursor.skip(2); // Tile index; image/header compatibility remains the codec's responsibility.
        const tileLength = cursor.read() * 0x1000000 + cursor.read() * 0x10000 + cursor.read() * 0x100 + cursor.read();
        cursor.skip(2); // Tile-part index and count.
        if (tileLength !== 0 && (tileLength < 14 || markerStart + tileLength > dataLength - 2)) {
            throw invalid('JPEG 2000 tile parts require a bounded Psot length');
        }
        finalTile = tileLength === 0;
        tileEnd = finalTile ? dataLength - 2 : markerStart + tileLength;
        tileCount++;
    }
}

/**
 * EASI JS 1.0.0 materializes undefined-length Pixel Data as raw Item headers and
 * values, including BOT but excluding the sequence delimiter. Build an owned,
 * bounded index; assemble only a requested multi-fragment JPEG frame. This is
 * indexing, not a compressed-codec or image-profile compatibility guarantee.
 */
export function indexEncapsulatedFrames(pixelAttribute, { frameCount, syntax,
    extendedOffsets, extendedLengths, maxBytes = MAX_ENCAPSULATED_BYTES,
    maxFragments = MAX_ENCAPSULATED_FRAGMENTS } = {}) {
    if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > 4096 ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ENCAPSULATED_BYTES ||
        !Number.isInteger(maxFragments) || maxFragments < 1 || maxFragments > MAX_ENCAPSULATED_FRAGMENTS) {
        throw invalid('the frame count or indexing budget is invalid');
    }
    const syntaxId = typeof syntax === 'string' ? syntax : syntax?.ID ?? pixelAttribute?.transferSyntax?.ID;
    const rle = syntaxId === RLE_TRANSFER_SYNTAX;
    const j2k = J2K_SYNTAXES.has(syntaxId), jpegLs = JLS_SYNTAXES.has(syntaxId);
    if (!rle && !j2k && !JPEG_SYNTAXES.has(syntaxId)) throw invalid('this transfer syntax has no supported frame indexer');
    if (typeof pixelAttribute?.access === 'function' &&
        (pixelAttribute.valueLength !== 0xFFFFFFFF || pixelAttribute.isComplete !== true)) {
        throw invalid('complete undefined-length Pixel Data is required');
    }
    const raw = bytesOf(pixelAttribute);
    if (!raw.byteLength || raw.byteLength > maxBytes) throw invalid('the encoded bytes exceed the indexing budget');
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const fragments = [];
    let cursor = 0, bot = null, firstFragment = null;
    while (cursor < raw.byteLength) {
        if (cursor + 8 > raw.byteLength) throw invalid('an Item header is truncated');
        const group = view.getUint16(cursor, true), element = view.getUint16(cursor + 2, true);
        const length = view.getUint32(cursor + 4, true);
        if (group === 0xFFFE && element === 0xE0DD) {
            if (length !== 0 || cursor + 8 !== raw.byteLength) throw invalid('the sequence delimiter is invalid');
            cursor += 8; break;
        }
        if (group !== 0xFFFE || element !== 0xE000 || length === 0xFFFFFFFF || cursor + 8 + length > raw.byteLength) {
            throw invalid('an Item tag or explicit length is invalid');
        }
        if (bot === null) {
            if (length % 4 !== 0) throw invalid('the Basic Offset Table length is invalid');
            bot = raw.subarray(cursor + 8, cursor + 8 + length);
        } else {
            if (length < 2 || length % 2 !== 0 || fragments.length >= maxFragments) throw invalid('a fragment length or fragment count is invalid');
            firstFragment ??= cursor;
            fragments.push({ offset: cursor - firstFragment, start: cursor + 8, length });
        }
        cursor += 8 + length;
    }
    if (bot === null || !fragments.length) throw invalid('the Basic Offset Table Item or image fragments are missing');
    const offsets = new Map(fragments.map((fragment, index) => [fragment.offset, index]));
    const groups = [];
    const hasExtended = extendedOffsets != null || extendedLengths != null;
    if (hasExtended) {
        if (extendedOffsets == null || extendedLengths == null || bot.byteLength !== 0) throw invalid('Extended Offset Tables require paired tables and an empty BOT');
        const starts = extendedTable(extendedOffsets, frameCount, 'Extended Offset Table');
        const lengths = extendedTable(extendedLengths, frameCount, 'Extended Offset Table Lengths');
        if (fragments.length !== frameCount) throw invalid('Extended Offset Tables require exactly one fragment per frame');
        for (let frame = 0; frame < frameCount; frame++) {
            if (starts[frame] !== fragments[frame].offset || lengths[frame] < 1 ||
                lengths[frame] + lengths[frame] % 2 !== fragments[frame].length ||
                (lengths[frame] % 2 && !JPEG_SYNTAXES.has(syntaxId) && raw[fragments[frame].start + lengths[frame]] !== 0)) {
                throw invalid('an Extended Offset Table entry does not match its fragment or padding');
            }
            groups.push({ start: frame, stop: frame + 1, trim: fragments[frame].length - lengths[frame] });
        }
    } else if (bot.byteLength) {
        if (bot.byteLength !== frameCount * 4) throw invalid('the BOT count does not match Number of Frames');
        const table = new DataView(bot.buffer, bot.byteOffset, bot.byteLength);
        const starts = Array.from({ length: frameCount }, (_, frame) => table.getUint32(frame * 4, true));
        for (let frame = 0; frame < frameCount; frame++) {
            if ((frame === 0 && starts[frame] !== 0) || !offsets.has(starts[frame]) ||
                (frame > 0 && starts[frame] <= starts[frame - 1])) throw invalid('BOT offsets must identify increasing fragment Item tags');
            groups.push({ start: offsets.get(starts[frame]), stop: frame + 1 < frameCount ? offsets.get(starts[frame + 1]) : fragments.length, trim: 0 });
        }
    } else if (rle || j2k) {
        if (fragments.length !== frameCount) throw invalid(`${rle ? 'RLE' : 'Empty BOT JPEG 2000'} requires exactly one fragment per frame`);
        for (let frame = 0; frame < frameCount; frame++) groups.push({ start: frame, stop: frame + 1, trim: 0 });
    } else {
        let start = 0;
        while (start < fragments.length) {
            if (groups.length >= frameCount) throw invalid('JPEG fragments contain more frames than declared');
            const boundary = jpegBoundary(fragments, raw, start, fragments.length, jpegLs);
            groups.push({ start, ...boundary }); start = boundary.stop;
        }
        if (groups.length !== frameCount) throw invalid('JPEG frame boundaries do not match Number of Frames');
    }
    for (const group of groups) {
        if (!Number.isInteger(group.stop) || group.stop <= group.start || group.stop > fragments.length ||
            rle && group.stop !== group.start + 1) throw invalid('a frame has ambiguous or unsupported fragment boundaries');
        if (!rle) {
            const boundary = j2k ? j2kBoundary(fragments, raw, group.start, group.stop)
                : jpegBoundary(fragments, raw, group.start, group.stop, jpegLs);
            if (boundary.stop !== group.stop || hasExtended && boundary.trim !== group.trim) throw invalid('JPEG frame boundaries disagree with their offset table');
            group.trim = boundary.trim;
            group.encodingWarnings = boundary.encodingWarnings;
        }
    }
    const index = { bytes: raw.slice(), frames: [], disposed: false,
        encodingWarnings: [...new Set(groups.flatMap(group => group.encodingWarnings ?? []))],
        getFrame(frame) {
            if (this.disposed) throw new Error('This encapsulated frame index has been disposed.');
            const selected = this.frames[frame];
            if (!Number.isInteger(frame) || !selected) throw new RangeError('Select an available encapsulated frame.');
            if (selected.fragments.length === 1) return selected.fragments[0];
            const bytes = new Uint8Array(selected.byteLength);
            let offset = 0;
            for (const fragment of selected.fragments) { bytes.set(fragment, offset); offset += fragment.byteLength; }
            return bytes;
        },
        dispose() {
            if (this.disposed) return;
            this.disposed = true;
            for (const frame of this.frames) frame.fragments = [];
            this.frames.length = 0; this.bytes = new Uint8Array(0);
        }
    };
    index.frames = groups.map(group => {
        const pieces = fragments.slice(group.start, group.stop).map((fragment, position, all) =>
            index.bytes.subarray(fragment.start, fragment.start + fragment.length - (position === all.length - 1 ? group.trim : 0)));
        return { fragments: pieces, byteLength: pieces.reduce((sum, piece) => sum + piece.byteLength, 0) };
    });
    return index;
}
