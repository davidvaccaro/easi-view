import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createDicomdirMedia } from '../test/dicomdir-fixtures.js';
import { browserSession, delay } from './browser-session.mjs';
import { startCorpusServer } from './local-corpus-check.mjs';

// Public, synthetic-only browser qualification. Files are generated locally and
// never leave the browser; rendering is verified against declared stored values.
const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'artifacts/browser-dicomdir');
const media = {
    standard: createDicomdirMedia(), multi: createDicomdirMedia({ multiPatient: true, lastRootRecord: 'last-image' }),
    later: createDicomdirMedia({ later: true, caseVariant: true, folder: 'LATER_MEDIA' }),
    staleZero: createDicomdirMedia({ later: true, lastRootOffset: 0, folder: 'STALE_ZERO_MEDIA' }),
    staleOutside: createDicomdirMedia({ later: true, lastRootOffset: 1, folder: 'STALE_OUTSIDE_MEDIA' }),
    missing: createDicomdirMedia({ missingReference: true }),
    malformed: createDicomdirMedia({ malformed: true }),
    unsafe: createDicomdirMedia({ unsafeReference: true }),
    mismatch: createDicomdirMedia({ uidMismatch: true })
};
const quote = JSON.stringify, checks = [];
const record = (name, details = {}) => { checks.push({ name, ...details }); console.log(`PASS ${name}`); };
let browser, server, temporary;
const evaluate = expression => browser.evaluate(expression);
const run = source => evaluate(`(async () => { ${source} })()`);
const click = selector => evaluate(`(() => { const node=window.__shadow.querySelector(${quote(selector)});if(!node)throw new Error('Missing media-library control: '+${quote(selector)});node.click(); })()`);
const state = () => evaluate('({state:window.__v.getState(),library:window.__v.getLocalLibraryState(),workspace:window.__v.getWorkspaceState(),performance:window.__v.getPerformance(),annotations:window.__v.getAnnotationState(),uploads:window.__qa.uploads,draws:window.__qa.draws,workers:window.__qa.workers,message:window.__shadow.querySelector(".local-library-message")?.textContent,mediaMessage:window.__shadow.querySelector(".local-library-media")?.textContent,panes:Array.from(window.__shadow.querySelectorAll(".workspace-pane")).map(pane=>({slot:Number(pane.dataset.slot),empty:!pane.querySelector("[data-pane-id=viewport-empty]").hidden,loading:!pane.querySelector("[data-pane-id=viewport-loading]").hidden,frameLoading:pane.classList.contains("frame-loading")}))})');
const settled = async () => browser.until('!window.__v.getLocalLibraryState().busy&&!window.__v.getState().busy','The media operation did not settle.');
const selectFolder = async name => {
    await evaluate(`(()=>{const input=window.__shadow.getElementById('folder-input'),transfer=new DataTransfer();for(const file of window.__mediaFiles(${quote(name)}))transfer.items.add(file);input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await settled();
};
const noPrivate = value => assert.ok(!/"(?:patientName|patientId|issuerOfPatientId|patientBirthDate|studyUid|seriesUid|sopUid|studyDate|fileId|path|points|samples|pixelData)"\s*:|2\.25\.997|SYNTHETIC\^ALPHA|SYNTHETIC_MEDIA_ISSUER/.test(JSON.stringify(value)), 'Automatic operational state/events must not expose media identifiers, paths or pixel payloads.');
const recoveryWarning = 'The DICOMDIR last-root pointer was inconsistent. Verified forward directory links were used.';
const verifyRecoveryNotice = async () => {
    const notice = await evaluate('({text:window.__shadow.querySelector(".local-library-media").textContent,kind:window.__shadow.querySelector(".local-library-media").dataset.kind,hidden:window.__shadow.querySelector(".local-library-media").hidden,errorHidden:window.__shadow.getElementById("error-banner").hidden})');
    assert.equal(notice.hidden,false);assert.equal(notice.kind,'warning');assert.ok(notice.text.includes(recoveryWarning));assert.equal(notice.errorHidden,true);
};
const capture = async name => { await browser.screenshot(name);await copyFile(resolve(temporary,'chrome',name+'.png'),resolve(output,name+'.png')); };
const verifyDraw = (observed, slot, values) => {
    const draw=observed.draws.findLast(item=>item.slot===slot&&item.pixels);
    assert.ok(draw,`Pane ${slot} did not render.`);assert.deepEqual(draw.samples,values);
    const window=observed.workspace.viewports[slot].window;
    for(let index=0;index<4;index++){
        const expected=Math.round(Math.max(0,Math.min(1,(values[index]-(window.center-.5))/(window.width-1)+.5))*255);
        assert.ok(draw.pixels[index].slice(0,3).every(value=>Math.abs(value-expected)<=2),JSON.stringify({slot,index,expected,actual:draw.pixels[index]}));
        assert.equal(draw.pixels[index][3],255);
    }
};

try {
    await mkdir(output,{recursive:true});await rm(resolve(output,'failure.json'),{force:true});await rm(resolve(output,'results.json'),{force:true});
    temporary=await mkdtemp(join(tmpdir(),'easi-view-dicomdir-browser-'));
    const host=resolve(temporary,'host');await mkdir(host);
    const buildInfo=JSON.parse(await readFile(resolve(root,'dist/build-info.json'),'utf8'));
    await writeFile(resolve(host,'fixtures.json'),JSON.stringify(Object.fromEntries(Object.entries(media).map(([name,value])=>[name,{expected:value.expected,files:value.files.map(({bytes,...file})=>({...file,encoded:Buffer.from(bytes).toString('base64')}))}]))));
    await writeFile(resolve(host,'index.html'),'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./host.css"></head><body><main id="mount"></main><script type="module" src="./host.js"></script></body></html>');
    await writeFile(resolve(host,'host.css'),'body{margin:0;background:#09121b}#mount{height:1080px;width:100%}');
    await writeFile(resolve(host,'host.js'),`
import {createViewer} from '/assets/easi-view.js';
const media=await(await fetch('./fixtures.json')).json();
window.__qa={media,events:[],uploads:[],draws:[],workers:{created:0,terminated:0,active:0},readKeys:[]};
const qa=window.__qa,NativeWorker=window.Worker;
window.Worker=class extends NativeWorker{constructor(...args){super(...args);qa.workers.created++;qa.workers.active++;this.__qaTerminated=false;}terminate(){if(!this.__qaTerminated){this.__qaTerminated=true;qa.workers.terminated++;qa.workers.active--;}return super.terminate();}};
const originalUpload=WebGL2RenderingContext.prototype.texImage2D,originalDraw=WebGL2RenderingContext.prototype.drawArrays;
WebGL2RenderingContext.prototype.texImage2D=function(...args){if(args[3]===2&&args[4]===2&&args[8]?.length===4){this.canvas.__qaSamples=Array.from(args[8]);qa.uploads.push({samples:Array.from(args[8]),slot:Number(this.canvas.closest('.workspace-pane')?.dataset.slot??0)});}return originalUpload.apply(this,args);};
WebGL2RenderingContext.prototype.drawArrays=function(...args){const result=originalDraw.apply(this,args);if(this.canvas.__qaSamples){const program=this.getParameter(this.CURRENT_PROGRAM),matrix=program&&this.getUniform(program,this.getUniformLocation(program,'imageToClip'));let pixels=null;if(matrix){pixels=[0,1,2,3].map(i=>{const x=i%2+.5,y=Math.floor(i/2)+.5,clipX=matrix[0]*x+matrix[3]*y+matrix[6],clipY=matrix[1]*x+matrix[4]*y+matrix[7],rgba=new Uint8Array(4);this.readPixels(Math.floor((clipX+1)*this.canvas.width/2),Math.floor((clipY+1)*this.canvas.height/2),1,1,this.RGBA,this.UNSIGNED_BYTE,rgba);return Array.from(rgba);});}qa.draws.push({samples:[...this.canvas.__qaSamples],pixels,slot:Number(this.canvas.closest('.workspace-pane')?.dataset.slot??0)});}return result;};
window.__mediaFiles=(name,{slow=0}={})=>media[name].files.map(f=>{const file=new File([Uint8Array.from(atob(f.encoded),c=>c.charCodeAt(0))],f.name);Object.defineProperty(file,'webkitRelativePath',{value:f.path});const original=file.stream.bind(file);Object.defineProperty(file,'stream',{value:()=>{qa.readKeys.push(name+':'+f.key);const reader=original().getReader();return new ReadableStream({async pull(controller){if(slow)await new Promise(done=>setTimeout(done,slow));const next=await reader.read();if(next.done)controller.close();else controller.enqueue(next.value);},cancel(reason){return reader.cancel(reason);}});}});return file;});
window.__mediaEntries=name=>{const roots=[];for(const fixture of media[name].files){let siblings=roots;const components=fixture.path.split('/');for(let index=0;index<components.length;index++){const name=components[index],leaf=index===components.length-1;let entry=siblings.find(item=>item.name===name);if(!entry){if(leaf){const file=new File([Uint8Array.from(atob(fixture.encoded),c=>c.charCodeAt(0))],fixture.name);entry={name,isFile:true,isDirectory:false,file(done){queueMicrotask(()=>done(file));}};}else{const children=[];entry={name,isFile:false,isDirectory:true,children,createReader(){let offset=0;return{readEntries(done){const batch=children.slice(offset,offset+2);offset+=batch.length;queueMicrotask(()=>done(batch));}};}};}siblings.push(entry);}siblings=entry.children;}}return roots;};
window.__dropMedia=name=>{const entries=window.__mediaEntries(name),event=new Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{types:['Files'],items:entries.map(entry=>({kind:'file',webkitGetAsEntry(){return entry;}})),files:[]}});window.__shadow.querySelector('.viewer-shell').dispatchEvent(event);};
window.__resetViewer=async()=>{if(window.__v){window.__v.dispose();await window.__v.whenDisposed();}window.__v=createViewer(document.getElementById('mount'),{initialDemo:null});for(const type of ['sourcechange','framechange','layoutchange','viewportchange','syncchange','annotationchange','error','dispose','librarychange'])window.__v.on(type,detail=>qa.events.push({type,detail}));await window.__v.ready;window.__shadow=document.getElementById('mount').querySelector('easi-view-embed').shadowRoot;};await window.__resetViewer();window.__ready=true;
`);
    server=await startCorpusServer({dist:resolve(root,'dist'),host,styleHash:buildInfo.inlineStyleSha256});
    browser=await browserSession(resolve(temporary,'chrome'));
    await browser.send('Emulation.setDeviceMetricsOverride',{width:1540,height:1120,deviceScaleFactor:1,mobile:false});
    await browser.send('Page.navigate',{url:server.url});await browser.until('window.__ready','The generated media host did not mount.');
    let observed=await state();assert.equal(observed.state.image,null);assert.equal(observed.performance.resources.workerCount,0);
    assert.equal(await evaluate('window.__shadow.getElementById("folder-input").hasAttribute("webkitdirectory")'),true);
    record('an empty viewer offers a local-media folder input without creating pixel workers');

    await selectFolder('multi');
    let catalog=await evaluate('window.__v.getLocalCatalog()');
    assert.equal(catalog.patients.length,2);assert.equal(catalog.counts.studies,3);assert.equal(catalog.counts.series,4);assert.equal(catalog.counts.instances,5);
    assert.ok(!JSON.stringify(catalog).includes('Unreferenced decoy'));assert.ok(!JSON.stringify(catalog).includes('2.25.997.99'));
    observed=await state();assert.equal(observed.state.image,null);assert.equal(observed.performance.resources.workerCount,0);assert.equal(observed.performance.resources.encodedBytes,0);assert.equal(observed.performance.resources.decodedCacheBytes,0);assert.equal(observed.uploads.length,0);assert.equal(observed.workers.created,0);
    assert.match(observed.mediaMessage,/DICOMDIR/i);assert.ok(!await evaluate('window.__qa.readKeys.some(key=>key.endsWith(":decoy")||key.endsWith(":sidecar"))'));await verifyRecoveryNotice();
    record('a DICOMDIR whose last-root pointer targets an IMAGE record indexes all patients through verified forward links, warns visibly, excludes decoys and waits for patient choice without decoding');
    noPrivate(observed.state);noPrivate(observed.library);noPrivate(observed.workspace);
    const alpha=catalog.patients.find(patient=>patient.patientId==='MEDIA_ALPHA'),beta=catalog.patients.find(patient=>patient.patientId==='MEDIA_BETA');assert.ok(alpha&&beta);
    const current=alpha.studies.find(study=>study.studyUid===media.multi.expected.currentStudyUid),prior=alpha.studies.find(study=>study.studyUid===media.multi.expected.priorStudyUid);
    assert.equal(current.series.length,2);assert.equal(current.instanceCount,3);
    await click('[data-local-action="select-patient"][data-patient-id="'+alpha.id+'"]');await settled();
    await click('[data-local-action="open-study"][data-study-id="'+current.id+'"]');await settled();
    observed=await state();assert.equal(observed.library.currentStudyId,current.id);assert.equal(observed.state.frameCount,2);verifyDraw(observed,0,media.multi.images.find(image=>image.key==='current-a').values);
    await evaluate('window.__v.setFrame(1)');observed=await state();verifyDraw(observed,0,media.multi.images.find(image=>image.key==='current-b').values);
    record('opening a media study displays and navigates its referenced extensionless instances with independently checked stored samples and framebuffer output');

    const soft=current.series.find(series=>series.seriesUid===media.multi.expected.softSeriesUid);
    await evaluate(`(()=>{const input=window.__shadow.querySelector('[data-local-study-series="${current.id}"]');if(!input)throw new Error('Missing study series selector');input.value=${quote(soft.id)};input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await click('[data-local-action="open-study"][data-study-id="'+current.id+'"]');await settled();observed=await state();assert.equal(observed.state.frameCount,1);verifyDraw(observed,0,media.multi.images.find(image=>image.key==='current-soft').values);
    assert.ok(await evaluate(`window.__shadow.querySelector('.local-library-study[data-study-id="${current.id}"]').textContent.includes('Media axial lung')&&window.__shadow.querySelector('.local-library-study[data-study-id="${current.id}"]').textContent.includes('Media soft tissue')`));
    await evaluate('window.__v.addAnnotation({tool:"length",points:[{x:.5,y:.5},{x:1.5,y:.5}]})');
    await click('[data-local-action="compare-study"][data-study-id="'+prior.id+'"]');await settled();observed=await state();assert.equal(observed.workspace.layout,2);assert.ok(observed.panes.every(pane=>!pane.empty&&!pane.loading&&!pane.frameLoading));verifyDraw(observed,0,media.multi.images.find(image=>image.key==='current-soft').values);verifyDraw(observed,1,media.multi.images.find(image=>image.key==='prior').values);assert.equal(observed.annotations.count,1);assert.equal(observed.workspace.synchronization.slice,false);
    record('all series remain accessible from the whole-study timeline and explicit prior comparison displays both examinations without automatic spatial linking');
    await capture('dicomdir-comparison');

    const beforeLater=await state();await selectFolder('later');observed=await state();catalog=await evaluate('window.__v.getLocalCatalog()');assert.equal(catalog.counts.instances,6);assert.equal(catalog.counts.studies,4);assert.deepEqual(observed.workspace,beforeLater.workspace);assert.equal(observed.annotations.count,1);assert.equal(observed.uploads.length,beforeLater.uploads.length);assert.match(observed.mediaMessage,/DICOMDIR/i);
    record('a later disc with lowercase directory name and case-varied nested paths imports additively while preserving working panes and measurements');

    for (const fixture of ['staleZero','staleOutside']) {
        const beforeRecovery=await state(),beforeCatalog=await evaluate('window.__v.getLocalCatalog()');
        const recovered=await evaluate(`window.__v.importLocalFiles(window.__mediaFiles(${quote(fixture)}))`);
        observed=await state();catalog=await evaluate('window.__v.getLocalCatalog()');
        assert.equal(recovered.added,1);assert.equal(recovered.failed,0);assert.equal(recovered.media.resolved,1);assert.ok(recovered.media.warnings.includes(recoveryWarning));
        assert.equal(catalog.counts.instances,beforeCatalog.counts.instances+1);assert.equal(catalog.counts.patients,beforeCatalog.counts.patients);assert.equal(catalog.counts.studies,beforeCatalog.counts.studies);
        assert.deepEqual(observed.workspace,beforeRecovery.workspace);assert.equal(observed.annotations.count,1);assert.equal(observed.uploads.length,beforeRecovery.uploads.length);assert.ok(observed.panes.every(pane=>!pane.empty&&!pane.loading&&!pane.frameLoading));await verifyRecoveryNotice();
        verifyDraw(observed,0,media.multi.images.find(image=>image.key==='current-soft').values);verifyDraw(observed,1,media.multi.images.find(image=>image.key==='prior').values);
        record(`${fixture==='staleZero'?'a zero':'an out-of-record'} redundant last-root pointer recovers with an explicit notice while additive import preserves both rendered comparison panes and measurements`);
    }
    await capture('dicomdir-recovered-last-root');

    const beforeMalformed=await state(),countsBeforeMalformed=await evaluate('window.__v.getLocalCatalog().counts');
    const malformed=await evaluate('window.__v.importLocalFiles(window.__mediaFiles("malformed")).then(()=>({rejected:false}),error=>({rejected:true,name:error.name}))');assert.equal(malformed.rejected,true);
    observed=await state();assert.deepEqual(await evaluate('window.__v.getLocalCatalog().counts'),countsBeforeMalformed);assert.deepEqual(observed.workspace,beforeMalformed.workspace);assert.equal(observed.annotations.count,1);
    record('malformed directory links are rejected atomically without scanning unrelated files or replacing an active comparison');

    await selectFolder('malformed');
    await browser.until('!window.__shadow.getElementById("error-banner").hidden','The folder handler did not report its malformed media import.');
    assert.equal(await evaluate('window.__shadow.getElementById("error-title").textContent'),'Unable to index these local files');
    const beforeRetry=await state(),countsBeforeRetry=await evaluate('window.__v.getLocalCatalog().counts');
    assert.deepEqual(beforeRetry.workspace,beforeMalformed.workspace);assert.deepEqual(countsBeforeRetry,countsBeforeMalformed);assert.equal(beforeRetry.annotations.count,1);
    await selectFolder('staleOutside');observed=await state();catalog=await evaluate('window.__v.getLocalCatalog()');await verifyRecoveryNotice();
    assert.equal(catalog.counts.instances,countsBeforeRetry.instances+1);assert.deepEqual(observed.workspace,beforeRetry.workspace);assert.equal(observed.annotations.count,1);assert.equal(observed.uploads.length,beforeRetry.uploads.length);
    assert.equal(await evaluate('window.__shadow.getElementById("status-text").textContent'),'Local library updated');
    verifyDraw(observed,0,media.multi.images.find(image=>image.key==='current-soft').values);verifyDraw(observed,1,media.multi.images.find(image=>image.key==='prior').values);
    record('retrying a failed folder import clears its stale fatal banner, shows the recoverable DICOMDIR notice and preserves both rendered comparison panes and measurements');
    const beforeUnsafe=await state(),unsafe=await evaluate('window.__v.importLocalFiles(window.__mediaFiles("unsafe"))');
    assert.equal(unsafe.media.invalid,1);assert.equal(unsafe.media.resolved,3);assert.equal(unsafe.added,3);observed=await state();assert.deepEqual(observed.workspace,beforeUnsafe.workspace);assert.equal(observed.annotations.count,1);assert.match(observed.mediaMessage,/1 invalid/);assert.equal(await evaluate('window.__qa.readKeys.includes("unsafe:current-a")'),false);
    record('unsafe file identifiers are counted and skipped before file reads while other valid references import without replacing working panes');

    const beforeCancel=await state(),countsBeforeCancel=await evaluate('window.__v.getLocalCatalog().counts');
    await evaluate('(()=>{window.__pendingImport=window.__v.importLocalFiles(window.__mediaFiles("standard",{slow:600})).then(()=>({aborted:false}),error=>({aborted:error.name==="AbortError"}));return true;})()');
    await browser.until('window.__v.getLocalLibraryState().indexing','The slow directory import did not start.');
    assert.equal(await evaluate('window.__shadow.querySelector("[data-local-action=cancel-import]").hidden'),false);
    await click('[data-local-action="cancel-import"]');assert.equal((await evaluate('window.__pendingImport')).aborted,true);await settled();observed=await state();assert.deepEqual(await evaluate('window.__v.getLocalCatalog().counts'),countsBeforeCancel);assert.deepEqual(observed.workspace,beforeCancel.workspace);assert.equal(observed.annotations.count,1);
    record('the visible cancel action aborts a directory import and leaves catalog, current study, comparison and measurements intact');

    await evaluate('window.__resetViewer()');await selectFolder('missing');catalog=await evaluate('window.__v.getLocalCatalog()');observed=await state();assert.equal(catalog.counts.instances,3);assert.equal(catalog.counts.studies,2);assert.equal(catalog.counts.series,3);assert.equal(observed.state.frameCount,1);assert.ok(observed.library.currentStudyId);assert.match(observed.mediaMessage,/DICOMDIR/i);assert.match(observed.mediaMessage,/1.*missing|missing.*1/i);verifyDraw(observed,0,media.missing.images.find(image=>image.key==='current-a').values);
    record('a missing directory reference is counted visibly while available series import and a single initial patient opens normally');
    await capture('dicomdir-missing-reference');

    await evaluate('window.__resetViewer()');
    const mismatch=await evaluate('window.__v.importLocalFiles(window.__mediaFiles("mismatch"))');
    catalog=await evaluate('window.__v.getLocalCatalog()');assert.equal(catalog.counts.instances,3);assert.equal(mismatch.failed,1);assert.ok(!catalog.patients.flatMap(patient=>patient.studies).flatMap(study=>study.series).flatMap(series=>series.instances).some(instance=>instance.sopUid===media.mismatch.images.find(image=>image.key==='current-b').sopUid));
    assert.match((await state()).message,/1.*skipped|1.*mismatch|mismatch.*1/i);
    record('referenced SOP identifiers are validated against actual file metadata and mismatched images are reported instead of silently substituting a different object');

    await evaluate('window.__resetViewer()');await selectFolder('standard');observed=await state();catalog=await evaluate('window.__v.getLocalCatalog()');assert.equal(catalog.counts.instances,4);assert.equal(observed.state.frameCount,2);assert.ok(observed.library.currentStudyId);verifyDraw(observed,0,media.standard.images.find(image=>image.key==='current-a').values);
    record('a complete single-patient disc automatically opens its current study while all prior examinations and remaining series stay available on demand');

    await evaluate('window.__resetViewer()');await evaluate('window.__dropMedia("standard")');
    await browser.until('window.__v.getLocalLibraryState().instances===4&&window.__v.getLocalLibraryState().currentStudyId&&!window.__v.getLocalLibraryState().busy&&!window.__v.getState().busy','The dropped directory tree did not import its references.');
    observed=await state();catalog=await evaluate('window.__v.getLocalCatalog()');assert.equal(catalog.counts.instances,4);assert.equal(catalog.counts.studies,2);assert.equal(catalog.counts.series,3);assert.match(observed.mediaMessage,/DICOMDIR/i);verifyDraw(observed,0,media.standard.images.find(image=>image.key==='current-a').values);
    record('dropping a nested media directory preserves relative paths from paginated filesystem entries and opens extensionless referenced images without File.webkitRelativePath');
    await browser.send('Emulation.setDeviceMetricsOverride',{width:780,height:1040,deviceScaleFactor:1,mobile:false});await delay(100);await evaluate('if(window.__shadow.getElementById("toggle-library").getAttribute("aria-expanded")!=="true")window.__shadow.getElementById("toggle-library").click()');await capture('dicomdir-narrow');
    const narrow=await evaluate('(()=>{const panel=window.__shadow.querySelector(".library-panel"),rect=panel.getBoundingClientRect();return{width:innerWidth,document:document.documentElement.scrollWidth,panel:{left:rect.left,width:rect.width,display:getComputedStyle(panel).display},studies:window.__shadow.querySelectorAll(".local-library-study").length};})()');assert.ok(narrow.document<=narrow.width+1);assert.notEqual(narrow.panel.display,'none');assert.ok(narrow.panel.left>=0&&narrow.panel.width>200&&narrow.panel.width<=narrow.width);assert.equal(narrow.studies,2);
    record('the local-media timeline remains usable at a narrow embedded width without page overflow');

    const final=await run('window.__v.dispose();await window.__v.whenDisposed();return {performance:window.__v.getPerformance(),library:window.__v.getLocalLibraryState(),events:window.__qa.events,workers:window.__qa.workers};');
    assert.equal(final.performance.resources.workerCount,0);assert.equal(final.performance.resources.encodedBytes,0);assert.equal(final.performance.resources.encodedCacheBytes,0);assert.equal(final.performance.resources.decodedCacheBytes,0);assert.equal(final.performance.resources.thumbnailBytes,0);assert.equal(final.workers.active,0);assert.equal(final.workers.created,final.workers.terminated);noPrivate(final.events);noPrivate(final.library);
    assert.equal(JSON.parse(await readFile(resolve(root,'dist/build-info.json'),'utf8')).sourceDigest,buildInfo.sourceDigest,'Viewer assets changed during qualification.');assert.equal(browser.errors.length,0);assert.equal(browser.consoleErrors.length,0);
    const uploads=browser.requests.filter(request=>!['GET','HEAD'].includes(request.method)),external=browser.requests.filter(request=>!request.url.startsWith(new URL(server.url).origin)&&!request.url.startsWith('data:')&&!request.url.startsWith('blob:'));
    assert.equal(uploads.length,0);assert.equal(external.length,0);assert.equal(server.requests.rejectedMethods,0);
    record('all media imports stay local with no uploads, external requests, browser errors or leaked workers and pixel resources after disposal');
    await writeFile(resolve(output,'results.json'),JSON.stringify({passed:checks.length,checks,sourceDigest:buildInfo.sourceDigest,harnessSha256:createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'),originalImagingFilesUsed:false,uploads:0,externalRequests:0,browserExceptions:0,consoleErrors:0},null,2)+'\n');
    console.log('DICOMDIR browser checks: '+checks.length+' passed.');
} catch(error){
    await writeFile(resolve(output,'failure.json'),JSON.stringify({checks,error:{name:error.name,message:error.message,stack:error.stack},browserExceptions:browser?.errors??[],consoleErrors:browser?.consoleErrors??[]},null,2)+'\n');throw error;
} finally {browser?.close();await server?.close();if(temporary)await rm(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
