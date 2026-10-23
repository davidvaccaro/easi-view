import test from 'node:test';
import assert from 'node:assert/strict';
import EASI from '@xinonix/easi-js';
import { resolveClassicDimensions, classicDimensionKey, validateClassicDimensions } from '../src/data/classic-dimensions.js';
import { loadFiles, normalizeInstance } from '../src/data/sources.js';
import { createDicomFixture } from '../src/data/synthetic.js';
import { nearestSyncedSlice } from '../src/runtime/workspace.js';

const FOR = '2.25.815', SERIES = '2.25.816';
const file = bytes => ({ size: bytes.length, stream: () => new Blob([bytes]).stream() });
function fixture(index, { syntax, time = 1, echo = 1, acquisition = 1, imageType = ['ORIGINAL', 'PRIMARY', 'M'], extra = {} } = {}) {
    return createDicomFixture({ rows: 2, columns: 2, signed: true, modality: 'MR', sopClass: '1.2.840.10008.5.1.4.1.1.4',
        sopUid: `${SERIES}.${index + 1}`, seriesUid: SERIES, transferSyntax: syntax,
        position: [0, 0, index % 2 * 2], instanceNumber: 20 - index, values: [index, -1, 2, 3],
        extraAttributes: { '00200052': ['UI', FOR], '00080008': ['CS', imageType], '00180088': ['DS', 2],
            '00180081': ['DS', echo * 20], '00180086': ['IS', echo], '00200100': ['IS', time], '00200012': ['IS', acquisition], ...extra } });
}
async function metadata(attributes) {
    return (await EASI.pipelineBuilder().fromPartStream().ofDicomMetadata().toInstances().build()
        .process(new Blob([JSON.stringify([attributes])]).stream(), { contentType: 'application/dicom+json' }))[0];
}
const json = (vr, ...Value) => ({ vr, Value });

for (const syntax of ['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']) test(`classic dimensions retain declared slice/echo/time/acquisition scope and original stored values (${syntax})`, async () => {
    const sources = await loadFiles([file(fixture(0, { syntax }))]);
    try {
        const scope = sources[0].frames[0].classicDimensions;
        assert.deepEqual(scope.echoNumbers, [1]); assert.equal(scope.effectiveEchoTime, 20);
        assert.equal(scope.temporalPositionIndex, 1); assert.equal(scope.acquisitionNumber, 1);
        assert.equal(scope.declaredSpacingBetweenSlices, 2); assert.deepEqual(scope.imageType, ['ORIGINAL', 'PRIMARY', 'M']);
        assert.equal(scope.complexImageComponent, 'MAGNITUDE'); assert.equal(scope.spatialEligible, true);
        assert.equal(scope.semanticScope, 'classic-exposed-dimensions');
        const decoded = await sources[0].getFrame(0); assert.deepEqual([...decoded.samples], [0, -1, 2, 3]);
        assert.deepEqual(decoded.classicDimensions, scope); assert.equal(decoded.declaredSpacingBetweenSlices, 2);
    } finally { sources.forEach(source => source.dispose()); }
});

test('classic MR partitions temporal and echo families before sorting spatial planes rather than mixing repeated positions', async () => {
    const files = [];
    for (const time of [1, 2]) for (const echo of [1, 2]) for (let plane = 1; plane >= 0; plane--) {
        const index = (time - 1) * 4 + (echo - 1) * 2 + plane; files.push(file(fixture(index, { time, echo })));
    }
    const sources = await loadFiles(files);
    try {
        assert.equal(sources.length, 4); assert.ok(sources.every(source => source.frames.length === 2));
        for (const source of sources) assert.deepEqual(source.frames.map(frame => frame.position[2]), [0, 2]);
        const family = sources.map(source => [source.frames[0].classicDimensions.temporalPositionIndex, source.frames[0].classicDimensions.echoNumbers[0]]).sort();
        assert.deepEqual(family, [[1, 1], [1, 2], [2, 1], [2, 2]]);
        assert.equal(nearestSyncedSlice(sources[0].frames[0], sources[1].frames).reason, 'temporal-or-echo-family-mismatch');
        assert.equal(sources.reduce((sum, source) => sum + source.sourceBytes, 0), 64);
    } finally { sources.forEach(source => source.dispose()); }
});

test('acquisition and complex/full image type differ independently while instance ordinals do not split spatial stacks', async () => {
    const sources = await loadFiles([file(fixture(0)), file(fixture(1)), file(fixture(2, { acquisition: 2 })),
        file(fixture(3, { imageType: ['ORIGINAL', 'PRIMARY', 'P'] })), file(fixture(4, { imageType: ['DERIVED', 'PRIMARY', 'M'] }))]);
    try {
        assert.equal(sources.length, 4); assert.equal(sources.find(source => source.frames.length === 2).frames.length, 2);
        assert.ok(sources.some(source => source.frames[0].classicDimensions.complexImageComponent === 'PHASE'));
        assert.ok(sources.some(source => source.frames[0].classicDimensions.acquisitionNumber === 2));
    } finally { sources.forEach(source => source.dispose()); }
});

test('different patient reference spaces never enter one compatible classic stack', async () => {
    const sources = await loadFiles([file(fixture(0)), file(fixture(1, { extra: { '00200052': ['UI', '2.25.817'] } }))]);
    assert.equal(sources.length, 2); sources.forEach(source => source.dispose());
});

for (const [label, extra] of [
    ['multiple echo times', { '00180081': ['DS', [20, 40]] }], ['zero echo', { '00180086': ['IS', 0] }],
    ['zero temporal index', { '00200100': ['IS', 0] }], ['negative acquisition', { '00200012': ['IS', -1] }],
    ['negative declared spacing', { '00180088': ['DS', -2] }], ['malformed optional numeric', { '00180081': ['DS', 'not-a-number'] }],
    ['malformed image type component', { '00080008': ['CS', ['ORIGINAL', '', 'M']] }]
]) test(`invalid ${label} keeps a truthful 2D preview but disables spatial grouping/linking`, async () => {
    const sources = await loadFiles([file(fixture(0, { extra })), file(fixture(1, { extra }))]);
    try {
        assert.equal(sources.length, 2);
        for (const source of sources) {
            const frame = await source.getFrame(0); assert.equal(frame.samples.length, 4);
            assert.equal(frame.classicDimensions.invalid, true); assert.equal(frame.classicDimensions.spatialEligible, false);
            assert.ok(frame.geometryWarnings.some(warning => /acquisition dimensions/.test(warning)));
            assert.equal(nearestSyncedSlice(frame, source.frames).matched, false);
        }
    } finally { sources.forEach(source => source.dispose()); }
});

test('absent dimension metadata stays same-series scoped, and numeric JSON arrays preserve supported optional values', async () => {
    const absent = resolveClassicDimensions((await metadata({})).dataSet);
    assert.equal(absent.semanticScope, 'same-series-only'); assert.equal(absent.temporalPositionIndex, null);
    const parsed = resolveClassicDimensions((await metadata({ '00200100': json('IS', 2), '00180081': json('DS', 45.25),
        '00180086': json('IS', 3), '00200012': json('IS', 0), '00180088': json('DS', 2.5),
        '00080008': json('CS', 'ORIGINAL', 'PRIMARY', 'M'), '00189087': json('FD', 1000), '00189089': json('FD', 1, 0, 0) })).dataSet, { modality: 'MR' });
    assert.equal(parsed.invalid, false); assert.equal(parsed.effectiveEchoTime, 45.25); assert.equal(parsed.acquisitionNumber, 0);
    assert.equal(parsed.diffusionBValue, 1000); assert.deepEqual(parsed.diffusionDirection, [1, 0, 0]);
    assert.notEqual(classicDimensionKey(parsed), classicDimensionKey({ ...parsed, temporalPositionIndex: 3 }));
});

for (const littleEndian of [true, false]) test(`binary FD diffusion scope decodes with explicit ${littleEndian ? 'little' : 'big'} endian order`, async () => {
    const fd = values => { const bytes = new Uint8Array(values.length * 8), view = new DataView(bytes.buffer); values.forEach((value, index) => view.setFloat64(index * 8, value, littleEndian)); return bytes; };
    const sources = await loadFiles([file(fixture(0, { syntax: littleEndian ? '1.2.840.10008.1.2.1' : '1.2.840.10008.1.2.2',
        extra: { '00189087': ['FD', fd([750])], '00189089': ['FD', fd([0, 1, 0])] } }))]);
    try {
        const dimensions = sources[0].frames[0].classicDimensions; assert.equal(dimensions.invalid, false);
        assert.equal(dimensions.diffusionBValue, 750); assert.deepEqual(dimensions.diffusionDirection, [0, 1, 0]);
    } finally { sources.forEach(source => source.dispose()); }
});

test('metadata-supplied echo/time/acquisition declarations must agree with the retrieved instance, while missing fields remain unknown', () => {
    const expected = { echoNumbers: [2], effectiveEchoTime: 40, temporalPositionIndex: 3, acquisitionNumber: 7, declaredSpacingBetweenSlices: 2 };
    assert.doesNotThrow(() => validateClassicDimensions(expected, expected));
    for (const [field, value] of Object.entries(expected)) {
        assert.throws(() => validateClassicDimensions({ ...expected, [field]: Array.isArray(value) ? [1] : value + 1 }, expected), /acquisition dimensions/);
    }
    assert.doesNotThrow(() => validateClassicDimensions(expected, { echoNumbers: [], effectiveEchoTime: null, imageType: [] }));
});

test('archive retrieval rejects an explicitly supplied acquisition family mismatch before retaining either pixel cache', async () => {
    const { loadArchiveSeries } = await import('../src/data/archive-source.js');
    const study = '2.25.819';
    const instance = await metadata({
        '00080016': json('UI', '1.2.840.10008.5.1.4.1.1.4'), '00080018': json('UI', `${SERIES}.1`), '00080060': json('CS', 'MR'),
        '0020000D': json('UI', study), '0020000E': json('UI', SERIES), '00200052': json('UI', FOR),
        '00200032': json('DS', 0, 0, 0), '00200037': json('DS', 1, 0, 0, 0, 1, 0),
        '00280002': json('US', 1), '00280004': json('CS', 'MONOCHROME2'), '00280008': json('IS', 1),
        '00280010': json('US', 2), '00280011': json('US', 2), '00280030': json('DS', 0.75, 0.75),
        '00280100': json('US', 16), '00280101': json('US', 16), '00280102': json('US', 15), '00280103': json('US', 1),
        '00080008': json('CS', 'ORIGINAL', 'PRIMARY', 'M'), '00180081': json('DS', 20), '00180086': json('IS', 1),
        '00200100': json('IS', 1), '00200012': json('IS', 1), '00180088': json('DS', 2),
        '7FE00010': { vr: 'OW', BulkDataURI: 'https://synthetic.invalid/never-fetched' }
    });
    for (const extra of [{ '00180081': ['DS', 30] }, { '00200012': ['IS', 2] }, { '00080008': ['CS', ['ORIGINAL', 'PRIMARY', 'P']] }]) {
        const raw = fixture(0, { extra: { '0020000D': ['UI', study], ...extra } }); let retrieves = 0;
        const sources = await loadArchiveSeries({ async getSeriesMetadata() { return [instance]; }, async retrieveInstance() { retrieves++; return new Response(raw, { headers: { 'content-type': 'application/dicom' } }); } }, study, SERIES);
        try {
            await assert.rejects(sources[0].getFrame(0), /acquisition dimensions/);
            assert.equal(retrieves, 1); assert.equal(sources[0].cacheBytes, 0); assert.equal(sources[0].sourceBytes, 0);
        } finally { sources.forEach(source => source.dispose()); }
    }
});
