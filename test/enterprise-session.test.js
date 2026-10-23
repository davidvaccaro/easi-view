import test from 'node:test';
import assert from 'node:assert/strict';
import { EnterpriseSession } from '../src/enterprise/EnterpriseSession.js';
import { DicomWebClient } from '../src/data/DicomWebClient.js';

function provider() {
    const api = { identity: null, calls: [], token: 0,
        async login({ signal }) { api.calls.push('login'); assert.equal(signal.aborted, false); return api.identity = { subject: 'private-user@example.invalid', realm: 'private-tenant', expiresAt: Date.now() + 60000 }; },
        async logout() { api.calls.push('logout'); api.identity = null; },
        async current() { api.calls.push('current'); return api.identity; },
        async getHeaders() { api.calls.push('headers'); return { Authorization: `Bearer private-token-${++api.token}` }; }
    }; return api;
}
const create = (adapter, options = {}) => new EnterpriseSession({ identityAdapter: adapter, archiveOrigins: ['https://pacs.example.invalid'], ...options });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('identity login/logout are explicit, request headers refresh each time, and default state/audit omit identity and credentials', async () => {
    const adapter = provider(), audits = [], states = [], session = create(adapter, { audit: event => audits.push(event) });
    session.subscribe(state => states.push(state)); assert.equal(session.getState().authenticated, false); assert.deepEqual(adapter.calls, []);
    await session.login(); assert.equal(session.getState().authenticated, true);
    assert.equal((await session.dicomHeaders({ url: 'https://pacs.example.invalid/studies?PatientID=private-id' })).Authorization, 'Bearer private-token-1');
    assert.equal((await session.dicomHeaders({ url: 'https://pacs.example.invalid/studies' })).Authorization, 'Bearer private-token-2');
    await session.logout(); assert.equal(session.getState().authenticated, false);
    assert.ok(!/private-|subject|realm|PatientID|https:|Authorization/.test(JSON.stringify({ audits, states })));
    assert.deepEqual(audits.map(event => event.operation), ['login', 'dicom-auth', 'dicom-auth', 'logout']); session.dispose();
});

test('unconfigured request origins, credentials, fragments and unsafe headers fail before any DICOM request', async () => {
    const adapter = provider(), session = create(adapter); await session.login(); const before = adapter.calls.length;
    for (const url of ['https://untrusted.invalid/studies', 'https://user:secret@pacs.example.invalid/studies', 'https://pacs.example.invalid/#token']) assert.throws(() => session.dicomHeaders({ url }), TypeError);
    assert.equal(adapter.calls.length, before);
    for (const value of [{ Cookie: 'private' }, { Host: 'untrusted' }, { Accept: 'text/html' }, { 'Proxy-Authorization': 'private' },
        { 'Sec-Fetch-Site': 'same-origin' }, { Authorization: 'private\r\nInjected: yes' }, { Authorization: 'a'.repeat(9000) }]) {
        await session.login(); adapter.getHeaders = async () => value; await assert.rejects(session.dicomHeaders({ url: 'https://pacs.example.invalid/' }), error => !/private|Injected|untrusted/.test(error.message));
        assert.equal(session.getState().authenticated, false);
    }
    session.dispose();
});

test('current identity and credential refresh failures clear authorization, notify observers and cancel concurrent work until explicit login', async () => {
    for (const failure of ['current', 'getHeaders']) {
        const adapter = provider(), session = create(adapter), states = [];
        session.subscribe(state => states.push(state)); await session.login();
        let finish; const work = session.withIdentity('worklist', {}, () => new Promise(resolve => finish = resolve));
        const workRejected = assert.rejects(work, { name: 'AbortError' }); await tick();
        const original = adapter[failure]; adapter[failure] = async () => { throw new Error('private refresh credentials and backend response'); };
        await assert.rejects(session.dicomHeaders({ url: 'https://pacs.example.invalid/' }), error => !/private|credentials|response/.test(error.message));
        await workRejected; assert.equal(session.getState().authenticated, false); assert.equal(states.at(-1).authenticated, false);
        adapter[failure] = original;
        await assert.rejects(session.dicomHeaders({ url: 'https://pacs.example.invalid/' }));
        finish('late-private-data'); await tick(); assert.equal(session.getState().authenticated, false);
        await session.login(); assert.equal(session.getState().authenticated, true); session.dispose();
    }
});

test('a canceled old refresh rejection cannot revoke a newer explicit login', async () => {
    const adapter = provider(), session = create(adapter); await session.login(); let rejectOld;
    const original = adapter.current; adapter.current = () => new Promise((resolve, reject) => rejectOld = reject);
    const pending = session.dicomHeaders({ url: 'https://pacs.example.invalid/' }), rejected = assert.rejects(pending, { name: 'AbortError' }); await tick();
    adapter.current = original; await session.login(); await rejected; rejectOld(new Error('late private failure')); await tick();
    assert.equal(session.getState().authenticated, true); assert.ok(await session.dicomHeaders({ url: 'https://pacs.example.invalid/' })); session.dispose();
});

test('logout cancels a hanging header refresh promptly and ignores its late token without an unhandled rejection', async () => {
    const adapter = provider(), session = create(adapter); await session.login();
    let finish; adapter.getHeaders = () => new Promise(resolve => finish = resolve);
    const pending = session.dicomHeaders({ url: 'https://pacs.example.invalid/studies' }); const rejected = assert.rejects(pending, { name: 'AbortError' });
    await tick(); await session.logout(); await rejected; finish({ Authorization: 'Bearer late-private-token' }); await tick();
    assert.equal(session.getState().authenticated, false); session.dispose();
});

test('a changed current identity realm cancels another pending operation and headers can only use the new identity', async () => {
    const adapter = provider(), session = create(adapter); await session.login();
    let finish; adapter.getHeaders = () => new Promise(resolve => finish = resolve);
    const pending = session.dicomHeaders({ url: 'https://pacs.example.invalid/studies' }); const rejected = assert.rejects(pending, { name: 'AbortError' }); await tick();
    adapter.identity = { subject: 'another-user', realm: 'another-realm', expiresAt: Date.now() + 60000 };
    adapter.getHeaders = async ({ identity }) => ({ Authorization: `Bearer ${identity.subject}` });
    assert.equal((await session.dicomHeaders({ url: 'https://pacs.example.invalid/studies' })).Authorization, 'Bearer another-user'); await rejected;
    finish({ Authorization: 'Bearer old-private-token' }); await tick(); session.dispose();
});

test('expired/invalid identity is cleared and provider errors never expose its response or secret context', async () => {
    const adapter = provider(), session = create(adapter); await session.login();
    adapter.identity.expiresAt = Date.now() - 1;
    await assert.rejects(session.dicomHeaders({ url: 'https://pacs.example.invalid/' }), /valid authorized data/); assert.equal(session.getState().authenticated, false);
    adapter.current = () => { throw new Error('private-token https://private.invalid?PatientID=example'); };
    await assert.rejects(session.dicomHeaders({ url: 'https://pacs.example.invalid/' }), error => !/private|https|PatientID/.test(error.message)); session.dispose();
});

test('host callback failures are isolated and disposal cancels hanging login without resurrecting identity', async () => {
    const adapter = provider(), session = create(adapter, { audit() { throw new Error('Observer failed.'); } });
    session.subscribe(async () => { throw new Error('Async observer failed.'); });
    let finish; adapter.login = () => new Promise(resolve => finish = resolve);
    const pending = session.login(); const rejected = assert.rejects(pending, { name: 'AbortError' }); await tick(); session.dispose(); await rejected;
    finish({ subject: 'late', realm: 'late', expiresAt: Date.now() + 60000 }); await tick();
    assert.deepEqual(session.getState(), { authenticated: false, expiresAt: null, disposed: true }); assert.throws(() => session.login(), /disposed/);
});

test('enterprise header callback plugs into the existing DICOMweb client with credentials omitted and a managed Accept', async () => {
    const old = globalThis.fetch, adapter = provider(), session = create(adapter); await session.login(); const requests = [];
    globalThis.fetch = async (url, options) => { requests.push({ url, options }); return new Response(null, { status: 204 }); };
    try {
        const client = new DicomWebClient({ baseUrl: 'https://pacs.example.invalid/dicom-web', headers: request => session.dicomHeaders(request) });
        await client.searchStudies(); await client.searchStudies();
        assert.equal(requests[0].options.credentials, 'omit'); assert.equal(requests[0].options.redirect, 'error');
        assert.equal(requests[0].options.headers.get('Accept'), 'application/dicom+json');
        assert.notEqual(requests[0].options.headers.get('Authorization'), requests[1].options.headers.get('Authorization'));
    } finally { globalThis.fetch = old; session.dispose(); }
});

test('an explicit logout stays logged out until explicit login even when a failed backend logout leaves its old host session current', async () => {
    const adapter = provider(), session = create(adapter); await session.login();
    adapter.logout = () => { throw new Error('Backend session revocation failed with private details.'); };
    await assert.rejects(session.logout(), /valid authorized data/); assert.equal(session.getState().authenticated, false);
    const calls = adapter.calls.length;
    await assert.rejects(session.dicomHeaders({ url: 'https://pacs.example.invalid/' }), /valid authorized data/);
    assert.equal(adapter.calls.length, calls, 'Silent identity refresh must not reverse explicit logout.');
    await session.login(); assert.equal(session.getState().authenticated, true); session.dispose();
});
