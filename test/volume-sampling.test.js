import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Volume, reslice, raycast, MAX_RECONSTRUCTION_OUTPUT_BYTES } from '../src/volume/index.js';
import { createVolumeSeries, createAxialSeries } from './volume-fixtures.js';

function close(a, b, epsilon = 1e-9) { assert.ok(Math.abs(a - b) <= epsilon, `${a} should equal ${b}`); }
const axialPlane = { rows: 2, columns: 2, origin: [0, 0, 1], orientation: [1, 0, 0, 0, 1, 0], pixelSpacing: [1, 1] };
test('nearest and trilinear reproduce an independent analytic patient field across a rotated sheared lattice', async () => {
    const volume = await Volume.fromSeries(createVolumeSeries());
    try {
        assert.equal(volume.samplePatient([9, 21.25, 32]), 199);
        close(volume.sampleVoxel([0.25, 0.75, 0.5]), 199);
        assert.equal(volume.sampleVoxel([0.25, 0.75, 0.5], { interpolation: 'nearest' }), 204);
        for (const x of [0, 0.2, 1.7, 3]) for (const y of [0, 0.5, 2]) for (const z of [0, 0.75, 2]) {
            const p = volume.voxelToPatient([x, y, z]);
            close(volume.samplePatient(p), 2 * p[0] + 4 * p[1] + 3 * p[2]);
        }
        assert.ok(Number.isNaN(volume.sampleVoxel([-0.01, 0, 0])));
        assert.ok(Number.isNaN(volume.sampleVoxel([3.01, 0, 0])));
        assert.throws(() => volume.sampleVoxel([NaN, 0, 0]), /patient geometry/);
        assert.throws(() => volume.sampleVoxel([0, 0, 0], { interpolation: 'cubic' }), /sampling mode/);
    } finally { volume.dispose(); }
});

test('trilinear interpolation never blends through padding or renormalizes missing neighbors', async () => {
    const series = createAxialSeries({ padding: { value: 0, limit: 0 } }), volume = await Volume.fromSeries(series);
    try {
        assert.ok(Number.isNaN(volume.sampleVoxel([0, 0, 0])));
        assert.ok(Number.isNaN(volume.sampleVoxel([0.5, 0.5, 0.5])));
        assert.equal(volume.sampleVoxel([1, 1, 0]), 11); // Zero-weight padding neighbors are ignored.
        assert.equal(volume.sampleVoxel([1, 1, 0], { domain: 'stored' }), 11);
        assert.equal(volume.storedAt(0, 0, 0), 0); // Original padding remains available explicitly.
    } finally { volume.dispose(); }
});

test('orthogonal reslices place the first pixel center at the supplied origin and retain modality units', async () => {
    const volume = await Volume.fromSeries(createAxialSeries());
    try {
        const axial = await reslice(volume, axialPlane);
        assert.deepEqual([...axial.values], [100, 101, 110, 111]); assert.deepEqual([...axial.valid], [1, 1, 1, 1]);
        assert.equal(axial.unit, 'HU'); assert.equal(axial.bytes, 36);
        const coronal = await reslice(volume, { rows: 3, columns: 2, origin: [0, 1, 0], orientation: [1, 0, 0, 0, 0, 1], pixelSpacing: [1, 1] });
        assert.deepEqual([...coronal.values], [10, 11, 110, 111, 210, 211]);
        const sagittal = await reslice(volume, { rows: 3, columns: 2, origin: [1, 0, 0], orientation: [0, 1, 0, 0, 0, 1], pixelSpacing: [1, 1] });
        assert.deepEqual([...sagittal.values], [1, 11, 101, 111, 201, 211]);
    } finally { volume.dispose(); }
});

test('oblique plane interpolation follows physical patient coordinates independently of input voxel axes', async () => {
    const volume = await Volume.fromSeries(createVolumeSeries());
    try {
        const q = Math.SQRT1_2;
        const plane = { rows: 2, columns: 2, origin: [9.5, 22.5, 33], orientation: [q, q, 0, -q, q, 0], pixelSpacing: [0.25, 0.5] };
        const result = await reslice(volume, plane);
        for (let row = 0; row < 2; row++) for (let column = 0; column < 2; column++) {
            const p = [9.5 + q * column * 0.5 - q * row * 0.25, 22.5 + q * column * 0.5 + q * row * 0.25, 33];
            close(result.values[row * 2 + column], 2 * p[0] + 4 * p[1] + 3 * p[2]);
        }
        const missing = await reslice(volume, { ...plane, origin: [999, 999, 999] });
        assert.ok([...missing.values].every(Number.isNaN)); assert.ok([...missing.valid].every(value => value === 0));
    } finally { volume.dispose(); }
});

test('MIP, minIP and mean use explicit symmetric slab thickness and sample counts', async () => {
    const volume = await Volume.fromSeries(createAxialSeries());
    try {
        for (const [projection, expected] of [['mip', [200, 201, 210, 211]], ['minip', [0, 1, 10, 11]], ['mean', [100, 101, 110, 111]]]) {
            const result = await reslice(volume, axialPlane, { projection, thicknessMm: 2, samples: 3 });
            assert.deepEqual([...result.values], expected); assert.equal(result.samples, 3); assert.equal(result.thicknessMm, 2);
        }
        const stored = await reslice(volume, axialPlane, { domain: 'stored' }); assert.equal(stored.unit, 'stored');
    } finally { volume.dispose(); }
});

test('slab projection explicitly excludes padding/outside samples and preserves a wholly empty pixel as NaN', async () => {
    const volume = await Volume.fromSeries(createAxialSeries({ padding: { value: 0, limit: 0 } }));
    try {
        const mean = await reslice(volume, axialPlane, { projection: 'mean', thicknessMm: 2, samples: 3 });
        assert.equal(mean.values[0], 150); // Only100/200 participate; original0 is padding.
        assert.deepEqual([...mean.values].slice(1), [101, 110, 111]);
        const empty = await reslice(volume, { ...axialPlane, origin: [50, 50, 50] }, { projection: 'mean', thicknessMm: 2, samples: 3 });
        assert.ok([...empty.values].every(Number.isNaN)); assert.deepEqual([...empty.valid], [0, 0, 0, 0]);
    } finally { volume.dispose(); }
});

test('slab and output budgets validate before work; canceled reslices publish no partial output', async () => {
    const volume = await Volume.fromSeries(createAxialSeries());
    try {
        for (const options of [{ samples: 2 }, { projection: 'mean', thicknessMm: 1, samples: 1 }, { projection: 'mip', thicknessMm: 1, samples: 1025 },
            { maxBytes: 35 }, { maxBytes: MAX_RECONSTRUCTION_OUTPUT_BYTES + 1 }]) await assert.rejects(reslice(volume, axialPlane, options), /Unsupported reconstruction/);
        await assert.rejects(reslice(volume, { ...axialPlane, rows: 4096, columns: 4096 }, { projection: 'mip', thicknessMm: 2, samples: 3 }), /sample count|byte budget/);
        const controller = new AbortController(), promise = reslice(volume, axialPlane, { signal: controller.signal });
        controller.abort(); await assert.rejects(promise, { name: 'AbortError' });
        const disposed = reslice(volume, axialPlane); volume.dispose(); await assert.rejects(disposed, /disposed/);
    } finally { volume.dispose(); }
});

test('parallel CPU MIP/minIP/mean rays use explicit color transfer after quantitative projection', async () => {
    const volume = await Volume.fromSeries(createAxialSeries());
    try {
        const plane = { ...axialPlane, origin: [0, 0, 0] }, transferFunction = value => [value / 255, 0, 0, 1];
        for (const [mode, expected] of [['mip', [200, 201, 210, 211]], ['minip', [0, 1, 10, 11]], ['mean', [100, 101, 110, 111]]]) {
            const result = await raycast(volume, plane, { nearMm: 0, farMm: 2, stepMm: 1, mode, transferFunction });
            assert.deepEqual([...result.rgba].filter((_, index) => index % 4 === 0), expected);
            assert.equal(result.steps, 3); assert.equal(result.bytes, 16);
        }
    } finally { volume.dispose(); }
});

test('front-to-back ray compositing returns straight RGBA with independent opacity reference', async () => {
    const volume = await Volume.fromSeries(createAxialSeries({ rows: 1, columns: 1, depth: 2, field: (_, __, z) => z }));
    try {
        const plane = { ...axialPlane, rows: 1, columns: 1, origin: [0, 0, 0] };
        const rgba = await raycast(volume, plane, { nearMm: 0, farMm: 1, stepMm: 1,
            transferFunction: value => value === 0 ? [1, 0, 0, 0.5] : [0, 0, 1, 0.5] });
        assert.deepEqual([...rgba.rgba], [170, 0, 85, 191]); // Premult(.5,0,.25)/alpha.75.
        const early = await raycast(volume, plane, { nearMm: 0, farMm: 1, stepMm: 1, transferFunction: () => [0, 1, 0, 1] });
        assert.deepEqual([...early.rgba], [0, 255, 0, 255]);
        const outside = await raycast(volume, { ...plane, origin: [10, 0, 0] }, { nearMm: 0, farMm: 1, stepMm: 1, transferFunction: () => [1, 0, 0, 1] });
        assert.deepEqual([...outside.rgba], [0, 0, 0, 0]);
    } finally { volume.dispose(); }
});

test('raycast step/ray/output caps, explicit transfer validation and cancellation remain bounded', async () => {
    const volume = await Volume.fromSeries(createAxialSeries());
    try {
        const defaults = { nearMm: 0, farMm: 2, stepMm: 1, transferFunction: () => [1, 1, 1, 1] };
        for (const options of [{ nearMm: undefined }, { stepMm: 0 }, { farMm: 5000 }, { maxBytes: 15 }, { rayDirection: [0, 0, 2] },
            { transferFunction: () => [2, 0, 0, 1] }, { transferFunction: () => [0, 0, 0, NaN] }]) {
            await assert.rejects(raycast(volume, axialPlane, { ...defaults, ...options }), /Unsupported reconstruction/);
        }
        await assert.rejects(raycast(volume, { ...axialPlane, rows: 2048, columns: 2048 }, { ...defaults, farMm: 4 }), /operation budget/);
        const controller = new AbortController();
        const canceled = raycast(volume, axialPlane, { ...defaults, signal: controller.signal }); controller.abort();
        await assert.rejects(canceled, { name: 'AbortError' });
    } finally { volume.dispose(); }
});
