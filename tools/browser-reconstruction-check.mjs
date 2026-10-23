import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile, readFile, rm, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createDicomFixture } from '../src/data/synthetic.js';
import { browserSession, delay } from './browser-session.mjs';

const root=resolve(import.meta.dirname,'..'),qa=resolve(root,'dist/qa'),output=resolve(root,'artifacts/browser-reconstruction');
const target=new URL(process.env.EASI_VIEW_URL||'http://127.0.0.1:5182/');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname));
const checks=[],requests=[],quote=JSON.stringify,record=(name,detail={})=>{checks.push({name,...detail});console.log(`PASS ${name}`);};
const close=(value,expected)=>assert.ok(Math.abs(value-expected)<1e-6,`${value} differs from independent ${expected}`);
const attr=(vr,...Value)=>({vr,Value}),classUid='1.2.840.10008.5.1.4.1.1.7.3',study='2.25.950';
const series=index=>`2.25.${951+index}.99`,sop=(index,frame)=>`2.25.${951+index}.${frame+1}`,forUid=index=>`2.25.${951+index}.55`;
const frames=(index,geometry=true)=>[2,0,1].map(z=>{
    const position=[10+z,20,30+z*2],values=Array.from({length:12},(_,n)=>index===1?50+Math.floor(n/4)*2+n%4+z*3:230+6*(n%4)+6*Math.floor(n/4)+12*z);
    const bytes=createDicomFixture({rows:3,columns:4,bitsStored:12,values,modality:index===1?'PT':'CT',sopClass:classUid,
        sopUid:sop(index,z),seriesUid:series(index),position,orientation:[1,0,0,0,1,0],pixelSpacing:[2,3],instanceNumber:z+1,
        slope:index===1?1:2,intercept:index===1?0:-100,rescaleType:index===1?'SUV':'HU',window:{center:index===1?64:400,width:index===1?128:800},
        extraAttributes:{'0020000D':['UI',study],'00200052':geometry?['UI',forUid(index)]:null,'00281056':['CS','LINEAR_EXACT']}});
    const metadata={'00080016':attr('UI',classUid),'00080018':attr('UI',sop(index,z)),'00080060':attr('CS',index===1?'PT':'CT'),
        '0020000D':attr('UI',study),'0020000E':attr('UI',series(index)),'00200052':attr('UI',forUid(index)),
        '00200013':attr('IS',z+1),'00200032':attr('DS',...position),'00200037':attr('DS',1,0,0,0,1,0),
        '00280002':attr('US',1),'00280004':attr('CS','MONOCHROME2'),'00280008':attr('IS',1),'00280010':attr('US',3),'00280011':attr('US',4),'00280030':attr('DS',2,3),
        '00280100':attr('US',16),'00280101':attr('US',12),'00280102':attr('US',11),'00280103':attr('US',0),
        '00281050':attr('DS',400),'00281051':attr('DS',800),'00281052':attr('DS',-100),'00281053':attr('DS',2),'00281054':attr('LO','HU'),'00281056':attr('CS','LINEAR_EXACT'),
        '7FE00010':{vr:'OW',BulkDataURI:'https://synthetic.invalid/not-followed'}};
    return{z,bytes,metadata,encoded:Buffer.from(bytes).toString('base64')};
});
const base=frames(0),overlay=frames(1),missing=frames(2,false),encoded=[base,overlay,missing].map(group=>group.map(frame=>frame.encoded));
const reference=patient=>4*patient[0]+6*patient[1]+10*patient[2]-100;
let server,browser,temporary;const control={slow:null};
function resources(snapshot){assert.ok(snapshot.volumeBytes<=snapshot.volumeBudget);assert.ok(snapshot.derivedBytes<=snapshot.derivedBudget);}
const state=()=>browser.evaluate('({main:window.__v.getState(),workspace:window.__v.getWorkspaceState(),reconstruction:window.__v.getReconstructionState(),performance:window.__v.getPerformance()})');
async function startServer(){
    server=createServer(async(request,response)=>{
        response.setHeader('Access-Control-Allow-Origin',target.origin);response.setHeader('Access-Control-Allow-Headers','Accept');response.setHeader('Cache-Control','no-store');
        if(request.method==='OPTIONS'){response.writeHead(204);response.end();return;}
        const path=new URL(request.url,'http://localhost').pathname;
        if(path.endsWith('/metadata')){requests.push({type:'metadata'});response.setHeader('Content-Type','application/dicom+json');response.end(JSON.stringify(base.map(frame=>frame.metadata)));return;}
        const frame=base.find(frame=>path.endsWith('/instances/'+sop(0,frame.z)));
        if(!frame){response.writeHead(404);response.end();return;}
        const log={type:'instance',frame:frame.z};requests.push(log);response.on('close',()=>{if(!response.writableEnded)log.canceled=true;});
        if(frame.z===control.slow)await delay(1000);
        if(!response.destroyed){response.setHeader('Content-Type','application/dicom');response.end(frame.bytes);}
    });await new Promise(done=>server.listen(0,'127.0.0.1',done));
}
try{
    await mkdir(output,{recursive:true});await mkdir(qa,{recursive:true});temporary=await mkdtemp(join(tmpdir(),'easi-view-reconstruction-'));
    const info=JSON.parse(await readFile(resolve(root,'dist/build-info.json'),'utf8'));await startServer();const baseUrl=`http://127.0.0.1:${server.address().port}/dicom-web/`;
    await writeFile(resolve(qa,'fixtures.json'),JSON.stringify(encoded));
    await writeFile(resolve(qa,'host.css'),'body{margin:0;background:#090f18}#mount{height:980px;width:100%}');
    await writeFile(resolve(qa,'index.html'),'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="host.css"><div id="mount"></div><script type="module" src="host.js"></script>');
    await writeFile(resolve(qa,'host.js'),`import{createViewer}from'../assets/easi-view.js';const data=await(await fetch('./fixtures.json')).json();window.__files=(group='all')=>(group==='all'?data.flat():data[group]).map((text,index)=>new File([Uint8Array.from(atob(text),c=>c.charCodeAt(0))],'synthetic-reconstruction-'+index+'.dcm'));window.__v=createViewer(document.getElementById('mount'));window.__events=[];window.__v.on('reconstructionchange',detail=>window.__events.push(detail));await window.__v.ready;window.__shadow=document.getElementById('mount').querySelector('easi-view-embed').shadowRoot;window.__canvases=()=>Array.from(window.__shadow.querySelectorAll('.reconstruction-panel canvas'));window.__pixels=(view,column,row)=>Array.from(window.__canvases()[view].getContext('2d').getImageData(column,row,1,1).data);window.__ready=true;`);
    browser=await browserSession(temporary);await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1050,deviceScaleFactor:1,mobile:false});await browser.send('Page.navigate',{url:new URL('qa/index.html',target).href});await browser.until('window.__ready','Reconstruction host did not mount.');
    let snapshot=await state();assert.equal(snapshot.reconstruction.open,false);assert.equal(snapshot.reconstruction.volumeBytes,0);assert.equal(snapshot.reconstruction.derivedBytes,0);assert.deepEqual(await browser.evaluate('window.__canvases().map(c=>[c.width,c.height])'),[[0,0],[0,0],[0,0],[0,0]]);
    record('reconstruction starts closed with no derived/volume allocations and zero-sized canvases');
    await browser.evaluate('(async()=>{await window.__v.openFiles(window.__files());window.__v.setWindow({center:400,width:800});})()');const original=await state();
    await browser.evaluate('window.__v.openReconstruction()');await browser.evaluate('window.__v.setReconstruction({maximumSize:16})');snapshot=await state();
    assert.deepEqual(snapshot.reconstruction.dimensions,[4,3,3]);assert.equal(snapshot.reconstruction.volumeBytes,396);assert.equal(snapshot.reconstruction.viewCount,4);resources(snapshot.reconstruction);
    const resolution=await browser.evaluate('(()=>{const select=Array.from(window.__shadow.querySelectorAll(".reconstruction-field")).find(label=>label.firstElementChild.textContent==="Output resolution").querySelector("select");return{value:select.value,text:select.selectedOptions[0]?.textContent,options:select.options.length};})()');assert.equal(resolution.value,'16');assert.match(resolution.text,/16/);assert.equal(resolution.options,4);
    const probes=await browser.evaluate('[0,1,2,3].map(view=>window.__v.probeReconstruction(view,7,view===2?7:3))');
    const expected=[[10+7*11/15,22,32],[10+7*11/15,22,32],[15.5,20+7*4/15,34-7*4/15],[10+7*11/15,22,32]];
    probes.forEach((probe,index)=>{assert.equal(probe.kind,'derived-modality');assert.equal(probe.unit,'HU');probe.patient.forEach((value,axis)=>close(value,expected[index][axis]));close(probe.value,reference(expected[index]));});
    assert.deepEqual(snapshot.workspace.viewports,original.workspace.viewports);assert.equal(snapshot.performance.resources.workerCount,1);
    record('real EASI Part10 assembly produces independent LPS affine/shear values across axial/coronal/sagittal/oblique views without changing the original pane');
    const scalarPixel=await browser.evaluate('window.__pixels(0,7,3)'),level=Math.round(reference(expected[0])/800*255);scalarPixel.slice(0,3).forEach(value=>assert.ok(Math.abs(value-level)<=1));assert.equal(scalarPixel[3],255);
    const visibleProbe=await browser.evaluate('(()=>{const c=window.__canvases()[0],r=c.getBoundingClientRect(),scale=Math.min(r.width/c.width,r.height/c.height);c.dispatchEvent(new PointerEvent("pointermove",{clientX:r.left+(r.width-c.width*scale)/2+7.5*scale,clientY:r.top+(r.height-c.height*scale)/2+3.5*scale,bubbles:true}));return window.__shadow.querySelector(".reconstruction-probe").textContent;})()');assert.match(visibleProbe,/DERIVED · slice/);assert.match(visibleProbe,/15\.13, 22\.00, 32\.00/);
    record('actual Canvas2D pixels window Float64 modality values once, with independent quantitative grayscale reference and contain-mapped UI probes');
    const cache=await browser.evaluate('window.__v.getWorkspaceState().decodedBytes');
    await browser.evaluate('window.__v.setReconstruction({projection:"mip",thicknessMm:2})');let projected=await browser.evaluate('window.__v.probeReconstruction(0,7,3)');close(projected.value,reference(expected[0])+10);
    await browser.evaluate('window.__v.setReconstruction({projection:"minip"})');projected=await browser.evaluate('window.__v.probeReconstruction(0,7,3)');close(projected.value,reference(expected[0])-10);
    await browser.evaluate('window.__v.setReconstruction({projection:"mean"})');projected=await browser.evaluate('window.__v.probeReconstruction(0,7,3)');close(projected.value,reference(expected[0]));
    assert.equal(await browser.evaluate('window.__v.getWorkspaceState().decodedBytes'),cache);
    record('finite slab MIP/minIP/mean match analytic modality references and reuse source decoding');
    await browser.evaluate('window.__v.setReconstruction({projection:"slice",thicknessMm:0,yawDeg:30,pitchDeg:20})');
    const oblique=await browser.evaluate('(()=>{const c=window.__canvases()[3];return window.__v.probeReconstruction(3,Math.floor(c.width/2),Math.floor(c.height/2));})()');assert.equal(oblique.kind,'derived-modality');close(oblique.value,reference(oblique.patient));
    record('oblique patient-space interpolation retains a quantitative analytic field');
    await browser.evaluate('window.__v.setReconstruction({yawDeg:0,pitchDeg:0,fourth:"3d",rayMode:"mip"})');const ray=await browser.evaluate('window.__v.probeReconstruction(3,7,3)');assert.equal(ray.kind,'parallel-ray-color');assert.equal(Object.hasOwn(ray,'value'),false);
    const rayLevel=Math.round((reference(expected[0])+20)/800*255);ray.rgba.slice(0,3).forEach(value=>assert.ok(Math.abs(value-rayLevel)<=1));
    record('parallel-ray MIP displays independently computed colors and explicitly avoids a fabricated single-voxel probe');
    await browser.evaluate('window.__v.setReconstruction({rayMode:"composite",color:"warm",opacity:.2})');const composite=await browser.evaluate('window.__v.probeReconstruction(3,7,3)');
    let red=0,green=0,blue=0,alpha=0;for(let z=30;z<=34;z++){const l=reference([expected[0][0],22,z])/800,a=l*.2,weight=(1-alpha)*a;red+=l*weight;green+=l*.6*weight;blue+=l*.2*weight;alpha+=weight;}
    const rgba=[Math.round(red/alpha*255),Math.round(green/alpha*255),Math.round(blue/alpha*255),Math.round(alpha*255)];composite.rgba.forEach((value,index)=>assert.ok(Math.abs(value-rgba[index])<=1));
    record('parallel color/opacity compositing matches an independent front-to-back sample reference');
    const missingRegistration=await browser.evaluate('(async()=>{try{await window.__v.setReconstructionFusion(1,{registration:{matrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}});return false;}catch{return true;}})()');assert.equal(missingRegistration,true);
    const registration={matrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],fromFrameOfReferenceUid:forUid(0),toFrameOfReferenceUid:forUid(1)};
    await browser.evaluate(`window.__v.setReconstructionFusion(1,{registration:${quote(registration)},window:{center:64,width:128,voiFunction:'LINEAR_EXACT'},alpha:.5})`);
    const fusion=await browser.evaluate('window.__v.probeReconstruction(3,7,3)');assert.equal(fusion.kind,'derived-fusion');assert.equal(fusion.baseUnit,'HU');assert.equal(fusion.overlayUnit,'SUV');close(fusion.base,reference(expected[0]));
    const x=(expected[0][0]-11)/3,y=1,z=1;close(fusion.overlay,50+x+2*y+3*z);
    record('cross-FoR fusion requires explicit rigid identifiers and keeps independently sampled HU/SUV channels separate');
    await browser.evaluate('window.__v.setReconstruction({fusionAlpha:0})');assert.deepEqual(await browser.evaluate('window.__pixels(3,7,3)'),await browser.evaluate('window.__pixels(0,7,3)'));
    const before=await browser.evaluate('window.__v.probeReconstruction(0,7,3)');const invalid=await browser.evaluate('(async()=>{try{await window.__v.setReconstruction({maximumSize:257});return false;}catch{return true;}})()');assert.equal(invalid,true);assert.deepEqual(await browser.evaluate('window.__v.probeReconstruction(0,7,3)'),before);
    record('fusion opacity affects display only and invalid replacement settings preserve the committed quantitative views');
    await browser.evaluate('(()=>{const context=window.__canvases()[2].getContext("2d"),original=context.putImageData.bind(context);let once=true;context.putImageData=(...args)=>{if(once){once=false;throw new Error("Synthetic canvas rejection");}return original(...args);};window.__restoreCanvas=()=>context.putImageData=original;})()');
    const rejected=await browser.evaluate('window.__v.setReconstruction({axialPosition:0}).then(()=>false,()=>true)');assert.equal(rejected,true);await browser.evaluate('window.__restoreCanvas()');assert.deepEqual(await browser.evaluate('window.__v.probeReconstruction(0,7,3)'),before);
    record('a rejected Canvas2D replacement restores every previously committed derived image');
    await browser.evaluate('window.__v.assignViewportSeries(0,2)');const unavailable=await browser.evaluate('window.__v.openReconstruction().then(()=>false,()=>true)');assert.equal(unavailable,true);assert.deepEqual(await browser.evaluate('window.__v.probeReconstruction(0,7,3)'),before);await browser.evaluate('window.__v.assignViewportSeries(0,0)');
    record('missing Frame of Reference rejects a replacement volume before changing the previous derived views');
    const stale=await browser.evaluate('(async()=>{const a=window.__v.setReconstruction({yawDeg:10}).then(()=>({ok:true}),e=>({ok:false,name:e.name}));await window.__v.setReconstruction({pitchDeg:20,maximumSize:16});return await a;})()');assert.equal(stale.ok,false);assert.equal(stale.name,'AbortError');resources((await state()).reconstruction);
    record('rapid reconstruction patches cancel stale generations and preserve the latest combined controls');
    await browser.evaluate('window.__v.setReconstruction({maximumSize:128})');await browser.screenshot('reconstruction-synthetic');await copyFile(join(temporary,'reconstruction-synthetic.png'),resolve(output,'reconstruction-synthetic.png'));
    const modal=await browser.evaluate('({inert:Array.from(window.__shadow.querySelector(".viewer-shell").children).filter(n=>!n.classList.contains("reconstruction-workspace")).every(n=>n.inert),focus:window.__shadow.activeElement?.className,rect:window.__shadow.querySelector(".reconstruction-workspace").getBoundingClientRect().toJSON()})');assert.equal(modal.inert,true);assert.match(modal.focus,/reconstruction-close/);
    await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await browser.until('!window.__v.getReconstructionState().open','Escape did not close reconstruction.');assert.equal((await state()).reconstruction.volumeBytes,0);
    record('modal focus/inert scope and Escape close leave the ordinary image workspace intact');
    await browser.send('Emulation.setDeviceMetricsOverride',{width:480,height:900,deviceScaleFactor:1,mobile:true});await browser.evaluate('window.__v.openReconstruction()');await browser.evaluate('window.__v.setReconstruction({maximumSize:128})');assert.equal(await browser.evaluate('window.innerWidth'),480);
    const mobile=await browser.evaluate('window.__canvases().map(c=>({width:c.getBoundingClientRect().width,height:c.getBoundingClientRect().height}))');assert.ok(mobile.every(r=>r.width>20&&r.height>20));
    await browser.screenshot('reconstruction-mobile-synthetic');await copyFile(join(temporary,'reconstruction-mobile-synthetic.png'),resolve(output,'reconstruction-mobile-synthetic.png'));
    await browser.evaluate('window.__v.closeReconstruction()');await browser.send('Emulation.clearDeviceMetricsOverride');
    record('mobile reconstruction exposes four bounded visible canvases and closes with zero derived allocations');
    await browser.evaluate(`(async()=>{window.__v.configureArchive({baseUrl:${quote(baseUrl)}});await window.__v.openArchiveSeries(${quote(study)},${quote(series(0))});})()`);control.slow=1;const start=requests.length;
    await browser.evaluate('window.__pending=window.__v.openReconstruction().then(()=>({ok:true}),e=>({ok:false,name:e.name}));true');for(let i=0;i<100&&!requests.slice(start).some(r=>r.frame===1);i++)await delay(10);
    assert.ok(requests.slice(start).some(r=>r.frame===1));await browser.evaluate('window.__v.closeReconstruction()');const canceled=await browser.evaluate('window.__pending');assert.equal(canceled.name,'AbortError');assert.equal((await state()).reconstruction.volumeBytes,0);
    record('closing pending archive volume assembly cancels source retrieval and returns no late volume');
    const replacing=requests.length;await browser.evaluate('window.__pending=window.__v.openReconstruction().then(()=>({ok:true}),e=>({ok:false,name:e.name}));true');for(let i=0;i<100&&!requests.slice(replacing).some(r=>r.frame===1);i++)await delay(10);
    await browser.evaluate('window.__v.openFiles(window.__files(0))');const replaced=await browser.evaluate('window.__pending');assert.equal(replaced.name,'AbortError');assert.equal((await state()).reconstruction.open,false);control.slow=null;
    record('source replacement cancels pending reconstruction without reopening obsolete patient-space views');
    await browser.evaluate(`(async()=>{window.__v.configureArchive({baseUrl:${quote(baseUrl)}});await window.__v.openArchiveSeries(${quote(study)},${quote(series(0))});})()`);control.slow=1;const disposing=requests.length;await browser.evaluate('window.__pending=window.__v.openReconstruction().then(()=>({ok:true}),e=>({ok:false,name:e.name}));true');for(let i=0;i<100&&!requests.slice(disposing).some(r=>r.frame===1);i++)await delay(10);assert.ok(requests.slice(disposing).some(r=>r.frame===1));assert.ok((await state()).reconstruction.pendingVolumeBytes>0);const disposed=await browser.evaluate('(async()=>{const events=window.__events;window.__v.dispose();await window.__v.whenDisposed();return{events,reconstruction:window.__v.getReconstructionState(),performance:window.__v.getPerformance()};})()');
    assert.equal((await browser.evaluate('window.__pending')).name,'AbortError');assert.equal(disposed.reconstruction.disposed,true);assert.equal(disposed.reconstruction.volumeBytes,0);assert.equal(disposed.reconstruction.derivedBytes,0);assert.equal(disposed.performance.resources.workerCount,0);
    assert.ok(!/"(?:patientName|patientId|sopUid|seriesUid|frameOfReferenceUid|points|samples|rgba|position)"\s*:|2\.25\.95[0-4]/.test(JSON.stringify(disposed.events)));assert.ok(!/"(?:window|patient|baseValues|overlayValues)"/.test(JSON.stringify(disposed.events.map(e=>e.reconstruction))));
    assert.equal(browser.errors.length,0);assert.equal(browser.consoleErrors.length,0);record('explicit cleanup completion cancels pending assembly and releases reconstruction/shared worker resources and automatic events expose no coordinates, references or pixels');
    assert.equal(JSON.parse(await readFile(resolve(root,'dist/build-info.json'),'utf8')).sourceDigest,info.sourceDigest);
    await writeFile(resolve(output,'results.json'),JSON.stringify({passed:checks.length,checks,sourceDigest:info.sourceDigest,harnessSha256:createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'),fixtureSha256:createHash('sha256').update(JSON.stringify(encoded)).digest('hex'),requests,browserExceptions:0,consoleErrors:0,originalImagingFilesUsed:false,profilesSaved:false},null,2)+'\n');
    console.log(`Reconstruction browser checks: ${checks.length} passed.`);
}finally{browser?.close();server?.closeAllConnections();if(server)await new Promise(done=>server.close(done));await rm(qa,{recursive:true,force:true});if(temporary){await delay(200);await rm(temporary,{recursive:true,force:true});}}
