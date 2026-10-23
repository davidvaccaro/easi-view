import test from 'node:test';
import assert from 'node:assert/strict';
import { createDicomFixture } from '../src/data/synthetic.js';
import { loadFiles } from '../src/data/sources.js';
import { nativePlaybackAvailable, nativePlaybackInterval } from '../src/data/frame-timing.js';
import { createCompressedDicom } from './compressed-fixtures.js';

const sopClass = '1.2.840.10008.5.1.4.1.1.7.4';
const rows = 3, columns = 5;
const samples = Array.from({ length: 3 }, (_, frame) => Array.from({ length: rows * columns * 3 }, (_, index) =>
    (frame * 71 + index * 3 + Math.floor(index / 3) * 7) % 256));

function nativeFixture(options = {}) {
    return createDicomFixture({ modality: 'OT', sopClass, rows, columns, frames: samples.length, frameTime: 40,
        bitsAllocated: 8, bitsStored: 8, photometric: 'RGB', rawPixelBytes: Uint8Array.from(samples.flat()),
        ...options, extraAttributes: { '00280002': ['US', 3], '00280006': ['US', 0], '00281056': null,
            ...options.extraAttributes } });
}

async function open(bytes, inspect) {
    const stacks = await loadFiles([new File([bytes], 'synthetic-multiframe-true-color.dcm', { type: 'application/dicom' })]);
    try { assert.equal(stacks.length, 1); await inspect(stacks[0]); }
    finally { stacks.forEach(stack => stack.dispose()); }
}

async function verifyFrames(stack) {
    assert.equal(stack.frames.length, 3); assert.equal(stack.cacheBytes, 0);
    assert.deepEqual(stack.frames.map(frame => frame.frameIndex), [0, 1, 2]);
    assert.deepEqual(stack.frames.map(frame => frame.acquisitionOffsetMs), [0, 40, 80]);
    assert.equal(nativePlaybackAvailable(stack.frames), true);
    assert.deepEqual(stack.frames.map((_, index) => nativePlaybackInterval(stack.frames, index)), [40, 40, 40]);
    for (const index of [2, 0, 1]) {
        const frame = await stack.getFrame(index);
        assert.deepEqual([...frame.samples], samples[index]);
        assert.ok(frame.samples instanceof Uint8Array); assert.equal(frame.photometric, 'RGB'); assert.equal(frame.samplesPerPixel, 3);
        assert.equal(frame.rows, rows); assert.equal(frame.columns, columns); assert.equal(frame.planarConfiguration, 0);
        assert.equal(frame.window, null); assert.equal(frame.range, null); assert.equal(frame.unit, '');
    }
    assert.equal(stack.cacheBytes, rows * columns * 3 * 3);
    await assert.rejects(stack.getFrame(3), /available frame/);
}

for (const transferSyntax of ['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']) {
    test(`Multi-frame True Color SC opens native RGB with independent exact frames and recorded playback (${transferSyntax})`, async () => {
        await open(nativeFixture({ transferSyntax }), verifyFrames);
    });
}

for (const codec of ['rle', 'jpeg-lossless', 'jpeg-ls']) {
    test(`Multi-frame True Color SC ${codec} preserves independent RGB samples and lazy frame navigation`, async () => {
        const fixture = await createCompressedDicom({ codec, modality: 'OT', sopClass, rows, columns, samplesPerPixel: 3,
            bitsAllocated: 8, photometric: 'RGB', frameSamples: samples, frameTime: 40,
            fragmentsPerFrame: codec === 'rle' ? 1 : 3, extraAttributes: { '00281056': null } });
        await open(fixture.bytes, async stack => {
            const record = [...stack._records.values()][0]; assert.ok(record.encapsulated);
            await verifyFrames(stack); const index = record.encapsulated;
            stack.dispose(); assert.equal(index.frames.length, 0); assert.equal(stack.cacheBytes, 0);
        });
    });
}

test('Multi-frame True Color SC accepts JPEG Lossless Process 14 with selection value 1', async () => {
    const fixture = await createCompressedDicom({ codec: 'jpeg-lossless', transferSyntax: '1.2.840.10008.1.2.4.57',
        modality: 'OT', sopClass, rows, columns, samplesPerPixel: 3, bitsAllocated: 8, photometric: 'RGB',
        frameSamples: samples, frameTime: 40, extraAttributes: { '00281056': null } });
    await open(fixture.bytes, verifyFrames);
});

test('Multi-frame True Color SC does not manufacture recorded playback when source timing is absent', async () => {
    await open(nativeFixture({ extraAttributes: { '00280009': null, '00181063': null } }), async stack => {
        assert.equal(nativePlaybackAvailable(stack.frames), false);
        assert.ok(stack.frames.every(frame => frame.frameTime === null && frame.timingMode === 'none'));
        assert.deepEqual([...(await stack.getFrame(2)).samples], samples[2]);
    });
});

for (const [name, options, message] of [
    ['scalar profile', { photometric: 'MONOCHROME2', extraAttributes: { '00280002': ['US', 1], '00280006': null } }, /True Color Secondary Capture/],
    ['planar color', { extraAttributes: { '00280006': ['US', 1] } }, /interleaved/],
    ['YBR color', { photometric: 'YBR_FULL' }, /True Color Secondary Capture/],
    ['signed channels', { signed: true }, /unsigned 8-bit/],
    ['sixteen-bit channels', { bitsAllocated: 16, bitsStored: 16 }, /unsigned 8-bit/],
    ['partial stored precision', { bitsStored: 7 }, /Bits Stored 8/],
    ['scalar rescale', { slope: 2 }, /scalar rescale/],
    ['invalid declared timing', { frameTime: 0 }, /frame timing/]
]) test(`Multi-frame True Color SC rejects unqualified ${name}`, async () => {
    await assert.rejects(open(nativeFixture(options), () => assert.fail('Invalid profile opened')), message);
});

test('Multi-frame True Color SC defers unqualified lossy/color-transform syntax profiles', async () => {
    const fixture = await createCompressedDicom({ codec: 'jpeg2000', modality: 'OT', sopClass, rows, columns,
        samplesPerPixel: 3, photometric: 'RGB', frameSamples: samples });
    await assert.rejects(open(fixture.bytes, () => assert.fail('Unqualified profile opened')), /True Color Secondary Capture/);
});
