import { evaluateModality } from './presentation-math.js';
/** Native frames contain scalar samples or three unsigned byte RGB components. */
export function nativeFrameByteLength(metadata) {
    const { rows, columns, bitsAllocated, samplesPerPixel = 1, photometric = 'MONOCHROME2' } = metadata;
    if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows <= 0 || columns <= 0 || ![8, 16].includes(bitsAllocated)) {
        throw new Error('Unsupported native frame dimensions or pixel bit layout.');
    }
    const channels = photometric === 'RGB' ? 3 : 1;
    if (samplesPerPixel !== channels || !['MONOCHROME1', 'MONOCHROME2', 'RGB', 'PALETTE COLOR'].includes(photometric)) {
        throw new Error('Unsupported native photometric interpretation or Samples per Pixel.');
    }
    const bytes = rows * columns * channels * bitsAllocated / 8;
    if (!Number.isSafeInteger(bytes)) throw new Error('Invalid native frame byte length.');
    return bytes;
}

// Decoding preserves stored values and remains independent of scalar windowing.
export function decodeNative(bytes, metadata) {
    const { rows, columns, bitsAllocated, bitsStored, highBit, signed, littleEndian = true,
        slope = 1, intercept = 0, padding = null } = metadata;
    if (![8, 16].includes(bitsAllocated) || !Number.isInteger(bitsStored) || bitsStored < 1 ||
        bitsStored > bitsAllocated || !Number.isInteger(highBit) || highBit < bitsStored - 1 || highBit >= bitsAllocated) {
        throw new Error('Unsupported or inconsistent native pixel bit layout.');
    }
    const count = rows * columns;
    if (bytes.byteLength !== nativeFrameByteLength(metadata)) {
        throw new Error('The native frame byte length does not match its dimensions.');
    }
    if (!Number.isFinite(slope) || slope === 0 || !Number.isFinite(intercept)) {
        throw new Error('Invalid pixel rescale transform.');
    }
    if (metadata.photometric === 'RGB') {
        if (bitsAllocated !== 8 || bitsStored !== 8 || highBit !== 7 || signed !== false ||
            ![0, 1].includes(metadata.planarConfiguration) || slope !== 1 || intercept !== 0 || padding !== null) {
            throw new Error('Native RGB requires unsigned 8-bit channels, Planar Configuration 0 or 1, and no scalar transforms.');
        }
        const samples = new Uint8Array(count * 3);
        if (metadata.planarConfiguration === 0) samples.set(bytes);
        else {
            for (let index = 0; index < count; index++) {
                samples[index * 3] = bytes[index];
                samples[index * 3 + 1] = bytes[count + index];
                samples[index * 3 + 2] = bytes[count * 2 + index];
            }
        }
        return { samples, range: null };
    }
    const samples = signed ? new Int16Array(count) : new Uint16Array(count);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const shift = highBit + 1 - bitsStored;
    const mask = (2 ** bitsStored) - 1;
    const sign = 2 ** (bitsStored - 1);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < count; i++) {
        const raw = bitsAllocated === 8 ? view.getUint8(i) : view.getUint16(i * 2, littleEndian);
        let value = (raw >>> shift) & mask;
        if (signed && value >= sign) value -= 2 ** bitsStored;
        samples[i] = value;
        if (padding && value >= Math.min(padding.value, padding.limit) && value <= Math.max(padding.value, padding.limit)) continue;
        const scaled = evaluateModality(value, metadata);
        min = Math.min(min, scaled);
        max = Math.max(max, scaled);
    }
    if (min === Infinity) { min = 0; max = 0; }
    return { samples, range: { min, max } };
}

export function defaultWindow(range, voiFunction = 'LINEAR') {
    const span = range.max - range.min;
    return voiFunction === 'LINEAR_EXACT'
        ? { center: (range.min + range.max) / 2, width: Math.max(1, span) }
        : { center: (range.min + range.max + 1) / 2, width: Math.max(1, span + 1) };
}
