import test from 'node:test';
import assert from 'node:assert/strict';
import { specialtyWindow, specialtyValuesToRgba, specialtyCanvasPoint } from '../src/ui/SpecialtyWorkspace.js';

test('specialty Float64 display uses explicit LINEAR_EXACT values without changing quantitative samples', async () => {
    const values = Float64Array.of(-20, 0, 20, 40), before = [...values], rgba = await specialtyValuesToRgba(values, 1, 4, { center: 0, width: 40 });
    assert.deepEqual([...rgba], [0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255, 255, 255, 255, 255]); assert.deepEqual([...values], before);
    const highPrecision = Float64Array.of(16777217.25), image = await specialtyValuesToRgba(highPrecision, 1, 1, { center: 16777217.25, width: 2 }); assert.equal(image[0], 128);
});
test('specialty scalar display never rescales the observed range or rounds uint32 quantitative values', async () => {
    const result = await specialtyValuesToRgba(Float64Array.of(10, 11), 1, 2, { center: 50, width: 100 }); assert.deepEqual([result[0], result[4]], [25, 28]);
    const value = 0x89ABCDEF * 0.001; assert.equal((await specialtyValuesToRgba(Float64Array.of(value), 1, 1, { center: value, width: 1000 }))[0], 128);
});
test('specialty image coordinates exclude letterboxes and use anisotropic pixel aspect without distortion', () => {
    const rect = { left: 10, top: 20, width: 400, height: 400 }, dimensions = { columns: 2, rows: 2, pixelAspect: 1.5 };
    assert.equal(specialtyCanvasPoint(rect, dimensions, 20, 30), null);
    assert.deepEqual(specialtyCanvasPoint(rect, dimensions, 110, 220), { column: 0, row: 1 });
    assert.deepEqual(specialtyCanvasPoint(rect, dimensions, 310, 220), { column: 1, row: 1 });
    assert.equal(specialtyCanvasPoint(rect, dimensions, 410, 220), null); assert.equal(specialtyCanvasPoint(rect, dimensions, Infinity, 220), null);
});
test('specialty display guards exact dimensions, scalar buffers, finite values and allocation caps', async () => {
    assert.throws(() => specialtyWindow({ center: 0, width: -1 }), /positive/); assert.throws(() => specialtyWindow({ center: 0, width: 2, observedRange: true }), TypeError);
    await assert.rejects(specialtyValuesToRgba(Float64Array.of(NaN), 1, 1, { center: 0, width: 1 }), /nonfinite/);
    await assert.rejects(specialtyValuesToRgba(Float64Array.of(1), 1, 2, { center: 0, width: 1 }), /invalid dimensions/);
    await assert.rejects(specialtyValuesToRgba(Float64Array.of(1), 1, 1, { center: 0, width: 1 }, { maxBytes: 3 }), /buffer budget/);
    const controller = new AbortController(); const pending = specialtyValuesToRgba(new Float64Array(131072), 256, 512, { center: 0, width: 1 }, { signal: controller.signal });
    queueMicrotask(() => controller.abort()); await assert.rejects(pending, { name: 'AbortError' });
});
