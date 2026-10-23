import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFrame } from '../src/data/compressed.js';
import { decodeWasmFrame } from '../src/data/wasm-codecs.js';
import { decodeNative } from '../src/data/native.js';
import { loadFiles } from '../src/data/sources.js';
import { createCompressedDicom, createEncapsulatedDicom } from './compressed-fixtures.js';

const extendedSyntax = '1.2.840.10008.1.2.4.51';
// Invented original rasters with four constant 8x8 blocks. References do not
// come from the production decoder or an original imaging corpus.
function blocks(levels) {
    return Array.from({ length: 256 }, (_, index) => levels[
        (Math.floor(index / 16) >= 8 ? 2 : 0) + (index % 16 >= 8 ? 1 : 0)]);
}
function marker(bytes, value) {
    for (let index = 0; index < bytes.length - 1; index++) {
        if (bytes[index] === 255 && bytes[index + 1] === value) return index;
    }
    throw new Error('Synthetic JPEG marker is missing.');
}
function changed(bytes, change) { const result = bytes.slice(); change(result); return result; }
function insertSegment(bytes, marker, payload) {
    const segment = Uint8Array.from([255, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255, ...payload]);
    const result = new Uint8Array(bytes.length + segment.length);
    result.set(bytes.subarray(0, 2)); result.set(segment, 2); result.set(bytes.subarray(2), 2 + segment.length);
    return result;
}

for (const precision of [8, 12]) for (const photometric of ['MONOCHROME1', 'MONOCHROME2']) {
    for (const allocation of precision === 8 ? [8, 16] : [16]) {
        test(`SOF1 unsigned${precision} ${photometric} preserves independently known samples in DICOM${allocation}`, async () => {
            const expected = blocks(precision === 8 ? [0, 63, 129, 255] : [0, 513, 2049, 4095]);
            const fixture = await createCompressedDicom({ codec: 'jpeg-extended', rows: 16, columns: 16,
                bitsAllocated: allocation, bitsStored: precision, photometric, frameSamples: [expected] });
            const encoded = fixture.frames[0];
            assert.equal(encoded[marker(encoded, 193) + 4], precision);
            const result = await decodeWasmFrame(encoded, fixture.metadata);
            const native = decodeNative(result.bytes, { ...fixture.metadata, ...result.metadataOverrides });
            assert.equal(result.bytes.byteLength, expected.length * allocation / 8);
            assert.ok(native.samples instanceof Uint16Array, 'Unsigned scalar samples use the existing canonical16-bit representation.');
            assert.deepEqual([...native.samples], expected);
            assert.equal(result.metadataOverrides.photometric, photometric);
            assert.equal(result.metadataOverrides.littleEndian, true);
            assert.deepEqual(result.metadataOverrides.encodingWarnings, []);
            if (precision === 12) {
                assert.equal(Math.max(...native.samples), 4095);
                assert.ok(native.samples.some(value => value > 255));
            }
        });
    }
}

test('Process4 lossy quantization keeps 12-bit range and the declared synthetic stored-sample tolerance', async () => {
    const expected = blocks([0, 513, 2049, 4095]);
    // Quantized DC = round(8*(sample-2048)/16): these chosen constant blocks
    // have at most one sample unit of rounding error, including integer IDCT.
    const tolerance = 1;
    const fixture = await createCompressedDicom({ codec: 'jpeg-extended', rows: 16, columns: 16,
        frameSamples: [expected], encoderOptions: { quantization: 16 } });
    const frame = await decodeFrame(fixture.frames[0], fixture.metadata);
    assert.ok(frame.samples instanceof Uint16Array);
    assert.equal(frame.samples.length, expected.length);
    for (let index = 0; index < expected.length; index++) assert.ok(Math.abs(frame.samples[index] - expected[index]) <= tolerance);
    assert.ok(Math.max(...frame.samples) > 4000);
    assert.equal(frame.range.max, 4095);
});

test('EASI native pipeline loads split-fragment Process4 multiframe pixels and seeks independent frame references', async () => {
    const first = blocks([0, 512, 2048, 4095]);
    const last = blocks([17, 1024, 3072, 4000]);
    const fixture = await createCompressedDicom({ codec: 'jpeg-extended', rows: 16, columns: 16,
        bitsAllocated: 16, bitsStored: 12, frameSamples: [first, last], fragmentsPerFrame: 3, bot: false });
    const series = await loadFiles([new File([fixture.bytes], 'synthetic-process4.dcm', { type: 'application/dicom' })]);
    try {
        assert.equal(series.length, 1);
        assert.equal(series[0].frames.length, 2);
        const one = await series[0].getFrame(0), two = await series[0].getFrame(1);
        assert.equal(one.transferSyntax, extendedSyntax);
        assert.equal(one.bitsStored, 12);
        assert.deepEqual([...one.samples], first);
        assert.deepEqual([...two.samples], last);
        assert.equal(await series[0].getFrame(0), one, 'A decoded frame remains reusable without truncating its stored samples.');
    } finally { series.forEach(stack => stack.dispose()); }
});

const valid = await createCompressedDicom({ codec: 'jpeg-extended', rows: 16, columns: 16,
    frameSamples: [blocks([0, 512, 2048, 4095])] });
const malformed = [
    ['missing EOI', bytes => bytes.slice(0, -2)],
    ['truncated marker prefix', bytes => bytes.slice(0, -1)],
    ['SOF0 baseline process relabeled Extended', bytes => changed(bytes, value => { value[marker(value, 193) + 1] = 192; })],
    ['SOF2 progressive process relabeled Extended', bytes => changed(bytes, value => { value[marker(value, 193) + 1] = 194; })],
    ['SOF3 lossless process relabeled Extended', bytes => changed(bytes, value => { value[marker(value, 193) + 1] = 195; })],
    ['precision mismatch', bytes => changed(bytes, value => { value[marker(value, 193) + 4] = 8; })],
    ['dimension mismatch', bytes => changed(bytes, value => { value[marker(value, 193) + 6] = 17; })],
    ['unsupported sampling factors', bytes => changed(bytes, value => { value[marker(value, 193) + 11] = 33; })],
    ['nonsequential spectral selection', bytes => changed(bytes, value => { value[marker(value, 218) + 7] = 1; })],
    ['incomplete spectral selection', bytes => changed(bytes, value => { value[marker(value, 218) + 8] = 62; })],
    ['successive approximation', bytes => changed(bytes, value => { value[marker(value, 218) + 9] = 1; })],
    ['missing referenced Huffman table', bytes => changed(bytes, value => { value[marker(value, 218) + 6] = 3; })],
    ['invalid quantizer', bytes => changed(bytes, value => { value[marker(value, 219) + 5] = 0; })],
    ['oversubscribed Huffman table', bytes => changed(bytes, value => { value[marker(value, 196) + 5] = 255; })],
    ['ICC profile', bytes => insertSegment(bytes, 226, new TextEncoder().encode('ICC_PROFILE\0\x01\x01'))],
    ['Adobe color marker', bytes => insertSegment(bytes, 238, [...new TextEncoder().encode('Adobe'), 0, 100, 0, 0, 0, 0, 0])],
    ['HP color marker', bytes => insertSegment(bytes, 232, [...new TextEncoder().encode('mrfx'), 1])],
    ['HP marker with zero transform', bytes => insertSegment(bytes, 232, [...new TextEncoder().encode('mrfx'), 0])],
    ['arithmetic coding tables', bytes => insertSegment(bytes, 204, [0, 16])],
    ['empty entropy scan', bytes => {
        const start = marker(bytes, 218), end = start + 2 + new DataView(bytes.buffer).getUint16(start + 2);
        return Uint8Array.from([...bytes.subarray(0, end), 255, 217]);
    }],
    ['early EOI after a partial entropy scan', bytes => {
        const start = marker(bytes, 218), end = start + 2 + new DataView(bytes.buffer).getUint16(start + 2);
        return Uint8Array.from([...bytes.subarray(0, end + 1), 255, 217]);
    }]
];
for (const [label, change] of malformed) {
    test(`Extended JPEG rejects ${label} before loading or allocating the codec`, async () => {
        await assert.rejects(decodeWasmFrame(change(valid.frames[0]), valid.metadata, { wasmBytes: new Uint8Array(1) }), /header|metadata/);
    });
}

for (const [label, patch] of [
    ['signed', { signed: true }], ['RGB', { samplesPerPixel: 3, photometric: 'RGB' }],
    ['YBR', { samplesPerPixel: 3, photometric: 'RGB', encodedPhotometric: 'YBR_FULL' }],
    ['palette', { photometric: 'PALETTE COLOR' }],
    ['precision10', { bitsStored: 10, highBit: 9 }], ['precision16', { bitsStored: 16, highBit: 15 }],
    ['12-bit values in an8-bit allocation', { bitsAllocated: 8 }], ['shifted high bit', { highBit: 12 }],
    ['over-budget dimensions', { rows: 16384, columns: 16384 }]
]) {
    test(`Extended JPEG rejects unsupported ${label} metadata before codec allocation`, async () => {
        await assert.rejects(decodeWasmFrame(valid.frames[0], { ...valid.metadata, ...patch }, { wasmBytes: new Uint8Array(1) }), /profile|header|metadata/);
    });
}

test('source metadata rejects signed Extended pixels and a falsely declared 10-bit profile', async () => {
    for (const patch of [{ signed: true }, { bitsStored: 10, highBit: 9 }]) {
        const bytes = createEncapsulatedDicom(valid.frames, { ...valid.metadata, ...patch, transferSyntax: extendedSyntax,
            extraAttributes: { '00280002': ['US', 1], '00281054': null } });
        await assert.rejects(loadFiles([new File([bytes], 'synthetic-outside-profile.dcm')]), /JPEG Extended.*profile/);
    }
});

test('a test-only native lossy8 encoder remains Baseline and cannot be silently relabeled SOF1', async () => {
    const baseline = await createCompressedDicom({ codec: 'jpeg', rows: 16, columns: 16,
        frameSamples: [blocks([0, 63, 129, 255])] });
    assert.equal(baseline.frames[0][marker(baseline.frames[0], 192) + 4], 8);
    await assert.rejects(decodeWasmFrame(baseline.frames[0], { ...baseline.metadata, transferSyntax: extendedSyntax }), /header/);
});

test('Process2 accepts valid8-bit sequential AC runs encoded by the test-only native JPEG encoder', async () => {
    const expected = Array.from({ length: 256 }, (_, index) => Math.floor(index / 16) * 8 + (index % 16) * 4);
    const baseline = await createCompressedDicom({ codec: 'jpeg', rows: 16, columns: 16, frameSamples: [expected] });
    // Baseline DCT/Huffman tables and sequential scans are a subset of Process2;
    // explicitly emit its required SOF1 instead of relabeling a SOF0 DICOM UID.
    const extended = changed(baseline.frames[0], bytes => { bytes[marker(bytes, 192) + 1] = 193; });
    const frame = await decodeFrame(extended, { ...baseline.metadata, transferSyntax: extendedSyntax });
    assert.equal(frame.samples.length, expected.length);
    for (let index = 0; index < expected.length; index++) assert.ok(Math.abs(frame.samples[index] - expected[index]) <= 2);
});

for (const precision of [8, 12]) for (const restartInterval of [1, 2]) {
    test(`Process${precision === 8 ? 2 : 4} validates DRI${restartInterval} and resets DC prediction at each restart`, async () => {
        const expected = blocks(precision === 8 ? [0, 63, 129, 255] : [0, 513, 2049, 4095]);
        const fixture = await createCompressedDicom({ codec: 'jpeg-extended', rows: 16, columns: 16,
            bitsAllocated: precision === 8 ? 8 : 16, bitsStored: precision, frameSamples: [expected],
            encoderOptions: { restartInterval } });
        assert.deepEqual([...(await decodeFrame(fixture.frames[0], fixture.metadata)).samples], expected);
    });
}

const restarted = await createCompressedDicom({ codec: 'jpeg-extended', rows: 16, columns: 16,
    frameSamples: [blocks([0, 513, 2049, 4095])], encoderOptions: { restartInterval: 1 } });
for (const [label, change] of [
    ['wrong restart order', bytes => changed(bytes, value => { value[marker(value, 208) + 1] = 209; })],
    ['restart without DRI', bytes => changed(bytes, value => { value[marker(value, 221) + 1] = 254; })],
    ['missing restart', bytes => { const offset = marker(bytes, 208); return Uint8Array.from([...bytes.subarray(0, offset), ...bytes.subarray(offset + 2)]); }],
    ['wrong declared restart interval', bytes => changed(bytes, value => { value[marker(value, 221) + 5] = 2; })],
    ['non-one alignment padding', bytes => changed(bytes, value => { value[marker(value, 208) - 1] &= 254; })]
]) {
    test(`Extended JPEG rejects ${label} before loading the codec`, async () => {
        await assert.rejects(decodeWasmFrame(change(restarted.frames[0]), restarted.metadata,
            { wasmBytes: new Uint8Array(1) }), /header/);
    });
}

test('restart numbering wraps and permitted FF marker fill does not create entropy samples', async () => {
    const expected = Array.from({ length: 8 * 80 }, (_, index) => [0, 1024, 4095][Math.floor(index % 80 / 8) % 3]);
    const fixture = await createCompressedDicom({ codec: 'jpeg-extended', rows: 8, columns: 80,
        frameSamples: [expected], encoderOptions: { restartInterval: 1 } });
    const source = fixture.frames[0], filled = [];
    for (let index = 0; index < source.length; index++) {
        if (source[index] === 255 && (source[index + 1] >= 208 && source[index + 1] <= 215 || source[index + 1] === 217)) filled.push(255);
        filled.push(source[index]);
    }
    assert.deepEqual([...(await decodeFrame(Uint8Array.from(filled), fixture.metadata)).samples], expected);
});

const legacyWarning = 'Legacy JPEG sequential scan uses Se=0; the complete 64-coefficient scan was validated before decoding.';
for (const precision of [8, 12]) {
    test(`legacy Se=0 Process${precision === 8 ? 2 : 4} requires a complete sequential scan and surfaces its header warning`, async () => {
        const expected = blocks(precision === 8 ? [0, 63, 129, 255] : [0, 513, 2049, 4095]);
        const fixture = await createCompressedDicom({ codec: 'jpeg-extended', rows: 16, columns: 16,
            bitsAllocated: precision === 8 ? 8 : 16, bitsStored: precision, frameSamples: [expected] });
        const legacy = changed(fixture.frames[0], bytes => { bytes[marker(bytes, 218) + 8] = 0; });
        const original = legacy.slice();
        const frame = await decodeFrame(legacy, fixture.metadata);
        assert.deepEqual([...frame.samples], expected);
        assert.deepEqual(frame.encodingWarnings, [legacyWarning]);
        assert.deepEqual(legacy, original, 'Compatibility must not rewrite the source codestream.');
        const bytes = createEncapsulatedDicom([legacy], { ...fixture.metadata,
            extraAttributes: { '00280002': ['US', 1], '00281054': null } });
        const series = await loadFiles([new File([bytes], 'synthetic-legacy-scan.dcm')]);
        try {
            const parsed = await series[0].getFrame(0);
            assert.deepEqual([...parsed.samples], expected);
            assert.deepEqual(parsed.encodingWarnings, [legacyWarning]);
        } finally { series.forEach(stack => stack.dispose()); }
    });
}

test('legacy Se=0 does not permit an actual DC-only scan or invented samples after an early EOI', async () => {
    const dcOnly = await createCompressedDicom({ codec: 'jpeg-extended', rows: 16, columns: 16,
        frameSamples: [blocks([0, 513, 2049, 4095])], encoderOptions: { omitAcEob: true } });
    const legacy = changed(valid.frames[0], bytes => { bytes[marker(bytes, 218) + 8] = 0; });
    const empty = malformed.find(([label]) => label === 'empty entropy scan')[1];
    const partial = malformed.find(([label]) => label === 'early EOI after a partial entropy scan')[1];
    for (const bytes of [changed(dcOnly.frames[0], value => { value[marker(value, 218) + 8] = 0; }), empty(legacy), partial(legacy)]) {
        await assert.rejects(decodeWasmFrame(bytes, valid.metadata, { wasmBytes: new Uint8Array(1) }), /header/);
    }
});

test('8-bit Process2 rejects a16-bit precision DQT before loading the codec', async () => {
    const fixture = await createCompressedDicom({ codec: 'jpeg-extended', rows: 16, columns: 16,
        bitsAllocated: 8, bitsStored: 8, frameSamples: [blocks([0, 63, 129, 255])] });
    // A complete table segment with legal nonzero16-bit elements still violates
    // the8-bit process's Pq=0 requirement (T.81 B.2.4.1).
    const dqt = [16, ...Array.from({ length: 64 }, () => [0, 1]).flat()];
    await assert.rejects(decodeWasmFrame(insertSegment(fixture.frames[0], 219, dqt), fixture.metadata,
        { wasmBytes: new Uint8Array(1) }), /header/);
});
