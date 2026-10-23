import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { browserSession, delay } from './browser-session.mjs';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'artifacts/browser-embed');
const qa = resolve(root, 'dist/qa');
const target = new URL(process.env.EASI_VIEW_URL || 'http://127.0.0.1:5174/');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname), 'Embedding checks require an isolated local preview.');
const checks = [];
const record = (name, detail = {}) => { checks.push({ name, ...detail }); console.log(`PASS ${name}`); };
const quote = JSON.stringify;
let browser;

const run = expression => browser.evaluate(`(async () => { ${expression} })()`);
const embedded = name => browser.evaluate(`window.__qa.viewer[${quote(name)}].getState()`);
const snapshot = name => browser.evaluate(`window.__qa.inspect(${quote(name)})`);
const open = (name, options) => run(`window.__qa.owner=${quote(name)}; const result=await window.__qa.viewer[${quote(name)}].openFiles(window.__qa.files(${quote(options)})); window.__qa.owner=null; return result;`);
const key = async (value, code) => {
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: value, code, ...(value.length === 1 ? { text: value } : {}) });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: value, code });
};
const demoState = () => browser.evaluate(`(() => {
    const mount=document.getElementById('viewer-container'),host=mount?.querySelector('easi-view-embed'),shadow=host?.shadowRoot;
    const text=id=>shadow?.getElementById(id)?.textContent.trim();
    const shell=shadow?.querySelector('.viewer-shell'),stage=shadow?.getElementById('image-stage')?.getBoundingClientRect();
    return {brand:text('brand-name'),accent:shell?.style.getPropertyValue('--accent'),frames:Number(text('detail-frames')),
        frame:Number(text('frame-number')),matrix:text('detail-matrix'),error:!shadow?.getElementById('error-banner')?.hidden,
        status:document.getElementById('integration-status')?.textContent, hostLabel:document.getElementById('host-source')?.textContent,
        documentWidth:document.documentElement.scrollWidth,width:innerWidth,
        stage:stage?{x:stage.x,right:stage.right,width:stage.width,height:stage.height}:null};
})()`);
const waitDemo = count => browser.until(`(() => {
    const shadow=document.getElementById('viewer-container')?.querySelector('easi-view-embed')?.shadowRoot;
    return Number(shadow?.getElementById('detail-frames')?.textContent)===${count}
        && shadow?.getElementById('viewport-loading')?.hidden && shadow?.getElementById('viewport-empty')?.hidden
        && shadow?.getElementById('error-banner')?.hidden;
})()`, `Embedded public demo did not display ${count} synthetic frames.`);

const samples = { rows: 2, columns: 2, bitsAllocated: 8, bitsStored: 8, values: [17, 31, 129, 201], window: { center: 128, width: 256 } };
const leftFiles = [
    { ...samples, sopUid: '1.2.826.0.1.3680043.10.543.999.1', seriesUid: '1.2.826.0.1.3680043.10.543.999.10', position: [0, 0, 0], instanceNumber: 1 },
    { ...samples, values: [19, 33, 131, 203], sopUid: '1.2.826.0.1.3680043.10.543.999.2', seriesUid: '1.2.826.0.1.3680043.10.543.999.10', position: [0, 0, 1], instanceNumber: 2 }
];
const rightFiles = [{ ...samples, values: [10, 40, 150, 220], sopUid: '1.2.826.0.1.3680043.10.543.999.3', seriesUid: '1.2.826.0.1.3680043.10.543.999.20' }];

try {
    await mkdir(output, { recursive: true });
    await mkdir(qa, { recursive: true });
    const fixtureEntry = resolve(output, 'fixtures-entry.js');
    await writeFile(fixtureEntry, "export { createDicomFixture } from '../../src/data/synthetic.js';\n");
    await build({ entryPoints: [fixtureEntry], outfile: resolve(qa, 'fixtures.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true });
    await writeFile(resolve(qa, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="./host.css"></head><body><input id="host-input" aria-label="Host text input"><button id="host-button">Host action</button><main><div id="mount-a" class="mount"></div><div id="mount-b" class="mount"></div></main><div id="mount-hidden" class="mount"></div><script type="module" src="./bootstrap.js"></script></body></html>');
    await writeFile(resolve(qa, 'host.css'), 'body { margin: 0; font: 22px serif; background: white; color: red; } button { font: 30px serif !important; color: red !important; background: #ff00ff !important; border: 6px solid red !important; } div { margin: 5px; padding: 3px; border: 2px solid red; } .workspace, .viewer-shell, .tool-button { background: red !important; } main { display: flex; gap: 20px; } .mount { margin: 0; padding: 0; border: 0; height: 540px; } #mount-a { width: 520px; } #mount-b { width: 600px; } #mount-hidden { width: 600px; height: 440px; }');
    await writeFile(resolve(qa, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="30"><rect width="120" height="30" fill="#7aa9ff"/><path d="M12 6h18v18H12z" fill="#112233"/></svg>');
    await writeFile(resolve(qa, 'bootstrap.js'), `
import { createViewer } from '../assets/easi-view.js';
import { createDicomFixture } from './fixtures.js';
const q=window.__qa={createViewer, viewer:{}, roots:{}, events:[], workers:[], uploads:[], hostKeys:[], owner:null};
const NativeWorker=window.Worker;
window.Worker=class extends NativeWorker {
    constructor(...args) { super(...args); this.qa={url:String(args[0]),owner:q.owner,terminated:false};q.workers.push(this.qa); }
    terminate() { this.qa.terminated=true;super.terminate(); }
};
const originalUpload=WebGL2RenderingContext.prototype.texImage2D;
WebGL2RenderingContext.prototype.texImage2D=function(...args) {
    const samples=args[8];
    if(samples?.length)q.uploads.push({owner:this.canvas.getRootNode().host?.parentElement?.id,rows:args[4],columns:args[3],first:Array.from(samples.slice(0,4))});
    return originalUpload.apply(this,args);
};
document.addEventListener('keydown',event=>q.hostKeys.push({key:event.key,prevented:event.defaultPrevented,target:event.target.id}));
q.files=options=>{const transfer=new DataTransfer();for(const option of options)transfer.items.add(new File([createDicomFixture(option)],'synthetic-embed.dcm',{type:'application/dicom'}));return transfer.files;};
q.mount=(name,options={})=>{
    q.viewer[name]=createViewer(document.getElementById('mount-'+name),options);
    q.roots[name]=document.getElementById('mount-'+name).querySelector('easi-view-embed').shadowRoot;
    for(const type of ['sourcechange','framechange','error','dispose'])q.viewer[name].on(type,detail=>q.events.push({name,type,detail}));
    return q.viewer[name].ready;
};
q.inspect=name=>{
    const shadow=q.roots[name],shell=shadow.querySelector('.viewer-shell'),canvas=shadow.getElementById('image-canvas');
    const rect=element=>{const r=element.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,width:r.width,height:r.height};};
    const display=selector=>getComputedStyle(shadow.querySelector(selector)).display;
    return{state:q.viewer[name].getState(),shell:rect(shell),stage:rect(shadow.getElementById('image-stage')),canvas:rect(canvas),
        toolWidth:rect(shadow.querySelector('[data-tool="window"]')).width,toolFont:getComputedStyle(shadow.querySelector('[data-tool="window"]')).fontSize,
        library:display('.library-panel'),toggleLibrary:display('#toggle-library'),header:display('.app-header'),inspector:display('.inspector-panel'),
        toggleInspector:display('#toggle-inspector'),statusBar:display('.status-bar'),demos:display('.demo-list'),
        headerHeight:getComputedStyle(shell).getPropertyValue('--header-height').trim(),statusHeight:getComputedStyle(shell).getPropertyValue('--status-height').trim(),
        brand:shadow.getElementById('brand-name').textContent,accent:getComputedStyle(shell).getPropertyValue('--accent').trim(),
        activeColor:getComputedStyle(shadow.querySelector('.tool-button.active')).color,
        logoHidden:shadow.getElementById('brand-logo').hidden,logoWidth:rect(shadow.getElementById('brand-logo')).width,
        markHidden:shadow.getElementById('brand-mark').hidden,releaseHidden:shadow.getElementById('release-tag').hidden,
        importBounds:rect(shadow.getElementById('header-import')),error:!shadow.getElementById('error-banner').hidden,
        upload:q.uploads.filter(item=>item.owner==='mount-'+name).at(-1)||null};
};
q.pixels=name=>{
    const state=q.viewer[name].getState();if(state.window)q.viewer[name].setWindow(state.window);else q.viewer[name].reset();
    const canvas=q.roots[name].getElementById('image-canvas'),gl=canvas.getContext('webgl2'),pixels=new Uint8Array(canvas.width*canvas.height*4);
    gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    let hash=2166136261,nonBlack=false;for(let i=0;i<pixels.length;i++){hash=Math.imul(hash^pixels[i],16777619)>>>0;if(i%4!==3&&pixels[i])nonBlack=true;}
    // These source fixtures have square pixels and no spatial transform. Inspect
    // image centers independently of banner-driven changes to canvas dimensions.
    const scale=Math.min(canvas.width/state.image.columns,canvas.height/state.image.rows),imagePixels=[];
    for(let row=0;row<state.image.rows;row++)for(let column=0;column<state.image.columns;column++){
        const x=(canvas.width-scale*state.image.columns)/2+scale*(column+.5);
        const y=(canvas.height-scale*state.image.rows)/2+scale*(row+.5),pixel=new Uint8Array(4);
        gl.readPixels(Math.floor(x),canvas.height-1-Math.floor(y),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);imagePixels.push([...pixel]);
    }
    return{hash,nonBlack,width:canvas.width,height:canvas.height,imagePixels};
};
await q.mount('a');await q.mount('b');q.initialReady=true;
`);
    browser = await browserSession(output);
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 2048, height: 1000, deviceScaleFactor: 1, mobile: false });
    await browser.send('Page.navigate', { url: new URL('qa/index.html', target).href });
    await browser.until('window.__qa?.initialReady', 'The two default embedded viewers did not become ready.');
    let left = await snapshot('a');let right = await snapshot('b');
    assert.equal(left.state.sourceType, 'empty');assert.equal(left.state.frameCount, 0);assert.equal(right.state.frameCount, 0);
    assert.equal(await browser.evaluate('window.__qa.workers.length'), 0);
    assert.ok(!browser.requests.some(request=>request.url.includes('decode-worker')), 'Default mounting must not start pixel workers or sample requests.');
    assert.equal(left.shell.width, 520);assert.equal(right.shell.width, 600);assert.equal(left.shell.height, 540);
    assert.equal(left.toolWidth, 35);assert.equal(left.library, 'none');assert.notEqual(left.toggleLibrary, 'none');assert.equal(left.headerHeight, '64px');
    assert.equal(left.toolFont, '10px');
    assert.equal(await browser.evaluate("getComputedStyle(document.getElementById('host-button')).backgroundColor"), 'rgb(255, 0, 255)');
    assert.equal(await browser.evaluate("document.getElementById('image-canvas')===null && window.__qa.roots.a.getElementById('image-canvas')!==window.__qa.roots.b.getElementById('image-canvas')"), true);
    assert.equal(await browser.evaluate("CSS.supports('container-type','inline-size') && CSS.supports('width','100cqw')"), true);
    record('default empty mounts isolate IDs and host styles, and adapt to 520px containers on a wide page');

    const localStart=browser.requests.length;
    const opened=await open('a', leftFiles);
    assert.equal(opened.sourceType, 'files');assert.equal(opened.frameCount, 2);assert.equal(opened.frameIndex, 0);
    left=await snapshot('a');assert.deepEqual(left.upload.first,[17,31,129,201]);assert.deepEqual(left.state.image,{rows:2,columns:2,photometric:'MONOCHROME2',samplesPerPixel:1,calibrated:true,geometryWarnings:[],timingWarnings:[],encodingWarnings:[]});
    await run("await window.__qa.viewer.a.setFrame(1); return true;");
    left=await snapshot('a');assert.equal(left.state.frameIndex,1);assert.deepEqual(left.upload.first,[19,33,131,203]);
    const events=await browser.evaluate("window.__qa.events.filter(event=>event.name==='a')");
    assert.ok(events.some(event=>event.type==='sourcechange'&&event.detail.frameCount===2));
    assert.ok(events.some(event=>event.type==='framechange'&&event.detail.frameIndex===1));
    const serialized=JSON.stringify(events);assert.ok(!/SYNTHETIC\^DEMO|EASI-SYNTHETIC|"samples":|patientName|patientId/.test(serialized), 'Public events must not expose fixture patient names, IDs, or pixel sample arrays.');
    assert.equal((await embedded('b')).frameCount,0);
    assert.ok((await browser.evaluate('window.__qa.pixels("a")')).nonBlack);
    record('FileList sources decode exact stored samples, navigate frames, and emit useful private-by-default state');

    const colorState = await run(`window.__qa.owner='a';const result=await window.__qa.viewer.a.openFiles(window.__qa.files([{
        rows:2,columns:2,frames:2,modality:'US',sopClass:'1.2.840.10008.5.1.4.1.1.3.1',photometric:'RGB',bitsAllocated:8,bitsStored:8,
        rawPixelBytes:new Uint8Array([255,0,0,0,255,0,0,0,255,17,73,201,11,22,33,45,67,89,101,123,145,203,219,237]),
        extraAttributes:{'00280002':['US',3],'00280006':['US',0],'00281050':null,'00281051':null,'00281052':null,'00281053':null,'00281054':null,'00281056':null}
    }]));window.__qa.owner=null;return result;`);
    assert.equal(colorState.image.photometric,'RGB');assert.equal(colorState.image.samplesPerPixel,3);
    assert.equal(colorState.window,null);assert.equal(colorState.tool,'pan');assert.equal(colorState.frameCount,2);
    const blocked = await run(`const rejected=[];for(const action of [()=>window.__qa.viewer.a.setWindow({center:128,width:256}),()=>window.__qa.viewer.a.setTool('window')]){try{action();rejected.push(false);}catch(error){rejected.push(/grayscale/.test(error.message));}}return rejected;`);
    assert.deepEqual(blocked,[true,true]);
    await run("await window.__qa.viewer.a.setFrame(1);return true;");
    left=await snapshot('a');assert.deepEqual(left.upload.first,[11,22,33,45]);assert.equal(left.state.window,null);
    assert.equal((await embedded('b')).sourceType,'empty');
    assert.ok((await browser.evaluate('window.__qa.pixels("a")')).nonBlack);
    await open('a',leftFiles);await run("await window.__qa.viewer.a.setFrame(1);window.__qa.viewer.a.setTool('window');return true;");
    assert.ok((await embedded('a')).window);
    record('embedded RGB exposes channel metadata, rejects scalar controls, navigates frames and restores grayscale controls');

    const pixelBefore=await browser.evaluate('window.__qa.pixels("a")');
    const imageBefore=await embedded('a');
    const unsafeBrand='<b>Acme & "Imaging"</b>';
    await run(`window.__qa.viewer.a.setBranding({name:${quote(unsafeBrand)},logoUrl:'./logo.svg',logoAlt:'Acme logo',showReleaseTag:false});window.__qa.viewer.a.setTheme({accent:'#7aa9ff',panel:'#112233'});return true;`);
    await browser.until("window.__qa.roots.a.getElementById('brand-logo').complete && window.__qa.roots.a.getElementById('brand-logo').naturalWidth===120", 'The local custom logo did not load.');
    await delay(200);
    left=await snapshot('a');assert.equal(left.brand,unsafeBrand);assert.equal(left.logoHidden,false);assert.equal(left.markHidden,false);assert.equal(left.releaseHidden,true);assert.ok(left.logoWidth<=120);
    assert.equal(await browser.evaluate("window.__qa.roots.a.getElementById('brand-name').querySelector('b')===null"),true);
    assert.equal(left.accent,'#7aa9ff');assert.equal(left.activeColor,'rgb(122, 169, 255)');
    assert.deepEqual(await browser.evaluate('window.__qa.pixels("a")'),pixelBefore);
    assert.deepEqual(left.state,imageBefore);
    await run("window.__qa.viewer.a.setBranding({name:'A'.repeat(120)});window.__qa.viewer.a.setTheme({panel:'#112233'});return true;");
    left=await snapshot('a');assert.equal(left.accent,'#76dec3');assert.ok(left.importBounds.right<=left.shell.right,'Long branding must preserve the Open DICOM action within the mount.');
    await run("window.__qa.viewer.a.setBranding({});window.__qa.viewer.a.setTheme({});return true;");
    left=await snapshot('a');assert.equal(left.brand,'EASI View');assert.equal(left.logoHidden,true);assert.equal(left.markHidden,false);assert.equal(left.releaseHidden,false);assert.equal(left.accent,'#76dec3');
    assert.equal(await browser.evaluate("window.__qa.roots.a.getElementById('brand-logo').hasAttribute('src')"),false);
    assert.deepEqual(await browser.evaluate('window.__qa.pixels("a")'),pixelBefore);
    record('safe branding, local logo, long labels, and replacement themes preserve decoded and displayed image pixels');

    await run("await window.__qa.viewer.a.setFrame(0); document.getElementById('host-input').focus();return true;");
    await key('h','KeyH');
    assert.equal(await browser.evaluate("document.getElementById('host-input').value"),'h');
    assert.equal((await embedded('a')).tool,'window');assert.equal((await embedded('b')).tool,'window');
    await browser.evaluate("window.__qa.roots.a.getElementById('image-canvas').focus()");
    await key('p','KeyP');await key('ArrowRight','ArrowRight');
    await browser.until("window.__qa.viewer.a.getState().frameIndex===1 && !window.__qa.viewer.a.getState().busy",'Focused viewer frame shortcut did not commit.');
    assert.equal((await embedded('a')).tool,'probe');assert.equal((await embedded('b')).tool,'window');
    const hostKeys=await browser.evaluate('window.__qa.hostKeys');assert.deepEqual(hostKeys.map(event=>event.key),['h']);assert.equal(hostKeys[0].prevented,false);
    record('host text input keeps its keystrokes; focused viewer shortcuts affect one instance and stay inside it');

    await open('b',rightFiles);const rightBefore=await embedded('b');const previous=await embedded('a');
    const previousPixels=await browser.evaluate('window.__qa.pixels("a")');
    const failure=await run(`try {await window.__qa.viewer.a.openFiles(window.__qa.files([${quote({...samples,photometric:'RGB',sopUid:'1.2.826.0.1.3680043.10.543.999.9'})}]));return {rejected:false};}catch(error){return {rejected:true,message:error.message};}`);
    assert.equal(failure.rejected,true);assert.match(failure.message,/MONOCHROME|RGB|unsupported/i);
    assert.deepEqual(await embedded('a'),previous);
    assert.deepEqual((await browser.evaluate('window.__qa.pixels("a")')).imagePixels,previousPixels.imagePixels);
    assert.deepEqual(previousPixels.imagePixels,[[19,19,19,255],[33,33,33,255],[131,131,131,255],[203,203,203,255]]);
    assert.deepEqual(await embedded('b'),rightBefore);
    assert.ok(await browser.evaluate("window.__qa.events.some(event=>event.name==='a'&&event.type==='error'&&event.detail.message.includes('samples per pixel'))"));
    record('source failures reject to the host and preserve the committed image without affecting another viewer');

    await run("await window.__qa.mount('hidden',{ui:{header:false,library:false,inspector:false,statusBar:false,demos:false}});window.__qa.roots.hidden.querySelector('.viewer-shell').classList.add('library-open');return true;");
    const hidden=await snapshot('hidden');
    for(const field of ['header','library','toggleLibrary','inspector','toggleInspector','statusBar','demos'])assert.equal(hidden[field],'none');
    assert.equal(hidden.headerHeight,'0px');assert.equal(hidden.statusHeight,'0px');assert.equal(hidden.state.frameCount,0);
    const allocation=await browser.evaluate(`(()=>{const root=window.__qa.roots.hidden,main=root.querySelector('.viewer-main').getBoundingClientRect(),stage=root.getElementById('image-stage').getBoundingClientRect();return{main:main.height,stage:stage.height,controls:['.viewer-toolbar','.workspace-controls','.frame-controls'].map(selector=>root.querySelector(selector)?.getBoundingClientRect().height||0)};})()`);
    assert.ok(Math.abs(allocation.main-allocation.stage-allocation.controls.reduce((sum,height)=>sum+height,0))<1,'Hidden chrome must leave all remaining height for the image and its visible controls.');
    await open('hidden',[{...samples,sopUid:'1.2.826.0.1.3680043.10.543.999.30'}]);
    assert.deepEqual((await snapshot('hidden')).upload.first,[17,31,129,201]);
    await run("window.__qa.viewer.hidden.dispose();return true;");
    record('hidden chrome reserves no panel offsets and host-driven file viewing still works');

    await run("await window.__qa.mount('hidden',{ui:{header:false,library:false,inspector:false}});return true;");
    await open('hidden',[
        {...samples,seriesUid:'1.2.826.0.1.3680043.10.543.999.40',sopUid:'1.2.826.0.1.3680043.10.543.999.41',orientation:[1,0,0,0,1,0]},
        {...samples,seriesUid:'1.2.826.0.1.3680043.10.543.999.40',sopUid:'1.2.826.0.1.3680043.10.543.999.42',orientation:[0,1,0,1,0,0],values:[10,40,150,220]}
    ]);
    assert.equal((await embedded('hidden')).seriesCount,2);
    await run("await window.__qa.viewer.hidden.setSeries(1);return true;");
    assert.deepEqual((await snapshot('hidden')).upload.first,[10,40,150,220]);
    assert.equal(await run("try{await window.__qa.viewer.hidden.setSeries(2);return false;}catch(error){return error instanceof RangeError;}"),true);
    assert.deepEqual((await snapshot('hidden')).upload.first,[10,40,150,220]);
    await run("window.__qa.viewer.hidden.dispose();return true;");
    record('hosts can select separate geometry stacks without combining incompatible image planes');

    const duplicate=await run("try {window.__qa.createViewer(document.getElementById('mount-a'));return false;}catch(error){return error.message.includes('already');}");assert.equal(duplicate,true);
    const workerBefore=await browser.evaluate('window.__qa.workers.map(item=>({...item}))');
    assert.ok(workerBefore.some(item=>item.owner==='a'&&!item.terminated));assert.ok(workerBefore.some(item=>item.owner==='b'&&!item.terminated));
    await run("window.__qa.viewer.a.play();window.__qa.viewer.a.dispose();window.__qa.viewer.a.dispose();return true;");
    assert.equal(await browser.evaluate("document.getElementById('mount-a').children.length"),0);
    assert.equal((await embedded('a')).disposed,true);assert.equal((await embedded('a')).playing,false);
    assert.equal(await browser.evaluate("window.__qa.events.filter(event=>event.name==='a'&&event.type==='dispose').length"),1);
    const workerAfter=await browser.evaluate('window.__qa.workers.map(item=>({...item}))');
    assert.ok(workerAfter.filter(item=>item.owner==='a').every(item=>item.terminated));assert.ok(workerAfter.some(item=>item.owner==='b'&&!item.terminated));
    assert.deepEqual(await embedded('b'),rightBefore);
    await run("await window.__qa.mount('a');return true;");assert.equal((await embedded('a')).frameCount,0);
    await open('a',[leftFiles[0]]);assert.deepEqual((await snapshot('a')).upload.first,[17,31,129,201]);
    const reentrantRemount=await run("let ready;const old=window.__qa.viewer.a;old.on('dispose',()=>{ready=window.__qa.mount('a');});old.dispose();await ready;return {count:document.getElementById('mount-a').children.length,state:window.__qa.viewer.a.getState()};");
    assert.equal(reentrantRemount.count,1);assert.equal(reentrantRemount.state.disposed,false);
    assert.equal(await run("try {window.__qa.createViewer(document.getElementById('mount-a'));return false;}catch(error){return error.message.includes('already');}"),true);
    const callbackDisposal=await run(`window.__qa.viewer.a.on('framechange',()=>window.__qa.viewer.a.dispose());window.__qa.owner='a';try {await window.__qa.viewer.a.openFiles(window.__qa.files(${quote([leftFiles[0]])}));return {rejected:false};}catch(error){return {rejected:true,name:error.name};}finally{window.__qa.owner=null;}`);
    assert.equal(callbackDisposal.rejected,true);assert.equal(callbackDisposal.name,'AbortError');
    assert.equal(await browser.evaluate("document.getElementById('mount-a').children.length"),0);
    assert.deepEqual(await embedded('b'),rightBefore);
    await run("window.__qa.viewer.b.dispose();return true;");
    assert.ok(await browser.evaluate('window.__qa.workers.every(item=>item.terminated)'));
    record('duplicate mounts, idempotent disposal, workers, and reentrant host callback remounts stay independent');

    const sdkRequests=browser.requests.slice(localStart);
    assert.ok(sdkRequests.every(request=>request.method==='GET'&&new URL(request.url).origin===target.origin),'Synthetic SDK actions must not upload files or contact external services.');
    await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await browser.send('Page.navigate',{url:new URL('embed.html',target).href});await waitDemo(16);
    let demo=await demoState();assert.equal(demo.brand,'NOVA Imaging');assert.equal(demo.accent,'#7aa9ff');
    await browser.evaluate("document.querySelector('[data-study=mr]').click()");await waitDemo(12);
    assert.equal((await demoState()).hostLabel,'Soft-tissue phantom');
    await browser.evaluate("document.querySelector('[data-skin=orbit]').click()");
    demo=await demoState();assert.equal(demo.brand,'Orbit Research');assert.equal(demo.accent,'#c2a6ff');assert.equal(demo.frames,12);assert.equal(demo.error,false);
    await browser.evaluate("document.querySelector('[data-study=us]').click()");await waitDemo(24);
    demo=await demoState();assert.match(demo.status,/US.*24/);assert.equal(demo.documentWidth,1440);
    await browser.screenshot('desktop-embedded-viewer');
    record('sample application wires real host study buttons, viewer events, and live branding changes');

    await browser.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await browser.send('Page.navigate',{url:new URL('embed.html',target).href});await waitDemo(16);await delay(100);
    demo=await demoState();assert.equal(demo.documentWidth,390);assert.ok(demo.stage.width>=320&&demo.stage.right<=390&&demo.stage.height>200);
    await browser.evaluate("document.querySelector('[data-skin=orbit]').click()");demo=await demoState();assert.equal(demo.brand,'Orbit Research');assert.equal(demo.frames,16);assert.equal(demo.documentWidth,390);
    await browser.screenshot('mobile-embedded-viewer');
    assert.deepEqual(browser.errors,[]);assert.deepEqual(browser.consoleErrors,[]);
    assert.ok(browser.requests.every(request=>request.method==='GET'&&new URL(request.url).origin===target.origin),'Embedding QA must use only local assets and synthetic sources.');
    record('390px embedding example fits without horizontal overflow, with no uploads or external requests');
    await writeFile(resolve(output,'results.json'),JSON.stringify({target:target.href,checks,exceptions:browser.errors,consoleErrors:browser.consoleErrors,requests:browser.requests},null,2)+'\n');
    await Promise.all(['failure.json','failure.png'].map(name=>rm(resolve(output,name),{force:true})));
    console.log(`Embedding browser checks passed: ${checks.length} integration groups.`);
} catch(error) {
    await mkdir(output,{recursive:true});
    await writeFile(resolve(output,'failure.json'),JSON.stringify({message:error.message,stack:error.stack,checks,exceptions:browser?.errors,consoleErrors:browser?.consoleErrors},null,2)+'\n');
    if(browser)await browser.screenshot('failure').catch(()=>{});
    throw error;
} finally {
    browser?.close();
    await rm(qa,{recursive:true,force:true});
}
