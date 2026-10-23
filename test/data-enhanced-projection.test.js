import test from 'node:test';
import assert from 'node:assert/strict';
import EASI, { Tag } from '@xinonix/easi-js';
import { createDicomFixture } from '../src/data/synthetic.js';
import { loadFiles, normalizeInstance, recordFrameGroups } from '../src/data/sources.js';
import { resolveEnhancedFrames, partitionEnhancedFrames } from '../src/data/enhanced.js';
import { loadArchiveSeries } from '../src/data/archive-source.js';
import { nearestSyncedSlice } from '../src/runtime/workspace.js';
import { validateVolumeGeometry } from '../src/volume/index.js';
import { measureGeometry } from '../src/annotations/geometry.js';
import { nativePlaybackAvailable } from '../src/data/frame-timing.js';
import { enhancedAttributes, binaryAttributes, createEnhancedArchive, createEnhancedDicom, pixels, locations, studyUid, seriesUid, sopUid } from './enhanced-fixtures.js';

const ctClass = '1.2.840.10008.5.1.4.1.1.2.1';
const nativeSyntaxes = ['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2'];
const sq = item => ['SQ', [item]];
const position = index => [10, 20, [6, 0, 14, 2, 12, 4, 10, 8][index]];
const orientation = index => [1, 0, 0, 0, Math.cos(index * Math.PI / 12), Math.sin(index * Math.PI / 12)];

function attributes({ parallel = false } = {}) {
    const object = enhancedAttributes();
    object['00080016'] = ['UI', ctClass]; object['00080060'] = ['CS', 'CT'];
    object['00209221'] = ['SQ', []]; object['00209222'] = ['SQ', []];
    object['52009229'][1][0]['00189329'] = sq({
        '00089007': ['CS', ['DERIVED', 'PRIMARY', 'SYNTHETIC', 'MAXIMUM']],
        '00089206': ['CS', 'SAMPLED'], '00089207': ['CS', 'MAX_IP']
    });
    delete object['52009229'][1][0]['00209116'];
    object['52009230'][1].forEach((frame, index) => {
        delete frame['00189114'];
        frame['00209111'] = sq({ '00209156': ['US', 3] });
        frame['00209113'] = sq({ '00200032': ['DS', position(index)] });
        frame['00209116'] = sq({ '00200037': ['DS', parallel ? orientation(0) : orientation(index)] });
        frame['00289132'] = sq({ '00281050': ['DS', 20 + index], '00281051': ['DS', 200 + index] });
        frame['00289145'][1][0]['00281054'] = ['LO', 'US'];
    });
    return object;
}

function native(object = attributes(), transferSyntax = nativeSyntaxes[1]) {
    const encoded = binaryAttributes(object, transferSyntax);
    for (const [id, tuple] of Object.entries(encoded)) if (tuple?.[0] === 'AT' && typeof tuple[1] === 'string') {
        const body = new Uint8Array(4), view = new DataView(body.buffer), little = transferSyntax !== nativeSyntaxes[2];
        view.setUint16(0, parseInt(tuple[1].slice(0, 4), 16), little);
        view.setUint16(2, parseInt(tuple[1].slice(4), 16), little); encoded[id] = ['AT', body];
    }
    return createDicomFixture({ sopClass: ctClass, sopUid, seriesUid, modality: 'CT', rows: 2, columns: 2,
        signed: true, bitsStored: 12, frames: locations.length, values: pixels.flat(), transferSyntax,
        extraAttributes: { '00181063': null, '00280009': null, ...encoded } });
}
const file = bytes => new File([bytes], 'generated-sampled-ct-projections.dcm', { type: 'application/dicom' });
async function parsed(object, syntax) {
    return (await EASI.pipelineBuilder().fromByteStream().ofDicomData().toInstances().build().process({ source: native(object, syntax) })).first();
}
function assertDescriptor(frame, index) {
    assert.equal(frame.frameIndex, index);
    assert.deepEqual(frame.position, position(index));
    assert.deepEqual(frame.orientation, orientation(index));
    assert.deepEqual(frame.pixelSpacing, [0.5, 0.75]);
    assert.equal(frame.slope, index + 1); assert.equal(frame.intercept, -100 * (index + 1));
    assert.deepEqual(frame.window, { center: 20 + index, width: 200 + index });
    assert.equal(frame.unit, '', 'US rescale type must not be relabeled HU');
    assert.equal(frame.dimensions.semanticScope, 'encoded-2d-projection');
    assert.equal(frame.dimensions.spatialEligible, false);
    assert.deepEqual(frame.dimensions.indices, []); assert.deepEqual(frame.dimensions.dimensionIndexValues, []);
    assert.equal(frame.dimensions.stackId, null); assert.equal(frame.dimensions.inStackPositionNumber, null);
    assert.equal(frame.dimensions.temporalPositionIndex, null); assert.equal(frame.dimensions.effectiveEchoTime, null);
    assert.equal(frame.dimensions.frameAcquisitionNumber, 3);
    assert.match(frame.geometryWarnings.join(' '), /Limited 2D.*empty.*original encoded order.*linking and reconstruction are unavailable/);
}

for (const syntax of nativeSyntaxes) {
    test(`sampled CT projections with paired empty dimensions retain original frames, pixels, planes and calibration (${syntax})`, async () => {
        let instance;
        const sources = await loadFiles([file(native(attributes(), syntax))], { onInstance: value => { instance = value; } });
        try {
            assert.equal(sources.length, 1, 'rotating projections must remain one navigable sequence');
            assert.equal(sources[0].frames.length, locations.length);
            assert.deepEqual(sources[0].frames.map(frame => frame.frameIndex), Array.from({ length: locations.length }, (_, i) => i));
            for (let index = 0; index < locations.length; index++) {
                assertDescriptor(sources[0].frames[index], index);
                const decoded = await sources[0].getFrame(index);
                assertDescriptor(decoded, index);
                assert.deepEqual([...decoded.samples], pixels[index], 'source-frame stored sample identity must survive grouping');
                assert.deepEqual(decoded.range, { min: pixels[index][0] * (index + 1) - 100 * (index + 1), max: pixels[index][3] * (index + 1) - 100 * (index + 1) });
                assert.equal(decoded.timingMode, 'none'); assert.equal(decoded.frameTime, null); assert.equal(decoded.acquisitionOffsetMs, null);
            }
            assert.equal(nativePlaybackAvailable(sources[0].frames), false, 'projection order does not imply a recorded playback clock');
            const record = [...sources[0]._records.values()][0];
            assert.deepEqual(recordFrameGroups(record)[0].frames.map(frame => frame.frameIndex), Array.from({ length: locations.length }, (_, i) => i));
            assert.ok(partitionEnhancedFrames(record.enhancedFrames).every(group => group.spatialEligible === false));
            assert.equal(instance.dataSet.find(Tag.find('00209221')).items.length, 0);
            assert.equal(instance.dataSet.find(Tag.find('00209222')).items.length, 0);
            const measure = measureGeometry('length', [{ x: 0.5, y: 0.5 }, { x: 1.5, y: 0.5 }], sources[0].frames[0]);
            assert.equal(measure.value, 0.75); assert.equal(measure.unit, 'mm');
        } finally { sources.forEach(series => series.dispose()); }
        assert.equal(sources[0]._session.measureDetails().encodedCacheBytes, 0);
        assert.equal(sources[0]._session.cache.bytes, 0);
    });
}

test('projection compatibility preserves existing geometry warnings and leaves ordinary enhanced warnings intact', async () => {
    for (const limited of [false, true]) {
        const object = limited ? attributes() : enhancedAttributes();
        object['00280034'] = ['IS', [0, 1]];
        const sources = await loadFiles([file(limited ? native(object) : createEnhancedDicom(object))]);
        try {
            for (const frame of sources.flatMap(series => series.frames)) {
                assert.ok(frame.geometryWarnings.some(warning => /Pixel Aspect Ratio/.test(warning)));
                assert.equal(frame.geometryWarnings.some(warning => /Limited 2D/.test(warning)), limited);
            }
        } finally { sources.forEach(series => series.dispose()); }
    }
});

test('paired-empty projection dimensions never enable linking or reconstruction, including parallel source planes', async () => {
    const sources = await loadFiles([file(native(attributes({ parallel: true })))]);
    try {
        assert.equal(sources.length, 1);
        assert.deepEqual(sources[0].frames.map(frame => frame.frameIndex), Array.from({ length: locations.length }, (_, i) => i));
        const frame = sources[0].frames[0];
        assert.equal(nearestSyncedSlice(frame, [frame], 1).matched, false);
        assert.throws(() => validateVolumeGeometry(sources[0].frames), /dimension scope.*ineligible/);
    } finally { sources.forEach(series => series.dispose()); }
});

test('a declared frame vector retains exact intervals in encoded projection order without treating acquisition number as time', async () => {
    const object = attributes();
    object['00280009'] = ['AT', '00181065'];
    object['00181065'] = ['DS', [0, 11, 22, 33, 44, 55, 66, 77]];
    const sources = await loadFiles([file(native(object))]);
    try {
        assert.deepEqual(sources[0].frames.map(frame => frame.frameIndex), [0, 1, 2, 3, 4, 5, 6, 7]);
        assert.deepEqual(sources[0].frames.map(frame => frame.acquisitionOffsetMs), [0, 11, 33, 66, 110, 165, 231, 308]);
        assert.deepEqual(sources[0].frames.map(frame => frame.nextIntervalMs), [11, 22, 33, 44, 55, 66, 77, null]);
        assert.equal(nativePlaybackAvailable(sources[0].frames), true);
    } finally { sources.forEach(series => series.dispose()); }
});

test('DICOM JSON indexing and native retrieval preserve the same limited projection scope and source pixels', async () => {
    const object = attributes(), client = await createEnhancedArchive({ object, bytes: native(object) });
    const sources = await loadArchiveSeries(client, studyUid, seriesUid);
    try {
        assert.equal(sources.length, 1);
        assert.deepEqual(sources[0].frames.map(frame => frame.frameIndex), [0, 1, 2, 3, 4, 5, 6, 7]);
        assert.equal(client.calls.length, 0, 'metadata indexing must not retrieve pixels');
        for (let index = 0; index < locations.length; index++) {
            assertDescriptor(sources[0].frames[index], index);
            const frame = await sources[0].getFrame(index);
            assert.deepEqual([...frame.samples], pixels[index]); assertDescriptor(frame, index);
        }
        assert.equal(client.calls.length, 1);
    } finally { sources.forEach(series => series.dispose()); }
});

test('archive retrieval rejects a native dimension organization differing from the limited indexed metadata before retaining pixels', async () => {
    const object = attributes(), actual = attributes();
    actual['00209221'] = sq({ '00209164': ['UI', '2.25.919'] });
    actual['00209222'] = sq({ '00209164': ['UI', '2.25.919'], '00209165': ['AT', '00209156'], '00209167': ['AT', '00209111'] });
    for (const frame of actual['52009230'][1]) frame['00209111'][1][0]['00209157'] = ['UL', 1];
    const client = await createEnhancedArchive({ object, bytes: native(actual) });
    const sources = await loadArchiveSeries(client, studyUid, seriesUid);
    try {
        await assert.rejects(sources[0].getFrame(0), /frame dimensions.*archive metadata/);
        assert.equal(sources[0]._session.measureDetails().encodedCacheBytes, 0);
        assert.equal(sources[0]._session.cache.bytes, 0);
    } finally { sources.forEach(series => series.dispose()); }
});

for (const [label, change] of [
    ['MR object', object => { object['00080016'][1] = '1.2.840.10008.5.1.4.1.1.4.1'; object['00080060'][1] = 'MR'; }],
    ['legacy converted CT object', object => { object['00080016'][1] = '1.2.840.10008.5.1.4.1.1.2.2'; }],
    ['wrong modality', object => { object['00080060'][1] = 'MR'; }],
    ['non-projection frame type', object => { object['52009229'][1][0]['00189329'][1][0]['00089007'][1][0] = 'ORIGINAL'; }],
    ['ordinary volume declaration', object => { object['52009229'][1][0]['00189329'][1][0]['00089206'][1] = 'VOLUME'; }],
    ['different projection technique', object => { object['52009229'][1][0]['00189329'][1][0]['00089207'][1] = 'AVERAGE'; }],
    ['dimension organization type claim', object => { object['00209311'] = ['CS', '3D']; }],
    ['concatenation claim', object => { object['00209161'] = ['UI', '2.25.919']; object['00209228'] = ['UL', 8]; }],
    ['nonempty organization with empty indices', object => { object['00209221'] = sq({ '00209164': ['UI', '2.25.919'] }); }],
    ['nonempty indices with empty organization', object => { object['00209222'] = sq({ '00209164': ['UI', '2.25.919'], '00209165': ['AT', '00209057'], '00209167': ['AT', '00209111'] }); }],
    ['missing organization', object => { delete object['00209221']; }],
    ['missing index sequence', object => { delete object['00209222']; }],
    ['unexplained frame dimension ordinal', object => { object['52009230'][1][0]['00209111'][1][0]['00209157'] = ['UL', 1]; }],
    ['missing per-frame position', object => { delete object['52009230'][1][0]['00209113']; }],
    ['nonorthogonal frame orientation', object => { object['52009230'][1][0]['00209116'][1][0]['00200037'][1] = [1, 0, 0, 1, 0, 0]; }],
    ['zero pixel spacing', object => { object['52009229'][1][0]['00289110'][1][0]['00280030'][1][0] = 0; }],
    ['missing per-frame content', object => { delete object['52009230'][1][0]['00209111']; }],
    ['duplicate shared/per-frame orientation', object => { object['52009229'][1][0]['00209116'] = sq({ '00200037': ['DS', [1, 0, 0, 0, 1, 0]] }); }],
    ['missing rescale calibration', object => { delete object['52009230'][1][0]['00289145']; }],
    ['missing rescale intercept', object => { delete object['52009230'][1][0]['00289145'][1][0]['00281052']; }],
    ['zero rescale slope', object => { object['52009230'][1][0]['00289145'][1][0]['00281053'][1] = 0; }],
    ['missing window', object => { delete object['52009230'][1][0]['00289132']; }],
    ['invalid window', object => { object['52009230'][1][0]['00289132'][1][0]['00281051'][1] = 0; }],
    ['malformed frame timing vector', object => { object['00280009'] = ['AT', '00181065']; object['00181065'] = ['DS', [0, 11]]; }]
]) {
    test(`paired-empty CT compatibility retains strict rejection: ${label}`, async () => {
        await assert.rejects(loadFiles([file(native(changeObject()))]), /enhanced|functional-group|frame|presentation|timing|dimension/i);
        function changeObject() { const object = attributes(); change(object); return object; }
    });
}

test('paired-empty compatibility requires declared sequence VR, exact geometry/calibration VR and native syntax', async () => {
    for (const id of ['00209221', '00209222', '52009229', '52009230']) {
        const instance = await parsed(attributes());
        instance.dataSet.find(Tag.find(id)).vr = { ID: 'UN' };
        assert.throws(() => normalizeInstance(instance), /enhanced|functional-group|dimension/i);
    }
    const instance = await parsed(attributes());
    const record = normalizeInstance(await parsed(attributes()));
    assert.throws(() => resolveEnhancedFrames(instance, { ...record.common, transferSyntax: '1.2.840.10008.1.2.4.90' }), /functional-group/);
    const spacing = instance.dataSet.find(Tag.find('52009229')).items[0].find(Tag.find('00289110')).items[0].find(Tag.find('00280030'));
    spacing.vr = { ID: 'IS' };
    assert.throws(() => normalizeInstance(instance), /functional-group|presentation|numeric/);
});
