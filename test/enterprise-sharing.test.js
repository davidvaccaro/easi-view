import test from 'node:test';
import assert from 'node:assert/strict';
import { assertEnterpriseAuditPrivacy } from './helpers/enterprise-audit.js';
import { EnterpriseSession, ShareCoordinator } from '../src/enterprise/index.js';

const reference = { archiveKey: 'pacs-one', studyUid: '2.25.995', seriesUid: '2.25.995.1' };
function fixture(overrides = {}) {
    let current = { subject: 'private-user', realm: 'private-realm', expiresAt: Date.now() + 60000 };
    const audits = [], auth = new EnterpriseSession({ archiveOrigins: ['https://pacs.invalid'], identityAdapter: { login: async () => current, logout: async () => { current = null; }, current: async () => current, getHeaders: async () => ({}) }, audit: event => audits.push(event) });
    const records = new Map(), calls = [];
    const adapter = {
        async create({ identity, reference, ttlMs, viewerOrigin }) { calls.push('create'); const id = `share-${records.size + 1}`; records.set(id, { shareId: id, capability: `private-capability-${id}`, subject: identity.subject, realm: identity.realm, origin: viewerOrigin, reference: structuredClone(reference), expiresAt: Date.now() + ttlMs - 1, revoked: false, permissions: ['view'] }); return { shareId: id, capability: records.get(id).capability }; },
        async verify({ identity, receipt }) { calls.push('verify'); const record = records.get(receipt.shareId); if (!record || record.capability !== receipt.capability || record.subject !== identity.subject) throw new Error('private server verification detail'); const { capability, ...verified } = record; return structuredClone(verified); },
        async revoke({ shareId, identity }) { calls.push('revoke'); const record = records.get(shareId); if (record.subject !== identity.subject) throw new Error('Not permitted.'); record.revoked = true; return { shareId, capability: record.capability }; }, ...overrides
    };
    return { auth, audits, adapter, records, calls, setIdentity(value) { current = value; } };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('explicit server-verified shares expire/revoke and default state/audit never contain receipts, identities or study references', async () => {
    const f = fixture(), shares = new ShareCoordinator({ session: f.auth, adapter: f.adapter, viewerOrigin: 'https://viewer.invalid' });
    const issued = await shares.create(reference, { ttlMs: 5000 }); assert.match(issued.capability, /^private-capability/u);
    const resolved = await shares.resolve({ shareId: issued.shareId, capability: issued.capability }); assert.deepEqual(resolved.reference, reference);
    assert.equal(shares.getState().activeShareCount, 1); assert.deepEqual(f.calls, ['create', 'verify', 'verify']);
    assert.deepEqual(await shares.revoke(issued.shareId), { shareId: issued.shareId, revoked: true });
    await assert.rejects(shares.resolve({ shareId: issued.shareId, capability: issued.capability }), /valid authorized data/);
    assert.equal(shares.getState().activeShareCount, 0);
    assertEnterpriseAuditPrivacy(f.audits, /private|capability|2\.25|https:|reference|share-1/, { state: shares.getState() });
    shares.dispose(); f.auth.dispose();
});

test('server verification binds identity realm, subject, origin, expiry, permissions and exact archive reference', async () => {
    for (const change of [{ realm: 'another' }, { subject: 'another' }, { origin: 'https://untrusted.invalid' }, { expiresAt: Date.now() - 1 },
        { expiresAt: Date.now() + 86400001 }, { permissions: ['view', 'admin'] }, { revoked: true }, { reference: { ...reference, studyUid: '2.25.996' } }]) {
        const f = fixture(), original = f.adapter.verify; f.adapter.verify = async input => ({ ...await original(input), ...change });
        const shares = new ShareCoordinator({ session: f.auth, adapter: f.adapter, viewerOrigin: 'https://viewer.invalid' });
        await assert.rejects(shares.create(reference, { ttlMs: 1000 }), error => !/another|untrusted|admin|2\.25/.test(error.message));
        assert.equal(shares.getState().activeShareCount, 0); shares.dispose(); f.auth.dispose();
    }
});

test('local files, arbitrary URLs, raw pixels, credentials, extra receipt fields and invalid TTLs are rejected before creating a server share', async () => {
    const f = fixture(), shares = new ShareCoordinator({ session: f.auth, adapter: f.adapter, viewerOrigin: 'https://viewer.invalid' });
    for (const value of [{ sourceType: 'files', file: {} }, { url: 'https://pacs.invalid/dicom' }, { ...reference, pixels: new Uint8Array(4) }, { ...reference, token: 'private' }, { ...reference, archiveKey: 'https://pacs.invalid' }]) assert.throws(() => shares.create(value), TypeError);
    for (const ttlMs of [0, 999, 86400001, Infinity]) assert.throws(() => shares.create(reference, { ttlMs }), TypeError);
    assert.throws(() => shares.resolve({ shareId: 'opaque', capability: 'private', url: 'https://untrusted.invalid' }), TypeError);
    assert.deepEqual(f.calls, []); shares.dispose(); f.auth.dispose();
});

test('missing server verification and false local capability flags cannot create or resolve access', () => {
    const f = fixture();
    assert.throws(() => new ShareCoordinator({ session: f.auth, adapter: { create() {}, revoke() {} }, viewerOrigin: 'https://viewer.invalid' }), /server adapter/);
    const shares = new ShareCoordinator({ session: f.auth, adapter: f.adapter, viewerOrigin: 'https://viewer.invalid' });
    assert.throws(() => shares.resolve({ shareId: 'share', capability: true }), TypeError); shares.dispose(); f.auth.dispose();
});

test('logout, identity replacement and coordinator disposal cancel pending verification and never restore stale remembered capabilities', async () => {
    for (const action of ['logout', 'identity', 'dispose']) {
        const f = fixture(), original = f.adapter.verify; let finish;
        const shares = new ShareCoordinator({ session: f.auth, adapter: f.adapter, viewerOrigin: 'https://viewer.invalid' });
        const issued = await shares.create(reference); f.adapter.verify = input => new Promise(resolve => { finish = async () => resolve(await original(input)); });
        const pending = shares.resolve({ shareId: issued.shareId, capability: issued.capability }), rejected = assert.rejects(pending, { name: 'AbortError' }); await tick();
        if (action === 'logout') await f.auth.logout();
        if (action === 'identity') { f.setIdentity({ subject: 'another', realm: 'another', expiresAt: Date.now() + 60000 }); await f.auth.withIdentity('worklist', {}, async () => null); }
        if (action === 'dispose') shares.dispose();
        await rejected; await finish(); await tick(); assert.equal(shares.getState().activeShareCount, 0); shares.dispose(); f.auth.dispose();
    }
});

test('remembered share lifecycle is bounded and expiration is checked on every resolution rather than trusting cached access', async () => {
    const f = fixture(), shares = new ShareCoordinator({ session: f.auth, adapter: f.adapter, viewerOrigin: 'https://viewer.invalid', limit: 2 });
    await shares.create(reference); await shares.create(reference); const third = await shares.create(reference); assert.equal(shares.getState().activeShareCount, 2);
    f.records.get(third.shareId).expiresAt = Date.now() - 1;
    await assert.rejects(shares.resolve({ shareId: third.shareId, capability: third.capability }), /valid authorized data/);
    assert.equal(f.calls.filter(value => value === 'verify').length, 4); shares.dispose(); f.auth.dispose();
});

test('a canceled create never starts follow-up verification or retains a late backend-issued receipt', async () => {
    const f = fixture(); let finish;
    f.adapter.create = () => new Promise(resolve => finish = resolve);
    const shares = new ShareCoordinator({ session: f.auth, adapter: f.adapter, viewerOrigin: 'https://viewer.invalid' });
    const pending = shares.create(reference), rejected = assert.rejects(pending, { name: 'AbortError' }); await tick();
    await f.auth.logout(); await rejected; finish({ shareId: 'late-share', capability: 'private-late-capability' }); await tick();
    assert.deepEqual(f.calls, []); assert.equal(shares.getState().activeShareCount, 0); shares.dispose(); f.auth.dispose();
});

test('a remote share lifetime begins at server creation after network transit', async () => {
    const f = fixture(), original = f.adapter.create;
    f.adapter.create = async input => { await new Promise(resolve => setTimeout(resolve, 10)); return original(input); };
    const shares = new ShareCoordinator({ session: f.auth, adapter: f.adapter, viewerOrigin: 'https://viewer.invalid' });
    const issued = await shares.create(reference, { ttlMs: 1000 });
    assert.ok(issued.expiresAt > Date.now()); shares.dispose(); f.auth.dispose();
});
