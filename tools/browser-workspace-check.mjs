import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { createDicomFixture } from '../src/data/synthetic.js';
import { presentationFixtures, binaryAttributes } from '../test/enhanced-fixtures.js';
import { browserSession, delay } from './browser-session.mjs';

const root = resolve(import.meta.dirname, '..'), qa = resolve(root, 'dist/qa');
const output = resolve(root, 'artifacts/browser-workspace');
const target = new URL(process.env.EASI_VIEW_URL || 'http://127.0.0.1:5175/');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname), 'Workspace checks require an isolated local preview.');
const quote = JSON.stringify, checks = [];
const record = (name, detail = {}) => { checks.push({ name, ...detail }); console.log(`PASS ${name}`); };
const study = '2.25.950', reference = '2.25.951', sopClass = '1.2.840.10008.5.1.4.1.1.2';
const planes = [[0, 2, 4], [0.3, 3.9, 8], [0, 2, 4], [0, 2, 4]];
const samples = (series, index) => [series * 40 + index * 20, 64, 128, 255];
const fileSpecs = planes.flatMap((locations, series) => locations.map((position, index) => ({ series, index,
    bytes: createDicomFixture({ rows: 2, columns: 2, signed: true, bitsStored: 12,
        values: samples(series, index), pixelSpacing: [1, 1], position: [0, 0, position],
        window: { center: 128, width: 256 }, instanceNumber: index + 1,
        description: `Synthetic workspace ${series + 1}`, seriesUid: `${study}.${series + 1}`, sopUid: `${study}.${series + 1}.${index + 1}`,
        extraAttributes: { '0020000D': ['UI', study], '00200052': series === 3 ? null : ['UI', series === 2 ? '2.25.952' : reference] } }) })));
const precisionAttributes = structuredClone(presentationFixtures().voiLut.attributes);
precisionAttributes['00080018'] = ['UI', `${study}.99.1`]; precisionAttributes['0020000E'] = ['UI', `${study}.99`];
precisionAttributes['0020000D'] = ['UI', study]; precisionAttributes['00281052'] = ['DS', 0]; precisionAttributes['00281053'] = ['DS', 16777217];
const badGpuBytes = createDicomFixture({ signed: true, modality: 'OT', sopClass: '1.2.840.10008.5.1.4.1.1.7',
    sopUid: `${study}.99.1`, seriesUid: `${study}.99`, values: [-2, -1, 0, 2], extraAttributes: binaryAttributes(precisionAttributes) });
fileSpecs.push({ series: 4, index: 0, bytes: badGpuBytes });
const partialSpecs = [...fileSpecs.filter(spec => spec.series === 0), ...planes[1].map((position, index) => ({ series: 1, index,
    bytes: createDicomFixture({ rows: 2, columns: 2, signed: true, bitsStored: 12, values: samples(1, index), slope: 2,
        pixelSpacing: [1, 1], position: [0, 0, position], window: { center: 128, width: 256 }, instanceNumber: index + 1,
        seriesUid: `${study}.30`, sopUid: `${study}.30.${index + 1}`, extraAttributes: { '0020000D': ['UI', study], '00200052': ['UI', reference] } }) }))];
const entry = (vr, ...Value) => ({ vr, Value });
const archiveSeries = `${study}.20`, archiveSop = index => `${archiveSeries}.${index + 1}`;
const metadata = Array.from({ length: 3 }, (_, index) => ({
    '00080016': entry('UI', sopClass), '00080018': entry('UI', archiveSop(index)), '00080060': entry('CS', 'CT'),
    '0020000D': entry('UI', study), '0020000E': entry('UI', archiveSeries), '00200052': entry('UI', reference),
    '00200013': entry('IS', index + 1), '00200032': entry('DS', 0, 0, index * 2), '00200037': entry('DS', 1, 0, 0, 0, 1, 0),
    '00280002': entry('US', 1), '00280004': entry('CS', 'MONOCHROME2'), '00280008': entry('IS', 1),
    '00280010': entry('US', 2), '00280011': entry('US', 2), '00280030': entry('DS', 1, 1),
    '00280100': entry('US', 16), '00280101': entry('US', 12), '00280102': entry('US', 11), '00280103': entry('US', 1),
    '00281050': entry('DS', 128), '00281051': entry('DS', 256), '00281052': entry('DS', 0), '00281053': entry('DS', 1),
    '00281054': entry('LO', 'HU'), '00281056': entry('CS', 'LINEAR'),
    '7FE00010': { vr: 'OW', BulkDataURI: 'https://synthetic.invalid/not-followed' }
}));
const archiveBytes = metadata.map((_, index) => createDicomFixture({ rows: 2, columns: 2, signed: true, bitsStored: 12,
    values: samples(0, index), pixelSpacing: [1, 1], position: [0, 0, index * 2], instanceNumber: index + 1,
    window: { center: 128, width: 256 }, seriesUid: archiveSeries, sopUid: archiveSop(index),
    extraAttributes: { '0020000D': ['UI', study], '00200052': ['UI', reference] } }));
const requests = [], serverOptions = { slow: null, delay: 650 };
let browser, server;
function words(values) { const bytes = new Uint8Array(values.length * 2), view = new DataView(bytes.buffer); values.forEach((value, index) => view.setUint16(index * 2, value & 65535, true)); return bytes; }
async function startArchive() {
    server = createServer(async (request, response) => {
        response.setHeader('Access-Control-Allow-Origin', target.origin);
        response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Accept');
        response.setHeader('Cache-Control', 'no-store');
        if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
        const path = new URL(request.url, 'http://127.0.0.1').pathname;
        if (path.endsWith('/metadata')) {
            requests.push({ type: 'metadata' }); response.writeHead(200, { 'Content-Type': 'application/dicom+json' }); response.end(JSON.stringify(metadata)); return;
        }
        const match = path.match(/\/instances\/([^/]+)(?:\/frames\/(\d+))?$/);
        const index = match ? metadata.findIndex(item => item['00080018'].Value[0] === match[1]) : -1;
        if (index < 0) { response.writeHead(404); response.end(); return; }
        const log = { type: match[2] ? 'frame' : 'instance', index, nativeAccept: /transfer-syntax=1\.2\.840\.10008\.1\.2\.1(?:\s|,|$)/.test(request.headers.accept || '') };
        requests.push(log); response.on('close', () => { if (!response.writableEnded) log.aborted = true; });
        if (index === serverOptions.slow) await delay(serverOptions.delay);
        if (response.destroyed) return;
        if (match[2]) {
            assert.equal(Number(match[2]), 1); const boundary = 'synthetic-workspace-frame';
            const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream; transfer-syntax=1.2.840.10008.1.2.1\r\nContent-Location: ${path}\r\nContent-Length: 8\r\n\r\n`),
                Buffer.from(words(samples(0, index))), Buffer.from(`\r\n--${boundary}--\r\n`)]);
            response.writeHead(200, { 'Content-Type': `multipart/related; type="application/octet-stream"; boundary=${boundary}`, 'Content-Length': body.length }); response.end(body); return;
        }
        response.writeHead(200, { 'Content-Type': 'application/dicom', 'Content-Length': archiveBytes[index].length }); response.end(archiveBytes[index]);
    });
    await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    return `http://127.0.0.1:${server.address().port}/dicom-web/`;
}
const frameIndices = state => state.viewports.map(viewport => viewport.frameIndex);
const assertPixels = (actual, expected) => actual.forEach((rgba, index) => {
    for (let channel = 0; channel < 3; channel++) assert.ok(Math.abs(rgba[channel] - expected[index]) <= 1, `Synthetic shader pixel ${index}: ${rgba[channel]} versus independent reference ${expected[index]}`);
    assert.equal(rgba[3], 255);
});

try {
    const buildInfo = JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8'));
    const baseUrl = await startArchive();
    await mkdir(qa, { recursive: true }); await mkdir(output, { recursive: true });
    const helper = resolve(output, 'entry.js');
    await writeFile(helper, `export { createImageTransform, transformPoint } from '../../src/render/ViewportTransform.js';
export const files = ${quote(fileSpecs.map(({ series, index, bytes }) => ({ series, index, base64: Buffer.from(bytes).toString('base64') })))};
export const partialFiles = ${quote(partialSpecs.map(({ series, index, bytes }) => ({ series, index, base64: Buffer.from(bytes).toString('base64') })))};
export function file(spec) { return new File([Uint8Array.from(atob(spec.base64), c => c.charCodeAt(0))], 'synthetic-workspace-'+spec.series+'-'+spec.index+'.dcm', {type:'application/dicom'}); }
export function delayedBadFile() { const bytes=Uint8Array.from(atob(files[files.length-1].base64),c=>c.charCodeAt(0));return{size:bytes.length,stream(){let timer;return new ReadableStream({start(controller){timer=setTimeout(()=>{controller.enqueue(bytes);controller.close();},120);},cancel(){clearTimeout(timer);}});}}; }`);
    await build({ entryPoints: [helper], outfile: resolve(qa, 'fixtures.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true });
    await writeFile(resolve(qa, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="./host.css"></head><body><main id="one"></main><aside id="two"></aside><script type="module" src="./host.js"></script></body></html>');
    await writeFile(resolve(qa, 'host.css'), 'body{margin:0;background:#101820}#one{height:1000px;width:100%}#two{height:600px;width:100%}');
    await writeFile(resolve(qa, 'host.js'), `import {createViewer} from '../assets/easi-view.js';import * as qa from './fixtures.js';window.__qa=qa;window.__events=[];window.__gpu=new Map();window.__stored=new Map();window.__uploads=new Map();window.__workers={created:0,terminated:0,alive:0};
const NativeWorker=window.Worker;window.Worker=class extends NativeWorker{constructor(...args){super(...args);window.__workers.created++;window.__workers.alive++;this.__released=false;}terminate(){if(!this.__released){this.__released=true;window.__workers.terminated++;window.__workers.alive--;}return super.terminate();}};
const context=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(kind,...args){const gl=context.call(this,kind,...args);if(kind==='webgl2'&&gl&&!gl.__qaHook){gl.__qaHook=true;const canvas=this,upload=gl.texImage2D.bind(gl),draw=gl.drawArrays.bind(gl);gl.texImage2D=(...args)=>{if(args[3]===2&&args[4]===2&&args[6]===gl.RED&&args[7]===gl.FLOAT){window.__stored.set(canvas,Array.from(args[8]));window.__uploads.set(canvas,(window.__uploads.get(canvas)||0)+1);}return upload(...args);};gl.drawArrays=(...args)=>{draw(...args);const r=canvas.getBoundingClientRect();if(!r.width||!r.height||!window.__stored.has(canvas))return;const program=gl.getParameter(gl.CURRENT_PROGRAM),matrix=gl.getUniform(program,gl.getUniformLocation(program,'imageToClip'));if(!matrix)return;window.__gpu.set(canvas,[0,1,2,3].map(i=>{const x=i%2+.5,y=Math.floor(i/2)+.5,clipX=matrix[0]*x+matrix[3]*y+matrix[6],clipY=matrix[1]*x+matrix[4]*y+matrix[7],rgba=new Uint8Array(4);gl.readPixels(Math.floor((clipX+1)*canvas.width/2),Math.floor((clipY+1)*canvas.height/2),1,1,gl.RGBA,gl.UNSIGNED_BYTE,rgba);return Array.from(rgba);}));};}return gl;};
window.__viewer=createViewer(document.getElementById('one'));for(const kind of ['sourcechange','framechange','layoutchange','viewportchange','syncchange','error'])window.__viewer.on(kind,detail=>window.__events.push({kind,detail}));await window.__viewer.ready;window.__shadow=document.getElementById('one').querySelector('easi-view-embed').shadowRoot;window.__pane=slot=>window.__shadow.querySelector('.workspace-pane[data-slot="'+slot+'"]');window.__canvas=slot=>window.__pane(slot)?.querySelector('canvas')||(slot===0?window.__shadow.getElementById('image-canvas'):null);window.__observe=()=>({workspace:window.__viewer.getWorkspaceState(),state:window.__viewer.getState(),performance:window.__viewer.getPerformance(),panes:Array.from(window.__shadow.querySelectorAll('.workspace-pane')).map(p=>({slot:Number(p.dataset.slot),active:p.classList.contains('active'),emptyVisible:!p.querySelector('[data-pane-id=\"viewport-empty\"]').hidden,loadingVisible:!p.querySelector('[data-pane-id=\"viewport-loading\"]').hidden,frameLoading:p.classList.contains('frame-loading'),rect:{width:p.getBoundingClientRect().width,height:p.getBoundingClientRect().height}})),stored:[0,1,2,3].map(slot=>window.__stored.get(window.__canvas(slot))||null),gpu:[0,1,2,3].map(slot=>window.__gpu.get(window.__canvas(slot))||null),uploads:[0,1,2,3].map(slot=>window.__uploads.get(window.__canvas(slot))||0),workers:{...window.__workers}});window.__ready=true;`);
    browser = await browserSession(output);
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
    await browser.send('Page.navigate', { url: new URL('qa/index.html', target).href });
    await browser.until('window.__ready', 'Workspace host did not mount.');
    assert.equal(await browser.evaluate('window.__viewer.getWorkspaceState().layout'), 1);
    assert.equal(requests.length, 0);
    await browser.evaluate('(async()=>{await window.__viewer.openFiles(window.__qa.files.map(window.__qa.file));})()');
    let observed = await browser.evaluate('window.__observe()');
    assert.equal(observed.state.seriesCount, 5); assert.equal(observed.workspace.layout, 1);
    assert.deepEqual(observed.stored[0], samples(0, 0)); assertPixels(observed.gpu[0], samples(0, 0));
    record('default single pane opens generated local Part10 data without archive requests');

    await browser.evaluate(`window.__shadow.querySelector('button[data-layout="2"]').click()`);
    await browser.until('window.__viewer.getWorkspaceState().layout===2', 'Two-pane UI layout was not applied.');
    await browser.evaluate('(async()=>{await window.__viewer.assignViewportSeries(1,1);window.__viewer.setActiveViewport(0);})()');
    observed = await browser.evaluate('window.__observe()');
    assert.equal(observed.panes.length, 2); assert.deepEqual(frameIndices(observed.workspace), [0, 0]);
    assert.ok(observed.panes.every(pane => pane.rect.width > 100 && pane.rect.height > 100));
    assert.deepEqual(observed.stored[1], samples(1, 0)); assertPixels(observed.gpu[1], samples(1, 0));
    await browser.evaluate('(async()=>{await window.__viewer.setLayout(4);await window.__viewer.assignViewportSeries(2,2);await window.__viewer.assignViewportSeries(3,3);})()');
    observed = await browser.evaluate('window.__observe()');
    assert.equal(observed.panes.length, 4); assert.equal(observed.workspace.layout, 4);
    assert.deepEqual(frameIndices(observed.workspace), [0, 0, 0, 0]);
    observed.stored.forEach((stored, series) => assert.deepEqual(stored, samples(series, 0)));
    record('UI two-pane and SDK four-pane layouts assign independently rendered series');

    const validation = await browser.evaluate(`(async()=>{const v=window.__viewer,prior=v.getWorkspaceState(),rejected=[];for(const action of[()=>v.setLayout(3),()=>v.setActiveViewport(4),()=>v.assignViewportSeries(0,5),()=>v.setSynchronization({slice:'yes'}),()=>v.setSynchronization({toleranceMm:-1})]){try{await action();rejected.push(false);}catch{rejected.push(true);}}const detached=v.getWorkspaceState();detached.viewports[0].frameIndex=999;detached.viewports[0].transform.panX=999;detached.synchronization.slice=true;return{prior,rejected,state:v.getWorkspaceState()};})()`);
    assert.ok(validation.rejected.every(Boolean)); assert.deepEqual(validation.state, validation.prior);
    assert.ok(!/"(?:patientName|patientId|studyUid|seriesUid|sopUid|samples|pixelData)"\s*:|2\.25\.95/.test(JSON.stringify(validation.state)));
    record('workspace SDK validates invalid layout/assignment/sync options and returns detached private operational snapshots');

    const independent = await browser.evaluate('(async()=>{const v=window.__viewer;v.setActiveViewport(0);v.setWindow({center:100,width:200});await v.setFrame(2);v.setActiveViewport(1);v.setWindow({center:64,width:128});await v.setFrame(1);return window.__observe();})()');
    assert.deepEqual(frameIndices(independent.workspace), [2, 1, 0, 0]);
    assert.deepEqual(independent.workspace.viewports[0].window, { center: 100, width: 200 });
    assert.deepEqual(independent.workspace.viewports[1].window, { center: 64, width: 128 });
    assert.deepEqual(independent.stored[0], samples(0, 2)); assert.deepEqual(independent.stored[1], samples(1, 1));
    const levels = (values, center, width) => values.map(value => Math.round(Math.max(0, Math.min(1, (value - (center - 0.5)) / (width - 1) + 0.5)) * 255));
    assertPixels(independent.gpu[0], levels(samples(0, 2), 100, 200)); assertPixels(independent.gpu[1], levels(samples(1, 1), 64, 128));
    record('active-pane seeks and scalar windows preserve the other panes and match independent GPU intensities');

    await browser.evaluate('window.__viewer.setActiveViewport(1);window.__viewer.setTool("pan")');
    const center = await browser.evaluate('(()=>{const r=window.__canvas(1).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()');
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: center.x, y: center.y, button: 'left', buttons: 1, clickCount: 1 });
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x + 25, y: center.y + 15, button: 'left', buttons: 1 });
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: center.x + 25, y: center.y + 15, button: 'left', buttons: 0, clickCount: 1 });
    observed = await browser.evaluate('window.__observe()');
    assert.equal(observed.workspace.viewports[0].transform.panX, 0); assert.ok(observed.workspace.viewports[1].transform.panX > 0);
    await browser.evaluate('window.__viewer.setActiveViewport(0);window.__viewer.setTool("probe")');
    const point = await browser.evaluate('(()=>{const canvas=window.__canvas(0),r=canvas.getBoundingClientRect(),state=window.__viewer.getWorkspaceState().viewports[0].transform,t=window.__qa.createImageTransform({rows:2,columns:2,pixelSpacing:[1,1]},state,r.width,r.height),p=window.__qa.transformPoint(t,.5,.5);return{x:r.x+p.x,y:r.y+p.y};})()');
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
    await browser.until('window.__shadow.getElementById("probe-stored").textContent.includes("40")', 'Active pane probe did not retain the original sample.');
    record('actual pointer pan and stored-value probe target the active canvas without moving its neighbor');

    await browser.evaluate('window.__viewer.setActiveViewport(0);window.__viewer.setSynchronization({slice:true,window:true,camera:true,toleranceMm:0.5})');
    await browser.until('window.__viewer.getWorkspaceState().lastSync.length===3', 'Guarded slice sync results were not published.');
    observed = await browser.evaluate('window.__observe()');
    assert.equal(observed.workspace.lastSync[0].matched, true); assert.equal(observed.workspace.viewports[1].frameIndex, 1);
    assert.equal(observed.workspace.lastSync[1].reason, 'frame-of-reference-mismatch');
    assert.equal(observed.workspace.lastSync[2].reason, 'missing-patient-geometry');
    assert.deepEqual(observed.workspace.viewports[1].window, observed.workspace.viewports[0].window);
    assert.ok(Math.abs(observed.workspace.viewports[1].transform.panX) < 1e-6);
    await browser.evaluate('(async()=>{await window.__viewer.setFrame(0);})()');
    await browser.until('window.__viewer.getWorkspaceState().viewports[1].frameIndex===0', 'Compatible nearest-plane navigation did not synchronize.');
    observed = await browser.evaluate('window.__observe()'); assert.deepEqual(frameIndices(observed.workspace), [0, 0, 0, 0]);
    record('patient-plane sync maps distinct SOPs, copies compatible windows/physical cameras and reports missing/different reference guards');

    await browser.evaluate('(async()=>{const v=window.__viewer;await v.setSynchronization({slice:false,window:false,camera:false});v.setActiveViewport(0);v.reset();await v.assignViewportSeries(1,0);})()');
    const reused = await browser.evaluate('window.__observe()');
    assert.deepEqual(reused.stored[1], samples(0, 0));
    assert.ok(reused.performance.measurements.some(value => value.phase === 'frame' && value.decodedCacheHit));
    assert.ok(reused.workspace.decodedBytes <= reused.workspace.cacheBudget);
    record('same-series assignment reuses the shared decoded cache within one aggregate workspace budget');

    const assignmentRollback = await browser.evaluate(`(async()=>{const v=window.__viewer,prior=window.__observe();let rejected=false,message='';try{await v.assignViewportSeries(1,4);}catch(error){rejected=true;message=error.message;}return{rejected,message,prior,after:window.__observe()};})()`);
    assert.equal(assignmentRollback.rejected, true); assert.match(assignmentRollback.message, /display|GPU|precision/i);
    assert.deepEqual(assignmentRollback.after.workspace.viewports, assignmentRollback.prior.workspace.viewports);
    assert.deepEqual(assignmentRollback.after.stored, assignmentRollback.prior.stored); assert.deepEqual(assignmentRollback.after.gpu, assignmentRollback.prior.gpu);
    assert.ok(assignmentRollback.after.panes.every(pane => !pane.emptyVisible && !pane.loadingVisible && !pane.frameLoading), 'Restored assigned panes must show their image without stale empty/loading overlays.');
    record('GPU-inexact series assignment rolls back its pane model and presentation before replacing the committed texture');

    await browser.evaluate(`(()=>{const v=window.__viewer;v.setActiveViewport(3);window.__beforeBadSource=window.__observe();window.__badSource=v.openFiles([window.__qa.delayedBadFile()]).then(()=>({rejected:false}),error=>({rejected:true,message:error.message}));return true;})()`);
    // Cleanup can await before the source transaction begins. Activate B only
    // after the delayed read is busy, so this really tests activation during
    // parsing rather than a synchronous change before the rollback snapshot.
    await browser.until('window.__viewer.getState().busy', 'The delayed replacement did not enter its source transaction.');
    await browser.evaluate('window.__viewer.setActiveViewport(1)');
    const sourceRollback = await browser.evaluate(`(async()=>({result:await window.__badSource,prior:window.__beforeBadSource,after:window.__observe()}))()`);
    assert.equal(sourceRollback.result.rejected, true); assert.match(sourceRollback.result.message, /GPU|precision|exact/i);
    assert.equal(sourceRollback.after.workspace.activeViewport, sourceRollback.prior.workspace.activeViewport);
    assert.deepEqual(sourceRollback.after.workspace.viewports, sourceRollback.prior.workspace.viewports);
    assert.deepEqual(sourceRollback.after.stored, sourceRollback.prior.stored); assert.deepEqual(sourceRollback.after.gpu, sourceRollback.prior.gpu);
    assert.ok(sourceRollback.after.panes.every(pane => !pane.emptyVisible && !pane.loadingVisible && !pane.frameLoading), 'Source rollback must restore visible images in every assigned pane, including inactive panes.');
    record('failed source replacement restores all four pane assignments and the original active pane despite an activation during parsing');
    await browser.evaluate('window.__viewer.setActiveViewport(0);window.__shadow.getElementById("dismiss-error").click()');
    await browser.screenshot('workspace-four-synthetic');

    const reduced = await browser.evaluate('(async()=>{const v=window.__viewer;window.__removedCanvas=window.__canvas(3);v.setActiveViewport(3);await v.setLayout(2);return window.__observe();})()');
    assert.equal(reduced.workspace.layout, 2); assert.ok(reduced.workspace.activeViewport >= 0 && reduced.workspace.activeViewport < 2); assert.equal(reduced.panes.length, 2);
    assert.equal(await browser.evaluate('window.__removedCanvas.isConnected'), false);
    const preserved = reduced.workspace.viewports.map(viewport => viewport.frameIndex);
    await browser.evaluate('window.__viewer.setLayout(1)');
    assert.equal(await browser.evaluate('window.__viewer.getWorkspaceState().viewports[0].frameIndex'), preserved[0]);
    record('layout reduction removes unused canvases, releases pane ownership and keeps the surviving frame');

    await browser.evaluate(`(async()=>{const v=window.__viewer;await v.openFiles(window.__qa.partialFiles.map(window.__qa.file));await v.setLayout(2);await v.assignViewportSeries(1,1);v.setActiveViewport(0);await v.setFrame(2);await v.setSynchronization({slice:true,window:true,toleranceMm:0.5});})()`);
    const partial = await browser.evaluate('window.__observe()');
    assert.equal(partial.workspace.viewports[1].frameIndex, 1); assert.deepEqual(partial.stored[1], samples(1, 1));
    assert.equal(partial.workspace.lastSync[0].matched, false); assert.equal(partial.workspace.lastSync[0].reason, 'presentation-semantics-mismatch');
    assert.equal(partial.workspace.lastSync[0].frameIndex, 1);
    record('successful nearest-slice movement commits even when the optional linked window has incompatible rescale semantics');

    await browser.evaluate(`(async()=>{const v=window.__viewer;await v.setSynchronization({slice:false,window:false,camera:false});await v.openFiles(window.__qa.files.filter(spec=>spec.series<2).map(window.__qa.file));await v.assignViewportSeries(1,1);v.setActiveViewport(0);await v.setSynchronization({slice:true,toleranceMm:0.5});await v.setFrame(2);await v.setFrame(0);})()`);
    await browser.until('(()=>{const s=window.__viewer.getWorkspaceState();return s.viewports[0].frameIndex===0&&s.viewports[1].frameIndex===0&&!s.viewports.some(p=>p.busy);})()', 'A superseded asynchronous synchronization left an obsolete target slice committed.');
    const latest = await browser.evaluate('window.__observe()'); assert.deepEqual(latest.stored[0], samples(0, 0)); assert.deepEqual(latest.stored[1], samples(1, 0));
    assert.ok(latest.workspace.lastSync.every(result => result.matched));
    await browser.evaluate('window.__viewer.setSynchronization({slice:false,window:false,camera:false})');
    record('successive source seeks coalesce asynchronous linked navigation onto the latest committed patient plane');

    await browser.evaluate(`(async()=>{const v=window.__viewer;v.configureArchive({baseUrl:${quote(baseUrl)}});await v.openArchiveSeries(${quote(study)},${quote(archiveSeries)});await v.setLayout(2);await v.assignViewportSeries(1,0);v.setActiveViewport(0);})()`);
    serverOptions.slow = 1;
    await browser.evaluate('window.__slow=window.__viewer.setFrame(1).then(()=>({success:true}),e=>({success:false,name:e.name}));true');
    for (let step = 0; step < 100 && !requests.some(request => request.type === 'instance' && request.index === 1); step++) await delay(10);
    assert.ok(requests.some(request => request.type === 'instance' && request.index === 1));
    await browser.evaluate('window.__viewer.setActiveViewport(1);window.__otherSeek=window.__viewer.setFrame(2).then(()=>({success:true}),e=>({success:false,name:e.name}));true');
    await browser.evaluate('(async()=>{window.__viewer.setActiveViewport(0);await window.__viewer.setFrame(0);})()');
    const canceled = await browser.evaluate('(async()=>({slow:await window.__slow,other:await window.__otherSeek,observed:window.__observe()}))()');
    assert.equal(canceled.slow.success, false); assert.equal(canceled.slow.name, 'AbortError'); assert.equal(canceled.other.success, true);
    assert.deepEqual(frameIndices(canceled.observed.workspace), [0, 2]); assert.deepEqual(canceled.observed.stored[1], samples(0, 2));
    await delay(50); assert.equal(requests.find(request => request.type === 'instance' && request.index === 1).aborted, true);
    record('canceling one pane aborts its lazy archive request while the queued neighboring pane completes correctly');
    serverOptions.slow = null;

    const beforeFrameMode = requests.length;
    await browser.evaluate(`(async()=>{const v=window.__viewer;await v.setLayout(1);v.configureArchive({baseUrl:${quote(baseUrl)},retrievalMode:'frame'});await v.openArchiveSeries(${quote(study)},${quote(archiveSeries)});await v.setFrame(2);await v.setFrame(0);})()`);
    const frameMode = await browser.evaluate('window.__observe()');
    const frameRequests = requests.slice(beforeFrameMode);
    assert.deepEqual(frameRequests.filter(request => request.type === 'frame').map(request => request.index), [0, 2]);
    assert.equal(frameRequests.some(request => request.type === 'instance'), false); assert.ok(frameRequests.filter(request => request.type === 'frame').every(request => request.nativeAccept));
    assert.deepEqual(frameMode.stored[0], samples(0, 0)); assert.equal(frameMode.performance.resources.encodedBytes, 0);
    record('explicit native-frame archive mode retrieves only selected frame resources and reuses decoded pixels without whole-instance storage');

    const isolation = await browser.evaluate('(async()=>{window.__other=window.__qa.createViewer?.(document.getElementById("two"));if(!window.__other){const{createViewer}=await import("../assets/easi-view.js");window.__other=createViewer(document.getElementById("two"));}await window.__other.ready;await window.__other.openFiles(window.__qa.files.filter(x=>x.series===1).map(window.__qa.file));await window.__other.setFrame(2);const state=window.__other.getState();window.__viewer.dispose();return{state,other:window.__other.getState(),disposed:window.__viewer.getPerformance(),hostRemoved:!document.getElementById("one").querySelector("easi-view-embed"),events:window.__events};})()');
    assert.equal(isolation.other.frameIndex, 2); assert.equal(isolation.other.disposed, false); assert.equal(isolation.hostRemoved, true);
    assert.equal(isolation.disposed.resources.disposed, true); assert.equal(isolation.disposed.resources.workerCount, 0);
    assert.equal(isolation.disposed.resources.encodedBytes, 0); assert.equal(isolation.disposed.resources.decodedCacheBytes, 0);
    assert.ok(!/"(?:patientName|patientId|studyUid|seriesUid|sopUid|samples|pixelData)"\s*:|2\.25\.95/.test(JSON.stringify(isolation.events)));
    for (const kind of ['layoutchange', 'viewportchange', 'syncchange']) assert.ok(isolation.events.some(event => event.kind === kind));
    const remount = await browser.evaluate('(async()=>{const{createViewer}=await import("../assets/easi-view.js");window.__viewer=createViewer(document.getElementById("one"));await window.__viewer.ready;await window.__viewer.openFiles(window.__qa.files.filter(x=>x.series===0).map(window.__qa.file));await window.__other.setFrame(1);return{state:window.__viewer.getState(),workspace:window.__viewer.getWorkspaceState(),other:window.__other.getState()};})()');
    assert.equal(remount.workspace.layout, 1); assert.equal(remount.state.frameIndex, 0); assert.equal(remount.other.frameIndex, 1);
    record('disposal clears owned resources and private operational events; a sibling viewer stays live and the original host can remount');
    await browser.evaluate('window.__viewer.dispose();window.__other.dispose();');
    assert.equal(await browser.evaluate('window.__workers.alive'), 0);
    assert.equal(browser.errors.length, 0); assert.equal(browser.consoleErrors.length, 0);
    assert.equal(JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8')).sourceDigest, buildInfo.sourceDigest);
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ passed: checks.length, checks, sourceDigest: buildInfo.sourceDigest,
        harnessSha256: createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'),
        fixtureReference: { planes, sourceValues: planes.map((locations, series) => locations.map((_, index) => samples(series, index))), aggregateDecodedBudgetBytes: 64 * 1024 * 1024 },
        requests, browserExceptions: 0, consoleErrors: 0, originalImagingFilesUsed: false }, null, 2) + '\n');
    console.log(`Workspace browser checks: ${checks.length} passed.`);
} finally { browser?.close(); server?.closeAllConnections(); if (server) await new Promise(resolveClose => server.close(resolveClose)); await rm(qa, { recursive: true, force: true }); }
