import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createLocalLibraryFixtures } from '../test/local-library-fixtures.js';
import { createDicomdirMedia } from '../test/dicomdir-fixtures.js';
import { createDicomFixture } from '../src/data/synthetic.js';
import { browserSession } from './browser-session.mjs';
import { startCorpusServer } from './local-corpus-check.mjs';
import { sourceDigest } from './source-digest.mjs';

// Only generated fixtures enter the disposable browser. No personal imaging
// collection is discovered, copied, served, uploaded, or captured.
const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'artifacts/browser-session-navigation');
const fixtures = createLocalLibraryFixtures(), media = createDicomdirMedia({multiPatient: true});
fixtures.push({key:'us-cine',name:'GENERATED_US_WITHOUT_EXTENSION',bytes:createDicomFixture({rows:2,columns:2,frames:3,values:[50,60,70,80,100,110,120,130,150,160,170,180],modality:'US',sopClass:'1.2.840.10008.5.1.4.1.1.3.1',sopUid:'2.25.998.20.1.1',seriesUid:'2.25.998.20.1',window:{center:512,width:1024},extraAttributes:{'0020000D':['UI','2.25.998.20'],'00100010':['PN','SYNTHETIC^CINE'],'00100020':['LO','CINE'],'00100021':['LO','SYNTHETIC_CINE'],'00081030':['LO','Generated multiframe ultrasound'],'0008103E':['LO','Generated ultrasound clip']}})});
// Missing issuer is deliberate: these patient identities must remain scoped to
// their import, so closing must forget the old local records before reimport.
for (const file of media.files.filter(item => Array.isArray(item.values))) {
    file.bytes = createDicomFixture({rows:2,columns:2,values:file.values,sopUid:file.sopUid,seriesUid:file.seriesUid,description:file.seriesDescription,modality:'CT',instanceNumber:file.instance,position:[0,0,file.instance-1],pixelSpacing:[1,1],window:{center:512,width:1024},extraAttributes:{'00080020':['DA',file.date],'00080030':['TM','110000'],'00081030':['LO',file.description],'00100010':['PN',`SYNTHETIC^${file.patient}`],'00100020':['LO',`MEDIA_${file.patient}`],'00100021':['LO',''],'00100030':['DA',file.patient==='BETA'?'19800102':'19700101'],'0020000D':['UI',file.studyUid],'00200011':['IS',file.series],'00200052':['UI',`${file.studyUid}.99`]}});
}
const quote = JSON.stringify, checks = [], remoteRequests = [];
const encode = ({bytes, ...metadata}) => ({...metadata, encoded: Buffer.from(bytes).toString('base64')});
const record = (name, details = {}) => { checks.push({name, ...details}); console.log(`PASS ${name}`); };
let browser, server, proxy, temporary, origin;
const evaluate = expression => browser.evaluate(expression);
const run = source => evaluate(`(async () => { ${source} })()`);
const select = selector => `window.__shadow.querySelector(${quote(selector)})`;
const click = selector => evaluate(`(() => {const node=${select(selector)};if(!node)throw new Error('Missing session control: '+${quote(selector)});node.focus();node.click();})()`);
const action = (name, extra = '') => click(`[data-open-action="${name}"]${extra}`);
const state = () => evaluate('({view:window.__v.getState(),session:window.__v.getSessionState(),catalog:window.__v.getSessionCatalog(),workspace:window.__v.getWorkspaceState(),annotations:window.__v.getAnnotationState(),uploads:window.__qa.uploads,draws:window.__qa.draws,performance:window.__v.getPerformance()})');
const idle = () => browser.until('!window.__v.getState().busy&&!window.__v.getSessionState().busy&&!window.__v.getOpenWorkflowState().busy', 'Session navigation did not finish.');
const screenshot = async name => {await run("await Promise.allSettled(Array.from(window.__shadow.querySelectorAll('dialog[open]')).flatMap(node=>node.getAnimations({subtree:true})).filter(animation=>animation.effect?.getComputedTiming().iterations!==Infinity).map(animation=>animation.finished));return true;");await browser.screenshot(name);await copyFile(resolve(temporary,'chrome',`${name}.png`),resolve(output,`${name}.png`));};
const cardSelector = id => `.session-library-series[data-series-id="${id}"]`;
const expandStudy = async id => {if(await evaluate(`!${select(`.session-library-study[data-study-id="${id}"] .session-library-series-list`)}`))await click(`[data-session-action="toggle-study"][data-study-id="${id}"]`);};
const expandInstances = async id => {const selector=`[data-session-action="toggle-instances"][data-series-id="${id}"]`;if(await evaluate(`${select(selector)}?.getAttribute('aria-expanded')!=='true'`))await click(selector);};
const fileInput = async (keys,{kind='images',collection='images',fresh=false}={}) => {
    await evaluate(`window.__v.open(${quote(kind)})`);await action(kind==='study'?'pick-study-folder':'pick-files');
    await evaluate(`(()=>{const input=window.__shadow.getElementById(${quote(kind==='study'?'folder-input':'file-input')}),transfer=new DataTransfer();for(const file of window.__files(${quote(keys)},${quote(collection)},${fresh}))transfer.items.add(file);input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);await idle();
};
const addImages = async keys => {await fileInput(keys);await action('add');await idle();};
const addMediaStudy = async (patientId='MEDIA_ALPHA',studyUid=media.expected.currentStudyUid) => {
    await fileInput(media.files.map(file=>file.key),{kind:'study',collection:'media',fresh:true});
    await evaluate(`(()=>{const card=Array.from(window.__shadow.querySelectorAll('[data-open-action="patient"]')).find(node=>node.textContent.includes(${quote(patientId)}));if(!card)throw new Error('Missing generated media patient');card.click();})()`);
    await evaluate(`(()=>{const state=window.__v.getOpenWorkflowState();const inputs=Array.from(window.__shadow.querySelectorAll('[data-open-study]'));const box=inputs.find(node=>node.closest('label')?.textContent.includes(${quote(studyUid===media.expected.currentStudyUid?'Media follow-up':'Media baseline')}))??inputs[0];if(!box)throw new Error('Missing generated media study');box.click();})()`);
    await action('add');await idle();
};
const latestSlotSample = async slot => evaluate(`window.__qa.uploads.filter(item=>item.slot===${slot}).at(-1)?.samples`);
const assertSlotSample = async (slot,values) => {await browser.until(`JSON.stringify(window.__qa.uploads.filter(item=>item.slot===${slot}).at(-1)?.samples)===${quote(JSON.stringify(values))}`,'The expected generated pixels were not uploaded to the target pane.');assert.deepEqual(await latestSlotSample(slot),values);};
const drag = async (sourceSelector,slot) => evaluate(`(()=>{const source=${select(sourceSelector)},target=${select(`.workspace-pane[data-slot="${slot}"]`)};if(!source||!target)throw new Error('Missing drag source or target pane');const transfer=new DataTransfer();source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,composed:true,dataTransfer:transfer}));target.dispatchEvent(new DragEvent('dragenter',{bubbles:true,cancelable:true,composed:true,dataTransfer:transfer}));target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,composed:true,dataTransfer:transfer}));target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,composed:true,dataTransfer:transfer}));source.dispatchEvent(new DragEvent('dragend',{bubbles:true,cancelable:true,composed:true,dataTransfer:transfer}));return Array.from(transfer.types);})()`);

const remoteUid = '2.25.998.1', remoteSop = '1.2.840.10008.5.1.4.1.1.2';
const attribute = (vr, ...Value) => ({Value,vr});
const remoteIdentity = {'00100010':attribute('PN',{Alphabetic:'SYNTHETIC^REMOTE'}),'00100020':attribute('LO','REMOTE'),'00100021':attribute('LO','SYNTHETIC_ARCHIVE'),'00100030':attribute('DA','19700101')};
function remoteInstances(seriesUid) {
    return Array.from({length:2},(_,index)=>({...remoteIdentity,
        '00080016':attribute('UI',remoteSop),'00080018':attribute('UI',`${seriesUid}.${index+1}`),'00080060':attribute('CS','CT'),'0008103E':attribute('LO','Generated remote series'),
        '0020000D':attribute('UI',remoteUid),'0020000E':attribute('UI',seriesUid),'00200013':attribute('IS',String(index+1)),'00200032':attribute('DS',0,0,index),'00200037':attribute('DS',1,0,0,0,1,0),'00200052':attribute('UI','2.25.998.99'),
        '00280002':attribute('US',1),'00280004':attribute('CS','MONOCHROME2'),'00280008':attribute('IS','1'),'00280010':attribute('US',2),'00280011':attribute('US',2),'00280030':attribute('DS',1,1),
        '00280100':attribute('US',16),'00280101':attribute('US',16),'00280102':attribute('US',15),'00280103':attribute('US',0),'00281050':attribute('DS',512),'00281051':attribute('DS',1024),'00281052':attribute('DS',0),'00281053':attribute('DS',1),'00281054':attribute('LO','HU'),'7FE00010':{vr:'OW',BulkDataURI:'never-followed'}
    }));
}
function generatedArchive(request,response,url) {
    const path=url.pathname.slice('/dicom-web/'.length);remoteRequests.push({path,method:request.method});
    const json=value=>{response.writeHead(200,{'Content-Type':'application/dicom+json'});response.end(JSON.stringify(value));};
    if(!['GET','HEAD'].includes(request.method)){response.writeHead(405);response.end();return;}
    if(path==='studies'){json([{...remoteIdentity,'00080020':attribute('DA','20261019'),'00081030':attribute('LO','Generated remote examination'),'00080061':attribute('CS','CT'),'0020000D':attribute('UI',remoteUid),'00201206':attribute('IS','2'),'00201208':attribute('IS','4')}]);return;}
    if(path===`studies/${remoteUid}/series`){json([1,2].map(index=>({'0020000D':attribute('UI',remoteUid),'0020000E':attribute('UI',`${remoteUid}.${index}`),'00080060':attribute('CS','CT'),'0008103E':attribute('LO',`Generated remote series ${index}`),'00200011':attribute('IS',String(index)),'00201209':attribute('IS','2')})));return;}
    const match=path.match(/^studies\/([^/]+)\/series\/([^/]+)\/(metadata|instances)(?:\/([^/]+))?$/);
    if(match){const [,studyUid,seriesUid,operation,sopUid]=match;if(studyUid===remoteUid&&[`${remoteUid}.1`,`${remoteUid}.2`].includes(seriesUid)){
        if(operation==='metadata'||operation==='instances'&&!sopUid){json(remoteInstances(seriesUid));return;}
        const index=remoteInstances(seriesUid).findIndex(item=>item['00080018'].Value[0]===sopUid);
        if(index>=0){const base=seriesUid.endsWith('.2')?217:117,bytes=createDicomFixture({rows:2,columns:2,values:[base+index*10,base+20,base+40,base+60],sopUid,seriesUid,position:[0,0,index],pixelSpacing:[1,1],instanceNumber:index+1,window:{center:512,width:1024},extraAttributes:{'0020000D':['UI',remoteUid],'00200052':['UI','2.25.998.99'],'00100010':['PN','SYNTHETIC^REMOTE'],'00100020':['LO','REMOTE'],'00100021':['LO','SYNTHETIC_ARCHIVE'],'00100030':['DA','19700101']}});response.writeHead(200,{'Content-Type':'application/dicom','Content-Length':bytes.length});response.end(bytes);return;}
    }}response.writeHead(404);response.end();
}

try {
    await mkdir(output,{recursive:true});await rm(resolve(output,'results.json'),{force:true});await rm(resolve(output,'failure.json'),{force:true});
    const buildInfo=JSON.parse(await readFile(resolve(root,'dist/build-info.json'),'utf8'));
    assert.equal(buildInfo.sourceDigest,await sourceDigest(root),'Rebuild the viewer before session-navigation qualification.');
    temporary=await mkdtemp(join(tmpdir(),'easi-view-session-navigation-browser-'));const host=resolve(temporary,'host');await mkdir(host);
    await writeFile(resolve(host,'fixtures.json'),JSON.stringify({images:fixtures.map(encode),media:media.files.map(encode)}));
    await writeFile(resolve(host,'index.html'),'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./host.css"></head><body><main id="mount"></main><script type="module" src="./host.js"></script></body></html>');
    await writeFile(resolve(host,'host.css'),'body{margin:0;background:#09121b}#mount{height:100dvh;width:100%}#other-mount{position:fixed;left:-2200px;top:0;width:1000px;height:800px}');
    await writeFile(resolve(host,'host.js'),`
import {createViewer} from '/assets/easi-view.js';
const fixtures=await(await fetch('./fixtures.json')).json();
window.__qa={uploads:[],draws:0,drawSamples:[],events:[]};
const upload=WebGL2RenderingContext.prototype.texImage2D,draw=WebGL2RenderingContext.prototype.drawArrays;
WebGL2RenderingContext.prototype.texImage2D=function(...args){if(args[3]===2&&args[4]===2&&args[8]?.length===4)window.__qa.uploads.push({samples:Array.from(args[8]),slot:Number(this.canvas.closest('.workspace-pane')?.dataset.slot??0)});return upload.apply(this,args);};
WebGL2RenderingContext.prototype.drawArrays=function(...args){window.__qa.draws++;const result=draw.apply(this,args);if(this.canvas.width&&this.canvas.height){const pixel=new Uint8Array(4);this.readPixels(Math.floor(this.canvas.width/2),Math.floor(this.canvas.height/2),1,1,this.RGBA,this.UNSIGNED_BYTE,pixel);window.__qa.drawSamples.push({slot:Number(this.canvas.closest('.workspace-pane')?.dataset.slot??0),rgba:Array.from(pixel)});}return result;};
const makeFile=item=>{const file=new File([Uint8Array.from(atob(item.encoded),c=>c.charCodeAt(0))],item.name);if(item.path)Object.defineProperty(file,'webkitRelativePath',{value:item.path});return file;};
const collections=Object.fromEntries(Object.entries(fixtures).map(([name,items])=>[name,new Map(items.map(item=>[item.key,makeFile(item)]))]));
window.__files=(keys,collection='images',fresh=false)=>keys.map(key=>fresh?makeFile(fixtures[collection].find(item=>item.key===key)):collections[collection].get(key));
window.__reset=async options=>{if(window.__v){window.__v.dispose();await window.__v.whenDisposed();}window.__v=createViewer(document.getElementById('mount'),{initialDemo:null,...options});await window.__v.ready;window.__shadow=document.getElementById('mount').querySelector('easi-view-embed').shadowRoot;for(const type of ['sourcechange','librarychange','annotationchange','error'])window.__v.on(type,detail=>window.__qa.events.push({type,detail}));};
window.__makeOther=async()=>{const mount=document.createElement('div');mount.id='other-mount';document.body.append(mount);window.__other=createViewer(mount,{initialDemo:null});await window.__other.ready;window.__otherShadow=mount.querySelector('easi-view-embed').shadowRoot;};
window.__removeOther=async()=>{window.__other.dispose();await window.__other.whenDisposed();document.getElementById('other-mount').remove();};
await window.__reset();window.__ready=true;
`);
    server=await startCorpusServer({dist:resolve(root,'dist'),host,styleHash:buildInfo.inlineStyleSha256});const internal=new URL(server.url).origin;
    proxy=createServer(async(request,response)=>{const url=new URL(request.url,'http://127.0.0.1');try{if(url.pathname.startsWith('/dicom-web/')){generatedArchive(request,response,url);return;}const result=await fetch(`${internal}${url.pathname}${url.search}`,{method:request.method});response.writeHead(result.status,Object.fromEntries(result.headers));response.end(Buffer.from(await result.arrayBuffer()));}catch{if(!response.headersSent)response.writeHead(500);response.end();}});
    await new Promise((done,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',done);});origin=`http://127.0.0.1:${proxy.address().port}`;
    browser=await browserSession(resolve(temporary,'chrome'));await browser.send('Emulation.setDeviceMetricsOverride',{width:1540,height:1050,deviceScaleFactor:1,mobile:false});await browser.send('Page.setInterceptFileChooserDialog',{enabled:true});
    await browser.send('Page.navigate',{url:`${origin}/qa-corpus/`});await browser.until('window.__ready','Generated session host did not mount.');

    // New navigation behavior is intentionally exercised through rendered cards,
    // drag events, menu buttons and the public SDK, with independent pixel values.
    let observed=await state();assert.equal(observed.catalog.counts.patients,0);assert.equal(observed.view.image,null);
    assert.equal(await evaluate('window.__shadow.querySelector("#viewport-empty strong").textContent'),'Open a Study or Image');
    assert.equal(await evaluate('window.__shadow.querySelector("#viewport-empty span").textContent'),'Choose Open… to add images, patient studies, or synthetic test images to your viewing session.');
    assert.equal(await evaluate('Array.from(window.__shadow.querySelectorAll(".session-library p")).some(node=>node.textContent.includes("Choose Open…"))'),false);
    assert.equal(await evaluate('Boolean(window.__shadow.querySelector(".library-panel .panel-heading #header-import"))'),true);
    assert.equal(await evaluate('window.__shadow.querySelector(".app-header #header-import")'),null);
    record('compact Open launcher sits in the Session library heading and the image workspace explains the empty session');

    await addImages(['current-lung-1','current-lung-2','current-soft','prior','other-patient']);observed=await state();
    let alpha=observed.catalog.patients.find(patient=>patient.issuerOfPatientId==='SYNTHETIC_HOSPITAL_A'),beta=observed.catalog.patients.find(patient=>patient.issuerOfPatientId==='SYNTHETIC_HOSPITAL_B');assert.ok(alpha&&beta);
    const current=alpha.studies.find(study=>study.studyUid===fixtures.find(item=>item.key==='current-lung-1').studyUid),lung=current.series.find(series=>series.seriesUid===fixtures.find(item=>item.key==='current-lung-1').seriesUid),soft=current.series.find(series=>series.seriesUid===fixtures.find(item=>item.key==='current-soft').seriesUid);
    await expandStudy(current.id);await evaluate('window.__v.setFrame(1)');await assertSlotSample(0,[110,120,130,140]);
    assert.equal(await evaluate('window.__shadow.querySelectorAll(".session-library-series-open").length'),0);
    await click(`${cardSelector(lung.id)} .session-library-series-title`);await idle();assert.equal((await state()).view.frameIndex,0);await assertSlotSample(0,[100,110,120,130]);
    const rendered=await evaluate('window.__qa.drawSamples.filter(item=>item.slot===0).at(-1).rgba');assert.equal(rendered[3],255);assert.ok(rendered[0]>15&&rendered[0]<45,JSON.stringify(rendered));assert.equal(rendered[0],rendered[1]);assert.equal(rendered[1],rendered[2]);
    record('clicking a series card selects its first image and the redundant little Open button is removed',{renderedCenterRgba:rendered});
    await evaluate('window.__v.setFrame(1)');await evaluate(`(()=>{const node=${select(cardSelector(lung.id)+' .session-library-series-select')};node.focus();node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));})()`);await idle();assert.equal((await state()).view.frameIndex,0);await assertSlotSample(0,[100,110,120,130]);
    await evaluate('window.__v.setFrame(1)');await evaluate(`(()=>{const node=${select(cardSelector(lung.id)+' .session-library-series-select')};node.focus();node.dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',bubbles:true,cancelable:true}));})()`);await idle();assert.equal((await state()).view.frameIndex,0);
    record('series cards remain keyboard accessible using Enter and Space');
    await expandInstances(lung.id);let instanceRows=await evaluate(`Array.from(${select(cardSelector(lung.id))}.querySelectorAll('.session-library-instance')).map(node=>({id:node.dataset.instanceId,text:node.textContent}))`);assert.equal(instanceRows.length,2);const firstInstanceId=instanceRows[0].id,secondInstanceId=instanceRows[1].id;
    const accessibility=await browser.send('Accessibility.getFullAXTree');assert.ok(accessibility.nodes.some(node=>node.role?.value==='button'&&node.name?.value.startsWith('Open image 2')),'Expanded instance must remain an accessible button.');
    await click(`[data-session-action="open-instance"][data-instance-id="${instanceRows[1].id}"]`);await idle();assert.equal((await state()).view.frameIndex,1);await assertSlotSample(0,[110,120,130,140]);
    record('expanded individual instance rows open the specifically selected source instance');

    await evaluate('window.__v.setLayout(2)');await evaluate('window.__v.setActiveViewport(0)');const beforeDrop=await state();await drag(cardSelector(lung.id),1);await idle();observed=await state();assert.equal(observed.workspace.layout,2);assert.equal(observed.workspace.viewports[0].frameIndex,beforeDrop.workspace.viewports[0].frameIndex);assert.equal(observed.workspace.viewports[1].frameIndex,0);await assertSlotSample(1,[100,110,120,130]);
    assert.equal(observed.catalog.counts.patients,2);record('dragging a whole series assigns its first image to the exact dropped pane without importing another source');
    assert.deepEqual(await evaluate(`Array.from(${select('[data-session-action="open-instance"][data-instance-id="'+firstInstanceId+'"]')}.querySelectorAll('.session-library-instance-pane-badge')).map(node=>node.textContent)`),['Pane B']);
    assert.deepEqual(await evaluate(`Array.from(${select('[data-session-action="open-instance"][data-instance-id="'+secondInstanceId+'"]')}.querySelectorAll('.session-library-instance-pane-badge')).map(node=>node.textContent)`),['Pane A']);
    await expandInstances(lung.id);instanceRows=await evaluate(`Array.from(${select(cardSelector(lung.id))}.querySelectorAll('.session-library-instance')).map(node=>node.dataset.instanceId)`);
    await drag(`[data-session-action="open-instance"][data-instance-id="${instanceRows[1]}"]`,1);await idle();observed=await state();assert.equal(observed.workspace.viewports[1].frameIndex,1);await assertSlotSample(1,[110,120,130,140]);assert.equal(observed.catalog.counts.patients,2);
    record('dragging an individual instance assigns that image to the selected pane and does not trigger the external-file drop path');
    assert.equal(await evaluate(`${select('[data-session-action="open-instance"][data-instance-id="'+firstInstanceId+'"]')}.querySelectorAll('.session-library-instance-pane-badge').length`),0);assert.deepEqual(await evaluate(`Array.from(${select('[data-session-action="open-instance"][data-instance-id="'+secondInstanceId+'"]')}.querySelectorAll('.session-library-instance-pane-badge')).map(node=>node.textContent)`),['Pane A','Pane B']);
    await evaluate('window.__v.setFrame(0)');assert.deepEqual(await evaluate(`Array.from(${select('[data-session-action="open-instance"][data-instance-id="'+firstInstanceId+'"]')}.querySelectorAll('.session-library-instance-pane-badge')).map(node=>node.textContent)`),['Pane B']);assert.deepEqual(await evaluate(`Array.from(${select('[data-session-action="open-instance"][data-instance-id="'+secondInstanceId+'"]')}.querySelectorAll('.session-library-instance-pane-badge')).map(node=>node.textContent)`),['Pane A']);await evaluate('window.__v.setFrame(1)');
    record('individual instance badges track their exact pane images when dropping and navigating frames');
    await evaluate('window.__makeOther()');await evaluate(`(()=>{const source=${select(cardSelector(lung.id))},target=window.__otherShadow.querySelector('.workspace-pane[data-slot=\"0\"]'),transfer=new DataTransfer();source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:transfer}));target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer}));target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));source.dispatchEvent(new DragEvent('dragend',{bubbles:true,cancelable:true,dataTransfer:transfer}));})()`);assert.equal(await evaluate('window.__other.getSessionCatalog().counts.patients'),0);assert.equal(await evaluate('window.__other.getState().image'),null);await evaluate('window.__removeOther()');
    record('session drag payloads are scoped to their owning viewer and cannot populate another embedded viewer');
    const rejectedPatient=await evaluate(`window.__v.openSessionSeries(${quote(beta.studies[0].series[0].id)},{viewport:1}).then(()=>false,error=>/Switch to this patient/.test(error.message))`);assert.equal(rejectedPatient,true);observed=await state();assert.equal(observed.session.activePatientId,alpha.id);assert.equal(observed.workspace.viewports[0].frameIndex,1);assert.equal(observed.workspace.viewports[1].frameIndex,1);
    const rejectedPane=await evaluate(`window.__v.openSessionSeries(${quote(lung.id)},{viewport:3}).then(()=>false,error=>error.name==='RangeError')`);assert.equal(rejectedPane,true);assert.equal((await state()).workspace.layout,2);
    record('explicit pane assignment rejects a different patient and a nonexistent pane without changing the active images');
    await screenshot('session-card-instance-drop-desktop');

    await evaluate('window.__v.setLayout(4)');await drag(cardSelector(soft.id),3);await idle();await assertSlotSample(3,[200,210,220,230]);assert.match(await evaluate(`${select(cardSelector(soft.id))}.textContent`),/Pane D/);
    await evaluate('window.__v.setLayout(2)');assert.equal(await evaluate('Array.from(window.__shadow.querySelectorAll(".session-library-pane-badge")).some(node=>/Pane [CD]/.test(node.textContent))'),false);
    await evaluate('window.__v.setLayout(1)');assert.equal(await evaluate('Array.from(window.__shadow.querySelectorAll(".session-library-pane-badge")).some(node=>/Pane [BCD]/.test(node.textContent))'),false);
    record('shrinking four panes to two and one immediately removes stale pane-assignment badges');
    await evaluate('window.__v.clearViewport(0)');observed=await state();assert.equal(observed.workspace.viewports[0].assigned,false);assert.equal(await evaluate('window.__shadow.querySelectorAll(".session-library-pane-badge,.session-library-instance-pane-badge").length'),0);
    record('clearing an individual pane updates series assignment badges immediately');
    await click(cardSelector(lung.id));await idle();
    const gutters=await evaluate('(()=>{const panel=window.__shadow.getElementById("session-library-panel").getBoundingClientRect(),card=window.__shadow.querySelector(".session-library-study").getBoundingClientRect();return{left:card.left-panel.left,right:panel.right-card.right};})()');assert.ok(gutters.left>=8&&gutters.right>=8,JSON.stringify(gutters));
    assert.equal(await evaluate('window.__shadow.querySelector(".session-library-summary")?.getClientRects().length??0'),0);
    const status=await evaluate('window.__shadow.querySelector(".status-bar").textContent');for(const fragment of ['2 patients','3 studies','4 series','5 instances'])assert.ok(status.includes(fragment),`${fragment}: ${status}`);
    const privacy=await evaluate('(()=>{const node=window.__shadow.getElementById("privacy-label"),bar=node?.closest(".status-secondary"),rect=node?.getBoundingClientRect(),status=window.__shadow.querySelector(".status-bar").getBoundingClientRect();return{inside:Boolean(bar),right:rect?.right,statusRight:status.right};})()');assert.ok(privacy.inside);assert.ok(privacy.statusRight-privacy.right<310);
    record('session cards have visible gutters while exact session totals and the local-files privacy indicator appear in the bottom status bar');

    // Menu selectors are the stable root-owned controls used by embedded hosts.
    await click('#primary-menu-toggle');assert.equal(await evaluate('window.__shadow.getElementById("primary-menu").open'),true);await screenshot('primary-menu-desktop');
    assert.equal(await evaluate('window.__shadow.getElementById("primary-menu").querySelector("button[data-primary-action]").id'),'primary-menu-open');
    await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});assert.equal(await evaluate('window.__shadow.getElementById("primary-menu").open'),false);assert.equal(await evaluate('window.__shadow.activeElement?.id'),'primary-menu-toggle');
    await click('#primary-menu-toggle');await click('#primary-menu-open');assert.equal(await evaluate('window.__v.getOpenWorkflowState().open'),true);assert.equal(await evaluate('window.__shadow.getElementById("primary-menu").open'),false);await action('close');
    record('the slide-out primary menu starts with Open and supports Escape, focus return and transition into the opening dialog');
    await evaluate(`(()=>{const source=${select(cardSelector(lung.id))};window.__staleTransfer=new DataTransfer();source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:window.__staleTransfer}));})()`);
    await click('#primary-menu-toggle');await click('#primary-menu-close');await idle();observed=await state();assert.equal(observed.catalog.counts.patients,0);assert.ok(observed.workspace.viewports.every(pane=>!pane.assigned));assert.equal(observed.annotations.count,0);assert.equal(observed.performance.resources.encodedBytes,0);assert.equal(observed.performance.resources.decodedCacheBytes,0);assert.equal(await evaluate('window.__v.getLocalCatalog().counts.instances'),0);
    record('primary-menu Close clears the entire session, all patient views and retained file/pixel resources without touching source files');
    await evaluate(`(()=>{const target=${select('.workspace-pane[data-slot="0"]')};target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:window.__staleTransfer}));})()`);await idle();assert.equal((await state()).catalog.counts.patients,0);assert.equal((await state()).view.image,null);
    record('closing the session invalidates older drag payloads so a stale drop cannot restore discarded images');

    await addMediaStudy();observed=await state();assert.equal(observed.catalog.counts.patients,1);assert.equal(observed.catalog.counts.studies,1);await assertSlotSample(0,[100,110,120,130]);const firstMediaPatient=observed.catalog.patients.find(patient=>patient.patientId==='MEDIA_ALPHA');assert.ok(firstMediaPatient);
    await addImages(['other-patient']);observed=await state();assert.equal(observed.catalog.counts.patients,2);
    await evaluate(`window.__v.removeSessionPatient(${quote(firstMediaPatient.id)})`);await idle();observed=await state();assert.equal(observed.catalog.counts.patients,1);assert.equal(observed.catalog.patients[0].issuerOfPatientId,'SYNTHETIC_HOSPITAL_B');
    await addMediaStudy();observed=await state();assert.equal(observed.catalog.counts.patients,2);assert.equal(observed.catalog.patients.filter(patient=>patient.patientId==='MEDIA_ALPHA').length,1);assert.equal(observed.catalog.patients.filter(patient=>patient.issuerOfPatientId==='SYNTHETIC_HOSPITAL_B').length,1);assert.equal(observed.catalog.patients.find(patient=>patient.patientId==='MEDIA_ALPHA').studies.length,1);
    const mediaPatient=observed.catalog.patients.find(patient=>patient.patientId==='MEDIA_ALPHA');await evaluate(`window.__v.selectSessionPatient(${quote(mediaPatient.id)})`);await idle();await assertSlotSample(0,[100,110,120,130]);
    record('reopening identical DICOMDIR media with fresh File objects after closing its patient does not duplicate or resurrect patients while another patient remains');

    await screenshot('dicomdir-reopened-desktop');
    await evaluate('window.__v.closeSession()');await addImages(['us-cine']);observed=await state();const cineSeries=observed.catalog.patients[0].studies[0].series[0];assert.equal(observed.view.frameCount,3);await evaluate('window.__v.setFrame(2)');await assertSlotSample(0,[150,160,170,180]);await click(cardSelector(cineSeries.id));await idle();assert.equal((await state()).view.frameIndex,0);await assertSlotSample(0,[50,60,70,80]);
    await expandInstances(cineSeries.id);const cineInstance=await evaluate(`${select(cardSelector(cineSeries.id))}.querySelector('.session-library-instance').dataset.instanceId`);assert.equal(await evaluate(`${select(cardSelector(cineSeries.id))}.querySelectorAll('.session-library-instance').length`),1);await evaluate('window.__v.setFrame(2)');await click(`[data-session-action="open-instance"][data-instance-id="${cineInstance}"]`);await idle();assert.equal((await state()).view.frameIndex,0);await assertSlotSample(0,[50,60,70,80]);
    await evaluate('window.__v.setLayout(2)');await evaluate('window.__v.setFrame(2)');await drag(`[data-session-action="open-instance"][data-instance-id="${cineInstance}"]`,1);await idle();observed=await state();assert.equal(observed.workspace.viewports[0].frameIndex,2);assert.equal(observed.workspace.viewports[1].frameIndex,0);await assertSlotSample(1,[50,60,70,80]);
    record('multiframe ultrasound retains one instance row and card, instance and drop actions each start at the first encoded frame');
    await evaluate('window.__reset()');await evaluate(`window.__v.registerSource({id:'generated-archive',name:'Generated archive',type:'dicomweb',baseUrl:${quote(`${origin}/dicom-web/`)}})`);await evaluate('window.__v.open("study")');await action('remote');await action('source');
    await evaluate('(()=>{const field=window.__shadow.querySelector("[data-open-filter=patientId]");field.value="REMOTE";field.dispatchEvent(new Event("input",{bubbles:true}));window.__shadow.querySelector("[data-open-form=criteria]").requestSubmit();})()');await idle();await action('patient');await idle();
    await evaluate('window.__shadow.querySelector("[data-open-study]").click()');await action('add');await idle();observed=await state();const remote=observed.catalog.patients.find(patient=>patient.sourceId==='generated-archive'),remoteStudy=remote.studies[0],unloaded=remoteStudy.series.find(series=>series.seriesUid===`${remoteUid}.2`);assert.ok(unloaded);await expandStudy(remoteStudy.id);
    const beforeMetadata=remoteRequests.length;await expandInstances(unloaded.id);await browser.until(`window.__v.getSessionCatalog().patients.flatMap(patient=>patient.studies).flatMap(study=>study.series).find(series=>series.id===${quote(unloaded.id)})?.instancesLoaded`,'Generated remote instance listing did not finish.');
    const listingRequests=remoteRequests.slice(beforeMetadata);assert.ok(listingRequests.some(item=>item.path===`studies/${remoteUid}/series/${unloaded.seriesUid}/metadata`));assert.equal(listingRequests.filter(item=>/\/instances\/[^/]+$/.test(item.path)).length,0);assert.equal(await evaluate(`${select(cardSelector(unloaded.id))}.querySelectorAll('.session-library-instance').length`),2);
    record('expanding an unopened remote series retrieves only its instance metadata and lists images without fetching pixels');
    await evaluate('window.__v.setLayout(2)');const remoteSecond=await evaluate(`${select(cardSelector(unloaded.id))}.querySelectorAll('.session-library-instance')[1].dataset.instanceId`);await drag(`[data-session-action="open-instance"][data-instance-id="${remoteSecond}"]`,1);await idle();observed=await state();assert.equal(observed.workspace.viewports[1].frameIndex,1);await assertSlotSample(1,[227,237,257,277]);assert.equal(observed.workspace.viewports[0].frameIndex,0);
    assert.match(await evaluate('window.__shadow.getElementById("session-summary").textContent'),/1 patient · 1 study · 2 series · 4 instances/);
    record('dragging a remote instance retrieves and renders the selected image in its target pane while preserving the existing pane');

    await screenshot('session-library-desktop');await browser.send('Emulation.setDeviceMetricsOverride',{width:430,height:930,deviceScaleFactor:1,mobile:true});await click('#primary-menu-toggle');await screenshot('primary-menu-narrow');
    const bounds=await evaluate('(()=>{const menu=window.__shadow.getElementById("primary-menu"),rect=menu.getBoundingClientRect();return{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:innerWidth,height:innerHeight,scrollWidth:menu.scrollWidth,clientWidth:menu.clientWidth};})()');assert.ok(bounds.left>=0&&bounds.right<=bounds.width+1&&bounds.top>=0&&bounds.bottom<=bounds.height+1);assert.ok(bounds.scrollWidth<=bounds.clientWidth+1);
    record('the primary menu fits a narrow viewport without horizontal overflow');

    const final=await run('window.__v.dispose();await window.__v.whenDisposed();return window.__v.getPerformance();');assert.equal(final.resources.workerCount,0);assert.equal(final.resources.encodedBytes,0);assert.equal(final.resources.decodedCacheBytes,0);
    assert.equal(browser.errors.length,0,JSON.stringify(browser.errors));assert.equal(browser.consoleErrors.length,0,JSON.stringify(browser.consoleErrors));
    assert.equal(browser.requests.filter(request=>!['GET','HEAD'].includes(request.method)).length,0);assert.equal(browser.requests.filter(request=>!request.url.startsWith(origin)&&!request.url.startsWith('data:')&&!request.url.startsWith('blob:')).length,0);
    assert.equal(JSON.parse(await readFile(resolve(root,'dist/build-info.json'),'utf8')).sourceDigest,buildInfo.sourceDigest);assert.equal(await sourceDigest(root),buildInfo.sourceDigest,'Source inputs changed during browser qualification.');
    record('generated qualification disposes cleanly with zero uploads, external requests, browser exceptions or console errors and matches the built source digest');
    await writeFile(resolve(output,'results.json'),JSON.stringify({passed:checks.length,checks,sourceDigest:buildInfo.sourceDigest,harnessSha256:createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'),originalImagingFilesUsed:false,uploads:0,externalRequests:0,browserExceptions:0,consoleErrors:0,remoteRequests},null,2)+'\n');console.log(`Session navigation browser checks: ${checks.length} passed.`);
} catch(error) {
    if(browser)await screenshot('failure').catch(()=>{});await writeFile(resolve(output,'failure.json'),JSON.stringify({checks,error:{name:error.name,message:error.message,stack:error.stack},browserExceptions:browser?.errors??[],consoleErrors:browser?.consoleErrors??[]},null,2)+'\n');throw error;
} finally {
    browser?.close();if(proxy){proxy.closeAllConnections();await new Promise(done=>proxy.close(done));}await server?.close();if(temporary)await rm(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
