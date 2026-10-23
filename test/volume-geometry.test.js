import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateVolumeGeometry, voxelToPatient, patientToVoxel, MAX_VOLUME_BYTES, VOLUME_BYTES_PER_VOXEL } from '../src/volume/index.js';
import { createVolumeSeries, createAxialSeries } from './volume-fixtures.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} should equal ${b}`);
test('full affine sorts rotated anisotropic planes and preserves regular gantry shear', () => {
    const series = createVolumeSeries(), geometry = validateVolumeGeometry(series.frames);
    assert.deepEqual(geometry.sourceIndices, [2, 0, 1]);
    assert.deepEqual(geometry.origin, [10, 20, 30]);
    assert.deepEqual(geometry.basisX, [0, 3, 0]); assert.deepEqual(geometry.basisY, [-2, 0, 0]); assert.deepEqual(geometry.basisZ, [1, 1, 4]);
    assert.equal(geometry.sheared, true); assert.equal(geometry.sliceDistanceMm, 4);
    assert.equal(geometry.bytes, 3 * 4 * 3 * VOLUME_BYTES_PER_VOXEL);
    const patient = voxelToPatient(geometry, [0.25, 0.75, 0.5]);
    assert.deepEqual(patient, [9, 21.25, 32]);
    const voxel = patientToVoxel(geometry, patient); [0.25, 0.75, 0.5].forEach((value, axis) => close(voxel[axis], value));
    assert.equal(geometry.semanticScope, 'same-series-only');
    assert.ok(Object.isFrozen(geometry)); assert.ok(Object.isFrozen(geometry.inverse));
});

test('non-sheared descending input and rounded valid direction cosines invert without an orthogonal-only shortcut', () => {
    const s = createAxialSeries({ order: [2, 1, 0], orientation: [0.707107, 0.707107, 0, -0.707107, 0.707107, 0] });
    const geometry = validateVolumeGeometry(s.frames);
    assert.deepEqual(geometry.sourceIndices, [2, 1, 0]); assert.equal(geometry.sheared, false);
    const expected = [0.3, 0.7, 1.25], result = patientToVoxel(geometry, voxelToPatient(geometry, expected));
    expected.forEach((value, axis) => close(result[axis], value));
});

test('declared spacing validates the supplied lattice but SliceThickness never supplies missing positions', () => {
    const series = createVolumeSeries();
    series.frames.forEach(frame => { frame.spacingBetweenSlices = 4; frame.sliceThickness = 0.7; frame.sliceLocation = 999; });
    assert.equal(validateVolumeGeometry(series.frames).sliceDistanceMm, 4);
    series.frames.forEach(frame => { frame.spacingBetweenSlices = 2; });
    assert.throws(() => validateVolumeGeometry(series.frames), /declared slice spacing/);
    series.frames.forEach(frame => { frame.position = null; });
    assert.throws(() => validateVolumeGeometry(series.frames), /patient geometry/);
});

test('exposed classic and enhanced dimension families remain explicit instead of becoming slice ordering', () => {
    const series = createVolumeSeries();
    series.frames.forEach(frame => { frame.classicDimensions = { temporalPositionIndex: 2, effectiveEchoTime: 20, echoNumbers: [1], acquisitionNumber: 4,
        imageType: ['ORIGINAL', 'PRIMARY', 'AXIAL'], declaredSpacingBetweenSlices: 4 }; });
    assert.equal(validateVolumeGeometry(series.frames).semanticScope, 'classic-exposed-dimensions');
    series.frames[1].classicDimensions.temporalPositionIndex = 3;
    assert.throws(() => validateVolumeGeometry(series.frames), /nonspatial family differs/);
    for (const frame of series.frames) {
        delete frame.classicDimensions;
        frame.dimensions = { frameOfReferenceUid: frame.frameOfReferenceUid, stackId: 'one', temporalPositionIndex: 1, echoNumbers: [1],
            volumetricProperties: 'VOLUME', indices: [{ organizationUid: '1.2.8', indexPointer: '00209057', functionalGroupPointer: '00209111',
                spatial: true, known: true, resolved: true, ordinal: Number(frame.sopUid.split('.').at(-1)) - 99 }] };
    }
    assert.equal(validateVolumeGeometry(series.frames).semanticScope, 'enhanced-verified-dimensions');
    series.frames[0].dimensions.indices[0].known = false;
    assert.throws(() => validateVolumeGeometry(series.frames), /unknown or unresolved/);
});

test('explicit same-series-only semantic scope is preserved even when classic dimension fields are present but blank', () => {
    const series = createVolumeSeries();
    series.frames.forEach(frame => { frame.classicDimensions = { semanticScope: 'same-series-only', spatialEligible: true,
        temporalPositionIndex: null, effectiveEchoTime: null, echoNumbers: [], acquisitionNumber: null, frameType: [], imageType: [] }; });
    assert.equal(validateVolumeGeometry(series.frames).semanticScope, 'same-series-only');
});

const cases = [
    ['missing Frame of Reference', frame => { frame.frameOfReferenceUid = null; }],
    ['mismatched Series', frame => { frame.seriesUid = '1.2.99'; }],
    ['mismatched units', frame => { frame.unit = 'SUV'; }],
    ['missing explicit units', frame => { delete frame.unit; }],
    ['mismatched modality', frame => { frame.modality = 'MR'; }],
    ['color profile', frame => { frame.photometric = 'RGB'; frame.samplesPerPixel = 3; }],
    ['missing position', frame => { frame.position = null; }],
    ['missing physical spacing', frame => { frame.pixelSpacing = null; }],
    ['nonorthogonal orientation', frame => { frame.orientation = [1, 0, 0, 0.01, 1, 0]; }],
    ['nonunit orientation', frame => { frame.orientation = [2, 0, 0, 0, 1, 0]; }],
    ['spacing differs', frame => { frame.pixelSpacing = [2.1, 3]; }],
    ['invalid exposed scope', frame => { frame.classicDimensions = { invalid: true }; }],
    ['unknown exposed scope', frame => { frame.classicDimensions = { arbitraryPhase: 2 }; }],
    ['ineligible exposed scope', frame => { frame.classicDimensions = { spatialEligible: false }; }],
    ['multiple echoes', frame => { frame.classicDimensions = { echoNumbers: [1, 2] }; }]
];
for (const [name, mutate] of cases) test(`volume geometry rejects ${name}`, () => {
    const series = createVolumeSeries(); mutate(series.frames[1]); assert.throws(() => validateVolumeGeometry(series.frames), /Unsupported reconstruction/);
});

test('duplicate planes, duplicate original identities, nonuniform gaps and changing shear reject', () => {
    for (const variant of ['position', 'identity', 'gap', 'shear']) {
        const series = createVolumeSeries({ order: [0, 1, 2] });
        if (variant === 'position') series.frames[1].position = [...series.frames[0].position];
        if (variant === 'identity') series.frames[1].sopUid = series.frames[0].sopUid;
        if (variant === 'gap') series.frames[2].position = [13, 23, 42];
        if (variant === 'shear') series.frames[2].position = [12, 23, 38];
        assert.throws(() => validateVolumeGeometry(series.frames), /duplicate|irregular|gap/);
    }
});

test('volume budgets, dimensions and single planes reject before pixel acquisition', () => {
    const series = createVolumeSeries();
    assert.throws(() => validateVolumeGeometry(series.frames, { maxBytes: 395 }), /byte budget/);
    assert.throws(() => validateVolumeGeometry(series.frames, { maxBytes: MAX_VOLUME_BYTES + 1 }), /bounded volume/);
    assert.throws(() => validateVolumeGeometry([series.frames[0]]), /two or more/);
    const huge = series.frames.slice(0, 2).map(frame => ({ ...frame, rows: 8192, columns: 2048 }));
    assert.throws(() => validateVolumeGeometry(huge), /byte budget/);
    assert.equal(series.requests.length, 0);
});
