import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createDicomFixture } from '../src/data/synthetic.js';
import { browserSession, delay } from './browser-session.mjs';

// Public SDK revocation regressions. All sources, references and masks are generated.
const root=resolve(import.meta.dirname,'..'),qa=resolve(root,'dist/qa-revocation'),output=resolve(root,'artifacts/browser-revocation');
const target=new URL(process.env.EASI_VIEW_URL||'http://127.0.0.1:5184/');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname));
const checks=[],requests=[],quote=JSON.stringify,record=(name,detail={})=>{checks.push({name,...detail});console.log(`PASS ${name}`);};
const study=index=>`2.25.${970+index}`,series=index=>`${study(index)}.1`,sop=(index,z)=>`${series(index)}.${z+1}`,classUid='1.2.840.10008.5.1.4.1.1.2';
const attr=(vr,...Value)=>({vr,Value}),frames=[0,1].map(index=>Array.from({length:3},(_,z)=>{
    const value=100+index*500+z*10,rows=64,columns=96,bytes=createDicomFixture({rows,columns,values:Array(rows*columns).fill(value),sopUid:sop(index,z),seriesUid:series(index),position:[0,0,z*2],pixelSpacing:[1,1],instanceNumber:z+1,
        window:{center:400,width:800},extraAttributes:{'0020000D':['UI',study(index)],'00200052':['UI','2.25.979']}});
    const metadata={'00080016':attr('UI',classUid),'00080018':attr('UI',sop(index,z)),'00080060':attr('CS','CT'),'0020000D':attr('UI',study(index)),'0020000E':attr('UI',series(index)),
        '00200052':attr('UI','2.25.979'),'00200013':attr('IS',z+1),'00200032':attr('DS',0,0,z*2),'00200037':attr('DS',1,0,0,0,1,0),
        '00280002':attr('US',1),'00280004':attr('CS','MONOCHROME2'),'00280008':attr('IS',1),'00280010':attr('US',rows),'00280011':attr('US',columns),'00280030':attr('DS',1,1),
        '00280100':attr('US',16),'00280101':attr('US',16),'00280102':attr('US',15),'00280103':attr('US',0),'00281050':attr('DS',400),'00281051':attr('DS',800),
        '00281052':attr('DS',0),'00281053':attr('DS',1),'00281054':attr('LO','HU'),'00281056':attr('CS','LINEAR'),'7FE00010':{vr:'OW',BulkDataURI:'https://synthetic.invalid/not-followed'}};
    return{bytes,metadata,value};
}));
const encode=bytes=>Buffer.from(bytes).toString('base64');
const generated={local:encode(createDicomFixture({values:[7,8,9,10],sopUid:'2.25.990.1',seriesUid:'2.25.990'})),
    replacement:encode(createDicomFixture({values:[77,78,79,80],sopUid:'2.25.991.1',seriesUid:'2.25.991'})),
    large:encode(createDicomFixture({rows:512,columns:512,values:Array(512*512).fill(123),sopUid:'2.25.992.1',seriesUid:'2.25.992'}))};
const controls={metadataDelay:0,urlDelay:650};let server,browser,temporary;
const state=()=>browser.evaluate('({state:window.__v.getState(),workspace:window.__v.getWorkspaceState(),performance:window.__v.getPerformance(),derived:window.__v.getDerivedState(),annotations:window.__v.getAnnotationState(),visible:window.__visible()})');
const context={version:1,layout:2,activeViewport:1,viewports:[{slot:1,reference:{archiveKey:'primary',studyUid:study(1),seriesUid:series(1),sopUid:sop(1,0)},frameIndex:0,originalFrameNumber:1}]};
const noRemote=s=>{assert.ok(s.workspace.viewports.every(view=>!view.assigned||view.image?.rows===2));assert.ok(s.visible.every(view=>view.empty||[7,77].includes(view.stored)));assert.equal(s.derived.overlayCount,0);assert.equal(s.derived.documentCount,0);};
async function begin(){
    server=createServer(async(request,response)=>{
        response.setHeader('Access-Control-Allow-Origin',target.origin);response.setHeader('Access-Control-Allow-Headers','Accept');response.setHeader('Cache-Control','no-store');
        if(request.method==='OPTIONS'){response.writeHead(204);response.end();return;}
        const path=new URL(request.url,'http://localhost').pathname;
        if(path==='/pending-url'){
            const log={type:'url'};requests.push(log);response.on('close',()=>{if(!response.writableEnded)log.canceled=true;});
            const boundary='synthetic-revocation-source',replacement=Buffer.from(generated.replacement,'base64');
            response.writeHead(200,{'Content-Type':`multipart/related; type="application/dicom"; boundary=${boundary}`});
            response.write(Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`),replacement,Buffer.from(`\r\n--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`)]));
            await delay(controls.urlDelay);log.ignoredCallbackCompleted=true;if(!response.destroyed)response.end(Buffer.concat([Buffer.from([1,2,3]),Buffer.from(`\r\n--${boundary}--\r\n`)]));return;
        }
        const match=path.match(/^\/(first|second)\/dicom-web\/studies\/([^/]+)\/series\/([^/]+)\/(metadata|instances)(?:\/([^/]+))?$/);
        if(!match){response.writeHead(404);response.end();return;}
        const index=[study(0),study(1)].indexOf(match[2]);if(index<0||match[3]!==series(index)){response.writeHead(404);response.end();return;}
        const log={type:match[4]==='metadata'?'metadata':'instance',archive:match[1],study:index};requests.push(log);response.on('close',()=>{if(!response.writableEnded)log.canceled=true;});
        if(match[4]==='metadata'){
            if(index===1&&controls.metadataDelay)await delay(controls.metadataDelay);log.ignoredCallbackCompleted=true;
            if(!response.destroyed){response.writeHead(200,{'Content-Type':'application/dicom+json'});response.end(JSON.stringify(frames[index].map(frame=>frame.metadata)));}return;
        }
        const z=frames[index].findIndex((_frame,z)=>sop(index,z)===match[5]);if(z<0){response.writeHead(404);response.end();return;}log.frame=z;
        response.writeHead(200,{'Content-Type':'application/dicom'});response.end(frames[index][z].bytes);
    });await new Promise(done=>server.listen(0,'127.0.0.1',done));
    return{first:`http://127.0.0.1:${server.address().port}/first/dicom-web/`,second:`http://127.0.0.1:${server.address().port}/second/dicom-web/`,pending:`http://127.0.0.1:${server.address().port}/pending-url`};
}
async function mixed(baseUrl){
    await browser.evaluate('(async()=>{window.__v.setActiveViewport(0);await window.__v.openFiles([window.__file("local")]);await window.__v.setLayout(2);window.__v.addAnnotation({tool:"length",points:[{x:.5,y:.5},{x:1.5,y:.5}]});})()');
    await browser.evaluate(`window.__v.configureArchive({baseUrl:${quote(baseUrl)}})`);await browser.evaluate(`window.__v.addArchiveSeries(${quote(study(0))},${quote(series(0))},{viewport:1})`);
    await browser.evaluate('window.__v.setActiveViewport(1);window.__v.addAnnotation({tool:"length",points:[{x:.5,y:.5},{x:1.5,y:.5}]});window.__v.addOverlay({id:"protected-mask",kind:"binary",values:Array(64*96).fill(1),opacity:.5,color:[255,0,0]})');
    await browser.until(`!window.__shadow.querySelector('.workspace-pane[data-slot="1"] .derived-overlay-canvas').hidden`,'Protected synthetic mask did not display.');
}
try{
    await mkdir(qa,{recursive:true});await mkdir(output,{recursive:true});temporary=await mkdtemp(join(tmpdir(),'easi-view-revocation-'));
    const info=JSON.parse(await readFile(resolve(root,'dist/build-info.json'),'utf8')),urls=await begin();
    await writeFile(resolve(qa,'fixtures.json'),JSON.stringify(generated));await writeFile(resolve(qa,'host.css'),'body{margin:0;background:#090f18}#mount{height:950px;width:100%}');
    await writeFile(resolve(qa,'index.html'),'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="host.css"><div id="mount"></div><script type="module" src="host.js"></script>');
    await writeFile(resolve(qa,'host.js'),`import{createViewer}from'../assets/easi-view.js';window.__data=await(await fetch('./fixtures.json')).json();window.__stored=new WeakMap();window.__events=[];
const originalContext=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(kind,...args){const gl=originalContext.call(this,kind,...args);if(kind==='webgl2'&&gl&&!gl.__revocationHook){gl.__revocationHook=true;const canvas=this,upload=gl.texImage2D.bind(gl);gl.texImage2D=(...args)=>{if(args[6]===gl.RED&&args[8]?.length)window.__stored.set(canvas,args[8][0]);return upload(...args);};}return gl;};
window.__file=name=>new File([Uint8Array.from(atob(window.__data[name]),c=>c.charCodeAt(0))],'synthetic-'+name+'.dcm');
window.__delayedBad=()=>{window.__badStarted=false;window.__badCanceled=0;window.__badCompleted=false;class SlowFile extends File{stream(){return new ReadableStream({start(controller){window.__badStarted=true;setTimeout(()=>{window.__badCompleted=true;try{controller.enqueue(Uint8Array.from([1,2,3]));controller.close();}catch{}},500);},cancel(){window.__badCanceled++;}});}}return new SlowFile([new Uint8Array([1,2,3])],'synthetic-delayed-invalid.dcm');};
window.__mount=async()=>{window.__v=createViewer(document.getElementById('mount'),{initialDemo:null});for(const type of['sourcechange','framechange','derivedchange','error'])window.__v.on(type,detail=>window.__events.push({type,detail}));await window.__v.ready;window.__shadow=document.getElementById('mount').querySelector('easi-view-embed').shadowRoot;};
window.__visible=()=>Array.from(window.__shadow.querySelectorAll('.workspace-pane')).map(pane=>({empty:!pane.querySelector('[data-pane-id="viewport-empty"]').hidden,stored:window.__stored.get(pane.querySelector('.viewport-canvas'))??null}));await window.__mount();window.__ready=true;`);
    browser=await browserSession(temporary);await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1050,deviceScaleFactor:1,mobile:false});
    await browser.send('Page.navigate',{url:new URL('qa-revocation/index.html',target).href});await browser.until('window.__ready','Revocation host did not mount.');
    await mixed(urls.first);let before=await state();assert.equal(before.annotations.count,2);assert.equal(before.workspace.viewports[0].image.rows,2);assert.equal(before.visible[0].stored,7);assert.equal(before.visible[1].stored,100);
    record('synthetic mixed local/archive panes have independent original samples, annotations, thumbnail and mask ownership');
    await browser.evaluate('window.__pending=window.__v.openFiles([window.__file("replacement"),window.__delayedBad()]).then(()=>({ok:true}),e=>({ok:false,name:e.name}));true');
    await browser.until('window.__badStarted&&window.__v.getState().busy&&window.__v.getState().sourceType==="files"&&window.__visible()[1].stored===77','Local replacement did not reach its accepted pending rollback state.');
    await browser.evaluate('window.__v.disconnectArchive()');let after=await state();noRemote(after);assert.equal(after.visible[0].stored,7);assert.equal(after.annotations.count,1);assert.equal(after.annotations.canUndo,false);assert.equal(after.annotations.canRedo,false);
    assert.equal((await browser.evaluate('window.__pending')).name,'AbortError');await browser.until('window.__badCompleted','Ignored local source callback did not complete.');assert.ok(await browser.evaluate('window.__badCanceled')>=1);noRemote(await state());
    await browser.evaluate('window.__v.undoAnnotations();window.__v.redoAnnotations()');assert.equal((await state()).annotations.count,1);
    record('disconnect cancels an accepted local replacement and sanitizes protected rollback images, presentations, masks and undo history while preserving its local pane');
    record('a deliberately ignored canceled File callback cannot restore protected images or create a late visible source');
    await browser.evaluate('window.__v.clearAnnotations()');await mixed(urls.first);
    await browser.evaluate(`window.__pending=window.__v.openUrl(${quote(urls.pending)}).then(()=>({ok:true}),e=>({ok:false,name:e.name}));true`);
    await browser.until('window.__v.getState().busy&&window.__v.getState().sourceType==="url"&&window.__visible()[1].stored===77','Multipart URL replacement did not reach its accepted pending rollback state.');
    await browser.evaluate('window.__v.disconnectArchive()');assert.equal((await browser.evaluate('window.__pending')).name,'AbortError');noRemote(await state());assert.equal((await state()).visible[0].stored,7);
    for(let i=0;i<100&&!requests.find(log=>log.type==='url')?.ignoredCallbackCompleted;i++)await delay(10);assert.equal(requests.find(log=>log.type==='url').canceled,true);noRemote(await state());
    record('disconnect cancels an accepted multipart URL replacement, hides protected rollback pixels and prevents the delayed second-part failure from restoring them');
    await browser.evaluate('window.__v.clearAnnotations()');await mixed(urls.first);const remoteThumbnails=(await state()).workspace.thumbnailBytes;
    await browser.evaluate('window.__v.openFiles([window.__file("replacement")])');before=await state();assert.equal(before.state.sourceType,'files');assert.ok(before.workspace.thumbnailBytes>=remoteThumbnails);
    await browser.evaluate('window.__v.disconnectArchive()');after=await state();noRemote(after);assert.ok(after.workspace.thumbnailBytes<=16);assert.ok(after.workspace.thumbnailBytes<remoteThumbnails);assert.equal(after.visible[1].stored,77);
    record('disconnect purges historical archive thumbnails after their source was already replaced and disposed, retaining only current local preview bytes');
    await browser.evaluate('window.__v.clearAnnotations()');await mixed(urls.first);controls.metadataDelay=650;const requestStart=requests.length;
    await browser.evaluate(`window.__pending=window.__v.applyStudyContext(${quote(context)},{archiveKey:'primary'}).then(()=>({ok:true}),e=>({ok:false,name:e.name}));true`);
    for(let i=0;i<100&&!requests.slice(requestStart).some(log=>log.type==='metadata'&&log.study===1);i++)await delay(10);assert.ok(requests.slice(requestStart).some(log=>log.type==='metadata'&&log.study===1));
    const configuration=await browser.evaluate(`window.__v.configureArchive({baseUrl:${quote(urls.second)}})`);assert.equal(configuration.connected,true);
    assert.equal((await browser.evaluate('window.__pending')).name,'AbortError');noRemote(await state());await delay(700);noRemote(await state());assert.equal((await state()).state.archive.connected,true);controls.metadataDelay=0;
    assert.equal(requests.slice(requestStart).filter(log=>log.type==='instance'&&log.study===1).length,0);
    record('synchronous archive configuration replacement revokes the previous pending context and its late metadata without rolling back denied panes or fetching obsolete pixels');
    await browser.evaluate('window.__v.setActiveViewport(0);window.__v.clearDerived();window.__v.openFiles([window.__file("large")])');
    const pendingDispose=await browser.evaluate('(async()=>{window.__v.addOverlay({id:"pending-large-mask",kind:"binary",values:Array(512*512).fill(1),opacity:.5,color:[255,0,0]});const started=window.__v.getPerformance();window.__v.dispose();const immediate=window.__v.getPerformance();await window.__v.whenDisposed();return{started,immediate,completed:window.__v.getPerformance(),derived:window.__v.getDerivedState()};})()');
    assert.ok(pendingDispose.started.resources.overlayRenderBytes>=512*512*8);assert.equal(pendingDispose.immediate.resources.cleanupPending,true);assert.ok(pendingDispose.immediate.resources.overlayRenderBytes>0);
    assert.equal(pendingDispose.completed.resources.overlayRenderBytes,0);assert.equal(pendingDispose.completed.resources.overlayBytes,0);assert.equal(pendingDispose.completed.resources.workerCount,0);assert.equal(pendingDispose.completed.resources.cleanupPending,false);assert.equal(pendingDispose.derived.disposed,true);
    record('whenDisposed waits for a real yielding mask scan to cancel and release pending RGBA/bitmap reservations before reporting complete global cleanup');
    const network=requests.length;await browser.evaluate('window.__mount()');after=await state();assert.equal(after.state.archive.connected,false);assert.equal(after.state.seriesCount,0);assert.equal(after.annotations.count,0);assert.equal(after.derived.overlayCount,0);assert.equal(after.performance.resources.thumbnailBytes,0);assert.equal(requests.length,network);
    await browser.evaluate('(async()=>{window.__v.dispose();await window.__v.whenDisposed();})()');assert.equal(browser.errors.length,0);assert.equal(browser.consoleErrors.length,0);
    record('fresh re-mount inherits no archive client, protected source/history, derived mask or thumbnail state and performs no implicit retrieval');
    assert.equal(JSON.parse(await readFile(resolve(root,'dist/build-info.json'),'utf8')).sourceDigest,info.sourceDigest);
    await writeFile(resolve(output,'results.json'),JSON.stringify({passed:checks.length,checks,sourceDigest:info.sourceDigest,harnessSha256:createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'),fixtureSha256:createHash('sha256').update(JSON.stringify(generated)).digest('hex'),requests,browserExceptions:0,consoleErrors:0,originalImagingFilesUsed:false,profilesSaved:false,resourceScope:'Owned mask/bitmap/canvas/cache reservations only; process heap and GPU usage are not measured.'},null,2)+'\n');
    console.log(`Revocation browser checks: ${checks.length} passed.`);
}finally{browser?.close();server?.closeAllConnections();if(server)await new Promise(done=>server.close(done));await rm(qa,{recursive:true,force:true});if(temporary){await delay(200);await rm(temporary,{recursive:true,force:true});}}
