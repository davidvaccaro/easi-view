import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile, readFile, rm, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { createDicomFixture } from '../src/data/synthetic.js';
import { context as normalizeContext, reference as normalizeReference } from '../src/enterprise/contracts.js';
import { browserSession, delay } from './browser-session.mjs';

// Qualification only: generated imaging data, isolated browser, fixed loopback
// archive and server-enforced identities. This is not a production login server.
const root = resolve(import.meta.dirname, '..'), qa = resolve(root, 'dist/qa-enterprise');
const output = resolve(root, 'artifacts/browser-enterprise');
const target = new URL(process.env.EASI_VIEW_URL || 'http://127.0.0.1:5184/');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname), 'Enterprise checks require a local preview.');
const checks = [], logs = [], credentials = new Map(), sessions = [], shares = new Map(), saved = new Map();
const controls = { contextLayout: 2, contextMode: 'normal', slow: null, slowMs: 1200, denyArchive: false, expiresMs: 60000 };
const quote = JSON.stringify, record = name => { checks.push({ name }); console.log(`PASS ${name}`); };
const key = 'synthetic-primary', sopClass = '1.2.840.10008.5.1.4.1.1.2';
const study = role => `2.25.${role === 'a' ? 980 : 990}`;
const series = (role, variant = 1) => `${study(role)}.${variant}`, sop = (role, index, variant = 1) => `${series(role, variant)}.${index + 1}`;
const forUid = role => `${study(role)}.55`;
const reference = (role, index) => ({ archiveKey: key, studyUid: study(role), seriesUid: series(role), ...(index == null ? {} : { sopUid: sop(role, index) }) });
const attr = (vr, ...Value) => ({ Value, vr }); // Exercise common peers' Value-before-vr order.
const values = (role, index) => Array.from({ length: 6 }, (_, pixel) => (role === 'a' ? 10 : 110) + index * 20 + pixel);
function fixture(role, index, variant = 1) {
    const metadata = {
        '00080016': attr('UI', sopClass), '00080018': attr('UI', sop(role, index, variant)), '00080060': attr('CS', 'CT'),
        '0020000D': attr('UI', study(role)), '0020000E': attr('UI', series(role, variant)), '00200052': attr('UI', forUid(role)),
        '00200013': attr('IS', String(index + 1)), '00200032': attr('DS', '0', '0', String(index * 2)), '00200037': attr('DS', '1', '0', '0', '0', '1', '0'),
        '00280002': attr('US', 1), '00280004': attr('CS', 'MONOCHROME2'), '00280008': attr('IS', '1'),
        '00280010': attr('US', 2), '00280011': attr('US', 3), '00280030': attr('DS', '1', '1'),
        '00280100': attr('US', 16), '00280101': attr('US', 12), '00280102': attr('US', 11), '00280103': attr('US', 0),
        '00281050': attr('DS', '128'), '00281051': attr('DS', '256'), '00281052': attr('DS', '0'), '00281053': attr('DS', '1'),
        '00281054': attr('LO', 'HU'), '00281056': attr('CS', 'LINEAR'),
        '7FE00010': { vr: 'OW', BulkDataURI: 'https://synthetic.invalid/never-followed' }
    };
    const bytes = createDicomFixture({ rows: 2, columns: 3, bitsStored: 12, values: values(role, index),
        modality: 'CT', sopClass, sopUid: sop(role, index, variant), seriesUid: series(role, variant), instanceNumber: index + 1,
        position: [0, 0, index * 2], orientation: [1, 0, 0, 0, 1, 0], pixelSpacing: [1, 1],
        window: { center: 128, width: 256 }, slope: 1, intercept: 0, rescaleType: 'HU',
        extraAttributes: { '0020000D': ['UI', study(role)], '00200052': ['UI', forUid(role)] } });
    return { index, metadata, bytes };
}
const archives = Object.fromEntries(['a', 'b'].map(role => [role, new Map([1, 2, 3].map(variant => [series(role, variant), [2, 0, 1].map(index => fixture(role, index, variant))]))]));
const localBytes = createDicomFixture({ rows: 2, columns: 3, values: [201, 202, 203, 204, 205, 206], bitsStored: 12,
    sopClass, sopUid: '2.25.970.1.1', seriesUid: '2.25.970.1', position: [0, 0, 0], pixelSpacing: [1, 1],
    extraAttributes: { '0020000D': ['UI', '2.25.970'], '00200052': ['UI', '2.25.970.55'] } });
let server, browser, temporary, archiveUrl;
function issue(session, purpose) { const credential = randomBytes(24).toString('base64url'); credentials.set(credential, { session, purpose, revision: ++session.credentialRevision }); return credential; }
function principal(request, purpose) {
    const authorization = request.headers.authorization;
    const supplied = typeof authorization === 'string' && /^Bearer [A-Za-z0-9_-]+$/u.test(authorization) ? credentials.get(authorization.slice(7)) : null;
    const current = supplied?.session;
    if (!current || supplied.purpose !== purpose || current.revoked || current.expiresAt <= Date.now()) return null;
    return supplied;
}
function permitted(current, selected) {
    if (selected.archiveKey !== key || selected.studyUid !== study(current.role) || selected.seriesUid != null && !archives[current.role].has(selected.seriesUid)) return false;
    const grant = current.activeGrant;
    return !grant || !grant.revoked && grant.expiresAt > Date.now() && Object.entries(grant.reference).every(([name, value]) => selected[name] === value);
}
function identity(current) { return { subject: `synthetic-user-${current.role}`, realm: `synthetic-realm-${current.role}`, expiresAt: current.expiresAt }; }
function viewingContext(selected, current) {
    const layout = controls.contextLayout;
    const viewports = Array.from({ length: layout === 1 ? 1 : layout - 1 }, (_, index) => ({ slot: layout === 1 ? 0 : index + 1,
        reference: { ...selected, sopUid: selected.sopUid ?? sop(current.role, index === 0 ? 2 : index - 1) },
        frameIndex: 0, originalFrameNumber: 1, window: { center: 70 + index * 10, width: 200 } }));
    if (controls.contextMode === 'foreign-key') viewports[0].reference.archiveKey = 'unconfigured';
    if (controls.contextMode === 'foreign-study') viewports.push({ slot: 0, reference: reference(current.role === 'a' ? 'b' : 'a', 0), frameIndex: 0, originalFrameNumber: 1 });
    if (controls.contextMode === 'broad-share') viewports.push({ slot: 0, reference: reference(current.role, 0), frameIndex: 0, originalFrameNumber: 1 });
    return { version: 1, layout, activeViewport: layout === 1 ? 0 : 1, viewports };
}
async function body(request) {
    let size = 0, text = '';
    for await (const chunk of request) { size += chunk.length; if (size > 65536) throw new Error('Synthetic backend body limit.'); text += chunk.toString('utf8'); }
    return text ? JSON.parse(text) : null;
}
function json(response, status, value) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); }
function verification(share, current) { return { shareId: share.shareId, ...identity(current), origin: share.origin, expiresAt: share.expiresAt, revoked: share.revoked, permissions: ['view'], reference: share.reference }; }
async function startServer() {
    server = createServer(async (request, response) => {
        response.setHeader('Access-Control-Allow-Origin', target.origin); response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Allow-Headers', 'Accept, Authorization, Content-Type');
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS'); response.setHeader('Cache-Control', 'no-store');
        if (request.headers.origin && request.headers.origin !== target.origin) { json(response, 403, { denied: true }); return; }
        if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
        const url = new URL(request.url, 'http://127.0.0.1'), path = url.pathname;
        const log = { kind: path.startsWith('/dicom-web') ? 'archive' : 'host', method: request.method, status: 0 };
        logs.push(log); response.on('finish', () => { log.status = response.statusCode; });
        response.on('close', () => { if (!response.writableEnded) log.aborted = true; });
        try {
            if (path === '/api/login' && request.method === 'POST') {
                const input = await body(request); if (!['a', 'b'].includes(input?.role)) { json(response, 400, { denied: true }); return; }
                const current = { role: input.role, expiresAt: Date.now() + controls.expiresMs, revoked: false, credentialRevision: 0, activeGrant: null };
                sessions.push(current); log.operation = 'login'; json(response, 200, { identity: identity(current), credential: issue(current, 'host') }); return;
            }
            const supplied = principal(request, path.startsWith('/dicom-web') ? 'archive' : 'host');
            if (!supplied) { log.denied = true; json(response, 401, { denied: true }); return; }
            const current = supplied.session; log.role = current.role; log.credentialRevision = supplied.revision;
            if (path === '/api/current' && request.method === 'GET') { log.operation = 'current'; json(response, 200, identity(current)); return; }
            if (path === '/api/headers' && request.method === 'POST') { const input = await body(request); if (input?.archiveKey !== key) { json(response, 403, { denied: true }); return; }
                if (current.activeGrant && (current.activeGrant.revoked || current.activeGrant.expiresAt <= Date.now())) { log.denied = true; json(response, 403, { denied: true }); return; }
                log.operation = 'headers'; json(response, 200, { credential: issue(current, 'archive') }); return; }
            if (path === '/api/logout' && request.method === 'POST') { log.operation = 'logout'; current.revoked = true; json(response, 200, { signedOut: true }); return; }
            if (path === '/api/worklist' && request.method === 'GET') { log.operation = 'worklist'; json(response, 200, { items: [{ key: `synthetic-${current.role}`, title: 'Generated CT review', modality: 'CT', reference: reference(current.role) }], nextOffset: null }); return; }
            if (path === '/api/study-context' && request.method === 'POST') {
                log.operation = 'open-study'; const selected = normalizeReference(await body(request));
                if (!permitted(current, selected)) { json(response, 403, { denied: true }); return; }
                json(response, 200, viewingContext(selected, current)); return;
            }
            const contextMatch = path.match(/^\/api\/contexts\/([A-Za-z0-9_.:-]+)$/u);
            if (contextMatch && ['PUT', 'GET'].includes(request.method)) {
                log.operation = request.method === 'PUT' ? 'save-context' : 'load-context'; const saveKey = `${current.role}/${contextMatch[1]}`;
                if (request.method === 'PUT') { const context = normalizeContext(await body(request)); if (context.viewports.some(view => !permitted(current, view.reference))) { json(response, 403, { denied: true }); return; }
                    saved.set(saveKey, context); json(response, 200, { saved: true }); }
                else json(response, 200, saved.get(saveKey) ?? null);
                return;
            }
            if (path === '/api/shares' && request.method === 'POST') {
                log.operation = 'create-share'; const input = await body(request), selected = normalizeReference(input.reference);
                if (!permitted(current, selected) || input.viewerOrigin !== target.origin || !Number.isInteger(input.ttlMs) || input.ttlMs < 1000 || input.ttlMs > 86400000) { json(response, 403, { denied: true }); return; }
                const share = { shareId: `share_${shares.size + 1}`, capability: randomBytes(24).toString('base64url'), reference: selected,
                    role: current.role, origin: input.viewerOrigin, expiresAt: Date.now() + input.ttlMs, revoked: false };
                shares.set(share.shareId, share); json(response, 200, { shareId: share.shareId, capability: share.capability }); return;
            }
            if (path === '/api/shares/verify' && request.method === 'POST') {
                log.operation = 'verify-share'; const input = await body(request), share = shares.get(input?.receipt?.shareId);
                if (!share || share.capability !== input.receipt.capability || share.role !== current.role || share.origin !== target.origin ||
                    !['create', 'resolve', 'revoke'].includes(input.operation) || input.operation !== 'revoke' && (share.revoked || share.expiresAt <= Date.now())) { json(response, 403, { denied: true }); return; }
                if (input.operation === 'resolve') current.activeGrant = share;
                json(response, 200, verification(share, current)); return;
            }
            const shareMatch = path.match(/^\/api\/shares\/(share_\d+)$/u);
            if (shareMatch && request.method === 'DELETE') {
                log.operation = 'revoke-share'; const share = shares.get(shareMatch[1]);
                if (!share || share.role !== current.role) { json(response, 403, { denied: true }); return; }
                share.revoked = true; json(response, 200, { shareId: share.shareId, capability: share.capability }); return;
            }
            if (!path.startsWith('/dicom-web') || request.method !== 'GET' || request.headers.cookie) { json(response, 404, { denied: true }); return; }
            log.kind = 'archive';
            const match = path.match(/^\/dicom-web\/studies(?:\/([0-9.]+)(?:\/series(?:\/([0-9.]+)(?:\/(metadata|instances\/([0-9.]+)))?)?)?)?$/u);
            if (!match) { json(response, 404, { denied: true }); return; }
            const requested = { archiveKey: key, studyUid: match[1] ?? study(current.role), ...(match[2] ? { seriesUid: match[2] } : {}), ...(match[4] ? { sopUid: match[4] } : {}) };
            // Series metadata is permitted within a SOP grant; it is still server
            // authorization, never a browser-supplied capability/header decision.
            const metadataScope = current.activeGrant && match[3] === 'metadata' ? { ...requested, sopUid: current.activeGrant.reference.sopUid } : requested;
            if (controls.denyArchive || !permitted(current, metadataScope)) { log.denied = true; json(response, 403, { denied: true }); return; }
            if (!match[1]) { log.operation = 'studies'; json(response, 200, [{ '0020000D': attr('UI', study(current.role)), '00100010': { vr: 'PN' },
                '00080020': attr('DA', '20261014'), '00080061': attr('CS', 'CT'), '00201206': attr('IS', '1'), '00201208': attr('IS', '3') }]); return; }
            if (!match[2]) { log.operation = 'series'; json(response, 200, [{ '0020000D': attr('UI', study(current.role)), '0020000E': attr('UI', series(current.role)),
                '00080060': attr('CS', 'CT'), '00200011': attr('IS', '1'), '00201209': attr('IS', '3') }]); return; }
            const frames = archives[current.role].get(match[2]);
            if (match[3] === 'metadata') { log.operation = 'metadata'; response.writeHead(200, { 'Content-Type': 'application/dicom+json' }); response.end(JSON.stringify(frames.map(frame => frame.metadata))); return; }
            const selected = frames.find(frame => frame.metadata['00080018'].Value[0] === match[4]);
            if (!selected) { json(response, 404, { denied: true }); return; }
            log.operation = 'instance'; log.frame = selected.index;
            if (controls.slow === selected.index) await delay(controls.slowMs);
            if (response.destroyed) return;
            // Recheck authorization after deferred work and before medical bytes.
            if (!principal(request, 'archive') || !permitted(current, requested) || controls.denyArchive) { log.denied = true; json(response, 403, { denied: true }); return; }
            response.writeHead(200, { 'Content-Type': 'application/dicom', 'Content-Length': selected.bytes.byteLength }); response.end(selected.bytes);
        } catch { if (!response.headersSent && !response.destroyed) json(response, 400, { denied: true }); else response.destroy(); }
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done)); archiveUrl = `http://127.0.0.1:${server.address().port}/dicom-web`;
}
const snapshot = () => browser.evaluate('window.__snapshot()');
const contextNow = () => browser.evaluate(`window.__viewer.exportStudyContext({archiveKey:${quote(key)}})`);
const rejected = expression => browser.evaluate(`Promise.resolve().then(()=>${expression}).then(()=>false,()=>true)`);
async function localPane() { await browser.evaluate('window.__viewer.assignViewportSeries(0,0)'); }
async function resetLogin(role = 'a') {
    controls.contextMode = 'normal'; controls.denyArchive = false; controls.slow = null; controls.expiresMs = 60000;
    await browser.evaluate(`window.__role=${quote(role)};window.__enterprise.login()`);
}
async function remoteClear() {
    await browser.until('!window.__enterprise.getState().cleanupPending && !window.__viewer.getState().archive.connected', 'Enterprise clearing did not finish.');
    const current = await snapshot(); assert.equal(current.workspace.viewports[0].assigned, true); assert.equal(current.workspace.viewports.slice(1).some(pane => pane.assigned), false);
    assert.equal(current.performance.resources.encodedCacheBytes, 0); assert.equal(current.performance.resources.reconstructionVolumeBytes, 0); assert.equal(current.performance.resources.reconstructionDerivedBytes, 0);
    assert.equal(current.performance.resources.overlayBytes, 0); assert.equal(current.performance.resources.overlayRenderBytes, 0);
    assert.equal(current.derived.documentCount, 0); return current;
}

try {
    const info = JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8'));
    await mkdir(output, { recursive: true }); await mkdir(qa, { recursive: true }); temporary = await mkdtemp(join(tmpdir(), 'easi-view-enterprise-')); await startServer();
    await writeFile(resolve(qa, 'fixtures.json'), JSON.stringify({ local: Buffer.from(localBytes).toString('base64') }));
    await writeFile(resolve(qa, 'host.css'), 'body{margin:0;background:#090f18}#mount{height:1000px;width:100%}');
    await writeFile(resolve(qa, 'index.html'), '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="host.css"><div id="mount"></div><script type="module" src="host.js"></script>');
    await writeFile(resolve(qa, 'host.js'), `import{createViewer,createEnterpriseViewer}from'../assets/easi-view.js';
const archive=${quote(archiveUrl)},api=${quote(archiveUrl.replace('/dicom-web', '/api'))},key=${quote(key)};let credential=null;window.__role='a';window.__events=[];window.__audits=[];window.__states=[];
async function request(path,{signal,method='GET',body}={}){const response=await fetch(api+path,{method,signal,credentials:'omit',redirect:'error',cache:'no-store',headers:{Accept:'application/json',...(credential?{Authorization:'Bearer '+credential}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});if(!response.ok)throw new Error('Synthetic backend denied the request.');return response.json();}
const identityAdapter={async login({signal}){const result=await request('/login',{signal,method:'POST',body:{role:window.__role}});credential=result.credential;return result.identity;},async logout({signal}){try{return await request('/logout',{signal,method:'POST'});}finally{credential=null;}},current({signal}){return request('/current',{signal});},async getHeaders({url,signal}){if(!url.startsWith(archive+'/'))throw new Error('Archive address is fixed.');const result=await request('/headers',{signal,method:'POST',body:{archiveKey:key}});return{Authorization:'Bearer '+result.credential};}};
const workflowAdapter={list:({signal,offset,limit})=>request('/worklist?offset='+offset+'&limit='+limit,{signal}),openStudy:({signal,reference})=>request('/study-context',{signal,method:'POST',body:reference})};
const persistence={load:({signal,key})=>request('/contexts/'+encodeURIComponent(key),{signal}),save:({signal,key,context})=>request('/contexts/'+encodeURIComponent(key),{signal,method:'PUT',body:context})};
const shareAdapter={create:({signal,reference,ttlMs,viewerOrigin})=>request('/shares',{signal,method:'POST',body:{reference,ttlMs,viewerOrigin}}),verify:({signal,receipt,operation})=>request('/shares/verify',{signal,method:'POST',body:{receipt,operation}}),revoke:({signal,shareId})=>request('/shares/'+encodeURIComponent(shareId),{signal,method:'DELETE'})};
window.__viewer=createViewer(document.getElementById('mount'),{initialDemo:null});for(const kind of['sourcechange','framechange','layoutchange','viewportchange','annotationchange','derivedchange','reconstructionchange','error','dispose'])window.__viewer.on(kind,detail=>window.__events.push({kind,detail}));await window.__viewer.ready;
window.__enterprise=createEnterpriseViewer(window.__viewer,{identityAdapter,archive:{key,baseUrl:archive},workflowAdapter,persistence,shareAdapter,viewerOrigin:location.origin,allowInsecureLoopback:true,audit:event=>window.__audits.push(event),onChange:state=>window.__states.push(state)});
const fixture=await(await fetch('./fixtures.json')).json();window.__local=()=>new File([Uint8Array.from(atob(fixture.local),c=>c.charCodeAt(0))],'synthetic-local-private.dcm',{type:'application/dicom'});window.__snapshot=()=>({viewer:window.__viewer.getState(),workspace:window.__viewer.getWorkspaceState(),performance:window.__viewer.getPerformance(),annotations:window.__viewer.getAnnotationState(),derived:window.__viewer.getDerivedState(),reconstruction:window.__viewer.getReconstructionState(),enterprise:window.__enterprise.getState()});window.__ready=true;`);
    browser = await browserSession(temporary); await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false });
    await browser.send('Page.navigate', { url: new URL('qa-enterprise/index.html', target).href }); await browser.until('window.__ready', 'Enterprise viewer did not mount with its actual SDK exports.');
    assert.equal(logs.length, 0); await browser.evaluate('window.__viewer.openFiles([window.__local()])');
    let current = await snapshot(); assert.equal(current.enterprise.authenticated, false); assert.equal(current.workspace.viewports[0].assigned, true); assert.equal(logs.length, 0);
    assert.equal(await browser.evaluate('localStorage.length+sessionStorage.length'), 0);
    record('actual enterprise SDK construction and local file viewing cause no sign-in, archive query, upload, or browser persistence');

    await resetLogin(); const page = await browser.evaluate('window.__enterprise.listWorklist()'); assert.deepEqual(page.items.map(item => item.reference), [reference('a')]);
    const found = await browser.evaluate('window.__viewer.searchStudies()'); assert.equal(found.items[0].studyUid, study('a'));
    const listed = await browser.evaluate(`window.__viewer.listStudySeries(${quote(study('a'))})`); assert.equal(listed.items[0].seriesUid, series('a'));
    await browser.evaluate(`window.__enterprise.openStudy(${quote(reference('a'))})`); current = await snapshot();
    assert.equal(current.workspace.layout, 2); assert.equal(current.workspace.activeViewport, 1); assert.equal(current.workspace.viewports[1].frameIndex, 2);
    let exported = await contextNow(); assert.equal(exported.viewports[0].reference.sopUid, sop('a', 2)); assert.equal(exported.viewports[0].originalFrameNumber, 1); assert.equal(exported.viewports[0].window.center, 70);
    await localPane(); const archiveLogs = logs.filter(log => log.kind === 'archive' && log.status === 200);
    assert.ok(archiveLogs.length >= 4); assert.equal(new Set(archiveLogs.map(log => log.credentialRevision)).size, archiveLogs.length);
    assert.ok(archiveLogs.every(log => log.role === 'a')); assert.equal(logs.some(log => log.kind === 'archive' && log.method !== 'GET'), false);
    record('backend-authenticated QIDO/WADO rotate request headers and restore the exact SOP/original frame despite reversed metadata and an incorrect navigation hint');

    controls.contextLayout = 4; await browser.evaluate(`window.__enterprise.openStudy(${quote(reference('a'))})`); await localPane();
    current = await snapshot(); assert.equal(current.workspace.layout, 4); assert.deepEqual(current.workspace.viewports.map(pane => pane.frameIndex), [0, 2, 0, 1]);
    await browser.evaluate('window.__enterprise.saveContext("four-pane")'); assert.equal(saved.size, 1);
    exported = await contextNow(); assert.equal(exported.viewports.length, 3); assert.equal(exported.viewports.some(pane => pane.slot === 0), false);
    assert.ok(exported.viewports.every(pane => pane.originalFrameNumber === 1 && pane.reference.archiveKey === key));
    await browser.evaluate('window.__viewer.setActiveViewport(1);window.__viewer.setFrame(0)'); await browser.evaluate('window.__enterprise.restoreContext("four-pane")'); await localPane();
    assert.deepEqual((await contextNow()).viewports, exported.viewports); assert.equal(logs.filter(log => log.operation === 'save-context').length, 1);
    controls.contextLayout = 2; await browser.evaluate(`window.__enterprise.openStudy(${quote(reference('a'))})`); await localPane(); await browser.evaluate('window.__enterprise.saveContext("two-pane")');
    controls.contextLayout = 4; await browser.evaluate(`window.__enterprise.openStudy(${quote(reference('a'))})`); await browser.evaluate('window.__enterprise.restoreContext("two-pane")'); await localPane();
    assert.equal((await snapshot()).workspace.layout, 2);
    record('explicit two/four-pane persistence serializes only authorized archive references/windows and restores original-frame identity without storing local pixels');

    const beforeAccept = await contextNow(), beforeAcceptState = await snapshot();
    const stagedContext = variant => ({ version: 1, layout: 2, activeViewport: 1, viewports: [{ slot: 1,
        reference: { archiveKey: key, studyUid: study('a'), seriesUid: series('a', variant), sopUid: sop('a', 2, variant) }, frameIndex: 0, originalFrameNumber: 1,
        window: { center: 90, width: 240 } }] });
    const immediate = await browser.evaluate(`(async()=>{const controller=new AbortController();let observed=0;const off=window.__viewer.on('sourcechange',()=>{observed++;controller.abort();});try{await window.__viewer.applyStudyContext(${quote(stagedContext(2))},{archiveKey:${quote(key)},signal:controller.signal});return{ok:true,observed};}catch(error){return{ok:false,name:error.name,observed};}finally{off();}})()`);
    assert.equal(immediate.observed, 1); assert.equal(immediate.ok, false); assert.equal(immediate.name, 'AbortError');
    assert.deepEqual(await contextNow(), beforeAccept); assert.equal((await snapshot()).viewer.seriesCount, beforeAcceptState.viewer.seriesCount);
    await browser.evaluate('(async()=>{await window.__viewer.setFrame(1);await window.__viewer.setFrame(2);})()');
    assert.equal((await snapshot()).workspace.viewports[0].assigned, true);
    record('synchronous source-change cancellation rolls back before acceptance and releases only staged sources while prior panes remain navigable');
    const accepted = await browser.evaluate(`(async()=>{const controller=new AbortController();let observed=0;const off=window.__viewer.on('sourcechange',()=>{observed++;queueMicrotask(()=>controller.abort());});try{const result=await window.__viewer.applyStudyContext(${quote(stagedContext(3))},{archiveKey:${quote(key)},signal:controller.signal});return{ok:true,observed,aborted:controller.signal.aborted,result};}catch(error){return{ok:false,name:error.name,observed,aborted:controller.signal.aborted};}finally{off();}})()`);
    assert.equal(accepted.observed, 1); assert.equal(accepted.aborted, true); assert.equal(accepted.ok, true);
    assert.equal((await contextNow()).viewports[0].reference.seriesUid, series('a', 3));
    await browser.evaluate('(async()=>{await window.__viewer.setFrame(1);await window.__viewer.setFrame(0);})()');
    assert.equal((await contextNow()).viewports[0].reference.sopUid, sop('a', 0, 3));
    assert.equal((await snapshot()).enterprise.authenticated, true);
    await browser.evaluate(`window.__enterprise.openStudy(${quote(reference('a'))})`); await localPane();
    record('microtask cancellation after atomic acceptance preserves committed source ownership and subsequent on-demand frame decoding remains live');

    const beforeScope = await contextNow(), beforeRequests = logs.filter(log => log.kind === 'archive').length;
    assert.equal(await rejected(`window.__viewer.applyStudyContext(${quote(beforeScope)},{archiveKey:${quote(key)},scope:${quote(reference('a', 0))}})`), true);
    assert.deepEqual(await contextNow(), beforeScope); assert.equal(logs.filter(log => log.kind === 'archive').length, beforeRequests);
    controls.contextMode = 'foreign-key'; assert.equal(await rejected(`window.__enterprise.openStudy(${quote(reference('a'))})`), true); assert.deepEqual(await contextNow(), beforeScope);
    controls.contextMode = 'foreign-study'; assert.equal(await rejected(`window.__enterprise.openStudy(${quote(reference('a'))})`), true); assert.deepEqual(await contextNow(), beforeScope);
    assert.ok(logs.some(log => log.kind === 'archive' && log.denied)); controls.contextMode = 'normal';
    record('narrow scope and foreign archive references fail before retrieval; server-denied secondary studies leave every previously committed pane intact');

    const receipt = await browser.evaluate(`window.__enterprise.createShare(${quote(reference('a', 2))},{ttlMs:60000})`);
    await browser.evaluate(`window.__enterprise.resolveShare(${quote({ shareId: receipt.shareId, capability: receipt.capability })})`); await localPane();
    assert.ok((await contextNow()).viewports.every(pane => pane.reference.sopUid === sop('a', 2)));
    controls.contextMode = 'broad-share'; const beforeShareRequests = logs.filter(log => log.kind === 'archive').length;
    assert.equal(await rejected(`window.__enterprise.resolveShare(${quote({ shareId: receipt.shareId, capability: receipt.capability })})`), true);
    assert.equal(logs.filter(log => log.kind === 'archive').length, beforeShareRequests); controls.contextMode = 'normal';
    await browser.evaluate(`window.__enterprise.revokeShare(${quote(receipt.shareId)})`); await remoteClear();
    assert.equal((await snapshot()).enterprise.authenticated, false); assert.equal(shares.get(receipt.shareId).revoked, true);
    record('verified SOP-scoped shares cannot broaden through worklist contexts, and revocation clears protected pixels while retaining the local pane');

    await resetLogin(); const serverReceipt = await browser.evaluate(`window.__enterprise.createShare(${quote(reference('a', 2))},{ttlMs:60000})`);
    await browser.evaluate(`window.__enterprise.resolveShare(${quote({ shareId: serverReceipt.shareId, capability: serverReceipt.capability })})`); await localPane();
    shares.get(serverReceipt.shareId).revoked = true;
    assert.equal(await rejected('window.__viewer.searchStudies()'), true); await remoteClear();
    assert.equal((await snapshot()).enterprise.authenticated, false);
    record('server-side grant revocation denies credential refresh and clears already displayed protected pixels without trusting browser capability flags');

    await resetLogin(); controls.contextLayout = 2; await browser.evaluate(`window.__enterprise.openStudy(${quote(reference('a'))})`); await localPane();
    await browser.evaluate('window.__viewer.addAnnotation({id:"local-retained",tool:"length",points:[{x:.5,y:.5},{x:2.5,y:.5}]},{viewport:0});window.__viewer.setActiveViewport(1)');
    await browser.evaluate('(async()=>{await window.__viewer.setFrame(0);window.__viewer.addAnnotation({id:"remote-history",tool:"rectangle",points:[{x:.5,y:.5},{x:2.5,y:1.5}]});window.__viewer.addOverlay({id:"remote-mask",kind:"binary",values:[1,0,1,0,1,0],opacity:1,color:[255,0,0]});await window.__viewer.setFrame(2);})()');
    await browser.evaluate('window.__viewer.openReconstruction({viewport:1})'); assert.ok((await snapshot()).reconstruction.volumeBytes > 0);
    await browser.evaluate('window.__viewer.setReconstruction({maximumSize:16})'); await browser.evaluate('window.__enterprise.logout()'); current = await remoteClear();
    assert.deepEqual(await browser.evaluate('window.__viewer.exportAnnotations().annotations.map(item=>item.id)'), ['local-retained']);
    await browser.evaluate('window.__viewer.undoAnnotations();window.__viewer.redoAnnotations()'); assert.deepEqual(await browser.evaluate('window.__viewer.exportAnnotations().annotations.map(item=>item.id)'), ['local-retained']);
    assert.equal(current.annotations.count, 1); assert.equal(current.reconstruction.open, false); assert.equal(current.derived.overlayCount, 0);
    const localMeasurement = await browser.evaluate('window.__viewer.measureAnnotation("local-retained",{viewport:0})'); assert.equal(localMeasurement.geometry.value, 2);
    record('logout purges past-SOP remote annotation history, masks, reconstructions and encoded caches while a local image and local measurement remain usable');

    await resetLogin(); await browser.evaluate(`window.__enterprise.openStudy(${quote(reference('a'))})`); await localPane();
    controls.slow = 1; await browser.evaluate('window.__viewer.setActiveViewport(1);window.__pending=window.__viewer.setFrame(1).then(()=>({ok:true}),error=>({ok:false,name:error.name}));true');
    for (let index = 0; index < 50 && !logs.some(log => log.operation === 'instance' && log.frame === 1 && log.status === 0); index++) await delay(30);
    assert.ok(logs.some(log => log.operation === 'instance' && log.frame === 1 && log.status === 0));
    await browser.evaluate('window.__enterprise.logout()'); await remoteClear(); await delay(controls.slowMs + 50);
    assert.equal((await snapshot()).workspace.viewports[1].assigned, false); assert.ok(logs.some(log => log.operation === 'instance' && log.frame === 1 && log.aborted)); controls.slow = null;
    record('logout aborts a deferred WADO read promptly and late backend work cannot restore a denied remote pane');

    await resetLogin(); await browser.evaluate(`window.__enterprise.openStudy(${quote(reference('a'))})`); await localPane();
    const activeSession = sessions.at(-1); activeSession.role = 'b';
    assert.equal(await rejected('window.__enterprise.listWorklist()'), true); await remoteClear();
    assert.equal((await snapshot()).enterprise.authenticated, false); await resetLogin('b'); await browser.evaluate(`window.__enterprise.openStudy(${quote(reference('b'))})`); await localPane();
    assert.equal((await contextNow()).viewports[0].reference.studyUid, study('b')); assert.equal(await rejected(`window.__viewer.listStudySeries(${quote(study('a'))})`), true);
    record('same-expiry identity realm changes invalidate existing projections and require explicit sign-in; the new realm cannot read the prior study');

    await browser.evaluate('window.__enterprise.logout()'); await remoteClear(); controls.expiresMs = 2200;
    await browser.evaluate('window.__role="a";window.__enterprise.login()'); await browser.evaluate(`window.__enterprise.openStudy(${quote(reference('a'))})`); await localPane();
    const requestCount = logs.length; await browser.until('!window.__enterprise.getState().authenticated&&!window.__enterprise.getState().cleanupPending', 'Identity expiry did not clear without another request.', 50); await remoteClear();
    assert.equal(logs.length, requestCount); controls.expiresMs = 60000;
    record('identity expiration clears authorized remote data through its timer without an extra archive or workflow request');

    await resetLogin(); await browser.evaluate(`window.__enterprise.openStudy(${quote(reference('a'))})`); await localPane();
    const deniedSession = sessions.at(-1); deniedSession.revoked = true;
    assert.equal(await rejected('window.__viewer.searchStudies()'), true); await remoteClear();
    assert.equal((await snapshot()).enterprise.authenticated, false);
    record('failed credential refresh invalidates the enterprise identity and purges existing remote projections');

    await resetLogin(); await browser.evaluate(`window.__enterprise.openStudy(${quote(reference('a'))})`); await localPane();
    await browser.evaluate('window.__unsubscribeThrow=window.__enterprise.subscribe(()=>{throw new Error("Synthetic observer failure");});window.__unsubscribeReject=window.__enterprise.subscribe(()=>Promise.reject(new Error("Synthetic observer rejection")));window.__enterprise.listWorklist()');
    await browser.evaluate('window.__unsubscribeThrow();window.__unsubscribeReject()');
    await browser.screenshot('enterprise-synthetic'); await copyFile(join(temporary, 'enterprise-synthetic.png'), resolve(output, 'enterprise-synthetic.png'));
    const disposed = await browser.evaluate('window.__enterprise.dispose()'); assert.equal(disposed.disposed, true); await remoteClear();
    assert.equal((await snapshot()).viewer.disposed, false); assert.equal(await browser.evaluate('window.__viewer.measureAnnotation("local-retained",{viewport:0}).geometry.value'), 2);
    assert.equal(await rejected('window.__enterprise.listWorklist()'), true);
    record('observer exceptions are isolated and controller disposal clears its services without disposing the host viewer or its local image');

    const final = await browser.evaluate('(async()=>{window.__viewer.dispose();await window.__viewer.whenDisposed();return{performance:window.__viewer.getPerformance(),events:window.__events,audits:window.__audits,states:window.__states};})()');
    assert.equal(final.performance.resources.workerCount, 0); assert.equal(final.performance.resources.encodedCacheBytes, 0); assert.equal(final.performance.resources.decodedCacheBytes, 0);
    assert.equal(final.performance.resources.overlayRenderBytes, 0); assert.equal(final.performance.resources.cleanupPending, false);
    for (const audit of final.audits) assert.deepEqual(Object.keys(audit).sort(), ['durationMs', 'operation', 'status']);
    const automatic = JSON.stringify({ events: final.events, states: final.states, audits: final.audits });
    assert.ok(!/"(?:patientName|patientId|sopUid|studyUid|seriesUid|frameOfReferenceUid|reference|samples|values|credential|capability|subject|realm)"\s*:/u.test(automatic));
    assert.ok(!/2\.25\.(?:970|980|990)/u.test(automatic));
    assert.equal(await browser.evaluate('localStorage.length+sessionStorage.length'), 0);
    assert.ok(browser.requests.every(request => {
        const url = new URL(request.url); return [target.origin, new URL(archiveUrl).origin].includes(url.origin) && !url.username && !url.password && !/token|capability|authorization|credential/iu.test(url.search);
    }));
    assert.ok(logs.filter(log => log.kind === 'archive').every(log => log.method === 'GET'));
    assert.equal(logs.filter(log => log.method === 'PUT').length, 2); assert.equal(browser.errors.length, 0); assert.equal(browser.consoleErrors.length, 0);
    assert.equal(JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8')).sourceDigest, info.sourceDigest);
    record('default states/audits contain no image identifiers or credentials; there are no local uploads, capability URLs, implicit storage, or remaining owned resources');
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ passed: checks.length, checks, sourceDigest: info.sourceDigest,
        harnessSha256: createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'),
        browserExceptions: 0, consoleErrors: 0, originalImagingFilesUsed: false, uploads: 0, backend: 'Generated, loopback-only, per-request server authorization',
        archiveRequests: logs.filter(log => log.kind === 'archive').length, deniedArchiveRequests: logs.filter(log => log.kind === 'archive' && log.denied).length,
        explicitContextSaves: saved.size, credentialValuesSaved: false, browserProfilesSaved: false }, null, 2) + '\n');
} finally {
    browser?.close(); if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
    if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); await rm(qa, { recursive: true, force: true });
    credentials.clear(); shares.clear(); sessions.length = 0;
}
