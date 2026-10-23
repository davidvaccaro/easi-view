import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDicomFixture } from '../src/data/synthetic.js';
import { browserSession, delay } from './browser-session.mjs';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'artifacts/browser-archive');
const qa = resolve(root, 'dist/qa');
const target = new URL(process.env.EASI_VIEW_URL || 'http://127.0.0.1:5174/');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname), 'Archive browser checks require an isolated local preview.');
const checks = [];
const record = (name, detail = {}) => { checks.push({ name, ...detail }); console.log(`PASS ${name}`); };
const quote = JSON.stringify;
const uid = '1.2.826.0.1.3680043.10.543.998';
const studyUid = `${uid}.1`, seriesUid = `${uid}.1.1`, badSeriesUid = `${uid}.1.2`;
const sopClass = '1.2.840.10008.5.1.4.1.1.2';
const jsonAttribute = (vr, ...Value) => ({ vr, Value });
const descriptors = Array.from({ length: 6 }, (_, index) => ({
    '00080016': jsonAttribute('UI', sopClass), '00080018': jsonAttribute('UI', `${uid}.1.1.${index + 1}`),
    '00080060': jsonAttribute('CS', 'CT'), '0008103E': jsonAttribute('LO', 'Synthetic archive stack'),
    '0020000D': jsonAttribute('UI', studyUid), '0020000E': jsonAttribute('UI', seriesUid),
    '00200013': jsonAttribute('IS', String(index + 1)), '00200032': jsonAttribute('DS', 0, 0, index),
    '00200037': jsonAttribute('DS', 1, 0, 0, 0, 1, 0),
    '00280002': jsonAttribute('US', 1), '00280004': jsonAttribute('CS', 'MONOCHROME2'),
    '00280008': jsonAttribute('IS', '1'), '00280010': jsonAttribute('US', 2), '00280011': jsonAttribute('US', 2),
    '00280030': jsonAttribute('DS', .75, .75), '00280100': jsonAttribute('US', 8),
    '00280101': jsonAttribute('US', 8), '00280102': jsonAttribute('US', 7), '00280103': jsonAttribute('US', 0),
    '00281050': jsonAttribute('DS', 128), '00281051': jsonAttribute('DS', 256),
    '00281052': jsonAttribute('DS', 0), '00281053': jsonAttribute('DS', 1),
    '00281054': jsonAttribute('LO', 'HU'), '00281056': jsonAttribute('CS', 'LINEAR'),
    '7FE00010': { vr: 'OB', BulkDataURI: 'not-followed-by-viewer' }
}));
const dicoms = descriptors.map((metadata, index) => createDicomFixture({
    rows: 2, columns: 2, bitsAllocated: 8, bitsStored: 8,
    values: [17 + index * 10, 31, 129, 201], window: { center: 128, width: 256 },
    sopUid: metadata['00080018'].Value[0], seriesUid, position: [0, 0, index], instanceNumber: index + 1,
    extraAttributes: { '0020000D': ['UI', studyUid] }
}));
const studies = Array.from({ length: 3 }, (_, index) => ({
    '0020000D': jsonAttribute('UI', index ? `${uid}.${index + 1}` : studyUid),
    '00080020': jsonAttribute('DA', '20261013'), '00080061': jsonAttribute('CS', 'CT'),
    '00081030': jsonAttribute('LO', `Synthetic QA study ${index + 1}`),
    '00100010': index === 1 ? {vr:'PN'} : index === 2 ? {vr:'PN',Value:[]} : { vr: 'PN', Value: [{ Alphabetic: 'SYNTHETIC^ARCHIVE' }] },
    '00100020': jsonAttribute('LO', `SYNTHETIC-${index + 1}`),
    '00201206': jsonAttribute('IS', '2'), '00201208': jsonAttribute('IS', '6')
}));
const series = [seriesUid, badSeriesUid].map((value, index) => ({
    '0020000D': jsonAttribute('UI', studyUid), '0020000E': jsonAttribute('UI', value),
    '00080060': jsonAttribute('CS', 'CT'), '0008103E': jsonAttribute('LO', index ? 'Synthetic unsupported color' : 'Synthetic archive stack'),
    '00200011': jsonAttribute('IS', String(index + 1)), '00201209': jsonAttribute('IS', index ? '1' : '6')
}));
const requests = [];
const options = { slowIndex: 3, delay: 500, failMetadata: false };
let browser, server;
const summarize = () => requests.map(({ type, index, offset, limit, aborted, authorized }) => ({ type, ...(index == null ? {} : { index }), ...(offset == null ? {} : { offset, limit }), ...(aborted ? { aborted } : {}), ...(authorized == null ? {} : { authorized }) }));
const requestCount = type => requests.filter(request => request.type === type).length;
const startArchive = async () => {
    server = createServer(async (request, response) => {
        response.setHeader('Access-Control-Allow-Origin', target.origin);
        response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Accept, X-QA-Auth');
        response.setHeader('Access-Control-Expose-Headers', 'Content-Length');
        response.setHeader('Cache-Control', 'no-store');
        if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
        const url = new URL(request.url, 'http://127.0.0.1');
        const protectedRoute = url.pathname.startsWith('/auth-web/');
        const path = url.pathname.replace(/^\/(?:dicom-web|auth-web)\/?/, '');
        const authorized = protectedRoute ? request.headers['x-qa-auth'] === 'synthetic-qa-only' : undefined;
        if (protectedRoute && !authorized) { requests.push({ type: 'auth', authorized }); response.writeHead(401); response.end('Synthetic private response body must not be echoed.'); return; }
        const sendJson = (status, data) => { response.writeHead(status, { 'Content-Type': 'application/dicom+json' }); response.end(JSON.stringify(data,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)&&typeof value.vr==='string'?{...Object.fromEntries(Object.entries(value).filter(([key])=>key!=='vr')),vr:value.vr}:value)); };
        if (path === 'studies') {
            const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 25);
            const log = { type: 'studies', offset, limit, authorized }; requests.push(log);
            const patientId = url.searchParams.get('PatientID') || url.searchParams.get('00100020');
            if (patientId === 'ERROR') { response.writeHead(503); response.end('Synthetic private response body must not be echoed.'); return; }
            if (patientId === 'EMPTY') { sendJson(200, []); return; }
            const catalog = patientId === 'PAGE' ? Array.from({length:45},(_,index)=>({...studies[index % studies.length], '0020000D':jsonAttribute('UI',`${uid}.2.${index + 1}`)})) : studies;
            sendJson(200, catalog.slice(offset, offset + limit)); return;
        }
        const match = path.match(/^studies\/([^/]+)\/series(?:\/([^/]+)(?:\/(metadata|instances)(?:\/([^/]+))?)?)?$/);
        if (!match) { response.writeHead(404); response.end(); return; }
        const [, requestedStudy, requestedSeries, action, sop] = match;
        if (!requestedSeries) {
            const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 25);
            requests.push({ type: 'series', offset, limit, authorized });
            sendJson(200, requestedStudy === studyUid ? series.slice(offset, offset + limit) : []); return;
        }
        if (action === 'metadata') {
            requests.push({ type: 'metadata', authorized });
            if (options.failMetadata) { response.writeHead(503); response.end('Synthetic private response body must not be echoed.'); return; }
            sendJson(200, requestedSeries === badSeriesUid ? [{ ...descriptors[0], '0020000E': jsonAttribute('UI', badSeriesUid), '00280004': jsonAttribute('CS', 'RGB') }] : descriptors); return;
        }
        if (action === 'instances' && !sop) { requests.push({ type: 'instances', authorized }); sendJson(200, descriptors); return; }
        if (action === 'instances' && sop) {
            const index = descriptors.findIndex(metadata => metadata['00080018'].Value[0] === sop);
            const log = { type: 'retrieve', index, authorized, acceptsOriginalSyntax: /transfer-syntax=\*/.test(request.headers.accept || '') };
            requests.push(log);response.on('close', () => { if (!response.writableEnded) log.aborted = true; });
            if (index === options.slowIndex) await delay(options.delay);
            if (response.destroyed) return;
            if (index < 0) { response.writeHead(404); response.end(); return; }
            const boundary = 'EASI-SYNTHETIC-QA';
            const head = Buffer.from(`--${boundary}\r\nContent-Type: application/dicom; transfer-syntax=1.2.840.10008.1.2.1\r\n\r\n`);
            const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
            const payload = Buffer.concat([head, Buffer.from(dicoms[index]), tail]);
            response.writeHead(200, { 'Content-Type': `multipart/related; type="application/dicom"; boundary=${boundary}`, 'Content-Length': payload.length });
            response.end(payload); return;
        }
        response.writeHead(404);response.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}/dicom-web/`;
};
const run = expression => browser.evaluate(`(async () => { ${expression} })()`);
const click = selector => browser.evaluate(`document.querySelector(${quote(selector)}).click()`);
const ready = (count = 6) => browser.until(`document.getElementById('error-banner').hidden && Number(document.getElementById('detail-frames').textContent)===${count} && !document.getElementById('image-stage').classList.contains('frame-loading') && document.getElementById('viewport-loading').hidden`, 'Synthetic archive images did not become ready.');
const state = () => browser.evaluate(`(() => ({status:document.getElementById('status-text').textContent,error:!document.getElementById('error-banner').hidden,errorMessage:document.getElementById('error-message').textContent,frame:Number(document.getElementById('frame-number').textContent),frames:Number(document.getElementById('detail-frames').textContent),source:document.getElementById('source-badge').textContent,upload:window.__qaUploads?.at(-1)??null}))()`);
const slide = async index => {
    await browser.evaluate(`(()=>{const slider=document.getElementById('frame-slider');slider.value=${index};slider.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await browser.until(`Number(document.getElementById('frame-number').textContent)===${index + 1} && !document.getElementById('image-stage').classList.contains('frame-loading')`, 'Archive frame navigation did not commit.');
};

try {
    await mkdir(output, { recursive: true });
    await mkdir(qa, { recursive: true });
    const archiveUrl = await startArchive();
    await writeFile(resolve(qa, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="./host.css"></head><body><main id="mount"></main><script type="module" src="./bootstrap.js"></script></body></html>');
    await writeFile(resolve(qa,'host.css'),'body{margin:0}#mount{width:100%;height:800px}');
    await writeFile(resolve(qa, 'bootstrap.js'), `
import { createViewer } from '../assets/easi-view.js';
const q=window.__qa={headersCalls:0,events:[]};
q.viewer=createViewer(document.getElementById('mount'),{ui:{library:true}});
q.root=document.getElementById('mount').querySelector('easi-view-embed').shadowRoot;
q.configure=url=>q.viewer.configureArchive({baseUrl:url,headers:async()=>{q.headersCalls++;return{'X-QA-Auth':'synthetic-qa-only'};}});
for(const type of ['sourcechange','framechange','error'])q.viewer.on(type,detail=>q.events.push({type,detail}));
await q.viewer.ready;q.ready=true;
`);
    browser = await browserSession(output);
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await browser.send('Page.navigate', { url: target.href });
    await browser.until(`document.getElementById('status-text')?.textContent.includes('ready') && document.getElementById('viewport-empty')?.hidden`, 'Initial synthetic study did not become ready.');
    assert.equal(requests.length, 0, 'Mounting and local demo viewing must not contact any archive.');
    record('standalone mounting and synthetic viewing make no archive requests');
    await browser.evaluate(`window.__qaUploads=[];const gl=document.getElementById('image-canvas').getContext('webgl2');const upload=gl.texImage2D.bind(gl);gl.texImage2D=(...args)=>{const s=args[8];if(s?.length)window.__qaUploads.push({rows:args[4],columns:args[3],first:Array.from(s.slice(0,4))});return upload(...args);};`);

    // Standalone UI selectors are kept here alongside its actual interaction contract.
    await browser.evaluate(`document.getElementById('open-archive').click();document.getElementById('archive-base-url').value=${quote(archiveUrl)};document.getElementById('archive-connect-form').requestSubmit();`);
    await browser.until(`document.querySelectorAll('[data-study-uid]').length>0`, 'Archive connection and QIDO study search did not return synthetic studies.');
    await click('[data-study-uid]');
    await browser.until(`document.querySelectorAll('[data-series-uid]').length>0`, 'Selecting a study did not list its series.');
    const beforeOpen = requestCount('retrieve');
    assert.equal(beforeOpen, 0, 'Querying studies and series must not fetch pixels.');
    await click('[data-series-uid]');await ready();
    assert.equal(requestCount('metadata'), 1);
    assert.equal(requestCount('retrieve'), 1);
    assert.equal(requests.find(item=>item.type==='retrieve').index, 0);
    assert.equal(requests.find(item=>item.type==='retrieve').acceptsOriginalSyntax, true);
    assert.deepEqual((await state()).upload.first, [17, 31, 129, 201]);
    record('UI study and series browsing fetches metadata first, then only the first selected native instance');

    await slide(5);
    assert.deepEqual((await state()).upload.first,[67,31,129,201]);
    assert.deepEqual(requests.filter(item=>item.type==='retrieve').map(item=>item.index),[0,5]);
    await slide(0);assert.equal(requestCount('retrieve'),2);
    record('distant-frame navigation fetches just its instance and reuses the previously cached image');

    const slowStart=requestCount('retrieve');
    await browser.evaluate(`(()=>{const s=document.getElementById('frame-slider');s.value=3;s.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    for(let i=0;i<50&&requestCount('retrieve')===slowStart;i++)await delay(20);
    await slide(1);await delay(options.delay+50);
    assert.equal((await state()).frame,2);
    assert.equal(requests.filter(item=>item.type==='retrieve'&&item.index===3).at(-1).aborted,true);
    assert.deepEqual((await state()).upload.first,[27,31,129,201]);
    record('rapid seeking aborts a superseded retrieval and commits only the final selected image');

    const prior=await state();
    await click(`[data-series-uid="${badSeriesUid}"]`);
    await browser.until(`!document.getElementById('error-banner').hidden`,'Unsupported archive replacement did not report its profile.');
    const failed=await state();assert.equal(failed.frame,prior.frame);assert.deepEqual(failed.upload.first,prior.upload.first);
    await click('#dismiss-error');
    record('unsupported replacement archive series preserves the previously committed image');
    await browser.screenshot('desktop-archive');

    await browser.evaluate(`document.getElementById('archive-patient-id').value='PAGE';document.getElementById('archive-search-form').requestSubmit();`);
    await browser.until(`!document.getElementById('archive-study-next').disabled && document.querySelectorAll('[data-study-uid]').length>0`, 'Paged archive search did not enable its next-page action.');
    const pagesBefore=requestCount('studies');await click('#archive-study-next');
    await browser.until(`!document.getElementById('archive-study-prev').disabled`, 'The next study page did not become navigable.');
    assert.equal(requestCount('studies'),pagesBefore+1);assert.ok(requests.filter(item=>item.type==='studies').at(-1).offset>0);
    await click('#archive-study-prev');
    await browser.until(`document.getElementById('archive-study-prev').disabled`, 'The previous study page did not return to page one.');
    await browser.evaluate(`document.getElementById('archive-patient-id').value='EMPTY';document.getElementById('archive-search-form').requestSubmit();`);
    await browser.until(`document.querySelectorAll('[data-study-uid]').length===0 && !document.getElementById('archive-message').textContent.includes('Searching')`, 'Empty UI search did not clear prior study records.');
    await browser.evaluate(`document.getElementById('archive-patient-id').value='';document.getElementById('archive-search-form').requestSubmit();`);
    await browser.until(`document.querySelectorAll('[data-study-uid]').length===3`, 'The prior successful UI query did not recover its result scope.');
    await browser.evaluate(`document.getElementById('archive-patient-id').value='ERROR';document.getElementById('archive-search-form').requestSubmit();`);
    await browser.until(`!document.getElementById('archive-error').hidden`, 'UI query error did not become visible.');
    assert.match(await browser.evaluate(`document.getElementById('archive-error').textContent`),/503/);
    assert.equal(await browser.evaluate(`document.querySelectorAll('[data-study-uid],[data-series-uid]').length`),0,'A failed new query must not show old results as though they match its filters.');
    assert.doesNotMatch(await browser.evaluate(`document.getElementById('archive-error').textContent`),/private response|PatientID|ERROR|127\.0\.0\.1/);
    assert.deepEqual((await state()).upload.first,prior.upload.first);
    record('standalone pagination, empty searches, and sanitized query errors preserve the displayed image');
    await browser.evaluate(`document.getElementById('archive-patient-id').value='';document.getElementById('archive-search-form').requestSubmit();`);
    await browser.until(`document.querySelectorAll('[data-study-uid]').length===3 && document.getElementById('archive-error').hidden`, 'The archive study list did not recover after its query error.');
    await browser.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
    await click('#open-archive');await delay(100);
    const mobile=await browser.evaluate(`(()=>{const panel=document.getElementById('library-panel').getBoundingClientRect();const input=document.getElementById('archive-base-url').getBoundingClientRect();return{width:innerWidth,documentWidth:document.documentElement.scrollWidth,panelRight:panel.right,inputRight:input.right,panelWidth:panel.width};})()`);
    assert.ok(mobile.documentWidth<=mobile.width);assert.ok(mobile.panelRight<=mobile.width+1);assert.ok(mobile.inputRight<=mobile.panelRight);
    await browser.screenshot('mobile-archive');
    record('archive connection and search controls fit a 390px mobile viewport');
    await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});

    await browser.send('Page.navigate',{url:new URL('qa/index.html',target).href});
    await browser.until('window.__qa?.ready','SDK archive QA mount did not become ready.');
    const authUrl=archiveUrl.replace('/dicom-web/','/auth-web/');
    await run(`await window.__qa.configure(${quote(authUrl)});return true;`);
    assert.equal((await run('return window.__qa.viewer.getState();')).frameCount,0);
    const beforeInvalid=requests.length;
    for(const call of ['searchStudies({},null)','searchStudies({},{signal:42})','listStudySeries('+quote(studyUid)+',null)','listStudySeries('+quote(studyUid)+',{signal:42})']){
        const rejected=await run(`try{await window.__qa.viewer.${call};return{rejected:false};}catch(error){return{rejected:true,message:error.message,state:window.__qa.viewer.getState()};}`);
        assert.equal(rejected.rejected,true);assert.equal(rejected.state.archive.searching,false);
    }
    assert.equal(requests.length,beforeInvalid,'Invalid host query options must not contact the archive.');
    const canceled=await run(`const controller=new AbortController();controller.abort();try{await window.__qa.viewer.searchStudies({},{signal:controller.signal});return{rejected:false};}catch(error){return{rejected:error.name==='AbortError',state:window.__qa.viewer.getState(),message:document.querySelector('easi-view-embed').shadowRoot.getElementById('archive-message').textContent};}`);
    assert.equal(canceled.rejected,true);assert.equal(canceled.state.archive.searching,false);assert.match(canceled.message,/canceled/);
    assert.equal(requests.length,beforeInvalid,'An already canceled query must not contact the archive.');
    record('invalid and canceled host queries leave no requests or stuck archive search indicator');
    let page=await run(`return window.__qa.viewer.searchStudies({}, {limit:2,offset:0});`);
    assert.equal(page.items.length,2);assert.equal(page.hasMore,true);
    page=await run(`return window.__qa.viewer.searchStudies({}, {limit:2,offset:2});`);
    assert.equal(page.items.length,1);assert.equal(page.hasMore,false);
    assert.equal(requests.filter(item=>item.type==='studies'&&item.authorized).length,2);
    const empty=await run(`return window.__qa.viewer.searchStudies({patientId:'EMPTY'},{limit:2});`);
    assert.equal(empty.items.length,0);
    const failure=await run(`try{await window.__qa.viewer.searchStudies({patientId:'ERROR'});return{rejected:false};}catch(error){return{rejected:true,message:error.message};}`);
    assert.equal(failure.rejected,true);assert.match(failure.message,/503/);assert.doesNotMatch(failure.message,/private response|PatientID|ERROR|synthetic-qa-only|127\.0\.0\.1/);
    assert.ok(await run('return window.__qa.headersCalls>=4;'));
    assert.equal(await run(`return localStorage.length+sessionStorage.length;`),0);
    record('host async authentication hook supports bounded pagination, empty searches, and sanitized server errors without browser persistence');

    const sdkOpenStart=requestCount('retrieve');
    await run(`return window.__qa.viewer.openArchiveSeries(${quote(studyUid)},${quote(seriesUid)});`);
    assert.equal((await run('return window.__qa.viewer.getState();')).frameCount,6);
    assert.equal(requestCount('retrieve'),sdkOpenStart+1);
    assert.ok(await run(`return !/SYNTHETIC\^ARCHIVE|PatientID|patientName|patientId|synthetic-qa-only/.test(JSON.stringify(window.__qa.events));`));
    const disposalStart=requestCount('retrieve');
    await run(`window.__qa.pending=window.__qa.viewer.setFrame(3).then(()=>({ok:true}),error=>({ok:false,name:error.name}));return true;`);
    for(let i=0;i<50&&requestCount('retrieve')===disposalStart;i++)await delay(20);
    await delay(50);await run('window.__qa.viewer.dispose();return true;');
    const disposed=await run('return window.__qa.pending;');
    assert.equal(disposed.ok,false);assert.equal(disposed.name,'AbortError');
    await delay(50);assert.equal(requests.filter(item=>item.type==='retrieve'&&item.index===3).at(-1).aborted,true);
    record('host SDK metadata-first viewing emits private-by-default events and disposal aborts its in-flight archive request');

    assert.equal(browser.errors.length,0);assert.equal(browser.consoleErrors.length,0);
    assert.ok(browser.requests.every(request=>request.method==='GET'||request.method==='OPTIONS'),'Archive viewing must never upload a file or issue a mutation.');
    assert.ok(browser.requests.every(request=>{const url=new URL(request.url);return ['data:','blob:','about:'].includes(url.protocol)||(['http:','https:'].includes(url.protocol)&&['127.0.0.1','localhost','[::1]'].includes(url.hostname));}),'Synthetic archive checks must never contact external services.');
    await writeFile(resolve(output,'results.json'),JSON.stringify({passed:checks.length,checks,requests:summarize(),browserExceptions:0,consoleErrors:0,originalImagingFilesUsed:false},null,2)+'\n');
    console.log(`Archive browser checks: ${checks.length} passed.`);
} finally {
    browser?.close();
    if(server)await new Promise(resolve=>server.close(resolve));
    await rm(qa,{recursive:true,force:true});
}
