import test from 'node:test';
import assert from 'node:assert/strict';
import { Tag } from '@xinonix/easi-js';
import { DoseGrid } from '../src/specialties/index.js';
import { parseNative, doseFixture, j } from './specialties-fixtures.js';
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

for (const syntax of ['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']) for (const bits of [16, 32]) test(`native dose ${bits}-bit ${syntax} preserves original words and physical scaling`, async () => {
    const instance = await parseNative(doseFixture({ bits, syntax }), syntax), pixel = instance.dataSet.find(Tag.find('7FE00010')), before = pixel.access().slice();
    const dose = await DoseGrid.fromInstance(instance);
    assert.equal(dose.geometry.units, 'GY'); assert.deepEqual(dose.geometry.offsetsMm, [0, 2, 5]); assert.equal(dose.storedAt(1, 1, 2), 25);
    assert.equal(dose.doseAt(1, 1, 2), 12.5); assert.deepEqual([...(await dose.frameValues(1)).values], [4, 5.5, 5, 6.5]);
    close(dose.samplePatient([11.5, 21, 33]), 7.25); // f=0.5*(3*x +2*y +4*z), actual z=3, not frame-index interpolation.
    assert.deepEqual(pixel.access(), before); assert.equal(dose.samplePatient([10, 20, 35], { interpolation: 'nearest' }), 10);
    assert.deepEqual(dose.gridToPatient({ column: 1, row: 1, frameIndex: 2 }), [13, 22, 35]);
    dose.dispose(); assert.equal(dose.bytes, 0); assert.throws(() => dose.doseAt(0, 0, 0), /disposed/); await assert.rejects(dose.frameValues(0), /disposed/);
});
test('native32 OW uses low word first with independent BE bytes and retains unsigned high bit', async () => {
    const syntax = '1.2.840.10008.1.2.2', samples = [0x11223344, 0x89ABCDEF];
    const dose = await DoseGrid.fromInstance(await parseNative(doseFixture({ syntax, bits: 32, rows: 1, columns: 2, offsets: [0], samples, '3004000E': j('DS', 0.001) }), syntax));
    assert.equal(dose.storedAt(0, 0, 0), 0x11223344); assert.equal(dose.storedAt(1, 0, 0), 0x89ABCDEF);
    close(dose.doseAt(1, 0, 0), 0x89ABCDEF * 0.001); dose.dispose();
});
test('rotated anisotropic dose uses full patient basis independently of axial positions', async () => {
    const dose = await DoseGrid.fromInstance(await parseNative(doseFixture({ orientation: [0, 1, 0, 0, 0, 1] })));
    close(dose.samplePatient([13, 21.5, 31]), 7.25); assert.deepEqual(dose.patientToGrid([13, 21.5, 31]), { column: 0.5, row: 0.5, offsetMm: 3 }); dose.dispose();
});
test('descending nonuniform offsets retain original order and interpolate physical distances', async () => {
    const dose = await DoseGrid.fromInstance(await parseNative(doseFixture({ offsets: [0, -2, -5], samples: [100, 103, 102, 105, 92, 95, 94, 97, 80, 83, 82, 85] })));
    assert.deepEqual(dose.geometry.sortedFrameIndices, [2, 1, 0]); close(dose.samplePatient([11.5, 21, 27]), 45.25); assert.equal(dose.storedAt(0, 0, 0), 100); dose.dispose();
});
test('absolute patient Z offset encoding is accepted only for exact transverse geometry', async () => {
    const dose = await DoseGrid.fromInstance(await parseNative(doseFixture({ offsets: [30, 32, 35] })));
    assert.equal(dose.geometry.offsetMode, 'absolute-patient-z'); assert.deepEqual(dose.geometry.offsetsMm, [0, 2, 5]); close(dose.samplePatient([11.5, 21, 33]), 7.25); dose.dispose();
    await assert.rejects(DoseGrid.fromInstance(await parseNative(doseFixture({ offsets: [30, 32, 35], orientation: [0, 1, 0, 0, 0, 1] }))), /absolute dose offsets/);
});
test('RELATIVE doses remain explicitly relative and never convert to Gy', async () => {
    const dose = await DoseGrid.fromInstance(await parseNative(doseFixture({ '30040002': j('CS', 'RELATIVE') })));
    assert.equal(dose.geometry.units, 'RELATIVE'); assert.equal((await dose.frameValues(0)).units, 'RELATIVE'); dose.dispose();
});
for (const [name, overrides] of [
    ['duplicate planes', { offsets: [0, 2, 2] }], ['nonmonotonic planes', { offsets: [0, 5, 2] }], ['invalid first offset', { offsets: [1, 2, 3] }],
    ['ERROR signed quantity', { '30040004': j('CS', 'ERROR'), '00280103': j('US', 1) }], ['unknown units', { '30040002': j('CS', 'CODED') }],
    ['zero scaling', { '3004000E': j('DS', 0) }], ['partial stored bits', { '00280101': j('US', 12) }],
    ['spatial transform', { '30040005': j('CS', 'RIGID') }], ['implicit rescale', { '00281053': j('DS', 1) }],
    ['missing FoR', { '00200052': undefined }], ['invalid orientation', { orientation: [1, 0, 0, 1, 0, 0] }]
]) test(`dose rejects ${name}`, async () => { const raw = doseFixture(overrides); for (const key of Object.keys(raw)) if (raw[key] === undefined) delete raw[key]; await assert.rejects(DoseGrid.fromInstance(await parseNative(raw)), /Unsupported/); });
test('dose rejects wrong FoR, returns NaN outside its lattice and enforces budgets', async () => {
    const instance = await parseNative(doseFixture()), dose = await DoseGrid.fromInstance(instance);
    assert.throws(() => dose.samplePatient([10, 20, 30], { frameOfReferenceUid: '2.25.999' }), /different Frame/);
    assert.ok(Number.isNaN(dose.samplePatient([9.99, 20, 30]))); assert.ok(Number.isNaN(dose.samplePatient([10, 20, 35.001])));
    await assert.rejects(DoseGrid.fromInstance(instance, { maxBytes: 16 }), /budget/); dose.dispose();
});
test('dose cancellation is prompt during copying and derived-plane processing', async () => {
    const samples = Array(512 * 256 * 3).fill(40), instance = await parseNative(doseFixture({ rows: 512, columns: 256, samples })), controller = new AbortController();
    const loading = DoseGrid.fromInstance(instance, { signal: controller.signal }); queueMicrotask(() => controller.abort()); await assert.rejects(loading, { name: 'AbortError' });
    const dose = await DoseGrid.fromInstance(instance), canceled = new AbortController(), pending = dose.frameValues(0, { signal: canceled.signal });
    queueMicrotask(() => canceled.abort()); await assert.rejects(pending, { name: 'AbortError' });
    const disposed = dose.frameValues(0); dose.dispose(); await assert.rejects(disposed, /disposed/);
});
