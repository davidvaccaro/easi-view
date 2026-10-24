import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createEasiStoreProxy } from '../tools/easi-store-proxy.mjs';
const study = '2.25.9001', series = '2.25.9002', sop = '2.25.9003';
const resource = `/studies/${study}/series/${series}/instances/${sop}`;
const credentials = { Cookie: 'unrelated=private; easi_store_session=synthetic_test_session; ignored=also_private' };
async function listen(server) { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
async function fixture(t, peerAction, options = {}) {
    const received = [];
    const peer = createServer((req, res) => { received.push({ path: req.url, method: req.method, headers: req.headers }); peerAction(req, res); });
    const upstream = await listen(peer);
    const bridge = createEasiStoreProxy({ upstream, ...options });
    const server = createServer(async (req, res) => { if (!await bridge(req, res)) { res.end('STATIC'); } });
    const base = await listen(server);
    t.after(async () => { await close(server); await close(peer); });
    return { base, received, upstream };
}
const metadata = (res, value) => { res.writeHead(200, { 'Content-Type': 'application/dicom+json', 'Set-Cookie': 'not_forwarded=secret' }); res.end(JSON.stringify(value)); };

test('Store proxy is fixed loopback/read-only and requires explicit local credentials', async t => {
    for (const upstream of ['https://127.0.0.1:8048', 'http://remote.invalid:8048', 'http://u:p@127.0.0.1:8048', 'http://127.0.0.1:8048/path', 'http://127.0.0.1:8048?x=1']) assert.throws(() => createEasiStoreProxy({ upstream }), /loopback/);
    const { base, received } = await fixture(t, (_req, res) => metadata(res, []));
    assert.equal((await fetch(base + '/easi-store/dicomweb/studies')).status, 401);
    assert.equal((await fetch(base + '/easi-store/dicomweb/studies', { method: 'POST', headers: credentials, body: 'not uploaded' })).status, 405);
    assert.equal((await fetch(base + '/easi-store/dicomweb/studies', { headers: { ...credentials, Origin: 'https://foreign.invalid' } })).status, 403);
    assert.equal((await fetch(base + '/easi-store/api/v1/instances', { headers: credentials })).status, 404);
    assert.equal((await fetch(base + '/easi-store/dicomweb/studies/1%2F2/series', { headers: credentials })).status, 404);
    const hostile = await new Promise(resolve => { const req = request(base + '/easi-store/dicomweb/studies', { headers: { ...credentials, Host: 'attacker.invalid' } }, res => { res.resume(); resolve(res.statusCode); }); req.end(); });
    assert.equal(hostile, 403); assert.equal(received.length, 1); assert.equal(received[0].path, '/api/v1/access');
});

test('Store proxy preserves searches and originals, strips unrelated credentials and cookies', async t => {
    const original = Buffer.from([0, 255, 1, 16, 0, 129]);
    const { base, received } = await fixture(t, (req, res) => {
        if (req.url.endsWith('/instances/' + sop)) { res.writeHead(200, { 'Content-Type': 'application/dicom' }); res.end(original); }
        else metadata(res, []);
    });
    const query = new URLSearchParams({ PatientName: 'Synthetic^名前*', includefield: '0020000D,00100020', limit: '25' });
    const response = await fetch(base + '/easi-store/dicomweb/studies?' + query, { headers: { ...credentials, 'X-Private': 'ignored' } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('set-cookie'), null); assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.deepEqual(await response.json(), []);
    assert.equal(received[0].path, '/dicomweb/studies?' + query); assert.equal(received[0].headers.cookie, 'easi_store_session=synthetic_test_session');
    assert.equal(received[0].headers['x-private'], undefined);
    assert.equal(received[0].headers['x-easi-store-public-base'], '/easi-store/dicomweb');
    assert.deepEqual(Buffer.from(await (await fetch(base + '/easi-store/dicomweb' + resource, { headers: credentials })).arrayBuffer()), original);
});

test('metadata bulk URIs stay within authenticated proxy while clinical attributes stay identical', async t => {
    const item = { '00100010': { vr: 'PN', Value: [{ Alphabetic: 'Synthetic^Patient' }] }, '52009230': { vr: 'SQ', Value: [{ '00209113': { vr: 'SQ', Value: [{ '00200032': { vr: 'DS', Value: [0, 0, 2.5] } }] } }] }, '7FE00010': { vr: 'OW', BulkDataURI: '/dicomweb' + resource + '/bulkdata/7FE00010' } };
    const { base } = await fixture(t, (_req, res) => metadata(res, [item]));
    const response = await fetch(base + '/easi-store/dicomweb' + resource + '/metadata', { headers: credentials });
    const actual = (await response.json())[0];
    assert.equal(actual['7FE00010'].BulkDataURI, '/easi-store/dicomweb' + resource + '/bulkdata/7FE00010');
    assert.deepEqual(actual['52009230'], item['52009230']); assert.deepEqual(actual['00100010'], item['00100010']);
});

test('DIMSE bridge checks Store identity per request before invoking its fixed gateway', async t => {
    let authenticated = true, called = 0;
    const { base, received } = await fixture(t, (req, res) => { assert.ok(['/api/v1/session','/api/v1/access'].includes(req.url)); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.url.endsWith('/access') ? {profile:'authenticated',dicomwebAuthenticationRequired:true} : { authenticated, setupRequired: false })); }, {
        dimseFactory: options => {
            assert.equal(options.association.calledAeTitle, 'EASISTORE'); assert.equal(options.association.port, 4248);
            return async (req, res) => { assert.equal(req.url, '/dimse/studies?PatientID=synthetic'); assert.equal(await options.authorize(), true); called++; metadata(res, []); };
        }
    });
    const url = base + '/easi-store/dimse/studies?PatientID=synthetic';
    assert.equal((await fetch(url, { headers: credentials })).status, 200); assert.equal(called, 1);
    authenticated = false;
    assert.equal((await fetch(url, { headers: credentials })).status, 401); assert.equal(called, 1);
    assert.equal(received.length, 3);
});

test('redirects cannot forward Store credentials to another target and failures are sanitized', async t => {
    let secondCalled = false;
    const second = createServer((_req, res) => { secondCalled = true; res.end('unexpected'); }); const destination = await listen(second); t.after(() => close(second));
    const { base } = await fixture(t, (_req, res) => { res.writeHead(302, { Location: destination + '/private' }); res.end(); });
    const response = await fetch(base + '/easi-store/dicomweb/studies', { headers: credentials });
    assert.equal(response.status, 502); assert.equal(secondCalled, false); assert.doesNotMatch(await response.text(), /synthetic_test_session|private/);
});

test('metadata output is bounded', async t => {
    const { base } = await fixture(t, (_req, res) => metadata(res, [{ a: 'x'.repeat(8 * 1024 * 1024) }]));
    const response = await fetch(base + '/easi-store/dicomweb/studies', { headers: credentials });
    assert.equal(response.status, 502);
});

test('the local bridge rejects excess active reads and releases capacity when a reader aborts', async t => {
    let release, started; const gate = new Promise(resolve => { release = resolve; });
    const arrived = new Promise(resolve => { started = resolve; });
    const {base} = await fixture(t, async (_req, res) => { started(); await gate; metadata(res, []); }, {maxConcurrent:1});
    const controller = new AbortController();
    const first = fetch(base + '/easi-store/dicomweb/studies', {headers:credentials, signal:controller.signal}).catch(error=>error);
    await arrived;
    assert.equal((await fetch(base + '/easi-store/dicomweb/studies', {headers:credentials})).status,429);
    controller.abort(); await first;
    await new Promise(resolve=>setTimeout(resolve,30)); release();
    assert.equal((await fetch(base + '/easi-store/dicomweb/studies', {headers:credentials})).status,200);
});

test('sign-in navigation keeps the viewer hostname and fixed configured Store port without forwarding criteria', async t => {
    const {base, upstream, received} = await fixture(t, (_req, res) => metadata(res, []));
    let response = await fetch(base + '/easi-store/sign-in', {redirect: 'manual'});
    assert.equal(response.status, 303); assert.equal(response.headers.get('location'), upstream + '/');
    const localUrl = new URL(base); localUrl.hostname = 'localhost';
    const localResult = await new Promise((resolve,reject) => {
        const req = request(base + '/easi-store/sign-in', {headers: {Host: localUrl.host}}, res => {res.resume();resolve({status:res.statusCode,location:res.headers.location});}); req.on('error',reject);req.end();
    });
    const expected = new URL(upstream); expected.hostname = 'localhost';
    assert.equal(localResult.status,303); assert.equal(localResult.location,expected.href);
    assert.equal((await fetch(base + '/easi-store/sign-in?PatientName=SYNTHETIC', {redirect:'manual'})).status,404);
    assert.equal((await fetch(base + '/easi-store/sign-in',{method:'POST',redirect:'manual'})).status,405);
    assert.equal((await fetch(base + '/easi-store/sign-in',{headers:{Origin:'https://foreign.invalid'},redirect:'manual'})).status,403);
    assert.equal(received.length,0,'sign-in navigation reads no archive data or session');
});

test('explicit local-research policy permits cookie-free DICOMweb and DIMSE, then locks immediately when changed', async t => {
    let research = true, dimseCalls = 0;
    const {base,received} = await fixture(t,(req,res)=>{
        if(req.url==='/api/v1/access') return metadata(res,{profile:research?'local-research':'authenticated',dicomwebAuthenticationRequired:!research});
        assert.equal(req.url,'/dicomweb/studies?PatientName=SYNTHETIC*'); assert.equal(req.headers.cookie,undefined); metadata(res,[]);
    },{dimseFactory:()=>async(_req,res)=>{dimseCalls++;metadata(res,[])}});
    assert.equal((await fetch(base+'/easi-store/dicomweb/studies?PatientName=SYNTHETIC*')).status,200);
    assert.equal((await fetch(base+'/easi-store/dimse/studies?PatientName=SYNTHETIC*')).status,200);assert.equal(dimseCalls,1);
    research=false;
    assert.equal((await fetch(base+'/easi-store/dicomweb/studies?PatientName=SYNTHETIC*')).status,401);
    assert.equal((await fetch(base+'/easi-store/dimse/studies?PatientName=SYNTHETIC*')).status,401);assert.equal(dimseCalls,1);
    assert.equal(received.filter(item=>item.path.startsWith('/dicomweb/')).length,1);
});

test('missing, malformed or inconsistent access policy cannot enable anonymous archive requests', async t => {
    for(const policy of [{},{profile:'authenticated',dicomwebAuthenticationRequired:false},{profile:'local-research',dicomwebAuthenticationRequired:'false'}]) {
        const {base,received}=await fixture(t,(_req,res)=>metadata(res,policy));
        assert.equal((await fetch(base+'/easi-store/dicomweb/studies')).status,401);
        assert.equal(received.length,1);assert.equal(received[0].path,'/api/v1/access');
    }
});
