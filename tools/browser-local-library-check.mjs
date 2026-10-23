import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createLocalLibraryFixtures } from '../test/local-library-fixtures.js';
import { browserSession, delay } from './browser-session.mjs';
import { startCorpusServer } from './local-corpus-check.mjs';

// Fully local, generated-only browser qualification. An isolated Chrome profile
// and a read-only static server keep local image imports off the network.
const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'artifacts/browser-local-library');
const fixtures = createLocalLibraryFixtures();
const quote = JSON.stringify;
const checks = [];
const record = (name, details = {}) => { checks.push({ name, ...details }); console.log(`PASS ${name}`); };
let browser, server, temporary;
const evaluate = expression => browser.evaluate(expression);
const run = source => evaluate(`(async () => { ${source} })()`);
const click = selector => evaluate(`(() => { const node=window.__shadow.querySelector(${quote(selector)}); if(!node)throw new Error('Missing local library control: '+${quote(selector)}); node.click(); })()`);
const capture = async name => { await browser.screenshot(name);await copyFile(resolve(temporary,'chrome',name+'.png'),resolve(output,name+'.png')); };
const state = () => evaluate('({state:window.__v.getState(),workspace:window.__v.getWorkspaceState(),performance:window.__v.getPerformance(),library:window.__v.getLocalLibraryState(),annotations:window.__v.getAnnotationState(),uploads:window.__qa.uploads,draws:window.__qa.draws,workers:window.__qa.workers,panes:Array.from(window.__shadow.querySelectorAll(".workspace-pane")).map(pane=>({slot:Number(pane.dataset.slot),active:pane.classList.contains("active"),emptyVisible:!pane.querySelector("[data-pane-id=viewport-empty]").hidden,loadingVisible:!pane.querySelector("[data-pane-id=viewport-loading]").hidden,frameLoading:pane.classList.contains("frame-loading"),frameLabel:pane.querySelector("[data-pane-id=frame-overlay]")?.textContent}))})');
const key = async (value, code) => { const native=value==='Enter'?{windowsVirtualKeyCode:13,nativeVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'}:value===' '?{windowsVirtualKeyCode:32,nativeVirtualKeyCode:32,text:' ',unmodifiedText:' '}:{};await browser.send('Input.dispatchKeyEvent', { type:'keyDown', key:value, code,...native }); await browser.send('Input.dispatchKeyEvent', { type:'keyUp', key:value, code,...native }); };
const noPrivate = value => assert.ok(!/"(?:patientName|patientId|issuerOfPatientId|patientBirthDate|studyUid|seriesUid|sopUid|studyDate|studyTime|points|samples|pixelData)"\s*:|2\.25\.998|SYNTHETIC\^ALPHA|SYNTHETIC_HOSPITAL/.test(JSON.stringify(value)), 'Automatic operational snapshots/events must not expose catalog metadata or image payloads.');
const assertResources = value => {
    assert.ok(value.workspace.decodedBytes <= value.workspace.cacheBudget);
    assert.ok(value.workspace.encodedBytes <= value.workspace.encodedCacheBudget);
    assert.ok(value.workspace.thumbnailBytes <= 4 * 1024 * 1024);
};

try {
    await mkdir(output, { recursive:true });
    await rm(resolve(output,'failure.json'),{force:true});
    await rm(resolve(output,'results.json'),{force:true});
    temporary = await mkdtemp(join(tmpdir(), 'easi-view-local-library-browser-'));
    const host = resolve(temporary, 'host'); await mkdir(host);
    const buildInfo = JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8'));
    await writeFile(resolve(host, 'fixtures.json'), JSON.stringify(fixtures.map(({bytes,...metadata}) => ({...metadata,encoded:Buffer.from(bytes).toString('base64')}))));
    await writeFile(resolve(host, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./host.css"></head><body><button id="host-action">Host action</button><main id="mount"></main><script type="module" src="./host.js"></script></body></html>');
    await writeFile(resolve(host, 'host.css'), 'body{margin:0;background:#09121b}#host-action{height:28px}#mount{height:1000px;width:100%}');
    await writeFile(resolve(host, 'host.js'), `
import {createViewer} from '/assets/easi-view.js';
const fixtures=await(await fetch('./fixtures.json')).json();
window.__qa={fixtures,events:[],uploads:[],draws:[],workers:{created:0,terminated:0,active:0}};
const qa=window.__qa,NativeWorker=window.Worker;
window.Worker=class extends NativeWorker{constructor(...args){super(...args);qa.workers.created++;qa.workers.active++;this.__qaTerminated=false;}terminate(){if(!this.__qaTerminated){this.__qaTerminated=true;qa.workers.terminated++;qa.workers.active--;}return super.terminate();}};
const originalUpload=WebGL2RenderingContext.prototype.texImage2D,originalDraw=WebGL2RenderingContext.prototype.drawArrays;
WebGL2RenderingContext.prototype.texImage2D=function(...args){if(args[3]===2&&args[4]===2&&args[8]?.length===4){this.canvas.__qaSamples=Array.from(args[8]);qa.uploads.push({samples:Array.from(args[8]),slot:Number(this.canvas.closest('.workspace-pane')?.dataset.slot??0)});}return originalUpload.apply(this,args);};
WebGL2RenderingContext.prototype.drawArrays=function(...args){const result=originalDraw.apply(this,args);if(this.canvas.__qaSamples){const program=this.getParameter(this.CURRENT_PROGRAM),matrix=program&&this.getUniform(program,this.getUniformLocation(program,'imageToClip'));let pixels=null;if(matrix){pixels=[0,1,2,3].map(i=>{const x=i%2+.5,y=Math.floor(i/2)+.5,clipX=matrix[0]*x+matrix[3]*y+matrix[6],clipY=matrix[1]*x+matrix[4]*y+matrix[7],rgba=new Uint8Array(4);this.readPixels(Math.floor((clipX+1)*this.canvas.width/2),Math.floor((clipY+1)*this.canvas.height/2),1,1,this.RGBA,this.UNSIGNED_BYTE,rgba);return Array.from(rgba);});}qa.draws.push({samples:[...this.canvas.__qaSamples],pixels,slot:Number(this.canvas.closest('.workspace-pane')?.dataset.slot??0)});}return result;};
const files=new Map(fixtures.map(f=>[f.key,new File([Uint8Array.from(atob(f.encoded),c=>c.charCodeAt(0))],f.name)]));
window.__file=key=>files.get(key);window.__files=keys=>keys.map(window.__file);
window.__malformed=()=>new File([Uint8Array.from([1,2,3,4,5,6,7,8])],'malformed');
window.__slowFile=(key,milliseconds=500)=>{const original=files.get(key),input=new File([original],original.name),stream=input.stream.bind(input);Object.defineProperty(input,'stream',{configurable:true,value:()=>{const reader=stream().getReader();return new ReadableStream({async pull(controller){await new Promise(done=>setTimeout(done,milliseconds));const next=await reader.read();if(next.done)controller.close();else controller.enqueue(next.value);},cancel(reason){return reader.cancel(reason);}});}});return input;};
window.__resetViewer=async()=>{if(window.__v){window.__v.dispose();await window.__v.whenDisposed();}window.__v=createViewer(document.getElementById('mount'),{initialDemo:null});for(const type of ['sourcechange','framechange','layoutchange','viewportchange','syncchange','annotationchange','error','dispose','librarychange'])window.__v.on(type,detail=>qa.events.push({type,detail}));await window.__v.ready;window.__shadow=document.getElementById('mount').querySelector('easi-view-embed').shadowRoot;};await window.__resetViewer();window.__ready=true;
`);
    server = await startCorpusServer({dist:resolve(root,'dist'),host,styleHash:buildInfo.inlineStyleSha256});
    browser = await browserSession(resolve(temporary,'chrome'));
    await browser.send('Emulation.setDeviceMetricsOverride',{width:1540,height:1120,deviceScaleFactor:1,mobile:false});
    await browser.send('Page.navigate',{url:server.url});
    await browser.until('window.__ready','Local library host did not mount.');

    let observed = await state();
    assert.equal(observed.state.image,null);assert.equal(observed.performance.resources.workerCount,0);
    assert.equal(await evaluate('window.__shadow.getElementById("file-input").hasAttribute("accept")'),false);
    record('an empty host mounts with no decoded pixels and local file selection permits arbitrary or missing extensions');

    const initialKeys=['current-lung-1','current-lung-2','current-soft','other-patient'];
    const initial=await evaluate(`window.__v.importLocalFiles(window.__files(${quote(initialKeys)}))`);
    noPrivate(initial);
    let catalog=await evaluate('window.__v.getLocalCatalog()');
    assert.equal(catalog.patients.length,2);
    const alpha=catalog.patients.find(p=>p.issuerOfPatientId==='SYNTHETIC_HOSPITAL_A');
    const beta=catalog.patients.find(p=>p.issuerOfPatientId==='SYNTHETIC_HOSPITAL_B');
    assert.ok(alpha&&beta);assert.notEqual(alpha.id,beta.id);assert.equal(alpha.patientId,beta.patientId);
    const current=alpha.studies.find(s=>s.studyUid===fixtures.find(f=>f.key==='current-lung-1').studyUid);
    assert.equal(current.series.length,2);assert.equal(current.instanceCount,3);assert.equal(current.frameCount,3);
    observed=await state();assert.equal(observed.state.image,null);assert.equal(observed.performance.resources.encodedBytes,0);assert.equal(observed.performance.resources.encodedCacheBytes,0);assert.equal(observed.performance.resources.decodedCacheBytes,0);assert.equal(observed.performance.resources.workerCount,0);assert.equal(observed.workers.created,0);assert.equal(observed.uploads.length,0);
    record('multi-patient indexing retains only navigation metadata, preserves issuer-qualified identity and never decodes or materializes image collections');
    await evaluate('(()=>{const view=window.__v.getLocalCatalog();view.patients[0].patientName="CHANGED_BY_HOST";view.patients[0].studies.length=0;})()');
    catalog=await evaluate('window.__v.getLocalCatalog()');assert.ok(!JSON.stringify(catalog).includes('CHANGED_BY_HOST'));assert.equal(catalog.patients.find(p=>p.id===alpha.id).studies.length,1);
    noPrivate(observed.state);noPrivate(observed.workspace);noPrivate(observed.library);
    record('explicit metadata access returns isolated catalog snapshots while default state remains operational');

    await evaluate(`window.__v.selectLocalPatient(${quote(alpha.id)})`);
    await click(`[data-local-action="open-study"][data-study-id="${current.id}"]`);
    await browser.until(`window.__v.getLocalLibraryState().currentStudyId===${quote(current.id)}&&!window.__v.getState().busy&&window.__v.getState().image`,'The selected local current study did not display.');
    observed=await state();assert.equal(observed.state.frameCount,2);assert.equal(observed.workspace.layout,1);assert.deepEqual(observed.uploads.at(-1).samples,fixtures.find(f=>f.key==='current-lung-1').values);assert.ok(observed.draws.some(draw=>draw.slot===0&&draw.samples[0]===100));assertResources(observed);
    await run('await window.__v.setFrame(1);window.__v.setWindow({center:400,width:1000});window.__v.addAnnotation({tool:"length",points:[{x:.5,y:.5},{x:1.5,y:.5}]});');
    assert.equal((await state()).annotations.count,1);
    const beforeAddition=await state(),beforeAdditionEvents=await evaluate('window.__qa.events.length');
    const addedKeys=['prior','prior-soft','same-day','undated','failed-image','untrusted-label','no-identity'];
    await evaluate(`window.__v.importLocalFiles(window.__files(${quote(addedKeys)}))`);
    observed=await state();assert.equal(observed.library.currentStudyId,current.id);assert.equal(observed.state.frameIndex,1);assert.deepEqual(observed.workspace,beforeAddition.workspace);assert.equal(observed.annotations.count,1);assert.equal(observed.uploads.length,beforeAddition.uploads.length);
    const additionEvents=await evaluate(`window.__qa.events.slice(${beforeAdditionEvents})`);assert.ok(additionEvents.every(event=>event.type==='librarychange'));noPrivate(additionEvents);
    catalog=await evaluate('window.__v.getLocalCatalog()');assert.equal(catalog.patients.length,3);
    const indexedAlpha=catalog.patients.find(p=>p.id===alpha.id),findStudy=key=>indexedAlpha.studies.find(s=>s.studyUid===fixtures.find(f=>f.key===key).studyUid);
    const prior=findStudy('prior'),sameDay=findStudy('same-day'),undated=findStudy('undated'),unsupported=findStudy('failed-image');
    assert.equal(undated.studyDate,'');assert.ok(prior&&sameDay&&unsupported);
    const timeline=await evaluate('Array.from(window.__shadow.querySelectorAll(".local-library-study")).map(el=>({id:el.dataset.studyId,date:el.querySelector("time")?.textContent,text:el.textContent}))');
    assert.equal(timeline.find(s=>s.id===sameDay.id).date,'16 Oct 2026');assert.match(timeline.find(s=>s.id===undated.id).date,/not supplied|unknown/i);
    assert.equal(await evaluate('Boolean(window.__catalogUnsafe)||window.__shadow.querySelectorAll("#local-catalog-panel img,#local-catalog-panel svg").length>0'),false);
    record('additive imports preserve the displayed frame, window, measurements and panes; same-day and undated examinations remain selectable and untrusted labels stay text');
    await click('[data-local-action="change-patient"]');
    await evaluate('(()=>{const input=window.__shadow.querySelector(".local-library-search");input.value="SYNTHETIC_HOSPITAL_A";input.dispatchEvent(new Event("input",{bubbles:true}));input.focus();})()');
    await key('ArrowRight','ArrowRight');await key('ArrowDown','ArrowDown');assert.equal((await state()).state.frameIndex,1);
    assert.equal(await evaluate('window.__shadow.querySelectorAll(".local-library-patient-card").length'),1);
    await evaluate('(()=>{const input=window.__shadow.querySelector(".local-library-search");input.value="";input.dispatchEvent(new Event("input",{bubbles:true}));})()');
    await click('[data-local-action="return-patient"]');
    const toggleSelector=`[data-local-action="toggle-study"][data-study-id="${current.id}"]`,priorExpanded=await evaluate(`window.__shadow.querySelector(${quote(toggleSelector)}).getAttribute('aria-expanded')`);
    await evaluate(`window.__shadow.querySelector(${quote(toggleSelector)}).focus()`);await key('Enter','Enter');
    assert.notEqual(await evaluate(`window.__shadow.querySelector(${quote(toggleSelector)}).getAttribute('aria-expanded')`),priorExpanded);
    assert.equal((await state()).state.frameIndex,1);
    record('patient search and native keyboard expansion operate without activating image-navigation shortcuts');
    const duplicate=await evaluate(`window.__v.importLocalFiles(window.__files(${quote(initialKeys)}))`);assert.equal(duplicate.added,0);assert.equal(duplicate.duplicates,initialKeys.length);
    record('re-importing the same selected File objects does not duplicate catalog entries or replace the current examination');

    await click(`[data-local-action="compare-study"][data-study-id="${prior.id}"]`);
    await browser.until(`window.__v.getLocalLibraryState().comparisonStudyId===${quote(prior.id)}&&!window.__v.getState().busy`,'The prior study did not open beside current.');
    observed=await state();assert.equal(observed.workspace.layout,2);assert.ok(observed.workspace.viewports.every(p=>p.assigned));assert.ok(observed.panes.every(pane=>!pane.emptyVisible&&!pane.loadingVisible&&!pane.frameLoading),JSON.stringify(observed.panes));assert.ok(observed.panes.every(pane=>pane.frameLabel&&!/preparing|no image/i.test(pane.frameLabel)),JSON.stringify(observed.panes));assert.equal(observed.library.currentStudyId,current.id);assert.equal(observed.library.comparisonStudyId,prior.id);assert.equal(observed.annotations.count,1);
    assert.equal(observed.workspace.synchronization.slice,false);assert.equal(observed.workspace.synchronization.window,false);assert.equal(observed.workspace.synchronization.camera,false);
    assert.equal(observed.workspace.viewports[0].frameIndex,1);assert.equal(observed.draws.findLast(draw=>draw.slot===0).samples[0],110);assert.equal(observed.draws.findLast(draw=>draw.slot===1).samples[0],300);
    for(const slot of [0,1]){const draw=observed.draws.findLast(draw=>draw.slot===slot&&draw.pixels),window=observed.workspace.viewports[slot].window,expected=fixtures.find(f=>f.key===(slot===0?'current-lung-2':'prior')).values;assert.ok(draw?.pixels);for(let i=0;i<4;i++){const gray=Math.round(Math.max(0,Math.min(1,(expected[i]-(window.center-.5))/(window.width-1)+.5))*255);assert.ok(draw.pixels[i].slice(0,3).every(component=>Math.abs(component-gray)<=2));assert.equal(draw.pixels[i][3],255);}}
    const badges=await evaluate('Array.from(window.__shadow.querySelectorAll(".local-study-badge")).map(el=>({slot:Number(el.closest(".workspace-pane")?.dataset.slot??0),text:el.textContent,hidden:el.hidden}))');
    assert.match(badges.find(b=>b.slot===0).text,/Current.*(?:16 Oct 2026|2026-10-16)/i);assert.match(badges.find(b=>b.slot===1).text,/Comparison.*(?:01 Sep 2026|2026-09-01)/i);
    record('Compare prepares and renders an explicit two-study layout with independent stored-pixel evidence, examination dates and all automatic synchronization off');
    await evaluate(`(()=>{const card=window.__shadow.querySelector('.local-library-study[data-study-id="${current.id}"]'),scroll=window.__shadow.querySelector('.library-scroll');scroll.scrollTop+=card.getBoundingClientRect().top-scroll.getBoundingClientRect().top-10;})()`);
    await capture('comparison-desktop');
    await evaluate('window.__shadow.getElementById("toggle-library").click()');
    await evaluate('if(!window.__shadow.querySelector(".viewer-shell").classList.contains("inspector-hidden"))window.__shadow.getElementById("toggle-inspector").click()');
    await browser.send('Emulation.setDeviceMetricsOverride',{width:780,height:1040,deviceScaleFactor:1,mobile:false});await delay(100);await capture('comparison-narrow');
    await browser.send('Emulation.setDeviceMetricsOverride',{width:1540,height:1120,deviceScaleFactor:1,mobile:false});await delay(100);
    await evaluate('if(window.__shadow.querySelector(".viewer-shell").classList.contains("inspector-hidden"))window.__shadow.getElementById("toggle-inspector").click()');

    await evaluate('window.__v.setActiveViewport(1)');
    await click(`[data-local-action="compare-study"][data-study-id="${undated.id}"]`);
    await browser.until(`window.__v.getLocalLibraryState().comparisonStudyId===${quote(undated.id)}&&!window.__v.getState().busy`,'The undated comparison did not display.');
    observed=await state();assert.equal(observed.library.currentStudyId,current.id);assert.equal(observed.annotations.count,1);assert.ok(observed.draws.some(draw=>draw.slot===1&&draw.samples[0]===500));assert.equal(observed.workspace.activeViewport,0);assert.deepEqual(observed.panes.map(pane=>pane.active),[true,false]);assert.match(await evaluate('window.__shadow.getElementById("active-viewport-label").textContent'),/PANE 1/);
    assert.match(await evaluate('window.__shadow.querySelectorAll(".local-study-badge")[1].textContent'),/not supplied|unknown/i);
    assert.equal(await evaluate(`window.__shadow.querySelector('[data-local-action="compare-study"][data-study-id="${sameDay.id}"]').disabled`),false);
    record('comparison replacement keeps the current role and measurements while supporting same-day and unknown-date examinations');
    const priorSoft=prior.series.find(series=>series.seriesUid===fixtures.find(f=>f.key==='prior-soft').seriesUid);
    await evaluate(`(()=>{const select=window.__shadow.querySelector('.local-library-series-select[data-local-study-series="${prior.id}"]');select.value=${quote(priorSoft.id)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await click(`[data-local-action="compare-study"][data-study-id="${prior.id}"]`);
    await browser.until(`window.__v.getLocalLibraryState().comparisonStudyId===${quote(prior.id)}&&!window.__v.getState().busy`,'The explicitly chosen comparison series did not display.');
    observed=await state();assert.equal(observed.draws.findLast(draw=>draw.slot===1).samples[0],350);assert.equal(observed.workspace.viewports[0].frameIndex,1);assert.equal(observed.annotations.count,1);
    await click(`[data-local-action="compare-study"][data-study-id="${undated.id}"]`);
    await browser.until(`window.__v.getLocalLibraryState().comparisonStudyId===${quote(undated.id)}&&!window.__v.getState().busy`,'The undated comparison could not be restored.');
    record('explicit comparison series selection displays the chosen series while preserving the current frame and measurements');
    const resolvedComparison=await evaluate(`window.__v.compareLocalStudies(${quote(current.id)},${quote(undated.id)})`);assert.equal(resolvedComparison.busy,false);assert.equal((await state()).library.busy,false);assert.equal(await evaluate('window.__qa.events.findLast(event=>event.type==="librarychange").detail.busy'),false);
    record('resolved comparison operations and their final library event report idle after transaction cleanup');
    const beforeQueuedCancel=await state();
    const queuedCancel=await run(`const pending=window.__v.openLocalStudy(${quote(prior.id)}).then(()=>({aborted:false}),error=>({aborted:error.name==='AbortError'}));window.__v.cancelLocalImport();return pending;`);assert.equal(queuedCancel.aborted,true);assert.deepEqual((await state()).workspace,beforeQueuedCancel.workspace);assert.equal((await state()).library.comparisonStudyId,undated.id);
    record('immediate cancellation invalidates a study selection queued before its controller exists and preserves the previous panes');




    const beforeFailure=await state();
    const failed=await evaluate(`window.__v.compareLocalStudies(${quote(current.id)},${quote(unsupported.id)}).then(()=>false,error=>Boolean(error))`);assert.equal(failed,true);
    observed=await state();assert.equal(observed.library.currentStudyId,current.id);assert.equal(observed.library.comparisonStudyId,undated.id);assert.deepEqual(observed.workspace,beforeFailure.workspace);assert.equal(observed.annotations.count,1);assertResources(observed);
    record('a catalogable image that fails pixel validation cannot erase or partially replace a working comparison');

    const beforeCancel=await evaluate('window.__v.getLocalCatalog().counts');
    await evaluate('(()=>{window.__pendingLocalImport=window.__v.importLocalFiles([window.__slowFile("future",500)]).then(()=>({aborted:false}),error=>({aborted:error.name==="AbortError"}));return true;})()');
    await delay(60);await evaluate('window.__v.cancelLocalImport()');
    assert.equal((await evaluate('window.__pendingLocalImport')).aborted,true);assert.deepEqual(await evaluate('window.__v.getLocalCatalog().counts'),beforeCancel);
    observed=await state();assert.equal(observed.library.currentStudyId,current.id);assert.equal(observed.library.comparisonStudyId,undated.id);assert.equal(observed.annotations.count,1);
    record('canceling metadata indexing commits no partial batch and leaves the current comparison usable');
    const partial=await evaluate('window.__v.importLocalFiles([window.__file("future"),window.__malformed()])');assert.equal(partial.added,1);assert.equal(partial.failed,1);noPrivate(partial);
    observed=await state();assert.equal(observed.library.currentStudyId,current.id);assert.equal(observed.library.comparisonStudyId,undated.id);assert.match(await evaluate('window.__shadow.querySelector(".local-library-message").textContent'),/1.*(?:failed|could|not.*index|skipped)/i);
    record('mixed valid and malformed imports report their exact partial outcome without silently dropping a failure or replacing the current study');

    const beforeRacingImports=await evaluate('window.__v.getLocalCatalog().counts');
    await evaluate('(()=>{window.__racingImport=window.__v.importLocalFiles([window.__slowFile("future",700)]).then(()=>({aborted:false}),error=>({aborted:error.name==="AbortError"}));return true;})()');
    await delay(50);
    const latestImport=await evaluate('window.__v.importLocalFiles([window.__file("prior")])');assert.equal(latestImport.duplicates,1);assert.equal((await evaluate('window.__racingImport')).aborted,true);assert.deepEqual(await evaluate('window.__v.getLocalCatalog().counts'),beforeRacingImports);
    const competingImports=await run('return Promise.allSettled([window.__v.importLocalFiles([window.__slowFile("future",700)]),window.__v.importLocalFiles([window.__file("prior")]),window.__v.importLocalFiles([window.__file("current-lung-1")])]).then(results=>results.map(result=>({status:result.status,name:result.reason?.name,duplicates:result.value?.duplicates})));');
    assert.deepEqual(competingImports.map(result=>result.status),['rejected','rejected','fulfilled']);assert.deepEqual(competingImports.slice(0,2).map(result=>result.name),['AbortError','AbortError']);assert.equal(competingImports[2].duplicates,1);assert.deepEqual(await evaluate('window.__v.getLocalCatalog().counts'),beforeRacingImports);
    observed=await state();assert.equal(observed.library.currentStudyId,current.id);assert.equal(observed.library.comparisonStudyId,undated.id);assert.equal(observed.annotations.count,1);
    record('active and same-tick competing imports cancel superseded requests, commit only the latest batch and preserve the working comparison');

    const activeAssociationBefore=await state(),associationCounts=await evaluate('window.__v.getLocalCatalog().counts');
    const activeAssociation=await evaluate(`window.__v.associateLocalPatient(${quote(alpha.id)},${quote(beta.id)},{confirmed:true}).then(()=>false,error=>/measurements/i.test(error.message))`);assert.equal(activeAssociation,true);assert.deepEqual((await state()).workspace,activeAssociationBefore.workspace);assert.deepEqual(await evaluate('window.__v.getLocalCatalog().counts'),associationCounts);assert.equal((await state()).annotations.count,1);
    const unidentified=(await evaluate('window.__v.getLocalCatalog()')).patients.find(patient=>!patient.patientId);
    assert.equal(await evaluate(`window.__v.associateLocalPatient(${quote(unidentified.id)},${quote(alpha.id)}).then(()=>false,error=>true)`),true);
    await click('[data-local-action="change-patient"]');
    await click(`[data-local-action="review-association"][data-patient-id="${unidentified.id}"]`);
    assert.equal(await evaluate('window.__shadow.querySelectorAll(".local-library-association-person").length'),2);
    assert.equal(await evaluate('window.__shadow.querySelector("[data-local-action=confirm-association]").disabled'),true);
    await click('[data-local-association-consent]');
    assert.equal(await evaluate('window.__shadow.querySelector("[data-local-action=confirm-association]").disabled'),false);
    await click('[data-local-action="confirm-association"]');
    await browser.until('window.__v.getLocalCatalog().patients.length===2&&!window.__v.getLocalLibraryState().busy','The explicitly reviewed association did not finish.');
    const associated=(await evaluate('window.__v.getLocalCatalog()')).patients.find(patient=>patient.id===alpha.id);
    assert.equal(associated.originalIdentities.length,2);assert.ok(associated.originalIdentities.some(identity=>identity.patientId===''));assert.ok(associated.studies.some(study=>study.studyUid===fixtures.find(f=>f.key==='no-identity').studyUid));assert.equal((await state()).annotations.count,1);assert.equal((await state()).state.image,null);
    record('active measured records cannot be associated away; an unmeasured outside record requires two-identity review and explicit consent while preserving original metadata and target measurements');

    await click('[data-local-action="change-patient"]');
    await click(`[data-local-action="select-patient"][data-patient-id="${beta.id}"]`);
    await browser.until(`window.__v.getLocalLibraryState().activePatientId===${quote(beta.id)}&&!window.__v.getState().busy`,'The second patient context did not become active.');
    observed=await state();assert.equal(observed.state.image,null);assert.ok(observed.workspace.viewports.every(p=>!p.assigned));assert.equal(observed.annotations.count,0);assert.equal(observed.annotations.canUndo,false);assert.ok(!String(await evaluate('window.__v.exportAnnotations()')).includes('2.25.998.1.1'));
    assert.equal(await evaluate(`window.__shadow.querySelector('[data-study-id="${current.id}"]')===null`),true);
    const resolvedOpen=await evaluate(`window.__v.openLocalStudy(${quote(beta.studies[0].id)})`);assert.equal(resolvedOpen.busy,false);assert.equal((await state()).library.busy,false);assert.equal(await evaluate('window.__qa.events.findLast(event=>event.type==="librarychange").detail.busy'),false);
    observed=await state();assert.deepEqual(observed.uploads.at(-1).samples,fixtures.find(f=>f.key==='other-patient').values);assert.equal(observed.annotations.count,0);
    const betaBefore=await state();const crossPatient=await evaluate(`window.__v.compareLocalStudies(${quote(beta.studies[0].id)},${quote(prior.id)}).then(()=>false,error=>true)`);assert.equal(crossPatient,true);assert.deepEqual((await state()).workspace,betaBefore.workspace);
    record('patient switching clears all old panes and isolates measurement visibility, undo history and exports; cross-patient comparisons are rejected');
    await evaluate(`window.__v.selectLocalPatient(${quote(alpha.id)})`);observed=await state();assert.equal(observed.state.image,null);assert.equal(observed.annotations.count,1);assert.equal(observed.annotations.canUndo,false);
    await evaluate(`window.__v.openLocalStudy(${quote(current.id)})`);await evaluate('window.__v.setFrame(1)');assert.equal((await state()).annotations.frameCount,1);
    record('returning to a patient restores their own bounded session measurements without restoring another patient display or undo history');
    const competingSelections=await run(`return Promise.allSettled([window.__v.openLocalStudy(${quote(prior.id)}),window.__v.selectLocalPatient(${quote(beta.id)})]).then(results=>results.map(result=>({status:result.status,name:result.reason?.name})));`);
    assert.equal(competingSelections[0].status,'rejected');assert.equal(competingSelections[0].name,'AbortError');assert.equal(competingSelections[1].status,'fulfilled');observed=await state();assert.equal(observed.library.activePatientId,beta.id);assert.equal(observed.state.image,null);assert.equal(observed.annotations.count,0);
    await evaluate(`window.__v.selectLocalPatient(${quote(alpha.id)})`);await evaluate(`window.__v.openLocalStudy(${quote(current.id)})`);await evaluate('window.__v.setFrame(1)');
    record('same-tick competing study and patient selections let the latest patient request win without exposing superseded images or measurements');


    await evaluate('window.__shadow.getElementById("toggle-library").click()');
    await browser.send('Emulation.setDeviceMetricsOverride',{width:780,height:1040,deviceScaleFactor:1,mobile:false});await delay(100);
    const narrow=await evaluate('(()=>{const shell=window.__shadow.querySelector(".viewer-shell"),panel=window.__shadow.querySelector(".local-library"),r=panel.getBoundingClientRect();return{document:document.documentElement.scrollWidth,width:innerWidth,shell:shell.scrollWidth,shellWidth:shell.clientWidth,panel:r.width,searchMax:window.__shadow.querySelector(".local-library-search").maxLength};})()');
    assert.ok(narrow.document<=narrow.width+1);assert.ok(narrow.panel>200&&narrow.panel<=narrow.width);assert.equal(narrow.searchMax,256);
    await browser.send('Emulation.setDeviceMetricsOverride',{width:1540,height:1120,deviceScaleFactor:1,mobile:false});await delay(100);
    await browser.screenshot('local-patient-timeline');await copyFile(resolve(temporary,'chrome/local-patient-timeline.png'),resolve(output,'local-patient-timeline.png'));
    record('the patient timeline stays usable at a narrow embedded width with bounded search input and no page overflow');

    await evaluate('window.__v.clearLocalLibrary()');observed=await state();assert.equal((await evaluate('window.__v.getLocalCatalog()')).patients.length,0);assert.equal(observed.state.image,null);assert.equal(observed.annotations.count,0);assert.equal(observed.performance.resources.encodedBytes,0);assert.equal(observed.performance.resources.encodedCacheBytes,0);assert.equal(observed.performance.resources.decodedCacheBytes,0);assert.ok(observed.performance.resources.workerCount<=1);assert.ok(observed.workspace.viewports.every(p=>!p.assigned));
    record('clearing the library releases catalog references, encoded and decoded buffers, pane assignments and patient measurements while retaining at most one idle shared worker');
    await evaluate('(()=>{const input=window.__shadow.getElementById("file-input"),transfer=new DataTransfer();for(const file of window.__files(["current-lung-1","current-lung-2"]))transfer.items.add(file);input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));})()');
    await browser.until('window.__v.getLocalLibraryState().studies===1&&window.__v.getLocalLibraryState().currentStudyId&&window.__v.getState().frameCount===2&&!window.__v.getState().busy&&!window.__v.getLocalLibraryState().busy','The native file-picker change path did not index and show a single patient.');
    const nativeCurrent=await evaluate('window.__v.getLocalLibraryState().currentStudyId');
    await evaluate('(()=>{const input=window.__shadow.getElementById("folder-input"),transfer=new DataTransfer(),original=window.__file("prior"),file=new File([original],"IM000003");Object.defineProperty(file,"webkitRelativePath",{value:"synthetic-disc/study/IM000003"});transfer.items.add(file);input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));})()');
    await browser.until('window.__v.getLocalLibraryState().studies===2&&!window.__v.getLocalLibraryState().busy','The native folder-picker change path did not add a prior examination.');
    observed=await state();assert.equal(observed.library.currentStudyId,nativeCurrent);assert.equal(observed.state.frameCount,2);
    record('native file and folder input events accept extensionless images, automatically open a single initial patient and add later examinations without replacement');
    await evaluate('window.__v.clearLocalLibrary()');
    await evaluate('window.__v.openFiles(window.__files(["current-lung-1","prior"]))');assert.equal((await state()).state.seriesCount,2);
    await evaluate('window.__v.openFiles(window.__files(["other-patient"]))');observed=await state();assert.equal(observed.state.seriesCount,1);assert.deepEqual(observed.uploads.at(-1).samples,fixtures.find(f=>f.key==='other-patient').values);assert.equal((await evaluate('window.__v.getLocalCatalog()')).patients.length,0);
    record('legacy SDK openFiles retains its replacement contract independently of additive local-library imports');
    const realBeforeIndex=await state();
    await evaluate('window.__v.importLocalFiles([window.__file("future")])');
    observed=await state();assert.equal(observed.library.patients,1);assert.equal(observed.library.activePatientId,null);assert.equal(observed.library.currentStudyId,null);assert.deepEqual(observed.workspace,realBeforeIndex.workspace);assert.equal(observed.uploads.length,realBeforeIndex.uploads.length);
    record('a first local catalog import does not replace an already displayed real SDK source');
    await evaluate('window.__resetViewer()');
    await evaluate('(()=>{window.__firstSlowImport=window.__v.importLocalFiles([window.__slowFile("future",700)]).then(result=>({added:result.added}),error=>({name:error.name}));return true;})()');
    await delay(50);await evaluate('window.__v.openFiles([window.__file("other-patient")])');
    const pendingFirstBefore=await state();assert.equal(pendingFirstBefore.draws.findLast(draw=>draw.slot===0).samples[0],600);
    assert.equal((await evaluate('window.__firstSlowImport')).added,1);
    observed=await state();assert.equal(observed.library.activePatientId,null);assert.equal(observed.library.currentStudyId,null);assert.equal(observed.state.sourceType,'files');assert.deepEqual(observed.workspace,pendingFirstBefore.workspace);assert.equal(observed.draws.findLast(draw=>draw.slot===0).samples[0],600);
    record('a source explicitly chosen during first-import indexing remains displayed when indexing finishes');
    await evaluate('window.__resetViewer()');
    const clearRace=await run('return Promise.allSettled([window.__v.clearLocalLibrary(),window.__v.importLocalFiles([window.__file("current-lung-1")])]).then(results=>results.map(result=>({status:result.status,name:result.reason?.name,added:result.value?.added})));');
    assert.equal(clearRace[0].status,'rejected');assert.equal(clearRace[0].name,'AbortError');assert.equal(clearRace[1].status,'fulfilled');assert.equal(clearRace[1].added,1);assert.equal((await evaluate('window.__v.getLocalCatalog()')).counts.instances,1);
    record('a newer import supersedes a pending clear operation and its catalog entries survive');


    const final=await run('window.__v.dispose();await window.__v.whenDisposed();return {performance:window.__v.getPerformance(),library:window.__v.getLocalLibraryState(),events:window.__qa.events,workers:window.__qa.workers};');
    assert.equal(final.performance.resources.workerCount,0);assert.equal(final.performance.resources.encodedBytes,0);assert.equal(final.performance.resources.encodedCacheBytes,0);assert.equal(final.performance.resources.decodedCacheBytes,0);assert.equal(final.performance.resources.thumbnailBytes,0);assert.equal(final.workers.active,0);assert.equal(final.workers.created,final.workers.terminated);noPrivate(final.events);noPrivate(final.library);
    record('disposal releases every local-library worker and pixel resource, and automatic events never expose patient identifiers or image payloads');

    assert.equal(JSON.parse(await readFile(resolve(root,'dist/build-info.json'),'utf8')).sourceDigest,buildInfo.sourceDigest,'Viewer assets changed during qualification.');
    assert.equal(browser.errors.length,0);assert.equal(browser.consoleErrors.length,0);
    const uploads=browser.requests.filter(request=>!['GET','HEAD'].includes(request.method));
    const external=browser.requests.filter(request=>!request.url.startsWith(new URL(server.url).origin)&&!request.url.startsWith('data:')&&!request.url.startsWith('blob:'));
    assert.equal(uploads.length,0);assert.equal(external.length,0);assert.equal(server.requests.rejectedMethods,0);
    record('all generated image imports stay local with zero uploads, external requests, browser exceptions or console errors');
    await writeFile(resolve(output,'results.json'),JSON.stringify({passed:checks.length,checks,sourceDigest:buildInfo.sourceDigest,harnessSha256:createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'),originalImagingFilesUsed:false,uploads:0,externalRequests:0,browserExceptions:0,consoleErrors:0},null,2)+'\n');
    console.log('Local library browser checks: '+checks.length+' passed.');
} catch(error) {
    await writeFile(resolve(output,'failure.json'),JSON.stringify({checks,error:{name:error.name,message:error.message,stack:error.stack},browserExceptions:browser?.errors??[],consoleErrors:browser?.consoleErrors??[]},null,2)+'\n');throw error;
} finally {
    browser?.close(); await server?.close();
    if(temporary)await rm(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
