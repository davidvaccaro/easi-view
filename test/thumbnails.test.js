import test from 'node:test';
import assert from 'node:assert/strict';
import { createThumbnail, ThumbnailCache } from '../src/data/thumbnails.js';

test('thumbnail uses bounded center sampling and preserves original scalar values', () => {
    const samples = Uint16Array.from({ length: 32 * 32 }, (_, index) => index);
    const original = samples.slice();
    const result = createThumbnail({ rows: 32, columns: 32, samples, photometric: 'MONOCHROME2', slope: 1, intercept: 0,
        voiFunction: 'LINEAR_EXACT', window: { center: 511.5, width: 1023 } }, { maximumSize: 16 });
    assert.equal(result.rows, 16); assert.equal(result.columns, 16); assert.equal(result.rgba.byteLength, 1024);
    // Pixel(0,0) selects original(1,1) =33; final pixel selects(31,31)=1023.
    assert.deepEqual([...result.rgba.slice(0, 4)], [8, 8, 8, 255]);
    assert.deepEqual([...result.rgba.slice(-4)], [255, 255, 255, 255]);
    assert.deepEqual(samples, original); assert.equal(result.derived, true);
});

test('RGB thumbnail retains independently selected channels and palette source retains its indices', () => {
    const rgb = { rows: 1, columns: 2, photometric: 'RGB', samplesPerPixel: 3, samples: Uint8Array.of(13, 42, 200, 255, 0, 128) };
    assert.deepEqual([...createThumbnail(rgb).rgba], [13, 42, 200, 255, 255, 0, 128, 255]);
    const samples = Uint16Array.of(0, 1);
    const palette = { rows: 1, columns: 2, photometric: 'PALETTE COLOR', samplesPerPixel: 1, samples,
        palette: { count: 2, firstMapped: 0, bits: 16, red: Uint16Array.of(0, 65535), green: Uint16Array.of(65535, 0), blue: Uint16Array.of(0, 32768) } };
    assert.deepEqual([...createThumbnail(palette).rgba], [0, 255, 0, 255, 255, 0, 128, 255]);
    assert.deepEqual([...samples], [0, 1]);
});

test('thumbnail shutter uses sampled original coordinates and final P-values across noninteger resizing, polarity and padding', () => {
    const rows = 37, columns = 53, samples = new Uint16Array(rows * columns).fill(200);
    for (const photometric of ['MONOCHROME1', 'MONOCHROME2']) for (const padded of [false, true]) {
        const displayShutter = Object.freeze({ shape: 'CIRCULAR', row: 19, column: 39, radius: 7,
            presentationValue: 32768, presentationValueDeclared: true });
        const original = samples.slice(), originalShutter = { ...displayShutter };
        const frame = { rows, columns, samples, photometric, pixelSpacing: [1, 1], slope: 1, intercept: 0,
            voiFunction: 'LINEAR_EXACT', presentationInvert: photometric === 'MONOCHROME1',
            window: { center: 100, width: 400 }, displayShutter,
            ...(padded ? { padding: { value: 200, limit: 200 } } : {}) };
        const thumbnail = createThumbnail(frame, { maximumSize: 16 });
        assert.equal(thumbnail.rows, 11); assert.equal(thumbnail.columns, 16);
        let boundaryPixels = 0, insidePixels = 0, outsidePixels = 0;
        for (let y = 0; y < 11; y++) for (let x = 0; x < 16; x++) {
            // Independent integer center-sampling oracle in the original raster.
            const row = Math.trunc((2 * y + 1) * rows / 22) + 1;
            const column = Math.trunc((2 * x + 1) * columns / 32) + 1;
            const distanceSquared = (row - 19) ** 2 + (column - 39) ** 2;
            const outside = distanceSquared > 49;
            if (outside) outsidePixels++; else insidePixels++;
            if (distanceSquared === 49) boundaryPixels++;
            const gray = outside ? 128 : padded ? 0 : photometric === 'MONOCHROME1' ? 64 : 191;
            assert.deepEqual([...thumbnail.rgba.subarray((y * 16 + x) * 4, (y * 16 + x + 1) * 4)], [gray, gray, gray, 255]);
        }
        assert.ok(boundaryPixels > 0 && insidePixels > 0 && outsidePixels > 0);
        assert.deepEqual(samples, original); assert.deepEqual(displayShutter, originalShutter);
        assert.equal(frame.rows, rows); assert.equal(frame.columns, columns); assert.equal(frame.displayShutter, displayShutter);
    }
});

test('the native-size RF shutter center remains valid when generating a bounded default thumbnail', () => {
    const samples = new Uint16Array(512 * 512).fill(200);
    const frame = { rows: 512, columns: 512, samples, photometric: 'MONOCHROME2',
        voiFunction: 'LINEAR_EXACT', window: { center: 100, width: 400 },
        displayShutter: { shape: 'CIRCULAR', row: 256, column: 256, radius: 254,
            presentationValue: 0, presentationValueDeclared: false } };
    const result = createThumbnail(frame);
    assert.equal(result.rows, 96); assert.equal(result.columns, 96);
    assert.deepEqual([...result.rgba.subarray(0, 4)], [0, 0, 0, 255]);
    assert.deepEqual([...result.rgba.subarray((48 * 96 + 48) * 4, (48 * 96 + 49) * 4)], [191, 191, 191, 255]);
    assert.throws(() => createThumbnail({ ...frame, displayShutter: { ...frame.displayShutter, row: 513 } }), /display-shutter profile/);
});

test('thumbnail LRU budgets derived display arrays and clears without owning decoded frames', () => {
    const cache = new ThumbnailCache(12);
    const thumbnail = () => ({ rows: 1, columns: 2, rgba: new Uint8ClampedArray(8) });
    const first = thumbnail(), second = thumbnail();
    cache.set('a', first); assert.equal(cache.bytes, 8);
    cache.set('b', second); assert.equal(cache.bytes, 8); assert.equal(cache.get('a'), null); assert.equal(cache.get('b'), second);
    cache.clear(); assert.equal(cache.entries.size, 0); assert.equal(cache.bytes, 0);
    assert.equal(second.rgba.length, 8);
    assert.throws(() => new ThumbnailCache(0)); assert.throws(() => createThumbnail({}, { maximumSize: 1024 }));
});
