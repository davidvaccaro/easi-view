import test from 'node:test';
import assert from 'node:assert/strict';
import { Volume } from '../src/volume/Volume.js';
import { validateVolumeGeometry, dot } from '../src/volume/geometry.js';
import { reslice } from '../src/volume/reslice.js';
import { patientBounds, patientBasis, createPatientPlane, raySamplingPlan, derivedToRgba, displayTransfer, probeDerived, derivedCanvasPoint } from '../src/render/ReconstructionMath.js';
import { createAxialSeries, createVolumeSeries } from './volume-fixtures.js';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('patient bounds include all eight rotated/sheared affine center corners', () => {
    const bounds = patientBounds(validateVolumeGeometry(createVolumeSeries().frames));
    assert.deepEqual(bounds.minimum, [6, 20, 30]); assert.deepEqual(bounds.maximum, [12, 31, 38]);
    assert.equal(bounds.corners.length, 8); assert.deepEqual(bounds.center, [9, 25.5, 34]);
});

test('LPS planes use explicit orthonormal patient axes and square physical pixels fitted to all corners', () => {
    const geometry = validateVolumeGeometry(createVolumeSeries().frames), bounds = patientBounds(geometry);
    for (const view of ['axial', 'sagittal', 'coronal', 'oblique']) {
        const plane = createPatientPlane(geometry, { view, yawDeg: 37, pitchDeg: -28, maximumSize: 128 });
        const x = plane.orientation.slice(0, 3), y = plane.orientation.slice(3), spanX = (plane.columns - 1) * plane.pixelSpacing[1], spanY = (plane.rows - 1) * plane.pixelSpacing[0];
        near(dot(x, y), 0); near(Math.hypot(...x), 1); near(Math.hypot(...y), 1);
        assert.equal(plane.pixelSpacing[0], plane.pixelSpacing[1]); assert.ok(plane.rows <= 128 && plane.columns <= 128);
        for (const point of bounds.corners) {
            const u = dot(point, x) - dot(plane.origin, x), v = dot(point, y) - dot(plane.origin, y);
            assert.ok(u >= -1e-9 && u <= spanX + 1e-9); assert.ok(v >= -1e-9 && v <= spanY + 1e-9);
        }
    }
    assert.deepEqual(patientBasis('axial'), [1, 0, 0, 0, 1, 0]);
    assert.deepEqual(patientBasis('coronal'), [1, 0, 0, 0, 0, -1]);
    assert.deepEqual(patientBasis('sagittal'), [0, 1, 0, 0, 0, -1]);
});

test('ray camera starts at front bounds and sample work is capped before allocation', () => {
    const geometry = validateVolumeGeometry(createVolumeSeries().frames);
    const selected = createPatientPlane(geometry, { view: 'oblique', maximumSize: 256, position: 1, yawDeg: 45, pitchDeg: 35 });
    const plan = raySamplingPlan(geometry, selected), range = patientBounds(geometry).corners.map(point => dot(point, plan.plane.normal));
    near(dot(plan.plane.origin, plan.plane.normal), Math.min(...range));
    near(plan.farMm, Math.max(...range) - Math.min(...range)); assert.equal(plan.nearMm, 0);
    assert.ok(plan.steps * plan.plane.rows * plan.plane.columns <= 16 * 1024 * 1024);
    const deep = { ...geometry, depth: 4096, basisZ: [100, 100, 100] };
    const capped = raySamplingPlan(deep, createPatientPlane(deep, { maximumSize: 256 }));
    assert.ok(capped.steps <= 256); assert.ok(capped.stepMm > 0);
});

test('derived display keeps Float64 quantitative values and applies modality window exactly once with padding transparency', async () => {
    const values = new Float64Array([-1, 0, 1, 2, 16777217.25]), valid = new Uint8Array([1, 1, 1, 0, 1]);
    const image = { rows: 1, columns: 5, values, valid };
    const rgba = await derivedToRgba(image, { center: 0, width: 2, voiFunction: 'LINEAR_EXACT' });
    assert.deepEqual([...rgba.subarray(0, 12)], [0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255]);
    assert.deepEqual([...rgba.subarray(12, 16)], [0, 0, 0, 0]); assert.equal(values[4], 16777217.25);
    const inverse = await derivedToRgba(image, { center: 0, width: 2, voiFunction: 'LINEAR_EXACT' }, { presentationInvert: true });
    assert.equal(inverse[0], 255); assert.equal(inverse[8], 0);
    near(displayTransfer({ center: 0, width: 4, voiFunction: 'SIGMOID' })(0)[0], 0.5);
    assert.deepEqual(displayTransfer({ center: 0, width: 2, voiFunction: 'LINEAR_EXACT' }, { color: 'warm', opacity: 0.1, rampOpacity: true })(0), [0.5, 0.3, 0.1, 0.05]);
});

test('analytic modality-plane probes retain patient coordinates and ray probes only report composite color', async () => {
    const volume = await Volume.fromSeries(createAxialSeries());
    try {
        const plane = createPatientPlane(volume.geometry, { maximumSize: 2, position: 0.5 });
        const image = await reslice(volume, plane);
        assert.deepEqual(probeDerived(image, 1, 1), { kind: 'derived-modality', projection: 'slice', value: 111, unit: 'HU', patient: [1, 1, 1] });
        assert.equal(probeDerived(image, 2, 0), null);
        const ray = { rows: 1, columns: 1, rgba: new Uint8ClampedArray([10, 20, 30, 40]), mode: 'composite' };
        assert.deepEqual(probeDerived(ray, 0, 0), { kind: 'parallel-ray-color', mode: 'composite', rgba: [10, 20, 30, 40] });
    } finally { volume.dispose(); }
});

test('invalid plane, display, and canceled conversion options fail without changing input values', async () => {
    const geometry = validateVolumeGeometry(createAxialSeries().frames);
    for (const options of [{ maximumSize: 257 }, { position: -1 }, { yawDeg: Infinity }, { pitchDeg: 91 }, { view: 'unknown' }]) assert.throws(() => createPatientPlane(geometry, options));
    assert.throws(() => displayTransfer({ center: 0, width: 0 })); assert.throws(() => displayTransfer({ center: 0, width: 1 }, { opacity: 2 }));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(derivedToRgba({ rows: 1, columns: 1, values: new Float64Array([1]), valid: new Uint8Array([1]) }, { center: 0, width: 1 }, { signal: controller.signal }), { name: 'AbortError' });
});

test('centered Canvas2D contain letterboxing maps only visible image pixels to probes', () => {
    const box = { left: 20, top: 30, width: 200, height: 200 }, image = { columns: 100, rows: 50 };
    assert.deepEqual(derivedCanvasPoint(box, image, 120, 130), { column: 50, row: 25 });
    assert.equal(derivedCanvasPoint(box, image, 120, 31), null); assert.equal(derivedCanvasPoint(box, image, 220, 130), null);
    const vertical = { columns: 50, rows: 100 }; assert.equal(derivedCanvasPoint(box, vertical, 21, 130), null);
    assert.deepEqual(derivedCanvasPoint(box, vertical, 120, 130), { column: 25, row: 50 });
});

test('an extent thinner than one output pixel uses a centered sample instead of two entirely outside planes', async () => {
    const source = createAxialSeries({ basisZ: [0, 0, 1000] }), volume = await Volume.fromSeries(source);
    try {
        const plane = createPatientPlane(volume.geometry, { view: 'coronal', maximumSize: 128 });
        assert.equal(plane.columns, 1); near(plane.origin[0], 0.5);
        const image = await reslice(volume, plane); assert.ok(image.valid.every(value => value === 1));
    } finally { volume.dispose(); }
});
