import test from 'node:test';
import assert from 'node:assert/strict';
import EASI from '@xinonix/easi-js';
import { loadFiles } from '../src/data/sources.js';
import { loadArchiveSeries } from '../src/data/archive-source.js';
import { createDicomFixture } from '../src/data/synthetic.js';
import { CLASSIC_PET_SOP_CLASS, classicDimensionKey, classicNavigationKey } from '../src/data/classic-dimensions.js';
import { nearestSyncedSlice, compatibleWindow } from '../src/runtime/workspace.js';
import { validateVolumeGeometry } from '../src/volume/geometry.js';
import { Volume } from '../src/volume/Volume.js';

const STUDY = '2.25.909.1', SERIES = '2.25.909.2', REFERENCE = '2.25.909.3';
const row = (stack, index, tag) => stack.getAttributes(index).rows.find(item => item.tag === tag);
function fixture(index, type = 'WHOLE BODY', overrides = {}) {
    const extraAttributes = {
        '00080008': ['CS', ['ORIGINAL', 'PRIMARY']], '0020000D': ['UI', STUDY], '00200052': ['UI', REFERENCE],
        '00541000': ['CS', [type, 'IMAGE']], '00541001': ['CS', 'BQML'], '00541002': ['CS', 'EMISSION'],
        '00541102': ['CS', 'START'], '00280051': ['CS', ['ATTN', 'DECY']],
        '00540081': ['US', 3], '00541300': ['DS', 1000 + index * 25], '00541330': ['US', index + 1], ...overrides
    };
    const values = [index * 10, index * 10 + 1, index * 10 + 2, index * 10 + 3];
    const bytes = createDicomFixture({ rows: 2, columns: 2, signed: true, modality: 'PT', sopClass: CLASSIC_PET_SOP_CLASS,
        sopUid: `${SERIES}.${index + 1}`, seriesUid: SERIES, instanceNumber: index + 1,
        position: [0, 0, index * 2], orientation: [1, 0, 0, 0, 1, 0], pixelSpacing: [0.75, 0.75],
        values, slope: 2.5, intercept: 0, extraAttributes });
    return { bytes, values, extraAttributes, file: new File([bytes], 'synthetic-pet.dcm', { type: 'application/dicom' }) };
}
async function withLocal(files, action) {
    const stacks = await loadFiles(files);
    try { await action(stacks); } finally { stacks.forEach(stack => stack.dispose()); }
}
function jsonMetadata(item, index) {
    const entry = (vr, ...Value) => ({ vr, Value });
    const result = {
        '00080016': entry('UI', CLASSIC_PET_SOP_CLASS), '00080018': entry('UI', `${SERIES}.${index + 1}`),
        '00080060': entry('CS', 'PT'), '0020000E': entry('UI', SERIES), '00200013': entry('IS', index + 1),
        '00200032': entry('DS', 0, 0, index * 2), '00200037': entry('DS', 1, 0, 0, 0, 1, 0),
        '00280002': entry('US', 1), '00280004': entry('CS', 'MONOCHROME2'), '00280008': entry('IS', 1),
        '00280010': entry('US', 2), '00280011': entry('US', 2), '00280030': entry('DS', 0.75, 0.75),
        '00280100': entry('US', 16), '00280101': entry('US', 16), '00280102': entry('US', 15), '00280103': entry('US', 1),
        '00281052': entry('DS', 0), '00281053': entry('DS', 2.5),
        '7FE00010': { vr: 'OW', BulkDataURI: 'https://synthetic.invalid/not-fetched' }
    };
    for (const [tag, attribute] of Object.entries(item.extraAttributes)) {
        if (!attribute) delete result[tag];
        else result[tag] = entry(attribute[0], ...(Array.isArray(attribute[1]) ? attribute[1] : [attribute[1]]));
    }
    return result;
}
async function archiveFor(items) {
    const objects = items.map(jsonMetadata);
    const instances = (await EASI.pipelineBuilder().fromByteStream().ofDicomMetadata().toInstances().build()
        .process({ source: new TextEncoder().encode(JSON.stringify(objects)) })).toArray();
    const retrieves = [];
    return { retrieves, async getSeriesMetadata() { return [...instances].reverse(); },
        async retrieveInstance(_study, _series, uid) {
            retrieves.push(uid);
            const index = items.findIndex((_item, ordinal) => uid === `${SERIES}.${ordinal + 1}`);
            assert.notEqual(index, -1);
            return new Response(items[index].bytes, { headers: { 'content-type': 'application/dicom' } });
        } };
}

for (const type of ['STATIC', 'WHOLE BODY']) {
    test(`${type} PET reference times permit one sorted 2D navigation stack without changing acquisition metadata`, async () => {
        const items = [fixture(0, type), fixture(1, type), fixture(2, type)];
        const originals = await Promise.all(items.map(item => item.file.arrayBuffer()));
        await withLocal(items.map(item => item.file).reverse(), async stacks => {
            assert.equal(stacks.length, 1);
            const [stack] = stacks;
            assert.equal(stack.frames.length, 3);
            assert.deepEqual(stack.frames.map(frame => frame.position[2]), [0, 2, 4]);
            assert.deepEqual(stack.frames.map(frame => frame.classicDimensions.petFrameReferenceTime), [1000, 1025, 1050]);
            assert.deepEqual(stack.frames.map(frame => frame.syncDimensions.petFrameReferenceTime), [1000, 1025, 1050]);
            for (const index of [0, 2]) {
                const decoded = await stack.getFrame(index);
                assert.deepEqual([...decoded.samples], items[index].values);
                assert.equal(decoded.classicDimensions.petFrameReferenceTime, 1000 + index * 25);
                assert.equal(row(stack, index, '(0054,1300)').value, String(1000 + index * 25));
                assert.equal(row(stack, index, '(0054,1330)').value, String(index + 1));
            }
            const first = stack.frames[0], last = stack.frames[2];
            assert.notEqual(classicDimensionKey(first.classicDimensions), classicDimensionKey(last.classicDimensions));
            assert.equal(classicNavigationKey(first.classicDimensions), classicNavigationKey(last.classicDimensions));
            assert.equal(nearestSyncedSlice(first, [last]).matched, false);
            assert.equal(compatibleWindow(first, last), false);
            assert.throws(() => validateVolumeGeometry(stack.frames), /nonspatial family differs/);
            await assert.rejects(Volume.fromSeries(stack), /nonspatial family differs/);
        });
        for (const [index, item] of items.entries()) assert.deepEqual(await item.file.arrayBuffer(), originals[index]);
    });

    test(`${type} PET DICOMweb metadata and retrieved frames use the same navigation grouping without eager retrieval`, async () => {
        const items = [fixture(0, type), fixture(1, type), fixture(2, type)];
        const archive = await archiveFor(items), stacks = await loadArchiveSeries(archive, STUDY, SERIES);
        try {
            assert.equal(stacks.length, 1); assert.equal(stacks[0].frames.length, 3);
            assert.deepEqual(archive.retrieves, []);
            assert.deepEqual(stacks[0].frames.map(frame => frame.classicDimensions.petFrameReferenceTime), [1000, 1025, 1050]);
            for (const index of [0, 2]) {
                const frame = await stacks[0].getFrame(index);
                assert.deepEqual([...frame.samples], items[index].values);
                assert.equal(frame.classicDimensions.petFrameReferenceTime, 1000 + index * 25);
                assert.equal(row(stacks[0], index, '(0054,1300)').value, String(1000 + index * 25));
            }
            assert.equal(archive.retrieves.length, 2);
            assert.equal(compatibleWindow(stacks[0].frames[0], stacks[0].frames[2]), false);
            assert.throws(() => validateVolumeGeometry(stacks[0].frames), /nonspatial family differs/);
        } finally { stacks.forEach(stack => stack.dispose()); }
    });
}

for (const [label, changes] of [
    ['acquisition number', { '00200012': ['IS', 2] }],
    ['temporal position', { '00200100': ['IS', 2] }],
    ['echo', { '00180081': ['DS', 30], '00180086': ['IS', 2] }],
    ['image type', { '00080008': ['CS', ['DERIVED', 'PRIMARY']] }],
    ['corrections', { '00280051': ['CS', ['NORM', 'DECY']] }],
    ['decay correction', { '00541102': ['CS', 'ADMIN'] }],
    ['counts source', { '00541002': ['CS', 'TRANSMISSION'] }],
    ['units', { '00541001': ['CS', 'CNTS'] }]
]) test(`PET 2D navigation keeps different ${label} in distinct stacks despite varying reference times`, async () => {
    await withLocal([fixture(0).file, fixture(1, 'WHOLE BODY', changes).file], async stacks => assert.equal(stacks.length, 2));
});

for (const [type, additions] of [
    ['DYNAMIC', { '00540101': ['US', 2] }],
    ['GATED', { '00540061': ['US', 1], '00540071': ['US', 1], '00181060': ['DS', 50], '00181063': ['DS', 50] }]
]) test(`${type} PET reference-time differences still partition navigation even within the same temporal index`, async () => {
    await withLocal([fixture(0, type, additions).file, fixture(1, type, additions).file], async stacks => {
        assert.equal(stacks.length, 2);
        assert.ok(stacks.every(stack => stack.frames[0].classicDimensions.invalid === false));
        const scopes = stacks.map(stack => stack.frames[0].classicDimensions);
        assert.equal(scopes[0].petTimeSliceIndex, scopes[1].petTimeSliceIndex);
        assert.equal(scopes[0].petTimeSlotIndex, scopes[1].petTimeSlotIndex);
        assert.notEqual(classicNavigationKey(scopes[0]), classicNavigationKey(scopes[1]));
    });
});

test('navigation keys preserve immutable original dimensions and retain exact ineligible-instance isolation', async () => {
    await withLocal([fixture(0).file], async ([stack]) => {
        const dimensions = structuredClone(stack.frames[0].classicDimensions), before = structuredClone(dimensions);
        for (const value of Object.values(dimensions)) if (Array.isArray(value)) Object.freeze(value);
        Object.freeze(dimensions);
        assert.doesNotThrow(() => classicNavigationKey(dimensions));
        assert.deepEqual(dimensions, before);
        for (const ineligible of [null, { ...dimensions, invalid: true }, { ...dimensions, spatialEligible: false },
            { ...dimensions, spatialEligible: false, petSeriesType: ['STATIC', 'REPROJECTION'] }]) {
            assert.equal(classicNavigationKey(ineligible, '2.25.1'), classicDimensionKey(ineligible, '2.25.1'));
            assert.notEqual(classicNavigationKey(ineligible, '2.25.1'), classicNavigationKey(ineligible, '2.25.2'));
        }
        assert.throws(() => classicNavigationKey({ ...dimensions, petFrameReferenceTime: Infinity }), /Invalid classic/);
        assert.throws(() => classicNavigationKey({ ...dimensions, petUnknownDimension: 1 }), /Invalid classic/);
        const partial = { ...dimensions }; delete partial.petFrameReferenceTime;
        assert.throws(() => classicNavigationKey(partial), /Invalid classic/);
    });
});
