import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import EASI from '@xinonix/easi-js';
import { createDimseGateway, DIMSE_GATEWAY_LIMITS, dimseMetadata } from '../examples/dimse-gateway/gateway.mjs';
import { SourceRegistry, SOURCE_SEARCH_FIELDS } from '../src/catalog/SourceRegistry.js';
import { loadArchiveSeries } from '../src/data/archive-source.js';
import { createDicomFixture } from '../src/data/synthetic.js';

const STUDY = '2.25.989.1', SERIES = `${STUDY}.1`, SOP = `${SERIES}.1`;
const association = { host: 'fixed-peer.invalid', port: 4242, callingAeTitle: 'EASI_VIEW', calledAeTitle: 'ORTHANC' };
const values = [17, 29, 41, 53];
function dicom(overrides = {}) {
    return createDicomFixture({ sopUid: SOP, seriesUid: SERIES, values,
        extraAttributes: { '0020000D': ['UI', STUDY], '00080020': ['DA', '20261019'], '00100010': ['PN', 'SYNTHETIC^PATIENT'],
            '00100020': ['LO', 'SYNTHETIC-1'], '00100021': ['LO', 'SYNTHETIC-ISSUER'], '00100030': ['DA', '20000101'],
            '00200011': ['IS', 1], ...overrides } });
}
function envelope(bytes = dicom(), count = 1, status = 0) {
    return { source: bytes, contentType: 'application/dicom', contentLength: bytes.byteLength,
        metadata: { count, dimse: { finalResponse: { status } } } };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function fixture(read = async () => envelope(), extra = {}) {
    const calls = [];
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const handler = createDimseGateway({ association, publicOrigin: origin,
        authorize: ({ authorization }) => authorization === 'Bearer SYNTHETIC',
        transportFactory: () => ({ read(peer, options) { calls.push({ peer, options }); return read(peer, options); } }), ...extra });
    server.on('request', handler);
    return { origin, handler, calls,
        get: (path, options = {}) => fetch(`${origin}/dimse${path}`, { ...options, headers: { Authorization: 'Bearer SYNTHETIC', ...options.headers } }),
        close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

test('DIMSE registry, HTTP gateway, EASI metadata and archive frames form a usable synthetic viewing pipeline', async () => {
    const f = await fixture();
    const registry = new SourceRegistry([{ id: 'synthetic', name: 'Synthetic DIMSE', type: 'dimse', baseUrl: `${f.origin}/dimse`,
        headers: { Authorization: 'Bearer SYNTHETIC' }, searchFields: [...SOURCE_SEARCH_FIELDS] }]);
    let stacks;
    try {
        const found = await registry.searchPatients('synthetic', { patientName: 'SYNTHETIC*', patientBirthDate: '20000101' });
        assert.equal(found.items[0].patientName, 'SYNTHETIC PATIENT');
        assert.equal(found.items[0].patientBirthDate, '20000101');
        const studies = await registry.listPatientStudies('synthetic', found.items[0]);
        assert.equal(studies.items[0].studyUid, STUDY);
        const remote = registry.getClient('synthetic');
        assert.equal((await remote.listSeries(STUDY)).items[0].seriesUid, SERIES);
        stacks = await loadArchiveSeries(remote, STUDY, SERIES);
        assert.equal(stacks.length, 1); assert.equal(stacks[0].frames.length, 1);
        const frame = await stacks[0].getFrame(0);
        assert.deepEqual([...frame.samples], values);
        assert.equal(frame.sopUid, SOP);
        assert.equal(f.calls.length, 5);
        assert.equal(f.calls[0].options.operation, 'c-find'); assert.equal(f.calls[0].options.queryRetrieveLevel, 'STUDY');
        assert.equal(f.calls[0].options.keys['00100010'], 'SYNTHETIC*');
        assert.equal(f.calls[0].options.keys['00100030'], '20000101');
        assert.equal(f.calls[1].options.keys['00100020'], 'SYNTHETIC-1');
        assert.equal(f.calls[1].options.keys['00100010'], '');
        assert.equal(f.calls[3].options.operation, 'c-get'); assert.equal(f.calls[3].options.queryRetrieveLevel, 'SERIES');
        assert.equal(f.calls[4].options.operation, 'c-get'); assert.equal(f.calls[4].options.queryRetrieveLevel, 'IMAGE');
        assert.deepEqual(f.calls[4].options.keys, { '0020000D': STUDY, '0020000E': SERIES, '00080018': SOP });
        assert.ok(f.calls.every(call => call.peer.host === 'fixed-peer.invalid'));
    } finally { stacks?.forEach(stack => stack.dispose()); registry.dispose(); await f.close(); }
});

test('gateway queries a fixed peer only after authorization and rejects mutating, foreign-origin and arbitrary proxy requests', async () => {
    const f = await fixture();
    try {
        assert.equal((await fetch(`${f.origin}/dimse/studies?PatientID=SYNTHETIC`)).status, 403);
        assert.equal((await f.get('/studies', { method: 'POST', body: '{}' })).status, 405);
        assert.equal((await f.get('/studies', { headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
        for (const path of ['/studies?host=secret.invalid', '/studies?port=1234', '/studies?url=https://secret.invalid',
            '/studies?PatientID=A&PatientID=B', '/studies?limit=101', '/studies?offset=-1', '/studies?includefield=bad', '/studies/not-a-uid/series']) {
            assert.equal((await f.get(path)).status, 400);
        }
        assert.equal(f.calls.length, 0);
        const preflight = await f.get('/studies', { method: 'OPTIONS', headers: { Origin: f.origin } });
        assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), f.origin);
        assert.equal(f.calls.length, 0);
    } finally { await f.close(); }
});

test('gateway exposes no peer diagnostics, credentials, URLs or failure bodies and bounds metadata output', async () => {
    const f = await fixture(async () => { throw new Error('SECRET https://secret.invalid?patient=PRIVATE'); });
    try {
        const response = await f.get('/studies?PatientID=SYNTHETIC');
        assert.equal(response.status, 502); assert.doesNotMatch(await response.text(), /SECRET|secret.invalid|PRIVATE|fixed-peer/);
        assert.deepEqual(f.handler.getState(), { activeRequests: 0 });
    } finally { await f.close(); }
    const bounded = await fixture(async () => envelope(), { limits: { ...DIMSE_GATEWAY_LIMITS, metadataBytes: 1 } });
    try { assert.equal((await bounded.get('/studies?PatientID=SYNTHETIC')).status, 502); }
    finally { await bounded.close(); }
});

test('gateway cancellation aborts the DIMSE signal and promptly releases concurrency even if a transport ignores cancellation', async () => {
    let canceled = false;
    const f = await fixture(async (_peer, { signal }) => new Promise(() => signal.addEventListener('abort', () => { canceled = true; })),
        { limits: { ...DIMSE_GATEWAY_LIMITS, maxConcurrent: 1 } });
    try {
        const controller = new AbortController(), pending = f.get('/studies?PatientID=SYNTHETIC', { signal: controller.signal });
        const rejected = assert.rejects(pending, { name: 'AbortError' });
        for (let index = 0; index < 50 && !f.calls.length; index++) await tick();
        assert.equal(f.calls.length, 1);
        assert.equal((await f.get('/studies?PatientID=SYNTHETIC')).status, 429);
        controller.abort(); await rejected;
        for (let index = 0; index < 50 && !canceled; index++) await tick();
        assert.equal(canceled, true);
        for (let index = 0; index < 50 && f.handler.getState().activeRequests; index++) await tick();
        assert.equal(f.handler.getState().activeRequests, 0);
    } finally { await f.close(); }
});

test('gateway preserves empty-success and partial-query truth and refuses partial or multiple-instance C-GET retrievals', async () => {
    const empty = await fixture(async () => ({ empty: true, ...envelope(new Uint8Array(), 0) }));
    try {
        const response = await empty.get('/studies?PatientID=SYNTHETIC');
        assert.equal(response.status, 200); assert.deepEqual(await response.json(), []);
    } finally { await empty.close(); }
    const partial = await fixture(async () => envelope(dicom(), 1, 0xB000));
    try {
        const response = await partial.get('/studies?PatientID=SYNTHETIC');
        assert.equal(response.status, 200); assert.match(response.headers.get('warning'), /^299/u);
        assert.equal((await partial.get(`/studies/${STUDY}/series/${SERIES}/metadata`)).status, 502);
    } finally { await partial.close(); }
    const multiple = await fixture(async () => envelope(dicom(), 2));
    try { assert.equal((await multiple.get(`/studies/${STUDY}/series/${SERIES}/instances/${SOP}`)).status, 502); }
    finally { await multiple.close(); }
});

test('gateway metadata preserves raw dates, all numeric values, Unicode names and inert pixel markers', async () => {
    const bytes = dicom({ '00100010': ['PN', 'SYNTHETIC^合成=ごうせい'], '00280030': ['DS', [0.7, 0.8]] });
    const result = await EASI.pipelineBuilder().fromByteStream().ofDicomData().toInstances().build().process({ source: bytes });
    const metadata = dimseMetadata(result.toArray()[0]);
    assert.deepEqual(metadata['00080020'], { vr: 'DA', Value: ['20261019'] });
    assert.deepEqual(metadata['00100030'], { vr: 'DA', Value: ['20000101'] });
    assert.deepEqual(metadata['00100010'].Value, [{ Alphabetic: 'SYNTHETIC^合成', Ideographic: 'ごうせい' }]);
    assert.deepEqual(metadata['00280030'].Value, ['0.7', '0.8']);
    assert.deepEqual(metadata['00280010'], { vr: 'US', Value: [2] });
    assert.equal(metadata['7FE00010'].InlineBinary, undefined);
    assert.equal(metadata['7FE00010'].BulkDataURI, 'urn:easi-view:dimse:pixel-data');
});

test('DIMSE native fallback requests native transfer syntax explicitly rather than pretending transcoding', async () => {
    const f = await fixture();
    try {
        const response = await f.get(`/studies/${STUDY}/series/${SERIES}/instances/${SOP}`, {
            headers: { Accept: 'application/dicom; transfer-syntax=1.2.840.10008.1.2.1' } });
        assert.equal(response.status, 200); await response.arrayBuffer();
        assert.deepEqual(f.calls[0].options.storageTransferSyntaxUids, ['1.2.840.10008.1.2.1']);
    } finally { await f.close(); }
});

test('gateway metadata retains sequence hierarchy and multi-valued endian-aware numeric descriptors', async () => {
    for (const transferSyntax of ['1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']) {
        const little = transferSyntax.endsWith('.1'), descriptor = new Uint8Array(6), view = new DataView(descriptor.buffer);
        [3, 0, 16].forEach((value, index) => view.setUint16(index * 2, value, little));
        const generated = createDicomFixture({ transferSyntax, extraAttributes: { '00283002': ['US', descriptor] } });
        const parsed = await EASI.pipelineBuilder().fromByteStream().ofDicomData().toInstances().build().process({ source: generated });
        assert.deepEqual(dimseMetadata(parsed.toArray()[0])['00283002'], { vr: 'US', Value: [3, 0, 16] });
    }
    const raw = new TextEncoder().encode('SYNTHETIC ');
    const nested = { tag: { ID: '00401001', VR: { ID: 'UN' } }, vr: { ID: 'SH' }, access: () => raw };
    const sequence = { tag: { ID: '00400275', VR: { ID: 'SQ' } }, items: [{ attributes: [nested] }] };
    const result = dimseMetadata({ dataSet: { attributes: [sequence] } });
    assert.deepEqual(result['00400275'], { vr: 'SQ', Value: [{ '00401001': { vr: 'SH', Value: ['SYNTHETIC'] } }] });
});

test('gateway authorization receives validated resource scope and requires an explicit boolean allow decision', async () => {
    let observed;
    const f = await fixture(async () => envelope(), { authorize: request => { observed = request; return { authenticated: true }; } });
    try {
        assert.equal((await f.get('/studies?PatientID=SYNTHETIC')).status, 403);
        assert.equal(observed.resource.kind, 'studies');
        assert.deepEqual(observed.query, { PatientID: 'SYNTHETIC' });
        assert.equal(observed.authorization, 'Bearer SYNTHETIC');
        assert.equal(f.calls.length, 0);
    } finally { await f.close(); }
});
