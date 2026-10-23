import test from 'node:test';
import assert from 'node:assert/strict';
import { createDicomFixture } from '../src/data/synthetic.js';
import { loadFiles } from '../src/data/sources.js';

async function read(photometric, pixels, options = {}) {
    return loadFiles([new File([createDicomFixture({ rows: 1, columns: 2, bitsAllocated: 8,
        bitsStored: 8, photometric, modality: 'US', rawPixelBytes: Uint8Array.from(pixels),
        sopClass: '1.2.840.10008.5.1.4.1.1.6.1', ...options,
        extraAttributes: { '00280002': ['US', 3], '00280006': ['US', options.planarConfiguration ?? 0] }
    })], 'synthetic-ybr.dcm')]);
}

for (const [photometric, pixels, options] of [
    ['YBR_FULL', [0,128,128,255,128,128], {}],
    ['YBR_FULL', [0,255,128,128,128,128], {planarConfiguration:1}],
    ['YBR_FULL_422', [0,255,128,128], {}]
]) test(`native ${photometric} converts neutral black/white exactly (planar ${options.planarConfiguration ?? 0})`, async () => {
    const series = await read(photometric, pixels, options);
    try {
        const frame = await series[0].getFrame(0);
        assert.equal(frame.photometric, 'RGB');
        assert.equal(frame.encodedPhotometric, photometric);
        assert.deepEqual([...frame.samples], [0,0,0,255,255,255]);
        assert.equal(frame.window, null);
    } finally { series.forEach(stack => stack.dispose()); }
});

test('YBR full-range matrix independently maps neutral and saturated components', async () => {
    const series = await read('YBR_FULL', [76,85,255,149,43,21]);
    try { assert.deepEqual([...(await series[0].getFrame(0)).samples], [254,0,0,0,255,0]); }
    finally { series.forEach(stack => stack.dispose()); }
});

test('native subsampled YBR rejects odd rows and planar storage', async () => {
    await assert.rejects(read('YBR_FULL_422',[0,128,128],{columns:1}), /even columns/);
    await assert.rejects(read('YBR_FULL_422',[0,255,128,128],{planarConfiguration:1}), /interleaved/);
});
