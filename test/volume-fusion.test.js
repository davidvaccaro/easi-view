import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Volume, createFusion, renderFusion, validateRigidRegistration } from '../src/volume/index.js';
import { createAxialSeries, identityRegistration } from './volume-fixtures.js';

const plane = { rows: 2, columns: 2, origin: [0, 0, 1], orientation: [1, 0, 0, 0, 1, 0], pixelSpacing: [1, 1] };
const red = () => [1, 0, 0, 1], blue = () => [0, 0, 1, 1];
test('fusion requires an explicit rigid registration even when volumes share a Frame of Reference', async () => {
    const base = await Volume.fromSeries(createAxialSeries()), overlay = await Volume.fromSeries(createAxialSeries({ unit: 'SUV', field: (x, y, z) => 5 + x + 2 * y + 3 * z }));
    try {
        assert.throws(() => createFusion(base, overlay), /explicit homogeneous rigid/);
        const fusion = createFusion(base, overlay, { registration: identityRegistration });
        assert.deepEqual(fusion.samplePatient([1, 1, 1]), { base: 111, overlay: 11 });
        const alpha = await renderFusion(fusion, plane, { baseTransferFunction: red, overlayTransferFunction: blue, alpha: 0.25 });
        assert.deepEqual([...alpha.rgba], Array(4).fill([191, 0, 64, 255]).flat());
        assert.deepEqual([...alpha.baseValues], [100, 101, 110, 111]); assert.deepEqual([...alpha.overlayValues], [8, 9, 10, 11]);
        assert.equal(alpha.baseUnit, 'HU'); assert.equal(alpha.overlayUnit, 'SUV'); assert.equal(alpha.bytes, 88);
        assert.equal(fusion.samplePatient([0.5, 0.5, 1.5]).overlay, 11);
        fusion.dispose(); assert.throws(() => fusion.samplePatient([0, 0, 0]), /disposed/);
        assert.equal(base.bytes, 132); assert.equal(overlay.bytes, 132); // Fusion does not own them.
    } finally { base.dispose(); overlay.dispose(); }
});

test('cross-Frame-of-Reference translation must explicitly name source and target and maps base→overlay', async () => {
    const base = await Volume.fromSeries(createAxialSeries());
    const overlay = await Volume.fromSeries(createAxialSeries({ origin: [10, 20, 30], frameOfReferenceUid: '1.2.10', field: (x, y, z) => x + 10 * y + 100 * z }));
    try {
        const matrix = [1, 0, 0, 10, 0, 1, 0, 20, 0, 0, 1, 30, 0, 0, 0, 1];
        assert.throws(() => createFusion(base, overlay, { registration: { matrix } }), /identifiers must match/);
        const fusion = createFusion(base, overlay, { registration: { matrix, fromFrameOfReferenceUid: '1.2.9', toFrameOfReferenceUid: '1.2.10' } });
        assert.deepEqual(fusion.samplePatient([0.25, 0.75, 0.5]), { base: 57.75, overlay: 57.75 });
        matrix[3] = 999; // Input mutation cannot change an established registration.
        assert.deepEqual(fusion.samplePatient([0, 0, 1]), { base: 100, overlay: 100 });
        fusion.dispose();
    } finally { base.dispose(); overlay.dispose(); }
});

test('rigid rotations are accepted; scales, shear, reflection, perspective and mismatched identifiers reject', () => {
    const rotation = [0, -1, 0, 1, 1, 0, 0, 2, 0, 0, 1, 3, 0, 0, 0, 1];
    assert.deepEqual(validateRigidRegistration({ matrix: rotation }, '1.2.9', '1.2.9'), rotation);
    for (const [index, value] of [[0, 2], [1, 0.1], [10, -1], [12, 1], [15, 2], [3, Infinity]]) {
        const matrix = [...identityRegistration.matrix]; matrix[index] = value;
        assert.throws(() => validateRigidRegistration({ matrix }, '1.2.9', '1.2.9'), /Unsupported reconstruction/);
    }
    assert.throws(() => validateRigidRegistration({ ...identityRegistration, fromFrameOfReferenceUid: '1.2.7' }, '1.2.9', '1.2.9'), /identifiers must match/);
});

test('checkerboards choose explicit output-grid tiles while retaining both quantitative sample arrays', async () => {
    const base = await Volume.fromSeries(createAxialSeries()), overlay = await Volume.fromSeries(createAxialSeries({ field: () => 7 }));
    const fusion = createFusion(base, overlay, { registration: identityRegistration });
    try {
        const result = await renderFusion(fusion, plane, { mode: 'checkerboard', checkerSize: 1, baseTransferFunction: red, overlayTransferFunction: blue });
        assert.deepEqual([...result.rgba], [255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255, 255, 0, 0, 255]);
        assert.deepEqual([...result.baseValid], [1, 1, 1, 1]); assert.deepEqual([...result.overlayValues], [7, 7, 7, 7]);
    } finally { fusion.dispose(); base.dispose(); overlay.dispose(); }
});

test('missing fusion samples stay NaN/transparent rather than becoming invented quantitative values', async () => {
    const base = await Volume.fromSeries(createAxialSeries()), overlay = await Volume.fromSeries(createAxialSeries({ padding: { value: 100, limit: 100 } }));
    const fusion = createFusion(base, overlay, { registration: identityRegistration });
    try {
        const result = await renderFusion(fusion, plane, { baseTransferFunction: red, overlayTransferFunction: blue, alpha: 0.5 });
        assert.ok(Number.isNaN(result.overlayValues[0])); assert.equal(result.overlayValid[0], 0);
        assert.deepEqual([...result.rgba].slice(0, 4), [255, 0, 0, 255]);
        const outside = await renderFusion(fusion, { ...plane, origin: [90, 90, 90] }, { baseTransferFunction: red, overlayTransferFunction: blue });
        assert.ok([...outside.baseValues].every(Number.isNaN)); assert.ok([...outside.overlayValues].every(Number.isNaN));
        assert.ok([...outside.rgba].every(value => value === 0));
    } finally { fusion.dispose(); base.dispose(); overlay.dispose(); }
});

test('fusion output byte cap, cancellation and dependent volume disposal prevent partial output publication', async () => {
    const base = await Volume.fromSeries(createAxialSeries()), overlay = await Volume.fromSeries(createAxialSeries());
    const fusion = createFusion(base, overlay, { registration: identityRegistration });
    const options = { baseTransferFunction: red, overlayTransferFunction: blue };
    try {
        await assert.rejects(renderFusion(fusion, plane, { ...options, maxBytes: 87 }), /byte budget/);
        const controller = new AbortController(), canceled = renderFusion(fusion, plane, { ...options, signal: controller.signal }); controller.abort();
        await assert.rejects(canceled, { name: 'AbortError' });
        const disposed = renderFusion(fusion, plane, options); overlay.dispose(); await assert.rejects(disposed, /disposed/);
    } finally { fusion.dispose(); base.dispose(); overlay.dispose(); }
});
