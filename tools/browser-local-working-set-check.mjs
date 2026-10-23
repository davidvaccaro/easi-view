import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createLocalWorkingSetFixtures, workingSetSamples, WORKING_SET_FRAMES,
    WORKING_SET_OVERSIZE_FRAMES } from '../test/local-working-set-fixtures.js';
import { browserSession } from './browser-session.mjs';
import { startCorpusServer } from './local-corpus-check.mjs';

// Independent synthetic-only qualification of the bounded local source cache.
// Stored samples, frame counts and framebuffer expectations come from the writer.
const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'artifacts/browser-local-working-set');
const fixtures = createLocalWorkingSetFixtures(), checks = [], quote = JSON.stringify;
const record = name => { checks.push({ name }); console.log(`PASS ${name}`); };
let browser, server, temporary;
const evaluate = expression => browser.evaluate(expression);
const run = source => evaluate(`(async () => { ${source} })()`);
const state = () => evaluate(`({state:window.__v.getState(),library:window.__v.getLocalLibraryState(),
    workspace:window.__v.getWorkspaceState(),performance:window.__v.getPerformance(),
    annotations:window.__v.getAnnotationState(),reads:{...window.__qa.reads},draws:window.__qa.draws,
    workers:window.__qa.workers,errorHidden:window.__shadow.getElementById('error-banner').hidden,
    panes:Array.from(window.__shadow.querySelectorAll('.workspace-pane')).map(pane=>({
        slot:Number(pane.dataset.slot),empty:!pane.querySelector('[data-pane-id=viewport-empty]').hidden,
        loading:!pane.querySelector('[data-pane-id=viewport-loading]').hidden,
        frameLoading:pane.classList.contains('frame-loading')}))})`);
const noPrivate = value => assert.ok(!/"(?:patientName|patientId|issuerOfPatientId|patientBirthDate|studyUid|seriesUid|sopUid|studyDate|studyTime|points|samples|pixelData)"\s*:|2\.25\.996|SYNTHETIC\^WORKING_SET|SYNTHETIC_ISSUER/.test(JSON.stringify(value)), 'Operational state/events must not expose catalog identifiers or image payloads.');
const verifyDraw = (observed, slot, samples) => {
    const draw = observed.draws.findLast(item => item.slot === slot && item.pixels);
    assert.ok(draw, `Pane ${slot} has no rendered pixels.`);
    assert.deepEqual(draw.samples, samples);
    const window = observed.workspace.viewports[slot].window;
    for (let index = 0; index < 4; index++) {
        const expected = Math.round(Math.max(0, Math.min(1,
            (samples[index] - (window.center - .5)) / (window.width - 1) + .5)) * 255);
        assert.ok(draw.pixels[index].slice(0, 3).every(value => Math.abs(value - expected) <= 2),
            JSON.stringify({ slot, index, expected, actual: draw.pixels[index] }));
        assert.equal(draw.pixels[index][3], 255);
    }
};
const capture = async name => {
    await browser.screenshot(name);
    await copyFile(resolve(temporary, 'chrome', `${name}.png`), resolve(output, `${name}.png`));
};

try {
    await mkdir(output, { recursive: true });
    await rm(resolve(output, 'failure.json'), { force: true });
    await rm(resolve(output, 'results.json'), { force: true });
    temporary = await mkdtemp(join(tmpdir(), 'easi-view-local-working-set-browser-'));
    const host = resolve(temporary, 'host'); await mkdir(host);
    const buildInfo = JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8'));
    const encoded = [...fixtures.studies, ...fixtures.oversized].map(({ bytes, ...metadata }) =>
        ({ ...metadata, encoded: Buffer.from(bytes).toString('base64') }));
    await writeFile(resolve(host, 'fixtures.json'), JSON.stringify(encoded));
    await writeFile(resolve(host, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./host.css"></head><body><main id="mount"></main><script type="module" src="./host.js"></script></body></html>');
    await writeFile(resolve(host, 'host.css'), 'body{margin:0;background:#09121b}#mount{height:1080px;width:100%}');
    await writeFile(resolve(host, 'host.js'), `
import {createViewer} from '/assets/easi-view.js';
const fixtures=await(await fetch('./fixtures.json')).json();
window.__qa={events:[],reads:{},slow:{},draws:[],workers:{created:0,terminated:0,active:0}};
const qa=window.__qa,NativeWorker=window.Worker;
window.Worker=class extends NativeWorker{constructor(...args){super(...args);qa.workers.created++;qa.workers.active++;this.__qaTerminated=false;}terminate(){if(!this.__qaTerminated){this.__qaTerminated=true;qa.workers.terminated++;qa.workers.active--;}return super.terminate();}};
const originalUpload=WebGL2RenderingContext.prototype.texImage2D,originalDraw=WebGL2RenderingContext.prototype.drawArrays;
WebGL2RenderingContext.prototype.texImage2D=function(...args){if(args[3]===2&&args[4]===2&&args[8]?.length===4)this.canvas.__qaSamples=Array.from(args[8]);return originalUpload.apply(this,args);};
WebGL2RenderingContext.prototype.drawArrays=function(...args){const result=originalDraw.apply(this,args);if(this.canvas.__qaSamples){const program=this.getParameter(this.CURRENT_PROGRAM),matrix=program&&this.getUniform(program,this.getUniformLocation(program,'imageToClip'));let pixels=null;if(matrix)pixels=[0,1,2,3].map(i=>{const x=i%2+.5,y=Math.floor(i/2)+.5,clipX=matrix[0]*x+matrix[3]*y+matrix[6],clipY=matrix[1]*x+matrix[4]*y+matrix[7],rgba=new Uint8Array(4);this.readPixels(Math.floor((clipX+1)*this.canvas.width/2),Math.floor((clipY+1)*this.canvas.height/2),1,1,this.RGBA,this.UNSIGNED_BYTE,rgba);return Array.from(rgba);});qa.draws.push({samples:[...this.canvas.__qaSamples],pixels,slot:Number(this.canvas.closest('.workspace-pane')?.dataset.slot??0)});}return result;};
const files=new Map(fixtures.map(f=>{const file=new File([Uint8Array.from(atob(f.encoded),c=>c.charCodeAt(0))],f.name),original=file.stream.bind(file);Object.defineProperty(file,'stream',{value:()=>{qa.reads[f.key]=(qa.reads[f.key]??0)+1;const reader=original().getReader(),milliseconds=qa.slow[f.key]??0;let canceled=false;return new ReadableStream({async pull(controller){try{if(milliseconds)await new Promise(done=>setTimeout(done,milliseconds));if(canceled)return;const next=await reader.read();if(canceled)return;if(next.done)controller.close();else controller.enqueue(next.value);}catch(error){if(!canceled)controller.error(error);}},cancel(reason){canceled=true;return reader.cancel(reason);}});}});return[f.key,file];}));
window.__files=keys=>keys.map(key=>files.get(key));
window.__v=createViewer(document.getElementById('mount'),{initialDemo:null});
for(const type of ['sourcechange','framechange','layoutchange','viewportchange','syncchange','annotationchange','error','dispose','librarychange'])window.__v.on(type,detail=>qa.events.push({type,detail}));
await window.__v.ready;window.__shadow=document.getElementById('mount').querySelector('easi-view-embed').shadowRoot;window.__ready=true;
`);
    server = await startCorpusServer({ dist: resolve(root, 'dist'), host, styleHash: buildInfo.inlineStyleSha256 });
    browser = await browserSession(resolve(temporary, 'chrome'));
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1540, height: 1120, deviceScaleFactor: 1, mobile: false });
    await browser.send('Page.navigate', { url: server.url });
    await browser.until('window.__ready', 'The generated working-set host did not mount.');

    await evaluate('window.__v.importLocalFiles(window.__files(["A","B","C","D","E"]))');
    let catalog = await evaluate('window.__v.getLocalCatalog()');
    assert.equal(catalog.counts.studies, 5); assert.equal(catalog.counts.series, 5);
    assert.equal(catalog.counts.frames, 5 * WORKING_SET_FRAMES);
    const patient = catalog.patients[0]; assert.equal(catalog.patients.length, 1);
    const studies = Object.fromEntries(fixtures.studies.map(fixture => [fixture.key,
        patient.studies.find(study => study.studyUid === fixture.studyUid)]));
    for (const study of Object.values(studies)) assert.ok(study);
    assert.equal((await state()).library.currentStudyId, studies.A.id);
    assert.equal((await state()).state.frameCount, WORKING_SET_FRAMES);
    record('five generated studies index 15,000 frames while only the initial selected study loads pixels');

    await run(`await window.__v.setFrame(${WORKING_SET_FRAMES - 1});window.__v.setWindow({center:400,width:1000});window.__v.addAnnotation({tool:'length',points:[{x:.5,y:.5},{x:1.5,y:.5}]});`);
    const measurement = await evaluate('window.__v.exportAnnotations()');
    assert.equal(measurement.annotations.length, 1);
    const initialCounts = catalog.counts;
    for (const key of ['B', 'C', 'D', 'E']) {
        await evaluate(`window.__v.compareLocalStudies(${quote(studies.A.id)},${quote(studies[key].id)})`);
        const observed = await state();
        assert.equal(observed.library.currentStudyId, studies.A.id);
        assert.equal(observed.library.comparisonStudyId, studies[key].id);
        assert.equal(observed.workspace.layout, 2);
        assert.equal(observed.workspace.viewports[0].frameIndex, WORKING_SET_FRAMES - 1);
        assert.deepEqual(observed.workspace.viewports[0].window, { center: 400, width: 1000 });
        assert.ok(observed.workspace.viewports.every(pane => pane.frameCount === WORKING_SET_FRAMES));
        assert.ok(observed.panes.every(pane => !pane.empty && !pane.loading && !pane.frameLoading));
        assert.ok(observed.state.seriesCount >= 2 && observed.state.seriesCount <= 3);
        assert.ok(observed.state.seriesCount * WORKING_SET_FRAMES <= 10000);
        assert.equal(observed.annotations.count, 1);
        assert.equal(observed.annotations.frameCount, 1);
        assert.deepEqual(await evaluate('window.__v.exportAnnotations()'), measurement);
        assert.deepEqual(await evaluate('window.__v.getLocalCatalog().counts'), initialCounts);
        verifyDraw(observed, 0, workingSetSamples('A', WORKING_SET_FRAMES - 1));
        verifyDraw(observed, 1, workingSetSamples(key));
        assert.equal(observed.workspace.synchronization.slice, false);
        assert.equal(observed.workspace.synchronization.window, false);
        assert.equal(observed.workspace.synchronization.camera, false);
        assert.equal(observed.errorHidden, true);
        assert.ok(observed.performance.resources.encodedBytes <= 3 * WORKING_SET_FRAMES * 8);
        noPrivate(observed.state); noPrivate(observed.library); noPrivate(observed.workspace);
        record(`comparison A/${key} preserves rendered frame 3000, window and measurement while evicting inactive sources as needed`);
    }
    await capture('local-working-set-comparison');
    const beforeReopen = await state(), previousReads = beforeReopen.reads.B;
    await evaluate(`window.__v.compareLocalStudies(${quote(studies.A.id)},${quote(studies.B.id)})`);
    let observed = await state();
    assert.equal(observed.reads.B, previousReads + 1);
    assert.equal(observed.reads.A, beforeReopen.reads.A);
    assert.equal(observed.workspace.viewports[0].frameIndex, WORKING_SET_FRAMES - 1);
    assert.equal(observed.library.comparisonStudyId, studies.B.id);
    assert.ok(observed.state.seriesCount <= 3);
    assert.deepEqual(await evaluate('window.__v.exportAnnotations()'), measurement);
    assert.deepEqual(await evaluate('window.__v.getLocalCatalog().counts'), initialCounts);
    verifyDraw(observed, 0, workingSetSamples('A', WORKING_SET_FRAMES - 1));
    verifyDraw(observed, 1, workingSetSamples('B'));
    record('reopening an evicted study rereads its original local File while the current study stays loaded and all catalog records remain');

    const beforeAddition = await state();
    await evaluate('window.__v.importLocalFiles(window.__files(["oversize-1","oversize-2","oversize-3"]))');
    observed = await state(); catalog = await evaluate('window.__v.getLocalCatalog()');
    assert.deepEqual(observed.workspace, beforeAddition.workspace);
    assert.equal(catalog.counts.studies, 6); assert.equal(catalog.counts.series, 6);
    assert.equal(catalog.counts.frames, 5 * WORKING_SET_FRAMES + WORKING_SET_OVERSIZE_FRAMES);
    const oversized = catalog.patients[0].studies.find(study => study.studyUid === fixtures.oversized[0].studyUid);
    assert.ok(oversized); assert.equal(oversized.series[0].frameCount, WORKING_SET_OVERSIZE_FRAMES);
    record('an oversized series can remain metadata-indexed without replacing an active comparison or loading its pixels');

    const beforeCancel = await state(), cancelReads = beforeCancel.reads['oversize-1'];
    await evaluate(`(()=>{window.__qa.slow['oversize-1']=500;window.__pending=window.__v.openLocalStudy(${quote(oversized.id)}).then(()=>({fulfilled:true}),error=>({name:error.name,message:error.message}));return true;})()`);
    await browser.until(`window.__qa.reads['oversize-1']>${cancelReads}&&window.__v.getLocalLibraryState().busy`, 'The slow local selection did not start.');
    await evaluate('window.__v.cancelLocalImport()');
    const canceled = await evaluate('window.__pending');
    assert.equal(canceled.name, 'AbortError');
    await evaluate('window.__qa.slow["oversize-1"]=0');
    observed = await state();
    assert.deepEqual(observed.workspace, beforeCancel.workspace);
    assert.equal(observed.library.currentStudyId, studies.A.id);
    assert.equal(observed.library.comparisonStudyId, studies.B.id);
    assert.equal(observed.performance.resources.encodedBytes, beforeCancel.performance.resources.encodedBytes);
    assert.deepEqual(await evaluate('window.__v.exportAnnotations()'), measurement);
    verifyDraw(observed, 0, workingSetSamples('A', WORKING_SET_FRAMES - 1));
    verifyDraw(observed, 1, workingSetSamples('B'));
    record('canceling a new source selection rolls back both rendered panes and retains the previous working set and measurements');

    const beforeOversize = await state();
    const rejected = await evaluate(`window.__v.openLocalStudy(${quote(oversized.id)}).then(()=>({fulfilled:true}),error=>({name:error.name,message:error.message}))`);
    assert.ok(!rejected.fulfilled);
    assert.match(rejected.message, /10[,.]?000|frame|working.set|workspace/i);
    observed = await state();
    assert.deepEqual(observed.workspace, beforeOversize.workspace);
    assert.equal(observed.library.currentStudyId, studies.A.id);
    assert.equal(observed.library.comparisonStudyId, studies.B.id);
    assert.equal(observed.performance.resources.encodedBytes, beforeOversize.performance.resources.encodedBytes);
    assert.equal(observed.state.seriesCount, beforeOversize.state.seriesCount);
    assert.deepEqual(await evaluate('window.__v.exportAnnotations()'), measurement);
    verifyDraw(observed, 0, workingSetSamples('A', WORKING_SET_FRAMES - 1));
    verifyDraw(observed, 1, workingSetSamples('B'));
    assert.equal((await evaluate('window.__v.getLocalCatalog()')).counts.studies, 6);
    record('a selected 12,288-frame series still rejects without discarding the previous comparison, its measurements or the catalog');

    await evaluate('window.__v.clearLocalLibrary()'); observed = await state();
    assert.equal(observed.library.instances, 0); assert.equal(observed.state.seriesCount, 0);
    assert.equal(observed.state.image, null); assert.equal(observed.annotations.count, 0);
    assert.equal(observed.performance.resources.encodedBytes, 0);
    assert.equal(observed.performance.resources.encodedCacheBytes, 0);
    assert.equal(observed.performance.resources.decodedCacheBytes, 0);
    assert.equal(observed.performance.resources.thumbnailBytes, 0);
    record('clearing the local library releases every loaded source, image cache and measurement');
    const final = await run('window.__v.dispose();await window.__v.whenDisposed();return {state:window.__v.getState(),performance:window.__v.getPerformance(),library:window.__v.getLocalLibraryState(),events:window.__qa.events,workers:window.__qa.workers};');
    assert.equal(final.performance.resources.workerCount, 0);
    assert.equal(final.performance.resources.encodedBytes, 0);
    assert.equal(final.performance.resources.encodedCacheBytes, 0);
    assert.equal(final.performance.resources.decodedCacheBytes, 0);
    assert.equal(final.performance.resources.thumbnailBytes, 0);
    assert.equal(final.workers.active, 0); assert.equal(final.workers.created, final.workers.terminated);
    noPrivate(final.events); noPrivate(final.library); noPrivate(final.state);
    record('viewer disposal releases all workers and pixel resources, and operational events remain free of image metadata');

    assert.equal(JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8')).sourceDigest,
        buildInfo.sourceDigest, 'Viewer assets changed during qualification.');
    assert.equal(browser.errors.length, 0); assert.equal(browser.consoleErrors.length, 0);
    const uploads = browser.requests.filter(request => !['GET', 'HEAD'].includes(request.method));
    const external = browser.requests.filter(request => !request.url.startsWith(new URL(server.url).origin)
        && !request.url.startsWith('data:') && !request.url.startsWith('blob:'));
    assert.equal(uploads.length, 0); assert.equal(external.length, 0);
    assert.equal(server.requests.rejectedMethods, 0);
    record('generated local imports make no uploads or external requests and produce no browser exceptions or console errors');
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ passed: checks.length, checks,
        sourceDigest: buildInfo.sourceDigest,
        harnessSha256: createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'),
        originalImagingFilesUsed: false, uploads: 0, externalRequests: 0,
        browserExceptions: 0, consoleErrors: 0 }, null, 2) + '\n');
    console.log(`Local working-set browser checks: ${checks.length} passed.`);
} catch (error) {
    await writeFile(resolve(output, 'failure.json'), JSON.stringify({ checks,
        error: { name: error.name, message: error.message, stack: error.stack },
        browserExceptions: browser?.errors ?? [], consoleErrors: browser?.consoleErrors ?? [] }, null, 2) + '\n');
    throw error;
} finally {
    browser?.close(); await server?.close();
    if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
