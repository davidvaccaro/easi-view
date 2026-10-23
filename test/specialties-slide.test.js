import test from 'node:test';
import assert from 'node:assert/strict';
import { Tag } from '@xinonix/easi-js';
import { createSlideIndex } from '../src/specialties/index.js';
import { metadata, parseNative, slideFixture, j, sq } from './specialties-fixtures.js';
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('TILED_FULL index proves row-major frame order and clips only padded edge extents', async () => {
    const index = createSlideIndex(await metadata(slideFixture()));
    assert.equal(index.metadata.frameCount, 9); assert.equal(index.tileAt(6, 4).frameIndex, 8);
    assert.deepEqual(index.tileDescriptor(8), { frameIndex: 8, frameNumber: 9, column: 6, row: 4, dicomColumnPosition: 7, dicomRowPosition: 5,
        columns: 1, rows: 1, encodedColumns: 3, encodedRows: 2, opticalPathId: 'PATH1', focalPlaneIndex: 0,
        slidePosition: { xMm: 9.992, yMm: 20.018, zUm: 300 } });
    assert.deepEqual(index.tilesInRegion({ column: 2, row: 1, width: 3, height: 2 }).map(tile => tile.frameIndex), [0, 1, 3, 4]);
    assert.deepEqual(index.tilesInRegion({ column: 3, row: 2, width: 3, height: 2 }).map(tile => tile.frameIndex), [4]);
    assert.deepEqual(index.tilesInRegion({ column: 99, row: 99, width: 1, height: 1 }), []);
});
test('rotated slide coordinates preserve mm versus micrometre units and center origin', async () => {
    const index = createSlideIndex(await parseNative(slideFixture()));
    const point = index.pixelToSlide([2, 3]); close(point.xMm, 9.994); close(point.yMm, 20.006); assert.equal(point.zUm, 300);
    const pixel = index.slideToPixel(point, { frameOfReferenceUid: '2.25.821' }); close(pixel.column, 2); close(pixel.row, 3);
    assert.deepEqual(index.pixelToSlide([0, 0]), { xMm: 10, yMm: 20, zUm: 300 });
    assert.throws(() => index.slideToPixel({ ...point, zUm: 301 }), /outside the indexed plane/);
    assert.throws(() => index.slideToPixel(point, { frameOfReferenceUid: '2.25.999' }), /Frame of Reference/);
});
test('slide indexing does not access pixel bytes or fetch BulkDataURI', async () => {
    const instance = await metadata(slideFixture({ '7FE00010': { vr: 'OB', BulkDataURI: 'https://example.invalid/slide' } }));
    const pixel = instance.dataSet.find(Tag.find('7FE00010')); pixel.access = () => { throw new Error('index accessed pixels'); };
    let requests = 0; const previous = globalThis.fetch; globalThis.fetch = () => { requests++; throw new Error('network'); };
    try { assert.equal(createSlideIndex(instance).tileAt(0, 0).frameNumber, 1); assert.equal(requests, 0); } finally { globalThis.fetch = previous; }
});
for (const [name, overrides] of [
    ['sparse layout', { '00209311': j('CS', 'TILED_SPARSE') }], ['wrong frame count', { '00280008': j('IS', 8) }],
    ['multiple focal planes', { '00480303': j('UL', 2) }], ['multiple optical paths', { '00480302': j('UL', 2) }],
    ['concatenation', { '00209161': j('UI', '2.25.900') }], ['explicit per-frame groups', { '52009230': sq({}) }],
    ['label extent', { '00080008': j('CS', 'ORIGINAL', 'PRIMARY', 'LABEL', 'NONE') }],
    ['tilted slide orientation', { '00480102': j('DS', 0, 0, 1, 0, 1, 0) }], ['inconsistent extent', { '00480001': j('FL', 1) }],
    ['planar color mismatch', { '00280006': j('US', 1) }], ['missing explicit origin Z', { '00480008': sq({ '0040072A': j('DS', 10), '0040073A': j('DS', 20) }) }]
]) test(`slide index rejects ${name}`, async () => { const instance = await metadata(slideFixture(overrides)); assert.throws(() => createSlideIndex(instance), /Unsupported/); });
test('slide query budgets and exact pixel bounds prevent accidental whole-layer allocation', async () => {
    const index = createSlideIndex(await metadata(slideFixture()));
    assert.throws(() => index.tilesInRegion({ column: 0, row: 0, width: 7, height: 5 }, { maxTiles: 8 }), /result budget/);
    assert.throws(() => index.tileAt(7, 0), /integer/); assert.throws(() => index.tileAt(0.5, 1), /integer/); assert.throws(() => index.tileDescriptor(9), /integer/);
    assert.throws(() => index.tilesInRegion({ column: 0, row: 0, width: Infinity, height: 1 }), /bounded/);
});
