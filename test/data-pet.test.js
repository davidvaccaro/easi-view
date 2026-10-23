import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFiles } from '../src/data/sources.js';
import { createDicomFixture } from '../src/data/synthetic.js';
import { CLASSIC_PET_SOP_CLASS, PET_DIMENSION_FIELDS, validatedPetDimensionValues } from '../src/data/classic-dimensions.js';
import { evaluateModality } from '../src/data/presentation-math.js';
import { renderScalarToRgba } from '../src/render/DisplayMath.js';
import { nearestSyncedSlice, compatibleWindow } from '../src/runtime/workspace.js';
import { frameGeometry, validateVolumeGeometry } from '../src/volume/geometry.js';
import { Volume } from '../src/volume/Volume.js';

function petFile(index = 1, options = {}) {
    return new File([createDicomFixture({ sopClass: CLASSIC_PET_SOP_CLASS, modality: 'PT',
        sopUid: `2.25.905.1.${index}`, seriesUid: '2.25.905.1', instanceNumber: index, signed: true,
        values: [-2, 0, 2, 4], slope: 2.5, position: [0, 0, (index - 1) % 2 * 2], ...options,
        extraAttributes: { '00080008': ['CS', ['ORIGINAL', 'PRIMARY']], '00200052': ['UI', '2.25.905'],
            '00541000': ['CS', ['STATIC', 'IMAGE']], '00541001': ['CS', 'BQML'], '00541002': ['CS', 'EMISSION'],
            '00541102': ['CS', 'START'], '00540081': ['US', 2], '00541300': ['DS', 1000], '00541330': ['US', index],
            '00280051': ['CS', ['ATTN', 'DECY']], ...options.extraAttributes }
    })], 'generated-pet.dcm', { type: 'application/dicom' });
}

async function inspect(files, action) {
    const sources = await loadFiles(files);
    try { await action(sources); } finally { sources.forEach(source => source.dispose()); }
}

for (const transferSyntax of ['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']) {
    for (const signed of [true, false]) test(`classic PET preserves stored samples and applies declared BQML rescale once (${transferSyntax}, signed=${signed})`, async () => {
        const values = signed ? [-2, 0, 2, 4] : [0, 1, 2, 65535];
        const file = petFile(1, { transferSyntax, signed, values });
        const original = new Uint8Array(await file.arrayBuffer());
        await inspect([file], async ([source]) => {
            const frame = await source.getFrame(0);
            assert.deepEqual([...frame.samples], values);
            assert.deepEqual(frame.range, { min: values[0] * 2.5, max: values[3] * 2.5 });
            assert.equal(frame.unit, 'BQML'); assert.equal(frame.slope, 2.5); assert.equal(frame.intercept, 0);
            assert.equal(evaluateModality(frame.samples[2], frame), 5);
            assert.equal(frame.classicDimensions.petUnits, 'BQML');
            assert.equal(frame.classicDimensions.petFrameReferenceTime, 1000);
            assert.equal(frame.classicDimensions.spatialEligible, true);
            assert.equal(frame.frameTime, null); assert.deepEqual(frame.timingWarnings, []);
            assert.equal(Object.hasOwn(frame, 'suv'), false);
            const rgba = renderScalarToRgba({ ...frame, window: { center: 5.5, width: 11 } });
            assert.equal(rgba[0], 0); assert.equal(rgba[8], 128); assert.equal(rgba[12], 255);
        });
        assert.deepEqual(new Uint8Array(await file.arrayBuffer()), original);
    });
}

test('classic PET uses Units (0054,1001) even when the optional Rescale Type is absent, and preserves declared GML without computing SUV', async () => {
    for (const unit of ['BQML', 'CNTS', 'CPS', 'GML']) await inspect([petFile(1, { extraAttributes: { '00541001': ['CS', unit] } })], async ([source]) => {
        const frame = await source.getFrame(0); assert.equal(frame.unit, unit);
        assert.deepEqual([...frame.samples], [-2, 0, 2, 4]);
        assert.deepEqual(frame.range, { min: -5, max: 10 });
        assert.equal(Object.hasOwn(frame, 'suv'), false);
    });
});

test('a PET spatial volume retains original samples separately from already rescaled physical values', async () => {
    await inspect([petFile(2), petFile(1)], async ([source]) => {
        assert.deepEqual(source.frames.map(frame => frame.position[2]), [0, 2]);
        const volume = await Volume.fromSeries(source);
        try {
            assert.equal(volume.geometry.unit, 'BQML');
            assert.deepEqual([...volume.storedSamples], [-2, 0, 2, 4, -2, 0, 2, 4]);
            assert.deepEqual([...volume.modalityValues], [-5, 0, 5, 10, -5, 0, 5, 10]);
        } finally { volume.dispose(); }
    });
});

test('PET dynamic time slices, whole-body acquisition times and correction families partition before spatial sorting or linking', async () => {
    const files = [];
    for (const time of [1, 2]) for (const plane of [1, 0]) {
        const index = (time - 1) * 2 + plane + 1;
        files.push(petFile(index, { extraAttributes: { '00541000': ['CS', ['DYNAMIC', 'IMAGE']],
            '00540101': ['US', 2], '00541300': ['DS', time * 1000] } }));
    }
    await inspect(files, async sources => {
        assert.equal(sources.length, 2); assert.ok(sources.every(source => source.frames.length === 2));
        assert.deepEqual(sources.map(source => source.frames[0].classicDimensions.petTimeSliceIndex).sort(), [1, 2]);
        assert.equal(nearestSyncedSlice(sources[0].frames[0], sources[1].frames).matched, false);
        assert.equal(compatibleWindow(sources[0].frames[0], sources[1].frames[0]), false);
        assert.throws(() => validateVolumeGeometry([sources[0].frames[0], sources[1].frames[1]]), /nonspatial family differs/);
    });
    for (const extraAttributes of [
        { '00541000': ['CS', ['WHOLE BODY', 'IMAGE']], '00541300': ['DS', 2000] },
        { '00280051': ['CS', ['NORM', 'DECY']] }, { '00541102': ['CS', 'ADMIN'] }, { '00541002': ['CS', 'TRANSMISSION'] },
        { '00541001': ['CS', 'CNTS'] }
    ]) await inspect([petFile(1), petFile(2, { extraAttributes })], async sources => assert.equal(sources.length, 2));
});

test('PET gated image-index dimensions isolate R-R intervals and time slots without using slice ordinals as temporal metadata', async () => {
    const files = Array.from({ length: 8 }, (_, ordinal) => {
        const index = ordinal + 1, slot = Math.floor(ordinal / 2) % 2 + 1, interval = Math.floor(ordinal / 4) + 1;
        return petFile(index, { extraAttributes: { '00541000': ['CS', ['GATED', 'IMAGE']],
            '00540061': ['US', 2], '00540071': ['US', 2], '00181060': ['DS', slot * 50],
            '00181063': ['DS', 50], '00181080': ['CS', 'Y'], '00181081': ['IS', interval * 500], '00181082': ['IS', interval * 500 + 100] } });
    });
    await inspect(files, async sources => {
        assert.equal(sources.length, 4); assert.ok(sources.every(source => source.frames.length === 2));
        assert.deepEqual(sources.map(source => [source.frames[0].classicDimensions.petRrIntervalIndex,
            source.frames[0].classicDimensions.petTimeSlotIndex]).sort(), [[1, 1], [1, 2], [2, 1], [2, 2]]);
        for (const source of sources) assert.doesNotThrow(() => validateVolumeGeometry(source.frames));
        assert.equal(nearestSyncedSlice(sources[0].frames[0], sources[1].frames).matched, false);
    });
});

for (const [label, extraAttributes] of [
    ['missing series type', { '00541000': null }], ['missing reference time', { '00541300': null }],
    ['invalid reference time', { '00541300': ['DS', -1] }], ['unsafe reference time', { '00541300': ['DS', 1e20] }],
    ['missing image index', { '00541330': null }], ['image index outside dimensions', { '00541330': ['US', 3] }],
    ['incomplete dynamic dimensions', { '00541000': ['CS', ['DYNAMIC', 'IMAGE']] }],
    ['incomplete gated dimensions', { '00541000': ['CS', ['GATED', 'IMAGE']] }],
    ['unknown counts source', { '00541002': ['CS', 'UNKNOWN'] }], ['unknown decay correction', { '00541102': ['CS', 'UNKNOWN'] }],
    ['wrong number-of-slices VR', { '00540081': ['DS', 2] }], ['multiple native image indices', { '00541330': ['US', Uint8Array.of(1, 0, 255, 255)] }],
    ['multiple native slice counts', { '00540081': ['US', Uint8Array.of(2, 0, 255, 255)] }],
    ['unknown correction', { '00280051': ['CS', 'BOGUS'] }], ['unknown SUV type', { '00541006': ['CS', 'BOGUS'] }]
]) test(`PET ${label} permits source-faithful 2D pixels but disables spatial grouping and linking`, async () => {
    await inspect([petFile(1, { extraAttributes }), petFile(2, { extraAttributes })], async sources => {
        assert.equal(sources.length, 2);
        const frame = await sources[0].getFrame(0);
        assert.deepEqual([...frame.samples], [-2, 0, 2, 4]); assert.equal(frame.unit, 'BQML');
        assert.equal(frame.classicDimensions.invalid, true); assert.equal(frame.classicDimensions.spatialEligible, false);
        assert.equal(nearestSyncedSlice(frame, sources[1].frames).matched, false);
        assert.throws(() => frameGeometry(frame), /scope is unknown or ineligible/);
    });
});

test('PET reprojection images never become a tomographic volume or spatially linked stack', async () => {
    await inspect([petFile(1, { extraAttributes: { '00541000': ['CS', ['STATIC', 'REPROJECTION']] } })], async ([source]) => {
        const frame = await source.getFrame(0); assert.deepEqual([...frame.samples], [-2, 0, 2, 4]);
        assert.equal(frame.classicDimensions.spatialEligible, false); assert.equal(frame.classicDimensions.invalid, false);
        assert.throws(() => frameGeometry(frame), /scope is unknown or ineligible/);
    });
});

test('spatial APIs reject partial, mutated or conflicting PET scope values and clone accepted arrays', async () => {
    await inspect([petFile(1)], async ([source]) => {
        const frame = await source.getFrame(0), original = structuredClone(frame.classicDimensions);
        const values = validatedPetDimensionValues(original);
        original.petSeriesType[0] = 'GATED';
        assert.deepEqual(values[0], ['STATIC', 'IMAGE']);
        for (const dimensions of [
            { ...frame.classicDimensions, petUnits: 'GML' }, { ...frame.classicDimensions, petFrameReferenceTime: Infinity },
            { ...frame.classicDimensions, petTriggerTime: -1 }, { ...frame.classicDimensions, petCorrectedImage: ['x'.repeat(65)] },
            { ...frame.classicDimensions, petSeriesType: ['DYNAMIC', 'IMAGE'] },
            Object.fromEntries(Object.entries(frame.classicDimensions).filter(([key]) => key !== PET_DIMENSION_FIELDS[0]))
        ]) {
            assert.throws(() => frameGeometry({ ...frame, classicDimensions: dimensions }), /PET/);
            assert.equal(nearestSyncedSlice({ ...frame, classicDimensions: dimensions }, [frame]).matched, false);
        }
        for (const extra of [{ petUnknownTemporalPhase: 2 }, { unknownDimension: 2 }]) {
            const altered = { ...frame, classicDimensions: { ...frame.classicDimensions, ...extra } };
            assert.throws(() => frameGeometry(altered), /scope/);
            assert.equal(nearestSyncedSlice(frame, [altered]).matched, false);
            assert.equal(compatibleWindow(frame, altered), false);
        }
    });
});

for (const [label, options, pattern] of [
    ['missing units', { extraAttributes: { '00541001': null } }, /explicit supported Units/],
    ['conflicting units', { extraAttributes: { '00281054': ['LO', 'HU'] } }, /rescale units conflict/],
    ['missing rescale', { extraAttributes: { '00281053': null, '00281052': null } }, /positive Rescale Slope/],
    ['multiple slopes', { extraAttributes: { '00281053': ['DS', [1, 2]] } }, /positive Rescale Slope/],
    ['wrong slope VR', { extraAttributes: { '00281053': ['IS', 2] } }, /positive Rescale Slope/],
    ['wrong pixel metadata VR', { extraAttributes: { '00280101': ['DS', 16] } }, /pixel metadata/],
    ['multiple native bit-depth values', { extraAttributes: { '00280101': ['US', Uint8Array.of(16, 0, 8, 0)] } }, /scalar US image pixel metadata/],
    ['nonzero intercept', { intercept: 2 }, /zero Rescale Intercept/],
    ['negative slope', { slope: -1 }, /positive Rescale Slope/],
    ['non-PET modality', { modality: 'MR' }, /modality PT/], ['12-bit samples', { bitsStored: 12 }, /16-bit stored samples/],
    ['multiframe object', { frames: 2, values: [0, 1, 2, 3, 4, 5, 6, 7] }, /single-frame/]
]) test(`unsupported or ambiguous PET calibration rejects explicitly: ${label}`, async () => {
    await assert.rejects(loadFiles([petFile(1, options)]), pattern);
});
