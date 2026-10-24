import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceRegistry } from '../src/catalog/SourceRegistry.js';
import { StorageSourceManager, STORAGE_SOURCES_KEY } from '../src/catalog/StorageSourceManager.js';
const origin = 'http://127.0.0.1:5174';
const profile = (overrides = {}) => ({ name: 'Synthetic archive', connection: 'dicomweb', baseUrl: 'https://archive.invalid/dicomweb', authentication: 'none', remember: false, isDefault: false, ...overrides });
const metadata = values => new Response(JSON.stringify(values), { headers: { 'Content-Type': 'application/dicom+json' } });
const syntheticStudy = { '0020000D': { vr: 'UI', Value: ['2.25.918.1'] }, '00100010': { vr: 'PN', Value: [{ Alphabetic: 'SYNTHETIC^PRIVATE' }] } };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function storage() { const values = new Map(), writes = []; return { values, writes, getItem: key => values.get(key) ?? null, setItem(key, value) { values.set(key, value); writes.push(value); }, removeItem(key) { values.delete(key); writes.push(null); } }; }
async function withFetch(fetch, action) { const old = globalThis.fetch; globalThis.fetch = fetch; try { return await action(); } finally { globalThis.fetch = old; } }
function fixture(options = {}, sources = []) { const registry = new SourceRegistry(sources), manager = new StorageSourceManager({ registry, origin, ...options }); return { registry, manager, close() { manager.dispose(); registry.dispose(); } }; }
function connector() {
    const records = new Map(), calls = []; let sequence = 0;
    return { records, calls,
        async available() { calls.push(['available']); return true; },
        async list() { calls.push(['list']); return [...records.values()]; },
        async save(value) { const id = `helper-${++sequence}`, result = { id, name: value.name, remember: value.remember, dimse: { ...value.dimse }, baseUrl: `${origin}/storage-connections/${id}/dimse/` }; calls.push(['save', structuredClone(value)]); records.set(id, result); return result; },
        async remove(id) { calls.push(['remove', id]); records.delete(id); },
        async testEcho(id) { calls.push(['echo', id]); return { ok: true }; } };
}
const dimse = (overrides = {}) => profile({ connection: 'dimse-local', baseUrl: '', dimse: { host: '127.0.0.1', port: 4248, callingAeTitle: 'EASI_VIEW', calledAeTitle: 'EASISTORE' }, ...overrides });

test('managed sources stay private and read-only; explicit bounded tests use their real host authentication', async () => {
    let requests = 0, headers = 0;
    const f = fixture({}, [{ id: 'managed', name: 'Host archive', type: 'dimse', baseUrl: 'https://host.invalid/private-gateway', credentials: 'include', headers: async () => { headers++; return { Authorization: 'Bearer SYNTHETIC-MANAGED-SECRET' }; } }]);
    try {
        await f.manager.load(); assert.equal(headers, 0); assert.equal(requests, 0);
        assert.equal(f.manager.canRemember, false);
        assert.doesNotMatch(JSON.stringify([f.manager.list(), f.manager.getProfile('managed')]), /https|private-gateway|SYNTHETIC|Authorization/);
        await assert.rejects(f.manager.save(profile({ id: 'managed' })), { code: 'MANAGED_SOURCE' });
        await assert.rejects(f.manager.remove('managed'), { code: 'MANAGED_SOURCE' });
        await withFetch(async (url, options) => { requests++; assert.equal(options.credentials, 'include'); assert.equal(options.headers.get('Authorization'), 'Bearer SYNTHETIC-MANAGED-SECRET'); assert.equal(new URL(url).searchParams.get('limit'), '1'); return metadata([syntheticStudy]); }, async () => {
            const result = await f.manager.test('managed'); assert.equal(result.ok, true); assert.match(result.summary, /not tested/);
            assert.doesNotMatch(JSON.stringify(result), /PRIVATE|2\.25|https|SECRET|gateway/);
        });
        assert.equal(headers, 1); assert.equal(requests, 1); assert.equal(f.registry.getState().patientCandidates, 0);
        await f.manager.setDefault('managed'); assert.equal(f.manager.defaultId, 'managed');
    } finally { f.close(); }
});

test('remembered profiles and public descriptors never include credentials; reload requires re-entry without network', async () => {
    const store = storage(), f = fixture({ storage: store }); let calls = 0;
    try {
        await withFetch(async () => { calls++; return metadata([]); }, async () => {
            const saved = await f.manager.save(profile({ authentication: 'bearer', token: 'SYNTHETIC-SECRET', remember: true, isDefault: true }));
            assert.equal(saved.requiresCredentials, false); assert.equal(saved.hasCredentials, true);
            assert.equal(f.manager.defaultId, saved.id);
            const raw = store.getItem(STORAGE_SOURCES_KEY);
            assert.doesNotMatch(raw, /SYNTHETIC-SECRET|token|username|password/);
            assert.doesNotMatch(JSON.stringify([saved, f.manager.list(), f.manager.getProfile(saved.id)]), /SYNTHETIC-SECRET|"token"|"username"|"password"/);
            const restored = fixture({ storage: store });
            try {
                await restored.manager.load(); assert.equal(calls, 0); assert.equal(restored.manager.defaultId, saved.id);
                assert.equal(restored.manager.getProfile(saved.id).requiresCredentials, true);
                const denied = await restored.manager.test(saved.id); assert.equal(denied.ok, false); assert.match(denied.summary, /Re-enter/); assert.equal(calls, 0);
                await restored.manager.save({ ...restored.manager.getProfile(saved.id), token: 'FRESH-SYNTHETIC-SECRET' });
                assert.equal((await restored.manager.test(saved.id)).ok, true);
            } finally { restored.close(); }
        });
    } finally { f.close(); }
});

test('blank secrets survive only an unchanged endpoint and auth identity, with exact cookie semantics', async () => {
    const f = fixture();
    try {
        const bearer = await f.manager.save(profile({ authentication: 'bearer', token: 'ORIGINAL-SYNTHETIC-TOKEN' }));
        await f.manager.save({ ...f.manager.getProfile(bearer.id), name: 'Renamed archive', token: '' });
        await assert.rejects(f.manager.save({ ...f.manager.getProfile(bearer.id), baseUrl: 'https://different.invalid/dicomweb', token: '' }), { code: 'CREDENTIAL_REQUIRED' });
        await assert.rejects(f.manager.save({ ...f.manager.getProfile(bearer.id), authentication: 'basic' }), { code: 'CREDENTIAL_REQUIRED' });
        await withFetch(async (_url, options) => { assert.equal(options.headers.get('Authorization'), 'Bearer ORIGINAL-SYNTHETIC-TOKEN'); assert.equal(options.credentials, 'omit'); return metadata([]); }, () => f.manager.test(bearer.id));
        for (const baseUrl of [`${origin}/dicomweb`, 'https://remote.invalid/dicomweb']) {
            const source = await f.manager.save(profile({ baseUrl, authentication: 'session' }));
            await withFetch(async (_url, options) => { assert.equal(options.credentials, baseUrl.startsWith(origin) ? 'same-origin' : 'include'); return metadata([]); }, () => f.manager.test(source.id));
        }
        const basic = await f.manager.save(profile({ authentication: 'basic', username: 'SYNTHETIC_USER', password: 'PRIVATE-PASSWORD' }));
        await f.manager.save({ ...f.manager.getProfile(basic.id), username: '', password: '' });
        await withFetch(async (_url, options) => { assert.equal(atob(options.headers.get('Authorization').slice(6)), 'SYNTHETIC_USER:PRIVATE-PASSWORD'); return metadata([]); }, () => f.manager.test(basic.id));
        await assert.rejects(f.manager.save({ ...f.manager.getProfile(basic.id), username: 'OTHER', password: '' }), { code: 'CREDENTIAL_REQUIRED' });
        assert.doesNotMatch(JSON.stringify(f.manager.getProfile(basic.id)), /SYNTHETIC_USER|PRIVATE-PASSWORD/);
    } finally { f.close(); }
});

test('credential transport and untrusted profile validation happen before requests or accessors', async () => {
    const f = fixture(); let calls = 0;
    try {
        await withFetch(async () => { calls++; return metadata([]); }, async () => {
            for (const authentication of ['session', 'bearer', 'basic']) await assert.rejects(f.manager.save(profile({ baseUrl: 'http://remote.invalid/dicomweb', authentication, token: 'SYNTHETIC', username: 'SYNTHETIC', password: 'SYNTHETIC' })), { code: 'HTTPS_REQUIRED' });
            for (const baseUrl of ['https://user:PRIVATE@remote.invalid/path', 'https://remote.invalid/path?token=PRIVATE', 'file:///PRIVATE']) {
                await assert.rejects(f.manager.save(profile({ baseUrl })), error => error.code === 'INVALID_URL' && !/PRIVATE|remote.invalid/.test(error.publicMessage));
            }
            const value = profile(); Object.defineProperty(value, 'id', { get() { calls++; throw new Error('PRIVATE'); } });
            await assert.rejects(f.manager.save(value), { code: 'INVALID_PROFILE' });
            await assert.rejects(f.manager.test(value), { code: 'INVALID_PROFILE' });
            assert.equal(calls, 0);
            const local = await f.manager.save(profile({ baseUrl: 'http://127.0.0.1:8048/dicomweb', authentication: 'bearer', token: 'SYNTHETIC' })); assert.ok(local.id);
        });
    } finally { f.close(); }
});

test('local DIMSE unsaved tests use an ephemeral helper and never retarget or persist an existing live peer', async () => {
    const helper = connector(), store = storage(), f = fixture({ connector: helper, storage: store });
    try {
        const source = await f.manager.save(dimse({ remember: true })), existingId = [...helper.records.keys()][0], before = store.getItem(STORAGE_SOURCES_KEY);
        const existing = structuredClone(helper.records.get(existingId));
        const result = await withFetch(async url => { assert.match(new URL(url).pathname, /helper-2\/dimse\/studies$/); return metadata([]); }, () => f.manager.test({ ...f.manager.getProfile(source.id), dimse: { ...f.manager.getProfile(source.id).dimse, port: 4444 }, remember: true }));
        assert.equal(result.ok, true); assert.equal(helper.records.size, 1); assert.deepEqual(helper.records.get(existingId), existing);
        assert.equal(store.getItem(STORAGE_SOURCES_KEY), before);
        const testSave = helper.calls.filter(call => call[0] === 'save')[1][1]; assert.equal(testSave.remember, false); assert.equal(testSave.connectorId, undefined);
        assert.deepEqual(helper.calls.find(call => call[0] === 'echo'), ['echo', 'helper-2']);
        assert.equal(f.registry.getState().patientCandidates, 0);
        await f.manager.save({ ...f.manager.getProfile(source.id), dimse: { ...existing.dimse, port: 4555 } });
        assert.equal(helper.records.size, 1); assert.equal(helper.records.has(existingId), false);
        assert.equal([...helper.records.values()][0].dimse.port, 4555);
        assert.equal(helper.calls.filter(call => call[0] === 'save')[2][1].connectorId, undefined);
    } finally { f.close(); }
});

test('local profiles restore from helper configuration without PACS requests; invalid persistence stays recoverable', async () => {
    const helper = connector(), store = storage(), f = fixture({ connector: helper, storage: store });
    const source = await f.manager.save(dimse({ remember: true, isDefault: true })); f.close();
    let fetches = 0; const restored = fixture({ connector: helper, storage: store });
    try {
        await withFetch(async () => { fetches++; return metadata([]); }, async () => { await restored.manager.load(); });
        assert.equal(fetches, 0); assert.equal(helper.calls.filter(call => call[0] === 'echo').length, 0);
        assert.equal(restored.manager.defaultId, source.id); assert.equal(restored.manager.getProfile(source.id).connection, 'dimse-local');
    } finally { restored.close(); }
    for (const raw of ['not json PRIVATE', 'X'.repeat(65537), JSON.stringify({ version: 1, profiles: [profile({ id: 'bad', remember: true, token: 'PRIVATE' })] })]) {
        store.values.set(STORAGE_SOURCES_KEY, raw); const broken = fixture({ storage: store });
        try { await broken.manager.load(); assert.equal(broken.manager.list().length, 0); assert.ok(broken.manager.warnings.length); assert.doesNotMatch(JSON.stringify(broken.manager.warnings), /PRIVATE/); } finally { broken.close(); }
    }
});

test('in-use guards are checked again after local helper creation; a rejected edit preserves old target and credentials', async () => {
    const helper = connector(); let allowed = true, calls = 0;
    const f = fixture({ connector: helper, canChange: () => { calls++; return allowed; } });
    try {
        const source = await f.manager.save(dimse()), old = [...helper.records.values()][0];
        const save = helper.save; helper.save = async value => { const result = await save(value); allowed = false; return result; };
        await assert.rejects(f.manager.save({ ...f.manager.getProfile(source.id), dimse: { ...old.dimse, port: 5555 } }), { code: 'SOURCE_IN_USE' });
        assert.equal(calls, 2); assert.equal(helper.records.size, 1); assert.deepEqual(helper.records.get(old.id), old);
        assert.equal(f.manager.getProfile(source.id).dimse.port, 4248);
        const before = helper.calls.length; await assert.rejects(f.manager.remove(source.id), { code: 'SOURCE_IN_USE' }); assert.equal(helper.calls.length, before);
    } finally { f.close(); }
});

test('tests sanitize failures, bound concurrency and timing, and never retain patient metadata', async () => {
    const f = fixture({ testTimeoutMs: 10 });
    try {
        for (const status of [401, 403, 502]) {
            const result = await withFetch(async () => new Response('PRIVATE https://secret.invalid?token=PRIVATE', { status }), () => f.manager.test(profile()));
            assert.equal(result.ok, false); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|secret.invalid/);
        }
        const malformed = await withFetch(async () => metadata({ unexpected: 'PRIVATE' }), () => f.manager.test(profile())); assert.match(malformed.summary, /malformed/);
        await withFetch(async () => new Promise(() => {}), async () => {
            const a = new AbortController(), b = new AbortController();
            const first = f.manager.test(profile(), { signal: a.signal }), second = f.manager.test(profile(), { signal: b.signal });
            const rejected = [assert.rejects(first, { name: 'AbortError' }), assert.rejects(second, { name: 'AbortError' })];
            assert.equal((await f.manager.test(profile())).ok, false); a.abort(); b.abort(); await Promise.all(rejected);
            const timed = await f.manager.test(profile()); assert.equal(timed.ok, false); assert.match(timed.summary, /timed out/);
        });
        assert.equal(f.registry.getState().patientCandidates, 0);
        await assert.rejects(f.manager.test('unknown'), { code: 'UNKNOWN_SOURCE' });
    } finally { f.close(); }
});

test('removal and disposal cancel tests and purge only owned connection state, keeping managed sources', async () => {
    const store = storage(), f = fixture({ storage: store }, [{ id: 'managed', name: 'Managed', type: 'dicomweb', baseUrl: 'https://managed.invalid' }]);
    const source = await f.manager.save(profile({ remember: true, isDefault: true }));
    await withFetch(async () => new Promise(() => {}), async () => {
        const pending = f.manager.test(source.id), rejected = assert.rejects(pending, { name: 'AbortError' }); await tick(); await f.manager.remove(source.id); await rejected;
    });
    assert.equal(f.manager.defaultId, null); assert.equal(store.getItem(STORAGE_SOURCES_KEY), null); assert.deepEqual(f.manager.list().map(source => source.id), ['managed']);
    const privateSource = await f.manager.save(profile({ authentication: 'bearer', token: 'PRIVATE-SYNTHETIC' }));
    const oldClient = f.registry.getClient(privateSource.id); f.manager.dispose();
    await assert.rejects(oldClient.searchStudies(), { name: 'AbortError' }); assert.deepEqual(f.registry.list().map(source => source.id), ['managed']); f.registry.dispose();
});

test('failed persistence leaves the registry unchanged and removes a newly created local helper record', async () => {
    const helper = connector(), store = storage(); store.setItem = () => { throw new Error('PRIVATE quota detail'); };
    const f = fixture({ connector: helper, storage: store });
    try {
        await assert.rejects(f.manager.save(dimse({ remember: true })), error => error.code === 'STORAGE_UNAVAILABLE' && !/PRIVATE/.test(error.publicMessage));
        assert.equal(f.registry.list().length, 0); assert.equal(helper.records.size, 0);
        const transient = await f.manager.save(profile()); assert.ok(transient.id);
    } finally { f.close(); }
});

test('default-first ordering remains stable and a rejected registry commit rolls remembered settings back', async () => {
    const helper=connector(),store=storage(),f=fixture({connector:helper,storage:store},[{id:'managed',name:'Managed',type:'dicomweb',baseUrl:'https://managed.invalid'}]);
    try {
        const source=await f.manager.save(profile({remember:true}));await f.manager.setDefault(source.id);
        assert.deepEqual(f.manager.list().map(item=>item.id),[source.id,'managed']);
        const before=store.getItem(STORAGE_SOURCES_KEY),original=helper.save;
        helper.save=async value=>{const target=await original(value);f.registry.add({id:'collision',name:'Independent host source',type:'dicomweb',baseUrl:'https://host.invalid'});return target;};
        await assert.rejects(f.manager.save(dimse({id:'collision',remember:true})),{code:'SAVE_FAILED'});
        assert.equal(store.getItem(STORAGE_SOURCES_KEY),before);assert.equal(helper.records.size,0);
        assert.equal(f.manager.getProfile('collision').managed,true);assert.equal(f.manager.defaultId,source.id);
    } finally {f.close();}
});

test('a noncooperative cleanup cannot hold connection results beyond the bounded cleanup grace', async () => {
    const helper=connector(),f=fixture({connector:helper,cleanupTimeoutMs:5});let timer;
    helper.remove=async id=>{helper.calls.push(['remove',id]);helper.records.delete(id);return new Promise(()=>{});};
    try {
        await withFetch(async()=>metadata([]),async()=>{
            const result=await Promise.race([f.manager.test(dimse()),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Connection cleanup did not finish within its bound.')),1000);})]);
            assert.equal(result.ok,true);assert.equal(helper.records.size,0);assert.match(f.manager.warnings.join(' '),/background/);
        });
    } finally {clearTimeout(timer);f.close();}
});

test('canceled late helper creations are cleaned without issuing a PACS query or committing a source', async () => {
    const helper=connector(),f=fixture({connector:helper});let finish;
    helper.save=()=>new Promise(resolve=>{finish=resolve;});
    const abort=new AbortController();
    try {
        const pending=f.manager.test(dimse(),{signal:abort.signal}),rejected=assert.rejects(pending,{name:'AbortError'});
        abort.abort();await rejected;
        helper.records.set('late',{id:'late'});finish({id:'late',baseUrl:`${origin}/storage-connections/late/dimse/`});await tick();
        assert.equal(helper.records.size,0);assert.equal(f.registry.list().length,0);assert.equal(helper.calls.filter(call=>call[0]==='echo').length,0);
    } finally {f.close();}
});

test('host replacement cancels a managed-source test instead of returning a stale connection result', async () => {
    const f=fixture({},[{id:'managed',name:'Managed',type:'dicomweb',baseUrl:'https://managed.invalid'}]);
    try {
        await withFetch(async()=>new Promise(()=>{}),async()=>{
            const pending=f.manager.test('managed'),rejected=assert.rejects(pending,{name:'AbortError'});await tick();
            f.registry.replace({id:'managed',name:'Replacement',type:'dicomweb',baseUrl:'https://replacement.invalid'});await rejected;
        });
    } finally {f.close();}
});
