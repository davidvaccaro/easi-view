// Scalar decoding is independent of display windowing and runs in a worker.
export function decodeNative(bytes, metadata) {
    const { rows, columns, bitsAllocated, bitsStored, highBit, signed, littleEndian = true,
        slope = 1, intercept = 0, padding = null } = metadata;
    if (![8, 16].includes(bitsAllocated) || !Number.isInteger(bitsStored) || bitsStored < 1 ||
        bitsStored > bitsAllocated || !Number.isInteger(highBit) || highBit < bitsStored - 1 || highBit >= bitsAllocated) {
        throw new Error('Unsupported or inconsistent native pixel bit layout.');
    }
    const count = rows * columns;
    if (!Number.isSafeInteger(count) || count <= 0 || bytes.byteLength !== count * bitsAllocated / 8) {
        throw new Error('The native frame byte length does not match its dimensions.');
    }
    if (!Number.isFinite(slope) || slope === 0 || !Number.isFinite(intercept)) {
        throw new Error('Invalid pixel rescale transform.');
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
        const scaled = value * slope + intercept;
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
