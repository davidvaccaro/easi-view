import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createDicomFixture } from '../src/data/synthetic.js';
import { sourceDigest } from './source-digest.mjs';
import { browserSession, delay } from './browser-session.mjs';

const root=resolve(import.meta.dirname,'..');
const output=resolve(root,'artifacts/browser-performance');
const qa=resolve(root,'dist/qa');
const target=new URL(process.env.EASI_VIEW_URL||'http://127.0.0.1:5174/');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname),'Performance checks require an isolated local preview.');
const repeats=Number(process.env.EASI_VIEW_PERF_REPEATS||7);
assert.ok(Number.isInteger(repeats)&&repeats>=5&&repeats<=30,'Use 5–30 repeats for the controlled baseline.');
const liveEnabled=process.env.EASI_VIEW_PERF_LIVE_ORTHANC==='1';
const conditions={instanceCount:8,bitsAllocated:16,bitsStored:16,signed:true,photometric:'MONOCHROME2',
    metadataDelayMs:20,instanceHeaderDelayMs:15,chunkBytes:8192,chunkIntervalMs:2,supersededHeaderDelayMs:400,
    cacheControl:'no-store',transport:'loopback HTTP',browserAlreadyMounted:true,pixelCachesColdOnOpen:true,
    browserModuleOrOperatingSystemCachesFlushed:false};
const attribute=(vr,...Value)=>({Value,vr}); // Orthanc-style arbitrary property order.
const uidRoot='1.2.826.0.1.3680043.10.543.995';
const cases=[['small',64],['medium',256]].map(([name,size])=>{
    const studyUid=`${uidRoot}.${size}.1`,seriesUid=`${studyUid}.1`;
    const metadata=Array.from({length:conditions.instanceCount},(_,index)=>({
        '00080016':attribute('UI','1.2.840.10008.5.1.4.1.1.2'),'00080018':attribute('UI',`${seriesUid}.${index+1}`),
        '00080060':attribute('CS','CT'),'0008103E':attribute('LO','Synthetic performance stack'),
        '0020000D':attribute('UI',studyUid),'0020000E':attribute('UI',seriesUid),'00200013':attribute('IS',String(index+1)),
        '00200032':attribute('DS',0,0,index),'00200037':attribute('DS',1,0,0,0,1,0),
        '00280002':attribute('US',1),'00280004':attribute('CS','MONOCHROME2'),'00280008':attribute('IS','1'),
        '00280010':attribute('US',size),'00280011':attribute('US',size),'00280030':attribute('DS',.75,.75),
        '00280100':attribute('US',16),'00280101':attribute('US',16),'00280102':attribute('US',15),'00280103':attribute('US',1),
        '00281050':attribute('DS',0),'00281051':attribute('DS',4096),'00281052':attribute('DS',0),'00281053':attribute('DS',1),
        '00281054':attribute('LO','HU'),'00281056':attribute('CS','LINEAR'),'7FE00010':{BulkDataURI:'not-followed',vr:'OW'}
    }));
    const instances=metadata.map((m,index)=>createDicomFixture({rows:size,columns:size,bitsAllocated:16,bitsStored:16,signed:true,
        values:Array.from({length:size*size},(_,pixel)=>-1000+index*10+pixel%997),window:{center:0,width:4096},
        sopUid:m['00080018'].Value[0],seriesUid,position:[0,0,index],instanceNumber:index+1,
        extraAttributes:{'0020000D':['UI',studyUid]}}));
    return{name,size,studyUid,seriesUid,metadata,instances,
        studies:[{'0020000D':attribute('UI',studyUid),'00080061':attribute('CS','CT'),'00100010':{vr:'PN'},'00100020':attribute('LO','SYNTHETIC-PERFORMANCE'),'00201206':attribute('IS','1'),'00201208':attribute('IS','8')}],
        series:[{'0020000D':attribute('UI',studyUid),'0020000E':attribute('UI',seriesUid),'00080060':attribute('CS','CT'),'00200011':attribute('IS','1'),'00201209':attribute('IS','8')}]};
});
const requests=[];
const checks=[];
const record=(name,detail={})=>{checks.push({name,...detail});console.log(`PASS ${name}`);};
const quote=JSON.stringify;
let browser,server;
const statistics=values=>{const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);return{count:sorted.length,medianMs:sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2,p95Ms:sorted[Math.ceil(sorted.length*.95)-1],minMs:sorted[0],maxMs:sorted.at(-1)};};
const validateSnapshot=snapshot=>{
    assert.equal(snapshot.limit,256);assert.ok(snapshot.measurements.length<=snapshot.limit);
    assert.ok(snapshot.resources.encodedBytes<=64*1024*1024);assert.ok(snapshot.resources.decodedCacheBytes<=64*1024*1024);assert.ok(snapshot.resources.workerCount<=1);
    const allowed=new Set(['phase','durationMs','status','bytes','decodedBytes','encodedCacheBytes','decodedCacheBytes','decodedCacheHit','encodedCacheHit','source']);
    for(const event of snapshot.measurements){assert.ok(Object.keys(event).every(key=>allowed.has(key)));assert.ok(Number.isFinite(event.durationMs)&&event.durationMs>=0);assert.ok(['success','error','canceled'].includes(event.status));}
    for(const[phase,summary]of Object.entries(snapshot.summary)){
        const events=snapshot.measurements.filter(event=>event.phase===phase),successes=events.filter(e=>e.status==='success');
        assert.equal(summary.count,events.length);assert.equal(summary.successCount,successes.length);
        if(successes.length){const independent=statistics(successes.map(e=>e.durationMs));assert.equal(summary.medianMs,independent.medianMs);assert.equal(summary.p95Ms,independent.p95Ms);}else{assert.equal(summary.medianMs,null);assert.equal(summary.p95Ms,null);}
    }
};
const run=expression=>browser.evaluate(`(async()=>{${expression}})()`);
const setupServer=async()=>{
    server=createServer(async(request,response)=>{
        response.setHeader('Access-Control-Allow-Origin',target.origin);response.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers','Accept');response.setHeader('Cache-Control','no-store');
        if(request.method==='OPTIONS'){response.writeHead(204);response.end();return;}
        if(request.method!=='GET'){response.writeHead(405);response.end();return;}
        const url=new URL(request.url,'http://127.0.0.1');const match=url.pathname.match(/^\/(small|medium)\/dicom-web\/(.*)$/);
        if(!match){response.writeHead(404);response.end();return;}const scenario=cases.find(c=>c.name===match[1]),path=match[2];
        const log={case:scenario.name,type:null,index:null,aborted:false,bytes:0};requests.push(log);response.on('close',()=>{if(!response.writableEnded)log.aborted=true;});
        const json=async(type,data)=>{log.type=type;await delay(conditions.metadataDelayMs);if(response.destroyed)return;const payload=Buffer.from(JSON.stringify(data));log.bytes=payload.length;response.writeHead(200,{'Content-Type':'application/dicom+json','Content-Length':payload.length});response.end(payload);};
        if(path==='studies'){await json('study-query',scenario.studies);return;}
        if(path===`studies/${scenario.studyUid}/series`){await json('series-query',scenario.series);return;}
        if(path===`studies/${scenario.studyUid}/series/${scenario.seriesUid}/metadata`){await json('series-metadata',scenario.metadata);return;}
        const index=scenario.metadata.findIndex(m=>path===`studies/${scenario.studyUid}/series/${scenario.seriesUid}/instances/${m['00080018'].Value[0]}`);
        if(index<0){response.writeHead(404);response.end();return;}log.type='instance';log.index=index;
        await delay(index===3?conditions.supersededHeaderDelayMs:conditions.instanceHeaderDelayMs);if(response.destroyed)return;
        const payload=scenario.instances[index];response.writeHead(200,{'Content-Type':'application/dicom; transfer-syntax=1.2.840.10008.1.2.1','Content-Length':payload.length});
        for(let offset=0;offset<payload.length;offset+=conditions.chunkBytes){if(response.destroyed)return;const part=payload.subarray(offset,offset+conditions.chunkBytes);response.write(part);log.bytes+=part.length;if(offset+conditions.chunkBytes<payload.length)await delay(conditions.chunkIntervalMs);}
        response.end();
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${server.address().port}/`;
};
const measure=async expression=>{
    const result=await run(`const start=performance.now();await ${expression};const submittedMs=performance.now()-start;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return{submittedMs,nextAnimationOpportunityMs:performance.now()-start,state:window.__perf.viewer.getState(),snapshot:window.__perf.viewer.getPerformance(),uploadedFirst:window.__perf.uploadedFirst,activeWorkers:window.__perf.workers.filter(w=>!w.terminated).length};`);
    validateSnapshot(result.snapshot);return result;
};
const dispose=async()=>{
    const result=await run(`const v=window.__perf.viewer;v.dispose();return{snapshot:v.getPerformance(),allWorkersTerminated:window.__perf.workers.every(w=>w.terminated),mountEmpty:document.getElementById('mount').children.length===0};`);
    assert.equal(result.snapshot.resources.disposed,true);assert.equal(result.snapshot.measurements.length,0);
    for(const field of['seriesCount','frameCount','encodedBytes','decodedCacheBytes','workerCount'])assert.equal(result.snapshot.resources[field],0);
    assert.equal(result.allWorkersTerminated,true);assert.equal(result.mountEmpty,true);return result;
};

try{
    await mkdir(output,{recursive:true});await mkdir(qa,{recursive:true});
    const archiveRoot=await setupServer();
    await writeFile(resolve(qa,'index.html'),'<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="./host.css"></head><body><main id="mount"></main><script type="module" src="./host.js"></script></body></html>');
    await writeFile(resolve(qa,'host.css'),'body{margin:0}#mount{height:800px;width:100%}');
    await writeFile(resolve(qa,'host.js'),`
import{createViewer}from'../assets/easi-view.js';
const q=window.__perf={createViewer,workers:[],events:[],uploadedFirst:null};
const NativeWorker=window.Worker;window.Worker=class extends NativeWorker{constructor(...args){super(...args);this.qa={terminated:false};q.workers.push(this.qa);}terminate(){this.qa.terminated=true;super.terminate();}};
const upload=WebGL2RenderingContext.prototype.texImage2D;WebGL2RenderingContext.prototype.texImage2D=function(...args){if(args[8]?.length)q.uploadedFirst=args[8][0];return upload.apply(this,args);};
q.mount=async()=>{q.viewer=createViewer(document.getElementById('mount'));q.root=document.getElementById('mount').querySelector('easi-view-embed').shadowRoot;for(const type of['framechange','sourcechange'])q.viewer.on(type,s=>q.events.push({type,index:s.frameIndex}));await q.viewer.ready;};
await q.mount();q.ready=true;
`);
    browser=await browserSession(output);await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await browser.send('Page.navigate',{url:new URL('qa/index.html',target).href});await browser.until('window.__perf?.ready','The performance SDK mount did not become ready.');
    const version=await browser.send('Browser.getVersion');const buildInfo=await(await fetch(new URL('build-info.json',target))).json();const inputDigest=await sourceDigest(root);
    assert.equal(buildInfo.sourceDigest,inputDigest,'Benchmark preview is stale relative to its source inputs. Rebuild before benchmarking.');
    const results=[];
    for(const scenario of cases){
        const observations=[];
        for(let iteration=0;iteration<repeats;iteration++){
            await run(`window.__perf.viewer.configureArchive({baseUrl:${quote(new URL(`${scenario.name}/dicom-web/`,archiveRoot).href)}});window.__perf.viewer.resetPerformance();`);
            const study=await measure('window.__perf.viewer.searchStudies({}, {limit:25})');
            const series=await measure(`window.__perf.viewer.listStudySeries(${quote(scenario.studyUid)})`);
            const before=requests.filter(r=>r.type==='instance'&&r.case===scenario.name).length;
            const cold=await measure(`window.__perf.viewer.openArchiveSeries(${quote(scenario.studyUid)},${quote(scenario.seriesUid)})`);
            assert.equal(cold.state.frameCount,conditions.instanceCount);assert.equal(cold.state.frameIndex,0);assert.equal(cold.uploadedFirst,-1000);assert.equal(cold.activeWorkers,1);
            assert.equal(requests.filter(r=>r.type==='instance'&&r.case===scenario.name).length,before+1);
            for(const phase of ['series-metadata','metadata-read','metadata-parse','metadata-index','instance-headers','stream','pipeline','decode','frame','display','first-display','source-open'])assert.ok(cold.snapshot.summary[phase]?.successCount>=1,`Missing successful ${phase} observation.`);
            const distant=await measure('window.__perf.viewer.setFrame(7)');assert.equal(distant.state.frameIndex,7);assert.equal(distant.uploadedFirst,-930);
            const beforeCached=requests.filter(r=>r.type==='instance'&&r.case===scenario.name).length;
            const cached=await measure('window.__perf.viewer.setFrame(0)');assert.equal(cached.state.frameIndex,0);assert.equal(cached.uploadedFirst,-1000);
            assert.equal(requests.filter(r=>r.type==='instance'&&r.case===scenario.name).length,beforeCached);
            assert.ok(cached.snapshot.measurements.some(m=>m.phase==='frame'&&m.status==='success'&&m.decodedCacheHit===true));
            observations.push({studyQueryMs:study.submittedMs,seriesQueryMs:series.submittedMs,pixelColdOpenMs:cold.submittedMs,
                openNextAnimationOpportunityMs:cold.nextAnimationOpportunityMs,uncachedSeekMs:distant.submittedMs,decodedCachedSeekMs:cached.submittedMs,
                resources:cached.snapshot.resources,measurements:cached.snapshot.measurements});
        }
        const summaries=Object.fromEntries(['studyQueryMs','seriesQueryMs','pixelColdOpenMs','openNextAnimationOpportunityMs','uncachedSeekMs','decodedCachedSeekMs'].map(key=>[key,statistics(observations.map(row=>row[key]))]));
        const successful=observations.flatMap(row=>row.measurements.filter(event=>event.status==='success'));
        const phaseSummaries=Object.fromEntries([...new Set(successful.map(event=>event.phase))].map(phase=>[phase,statistics(successful.filter(event=>event.phase===phase).map(event=>event.durationMs))]));
        results.push({case:scenario.name,rows:scenario.size,columns:scenario.size,encodedPixelBytesPerInstance:scenario.size*scenario.size*2,
            part10BytesPerInstance:scenario.instances[0].byteLength,syntheticFixtureSha256:createHash('sha256').update(scenario.instances[0]).digest('hex'),summaries,phaseSummaries,observations});
    }
    await run(`window.__perf.root.querySelector('.inspector-scroll').scrollTop=window.__perf.root.querySelector('.inspector-scroll').scrollHeight;`);
    await browser.screenshot('synthetic-performance-panel');
    record('repeatable pixel-cold opens and uncached/cached seeks have independent elapsed times, source samples, and median/p95 summaries',{caseCount:results.length,repeats});
    const current=cases[1];const baseUrl=new URL('medium/dicom-web/',archiveRoot).href;
    await run(`window.__perf.viewer.configureArchive({baseUrl:${quote(baseUrl)}});await window.__perf.viewer.openArchiveSeries(${quote(current.studyUid)},${quote(current.seriesUid)});window.__perf.viewer.resetPerformance();window.__perf.pending=window.__perf.viewer.setFrame(3).then(()=>({status:'success'}),error=>({status:error.name}));`);
    const pollStart=performance.now();while(!requests.some(r=>r.case==='medium'&&r.index===3)&&performance.now()-pollStart<3000)await delay(20);
    const latest=await measure('window.__perf.viewer.setFrame(1)');const canceled=await run('return window.__perf.pending;');assert.equal(canceled.status,'AbortError');assert.equal(latest.state.frameIndex,1);assert.equal(latest.uploadedFirst,-990);
    await delay(conditions.supersededHeaderDelayMs+30);assert.equal(await run('return window.__perf.viewer.getState().frameIndex;'),1);
    assert.equal(requests.filter(r=>r.case==='medium'&&r.index===3).at(-1).aborted,true);
    const canceledSnapshot=await run('return window.__perf.viewer.getPerformance();');validateSnapshot(canceledSnapshot);assert.ok(canceledSnapshot.measurements.some(m=>m.status==='canceled'));
    record('superseded seek cancels its HTTP request and never replaces the final submitted frame');
    await run('await window.__perf.viewer.setFrame(0);await window.__perf.viewer.setFrame(1);');
    const bounded=await run('for(let i=0;i<140;i++)await window.__perf.viewer.setFrame(i%2);return window.__perf.viewer.getPerformance();');validateSnapshot(bounded);assert.equal(bounded.measurements.length,bounded.limit);
    const reset=await run('const before=window.__perf.viewer.getPerformance().resources;window.__perf.viewer.resetPerformance();return{before,after:window.__perf.viewer.getPerformance()};');assert.equal(reset.after.measurements.length,0);assert.deepEqual(reset.after.resources,reset.before);
    record('bounded measurements, success-only percentiles and reset preserve viewing resources without persistent telemetry');
    await dispose();
    const cycles=[];const small=cases[0];for(let i=0;i<5;i++){
        await run(`await window.__perf.mount();window.__perf.viewer.configureArchive({baseUrl:${quote(new URL('small/dicom-web/',archiveRoot).href)}});`);
        const opened=await measure(`window.__perf.viewer.openArchiveSeries(${quote(small.studyUid)},${quote(small.seriesUid)})`);assert.equal(opened.activeWorkers,1);cycles.push({resourcesBeforeDispose:opened.snapshot.resources,resourcesAfterDispose:(await dispose()).snapshot.resources});
    }
    record('five open/dispose cycles release workers, retained pixel caches, viewer mounts and measurement history');
    let live=null;
    if(liveEnabled){
        await run(`await window.__perf.mount();window.__perf.viewer.configureArchive({baseUrl:${quote(new URL('orthanc/dicom-web/',target).href)}});window.__perf.liveCandidates=[];const studies=await window.__perf.viewer.searchStudies({modality:'XA'},{limit:100});for(const study of studies.items){const series=await window.__perf.viewer.listStudySeries(study.studyUid,{limit:100});for(const item of series.items)if(item.modality==='XA')window.__perf.liveCandidates.push({studyUid:study.studyUid,seriesUid:item.seriesUid});}return true;`);
        const candidates=await run('return window.__perf.liveCandidates.length;');assert.ok(candidates>0,'No XA candidate is available in the explicitly requested local Orthanc check.');
        const index=await run('for(let i=0;i<window.__perf.liveCandidates.length;i++){const c=window.__perf.liveCandidates[i];try{await window.__perf.viewer.openArchiveSeries(c.studyUid,c.seriesUid);return i;}catch{}}return -1;');assert.ok(index>=0,'No candidate fits the supported native XA profile.');
        const samples=[];for(let i=0;i<5;i++){
            const observed=await run(`const selected=window.__perf.liveCandidates[${index}];const v=window.__perf.viewer;v.disconnectArchive();v.configureArchive({baseUrl:${quote(new URL('orthanc/dicom-web/',target).href)}});v.resetPerformance();const start=performance.now();await v.openArchiveSeries(selected.studyUid,selected.seriesUid);const elapsedMs=performance.now()-start;const frameCount=v.getState().frameCount;await v.setFrame(frameCount-1);await v.setFrame(0);return{elapsedMs,state:v.getState(),snapshot:v.getPerformance()};`);
            validateSnapshot(observed.snapshot);samples.push({submittedOpenMs:observed.elapsedMs,frameCount:observed.state.frameCount,image:observed.state.image,resources:observed.snapshot.resources,measurements:observed.snapshot.measurements});
        }
        live={enabled:true,peer:'fixed loopback Orthanc through preview bridge',modality:'XA',candidateCount:candidates,
            selectedCandidateOrdinal:index,openSummary:statistics(samples.map(s=>s.submittedOpenMs)),samples,originalPixelsOrScreenshotsSaved:false};await dispose();
        record('optional live Orthanc XA repeats remain read-only and save only technical timing/resource observations');
    }
    assert.equal(browser.errors.length,0);assert.equal(browser.consoleErrors.length,0);
    assert.ok(browser.requests.every(r=>r.method==='GET'||r.method==='OPTIONS'),'Performance checks must not upload or mutate archive data.');
    assert.ok(browser.requests.every(r=>{const u=new URL(r.url);return ['data:','blob:','about:'].includes(u.protocol)||['127.0.0.1','localhost','[::1]'].includes(u.hostname);}),'Performance checks must not contact external services.');
    const receipt={schemaVersion:1,passed:checks.length,checks,definitions:{submittedMs:'Browser monotonic elapsed to SDK completion after draw commands were submitted; not GPU completion or physical paint.',nextAnimationOpportunityMs:'Elapsed through two later requestAnimationFrame callbacks; not proof of actual canvas paint.',percentiles:'Median averages two middle samples; p95 uses nearest rank. Timed successful operations only.',phases:'Transfer and pipeline spans overlap; phase durations must not be summed as end-to-end latency.'},
        conditions,repeats,environment:{node:process.version,platform:process.platform,architecture:process.arch,browser:version.product,javascriptEngine:version.jsVersion,softwareWebgl:true},
        provenance:{viewerVersion:buildInfo.version,easiJsVersion:buildInfo.easiJsVersion,sourceDigest:inputDigest,buildSourceDigest:buildInfo.sourceDigest},results,
        cancellation:{abortedRequests:requests.filter(r=>r.aborted).length},lifecycle:cycles,live,browserExceptions:0,consoleErrors:0,
        originalImagesSaved:false,screenshotsCaptured:true,onlySyntheticScreenshot:'synthetic-performance-panel.png'};
    await writeFile(resolve(output,'results.json'),JSON.stringify(receipt,null,2)+'\n');
    console.log(`Performance browser checks: ${checks.length} passed; ${results.length} controlled cases × ${repeats} repeats.`);
}finally{browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await rm(qa,{recursive:true,force:true});}
