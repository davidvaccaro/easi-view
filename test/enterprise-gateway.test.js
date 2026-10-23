import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createDicomGateway, GATEWAY_LIMITS } from '../examples/gateway/gateway.mjs';
import { runSyntheticGateway } from '../examples/gateway/synthetic.mjs';
import { MAX_METADATA_BYTES } from '../src/data/DicomWebClient.js';
import { MAX_SOURCE_BYTES } from '../src/data/sources.js';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function fixture(peer, options = {}) {
    const calls = [], audits = [], upstream = createServer((request, response) => { calls.push({ path: request.url, headers: request.headers }); peer(request, response); });
    const gateway = createServer(), upstreamPort = await listen(upstream), port = await listen(gateway), origin = `http://127.0.0.1:${port}`;
    const handler = createDicomGateway({ archiveBaseUrl: `http://127.0.0.1:${upstreamPort}/dicom-web`, publicOrigin: origin, allowInsecureLoopback: true,
        authorize: ({ authorization }) => authorization === 'Bearer synthetic-viewer' ? { subject: 'private-subject', realm: 'private-realm', expiresAt: Date.now() + 60000 } : null,
        upstreamHeaders: () => ({ Authorization: 'Bearer synthetic-upstream' }), audit: event => audits.push(event), ...options });
    gateway.on('request', handler);
    return { origin, calls, audits, upstreamPort, get: (path, values = {}) => fetch(`${origin}${path}`, { ...values, headers: { Authorization: 'Bearer synthetic-viewer', Accept: 'application/dicom+json', ...values.headers } }),
        async close() { await Promise.all([close(gateway), close(upstream)]); } };
}

test('gateway is a fixed authenticated read-only route, strips downstream credentials and preserves encoded queries and only selected response headers', async () => {
    const f = await fixture((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/dicom+json', 'Set-Cookie': 'private-cookie', Warning: '299 peer "private query detail"' }); response.end('[]'); });
    try {
        const response = await f.get('/dicom-web/studies?PatientID=SYN%26THETIC&limit=10', { headers: { Cookie: 'private-host-session', Accept: 'application/dicom+json', 'X-Private': 'do-not-forward' } });
        assert.equal(response.status, 200); assert.equal(await response.text(), '[]'); assert.equal(f.calls[0].path, '/dicom-web/studies?PatientID=SYN%26THETIC&limit=10');
        assert.equal(f.calls[0].headers.authorization, 'Bearer synthetic-upstream'); assert.equal(f.calls[0].headers.cookie, undefined); assert.equal(f.calls[0].headers['x-private'], undefined);
        assert.equal(response.headers.get('set-cookie'), null); assert.equal(response.headers.get('access-control-allow-origin'), null); assert.match(response.headers.get('warning'), /limited these results/u); assert.ok(!response.headers.get('warning').includes('private'));
        assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
        await tick(); assert.ok(!/private|Bearer|PatientID|http:/.test(JSON.stringify(f.audits)));
    } finally { await f.close(); }
});

test('unauthenticated, mutating, foreign-origin, URL-proxy and invalid-query requests never reach the fixed archive', async () => {
    const f = await fixture((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/dicom+json' }); response.end('[]'); });
    try {
        assert.equal((await fetch(`${f.origin}/dicom-web/studies`)).status, 403);
        assert.equal((await f.get('/dicom-web/studies', { method: 'POST', body: 'synthetic' })).status, 405);
        assert.equal((await f.get('/dicom-web/studies', { headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
        assert.equal((await f.get('/dicom-web/studies?url=https://untrusted.invalid')).status, 400);
        assert.equal((await f.get('/dicom-web/studies?limit=101')).status, 400);
        assert.equal((await f.get('/dicom-web/studies?limit=1&limit=2')).status, 400);
        assert.equal((await f.get('/dicom-web/studies/private/series')).status, 404);
        assert.equal((await f.get('/dicom-web/admin')).status, 404); assert.equal(f.calls.length, 0);
    } finally { await f.close(); }
});

test('peer errors and redirects expose no archive response body/location and never contact a redirect target', async () => {
    let hits = 0; const target = createServer((_request, response) => { hits++; response.end('not-called'); }), targetPort = await listen(target);
    const f = await fixture((request, response) => { if (request.url.includes('redirect')) response.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/private` }); else response.writeHead(403, { 'Content-Type': 'text/plain' }); response.end('private patient/token body'); });
    try {
        const denied = await f.get('/dicom-web/studies'); assert.equal(denied.status, 403); assert.ok(!/private|patient|token/.test(await denied.text()));
        const redirected = await f.get('/dicom-web/studies?PatientID=redirect'); assert.equal(redirected.status, 502); assert.equal(redirected.headers.get('location'), null); assert.equal(hits, 0);
    } finally { await f.close(); await close(target); }
});

test('gateway caps declared and streamed envelopes and metadata media before exposing a usable response', async () => {
    const f = await fixture((request, response) => {
        if (request.url.includes('wrong-media')) { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('private body'); }
        else { response.writeHead(200, { 'Content-Type': 'application/dicom+json', 'Content-Length': '1000' }); response.end('[]'); }
    }, { limits: { ...GATEWAY_LIMITS, metadata: 10 } });
    try {
        for (const path of ['/dicom-web/studies', '/dicom-web/studies?PatientID=wrong-media']) { const response = await f.get(path); assert.equal(response.status, 502); assert.ok(!/private/.test(await response.text())); }
    } finally { await f.close(); }
    const streamed = await fixture((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/dicom+json' }); response.write('[]'); setTimeout(() => response.end(' '.repeat(100)), 5); }, { limits: { ...GATEWAY_LIMITS, metadata: 10 } });
    try { const response = await streamed.get('/dicom-web/studies'); await assert.rejects(response.text()); } finally { await streamed.close(); }
});

test('streaming native frame location headers are proven and rewritten before pixels, with the first payload chunk visible before the tail', async () => {
    let release; const tail = new Promise(resolve => release = resolve);
    const path = '/dicom-web/studies/2.25.1/series/2.25.2/instances/2.25.3/frames/1', boundary = 'synthetic-http-native';
    const f = await fixture(async (_request, response) => {
        response.writeHead(200, { 'Content-Type': `multipart/related;type="application/octet-stream";boundary=${boundary}` });
        response.write(`--${boundary}\r\nContent-Type: application/octet-stream; transfer-syntax=1.2.840.10008.1.2.1\r\nContent-Location: ${path}\r\nContent-Length: 200\r\n\r\n`); response.write(Buffer.alloc(150, 17)); await tail;
        response.end(Buffer.concat([Buffer.alloc(50, 34), Buffer.from(`\r\n--${boundary}--\r\n`)]));
    });
    try {
        const response = await f.get(path, { headers: { Accept: 'multipart/related;type="application/octet-stream"' } }), reader = response.body.getReader();
        const first = await reader.read(); assert.equal(first.done, false); assert.ok(first.value.length > 0);
        const head = Buffer.from(first.value).toString('latin1'); assert.ok(head.includes(`${f.origin}${path}`)); release();
        const chunks = [first.value]; while (true) { const part = await reader.read(); if (part.done) break; chunks.push(part.value); }
        const body = Buffer.concat(chunks.map(value => Buffer.from(value))), end = body.indexOf('\r\n\r\n');
        assert.deepEqual(body.subarray(end + 4, end + 204), Buffer.concat([Buffer.alloc(150, 17), Buffer.alloc(50, 34)]));
    } finally { release(); await f.close(); }
});

test('gateway concurrency and browser cancellation are enforced through the upstream abort signal', async () => {
    let started = false, canceled = false;
    const f = await fixture((_request, response) => { started = true; response.writeHead(200, { 'Content-Type': 'application/dicom+json' }); response.write('['); response.on('close', () => { if (!response.writableEnded) canceled = true; }); }, { maxConcurrent: 1 });
    try {
        const controller = new AbortController(), pending = f.get('/dicom-web/studies', { signal: controller.signal });
        const response = await pending; assert.equal(response.status, 200); for (let step = 0; step < 100 && !started; step++) await tick(); assert.equal(started, true);
        assert.equal((await f.get('/dicom-web/studies')).status, 429);
        const body = response.text(), rejected = assert.rejects(body); controller.abort(); await rejected;
        for (let step = 0; step < 50 && !canceled; step++) await new Promise(resolve => setTimeout(resolve, 2)); assert.equal(canceled, true);
    } finally { await f.close(); }
});

test('gateway limits match the viewer envelopes and the console synthetic demonstration proves authorized/denied generated reads', async () => {
    assert.equal(GATEWAY_LIMITS.metadata, MAX_METADATA_BYTES); assert.equal(GATEWAY_LIMITS.instance, MAX_SOURCE_BYTES);
    const result = await runSyntheticGateway(); assert.equal(result.studies, 1); assert.equal(result.unauthenticatedStatus, 403); assert.equal(result.originalImagingFilesUsed, false);
});

test('server authorization revocation aborts an active read and client capability booleans cannot authorize a gateway request', async () => {
    const revoked = new AbortController(); let canceled = false;
    const f = await fixture((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/dicom+json' }); response.write('['); response.on('close', () => { if (!response.writableEnded) canceled = true; }); },
        { authorize: () => ({ subject: 'server-verified-subject', realm: 'server-verified-realm', expiresAt: Date.now() + 60000, revocationSignal: revoked.signal }) });
    try {
        const response = await f.get('/dicom-web/studies'), body = response.text(), rejected = assert.rejects(body); revoked.abort(); await rejected;
        for (let step = 0; step < 50 && !canceled; step++) await new Promise(resolve => setTimeout(resolve, 2)); assert.equal(canceled, true);
        assert.equal((await f.get('/dicom-web/studies')).status, 403);
    } finally { await f.close(); }
    const flags = await fixture((_request, response) => response.end(), { authorize: () => ({ authorized: true, canRead: true }) });
    try { assert.equal((await flags.get('/dicom-web/studies')).status, 403); assert.equal(flags.calls.length, 0); } finally { await flags.close(); }
});
