import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalStorageConnector } from '../src/integration/local-storage-connector.js';

const origin = 'http://127.0.0.1:5174', id = '58c522d2-bc82-4b79-875d-7f371b9bc96a';
const item = { id, name: 'Synthetic PACS', remember: true, baseUrl: `${origin}/storage-connections/${id}/dimse/`,
    dimse: { host: '127.0.0.1', port: 4248, callingAeTitle: 'EASI_VIEW', calledAeTitle: 'SYNTHETIC' } };
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('browser local connector safely configures fixed-ID peers and lists without PACS work or credential forwarding', async () => {
    const calls = [];
    const connector = createLocalStorageConnector({ origin, fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (options.method === 'DELETE') return new Response(null, { status: 204 });
        if (url.endsWith('/echo')) return json({ ok: true, patient: 'MUST_NOT_ESCAPE' });
        if (options.method === 'GET') return json({ available: true, profiles: [item] });
        return json(item);
    } });
    assert.equal(await connector.available(), true); assert.deepEqual(await connector.list(), [item]);
    assert.deepEqual(await connector.save({ ...item, token: 'PRIVATE', password: 'PRIVATE', authentication: 'basic' }), item);
    assert.deepEqual(JSON.parse(calls[2].options.body), { name: item.name, remember: true, dimse: item.dimse });
    await connector.save({ ...item, connectorId: id }); assert.equal(calls[3].options.method, 'PUT');
    const result = await connector.testEcho(id); assert.equal(result.ok, true); assert.doesNotMatch(JSON.stringify(result), /MUST_NOT_ESCAPE/);
    await connector.remove(id);
    for (const call of calls) {
        assert.equal(call.options.credentials, 'omit'); assert.equal(call.options.redirect, 'error');
        assert.doesNotMatch(JSON.stringify(call), /PRIVATE|Authorization|Cookie/);
        if (call.options.method !== 'GET') assert.equal(call.options.headers['X-EASI-View'], '1');
    }
});

test('browser helper rejects foreign origins, raw target IDs, redirected profile URLs and unbounded responses', async () => {
    for (const value of ['https://127.0.0.1:5174', 'http://viewer.example', origin + '/path', origin + '?x=1']) {
        assert.throws(() => createLocalStorageConnector({ origin: value }), /loopback/);
    }
    const connector = createLocalStorageConnector({ origin, fetchImpl: async () => json({ ...item, baseUrl: 'https://foreign.invalid/dimse' }) });
    await assert.rejects(connector.save(item), /invalid profile/);
    await assert.rejects(connector.testEcho('127.0.0.1:4248'), /configured local connector ID/);
    const oversized = createLocalStorageConnector({ origin, fetchImpl: async () => json({ available: true, profiles: [], pad: 'x'.repeat(131073) }) });
    await assert.rejects(oversized.list(), /exceeds its limit/);
});

test('browser connector sanitizes transport and HTTP failures and preserves explicit cancellation', async () => {
    const failing = createLocalStorageConnector({ origin, fetchImpl: async () => { throw new Error('SECRET PRIVATE'); } });
    assert.equal(await failing.available(), false);
    await assert.rejects(failing.list(), error => !/SECRET|PRIVATE/.test(error.message));
    const denied = createLocalStorageConnector({ origin, fetchImpl: async () => new Response('SECRET PRIVATE', { status: 403 }) });
    await assert.rejects(denied.list(), error => error.status === 403 && !/SECRET|PRIVATE/.test(error.message));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(denied.list({ signal: controller.signal }), { name: 'AbortError' });
});

test('control and echo requests have bounded deadlines even if fetch ignores cancellation', async () => {
    const signals = [];
    const connector = createLocalStorageConnector({ origin, timeoutMs: 20, echoTimeoutMs: 30,
        fetchImpl: (_url, { signal }) => { signals.push(signal); return new Promise(() => {}); } });
    assert.equal(await connector.available(), false);
    for (const operation of [() => connector.list(), () => connector.save(item), () => connector.remove(id), () => connector.testEcho(id)]) {
        await assert.rejects(operation(), error => error.name === 'TimeoutError' && error.status === 504 && /timed out/.test(error.message));
    }
    assert.equal(signals.length, 5); assert.ok(signals.every(signal => signal.aborted));
    const controller = new AbortController(), pending = connector.list({ signal: controller.signal }); controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
});

test('never-ending response bodies and stalled body cancellation cannot hang cleanup', async () => {
    let canceled = 0;
    const connector = createLocalStorageConnector({ origin, timeoutMs: 20, fetchImpl: async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"available":true')); },
        cancel() { canceled++; return new Promise(() => {}); }
    }), { headers: { 'Content-Type': 'application/json' } }) });
    await assert.rejects(connector.list(), { name: 'TimeoutError', status: 504 }); assert.equal(canceled, 1);
    await assert.rejects(connector.remove(id), { name: 'TimeoutError', status: 504 }); assert.equal(canceled, 2);
    const denied = createLocalStorageConnector({ origin, timeoutMs: 20, fetchImpl: async () => new Response(new ReadableStream({
        cancel() { return new Promise(() => {}); }
    }), { status: 403 }) });
    await assert.rejects(denied.remove(id), error => error.status === 403);
});

test('malformed connector response diagnostics never expose response content', async () => {
    const connector = createLocalStorageConnector({ origin, fetchImpl: async () => new Response('SECRET token=PRIVATE', { headers: { 'Content-Type': 'application/json' } }) });
    await assert.rejects(connector.list(), error => /unsupported response/.test(error.message) && !/SECRET|PRIVATE/.test(error.message));
});
