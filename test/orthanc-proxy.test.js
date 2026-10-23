import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { gzipSync } from 'node:zlib';
import { createOrthancProxy } from '../tools/orthanc-proxy.mjs';

const STUDY = '2.25.301';
const SERIES = '2.25.301.1';
const SOP = '2.25.301.1.1';
const pause = duration => new Promise(resolve => setTimeout(resolve, duration));
function deferred() { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; }
async function listen(server) {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
}
function rawRequest(url, headers) {
    return new Promise((resolve, reject) => {
        const request = httpRequest(url, { headers }, response => { response.resume(); resolve(response.statusCode); });
        request.on('error', reject);
        request.end();
    });
}
async function fixture(action, peerAction = (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/dicom+json' });
    response.end('[]');
}) {
    const requests = [];
    const peer = createServer((request, response) => { requests.push({ url: request.url, headers: { ...request.headers }, method: request.method }); peerAction(request, response); });
    const peerUrl = await listen(peer);
    const proxy = createOrthancProxy(peerUrl);
    const server = createServer(async (request, response) => {
        if (!(await proxy(request, response))) { response.writeHead(200, { 'Content-Type': 'text/plain' }); response.end('STATIC'); }
    });
    const url = await listen(server);
    try { return await action({ url, peerUrl, requests }); }
    finally { await close(server); await close(peer); }
}

test('local preview proxy requires a fixed HTTP loopback root', () => {
    for (const upstream of ['https://127.0.0.1:8042', 'http://remote.invalid:8042', 'file:///tmp',
        'http://user:SECRET@127.0.0.1:8042', 'http://127.0.0.1:8042/path',
        'http://127.0.0.1:8042?upstream=remote', 'http://127.0.0.1:8042#section', 'http://127.0.0.1:8042?',
        'http://127.0.0.1:8042#', null, 8042]) {
        assert.throws(() => createOrthancProxy(upstream), /loopback root/);
    }
    assert.equal(typeof createOrthancProxy(), 'function');
    assert.equal(typeof createOrthancProxy('http://localhost:8042/'), 'function');
    assert.equal(typeof createOrthancProxy('http://[::1]:8042/'), 'function');
});

test('QIDO forwarding preserves encoded query values, status, and MIME while stripping credentials and private headers', async () => {
    await fixture(async ({ url, requests }) => {
        const query = new URLSearchParams({ PatientID: 'SYNTH*&notAParameter=1', PatientName: '合成^Patient',
            offset: '0', limit: '25', includefield: '0020000D,00100010' });
        const result = await fetch(`${url}/orthanc/dicom-web/studies?${query}`, {
            headers: { Accept: 'application/dicom+json', Cookie: 'SECRET=private', Authorization: 'Bearer SECRET',
                'X-Private': 'SECRET', Origin: url }
        });
        assert.equal(result.status, 200);
        assert.equal(result.headers.get('content-type'), 'application/dicom+json');
        assert.equal(result.headers.get('cache-control'), 'no-store');
        assert.equal(result.headers.get('access-control-allow-origin'), null);
        assert.equal(result.headers.get('set-cookie'), null);
        assert.equal(result.headers.get('x-private'), null);
        assert.equal(await result.text(), '[]');
        assert.equal(requests.length, 1);
        const forwarded = new URL(requests[0].url, 'http://localhost');
        assert.equal(forwarded.pathname, '/dicom-web/studies');
        assert.equal(forwarded.searchParams.get('PatientID'), 'SYNTH*&notAParameter=1');
        assert.equal(forwarded.searchParams.get('PatientName'), '合成^Patient');
        assert.equal(forwarded.searchParams.has('notAParameter'), false);
        assert.equal(requests[0].headers.accept, 'application/dicom+json');
        assert.equal(requests[0].headers.cookie, undefined);
        assert.equal(requests[0].headers.authorization, undefined);
        assert.equal(requests[0].headers['x-private'], undefined);
        assert.equal(requests[0].headers.origin, undefined);
    }, (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/dicom+json', 'Set-Cookie': 'SECRET=private',
            'Access-Control-Allow-Origin': '*', 'X-Private': 'SECRET' });
        response.end('[]');
    });
});

test('only validated study, series, instance, and metadata resource paths reach Orthanc', async () => {
    await fixture(async ({ url, requests }) => {
        const allowed = ['/studies', `/studies/${STUDY}/series`, `/studies/${STUDY}/instances`, `/studies/${STUDY}/metadata`,
            `/studies/${STUDY}/series/${SERIES}/instances`, `/studies/${STUDY}/series/${SERIES}/metadata`,
            `/studies/${STUDY}/series/${SERIES}/instances/${SOP}`, `/studies/${STUDY}/series/${SERIES}/instances/${SOP}/metadata`];
        for (const path of allowed) assert.equal((await fetch(`${url}/orthanc/dicom-web${path}`)).status, 200);
        assert.equal(requests.length, allowed.length);
        const rejected = ['/orthanc', '/orthanc/system', '/orthanc/patients', '/orthanc/tools/find',
            '/orthanc/dicom-web/studies/1..2/series', '/orthanc/dicom-web/studies/1.02/series',
            `/orthanc/dicom-web/studies/${'1'.repeat(65)}/series`, '/orthanc/dicom-web/studies/ABC/series',
            `/orthanc/dicom-web/studies/${STUDY}/series/${SERIES}`, `/orthanc/dicom-web/studies/${STUDY}`,
            `/orthanc/dicom-web/studies/${STUDY}/series/${SERIES}/instances/${SOP}/rendered`,
            '/orthanc/dicom-web/studies/1%2F2/series', '/orthanc/dicom-web/studies/1%2E2/series'];
        for (const path of rejected) assert.equal((await fetch(`${url}${path}`)).status, 404);
        assert.equal(requests.length, allowed.length);
        assert.equal(await (await fetch(`${url}/index.html`)).text(), 'STATIC');
    });
});

test('non-loopback hosts and foreign or opaque browser origins are blocked before forwarding', async () => {
    await fixture(async ({ url, requests }) => {
        // Browser fetch controls Host; use raw HTTP to exercise DNS-rebinding host defenses.
        for (const Host of ['attacker.invalid', 'localhost.attacker.invalid']) {
            assert.equal(await rawRequest(`${url}/orthanc/dicom-web/studies`, { Host }), 403);
        }
        for (const headers of [{ Origin: 'https://attacker.invalid' }, { Origin: 'null' }, { Origin: 'http://localhost:1234' },
            { Origin: `${url}/private-path` }, { Origin: `${url}?query=1` }]) {
            assert.equal((await fetch(`${url}/orthanc/dicom-web/studies`, { headers })).status, 403);
        }
        assert.equal(requests.length, 0);
        assert.equal((await fetch(`${url}/orthanc/dicom-web/studies`, { headers: { Origin: url } })).status, 200);
        assert.equal(requests.length, 1);
    });
});

test('mutating methods, HEAD, and CORS preflights cannot reach the local peer', async () => {
    await fixture(async ({ url, requests }) => {
        for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
            const result = await fetch(`${url}/orthanc/dicom-web/studies`, { method });
            assert.equal(result.status, 405);
            assert.equal(result.headers.get('allow'), 'GET');
            assert.equal(result.headers.get('access-control-allow-origin'), null);
        }
        assert.equal(requests.length, 0);
    });
});

test('native multipart responses deliver the first chunk before the peer completes its tail', async () => {
    const releaseTail = deferred();
    const first = '--synthetic\r\nContent-Type: application/dicom\r\n\r\n';
    await fixture(async ({ url, requests }) => {
        const result = await fetch(`${url}/orthanc/dicom-web/studies/${STUDY}/series/${SERIES}/instances/${SOP}`, {
            headers: { Accept: 'multipart/related; type="application/dicom"; transfer-syntax=1.2.840.10008.1.2.1' }
        });
        assert.match(result.headers.get('content-type'), /multipart\/related/);
        const reader = result.body.getReader();
        const initial = await reader.read();
        assert.equal(new TextDecoder().decode(initial.value), first);
        releaseTail.resolve();
        let received = '';
        while (true) { const chunk = await reader.read(); if (chunk.done) break; received += new TextDecoder().decode(chunk.value); }
        reader.releaseLock();
        assert.equal(received, 'SYNTHETIC-PIXELS\r\n--synthetic--\r\n');
        assert.match(requests[0].headers.accept, /transfer-syntax=1\.2\.840\.10008\.1\.2\.1/);
    }, (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'multipart/related; type="application/dicom"; boundary=synthetic' });
        response.write(first);
        releaseTail.promise.then(() => response.end('SYNTHETIC-PIXELS\r\n--synthetic--\r\n'));
    });
});

test('transparent gzip decoding does not forward incompatible length or encoding headers', async () => {
    const compressed = gzipSync('[]');
    await fixture(async ({ url }) => {
        const result = await fetch(`${url}/orthanc/dicom-web/studies`);
        assert.equal(result.headers.get('content-encoding'), null);
        assert.equal(result.headers.get('content-length'), null);
        assert.equal(await result.text(), '[]');
    }, (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/dicom+json', 'Content-Encoding': 'gzip', 'Content-Length': compressed.byteLength });
        response.end(compressed);
    });
});

test('upstream 299 warnings preserve pagination without exposing raw warning data', async () => {
    await fixture(async ({ url }) => {
        const result = await fetch(`${url}/orthanc/dicom-web/studies`);
        assert.match(result.headers.get('warning'), /^299 /);
        assert.doesNotMatch(result.headers.get('warning'), /SECRET|PatientID|private.invalid/);
        await result.arrayBuffer();
    }, (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/dicom+json', Warning: '299 orthanc "https://private.invalid/?PatientID=SECRET"' });
        response.end('[]');
    });
});

test('peer errors expose status and fixed technical messages instead of upstream bodies', async () => {
    await fixture(async ({ url }) => {
        const result = await fetch(`${url}/orthanc/dicom-web/studies`);
        assert.equal(result.status, 401);
        assert.equal(await result.text(), 'The local Orthanc peer returned HTTP 401.');
        assert.equal(result.headers.get('www-authenticate'), null);
    }, (_request, response) => {
        response.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'SECRET' });
        response.end('{"patient":"SECRET","url":"https://private.invalid"}');
    });
});

test('redirects are refused without contacting their target or exposing Location', async () => {
    const target = createServer((_request, response) => { targetRequests++; response.end('SECRET'); });
    let targetRequests = 0;
    const targetUrl = await listen(target);
    try {
        await fixture(async ({ url, requests }) => {
            const result = await fetch(`${url}/orthanc/dicom-web/studies`);
            assert.equal(result.status, 502);
            assert.equal(result.headers.get('location'), null);
            assert.doesNotMatch(await result.text(), /SECRET|private.invalid/);
            assert.equal(requests.length, 1);
            assert.equal(targetRequests, 0);
        }, (_request, response) => { response.writeHead(302, { Location: `${targetUrl}/SECRET` }); response.end(); });
    } finally { await close(target); }
});

test('browser response cancellation aborts the upstream streaming request', async () => {
    const peerClosed = deferred();
    await fixture(async ({ url }) => {
        const result = await fetch(`${url}/orthanc/dicom-web/studies/${STUDY}/series/${SERIES}/instances/${SOP}`);
        const reader = result.body.getReader();
        assert.equal((await reader.read()).done, false);
        await reader.cancel();
        reader.releaseLock();
        const closed = await Promise.race([peerClosed.promise.then(() => true), pause(2000).then(() => false)]);
        assert.equal(closed, true, 'The upstream stream must close after browser cancellation.');
    }, (_request, response) => {
        response.on('close', peerClosed.resolve);
        response.writeHead(200, { 'Content-Type': 'application/dicom' });
        response.write('SYNTHETIC-FIRST-CHUNK');
    });
});

test('connection failures return sanitized 502 messages', async () => {
    await fixture(async ({ url }) => {
        const result = await fetch(`${url}/orthanc/dicom-web/studies`);
        assert.equal(result.status, 502);
        assert.equal(await result.text(), 'The local Orthanc peer is unavailable or refused the preview request.');
    }, (request) => request.socket.destroy());
});
