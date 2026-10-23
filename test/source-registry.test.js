import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceRegistry, SOURCE_SEARCH_FIELDS } from '../src/catalog/SourceRegistry.js';
import { DimseGatewayClient } from '../src/data/DimseGatewayClient.js';

const attr = (vr, ...Value) => ({ vr, Value });
const study = (number, overrides = {}) => ({ '0020000D': attr('UI', `2.25.${number}`),
    '00100010': attr('PN', { Alphabetic: 'SYNTHETIC^PATIENT' }), '00100020': attr('LO', 'SYNTH-1'),
    '00100021': attr('LO', 'SYNTHETIC-HOSPITAL'), '00100030': attr('DA', '20000101'),
    '00080020': attr('DA', '20261019'), ...overrides });
const source = (id = 'research', options = {}) => ({ id, name: 'Synthetic Research Archive', type: 'dicomweb',
    baseUrl: 'https://synthetic.invalid/dicom-web', ...options });
const json = (items, headers = {}) => new Response(JSON.stringify(items), { headers: { 'content-type': 'application/dicom+json', ...headers } });
async function withFetch(stub, action) {
    const original = globalThis.fetch; globalThis.fetch = stub;
    try { return await action(); } finally { globalThis.fetch = original; }
}

test('closing a session forgets patient search evidence while retaining configured independent clients', async () => {
    await withFetch(async () => json([study(1)]), async () => {
        const registry = new SourceRegistry([source()]), client = registry.getClient('research');
        const result = await registry.searchPatients('research', { patientId: 'SYNTH-1' });
        registry.clearSearchHistory();
        assert.equal(registry.list().length, 1); assert.equal(registry.getClient('research'), client);
        await assert.rejects(registry.listPatientStudies('research', result.items[0]), /Choose a patient/);
        const fresh = await registry.searchPatients('research', { patientId: 'SYNTH-1' });
        assert.notEqual(fresh.items[0].id, result.items[0].id); registry.dispose();
    });
});

test('source registration makes no requests and safe descriptors exclude URLs and credentials', () => {
    let requests = 0, auth = 0;
    const original = globalThis.fetch; globalThis.fetch = () => { requests++; };
    try {
        const registry = new SourceRegistry([source('research', { headers: async () => { auth++; return { Authorization: 'SECRET-TOKEN' }; } }),
            source('hospital', { type: 'dimse', baseUrl: 'https://secret.invalid/gateway' })]);
        assert.equal(requests, 0); assert.equal(auth, 0);
        assert.equal(registry.list().length, 2);
        assert.equal(registry.getClient('research'), registry.getClient('research'));
        assert.notEqual(registry.getClient('research'), registry.getClient('hospital'));
        assert.ok(registry.getClient('hospital') instanceof DimseGatewayClient);
        assert.equal(registry.getSource('hospital').capabilities.requiresGateway, true);
        assert.equal(Object.isFrozen(registry.list()[0].capabilities.searchFields), true);
        assert.doesNotMatch(JSON.stringify(registry.list()), /secret|https|SECRET|Authorization/);
        registry.dispose(); assert.throws(() => registry.list(), /disposed/);
    } finally { globalThis.fetch = original; }
});

test('source validation rejects unsafe endpoints, ambiguous IDs, unsupported fields and frame-only DIMSE', () => {
    for (const value of [source(''), source('space id'), source('research', { type: 'tcp' }),
        source('research', { baseUrl: 'https://user:SECRET@synthetic.invalid' }),
        source('research', { baseUrl: 'https://synthetic.invalid?token=SECRET' }),
        source('research', { baseUrl: 'file:///secret' }), source('research', { name: 'bad\nname' }),
        source('research', { searchFields: ['patientName'] }), source('research', { searchFields: ['patientId', 'unsupported'] }),
        source('research', { type: 'dimse', retrievalMode: 'frame' }), source('research', { token: 'SECRET' })]) {
        assert.throws(() => new SourceRegistry([value]), error => !/SECRET|user:|file:/.test(error.message));
    }
    assert.throws(() => new SourceRegistry([source(), source()]), /unique/);
});

test('patient candidates group matching study evidence while retaining raw server pagination', async () => {
    await withFetch(async () => json([study(1), study(2)]), async () => {
        const registry = new SourceRegistry([source()]);
        const result = await registry.searchPatients('research', { patientName: 'SYNTHETIC*' }, { limit: 2 });
        assert.equal(result.items.length, 1); assert.equal(result.items[0].studies.length, 2);
        assert.equal(result.hasMore, true); assert.equal(result.nextOffset, 2);
        assert.equal(result.items[0].patientBirthDate, '20000101');
        assert.equal(result.items[0].issuerOfPatientId, 'SYNTHETIC-HOSPITAL');
        assert.doesNotMatch(result.items[0].id, /SYNTHETIC|20000101/);
        assert.equal(result.items[0].identityStatus, 'source-qualified');
    });
});

test('selecting a patient starts a new exact study search without initial modality/date/accession filters', async () => {
    const urls = [];
    await withFetch(async url => { urls.push(new URL(url)); return json([study(urls.length)]); }, async () => {
        const registry = new SourceRegistry([source()]);
        const [patient] = (await registry.searchPatients('research', { patientName: 'SYNTHETIC*', modality: 'CT',
            studyDate: '20260101-', accessionNumber: 'SYNTHETIC' })).items;
        const result = await registry.listPatientStudies('research', patient);
        assert.equal(result.items[0].studyUid, '2.25.2');
        assert.equal(urls[1].searchParams.get('PatientID'), 'SYNTH-1');
        assert.equal(urls[1].searchParams.has('IssuerOfPatientID'), false); // Optional matching was not configured.
        for (const name of ['ModalitiesInStudy', 'StudyDate', 'AccessionNumber', 'PatientName']) assert.equal(urls[1].searchParams.has(name), false);
    });
});

test('demographic conflicts remain separate and foreign or missing issuer results are excluded without losing pagination', async () => {
    let phase = 0;
    await withFetch(async () => json(phase++ === 0 ? [study(1), study(2, { '00100030': attr('DA', '19900101') })]
        : [study(3), study(4, { '00100021': attr('LO', 'OTHER') }), study(5, { '00100021': { vr: 'LO' } })]), async () => {
        const registry = new SourceRegistry([source()]);
        const found = await registry.searchPatients('research', { patientId: 'SYNTH-1' });
        assert.equal(found.items.length, 2); assert.equal(found.items[0].identityStatus, 'demographics-conflict');
        const result = await registry.listPatientStudies('research', found.items[0], { limit: 3 });
        assert.equal(result.items.length, 1); assert.equal(result.items[0].studyUid, '2.25.3');
        assert.equal(result.nextOffset, 3); assert.equal(result.hasMore, true);
        assert.match(result.warnings.join(' '), /excluded/);
    });
});

test('missing and wildcard patient IDs are study-scoped and never trigger a broad patient requery', async () => {
    for (const patientId of ['', 'SYNTH*', 'SYNTH?']) {
        let requests = 0;
        await withFetch(async () => { requests++; return json([study(1, { '00100020': attr('LO', patientId) }), study(2, { '00100020': attr('LO', patientId) })]); }, async () => {
            const registry = new SourceRegistry([source()]);
            const result = await registry.searchPatients('research', { accessionNumber: 'SYNTHETIC' });
            assert.equal(result.items.length, 2); assert.equal(result.items[0].identityStatus, 'study-scoped');
            const selected = await registry.listPatientStudies('research', result.items[0]);
            assert.equal(selected.items.length, 1); assert.equal(selected.items[0].studyUid, '2.25.1');
            assert.equal(requests, 1); assert.match(selected.warnings.join(' '), /exact patient identifier/);
        });
    }
});

test('sources isolate patient candidates and changing the selected source does not change other clients', async () => {
    await withFetch(async () => json([study(1)]), async () => {
        const registry = new SourceRegistry([source('a'), source('b')]);
        const original = registry.getClient('a');
        const first = (await registry.searchPatients('a', { patientId: 'SYNTH-1' })).items[0];
        const second = (await registry.searchPatients('b', { patientId: 'SYNTH-1' })).items[0];
        assert.notEqual(first.id, second.id); assert.equal(registry.getClient('a'), original);
        await assert.rejects(registry.listPatientStudies('b', first), /Choose a patient/);
    });
});

test('unsupported or unrestricted patient search is rejected before any network request', async () => {
    let requests = 0;
    await withFetch(async () => { requests++; return json([]); }, async () => {
        const registry = new SourceRegistry([source('research', { searchFields: ['patientId', 'patientName'] })]);
        for (const filters of [{}, { patientName: '*' }, { issuerOfPatientId: 'SYNTHETIC' }, { patientBirthDate: '20000101' }, { patientId: 'bad\nvalue' }]) {
            await assert.rejects(registry.searchPatients('research', filters), /criteria|support|short text/);
        }
        assert.equal(requests, 0);
    });
});

test('patient search maps birth date and issuer filters, preserves partial-result warnings without server text', async () => {
    let requested;
    await withFetch(async url => { requested = new URL(url); return json([study(1)], { Warning: '299 archive "SECRET https://secret.invalid?token=PRIVATE"' }); }, async () => {
        const registry = new SourceRegistry([source('research', { searchFields: [...SOURCE_SEARCH_FIELDS] })]);
        const result = await registry.searchPatients('research', { patientBirthDate: '20000101', issuerOfPatientId: 'SYNTHETIC-HOSPITAL' });
        assert.equal(requested.searchParams.get('PatientBirthDate'), '20000101');
        assert.equal(requested.searchParams.get('IssuerOfPatientID'), 'SYNTHETIC-HOSPITAL');
        assert.equal(result.hasMore, true); assert.equal(result.warnings.length, 1);
        assert.doesNotMatch(result.warnings[0], /SECRET|secret.invalid|PRIVATE/);
    });
});

test('canceling an auth supplier or late fetch does not retain patient candidates or sensitive errors', async () => {
    const registry = new SourceRegistry([source('research', { headers: () => new Promise(() => {}) })]);
    const abort = new AbortController();
    const pending = registry.searchPatients('research', { patientId: 'SYNTH-1' }, { signal: abort.signal });
    abort.abort(); await assert.rejects(pending, { name: 'AbortError' });
    await withFetch(async () => { throw new Error('SECRET https://secret.invalid?token=PRIVATE'); }, async () => {
        const dimse = new SourceRegistry([source('research', { type: 'dimse' })]);
        await assert.rejects(dimse.searchPatients('research', { patientId: 'SYNTH-1' }), error => /DIMSE HTTP gateway/.test(error.message) && !/SECRET|PRIVATE|secret.invalid/.test(error.message));
    });
});

test('disposing the registry cancels pending requests and produces count-only disposed state', async () => {
    const registry = new SourceRegistry([source('research', { headers: () => new Promise(() => {}) })]);
    const pending = registry.searchPatients('research', { patientId: 'SYNTHETIC' });
    registry.dispose(); await assert.rejects(pending, { name: 'AbortError' });
    assert.deepEqual(registry.getState(), { sources: 0, clients: 0, patientCandidates: 0, disposed: true });
});

test('optional issuer matching is declared explicitly while mandatory query fallback still verifies issuer', async () => {
    const urls = [];
    await withFetch(async url => { urls.push(new URL(url)); return json([study(1)]); }, async () => {
        const registry = new SourceRegistry([source('research', { searchFields: [...SOURCE_SEARCH_FIELDS] })]);
        const [patient] = (await registry.searchPatients('research', { patientId: 'SYNTH-1' })).items;
        await registry.listPatientStudies('research', patient);
        assert.equal(urls[1].searchParams.get('IssuerOfPatientID'), 'SYNTHETIC-HOSPITAL');
    });
});

test('dynamic named source registration validates before committing and cannot replace a live source', () => {
    const registry = new SourceRegistry();
    assert.equal(registry.register(source()).id, 'research');
    const client = registry.getClient('research');
    assert.throws(() => registry.add(source('research', { baseUrl: 'https://other.invalid' })), /unique/);
    assert.equal(registry.getClient('research'), client);
    assert.deepEqual(registry.getState(), { sources: 1, clients: 1, patientCandidates: 0, disposed: false });
});

test('a selected known name or birth date must remain verifiable on the fresh patient study page', async () => {
    for (const missing of ['00100010', '00100030']) {
        let count = 0;
        await withFetch(async () => json([count++ ? study(2, { [missing]: { vr: missing === '00100010' ? 'PN' : 'DA' } }) : study(1)]), async () => {
            const registry = new SourceRegistry([source()]);
            const [patient] = (await registry.searchPatients('research', { patientId: 'SYNTH-1' })).items;
            const selected = await registry.listPatientStudies('research', patient);
            assert.equal(selected.items.length, 0);
            assert.match(selected.warnings.join(' '), /unverified patient identity/);
        });
    }
});

test('source descriptors and static header objects reject accessors and symbol settings without invoking them', () => {
    let calls = 0;
    const configured = source(); Object.defineProperty(configured, 'headers', { enumerable: true, get() { calls++; throw new Error('SECRET'); } });
    assert.throws(() => new SourceRegistry([configured]), /Configure a source/);
    const headers = {}; Object.defineProperty(headers, 'Authorization', { enumerable: true, get() { calls++; throw new Error('SECRET'); } });
    assert.throws(() => new SourceRegistry([source('research', { headers })]), /plain request header/);
    assert.throws(() => new SourceRegistry([{ ...source(), [Symbol('private')]: 'SECRET' }]), /Configure a source/);
    assert.equal(calls, 0);
});

test('cumulative patient search evidence is bounded across responses and repeated studies do not consume another record', async () => {
    let number = 1;
    await withFetch(async () => json([study(number)]), async () => {
        const registry = new SourceRegistry([source()], { historyLimits: { bytes: 4096, studies: 2 } });
        const criteria = { patientId: 'SYNTH-1' };
        await registry.searchPatients('research', criteria); await registry.searchPatients('research', criteria);
        number = 2; await registry.searchPatients('research', criteria);
        number = 3; await assert.rejects(registry.searchPatients('research', criteria), /search history reached its session limit/);
        number = 1; const result = await registry.searchPatients('research', criteria);
        assert.equal(result.items[0].studies.length, 2);
    });
});

test('cumulative metadata byte limits apply before retaining another oversized patient candidate', async () => {
    await withFetch(async () => json([study(1, { '00100010': attr('PN', { Alphabetic: 'SYNTHETIC'.repeat(256) }) })]), async () => {
        const registry = new SourceRegistry([source()], { historyLimits: { bytes: 1024, studies: 10 } });
        await assert.rejects(registry.searchPatients('research', { patientId: 'SYNTH-1' }), /search history reached its session limit/);
        assert.equal(registry.getState().patientCandidates, 0);
    });
    assert.throws(() => new SourceRegistry([], { historyLimits: { bytes: 0, studies: 10 } }), /bounded internal/);
});
