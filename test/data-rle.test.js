import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRleFrame, MAX_RLE_OUTPUT_BYTES } from '../src/data/rle.js';
import { decodeNative } from '../src/data/native.js';

function frame(segments) {
    const padded = segments.map(bytes => {
        const result = new Uint8Array(bytes.length + bytes.length % 2); result.set(bytes); return result;
    });
    const result = new Uint8Array(64 + padded.reduce((sum, segment) => sum + segment.length, 0));
    const view = new DataView(result.buffer);
    view.setUint32(0, segments.length, true);
    let offset = 64;
    padded.forEach((segment, index) => { view.setUint32((index + 1) * 4, offset, true); result.set(segment, offset); offset += segment.length; });
    return result;
}
const mono = { rows: 1, columns: 4, bitsAllocated: 8, samplesPerPixel: 1, photometric: 'MONOCHROME2' };

test('RLE literal and repeat packets reconstruct each row without changing sample bytes', () => {
    const encoded = frame([[2, 1, 2, 3, 254, 4]]);
    assert.deepEqual([...decodeRleFrame(encoded, { ...mono, rows: 2, columns: 3 })], [1, 2, 3, 4, 4, 4]);
});

test('RLE high-byte-first segments become native little-endian signed 16-bit samples', () => {
    const encoded = frame([[3, 0x80, 0xFF, 0x12, 0], [3, 0, 0xFF, 0x34, 0]]);
    const metadata = { ...mono, bitsAllocated: 16, bitsStored: 16, highBit: 15, signed: true, littleEndian: true };
    const bytes = decodeRleFrame(encoded, metadata);
    assert.deepEqual([...bytes], [0, 0x80, 0xFF, 0xFF, 0x34, 0x12, 0, 0]);
    assert.deepEqual([...decodeNative(bytes, metadata).samples], [-32768, -1, 4660, 0]);
});

test('RLE preserves stored bit placement and unused bits for the independent native decoder', () => {
    const encoded = frame([[3, 0xC0, 0xFF, 0xBF, 0x80], [3, 7, 0xFF, 0xFF, 7]]);
    const metadata = { ...mono, bitsAllocated: 16, bitsStored: 12, highBit: 14, signed: true, littleEndian: true };
    const bytes = decodeRleFrame(encoded, metadata);
    assert.deepEqual([...bytes], [7, 0xC0, 0xFF, 0xFF, 0xFF, 0xBF, 7, 0x80]);
    assert.deepEqual([...decodeNative(bytes, metadata).samples], [-2048, -1, 2047, 0]);
});

test('RGB RLE component segments return canonical interleaved original channel bytes regardless of planar metadata', () => {
    const encoded = frame([[3, 255, 0, 0, 17], [3, 0, 255, 0, 31], [3, 0, 0, 255, 129]]);
    for (const planarConfiguration of [0, 1]) {
        assert.deepEqual([...decodeRleFrame(encoded, { ...mono, samplesPerPixel: 3, photometric: 'RGB', signed: false, planarConfiguration })],
            [255, 0, 0, 0, 255, 0, 0, 0, 255, 17, 31, 129]);
    }
});

test('YBR_FULL RLE returns component bytes without applying an implicit color or display transform', () => {
    const encoded = frame([[3, 10, 20, 30, 40], [3, 128, 128, 100, 100], [3, 128, 128, 200, 200]]);
    assert.deepEqual([...decodeRleFrame(encoded, { ...mono, samplesPerPixel: 3, photometric: 'YBR_FULL', signed: false })],
        [10, 128, 128, 20, 128, 128, 30, 100, 200, 40, 100, 200]);
});

test('PackBits -128 no-ops and only a final zero padding byte are permitted', () => {
    assert.deepEqual([...decodeRleFrame(frame([[128, 0, 99, 0]]), { ...mono, columns: 1 })], [99]);
    assert.deepEqual([...decodeRleFrame(frame([[0, 99, 128, 0]]), { ...mono, columns: 1 })], [99]);
});

test('PackBits supports the independent literal and repeat endpoints of 128 output samples', () => {
    const literals = [127, ...Array.from({ length: 128 }, (_, index) => index)];
    assert.deepEqual([...decodeRleFrame(frame([literals]), { ...mono, columns: 128 })], literals.slice(1));
    assert.deepEqual([...decodeRleFrame(frame([[129, 42]]), { ...mono, columns: 128 })], Array(128).fill(42));
});

for (const [name, segments, metadata, expected] of [
    ['literal truncation', [[2, 10]], { ...mono, columns: 3 }, /literal run is truncated/],
    ['repeat truncation', [[128, 255]], { ...mono, columns: 2 }, /repeated run is truncated/],
    ['decoded output overflow', [[3, 1, 2, 3, 4]], { ...mono, columns: 3 }, /output or row boundary/],
    ['row crossing', [[3, 1, 2, 3, 4]], { ...mono, rows: 2, columns: 2 }, /row boundary/],
    ['incomplete decoded plane', [[0, 99]], mono, /segment ends/],
    ['extra encoded samples', [[3, 1, 2, 3, 4, 0, 9]], mono, /extra encoded samples/],
    ['excess padding', [[2, 1, 2, 3, 0, 0]], { ...mono, columns: 3 }, /extra encoded samples/],
    ['unsupported color type', [[3, 1, 2, 3, 4]], { ...mono, photometric: 'YBR_PARTIAL_420' }, /byte layouts/],
    ['unsupported one-bit pixels', [[3, 1, 2, 3, 4]], { ...mono, bitsAllocated: 1 }, /byte layouts/],
    ['unsupported YBR_FULL_422', [[3, 1, 2, 3, 4]], { ...mono, samplesPerPixel: 3, photometric: 'YBR_FULL_422' }, /byte layouts/],
    ['invalid dimension', [[3, 1, 2, 3, 4]], { ...mono, rows: 0 }, /byte layouts/]
]) test(`malformed RLE rejects clearly: ${name}`, () => assert.throws(() => decodeRleFrame(frame(segments), metadata), expected));

test('RLE header counts, reserved offsets and all segment boundaries are validated', () => {
    const encoded = frame([[3, 1, 2, 3, 4]]);
    for (const [offset, value, expected] of [[0, 0, /segment count/], [4, 66, /offsets/], [8, 66, /unused/], [4, 1000, /offsets/]]) {
        const invalid = encoded.slice(); new DataView(invalid.buffer).setUint32(offset, value, true);
        assert.throws(() => decodeRleFrame(invalid, mono), expected);
    }
    assert.throws(() => decodeRleFrame(encoded.subarray(0, 63), mono), /64-byte header/);
    assert.throws(() => decodeRleFrame(encoded.subarray(0, encoded.length - 1), mono), /even lengths/);
    assert.throws(() => decodeRleFrame(encoded, mono, { maxOutputBytes: 3 }), /byte budget/);
    assert.throws(() => decodeRleFrame(encoded, mono, { maxOutputBytes: 0 }), /budget is invalid/);
    assert.equal(MAX_RLE_OUTPUT_BYTES, 64 * 1024 * 1024);
});
