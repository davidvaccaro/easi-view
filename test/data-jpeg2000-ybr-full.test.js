import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Tag } from '@xinonix/easi-js';
import { createCompressedDicom } from './compressed-fixtures.js';
import { decodeWasmFrame } from '../src/data/wasm-codecs.js';
import { decodeFrame } from '../src/data/compressed.js';
import { loadFiles } from '../src/data/sources.js';
import { renderColorToRgba } from '../src/render/DisplayMath.js';

const sourceColors = [0,128,128, 255,128,128, 128,128,128, 76,84,255, 149,43,21, 29,255,107,
    100,100,200, 0,0,0, 255,255,255];
// Independent integer reference values from the full-range Y/Cb/Cr matrix,
// with unsigned8 midpoint128, round-to-nearest and channel clipping.
const expectedColors = [0,0,0, 255,255,255, 128,128,128, 254,0,0, 0,255,0, 0,0,254,
    201,58,50, 0,135,0, 255,121,255];
const wasmBytes = new Uint8Array(await readFile(new URL('../node_modules/dcmjs-codecs/build/dcmjs-native-codecs.wasm', import.meta.url)));
const syntax = suffix => `1.2.840.10008.1.2.4.${suffix}`;
async function fixture({ suffix = 90, samples = sourceColors, rows = 3, columns = 3 } = {}) {
    return createCompressedDicom({ codec: 'jpeg2000', rows, columns, samplesPerPixel: 3, bitsAllocated: 8, bitsStored: 8,
        signed: false, photometric: 'YBR_FULL', transferSyntax: syntax(suffix), frameSamples: [samples] });
}
const metadata = generated => ({ ...generated.metadata, photometric: 'RGB', encodedPhotometric: 'YBR_FULL', slope: 1, intercept: 0 });
function codPosition(bytes) {
    for (let index = 2; index + 1 < bytes.length; index++) if (bytes[index] === 255 && bytes[index + 1] === 82) return index;
    throw new Error('Generated JPEG2000 has no COD segment.');
}

for (const suffix of [90, 91]) test(`JPEG2000 MCT0 YBR_FULL preserves known source components and converts to RGB once (${suffix})`, async () => {
    const generated = await fixture({ suffix }), before = generated.frames[0].slice();
    // The owned WASM adapter intentionally returns Y/Cb/Cr unchanged. The
    // existing compressed-frame dispatcher owns the single display conversion.
    const raw = await decodeWasmFrame(generated.frames[0], metadata(generated), { wasmBytes });
    assert.deepEqual([...raw.bytes], sourceColors); assert.equal(raw.metadataOverrides.photometric, 'YBR_FULL');
    const decoded = await decodeFrame(generated.frames[0], metadata(generated));
    assert.deepEqual([...decoded.samples], expectedColors); assert.equal(decoded.range, null);
    assert.deepEqual(generated.frames[0], before);
    const rgba = renderColorToRgba({ ...metadata(generated), ...decoded });
    assert.deepEqual([...rgba], expectedColors.flatMap((value, index) => index % 3 === 2 ? [value, 255] : [value]));
});

test('JPEG2000 full-range conversion matches an independent color matrix across a generated125color cube', async () => {
    const samples = []; for (const y of [0,64,128,192,255]) for (const cb of [0,64,128,192,255]) for (const cr of [0,64,128,192,255]) samples.push(y,cb,cr);
    const generated = await fixture({ samples, rows: 5, columns: 25 });
    const raw = await decodeWasmFrame(generated.frames[0], metadata(generated), { wasmBytes });
    assert.deepEqual([...raw.bytes], samples);
    const expected = [], matrix = [[1,0,1.402], [1,-0.344136,-0.714136], [1,1.772,0]];
    for (let index = 0; index < samples.length; index += 3) {
        const input = [samples[index], samples[index + 1] - 128, samples[index + 2] - 128];
        expected.push(...matrix.map(row => Math.max(0, Math.min(255, Math.round(row.reduce((sum, coefficient, axis) => sum + coefficient * input[axis], 0))))));
    }
    assert.deepEqual([...(await decodeFrame(generated.frames[0], metadata(generated))).samples], expected);
});

test('full EASI file pipeline retains YBR_FULL provenance, RGB display/caches and original synthetic input bytes', async () => {
    const generated = await fixture(), before = generated.bytes.slice(); let sourcePhotometric;
    const sources = await loadFiles([new File([generated.bytes], 'generated-j2k-ybr-full.dcm')], { onInstance(instance) {
        sourcePhotometric = instance.dataSet.value(Tag.find('00280004'));
    } });
    try {
        const frame = await sources[0].getFrame(0);
        assert.equal(sourcePhotometric, 'YBR_FULL'); assert.equal(frame.encodedPhotometric, 'YBR_FULL'); assert.equal(frame.photometric, 'RGB');
        assert.deepEqual([...frame.samples], expectedColors); assert.equal(frame.range, null); assert.equal(frame.window, null);
        assert.equal(await sources[0].getFrame(0), frame); assert.equal(sources[0].cacheBytes, 27);
    } finally { sources.forEach(source => source.dispose()); }
    assert.deepEqual(generated.bytes, before); assert.equal(sources[0].cacheBytes, 0); assert.equal(sources[0].sourceBytes, 0);
});

test('worker path converts known YBR_FULL pixels once and caches the same RGB renderer inputs', async () => {
    const generated = await fixture(), previous = globalThis.Worker, workers = [];
    class GeneratedWorker {
        constructor() { workers.push(this); }
        postMessage(message) { this.message = message; queueMicrotask(async () => {
            try { this.onmessage({ data: { id: message.id, ...await decodeFrame(new Uint8Array(message.bytes), message.metadata) } }); }
            catch (error) { this.onmessage({ data: { id: message.id, error: error.message } }); }
        }); }
        terminate() { this.terminated = true; }
    }
    globalThis.Worker = GeneratedWorker; let sources = [];
    try {
        sources = await loadFiles([new File([generated.bytes], 'generated-j2k-ybr-worker.dcm')]);
        const frame = await sources[0].getFrame(0); assert.deepEqual([...frame.samples], expectedColors);
        assert.equal(workers[0].message.metadata.encodedPhotometric, 'YBR_FULL'); assert.equal(frame.photometric, 'RGB');
        assert.equal(await sources[0].getFrame(0), frame); assert.equal(workers.length, 1);
        assert.deepEqual([...renderColorToRgba(frame)].filter((_, index) => index % 4 !== 3), expectedColors);
    } finally { sources.forEach(source => source.dispose()); globalThis.Worker = previous; }
    assert.equal(workers[0].terminated, true);
});

test('YBR_FULL JPEG2000 profile keeps signed, high-depth, subsampled and incompatible MCT guards strict', async () => {
    const generated = await fixture(), base = metadata(generated);
    for (const changes of [{ signed: true }, { bitsAllocated: 16 }, { bitsStored: 7, highBit: 6 },
        { bitsStored: 12, highBit: 11, bitsAllocated: 16 }, { samplesPerPixel: 1 }, { planarConfiguration: 2 },
        { planarConfiguration: 1 }, { encodedPhotometric: 'YBR_FULL_422' }]) {
        await assert.rejects(decodeWasmFrame(generated.frames[0], { ...base, ...changes }, { wasmBytes }), /header|metadata/);
    }
    const mct = generated.frames[0].slice(); mct[codPosition(mct) + 8] = 1;
    await assert.rejects(decodeWasmFrame(mct, base, { wasmBytes }), /component transform/);
    const subsampled = generated.frames[0].slice(); subsampled[45] = 2;
    await assert.rejects(decodeWasmFrame(subsampled, base, { wasmBytes }), /header|metadata/);
    await assert.rejects(decodeWasmFrame(generated.frames[0].subarray(0, generated.frames[0].length - 2), base, { wasmBytes }), /header/);
});
