import test from 'node:test';
import assert from 'node:assert/strict';
import { assertEnterpriseAuditPrivacy } from './helpers/enterprise-audit.js';
import { createEnterpriseViewer } from '../src/integration/enterprise-viewer.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const primary = { archiveKey: 'primary', studyUid: '2.25.700', seriesUid: '2.25.700.1', sopUid: '2.25.700.1.1' };
const another = { archiveKey: 'primary', studyUid: '2.25.701', seriesUid: '2.25.701.1', sopUid: '2.25.701.1.1' };
const makeContext = (reference = primary) => ({ version: 1, layout: 2, activeViewport: 0, viewports: [{ slot: 0, reference: structuredClone(reference), frameIndex: 17, originalFrameNumber: 96, window: { center: 40, width: 400 } }] });

function fixture(changes = {}) {
    const state = { identity: { subject: 'synthetic-alice', realm: 'synthetic-realm-a', expiresAt: Date.now() + 60000 }, loginCalls: 0, logoutCalls: 0,
        headers: [], audits: [], events: [], openCalls: 0, listCalls: 0, records: new Map(), saved: new Map(), local: [11, 22], remote: [], history: [], configuration: null,
        configurationCalls: 0, disconnectCalls: 0, viewerDisposeCalls: 0, applied: [], currentContext: null, disposed: false, subscriptions: new Map() };
    const viewer = {
        getState: () => ({ disposed: state.disposed }),
        on(type, callback) { state.subscriptions.set(type, callback); return () => state.subscriptions.delete(type); },
        async configureArchive(configuration) { state.configurationCalls++; if (state.configureHandler) return state.configureHandler(configuration); state.configuration = configuration; },
        async disconnectArchive() { state.disconnectCalls++; if (state.disconnectHandler) await state.disconnectHandler(); state.remote = []; state.history = []; state.configuration = null; state.currentContext = null; },
        exportStudyContext({ archiveKey }) { assert.equal(archiveKey, 'primary'); return state.exported ?? state.currentContext ?? { version: 1, layout: 2, activeViewport: 0, viewports: [] }; },
        async applyStudyContext(context, options) {
            if (state.applyHandler) return state.applyHandler(context, options);
            assert.equal(options.archiveKey, 'primary'); assert.ok(options.signal instanceof AbortSignal);
            const selected = context.viewports[0].reference;
            const headers = await state.configuration.headers({ url: `${state.configuration.baseUrl}/studies/${selected.studyUid}/series/${selected.seriesUid}/metadata`, signal: options.signal });
            assert.match(headers.Authorization, /^Bearer synthetic-/u);
            if (options.signal.aborted) throw new DOMException('Synthetic canceled apply.', 'AbortError');
            state.applied.push({ context: structuredClone(context), options: { archiveKey: options.archiveKey, scope: options.scope ? structuredClone(options.scope) : null } });
            state.currentContext = structuredClone(context); state.remote = context.viewports.map(item => item.reference.studyUid); state.history.push(state.currentContext);
        },
        dispose() { state.viewerDisposeCalls++; state.disposed = true; state.subscriptions.get('dispose')?.(); }
    };
    const identityAdapter = {
        async login() { state.loginCalls++; return state.identity; }, async logout() { state.logoutCalls++; if (state.logoutError) throw new Error('secret backend credentials and medical response'); },
        async current() { return state.identity; }, async getHeaders({ identity, url }) { const value = `Bearer synthetic-${identity.subject}-${state.headers.length + 1}`; state.headers.push({ url, value }); return { Authorization: value }; }
    };
    const workflowAdapter = {
        async list({ identity, offset, limit }) { state.listCalls++; assert.ok(identity); return { items: [{ key: 'generated-case', title: 'Generated worklist item', reference: primary }].slice(0, limit), nextOffset: offset === 0 ? 1 : null }; },
        async openStudy({ identity, reference }) { state.openCalls++; if (state.workflowHandler) return state.workflowHandler({ identity, reference }); return makeContext(reference); }
    };
    const persistence = {
        async save({ identity, key, context }) { state.saved.set(`${identity.realm}/${identity.subject}/${key}`, structuredClone(context)); },
        async load({ identity, key }) { return state.saved.get(`${identity.realm}/${identity.subject}/${key}`) ?? null; }
    };
    const shareAdapter = {
        async create({ identity, reference, ttlMs, viewerOrigin }) {
            const shareId = `synthetic-share-${state.records.size + 1}`, capability = `opaque-synthetic-capability-${shareId}`;
            state.records.set(shareId, { shareId, capability, subject: identity.subject, realm: identity.realm, reference: structuredClone(reference), origin: viewerOrigin,
                expiresAt: state.shareExpiresAt ?? Date.now() + ttlMs - 1, permissions: ['view'], revoked: false }); return { shareId, capability };
        },
        async verify({ receipt }) { const record = state.records.get(receipt.shareId); if (!record || receipt.capability !== record.capability) throw new Error('secret receipt detail'); const { capability, ...result } = record; return structuredClone(result); },
        async revoke({ shareId, identity }) { const record = state.records.get(shareId); if (record.subject !== identity.subject) throw new Error('private denied identity'); record.revoked = true; return { shareId, capability: record.capability }; }
    };
    const configuration = { identityAdapter, archive: { key: 'primary', baseUrl: 'https://gateway.invalid/dicom-web', retrievalMode: 'frame' }, workflowAdapter, persistence,
        shareAdapter, viewerOrigin: 'https://viewer.invalid', audit: value => state.audits.push(value), onChange: value => state.events.push(value), ...changes };
    const controller = createEnterpriseViewer(viewer, configuration);
    return { state, viewer, controller, configuration };
}

test('construction has no implicit sign-in, query or storage, and explicit login configures only the fixed archive with refreshing headers', async () => {
    const f = fixture(); assert.ok(Object.isFrozen(f.controller));
    assert.deepEqual([f.state.loginCalls, f.state.openCalls, f.state.configurationCalls, f.state.disconnectCalls, f.state.saved.size], [0, 0, 0, 0, 0]);
    assert.throws(() => f.controller.listWorklist(), /Sign in explicitly/);
    const signed = await f.controller.login(); assert.equal(signed.authenticated, true); assert.equal(signed.pendingOperations, 0);
    assert.equal(f.state.configuration.baseUrl, 'https://gateway.invalid/dicom-web'); assert.equal(f.state.configuration.credentials, 'omit'); assert.equal(f.state.configuration.retrievalMode, 'frame');
    const request = { url: 'https://gateway.invalid/dicom-web/studies', signal: new AbortController().signal };
    const first = await f.state.configuration.headers(request), second = await f.state.configuration.headers(request); assert.notEqual(first.Authorization, second.Authorization);
    assert.throws(() => f.state.configuration.headers({ ...request, url: 'https://foreign.invalid/studies' }));
    await f.controller.openStudy(primary); const page = await f.controller.listWorklist({ limit: 10 }); assert.equal(page.items.length, 1);
    assert.deepEqual(f.state.local, [11, 22]);
    assertEnterpriseAuditPrivacy(f.state.audits, /synthetic|2\.25|Bearer|https:|capability|reference|patient/i,
        { state: f.controller.getState(), events: f.state.events });
    await f.controller.dispose(); assert.equal(f.state.viewerDisposeCalls, 0); assert.deepEqual(f.state.local, [11, 22]);
});

test('foreign archive keys, credential/URL context fields and local-file shares are rejected before any viewer fetch', async () => {
    const f = fixture(); await f.controller.login();
    assert.throws(() => f.controller.openStudy({ ...primary, archiveKey: 'other' }), /configured archive/);
    assert.throws(() => f.controller.createShare({ sourceType: 'files', file: {} }), TypeError);
    assert.throws(() => f.controller.openStudy({ ...primary, url: 'https://foreign.invalid' }), TypeError);
    f.state.workflowHandler = async () => ({ ...makeContext(), url: 'https://secret.invalid' }); await assert.rejects(f.controller.openStudy(primary)); assert.equal(f.state.applied.length, 0);
    f.state.workflowHandler = async () => ({ ...makeContext(), viewports: [{ ...makeContext().viewports[0], reference: { ...primary, archiveKey: 'other' } }] });
    await assert.rejects(f.controller.openStudy(primary)); assert.equal(f.state.applied.length, 0); assert.equal(f.state.headers.length, 0);
    await f.controller.dispose();
});

test('explicit save/restore uses validated archive-only context and preserves SOP/original-frame authority without persisting credentials or pixels', async () => {
    const f = fixture(); await f.controller.login(); await assert.rejects(f.controller.saveContext('empty'));
    await f.controller.openStudy(primary); assert.deepEqual(await f.controller.saveContext('reading-1'), { saved: true });
    const saved = [...f.state.saved.values()][0]; assert.equal(saved.viewports[0].originalFrameNumber, 96); assert.equal(saved.viewports[0].frameIndex, 17);
    assert.ok(!/local|pixels|samples|token|https:|Bearer/.test(JSON.stringify(saved)));
    f.state.currentContext.viewports[0].frameIndex = 1; await f.controller.restoreContext('reading-1'); assert.equal(f.state.applied.at(-1).context.viewports[0].originalFrameNumber, 96);
    assert.equal(f.state.applied.at(-1).context.viewports[0].frameIndex, 17); assert.equal(await f.controller.restoreContext('missing'), null);
    f.state.exported = { ...makeContext(), patientName: 'forbidden' }; await assert.rejects(f.controller.saveContext('bad')); assert.equal(f.state.saved.size, 1);
    await f.controller.dispose();
});

test('logout during non-cooperative context application cancels promptly and clears any late protected projection while preserving local panes', async () => {
    const f = fixture(); await f.controller.login(); let release, start;
    const began = new Promise(resolve => start = resolve);
    f.state.applyHandler = (context, options) => new Promise(resolve => { release = () => { f.state.remote = [context.viewports[0].reference.studyUid]; resolve(); }; start(options.signal); });
    const pending = f.controller.openStudy(primary), rejected = assert.rejects(pending, { name: 'AbortError' }), selectedSignal = await began;
    await f.controller.logout(); await rejected; assert.equal(selectedSignal.aborted, true); assert.equal(f.controller.getState().authenticated, false);
    release(); await tick(); await tick(); assert.deepEqual(f.state.remote, []); assert.deepEqual(f.state.local, [11, 22]);
    assert.equal(f.state.viewerDisposeCalls, 0); await f.controller.dispose();
});

test('subject/realm replacement with identical expiry clears old reads and requires explicit login for the new identity', async () => {
    const f = fixture(); await f.controller.login(); await f.controller.openStudy(primary); await f.controller.saveContext('alice-only');
    const expiresAt = f.state.identity.expiresAt; f.state.identity = { subject: 'synthetic-bob', realm: 'synthetic-realm-b', expiresAt };
    await assert.rejects(f.controller.listWorklist(), { name: 'AbortError' }); await tick(); assert.deepEqual(f.state.remote, []); assert.equal(f.controller.getState().authenticated, false);
    assert.throws(() => f.controller.openStudy(another), /Sign in explicitly/);
    await f.controller.login(); await f.controller.openStudy(another); assert.deepEqual(f.state.remote, [another.studyUid]);
    assert.equal(await f.controller.restoreContext('alice-only'), null); assert.ok(f.state.headers.at(-1).value.includes('synthetic-bob')); await f.controller.dispose();
});

test('identity expiry is actively enforced even without another request and timer disposal clears remote projections', async () => {
    const originalNow = Date.now; let now = 100000; Date.now = () => now; let f;
    try {
        f = fixture(); f.state.identity.expiresAt = now + 10; await f.controller.login(); await f.controller.openStudy(primary);
        now += 20; await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(f.controller.getState().authenticated, false); assert.deepEqual(f.state.remote, []); assert.deepEqual(f.state.local, [11, 22]);
        await f.controller.dispose(); assert.equal(f.controller.getState().cleanupPending, false);
    } finally { if (f && !f.controller.getState().disposed) await f.controller.dispose(); Date.now = originalNow; }
});

test('backend logout failure stays fail-closed locally and sanitized errors never include provider data', async () => {
    const f = fixture(); await f.controller.login(); await f.controller.openStudy(primary); f.state.logoutError = true;
    await assert.rejects(f.controller.logout(), error => !/secret|credentials|medical/.test(error.message)); assert.deepEqual(f.state.remote, []);
    assert.equal(f.controller.getState().authenticated, false); assert.throws(() => f.controller.listWorklist(), /Sign in explicitly/);
    f.state.logoutError = false; await f.controller.login(); assert.equal(f.controller.getState().connected, true); await f.controller.dispose();
});

test('failed current identity or credential refresh clears existing remote projections and requires explicit login', async () => {
    for (const failure of ['current', 'getHeaders']) {
        const f = fixture(); await f.controller.login(); await f.controller.openStudy(primary);
        const original = f.configuration.identityAdapter[failure];
        f.configuration.identityAdapter[failure] = async () => { throw new Error('private authorization credentials and medical error body'); };
        await assert.rejects(f.state.configuration.headers({ url: 'https://gateway.invalid/dicom-web/studies', signal: new AbortController().signal }), error => !/private|credentials|medical/.test(error.message));
        await tick(); assert.deepEqual(f.state.remote, []); assert.equal(f.controller.getState().authenticated, false); assert.deepEqual(f.state.local, [11, 22]);
        assert.throws(() => f.controller.listWorklist(), /Sign in explicitly/);
        f.configuration.identityAdapter[failure] = original; await f.controller.login(); await f.controller.openStudy(primary); assert.equal(f.state.remote.length, 1);
        await f.controller.dispose();
    }
});

test('verified sharing opens only context panes within the grant and never turns a capability into an archive header/address', async () => {
    const f = fixture(); await f.controller.login(); const issued = await f.controller.createShare(primary, { ttlMs: 1000 });
    const receipt = { shareId: issued.shareId, capability: issued.capability };
    await f.controller.resolveShare(receipt); assert.deepEqual(f.state.applied.at(-1).options.scope, primary);
    assert.ok(f.state.headers.every(item => !item.value.includes(issued.capability) && item.url.startsWith('https://gateway.invalid/dicom-web/')));
    await f.controller.revokeShare(issued.shareId); assert.deepEqual(f.state.remote, []); assert.equal(f.controller.getState().authenticated, false); assert.equal(f.state.logoutCalls, 0);
    await f.controller.dispose();
});

test('share resolution rejects broadened secondary panes, different series/SOP, and a foreign archive before applying any context', async () => {
    for (const change of [{ reference: another }, { reference: { ...primary, seriesUid: '2.25.700.2' } }, { reference: { ...primary, sopUid: '2.25.700.1.2' } }]) {
        const f = fixture(); await f.controller.login(); const issued = await f.controller.createShare(primary);
        f.state.workflowHandler = async () => ({ ...makeContext(), viewports: [...makeContext().viewports, { slot: 1, reference: change.reference, frameIndex: 0 }] });
        await assert.rejects(f.controller.resolveShare({ shareId: issued.shareId, capability: issued.capability })); assert.equal(f.state.applied.length, 0); assert.equal(f.state.headers.length, 0); await f.controller.dispose();
    }
    const f = fixture(); await f.controller.login(); const issued = await f.controller.createShare(primary); f.state.records.get(issued.shareId).reference.archiveKey = 'foreign';
    await assert.rejects(f.controller.resolveShare({ shareId: issued.shareId, capability: issued.capability })); assert.equal(f.state.openCalls, 0); await f.controller.dispose();
});

test('share expiry and a newly denied active server verification clear remote projections without automatic server logout', async () => {
    const originalNow = Date.now; let now = 200000; Date.now = () => now; let f;
    try {
        f = fixture(); f.state.shareExpiresAt = now + 10; await f.controller.login(); const issued = await f.controller.createShare(primary, { ttlMs: 1000 });
        await f.controller.resolveShare({ shareId: issued.shareId, capability: issued.capability }); now += 20; await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(f.controller.getState().authenticated, false); assert.deepEqual(f.state.remote, []); assert.equal(f.state.logoutCalls, 0); await f.controller.dispose();
    } finally { if (f && !f.controller.getState().disposed) await f.controller.dispose(); Date.now = originalNow; }
    const second = fixture(); await second.controller.login(); const issued = await second.controller.createShare(primary);
    const receipt = { shareId: issued.shareId, capability: issued.capability }; await second.controller.resolveShare(receipt); second.state.records.get(issued.shareId).revoked = true;
    await assert.rejects(second.controller.resolveShare(receipt)); await tick(); assert.deepEqual(second.state.remote, []); assert.equal(second.controller.getState().authenticated, false); await second.controller.dispose();
});

test('missing share/persistence configuration never grants access or invents a backend', async () => {
    const f = fixture({ shareAdapter: undefined, persistence: undefined }); assert.equal(f.controller.getState().sharingEnabled, false); await f.controller.login();
    assert.throws(() => f.controller.createShare(primary), /not configured/); await assert.rejects(f.controller.saveContext('one')); await assert.rejects(f.controller.restoreContext('one'));
    assert.equal(f.state.saved.size, 0); await f.controller.dispose();
});

test('observer rejections are isolated, controller disposal never disposes its host, and a host dispose event cancels service lifetime', async () => {
    const f = fixture({ onChange: () => Promise.reject(new Error('Ignored observer')), audit: () => Promise.reject(new Error('Ignored audit')) });
    const unsub = f.controller.subscribe(() => { throw new Error('Ignored subscriber'); }); await f.controller.login(); await f.controller.openStudy(primary);
    await f.controller.dispose(); unsub(); assert.equal(f.state.viewerDisposeCalls, 0); assert.deepEqual(f.state.local, [11, 22]); assert.equal(f.controller.getState().cleanupPending, false); await tick();
    const second = fixture(); await second.controller.login(); second.viewer.dispose(); await tick(); assert.equal(second.controller.getState().disposed, true); assert.equal(second.controller.getState().cleanupPending, false);
});

test('one controller owns one viewer until cleanup completes, with fixed HTTPS/loopback validation and no public private-state access', async () => {
    const f = fixture(); assert.throws(() => createEnterpriseViewer(f.viewer, f.configuration), /one enterprise controller/);
    await f.controller.dispose(); const reused = createEnterpriseViewer(f.viewer, f.configuration); await reused.dispose();
    for (const baseUrl of ['https://secret@gateway.invalid/dicom-web', 'https://gateway.invalid/dicom-web?token=secret', 'http://remote.invalid/dicom-web']) {
        assert.throws(() => createEnterpriseViewer(f.viewer, { ...f.configuration, archive: { key: 'primary', baseUrl } }));
    }
    assert.equal(f.state.loginCalls, 0); assert.equal(f.state.viewerDisposeCalls, 0);
});

test('a superseded context request cannot overwrite a newer successful view and a late non-cooperative commit fails closed', async () => {
    const f = fixture(); await f.controller.login(); let release, start; const begun = new Promise(resolve => start = resolve);
    f.state.applyHandler = context => new Promise(resolve => { release = () => { f.state.remote = [context.viewports[0].reference.studyUid]; resolve(); }; start(); });
    const first = f.controller.openStudy(primary), rejected = assert.rejects(first, { name: 'AbortError' }); await begun; f.state.applyHandler = null;
    await f.controller.openStudy(another); await rejected; assert.deepEqual(f.state.remote, [another.studyUid]);
    release(); await tick(); await tick(); assert.deepEqual(f.state.remote, []); assert.equal(f.controller.getState().authenticated, false); await f.controller.dispose();
});
