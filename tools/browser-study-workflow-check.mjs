import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { createDicomFixture } from '../src/data/synthetic.js';
import { createVariableCineDicom } from '../test/enhanced-fixtures.js';
import { browserSession, delay } from './browser-session.mjs';

const root=resolve(import.meta.dirname,'..'),qa=resolve(root,'dist/qa'),output=resolve(root,'artifacts/browser-study-workflow');
const target=new URL(process.env.EASI_VIEW_URL||'http://127.0.0.1:5180/');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname));
const quote=JSON.stringify,checks=[],requests=[];
const record=(name,details={})=>{checks.push({name,...details});console.log(`PASS ${name}`);};
const uid='2.25.990',study=index=>`${uid}.${index+1}`,series=index=>`${study(index)}.1`,sop=(index,frame)=>`${series(index)}.${frame+1}`;
const attr=(vr,...Value)=>({vr,Value}),classUid='1.2.840.10008.5.1.4.1.1.7.3';
const studies=[
    {study:study(0),date:'20261014',patient:'QA-WORKFLOW'},
    {study:study(1),date:'20250908',patient:'QA-WORKFLOW'},
    {study:study(2),date:'20240815',patient:'DIFFERENT-SYNTHETIC'},
    {study:study(3),date:'2025',patient:'QA-WORKFLOW'}
].map((item,index)=>({'0020000D':attr('UI',item.study),'00080020':attr('DA',item.date),'00100020':attr('LO',item.patient),'00080061':attr('CS','OT'),
    '00081030':attr('LO',`Synthetic workflow study ${index+1}`),'00201206':attr('IS',1),'00201208':attr('IS',6)}));
const descriptors=index=>Array.from({length:6},(_,frame)=>({
    '00080016':attr('UI',classUid),'00080018':attr('UI',sop(index,frame)),'00080060':attr('CS','OT'),
    '0020000D':attr('UI',study(index)),'0020000E':attr('UI',series(index)),'00200052':attr('UI',`${uid}.99`),
    '00200013':attr('IS',frame+1),'00200032':attr('DS',0,0,frame),'00200037':attr('DS',1,0,0,0,1,0),
    '00280002':attr('US',1),'00280004':attr('CS','MONOCHROME2'),'00280008':attr('IS',1),
    '00280010':attr('US',128),'00280011':attr('US',192),'00280030':attr('DS',1,1),
    '00280100':attr('US',16),'00280101':attr('US',12),'00280102':attr('US',11),'00280103':attr('US',0),
    '00281050':attr('DS',2048),'00281051':attr('DS',4096),'00281052':attr('DS',0),'00281053':attr('DS',1),'00281054':attr('LO','TEST'),'00281056':attr('CS','LINEAR'),
    '7FE00010':{vr:'OW',BulkDataURI:'https://synthetic.invalid/not-followed'}
}));
const pixels=(index,frame)=>Array(128*192).fill(100+index*500+frame*10);
const dicoms=Array.from({length:2},(_,index)=>Array.from({length:6},(_,frame)=>createDicomFixture({rows:128,columns:192,bitsStored:12,
    values:pixels(index,frame),sopClass:classUid,modality:'OT',rescaleType:'TEST',sopUid:sop(index,frame),seriesUid:series(index),position:[0,0,frame],pixelSpacing:[1,1],instanceNumber:frame+1,
    window:{center:2048,width:4096},extraAttributes:{'0020000D':['UI',study(index)],'00200052':['UI',`${uid}.99`]}})));
const controls={metadataDelay:0,instanceDelay:0,slowFrame:null,metadataFail:false,instanceFail:false,frameFail:false};
let server,browser;
const count=type=>requests.filter(request=>request.type===type).length;
const begin=async()=>{
    server=createServer(async(request,response)=>{
        response.setHeader('Access-Control-Allow-Origin',target.origin);response.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');response.setHeader('Access-Control-Allow-Headers','Accept');response.setHeader('Cache-Control','no-store');
        if(request.method==='OPTIONS'){response.writeHead(204);response.end();return;}
        const url=new URL(request.url,'http://127.0.0.1'),path=url.pathname.replace(/^\/dicom-web\//,'');
        const json=data=>{response.writeHead(200,{'Content-Type':'application/dicom+json'});response.end(JSON.stringify(data));};
        if(path==='studies'){
            const offset=Number(url.searchParams.get('offset')||0),limit=Number(url.searchParams.get('limit')||25);
            requests.push({type:'studies',offset,limit,exactId:url.searchParams.get('PatientID')==='QA-WORKFLOW',dated:url.searchParams.get('StudyDate')==='-20261014'});
            json(studies.slice(offset,offset+limit));return;
        }
        const match=path.match(/^studies\/([^/]+)\/series(?:\/([^/]+)(?:\/(metadata|instances)(?:\/([^/]+)(?:\/frames\/(\d+))?)?)?)?$/);
        if(!match){response.writeHead(404);response.end();return;}
        const index=[study(0),study(1)].indexOf(match[1]);
        if(index<0){json([]);return;}
        if(!match[2]){requests.push({type:'series',study:index});json([{'0020000D':attr('UI',study(index)),'0020000E':attr('UI',series(index)),'00080060':attr('CS','OT'),'0008103E':attr('LO','Synthetic comparison'),'00200011':attr('IS',1),'00201209':attr('IS',6)}]);return;}
        if(match[3]==='metadata'){
            const log={type:'metadata',study:index};requests.push(log);response.on('close',()=>{if(!response.writableEnded)log.canceled=true;});
            if(index===1&&controls.metadataDelay)await delay(controls.metadataDelay);
            if(response.destroyed)return;
            if(index===1&&controls.metadataFail){response.writeHead(503);response.end('Synthetic private failure body');return;}
            json(descriptors(index));return;
        }
        const frame=descriptors(index).findIndex(item=>item['00080018'].Value[0]===match[4]);
        if(frame<0){response.writeHead(404);response.end();return;}
        const log={type:match[5]?'frame':'instance',study:index,frame};requests.push(log);response.on('close',()=>{if(!response.writableEnded)log.canceled=true;});
        if((index===1&&controls.instanceDelay)||(frame===controls.slowFrame))await delay(controls.instanceDelay||800);
        if(response.destroyed)return;
        if((index===1&&controls.instanceFail)||(match[5]&&controls.frameFail)){response.writeHead(match[5]?406:503);response.end('Synthetic private failure body');return;}
        if(match[5]){
            const bytes=new Uint8Array(128*192*2),view=new DataView(bytes.buffer);pixels(index,frame).forEach((value,p)=>view.setUint16(p*2,value,true));
            const boundary='synthetic-workflow-frame',body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream; transfer-syntax=1.2.840.10008.1.2.1\r\nContent-Location: ${url.pathname}\r\nContent-Length: ${bytes.length}\r\n\r\n`),Buffer.from(bytes),Buffer.from(`\r\n--${boundary}--\r\n`)]);
            response.writeHead(200,{'Content-Type':`multipart/related; type="application/octet-stream"; boundary=${boundary}`});response.end(body);return;
        }
        response.writeHead(200,{'Content-Type':'application/dicom'});response.end(dicoms[index][frame]);
    });
    await new Promise(resolveListen=>server.listen(0,'127.0.0.1',resolveListen));return`http://127.0.0.1:${server.address().port}/dicom-web/`;
};
const state=()=>browser.evaluate('({state:window.__v.getState(),workspace:window.__v.getWorkspaceState(),performance:window.__v.getPerformance(),thumbnails:Array.from(window.__shadow.querySelectorAll(".imported-thumbnail")).map(c=>({width:c.width,height:c.height}))})');
const invariant=s=>{assert.ok(s.workspace.decodedBytes<=s.workspace.cacheBudget);assert.ok(s.workspace.encodedBytes<=s.workspace.encodedCacheBudget);assert.ok(s.workspace.workerCount<=1);assert.ok(s.workspace.thumbnailBytes<=4*1024*1024);};
try{
    const buildInfo=JSON.parse(await readFile(resolve(root,'dist/build-info.json'),'utf8')),baseUrl=await begin();
    await mkdir(qa,{recursive:true});await mkdir(output,{recursive:true});
    const local=createDicomFixture({rows:2,columns:2,frames:3,values:[7,8,9,10,17,18,19,20,27,28,29,30],sopUid:`${uid}.100`,seriesUid:`${uid}.101`});
    const replay=createVariableCineDicom();
    await writeFile(resolve(output,'entry.js'),`const bytes=${quote({local:Buffer.from(local).toString('base64'),replay:Buffer.from(replay.bytes).toString('base64')})};export function file(name){return new File([Uint8Array.from(atob(bytes[name]),c=>c.charCodeAt(0))],'synthetic-'+name+'.dcm',{type:'application/dicom'});}`);
    await build({entryPoints:[resolve(output,'entry.js')],outfile:resolve(qa,'fixtures.js'),bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true});
    await writeFile(resolve(qa,'index.html'),'<!doctype html><html><head><link rel="stylesheet" href="./host.css"></head><body><main id="mount"></main><script type="module" src="./host.js"></script></body></html>');
    await writeFile(resolve(qa,'host.css'),'body{margin:0;background:#101820}#mount{height:1000px;width:100%}');
    await writeFile(resolve(qa,'host.js'),`import{createViewer}from'../assets/easi-view.js';import{file}from'./fixtures.js';window.__file=file;window.__v=createViewer(document.getElementById('mount'));window.__events=[];for(const type of['framechange','sourcechange','error'])window.__v.on(type,detail=>window.__events.push({type,detail}));await window.__v.ready;window.__shadow=document.getElementById('mount').querySelector('easi-view-embed').shadowRoot;window.__ready=true;`);
    browser=await browserSession(output);await browser.send('Emulation.setDeviceMetricsOverride',{width:1500,height:1100,deviceScaleFactor:1,mobile:false});
    await browser.send('Page.navigate',{url:new URL('qa/index.html',target).href});await browser.until('window.__ready','Study workflow host did not mount.');
    await browser.evaluate(`(async()=>{await window.__v.openFiles([window.__file('local')]);await window.__v.setLayout(2);window.__v.configureArchive({baseUrl:${quote(baseUrl)}});})()`);
    const localState=await state();assert.equal(localState.state.sourceType,'files');assert.equal(requests.length,0);assert.equal(localState.workspace.prefetch.enabled,false);
    await browser.evaluate('window.__v.addAnnotation({tool:"length",points:[{x:.5,y:.5},{x:1.5,y:.5}]})');
    assert.equal(await browser.evaluate('window.__v.getAnnotationState().frameCount'),1);
    assert.equal(await browser.evaluate('window.__shadow.getElementById("annotation-list").children.length'),1);
    record('local pane and archive configuration stay independent, with background pixel retrieval off by default');
    await browser.evaluate(`window.__v.addArchiveSeries(${quote(study(0))},${quote(series(0))},{viewport:1})`);
    let current=await state();assert.equal(current.state.seriesCount,2);assert.equal(current.workspace.viewports[0].seriesIndex,0);assert.equal(current.workspace.viewports[0].frameIndex,0);assert.equal(current.workspace.viewports[1].seriesIndex,1);assert.equal(current.state.sourceType,'files');invariant(current);
    assert.equal(count('metadata'),1);assert.equal(count('instance'),1);await delay(400);assert.equal(count('instance'),1);
    assert.ok(current.thumbnails.length>=2,JSON.stringify({localThumbnails:localState.thumbnails,localThumbnailBytes:localState.workspace.thumbnailBytes,comparisonThumbnails:current.thumbnails,comparisonThumbnailBytes:current.workspace.thumbnailBytes,seriesCount:current.state.seriesCount}));assert.ok(current.thumbnails.every(t=>t.width<=96&&t.height<=96));assert.ok(current.thumbnails.some(t=>t.width===96&&t.height===64));
    const duplicateCounts={metadata:count('metadata'),instance:count('instance')};
    await browser.evaluate(`window.__v.addArchiveSeries(${quote(study(0))},${quote(series(0))},{viewport:1})`);assert.deepEqual({metadata:count('metadata'),instance:count('instance')},duplicateCounts);assert.equal(await browser.evaluate('window.__events.filter(e=>e.type==="sourcechange").at(-1).detail.busy'),false);
    record('comparison addition preserves local images, derives a bounded96×64 thumbnail from the displayed frame, and duplicate additions fetch no data');
    const priorStart=count('instance');
    const priors=await browser.evaluate(`window.__v.findPriorStudies({patientId:'QA-WORKFLOW',currentStudyUid:${quote(study(0))},currentStudyDate:'20261014'},{limit:2,maxPages:2})`);
    assert.equal(priors.items.length,1);assert.equal(priors.items[0].studyUid,study(1));assert.match(priors.warnings.join(' '),/Confirm patient identity/);assert.match(priors.warnings.join(' '),/complete valid date/);assert.equal(count('instance'),priorStart);assert.equal((await state()).state.seriesCount,2);
    assert.ok(requests.filter(r=>r.type==='studies').every(r=>r.exactId&&r.dated));
    record('prior search uses exact ID and bounded earlier-date metadata, excludes mismatches/partial dates and never assigns images automatically');
    await browser.evaluate(`(async()=>{await window.__v.searchStudies();await window.__v.listStudySeries(${quote(study(0))});window.__shadow.getElementById('archive-find-priors').click();})()`);
    await browser.until('window.__shadow.getElementById("archive-prior-list").children.length===1','Prior candidate UI did not list the matching earlier study.');
    assert.match(await browser.evaluate('window.__shadow.getElementById("archive-prior-message").textContent'),/Confirm patient identity/);
    record('archive UI displays an explicit earlier-study candidate and identity warning');
    controls.metadataFail=true;const beforeFailure=await state();
    const failed=await browser.evaluate(`window.__v.addArchiveSeries(${quote(study(1))},${quote(series(1))},{viewport:1}).then(()=>false,error=>/HTTP 503/.test(error.message))`);assert.equal(failed,true);
    current=await state();assert.deepEqual(current.workspace.viewports,beforeFailure.workspace.viewports);assert.equal(current.state.seriesCount,2);controls.metadataFail=false;
    record('failed comparison metadata leaves both committed panes and the library intact');
    controls.metadataDelay=600;
    await browser.evaluate(`window.__pending=window.__v.addArchiveSeries(${quote(study(1))},${quote(series(1))},{viewport:1}).then(()=>({ok:true}),error=>({ok:false,name:error.name}));true`);
    await browser.evaluate('(async()=>{window.__v.setActiveViewport(1);await window.__v.setFrame(1);})()');
    const superseded=await browser.evaluate('window.__pending');assert.equal(superseded.ok,false);assert.equal(superseded.name,'AbortError');assert.equal((await state()).workspace.viewports[1].frameIndex,1);assert.equal((await state()).state.seriesCount,2);controls.metadataDelay=0;
    record('target-pane navigation supersedes a delayed additive metadata request without undoing the newer frame');
    controls.instanceDelay=900;
    await browser.evaluate(`window.__pending=window.__v.addArchiveSeries(${quote(study(1))},${quote(series(1))},{viewport:1}).then(()=>({ok:true}),error=>({ok:false,name:error.name}));true`);
    for(let i=0;i<100&&!requests.some(r=>r.type==='instance'&&r.study===1);i++)await delay(10);
    await browser.evaluate('window.__v.setLayout(1)');
    const removed=await browser.evaluate('window.__pending');assert.equal(removed.ok,false);assert.equal(removed.name,'AbortError');assert.equal((await state()).state.seriesCount,2);controls.instanceDelay=0;
    record('removing the target pane cancels a delayed first-frame addition without committing a detached viewport');
    await browser.evaluate('window.__v.setActiveViewport(0)');controls.instanceFail=true;
    const badFrame=await browser.evaluate(`window.__v.addArchiveSeries(${quote(study(1))},${quote(series(1))},{viewport:0}).then(()=>false,error=>/HTTP 503/.test(error.message))`);assert.equal(badFrame,true);assert.equal((await state()).workspace.viewports[0].seriesIndex,0);controls.instanceFail=false;
    record('failed comparison pixel retrieval preserves the surviving local source');
    const beforeGpu=await state();
    await browser.evaluate(`(()=>{const gl=window.__shadow.querySelector('.workspace-pane[data-slot="0"] canvas').getContext('webgl2'),original=gl.getError.bind(gl);let once=true;gl.getError=()=>once?(once=false,gl.INVALID_OPERATION):original();window.__restoreGl=()=>{gl.getError=original;};})()`);
    const gpuRejected=await browser.evaluate(`window.__v.addArchiveSeries(${quote(study(1))},${quote(series(1))},{viewport:0}).then(()=>false,error=>true)`);
    await browser.evaluate('window.__restoreGl()');assert.equal(gpuRejected,true);current=await state();assert.equal(current.state.seriesCount,beforeGpu.state.seriesCount);assert.deepEqual(current.workspace.viewports,beforeGpu.workspace.viewports);invariant(current);
    record('GPU rejection during additive commit restores the target image and removes the uncommitted library stacks');
    controls.metadataDelay=600;
    await browser.evaluate(`window.__pending=window.__v.addArchiveSeries(${quote(study(1))},${quote(series(1))},{viewport:0}).then(()=>({ok:true}),error=>({ok:false,name:error.name}));true`);
    await browser.evaluate('window.__v.openFiles([window.__file("local")])');
    const replaced=await browser.evaluate('window.__pending');assert.equal(replaced.ok,false);assert.equal(replaced.name,'AbortError');assert.equal((await state()).state.seriesCount,1);assert.equal((await state()).state.sourceType,'files');controls.metadataDelay=0;
    await browser.evaluate(`(async()=>{await window.__v.setLayout(2);await window.__v.addArchiveSeries(${quote(study(0))},${quote(series(0))},{viewport:1});})()`);
    record('replacing the source cancels an additive metadata request and prevents obsolete studies entering the new library');
    await browser.evaluate(`(async()=>{await window.__v.setLayout(2);await window.__v.addArchiveSeries(${quote(study(1))},${quote(series(1))},{viewport:1});window.__v.setActiveViewport(1);})()`);
    current=await state();assert.equal(current.state.seriesCount,3);assert.equal(current.workspace.viewports[0].seriesIndex,0);assert.equal(current.state.sourceType,'archive');invariant(current);
    await browser.screenshot('comparison-synthetic');
    assert.equal(await browser.evaluate('window.__events.filter(e=>e.type==="sourcechange").at(-1).detail.busy'),false);
    record('two archive studies and local files coexist with per-pane source origins and one shared worker/cache budget');
    const noPrefetch=count('instance');await delay(400);assert.equal(count('instance'),noPrefetch);
    await browser.evaluate('window.__v.setPrefetch({enabled:true,neighbors:2})');
    await browser.until('window.__shadow.getElementById("prefetch-status").textContent.includes("cached")','Explicit idle prefetch did not finish.');
    const prefetchCalls=count('instance');assert.equal(prefetchCalls,noPrefetch+1);
    await browser.evaluate('window.__v.setFrame(1)');assert.equal(count('instance'),prefetchCalls);
    await browser.until('window.__shadow.getElementById("prefetch-status").textContent.includes("cached")','Two-neighbor prefetch did not finish.');
    current=await state();invariant(current);assert.equal(current.workspace.prefetch.enabled,true);assert.ok(current.workspace.workerCount<=1);
    record('opt-in idle neighbor prefetch retrieves only adjacent missing frames and foreground navigation reuses their decoded cache');
    controls.slowFrame=3;controls.instanceDelay=900;
    await browser.evaluate('window.__v.setFrame(2)');
    for(let i=0;i<100&&!requests.some(r=>r.type==='instance'&&r.study===1&&r.frame===3);i++)await delay(10);
    await browser.evaluate('window.__v.setFrame(5)');await browser.evaluate('window.__v.setPrefetch({enabled:false})');
    assert.equal((await state()).state.frameIndex,5);invariant(await state());controls.slowFrame=null;controls.instanceDelay=0;
    record('urgent navigation preempts delayed background prefetch and keeps the final foreground frame');
    const nativeStart=count('instance');await browser.evaluate(`(async()=>{window.__v.configureArchive({baseUrl:${quote(baseUrl)},retrievalMode:'frame'});await window.__v.openArchiveSeries(${quote(study(0))},${quote(series(0))});await window.__v.setFrame(5);})()`);
    assert.equal(count('instance'),nativeStart);assert.ok(count('frame')>=2);assert.equal((await state()).workspace.encodedBytes,0);
    controls.frameFail=true;const priorNative=await state();const missing=await browser.evaluate('window.__v.setFrame(4).then(()=>false,error=>true)');assert.equal(missing,true);assert.equal((await state()).state.frameIndex,priorNative.state.frameIndex);controls.frameFail=false;
    record('explicit frame mode retrieves native selected resources and a missing native frame preserves the previous display');
    await browser.evaluate('(async()=>{await window.__v.openFiles([window.__file("replay")]);window.__v.play();})()');
    await browser.until('window.__v.getState().frameIndex===3&&!window.__v.getState().playing','Recorded cine did not stop on its last frame.');
    await browser.evaluate('window.__v.play()');await browser.until('window.__v.getState().frameIndex<3&&window.__v.getState().playing','Explicit replay did not seek to the first frame.');
    await browser.evaluate('window.__v.pause()');
    record('recorded timing stops at the final frame and a separate explicit Play action restarts from the first');
    const final=await browser.evaluate('(()=>{const v=window.__v,events=window.__events;v.dispose();return{performance:v.getPerformance(),events};})()');
    assert.equal(final.performance.resources.workerCount,0);assert.equal(final.performance.resources.encodedCacheBytes,0);assert.equal(final.performance.resources.decodedCacheBytes,0);assert.equal(final.performance.resources.thumbnailBytes,0);
    assert.ok(!/"(?:patientName|patientId|sopUid|seriesUid|studyUid|points|samples|pixelData)"\s*:|2\.25\.990/.test(JSON.stringify(final.events)));
    assert.equal(browser.errors.length,0);assert.equal(browser.consoleErrors.length,0);
    record('disposal releases shared worker/encoded/decoded/thumbnail resources and operational events omit identifiers and pixels');
    assert.equal(JSON.parse(await readFile(resolve(root,'dist/build-info.json'),'utf8')).sourceDigest,buildInfo.sourceDigest);
    await writeFile(resolve(output,'results.json'),JSON.stringify({passed:checks.length,checks,sourceDigest:buildInfo.sourceDigest,harnessSha256:createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'),requests,browserExceptions:0,consoleErrors:0,originalImagingFilesUsed:false},null,2)+'\n');
    console.log(`Study workflow browser checks: ${checks.length} passed.`);
}finally{browser?.close();server?.closeAllConnections();if(server)await new Promise(resolveClose=>server.close(resolveClose));await rm(qa,{recursive:true,force:true});}
