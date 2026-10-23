import test from 'node:test';
import assert from 'node:assert/strict';
import { createDicomFixture } from '../src/data/synthetic.js';
import { loadFiles } from '../src/data/sources.js';
import { decodeNative, nativeFrameByteLength } from '../src/data/native.js';
import { NativeDecoder } from '../src/runtime/native-decoder.js';

const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 17, 31, 129]);

function planes(interleaved) {
    const count = interleaved.length / 3;
    const result = new Uint8Array(interleaved.length);
    for (let index = 0; index < count; index++) {
        result[index] = interleaved[index * 3];
        result[count + index] = interleaved[index * 3 + 1];
        result[count * 2 + index] = interleaved[index * 3 + 2];
    }
    return result;
}

function colorFile(options = {}) {
    const bytes = createDicomFixture({ modality: 'US', sopClass: '1.2.840.10008.5.1.4.1.1.6.1',
        bitsAllocated: 8, bitsStored: 8, photometric: 'RGB', rawPixelBytes: rgb,
        ...options, extraAttributes: { '00280002': ['US', 3], '00280006': ['US', options.planarConfiguration ?? 0],
            '00281054': null, ...options.extraAttributes } });
    return new File([bytes], 'generated-native-rgb.dcm', { type: 'application/dicom' });
}

async function inspect(options, assertion) {
    const sources = await loadFiles([colorFile(options)]);
    try { await assertion(sources[0]); }
    finally { sources.forEach(stack => stack.dispose()); }
}

for (const transferSyntax of ['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']) {
    for (const planarConfiguration of [0, 1]) {
        test(`native RGB keeps exact channel values (${transferSyntax}, planar ${planarConfiguration})`, async () => {
            await inspect({ transferSyntax, planarConfiguration, rawPixelBytes: planarConfiguration ? planes(rgb) : rgb }, async stack => {
                assert.equal(stack.cacheBytes, 0);
                const frame = await stack.getFrame(0);
                assert.ok(frame.samples instanceof Uint8Array);
                assert.deepEqual([...frame.samples], [...rgb]);
                assert.equal(frame.samplesPerPixel, 3); assert.equal(frame.planarConfiguration, planarConfiguration);
                assert.equal(frame.photometric, 'RGB'); assert.equal(frame.range, null); assert.equal(frame.window, null);
                assert.equal(frame.unit, ''); assert.equal(stack.cacheBytes, rgb.length);
                assert.equal(stack.sourceBytes, rgb.length);
                assert.equal(await stack.getFrame(0), frame);
            });
        });
    }
}

for (const planarConfiguration of [0, 1]) {
    test(`multiframe native RGB slices and reorders each selected frame independently (planar ${planarConfiguration})`, async () => {
        const second = new Uint8Array([1, 2, 3, 11, 12, 13, 21, 22, 23, 31, 32, 33]);
        const encoded = new Uint8Array(24);
        encoded.set(planarConfiguration ? planes(rgb) : rgb);
        encoded.set(planarConfiguration ? planes(second) : second, 12);
        await inspect({ planarConfiguration, frames: 2, rawPixelBytes: encoded }, async stack => {
            assert.equal(stack.frames.length, 2);
            assert.deepEqual([...(await stack.getFrame(1)).samples], [...second]);
            assert.equal(stack.cacheBytes, 12);
            const first = await stack.getFrame(0);
            assert.deepEqual([...first.samples], [...rgb]); assert.equal(stack.cacheBytes, 24);
            stack._session.cache.budget = 12; stack._session.cache.clear();
            await stack.getFrame(1);
            assert.deepEqual([...(await stack.getFrame(0)).samples], [...rgb]);
            assert.equal(stack.cacheBytes, 12);
        });
    });
}

test('odd RGB byte counts strip only the final DICOM pad and preserve the last channel', async () => {
    await inspect({ rows: 1, columns: 1, rawPixelBytes: new Uint8Array([17, 31, 129]) }, async stack => {
        assert.deepEqual([...(await stack.getFrame(0)).samples], [17, 31, 129]);
        assert.equal(stack.sourceBytes, 3); assert.equal(stack.cacheBytes, 3);
    });
    await assert.rejects(loadFiles([colorFile({ rows: 1, columns: 1, rawPixelBytes: new Uint8Array(6) })]), /length/);
});

test('eight-bit OW Big Endian restores byte pairs before trimming odd padding and splitting odd frames', async () => {
    const syntax = '1.2.840.10008.1.2.2';
    await inspect({ transferSyntax: syntax, rows: 1, columns: 1,
        extraAttributes: { '7FE00010': ['OW', new Uint8Array([31, 17, 0, 129])] } }, async stack => {
        assert.deepEqual([...(await stack.getFrame(0)).samples], [17, 31, 129]);
    });
    await inspect({ transferSyntax: syntax, rows: 1, columns: 1, frames: 2,
        extraAttributes: { '7FE00010': ['OW', new Uint8Array([2, 1, 11, 3, 13, 12])] } }, async stack => {
        assert.deepEqual([...(await stack.getFrame(0)).samples], [1, 2, 3]);
        assert.deepEqual([...(await stack.getFrame(1)).samples], [11, 12, 13]);
    });
});

test('RGB and scalar images in one Series UID remain distinct compatible stacks', async () => {
    const sources = await loadFiles([
        colorFile({ sopUid: '1.2.3.1' }),
        new File([createDicomFixture({ sopUid: '1.2.3.2' })], 'generated-mono.dcm')
    ]);
    try {
        assert.equal(sources.length, 2);
        assert.equal(sources[0].frames[0].photometric, 'RGB');
        assert.equal(sources[1].frames[0].photometric, 'MONOCHROME2');
    } finally { sources.forEach(stack => stack.dispose()); }
});

for (const [name, options, expected] of [
    ['signed RGB', { signed: true }, /unsigned 8-bit/],
    ['sixteen-bit RGB', { bitsAllocated: 16, bitsStored: 16 }, /unsigned 8-bit/],
    ['partial stored channel width', { bitsStored: 7 }, /Bits Stored 8/],
    ['missing planar configuration', { extraAttributes: { '00280006': null } }, /pixel metadata/],
    ['unsupported planar configuration', { planarConfiguration: 2 }, /pixel metadata/],
    ['nonidentity rescale', { slope: 2 }, /scalar rescale/],
    ['pixel padding', { padding: 0 }, /pixel padding/],
    ['ICC profile', { extraAttributes: { '00282000': ['OB', new Uint8Array([1, 2])] } }, /color-management/],
    ['declared color space', { extraAttributes: { '00282002': ['CS', 'ADOBERGB'] } }, /color-management/],
    ['unsupported partial YBR', { photometric: 'YBR_PARTIAL_420' }, /supported scalar/],
    ['palette color with RGB sample count', { photometric: 'PALETTE COLOR' }, /one sample/]
]) {
    test(`unsupported RGB presentation or pixel layout rejects explicitly: ${name}`, async () => {
        await assert.rejects(loadFiles([colorFile(options)]), expected);
    });
}

test('empty optional ICC/color space fields do not change original RGB samples', async () => {
    await inspect({ extraAttributes: { '00282000': ['OB', new Uint8Array()], '00282002': ['CS', ''] } }, async stack => {
        assert.deepEqual([...(await stack.getFrame(0)).samples], [...rgb]);
    });
});

test('native frame byte counts distinguish RGB and scalar layouts', () => {
    assert.equal(nativeFrameByteLength({ rows: 2, columns: 2, bitsAllocated: 8, samplesPerPixel: 3, photometric: 'RGB' }), 12);
    assert.equal(nativeFrameByteLength({ rows: 2, columns: 2, bitsAllocated: 16 }), 8);
    assert.throws(() => nativeFrameByteLength({ rows: 2, columns: 2, bitsAllocated: 8, samplesPerPixel: 1, photometric: 'RGB' }), /Samples per Pixel/);
});

test('RGB decode transfers only requested bytes and whitelisted color metadata to its worker', async () => {
    const originalWorker = globalThis.Worker;
    let worker;
    globalThis.Worker = class {
        constructor() { worker = this; }
        postMessage(message, transfer) { this.message = message; this.transfer = transfer; }
        terminate() { this.terminated = true; }
    };
    const decoder = new NativeDecoder();
    try {
        const retained = new Uint8Array(100);
        retained.set(planes(rgb), 50);
        const promise = decoder.decode(retained.subarray(50, 62), {
            rows: 2, columns: 2, bitsAllocated: 8, bitsStored: 8, highBit: 7, signed: false,
            photometric: 'RGB', samplesPerPixel: 3, planarConfiguration: 1, _record: { bytes: retained }
        });
        assert.equal(worker.message.bytes.byteLength, 12); assert.equal(retained.byteLength, 100);
        assert.equal(worker.message.metadata.samplesPerPixel, 3);
        assert.equal(worker.message.metadata.planarConfiguration, 1);
        assert.equal(worker.message.metadata.photometric, 'RGB');
        assert.equal('_record' in worker.message.metadata, false);
        const result = decodeNative(new Uint8Array(worker.message.bytes), worker.message.metadata);
        worker.onmessage({ data: { id: worker.message.id, ...result } });
        assert.deepEqual([...(await promise).samples], [...rgb]);
        assert.equal(result.range, null);
    } finally { decoder.dispose(); globalThis.Worker = originalWorker; }
    assert.equal(worker.terminated, true);
});

test('RGB queued/active decoding cancellation preserves later decoding and disposal', async () => {
    const decoder = new NativeDecoder();
    const metadata = { rows: 2, columns: 2, bitsAllocated: 8, bitsStored: 8, highBit: 7,
        signed: false, photometric: 'RGB', samplesPerPixel: 3, planarConfiguration: 0 };
    const firstController = new AbortController();
    const queuedController = new AbortController();
    const first = decoder.decode(rgb, metadata, { signal: firstController.signal });
    const next = decoder.decode(rgb, metadata, { signal: queuedController.signal });
    const rejectedFirst = assert.rejects(first, { name: 'AbortError' });
    const rejectedNext = assert.rejects(next, { name: 'AbortError' });
    queuedController.abort(); firstController.abort();
    await Promise.all([rejectedFirst, rejectedNext]);
    assert.deepEqual([...(await decoder.decode(rgb, metadata)).samples], [...rgb]);
    decoder.dispose();
    await assert.rejects(decoder.decode(rgb, metadata), /disposed/);
});
