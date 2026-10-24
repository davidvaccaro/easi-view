import test from 'node:test';
import assert from 'node:assert/strict';
import { EnterpriseSession, WorkflowCoordinator, normalizeEnterpriseContext, createWorkflowHttpAdapter } from '../src/enterprise/index.js';
import { assertEnterpriseAuditPrivacy } from './helpers/enterprise-audit.js';

const reference = { archiveKey: 'pacs-one', studyUid: '2.25.991', seriesUid: '2.25.991.1' };
const context = { version: 1, layout: 2, activeViewport: 0, viewports: [{ slot: 0, reference, frameIndex: 2, window: { center: 40, width: 400 } }] };
function identity() { return { subject: 'private-user', realm: 'private-realm', expiresAt: Date.now() + 60000 }; }
function session(audits = []) { return new EnterpriseSession({ archiveOrigins: ['https://pacs.invalid'], identityAdapter: { current: async () => identity(), login: async () => identity(), logout: async () => {}, getHeaders: async () => ({}) }, audit: event => audits.push(event) }); }
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('host JSON worklists and study context are functional, detached, and audited without worklist content or references', async () => {
    const audits = [], auth = session(audits), calls = [], item = { key: 'opaque-case', title: 'Host-provided title', reference, modality: 'CT', status: 'ready', priority: 'normal' };
    const workflow = new WorkflowCoordinator({ session: auth, adapter: { async list({ identity, offset, limit }) { calls.push([identity.realm, offset, limit]); return { items: [item], nextOffset: 1 }; }, async openStudy() { return context; } } });
    const page = await workflow.listWorklist({ limit: 10 }); assert.deepEqual(calls, [['private-realm', 0, 10]]);
    page.items[0].reference.studyUid = '2.25.123'; assert.equal(item.reference.studyUid, reference.studyUid);
    assert.deepEqual(await workflow.openStudy(reference), context); assert.equal(page.nextOffset, 1);
    assertEnterpriseAuditPrivacy(audits, /private-|opaque-case|2\.25|archiveKey|title|window/); workflow.dispose(); auth.dispose();
});

test('explicit persistence retains only normalized versioned UID/frame/layout/window context and never uses browser storage', async () => {
    const auth = session(), values = new Map(), calls = [];
    const workflow = new WorkflowCoordinator({ session: auth, adapter: { list: async () => ({ items: [] }), openStudy: async () => context },
        persistence: { async save({ key, context }) { calls.push('save'); values.set(key, structuredClone(context)); }, async load({ key }) { calls.push('load'); return values.get(key); } } });
    assert.deepEqual(calls, []); assert.deepEqual(await workflow.saveContext('view-1', context), { saved: true });
    const restored = await workflow.restoreContext('view-1'); restored.viewports[0].frameIndex = 99;
    assert.equal((await workflow.restoreContext('view-1')).viewports[0].frameIndex, 2); assert.deepEqual(calls, ['save', 'load', 'load']);
    workflow.dispose(); auth.dispose();
});

test('worklist and context schema bounds reject patient/pixel/token/URL fields, duplicate slots, unsupported versions and wrong requested studies', async () => {
    const auth = session(), workflow = new WorkflowCoordinator({ session: auth, adapter: { list: async () => ({ items: [{ key: 'one', title: 'Example', reference, patientName: 'not-permitted' }] }), openStudy: async () => ({ ...context, viewports: [{ slot: 0, reference: { ...reference, studyUid: '2.25.998' }, frameIndex: 0 }] }) } });
    await assert.rejects(workflow.listWorklist(), /valid authorized data/); await assert.rejects(workflow.openStudy(reference), /valid authorized data/);
    for (const changed of [{ version: 2 }, { layout: 3 }, { activeViewport: 4 }, { patientName: 'not-permitted' }, { pixels: new Uint8Array(1) }, { token: 'private' }, { url: 'https://secret.invalid' }, { viewports: [context.viewports[0], context.viewports[0]] }]) assert.throws(() => normalizeEnterpriseContext({ ...context, ...changed }), TypeError);
    assert.throws(() => normalizeEnterpriseContext({ ...context, viewports: [{ ...context.viewports[0], reference: { ...reference, archiveKey: 'https://secret.invalid' } }] }), TypeError);
    for (const options of [{ limit: 101 }, { limit: 0 }, { offset: -1 }, { filters: { patientName: 'private' } }]) assert.throws(() => workflow.listWorklist(options), TypeError);
    workflow.dispose(); auth.dispose();
});

test('logout or workflow disposal cancels pending host work promptly without returning stale context', async () => {
    for (const mode of ['logout', 'dispose']) {
        const auth = session(); let finish;
        const workflow = new WorkflowCoordinator({ session: auth, adapter: { list: () => new Promise(resolve => finish = resolve), openStudy: async () => context } });
        const pending = workflow.listWorklist(), rejected = assert.rejects(pending, { name: 'AbortError' }); await tick();
        if (mode === 'logout') await auth.logout(); else workflow.dispose(); await rejected;
        finish({ items: [], nextOffset: null }); await tick(); workflow.dispose(); auth.dispose();
    }
});

test('workflow HTTP adapter refreshes headers and uses explicit JSON methods with omitted credentials and refused redirects', async () => {
    const old = globalThis.fetch, calls = []; let tokens = 0;
    globalThis.fetch = async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify(options.method === 'GET' && url.includes('worklist') ? { items: [], nextOffset: null } : context), { headers: { 'content-type': 'application/json' } }); };
    try {
        const http = createWorkflowHttpAdapter({ baseUrl: 'https://host.invalid/api/easi-view', headers: async () => ({ Authorization: `Bearer private-${++tokens}` }) });
        const current = { identity: identity(), signal: new AbortController().signal };
        await http.adapter.list({ ...current, offset: 0, limit: 10 }); await http.adapter.openStudy({ ...current, reference });
        await http.persistence.save({ ...current, key: 'one', context }); await http.persistence.load({ ...current, key: 'one' });
        assert.deepEqual(calls.map(call => call.options.method), ['GET', 'POST', 'PUT', 'GET']);
        assert.ok(calls.every(call => call.options.credentials === 'omit' && call.options.redirect === 'error' && call.options.cache === 'no-store'));
        assert.equal(calls[0].options.headers.get('Authorization'), 'Bearer private-1'); assert.equal(calls[3].options.headers.get('Authorization'), 'Bearer private-4');
        assert.deepEqual(JSON.parse(calls[1].options.body), reference); assert.deepEqual(JSON.parse(calls[2].options.body), context);
    } finally { globalThis.fetch = old; }
});

test('workflow HTTP errors, oversized bodies, malformed JSON and cancellation are bounded and expose no provider data', async () => {
    const old = globalThis.fetch, http = createWorkflowHttpAdapter({ baseUrl: 'https://host.invalid/api', timeoutMs: 1000 }), current = { identity: identity(), signal: new AbortController().signal };
    try {
        for (const response of [new Response('private token and patient body', { status: 403 }), new Response('bad-json', { headers: { 'content-type': 'application/json' } }),
            new Response(' '.repeat(65537), { headers: { 'content-type': 'application/json' } }), new Response('{}', { headers: { 'content-type': 'text/html' } })]) {
            globalThis.fetch = async () => response; await assert.rejects(http.adapter.list({ ...current, offset: 0, limit: 10 }), error => !/private|token|patient|host\.invalid|bad-json/.test(error.message));
        }
        const controller = new AbortController(); globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Canceled.', 'AbortError'))));
        const pending = http.adapter.list({ ...current, signal: controller.signal, offset: 0, limit: 10 }), rejected = assert.rejects(pending, { name: 'AbortError' }); await tick(); controller.abort(); await rejected;
    } finally { globalThis.fetch = old; }
});

test('version1 context retains stable SOP/original-frame binding alongside a logical navigation hint', () => {
    const original = { ...context, viewports: [{ ...context.viewports[0], reference: { ...reference, sopUid: '2.25.991.1.2' }, frameIndex: 17, originalFrameNumber: 96 }] };
    assert.deepEqual(normalizeEnterpriseContext(original), original);
    const serialized = JSON.parse(JSON.stringify(normalizeEnterpriseContext(original))); assert.equal(serialized.viewports[0].originalFrameNumber, 96);
    for (const originalFrameNumber of [0, 4097, 1.5, Infinity]) assert.throws(() => normalizeEnterpriseContext({ ...original, viewports: [{ ...original.viewports[0], originalFrameNumber }] }), TypeError);
    assert.throws(() => normalizeEnterpriseContext({ ...context, viewports: [{ ...context.viewports[0], originalFrameNumber: 1 }] }), /exact SOP reference/);
});
