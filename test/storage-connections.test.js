import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, readFile, stat, rm, chmod, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStorageConnections, allowedStorageAddress } from '../tools/storage-connections.mjs';
import { createDimseGateway } from '../examples/dimse-gateway/gateway.mjs';
import { createDicomFixture } from '../src/data/synthetic.js';

const profile = (values = {}) => ({ name: 'Synthetic PACS', remember: false,
    dimse: { host: '127.0.0.1', port: 4248, callingAeTitle: 'EASI_VIEW', calledAeTitle: 'SYNTHETIC' }, ...values });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, options = {}) {
    const directory = await mkdtemp(path.join(tmpdir(), 'easi-view-connector-'));
    const file = path.join(directory, 'private', 'profiles.json');
    const handler = await createStorageConnections({ profilePath: file, ...options });
    const server = createServer(async (req, res) => { if (!await handler(req, res)) { res.statusCode = 404; res.end(); } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const send = (suffix = '', method = 'GET', body, headers = {}, signal) => fetch(base + '/storage-connections' + suffix,
        { method, signal, headers: { Origin: base, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-EASI-View': '1' }), ...headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    t.after(async () => { await handler.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
    return { handler, base, send, file, directory, server };
}
const save = async (f, value = profile()) => { const response = await f.send('', 'POST', value); assert.equal(response.status, 201, await response.clone().text()); return response.json(); };

test('local DIMSE connector requires same-origin loopback controls and never contacts PACS on discovery/configuration', async t => {
    let lookups = 0, echoes = 0;
    const f = await fixture(t, { lookup: async () => { lookups++; return [{ address: '127.0.0.1' }]; }, echo: async () => { echoes++; return { status: 0 }; } });
    assert.equal((await f.send()).status, 200);
    assert.equal((await f.send('', 'POST', profile(), { Origin: 'https://foreign.invalid' })).status, 403);
    assert.equal((await f.send('', 'POST', profile(), { 'X-EASI-View': '' })).status, 403);
    assert.equal((await f.send('', 'POST', profile(), { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    const hostile = await new Promise(resolve => { const req = request(f.base + '/storage-connections', { headers: { Host: 'attacker.invalid' } }, res => { res.resume(); resolve(res.statusCode); }); req.end(); });
    assert.equal(hostile, 403);
    const wrongPort = await new Promise(resolve => { const req = request(f.base + '/storage-connections', { headers: { Host: '127.0.0.1:1' } }, res => { res.resume(); resolve(res.statusCode); }); req.end(); });
    assert.equal(wrongPort, 403);
    const stored = await save(f, profile({ dimse: { ...profile().dimse, host: 'pacs.example' } }));
    assert.match(stored.id, /^[a-f0-9-]{36}$/); assert.equal(stored.baseUrl, `${f.base}/storage-connections/${stored.id}/dimse/`);
    assert.equal((await f.send()).headers.get('access-control-allow-origin'), null);
    assert.equal(lookups, 0); assert.equal(echoes, 0);
    assert.equal((await f.send('/' + stored.id + '/echo', 'POST', { host: '169.254.169.254' })).status, 400);
    assert.equal(lookups, 0); assert.equal(echoes, 0);
});

test('local DIMSE targets permit intentional LAN peers and reject metadata, link-local, unspecified and multicast destinations', async t => {
    const f = await fixture(t);
    for (const host of ['127.0.0.1', '192.168.10.2', '10.1.2.3', '172.16.0.2', '::1', 'fd12:3456::2', 'pacs.department.example']) {
        assert.equal((await f.send('', 'POST', profile({ dimse: { ...profile().dimse, host } }))).status, 201, host);
    }
    for (const host of ['0.0.0.0', '0.12.34.56', '169.254.169.254', '169.254.1.2', '100.100.100.200', '224.0.0.2', '255.255.255.255',
        '::', 'fe80::1', 'fe80::1%en0', 'ff02::1', 'fd00:ec2::254', '::ffff:a9fe:a9fe', 'http://pacs.example', 'user:pass@pacs.example', '2130706433', '127.1', '0x7f000001']) {
        assert.equal((await f.send('', 'POST', profile({ dimse: { ...profile().dimse, host } }))).status, 400, host);
    }
    assert.equal(allowedStorageAddress('::ffff:192.168.1.20'), true);
    assert.equal(allowedStorageAddress('::ffff:7f00:1'), true);
    assert.equal((await f.send('', 'POST', { ...profile(), token: 'SECRET' })).status, 400);
    assert.equal((await f.send('', 'POST', profile({ dimse: { ...profile().dimse, tls: true } }))).status, 400);
});

test('DNS results are validated and pinned per operation, including mixed and rebinding answers', async t => {
    let answer = [{ address: '192.168.10.2' }], queried = 0; const peers = [];
    const f = await fixture(t, { lookup: async host => { assert.equal(host, 'pacs.example'); return answer; },
        echo: async peer => { queried++; peers.push(peer); return { status: 0 }; } });
    const record = await save(f, profile({ dimse: { ...profile().dimse, host: 'pacs.example' } }));
    assert.equal((await f.send(`/${record.id}/echo`, 'POST', {})).status, 200);
    assert.equal(peers[0].host, '192.168.10.2', 'transport receives an approved literal rather than performing a second DNS lookup');
    for (const addresses of [['169.254.169.254'], ['192.168.10.2', '169.254.169.254'], ['fd00:ec2::254'], ['::ffff:a9fe:a9fe']]) {
        answer = addresses.map(address => ({ address }));
        assert.equal((await f.send(`/${record.id}/echo`, 'POST', {})).status, 400);
    }
    assert.equal(queried, 1);
});

test('only opted-in nonsecret DIMSE profiles persist in an owner-only file and reload without PACS traffic', async t => {
    const f = await fixture(t);
    const ephemeral = await save(f);
    await assert.rejects(stat(f.file), { code: 'ENOENT' });
    const remembered = await save(f, profile({ name: 'Remembered synthetic PACS', remember: true }));
    const content = JSON.parse(await readFile(f.file, 'utf8'));
    assert.equal(content.profiles.length, 1); assert.equal(content.profiles[0].id, remembered.id);
    assert.doesNotMatch(JSON.stringify(content), /password|token|authorization|patient|baseUrl/i);
    if (process.platform !== 'win32') assert.equal((await stat(f.file)).mode & 0o777, 0o600);
    let traffic = 0;
    const restored = await createStorageConnections({ profilePath: f.file, lookup: async () => { traffic++; }, echo: async () => { traffic++; } });
    t.after(() => restored.close()); assert.equal(restored.getState().profiles, 1); assert.equal(traffic, 0);
    assert.equal((await f.send('/' + remembered.id, 'PUT', profile({ name: 'Forgotten', remember: false }))).status, 200);
    assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')).profiles, []);
    assert.equal((await f.send('/' + ephemeral.id, 'DELETE')).status, 204);
    assert.equal((await f.send('/' + ephemeral.id + '/echo', 'POST', {})).status, 404);
});

test('local connector refuses credential-bearing or unsafe saved profile files', async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'easi-view-private-profiles-')); t.after(() => rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'profiles.json');
    await writeFile(file, JSON.stringify({ version: 1, profiles: [{ id: '58c522d2-bc82-4b79-875d-7f371b9bc96a', ...profile({ remember: true }), password: 'SECRET' }] }), { mode: 0o600 });
    await assert.rejects(createStorageConnections({ profilePath: file }), /could not be loaded/);
    if (process.platform !== 'win32') {
        await writeFile(file, JSON.stringify({ version: 1, profiles: [] })); await chmod(file, 0o644);
        await assert.rejects(createStorageConnections({ profilePath: file }), /could not be loaded/);
        await chmod(file, 0o600); const link = path.join(directory, 'link.json'); await symlink(file, link);
        await assert.rejects(createStorageConnections({ profilePath: link }), /could not be loaded/);
    }
});

test('fixed-ID DIMSE gateway uses configured peers and real EASI metadata conversion without forwarding HTTP credentials', async t => {
    const calls = [], study = '2.25.4101', series = '2.25.4102';
    const bytes = createDicomFixture({ seriesUid: series, extraAttributes: { '0020000D': ['UI', study], '00100010': ['PN', 'SYNTHETIC^PATIENT'] } });
    const f = await fixture(t, { gatewayFactory: options => createDimseGateway({ ...options,
        transportFactory: () => ({ read: async (peer, query) => { calls.push({ peer, query }); return { source: bytes, contentType: 'application/dicom',
            contentLength: bytes.byteLength, metadata: { count: 1, dimse: { finalResponse: { status: 0 } } } }; } }) }) });
    const record = await save(f);
    let response = await f.send(`/${record.id}/dimse/studies?PatientName=SYNTHETIC*`, 'GET', undefined,
        { Authorization: 'Bearer NOT_FOR_TCP', Cookie: 'private=NOT_FOR_TCP' });
    assert.equal(response.status, 200); assert.equal((await response.json())[0]['0020000D'].Value[0], study);
    assert.equal(calls.length, 1); assert.deepEqual(calls[0].peer, profile().dimse);
    assert.equal(calls[0].query.keys['00100010'], 'SYNTHETIC*');
    assert.doesNotMatch(JSON.stringify(calls), /NOT_FOR_TCP|Authorization|Cookie/);
    response = await f.send(`/${record.id}/dimse/studies?host=169.254.169.254`); assert.equal(response.status, 400); assert.equal(calls.length, 1);
    response = await f.send(`/${record.id}/dimse/studies`, 'POST', {}); assert.equal(response.status, 404); assert.equal(calls.length, 1);
});

test('local connector enforces operation concurrency and cancellation releases capacity when a transport ignores abort', async t => {
    let started, aborted = false;
    const begin = new Promise(resolve => { started = resolve; });
    const f = await fixture(t, { maxConcurrent: 1, operationTimeoutMs: 1000,
        echo: async (_peer, { signal }) => { started(); signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); } });
    const record = await save(f), controller = new AbortController();
    const pending = f.send(`/${record.id}/echo`, 'POST', {}, {}, controller.signal).catch(error => error);
    await begin;
    assert.equal((await f.send(`/${record.id}/echo`, 'POST', {})).status, 429);
    controller.abort(); await pending;
    for (let i = 0; i < 50 && f.handler.getState().activeRequests; i++) await pause(5);
    assert.equal(aborted, true); assert.equal(f.handler.getState().activeRequests, 0);
});

test('local connector deadlines, deleted targets and shutdown cancel active peer work', async t => {
    let aborted = 0;
    const f = await fixture(t, { operationTimeoutMs: 40, echo: (_peer, { signal }) => new Promise(() => signal.addEventListener('abort', () => { aborted++; })) });
    const record = await save(f);
    assert.equal((await f.send(`/${record.id}/echo`, 'POST', {})).status, 504); assert.equal(aborted, 1);
    const pending = f.send(`/${record.id}/echo`, 'POST', {}).catch(error => error);
    for (let i = 0; i < 50 && !f.handler.getState().activeRequests; i++) await pause(1);
    assert.equal((await f.send('/' + record.id, 'DELETE')).status, 204); await pending;
    for (let i = 0; i < 50 && f.handler.getState().activeRequests; i++) await pause(1);
    assert.equal(f.handler.getState().activeRequests, 0); assert.ok(aborted >= 2);
    await f.handler.close(); assert.equal((await f.send()).status, 503);
});

test('connector bounds profile counts, request size and secret-bearing failure output', async t => {
    const f = await fixture(t, { echo: async () => { throw Object.assign(new Error('SECRET user:pass@private.example patient=NAME'), { status: 400 }); } });
    const record = await save(f);
    const response = await f.send(`/${record.id}/echo`, 'POST', {}); assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /SECRET|user:pass|private.example|patient=NAME/);
    assert.equal((await f.send('', 'POST', profile({ name: 'x'.repeat(17000) }))).status, 413);
    for (let i = 1; i < 32; i++) await save(f, profile({ name: `Synthetic peer ${i}` }));
    assert.equal((await f.send('', 'POST', profile())).status, 409);
});
