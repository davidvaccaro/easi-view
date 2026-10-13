import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeNative, defaultWindow } from '../src/data/native.js';

function packed(values, { bitsAllocated = 16, bitsStored = 12, highBit = 14, littleEndian = true, noise = 0 } = {}) {
    const bytes = new Uint8Array(values.length * bitsAllocated / 8);
    const view = new DataView(bytes.buffer);
    values.forEach((value, i) => {
        const raw = ((value < 0 ? value + 2 ** bitsStored : value) << (highBit + 1 - bitsStored)) | noise;
        if (bitsAllocated === 8) view.setUint8(i, raw);
        else view.setUint16(i * 2, raw, littleEndian);
    });
    return bytes;
}

for (const littleEndian of [true, false]) {
    test(`signed 12-bit samples with HighBit14 and unused bits (${littleEndian ? 'LE' : 'BE'})`, () => {
        const values = [-2048, -1, 0, 2047];
        const bytes = packed(values, { littleEndian, noise: 0x8007 });
        const decoded = decodeNative(bytes, { rows: 2, columns: 2, bitsAllocated: 16, bitsStored: 12, highBit: 14, signed: true,
            littleEndian, slope: 2, intercept: -1000 });
        assert.ok(decoded.samples instanceof Int16Array);
        assert.deepEqual([...decoded.samples], values);
        assert.deepEqual(decoded.range, { min: -5096, max: 3094 });
        // Scalar samples remain in their stored domain; the display transform is separate.
        assert.equal(decoded.samples[2], 0);
    });
}

test('unsigned 16-bit range, negative slope, and signed 8-bit pixels', () => {
    const unsigned = decodeNative(packed([0, 65535], { bitsStored: 16, highBit: 15 }), {
        rows: 1, columns: 2, bitsAllocated: 16, bitsStored: 16, highBit: 15, signed: false, slope: -0.5, intercept: 20
    });
    assert.deepEqual([...unsigned.samples], [0, 65535]);
    assert.deepEqual(unsigned.range, { min: -32747.5, max: 20 });
    const signed = decodeNative(new Uint8Array([128, 255, 0, 127]), {
        rows: 2, columns: 2, bitsAllocated: 8, bitsStored: 8, highBit: 7, signed: true
    });
    assert.deepEqual([...signed.samples], [-128, -1, 0, 127]);
});

test('padding interval is excluded from auto-window range without changing samples', () => {
    const values = [-2048, -2047, 0, 100];
    const result = decodeNative(packed(values, { highBit: 11 }), {
        rows: 2, columns: 2, bitsAllocated: 16, bitsStored: 12, highBit: 11, signed: true,
        slope: 2, intercept: -1000, padding: { value: -2048, limit: -2047 }
    });
    assert.deepEqual([...result.samples], values);
    assert.deepEqual(result.range, { min: -1000, max: -800 });
    assert.deepEqual(defaultWindow(result.range), { center: -899.5, width: 201 });
    assert.deepEqual(defaultWindow(result.range, 'LINEAR_EXACT'), { center: -900, width: 200 });
});

test('invalid native layouts, byte lengths, and rescale transforms fail', () => {
    const metadata = { rows: 1, columns: 1, bitsAllocated: 16, bitsStored: 12, highBit: 11, signed: false };
    assert.throws(() => decodeNative(new Uint8Array(1), metadata), /byte length/);
    assert.throws(() => decodeNative(new Uint8Array(2), { ...metadata, highBit: 10 }), /bit layout/);
    assert.throws(() => decodeNative(new Uint8Array(2), { ...metadata, slope: 0 }), /rescale/);
});
