import test from 'node:test';
import assert from 'node:assert/strict';
import EASI from '@xinonix/easi-js';
import { createAttributeSnapshot, limitAttributeSnapshot, MAX_ATTRIBUTE_BYTES, MAX_SESSION_ATTRIBUTE_BYTES } from '../src/data/attributes.js';
import { createDicomFixture } from '../src/data/synthetic.js';
import { loadFiles } from '../src/data/sources.js';
import { loadArchiveSeries } from '../src/data/archive-source.js';
import { DicomWebClient } from '../src/data/DicomWebClient.js';
import { independentNativeFixture, j, sq } from './derived-fixtures.js';
import { createEnhancedDicom, createEnhancedArchive, enhancedAttributes, dicomJson, studyUid, seriesUid } from './enhanced-fixtures.js';

const native = async bytes => (await EASI.pipelineBuilder().fromByteStream().ofDicomData({ includePart10Header: true }).toInstances().build().process({ source: bytes })).first();
const json = async object => (await EASI.pipelineBuilder().fromByteStream().ofDicomMetadata().toInstances().build().process({ source: new TextEncoder().encode(JSON.stringify(object)) })).first();
const file = bytes => new File([bytes], 'synthetic-attributes.dcm', { type: 'application/dicom' });
const row = (snapshot, tag) => snapshot.rows.find(value => value.tag === tag);
const countBytes = snapshot => new TextEncoder().encode(JSON.stringify(snapshot.rows)).byteLength;
const attribute = (id, vr, value, more = {}) => ({ tag: { ID: id, Name: `Synthetic ${id}`, VR: { ID: vr } }, _value: value, ...more });
const instance = attributes => ({ dataSet: { attributes } });
async function withMetadataClient(data, action) {
    const previous = globalThis.fetch, requests = [];
    globalThis.fetch = async url => {
        requests.push(String(url));
        return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/dicom+json' } });
    };
    try { return await action(new DicomWebClient({ baseUrl: 'https://synthetic.invalid/dicom-web' }), requests); }
    finally { globalThis.fetch = previous; }
}

test('real native EASI snapshots keep meta-header, ordinary PN/LO/ID and explicit private/unknown values readable', async () => {
    const bytes = createDicomFixture({ extraAttributes: { '00191001': ['LO', 'Synthetic private <text>'], '77760010': ['FD', new Uint8Array(new Float64Array([1.25, -2.5]).buffer)] } });
    const parsed = await native(bytes), snapshot = createAttributeSnapshot(parsed);
    assert.equal(row(snapshot, '(0002,0010)').section, 'meta'); assert.equal(row(snapshot, '(0002,0010)').vr, 'UI');
    assert.equal(row(snapshot, '(0010,0010)').value, 'SYNTHETIC^DEMO'); assert.equal(row(snapshot, '(0010,0010)').kind, 'value');
    assert.match(row(snapshot, '(0010,0010)').name, /Patient.*Name/u);
    assert.equal(row(snapshot, '(0010,0020)').value, 'EASI-SYNTHETIC'); assert.equal(row(snapshot, '(0008,103e)').value, 'Synthetic scalar fixture');
    assert.equal(row(snapshot, '(0019,1001)').value, 'Synthetic private <text>'); assert.equal(row(snapshot, '(0019,1001)').vr, 'LO');
    assert.equal(row(snapshot, '(7776,0010)').vr, 'FD'); assert.equal(row(snapshot, '(7776,0010)').value, '1.25\\-2.5');
    assert.equal(row(snapshot, '(7fe0,0010)').kind, 'binary'); assert.match(row(snapshot, '(7fe0,0010)').value, /8 bytes/u);
    assert.equal(snapshot.bytes, countBytes(snapshot)); assert.equal(snapshot.truncated, false);
    assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.rows) && snapshot.rows.every(Object.isFrozen));
});

test('nested sequence/item paths preserve repeated tags and native multi-valued numbers independently', async () => {
    const metadata = { '00080016': j('UI', '1.2.840.10008.5.1.4.1.1.7'), '00080018': j('UI', '2.25.88001'),
        '00081115': sq({ '0020000E': j('UI', '2.25.881'), '00081140': sq({ '00081155': j('UI', '2.25.8811') }, { '00081155': j('UI', '2.25.8812') }) }),
        '00280106': j('US', 1, 2, 3) };
    const snapshot = createAttributeSnapshot(await native(independentNativeFixture(metadata)));
    const refs = snapshot.rows.filter(value => value.tag === '(0008,1155)');
    assert.deepEqual(refs.map(value => value.value), ['2.25.8811', '2.25.8812']); assert.notEqual(refs[0].path, refs[1].path);
    assert.match(refs[1].path, /^dataset\/\(0008,1115\)\/item\[1\]\/\(0008,1140\)\/item\[2\]/u);
    assert.equal(refs[1].depth, 2); assert.equal(row(snapshot, '(0028,0106)').value, '1\\2\\3');
    assert.ok(snapshot.rows.filter(value => value.kind === 'item').every(value => value.tag === '(fffe,e000)' && value.vr === 'ITEM'));
});

test('native character set controls bounded textual decoding; JSON Unicode PN is already decoded', async () => {
    const latin = await native(createDicomFixture({ extraAttributes: { '00080005': ['CS', 'ISO_IR 100'], '00100010': ['PN', Uint8Array.of(77, 252, 108, 108, 101, 114)] } }));
    assert.equal(row(createAttributeSnapshot(latin), '(0010,0010)').value, 'Müller');
    const unknown = await native(createDicomFixture({ extraAttributes: { '00080005': ['CS', 'ISO 2022 IR 87'] } }));
    const partial = createAttributeSnapshot(unknown); assert.equal(partial.truncated, true); assert.match(row(partial, '(0010,0010)').value, /unsupported Specific Character Set/u);
    assert.equal(row(partial, '(0028,0010)').value, '2');
    const unicode = createAttributeSnapshot(await json({ '00100010': { vr: 'PN', Value: [{ Alphabetic: 'SYNTHETIC^UNICODE', Ideographic: '合成' }] } }));
    assert.equal(row(unicode, '(0010,0010)').value, 'Alphabetic: SYNTHETIC^UNICODE · Ideographic: 合成');
});

test('binary, Pixel Data and deferred URI summaries never read/copy payloads or expose URI values', async () => {
    let reads = 0;
    const pixel = attribute('7FE00010', 'OW', null, { valueLength: 64 * 1024 * 1024 });
    const binary = attribute('00282000', 'OB', null, { valueLength: 1024 });
    for (const value of [pixel, binary]) { Object.defineProperty(value, 'data', { get() { reads++; throw Error('Do not inspect bulk bytes.'); } }); value.access = () => { reads++; throw Error('Do not access bulk bytes.'); }; }
    const snapshot = createAttributeSnapshot(instance([pixel, binary, attribute('00420011', 'OB', '../not-followed'), attribute('00191001', 'LO', 'Readable', { bulkDataDecision: 'auto-materialize', isBulkStreamed: false, isMaterialized: true })]));
    assert.equal(reads, 0); assert.equal(row(snapshot, '(0042,0011)').kind, 'bulk'); assert.ok(!JSON.stringify(snapshot).includes('../not-followed'));
    assert.equal(row(snapshot, '(0019,1001)').value, 'Readable');
    const parsed = await json({ '7FE00010': { vr: 'OW', BulkDataURI: 'https://synthetic.invalid/no-request' }, '00420011': { vr: 'OB', InlineBinary: 'AQIDBA==' } });
    const fromJson = createAttributeSnapshot(parsed); assert.equal(row(fromJson, '(7fe0,0010)').kind, 'bulk'); assert.match(row(fromJson, '(0042,0011)').value, /4 bytes/u);
    assert.ok(!JSON.stringify(fromJson).includes('synthetic.invalid'));
});

test('real DICOMweb metadata preserves private VR and exact BulkDataURI provenance without URI-shape guesses', async () => {
    const data = { ...dicomJson(enhancedAttributes()),
        '00420011': { vr: 'OB', BulkDataURI: '../known-bulk?token=synthetic-known' },
        '00191000': { vr: 'OB', BulkDataURI: '../private-bulk?token=synthetic-private' },
        '00191001': { vr: 'LO', Value: ['../looks-like-a-uri?token=literal-text'] },
        '00191002': { vr: 'LO', Value: ['https://synthetic.invalid/literal-private-text'] },
        '00191003': { vr: 'FD', Value: [-2.25, 6.5] },
        '00191004': { vr: 'OB', InlineBinary: 'AQIDBA==' } };
    await withMetadataClient([data], async (client, requests) => {
        const [parsed] = await client.getSeriesMetadata(studyUid, seriesUid), snapshot = createAttributeSnapshot(parsed);
        assert.equal(requests.length, 1);
        for (const tag of ['(0042,0011)', '(0019,1000)']) {
            assert.equal(row(snapshot, tag).vr, 'OB'); assert.equal(row(snapshot, tag).kind, 'bulk');
            assert.equal(row(snapshot, tag).value, 'Deferred bulk data (not fetched)');
        }
        assert.equal(row(snapshot, '(0019,1001)').vr, 'LO'); assert.equal(row(snapshot, '(0019,1001)').kind, 'value');
        assert.equal(row(snapshot, '(0019,1001)').value, '../looks-like-a-uri?token=literal-text');
        assert.equal(row(snapshot, '(0019,1002)').value, 'https://synthetic.invalid/literal-private-text');
        assert.equal(row(snapshot, '(0019,1003)').vr, 'FD'); assert.equal(row(snapshot, '(0019,1003)').value, '-2.25\\6.5');
        assert.equal(row(snapshot, '(0019,1004)').vr, 'OB'); assert.equal(row(snapshot, '(0019,1004)').kind, 'binary');
        assert.match(row(snapshot, '(0019,1004)').value, /4 bytes/u);
        assert.doesNotMatch(JSON.stringify(snapshot), /synthetic-known|synthetic-private|known-bulk|private-bulk/u);
        assert.equal(snapshot.bytes, countBytes(snapshot));
    });
});

test('private nested JSON sequences align null and empty items without bulk provenance aliasing', async () => {
    const data = { ...dicomJson(enhancedAttributes()), '00191010': { vr: 'SQ', Value: [null, {},
        { '00191000': { vr: 'OB', BulkDataURI: '../nested-secret?token=synthetic-nested' },
            '00191011': { vr: 'SQ', Value: [null, { '00191000': { vr: 'UN', BulkDataURI: 'nested-relative' } }] } },
        { '00191000': { vr: 'LO', Value: ['../literal-nested-text'] } }] } };
    await withMetadataClient([data], async (client, requests) => {
        const [parsed] = await client.getSeriesMetadata(studyUid, seriesUid), snapshot = createAttributeSnapshot(parsed);
        assert.equal(requests.length, 1);
        const values = snapshot.rows.filter(value => value.tag === '(0019,1000)');
        assert.deepEqual(values.map(value => [value.vr, value.kind]), [['OB', 'bulk'], ['UN', 'bulk'], ['LO', 'value']]);
        assert.match(values[0].path, /\(0019,1010\)\/item\[2\]/u);
        assert.match(values[1].path, /\(0019,1011\)\/item\[1\]/u);
        assert.match(values[2].path, /\(0019,1010\)\/item\[3\]/u);
        assert.equal(values[2].value, '../literal-nested-text');
        assert.doesNotMatch(JSON.stringify(snapshot), /nested-secret|synthetic-nested|nested-relative/u);
    });
});

test('registered archive metadata snapshots obey admission caps and clear held source references on last disposal', async () => {
    const data = { ...dicomJson(enhancedAttributes()),
        '00191000': { vr: 'OB', BulkDataURI: '../not-retained?token=synthetic-budget' },
        '00191001': { vr: 'LO', Value: ['x'.repeat(4096)] } };
    await withMetadataClient([data], async (client, requests) => {
        const sources = await loadArchiveSeries(client, studyUid, seriesUid), record = sources[0].frames[0]._metadata, session = sources[0]._session;
        try {
            const snapshot = sources[0].getAttributes(0);
            assert.equal(requests.length, 1); assert.equal(row(snapshot, '(0019,1000)').kind, 'bulk');
            assert.ok(snapshot.bytes <= MAX_ATTRIBUTE_BYTES); assert.ok(session.attributeBytes <= MAX_SESSION_ATTRIBUTE_BYTES);
            assert.equal(session.attributeBytes, snapshot.bytes); assert.doesNotMatch(JSON.stringify(snapshot), /not-retained|synthetic-budget/u);
            const capped = limitAttributeSnapshot(snapshot, 256); assert.ok(capped.bytes <= 256); assert.ok(capped.reasons.includes('byte-limit'));
            sources[0].dispose(); assert.equal(record.attributes, snapshot);
        } finally { sources.forEach(source => source.dispose()); }
        assert.equal(record.attributes, null); assert.equal(session.attributeBytes, 0); assert.equal(requests.length, 1);
    });
});

test('row, value, nesting, cyclic and byte limits are disclosed without breaking the source', () => {
    const values = instance(Array.from({ length: 10 }, (_, index) => attribute(`0019${(0x1000 + index).toString(16)}`, 'LO', 'x'.repeat(80))));
    const rows = createAttributeSnapshot(values, { maxRows: 3 }); assert.equal(rows.rows.length, 3); assert.ok(rows.reasons.includes('row-limit'));
    const text = createAttributeSnapshot(values, { maxValueChars: 12 }); assert.ok(text.rows.every(value => value.value.length <= 12)); assert.ok(text.reasons.includes('value-limit'));
    const child = { attributes: [attribute('00191001', 'LO', 'nested')] }, nested = instance([attribute('00081115', 'SQ', null, { items: [child] })]);
    child.attributes.push(attribute('00081140', 'SQ', null, { items: [{ attributes: [attribute('00191002', 'LO', 'too deep')] }] }));
    const depth = createAttributeSnapshot(nested, { maxDepth: 1 }); assert.ok(depth.reasons.includes('depth-limit')); assert.ok(!JSON.stringify(depth).includes('too deep'));
    const cycle = instance([]); cycle.dataSet.attributes.push(attribute('00081115', 'SQ', null, { items: [cycle.dataSet] }));
    assert.ok(createAttributeSnapshot(cycle).reasons.includes('cyclic-sequence'));
    for (const maxBytes of [0, 1, 2, 256, 1024]) {
        const limited = createAttributeSnapshot(values, { maxBytes }); assert.ok(limited.bytes >= 0 && limited.bytes <= maxBytes); assert.equal(limited.truncated, true);
        assert.ok(limited.reasons.includes('byte-limit')); if (limited.rows.length) assert.equal(limited.bytes, countBytes(limited));
    }
    const full = createAttributeSnapshot(values), readmitted = limitAttributeSnapshot(full, 256);
    assert.ok(readmitted.bytes <= 256); assert.equal(readmitted.truncated, true); assert.equal(limitAttributeSnapshot(full, full.bytes), full);
});

test('local getters share one instance snapshot across frames, do not decode/reparse, and clear held record references on disposal', async () => {
    const sources = await loadFiles([file(createDicomFixture({ frames: 2, values: [1, 2, 3, 4, 5, 6, 7, 8] }))]), series = sources[0];
    const descriptor = series.frames[0], snapshot = series.getAttributes(0), session = series._session;
    const decode = session.decoder.decode; let calls = 0; session.decoder.decode = () => { calls++; throw Error('No tab decoding.'); };
    assert.equal(series.getAttributes(1), snapshot); assert.equal(series.getAttributes(0), snapshot); assert.equal(calls, 0);
    assert.equal(session.attributeBytes, snapshot.bytes); assert.equal(session.cache.bytes, 0); session.decoder.decode = decode;
    series.dispose(); assert.equal(descriptor._record.attributes, null); assert.equal(session.attributeBytes, 0);
    assert.throws(() => series.getAttributes(0), /disposed/u);
});

test('enhanced local groups retain a shared snapshot until the last owner releases it', async () => {
    const sources = await loadFiles([file(createEnhancedDicom())]), first = sources[0], other = sources[1];
    const snapshot = first.getAttributes(0), held = first.frames[0]._record, session = first._session;
    assert.equal(other.getAttributes(0), snapshot); assert.equal(session.attributeBytes, snapshot.bytes);
    first.dispose(); assert.equal(held.attributes, snapshot); assert.equal(other.getAttributes(0), snapshot);
    sources.forEach(source => source.dispose()); assert.equal(held.attributes, null); assert.equal(session.attributeBytes, 0);
});

test('archive getters never fetch or decode; accepted WADO enriches headers once and metadata remains across encoded-cache eviction', async () => {
    const client = await createEnhancedArchive(), sources = await loadArchiveSeries(client, studyUid, seriesUid), series = sources[0];
    const metadata = series.getAttributes(0), held = series.frames[0]._metadata, session = series._session;
    try {
        assert.deepEqual(client.calls, []); assert.equal(metadata.rows.some(value => value.section === 'meta'), false);
        assert.equal(sources[1].getAttributes(0), metadata); assert.equal(session.attributeBytes, metadata.bytes);
        await series.getFrame(0); const actual = series.getAttributes(0);
        assert.notEqual(actual, metadata); assert.ok(actual.rows.some(value => value.section === 'meta'));
        assert.equal(sources[1].getAttributes(0), actual); assert.equal(client.calls.length, 1); assert.equal(session.attributeBytes, actual.bytes);
        session.encoded.clear(); assert.equal(series.getAttributes(0), actual); assert.equal(client.calls.length, 1);
        series.dispose(); assert.equal(held.attributes, actual); assert.equal(sources[1].getAttributes(0), actual);
    } finally { sources.forEach(source => source.dispose()); }
    assert.equal(held.attributes, null); assert.equal(session.attributeBytes, 0); assert.throws(() => series.getAttributes(0), /disposed/u);
});

test('aggregate local snapshot admission caps2MiB, keeps later images viewable, and releases every metadata reservation', async () => {
    const extras = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`0019${(0x1000 + index).toString(16)}`, ['LO', 'x'.repeat(4096)]]));
    const files = Array.from({ length: 20 }, (_, index) => file(createDicomFixture({ sopUid: `2.25.8900.${index + 1}`, instanceNumber: index + 1, extraAttributes: extras })));
    const sources = await loadFiles(files), series = sources[0], session = series._session;
    try {
        assert.equal(series.frames.length, 20); assert.ok(session.attributeBytes <= MAX_SESSION_ATTRIBUTE_BYTES);
        for (let index = 0; index < 20; index++) { const snapshot = series.getAttributes(index); assert.ok(snapshot.bytes <= MAX_ATTRIBUTE_BYTES); assert.equal(snapshot.truncated, true); }
        const tail = series.getAttributes(19); assert.equal(tail.rows.length, 0); assert.equal(tail.bytes, 0); assert.ok(tail.reasons.includes('byte-limit'));
        assert.deepEqual([...(await series.getFrame(19)).samples], [0, 100, 200, 300]);
    } finally { sources.forEach(source => source.dispose()); }
    assert.equal(session.attributeBytes, 0);
});

test('aggregate archive display rows remain capped through WADO enrichment and clear every shared metadata reference', async () => {
    const extras = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`0019${(0x1000 + index).toString(16)}`, ['LO', 'x'.repeat(4096)]]));
    const objects = Array.from({ length: 20 }, (_, index) => ({ ...enhancedAttributes(), ...extras, '00080018': ['UI', `2.25.8910.${index + 1}`] }));
    const instances = (await EASI.pipelineBuilder().fromByteStream().ofDicomMetadata().toInstances().build().process({ source: new TextEncoder().encode(JSON.stringify(objects.map(dicomJson))) })).toArray();
    let requests = 0;
    const client = { async getSeriesMetadata() { return instances; }, async retrieveInstance() { requests++; return new Response(createEnhancedDicom(objects[19]), { headers: { 'content-type': 'application/dicom' } }); } };
    const sources = await loadArchiveSeries(client, studyUid, seriesUid), session = sources[0]._session;
    const records = [...session.metadataRecords.values()];
    try {
        assert.equal(requests, 0); assert.equal(records.length, 20); assert.ok(session.attributeBytes <= MAX_SESSION_ATTRIBUTE_BYTES);
        const series = sources.find(source => source.frames.some(frame => frame.sopUid === '2.25.8910.20'));
        const index = series.frames.findIndex(frame => frame.sopUid === '2.25.8910.20');
        assert.equal(series.getAttributes(index).rows.length, 0); assert.equal(series.getAttributes(index).bytes, 0);
        assert.equal(requests, 0); const frame = await series.getFrame(index); assert.equal(frame.samples.length, 4);
        assert.equal(requests, 1); assert.ok(session.attributeBytes <= MAX_SESSION_ATTRIBUTE_BYTES); assert.equal(series.getAttributes(index).rows.length, 0);
    } finally { sources.forEach(source => source.dispose()); }
    assert.ok(records.every(record => record.attributes === null)); assert.equal(session.attributeBytes, 0);
});

test('decoded frames and worker messages never carry snapshot metadata or readable identity fields', async () => {
    const previous = globalThis.Worker, sent = [];
    class Worker {
        postMessage(message) { sent.push(message); queueMicrotask(() => this.onmessage({ data: { id: message.id, samples: Uint16Array.of(1, 2, 3, 4), range: { min: 1, max: 4 } } })); }
        terminate() {}
    }
    globalThis.Worker = Worker;
    const progress = [], measures = [], sources = await loadFiles([file(createDicomFixture({ values: [1, 2, 3, 4] }))], { onProgress: value => progress.push(value), onMeasure: value => measures.push(value) });
    try {
        const frame = await sources[0].getFrame(0); assert.equal(Object.hasOwn(frame, 'attributes'), false);
        assert.equal(sent.length, 1); assert.equal(Object.hasOwn(sent[0].metadata, 'attributes'), false);
        assert.ok(!/SYNTHETIC\^DEMO|EASI-SYNTHETIC|Patient.*Name/u.test(JSON.stringify([sent[0].metadata, progress, measures])));
        assert.equal(row(sources[0].getAttributes(0), '(0010,0010)').value, 'SYNTHETIC^DEMO');
    } finally { sources.forEach(source => source.dispose()); globalThis.Worker = previous; }
});
