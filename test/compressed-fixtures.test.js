import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompressedDicom, encodeRleFrame, encapsulatePixelData, packFixtureSamples } from './compressed-fixtures.js';
import { loadFiles } from '../src/data/sources.js';
import { indexEncapsulatedFrames } from '../src/data/encapsulated.js';
import { decodeRleFrame } from '../src/data/rle.js';
import { jpegBaselineHeader } from '../src/data/compressed.js';

async function inspect(fixture, assertion) {
    const sources = await loadFiles([new File([fixture.bytes], 'generated-compressed.dcm')]);
    try { await assertion(sources[0]); }
    finally { sources.forEach(source => source.dispose()); }
}

test('independent row-wise RLE encodes both literal and repeated runs and exact signed sample planes', async () => {
    const samples = [-2048, -2048, 0, 2047, -1, 1, 2, 3];
    const options = { rows: 2, columns: 4, bitsAllocated: 16, bitsStored: 12, highBit: 11, signed: true };
    const encoded = encodeRleFrame(samples, options);
    assert.equal(new DataView(encoded.buffer).getUint32(0, true), 2);
    assert.deepEqual([...decodeRleFrame(encoded, { ...options, samplesPerPixel: 1 })], [...packFixtureSamples(samples, options)]);
    const fixture = await createCompressedDicom({ codec: 'rle', ...options, frameSamples: [samples, [...samples].reverse()] });
    await inspect(fixture, async source => {
        assert.equal(source.cacheBytes, 0);
        assert.deepEqual([...(await source.getFrame(1)).samples], [...samples].reverse());
        assert.deepEqual([...(await source.getFrame(0)).samples], samples);
        assert.equal(source.frames.length, 2);
    });
});

test('synthetic RGB RLE preserves independent interleaved reference channels despite planar metadata', async () => {
    const samples = [255, 0, 0, 0, 255, 0, 0, 0, 255, 17, 31, 129];
    const fixture = await createCompressedDicom({ codec: 'rle', rows: 2, columns: 2,
        bitsAllocated: 8, samplesPerPixel: 3, planarConfiguration: 1, frameSamples: [samples], bot: false });
    await inspect(fixture, async source => {
        const frame = await source.getFrame(0);
        assert.deepEqual([...frame.samples], samples);
        assert.equal(frame.photometric, 'RGB'); assert.equal(frame.window, null);
    });
});

test('synthetic BOT offsets include fragment headers and only final JPEG payloads may be padded', async () => {
    const fixture = await createCompressedDicom({ codec: 'jpeg', frameSamples: [Array(64).fill(80), Array(64).fill(130)], fragmentsPerFrame: 3 });
    const value = encapsulatePixelData(fixture.frames, { fragmentsPerFrame: 3 });
    const tableLength = new DataView(value.buffer).getUint32(4, true);
    assert.equal(tableLength, 8);
    const index = indexEncapsulatedFrames(value, { frameCount: 2, syntax: fixture.metadata.transferSyntax });
    assert.deepEqual([...index.getFrame(0)], [...fixture.frames[0]]);
    assert.deepEqual([...index.getFrame(1)], [...fixture.frames[1]]);
    assert.equal(index.frames[0].fragments.length, 3);
    const withoutTable = indexEncapsulatedFrames(encapsulatePixelData(fixture.frames, { bot: false, fragmentsPerFrame: 3 }),
        { frameCount: 2, syntax: fixture.metadata.transferSyntax });
    assert.deepEqual([...withoutTable.getFrame(1)], [...fixture.frames[1]]);
});

test('grayscale JPEG synthetic input has one SOF component and a bounded original-raster error', async () => {
    const fixture = await createCompressedDicom({ codec: 'jpeg', frameSamples: [Array(64).fill(80), Array(64).fill(130)] });
    assert.deepEqual(jpegBaselineHeader(fixture.frames[0]), { precision: 8, rows: 8, columns: 8, components: 1, adobeTransform: null, icc: false });
    await inspect(fixture, async source => {
        for (let index = 0; index < 2; index++) {
            const actual = (await source.getFrame(index)).samples;
            assert.ok(actual.every((value, pixel) => Math.abs(value - fixture.expectedSamples[index][pixel]) <= 1));
        }
    });
});

test('RGB JPEG fixture declares its three-component YCbCr codestream and preserves known color blocks', async () => {
    const reference = [17, 31, 129], samples = Array.from({ length: 64 }, () => reference).flat();
    const fixture = await createCompressedDicom({ codec: 'jpeg', samplesPerPixel: 3, frameSamples: [samples], fragmentsPerFrame: 2 });
    assert.equal(fixture.metadata.photometric, 'YBR_FULL'); assert.equal(jpegBaselineHeader(fixture.frames[0]).components, 3);
    await inspect(fixture, async source => {
        const frame = await source.getFrame(0);
        assert.equal(frame.photometric, 'RGB');
        assert.ok(frame.samples.every((value, pixel) => Math.abs(value - samples[pixel]) <= 2));
    });
});

test('negative fixture deliberately disagrees with the encoded dimensions without changing original reference data', async () => {
    const fixture = await createCompressedDicom({ codec: 'jpeg', metadataOverrides: { rows: 9 } });
    assert.equal(fixture.metadata.rows, 9); assert.equal(jpegBaselineHeader(fixture.frames[0]).rows, 8);
    assert.equal(fixture.expectedSamples[0].length, 64);
    await inspect(fixture, async source => { await assert.rejects(source.getFrame(0), /dimensions|metadata/); });
});

test('RLE multiframe fixtures retain one fragment per frame and can intentionally generate invalid fragmentation', async () => {
    const fixture = await createCompressedDicom({ codec: 'rle', rows: 2, columns: 2,
        frameSamples: [[0, 1, 255, 256], [65535, 32768, 4095, 1024]] });
    const index = indexEncapsulatedFrames(encapsulatePixelData(fixture.frames), { frameCount: 2, syntax: fixture.metadata.transferSyntax });
    assert.ok(index.frames.every(frame => frame.fragments.length === 1));
    assert.throws(() => indexEncapsulatedFrames(encapsulatePixelData(fixture.frames, { fragmentsPerFrame: 2 }),
        { frameCount: 2, syntax: fixture.metadata.transferSyntax }), /one|single|fragment/);
});

test('JPEG2000 RCT synthetic fixture declares its transform and restores exact nonconstant original RGB', async () => {
    const samples = Array.from({ length: 64 }, (_, index) => [index * 4, 255 - index * 3, index + 17]).flat();
    const fixture = await createCompressedDicom({ codec: 'jpeg2000', samplesPerPixel: 3,
        photometric: 'YBR_RCT', frameSamples: [samples], extendedOffsets: true });
    await inspect(fixture, async source => {
        const frame = await source.getFrame(0);
        assert.deepEqual([...frame.samples], samples);
        assert.equal(frame.photometric, 'RGB'); assert.equal(frame.window, null);
    });
});

test('JPEG Process 14 predictor two fixture retains exact independently specified unsigned samples', async () => {
    const samples = Array.from({ length: 64 }, (_, index) => index * 1024);
    const fixture = await createCompressedDicom({ codec: 'jpeg-lossless', encoderOptions: { predictor: 2 },
        transferSyntax: '1.2.840.10008.1.2.4.57', frameSamples: [samples], fragmentsPerFrame: 2 });
    await inspect(fixture, async source => { assert.deepEqual([...(await source.getFrame(0)).samples], samples); });
});

test('actual JPEG-LS NEAR two fixture stays within the declared original stored-sample error', async () => {
    const samples = Array.from({ length: 256 }, (_, index) => index % 251);
    const fixture = await createCompressedDicom({ codec: 'jpeg-ls-near', rows: 16, columns: 16,
        bitsAllocated: 8, encoderOptions: { allowedLossyError: 2 }, frameSamples: [samples], bot: false, fragmentsPerFrame: 2 });
    await inspect(fixture, async source => {
        const frame = await source.getFrame(0);
        assert.ok(frame.samples.every((value, index) => Math.abs(value - samples[index]) <= 2));
        assert.ok(frame.samples.some((value, index) => value !== samples[index]), 'Fixture must exercise actual near-lossless encoding.');
    });
});

test('twelve-bit JPEG-LS fixture codestream precision matches Bits Stored inside a sixteen-bit DICOM container', async () => {
    const samples = Array.from({ length: 64 }, (_, index) => index * 65);
    const fixture = await createCompressedDicom({ codec: 'jpeg-ls', bitsAllocated: 16, bitsStored: 12, frameSamples: [samples] });
    await inspect(fixture, async source => { assert.deepEqual([...(await source.getFrame(0)).samples], samples); });
});

test('irreversible JPEG2000 fixture has a bounded independent reference for the stated quadrant raster only', async () => {
    const samples = Array.from({ length: 256 }, (_, index) => [16, 80, 128, 240][
        (Math.floor(index / 16) >= 8 ? 2 : 0) + (index % 16 >= 8 ? 1 : 0)]);
    const fixture = await createCompressedDicom({ codec: 'jpeg2000-lossy', rows: 16, columns: 16,
        bitsAllocated: 8, encoderOptions: { rate: 1 }, frameSamples: [samples], fragmentsPerFrame: 2 });
    await inspect(fixture, async source => {
        const frame = await source.getFrame(0);
        assert.ok(frame.samples.every((value, index) => Math.abs(value - samples[index]) <= 3));
    });
});
