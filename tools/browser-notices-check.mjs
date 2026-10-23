import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createJpegAlignmentFixture } from '../test/jpeg-alignment-fixtures.js';
import { createDicomFixture } from '../src/data/synthetic.js';
import { JPEG_ALIGNMENT_WARNING as A } from '../src/data/encapsulated.js';
import { JPEG_STORED_PRECISION_WARNING as B } from '../src/data/wasm-codecs.js';
import { loadFiles } from '../src/data/sources.js';
import { browserSession, delay } from './browser-session.mjs';
import { build as bundle } from 'esbuild';
import { startCorpusServer } from './local-corpus-check.mjs';
import { sourceDigest } from './source-digest.mjs';

// Generated sources only. Expected stored samples precede encoder/decoder use.
const root = resolve(import.meta.dirname, '..'), output = resolve(root, 'artifacts/browser-notices');
const uid = '2.25.992', quote = JSON.stringify, fixtures = {}, checks = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const record = (name, details = {}) => {checks.push({name, ...details});console.log(`PASS ${name}`);};
const frames = {
    a: [[10, 20, 30, 40], [15, 25, 35, 45]],
    b: [[0, 4095, 4096, 65535], [8192, 16384, 32768, 65535]],
    ab: [[23, 4095, 4096, 65535], [8192, 20000, 32768, 65535], [100, 8000, 16000, 60000]],
    other: [[1000, 2000, 3000, 4000]], clean: [[100, 200, 300, 400]]
};
function options(series, study = 1, instance = 1) {
    return {rows: 2, columns: 2, bitsAllocated: 16, bitsStored: 16, signed: false,
        modality: 'OT', sopClass: '1.2.840.10008.5.1.4.1.1.7.3',
        sopUid: `${uid}.${study}.${series}.${instance}`, seriesUid: `${uid}.${study}.${series}`,
        description: `Generated notice series ${series}`, instanceNumber: instance, position: [0, 0, instance - 1],
        pixelSpacing: [1, 1], window: {center: 32768, width: 65536}, extraAttributes: {
            '0020000D': ['UI', `${uid}.${study}`], '00200011': ['IS', series], '00200052': ['UI', `${uid}.${study}.99`],
            '00080020': ['DA', study === 1 ? '20261019' : '20261018'],
            '00081030': ['LO', `Generated notice study ${study}`], '00100010': ['PN', 'SYNTHETIC^NOTICE'],
            '00100020': ['LO', 'SYNTHETIC_NOTICE'], '00100021': ['LO', 'GENERATED'],
            '00281050': ['DS', 32768], '00281051': ['DS', 65536]
        }};
}
let browser, server, temporary, pickerPaths;
const evaluate = expression => browser.evaluate(expression);
const click = selector => evaluate(`(()=>{const n=window.__shadow.querySelector(${quote(selector)});if(!n)throw new Error('Missing notice control: '+${quote(selector)});n.click();})()`);
const idle = () => browser.until('!window.__v.getState().busy&&!window.__v.getSessionState().busy&&!window.__v.getOpenWorkflowState().busy', 'The generated notice operation did not finish.');
const screenshot = async name => {await browser.screenshot(name);await copyFile(resolve(temporary, 'chrome', `${name}.png`), resolve(output, `${name}.png`));};
const state = () => evaluate(`(()=>{const s=window.__shadow,v=window.__v,slot=v.getWorkspaceState().activeViewport,button=s.querySelector('.image-notice-button'),badge=s.querySelector('.image-notice-badge'),popover=s.querySelector('.image-notice-popover'),canvas=s.querySelector('.workspace-pane[data-slot="'+slot+'"] .viewport-canvas'),details=s.getElementById('inspector-panel-details');return{view:v.getState(),catalog:v.getSessionCatalog(),workspace:v.getWorkspaceState(),upload:window.__qa.uploads.filter(item=>item.main&&item.slot===slot).at(-1),draw:window.__qa.draws.filter(item=>item.main&&item.slot===slot).at(-1),jobs:window.__qa.jobs.length,notice:{open:popover.matches(':popover-open'),label:button.getAttribute('aria-label'),expanded:button.getAttribute('aria-expanded'),disabled:button.disabled,count:badge.hidden?0:Number(badge.textContent),messages:Array.from(popover.querySelectorAll('.image-notice-message')).map(n=>n.textContent),groups:Array.from(popover.querySelectorAll('[data-notice-group]')).map(n=>n.dataset.noticeGroup),context:popover.querySelector('.image-notice-context').textContent,readDisabled:popover.querySelector('.image-notice-acknowledge').disabled,details:details.textContent,legacyBanner:Boolean(s.getElementById('geometry-notice')),legacyDetails:Boolean(s.getElementById('detail-geometry-notice'))},canvas:canvas.getBoundingClientRect().toJSON(),details:details.getBoundingClientRect().toJSON()};})()`);
async function verify(expected, encoding, unread, extra = []) {
    const s = await state();assert.deepEqual(s.upload.samples, expected);
    assert.deepEqual([...s.view.image.encodingWarnings].sort(), [...encoding].sort());
    assert.equal(s.notice.count, unread, JSON.stringify(s.notice));
    assert.deepEqual([...s.notice.messages].sort(), [...new Set([...encoding, ...extra])].sort());
    assert.equal(s.notice.legacyBanner, false);assert.equal(s.notice.legacyDetails, false);
    for (const message of [...encoding, ...extra]) assert.ok(!s.notice.details.includes(message), 'Technical explanations belong in the compact notice, not Details.');
    const window = s.workspace.viewports[s.workspace.activeViewport].window;
    for (const [index, pixel] of s.draw.pixels.entries()) {
        const target = Math.round(Math.max(0, Math.min(1, (expected[index] - (window.center - .5)) / (window.width - 1) + .5)) * 255);
        assert.equal(pixel[3], 255);for (const channel of pixel.slice(0, 3)) assert.ok(Math.abs(channel - target) <= 2, JSON.stringify({index, expected: target, actual: pixel}));
    }
    return s;
}
async function point(selector, shadow = '__shadow') {
    return evaluate(`(()=>{const n=window.${shadow}.querySelector(${quote(selector)});if(!n)throw new Error('Missing pointer target');const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+Math.min(r.height/2,30),box:r.toJSON()};})()`);
}
async function move(selector, shadow) {const p = await point(selector, shadow);await browser.send('Input.dispatchMouseEvent', {type:'mouseMoved', x:p.x, y:p.y, button:'none', buttons:0});return p;}
async function pointerClick(selector, shadow) {const p=await move(selector,shadow);await browser.send('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',buttons:1,clickCount:1});await browser.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y,button:'left',buttons:0,clickCount:1});}
async function key(key, code=key) {const virtual={Enter:13,Space:32,Escape:27,Tab:9}[code]??0;const text=code==='Enter'?'\r':code==='Space'?' ':undefined;await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:virtual,...(text?{text,unmodifiedText:text}:{})});await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:virtual});}
async function focusIcon() {await evaluate('(()=>{const b=window.__shadow.querySelector(".image-notice-button");if(window.__shadow.activeElement===b)b.blur();b.focus();})()');await browser.until('window.__shadow.querySelector(".image-notice-popover").matches(":popover-open")','Focusing the notice icon did not open its content.');}
async function close() {await click('.image-notice-close');await move('.viewport-canvas');await evaluate('window.__shadow.querySelector(".viewport-canvas").focus()');await browser.until('!window.__shadow.querySelector(".image-notice-popover").matches(":popover-open")','The notice did not close.');}
async function read() {await focusIcon();await click('.image-notice-acknowledge');await close();}
const sameBox = (a,b) => {for (const field of ['x','y','width','height']) assert.ok(Math.abs(a[field]-b[field])<.5, JSON.stringify({field,a,b}));};
const add = async () => {
    await evaluate('window.__v.open("images")');await click('[data-open-action="pick-files"]');
    const input=await browser.send('Runtime.evaluate',{expression:'window.__shadow.getElementById("file-input")',returnByValue:false});
    await browser.send('DOM.setFileInputFiles',{objectId:input.result.objectId,files:pickerPaths});
    await idle();await click('[data-open-action="add"]');await idle();
};
async function openSeries(id, selection = {}) {await evaluate(`window.__v.openSessionSeries(${quote(id)},{frameIndex:0,...${quote(selection)}})`);await idle();}

try {
    await mkdir(output, {recursive: true});await rm(resolve(output, 'results.json'), {force: true});await rm(resolve(output, 'failure.json'), {force: true});await rm(resolve(output,'failure.png'),{force:true});
    const build = JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8'));assert.equal(build.sourceDigest, await sourceDigest(root), 'Rebuild before notice qualification.');
    for (let instance = 0; instance < 2; instance++) {
        const item = await createJpegAlignmentFixture({...options(1, 1, instance + 1), frameSamples: [frames.a[instance]]}, 0x31);
        fixtures[`a${instance}`] = {bytes: item.bytes, expected: [frames.a[instance]], series: 1, study: 1};
    }
    for (const [key, number, padding] of [['b', 2, 0], ['ab', 3, 0x31]]) {
        const item = await createJpegAlignmentFixture({...options(number), frameSamples: frames[key], metadataOverrides: {bitsStored: 12, highBit: 11}}, padding);
        fixtures[key] = {bytes: item.bytes, expected: frames[key], series: number, study: 1};
    }
    const other = await createJpegAlignmentFixture({...options(1, 2), frameSamples: frames.other}, 0x31);
    fixtures.other = {bytes: other.bytes, expected: frames.other, series: 1, study: 2};
    for (const series of [4, 5]) {
        const spec = options(series);
        fixtures[`g${series}`] = {series, study: 1, expected: frames.clean, bytes: createDicomFixture({...spec, values: frames.clean[0], extraAttributes: {...spec.extraAttributes, '00280034': ['IS', [0, 1]]}})};
    }
    for (const series of [6, 7]) {
        const spec = options(series), expected = [frames.clean[0], [110, 210, 310, 410], [120, 220, 320, 420]];
        fixtures[`t${series}`] = {series, study: 1, expected, bytes: createDicomFixture({...spec, modality: 'US', sopClass: '1.2.840.10008.5.1.4.1.1.3.1', frames: 3, values: expected.flat(), extraAttributes: {...spec.extraAttributes, '00181063': ['DS', 0]}})};
    }
    fixtures.clean = {bytes: createDicomFixture({...options(8), values: frames.clean[0]}), expected: frames.clean};
    fixtures.invalid = {bytes: new Uint8Array([0x31])};
    for (const [key, encoding] of [['a0', [A]], ['b', [B]], ['ab', [A, B]], ['g4', []], ['t6', []]]) {
        const sources = await loadFiles([new File([fixtures[key].bytes], `GENERATED_${key}`)]);
        try {const frame = await sources[0].getFrame(0);assert.deepEqual(Array.from(frame.samples), fixtures[key].expected[0]);assert.deepEqual([...frame.encodingWarnings ?? []].sort(), [...encoding].sort());if(key==='g4')assert.ok(frame.geometryWarnings.length);if(key==='t6')assert.ok(frame.timingWarnings.length);}
        finally {sources.forEach(source => source.dispose());}
    }
    const originalHashes = Object.fromEntries(Object.entries(fixtures).map(([key, item]) => [key, hash(item.bytes)]));
    temporary = await mkdtemp(join(tmpdir(), 'easi-view-notices-browser-'));const host = resolve(temporary, 'host');await mkdir(host);pickerPaths=[];const picker=resolve(temporary,'generated-picker');await mkdir(picker);for(const [key,item] of Object.entries(fixtures)){if(key==='invalid')continue;const path=resolve(picker,'GENERATED_'+key);await writeFile(path,item.bytes);pickerPaths.push(path);}
    await writeFile(resolve(host, 'fixtures.json'), JSON.stringify(Object.fromEntries(Object.entries(fixtures).map(([key, {bytes, ...item}]) => [key, {...item, encoded: Buffer.from(bytes).toString('base64')}]))));
    await writeFile(resolve(host, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./host.css"></head><body><main id="mount"></main><aside id="other-mount"></aside><script type="module" src="./host-bundle.js"></script></body></html>');
    await writeFile(resolve(host, 'host.css'), 'body{margin:0;background:#09121b}#mount{height:100dvh;width:100%}#other-mount{position:fixed;left:-2200px;top:0;width:1000px;height:800px}');
    // GL reads sample centres after the real renderer draw. Pixel expectations
    // come from the original invented rasters, not production decode output.
    await writeFile(resolve(host, 'host.js'), `
import {createViewer} from '/assets/easi-view.js';
import {ImageNoticePopover} from ${quote(resolve(root,'src/ui/ImageNoticePopover.js'))};
const fixtures=await(await fetch('./fixtures.json')).json();window.__files=Object.fromEntries(Object.entries(fixtures).map(([key,item])=>[key,new File([Uint8Array.from(atob(item.encoded),c=>c.charCodeAt(0))],'GENERATED_'+key)]));window.__mainKeys=Object.keys(fixtures).filter(key=>key!=='invalid');
window.__qa={uploads:[],draws:[],jobs:[],workers:{created:0,terminated:0}};
const NativeWorker=window.Worker;window.Worker=class extends NativeWorker{constructor(...args){super(...args);window.__qa.workers.created++;}postMessage(message,...args){if(message.metadata&&message.bytes)window.__qa.jobs.push({bitsStored:message.metadata.bitsStored,highBit:message.metadata.highBit});return super.postMessage(message,...args);}terminate(){if(!this.__qaTerminated){this.__qaTerminated=true;window.__qa.workers.terminated++;}return super.terminate();}};
const upload=WebGL2RenderingContext.prototype.texImage2D,draw=WebGL2RenderingContext.prototype.drawArrays;
WebGL2RenderingContext.prototype.texImage2D=function(...args){if(args[3]===2&&args[4]===2&&args[8]?.length===4){this.canvas.__qaSamples=Array.from(args[8]);window.__qa.uploads.push({samples:this.canvas.__qaSamples,main:this.canvas.getRootNode().host?.parentElement?.id==='mount',slot:Number(this.canvas.closest('.workspace-pane')?.dataset.slot)});}return upload.apply(this,args);};
WebGL2RenderingContext.prototype.drawArrays=function(...args){const result=draw.apply(this,args);if(this.canvas.__qaSamples){const program=this.getParameter(this.CURRENT_PROGRAM),matrix=program&&this.getUniform(program,this.getUniformLocation(program,'imageToClip'));if(matrix){const pixels=[[0,0],[1,0],[0,1],[1,1]].map(([x,y])=>{const a=x+.5,b=y+.5,cx=matrix[0]*a+matrix[3]*b+matrix[6],cy=matrix[1]*a+matrix[4]*b+matrix[7],p=new Uint8Array(4);this.readPixels(Math.floor((cx+1)*this.canvas.width/2),Math.floor((cy+1)*this.canvas.height/2),1,1,this.RGBA,this.UNSIGNED_BYTE,p);return Array.from(p);});window.__qa.draws.push({pixels,main:this.canvas.getRootNode().host?.parentElement?.id==='mount',slot:Number(this.canvas.closest('.workspace-pane')?.dataset.slot)});}}return result;};
window.__hashes=async()=>Object.fromEntries(await Promise.all(Object.entries(window.__files).map(async([key,file])=>{const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()));return[key,Array.from(bytes,v=>v.toString(16).padStart(2,'0')).join('')];})));
window.__other=async()=>{window.__o=createViewer(document.getElementById('other-mount'),{initialDemo:null});await window.__o.ready;await window.__o.openFiles([window.__files.a0,window.__files.a1]);window.__oshadow=document.getElementById('other-mount').querySelector('easi-view-embed').shadowRoot;return{count:Number(window.__oshadow.querySelector('.image-notice-badge').textContent),message:window.__oshadow.querySelector('.image-notice-popover').textContent};};
window.__stressStart=async()=>{const mount=document.getElementById('other-mount');mount.style.cssText='position:fixed;left:220px;top:210px;width:550px;height:420px;z-index:50';window.__stressViewer=createViewer(mount,{initialDemo:null,ui:{inspector:false}});await window.__stressViewer.ready;window.__stressShadow=mount.querySelector('easi-view-embed').shadowRoot;const slot=document.createElement('span');slot.className='stress-notice-mount';window.__stressShadow.querySelector('.header-actions').prepend(slot);const messages=Array.from({length:120},(_,index)=>'Generated literal note '+index+' <img src=x onerror=alert(1)> '+('0123456789 '.repeat(16)));window.__stressInput={contextKey:'generated-stress',contextLabel:'Generated <em>embedded</em> current frame',groups:[{id:'encoding',label:'Generated <b>encoding</b>',messages}],unreadCount:120};window.__stress=new ImageNoticePopover(slot,{onAcknowledge:()=>window.__stress.update({...window.__stressInput,unreadCount:0})});window.__stress.update(window.__stressInput);};
window.__stressStop=async()=>{window.__stress.dispose();window.__stressViewer.dispose();await window.__stressViewer.whenDisposed();document.getElementById('other-mount').style.cssText='';return{removed:!window.__stressShadow.querySelector('.stress-notice-mount .image-notice-button'),imageNotices:window.__stressShadow.querySelectorAll('.image-notice-popover').length};};
window.__v=createViewer(document.getElementById('mount'),{initialDemo:null});await window.__v.ready;window.__shadow=document.getElementById('mount').querySelector('easi-view-embed').shadowRoot;window.__ready=true;
`);
    await bundle({entryPoints:[resolve(host,'host.js')],outfile:resolve(host,'host-bundle.js'),bundle:true,format:'esm',platform:'browser',external:['/assets/easi-view.js'],logLevel:'silent'});
    server = await startCorpusServer({dist: resolve(root, 'dist'), host, styleHash: build.inlineStyleSha256});const origin = new URL(server.url).origin;
    browser = await browserSession(resolve(temporary, 'chrome'));await browser.send('Emulation.setDeviceMetricsOverride', {width: 1540, height: 1050, deviceScaleFactor: 1, mobile: false});await browser.send('Emulation.setFocusEmulationEnabled',{enabled:true});await browser.send('Page.setInterceptFileChooserDialog', {enabled: true});await browser.send('Page.navigate', {url: server.url});await browser.until('window.__ready', 'The generated notice host did not mount.');
    await add();let s = await state();assert.equal(s.catalog.counts.patients, 1);assert.equal(s.catalog.counts.studies, 2);
    const series = Object.fromEntries(s.catalog.patients[0].studies.flatMap(study => study.series.map(item => [`${study.studyUid}:${item.seriesUid}`, item.id])));
    const id = (number, study = 1) => series[`${uid}.${study}:${uid}.${study}.${number}`];
    await openSeries(id(1));s=await verify(frames.a[0],[A],1);assert.equal(s.notice.open,false);assert.equal(s.notice.disabled,false);assert.equal(s.notice.expanded,'false');assert.match(s.notice.label,/notice/i);
    const bounds={canvas:s.canvas,details:s.details};await move('.image-notice-button');await browser.until('window.__shadow.querySelector(".image-notice-popover").matches(":popover-open")','Native hover did not show the notices.');s=await verify(frames.a[0],[A],1);assert.equal(s.notice.expanded,'true');await move('.image-notice-popover');await delay(300);assert.equal((await state()).notice.open,true);await screenshot('compact-notice-hover-desktop');await move('.viewport-canvas');await browser.until('!window.__shadow.querySelector(".image-notice-popover").matches(":popover-open")','Moving away from a transient notice did not close it.');s=await state();sameBox(s.canvas,bounds.canvas);sameBox(s.details,bounds.details);
    record('a reserved highlighted icon opens on native hover, stays available while entering the popup and leaves image and Details bounds unchanged');
    await focusIcon();await key('Enter');await move('.viewport-canvas');await delay(300);assert.equal((await state()).notice.open,true);await key('Escape');assert.equal((await state()).notice.open,false);assert.equal(await evaluate('window.__shadow.activeElement.classList.contains("image-notice-button")'),true);
    await key(' ','Space');assert.equal((await state()).notice.open,true);assert.equal((await state()).view.playing,false);await pointerClick('.viewport-canvas');await browser.until('!window.__shadow.querySelector(".image-notice-popover").matches(":popover-open")','An outside pointer did not close the pinned notice.');
    record('keyboard focus and Enter or Space pin the notice without triggering cine; Escape and an outside pointer close it accessibly');
    await read();s=await verify(frames.a[0],[A],0);assert.equal(s.notice.disabled,false);await evaluate('window.__v.setFrame(1)');await verify(frames.a[1],[A],0);await focusIcon();assert.ok((await state()).notice.messages.includes(A));await close();
    record('Mark as read quiets the highlight while preserving the full current-frame explanation across two independent source instances');
    await openSeries(id(3));await verify(frames.ab[0],[A,B],1);await focusIcon();await screenshot('new-precision-highlight-all-current-notices');await read();
    for (const [number,key,warnings] of [[2,'b',[B]],[1,'a',[A]],[3,'ab',[A,B]]]){await openSeries(id(number));await verify(frames[key][0],warnings,0);}
    for(const frame of[1,2,0]){await evaluate(`window.__v.setFrame(${frame})`);await verify(frames.ab[frame],[A,B],0);}
    await evaluate('window.__v.play()');await browser.until('window.__v.getState().frameIndex!==0','Generated notice cine did not advance.');await evaluate('window.__v.pause()');await evaluate('window.__v.setFrame(1)');await verify(frames.ab[1],[A,B],0);
    record('only the new precision message highlights after alignment was read; all current messages remain available through same-study series switches, seeks and actual worker cine');
    for(const[first,second,field,group]of[[4,5,'geometryWarnings','geometry'],[6,7,'timingWarnings','timing']]){await openSeries(id(first));s=await state();assert.ok(s.view.image[field].length);await verify(frames.clean[0],[],s.view.image[field].length,s.view.image[field]);assert.ok(s.notice.groups.includes(group));await read();await openSeries(id(second));s=await state();await verify(frames.clean[0],[],s.view.image[field].length,s.view.image[field]);await read();}
    record('geometry and invalid-US-clock notices share the compact grouped popup and keep independent per-series read state');
    await openSeries(id(1,2));await verify(frames.other[0],[A],1);await read();await openSeries(id(3));await verify(frames.ab[0],[A,B],0);
    record('a newly admitted study highlights its own compatibility notice while a previously read study remains quiet');
    await focusIcon();await evaluate(`(async()=>{await window.__v.setLayout(2);return window.__v.openSessionSeries(${quote(id(2))},{viewport:1,frameIndex:0});})()`);await idle();await evaluate('window.__v.setActiveViewport(0)');s=await verify(frames.ab[0],[A,B],0);assert.equal(s.notice.open,false);await focusIcon();await key('Enter');const backgroundBefore=await state();await evaluate('window.__v.assignViewportSeries(1,window.__v.getWorkspaceState().viewports[1].seriesIndex)');await idle();s=await verify(frames.ab[0],[A,B],0);assert.equal(s.notice.open,true);assert.equal(s.notice.context,backgroundBefore.notice.context);sameBox(s.canvas,backgroundBefore.canvas);record('a pinned active-image popup survives background loading of another pane without borrowing its messages or losing context');await evaluate('window.__v.setActiveViewport(1)');s=await verify(frames.b[0],[B],0);assert.equal(s.notice.open,false);await focusIcon();assert.match((await state()).notice.context,/Pane B/);await evaluate('window.__v.setFrame(1)');await verify(frames.b[1],[B],0);assert.equal((await state()).notice.open,false);await focusIcon();await evaluate('window.__v.clearViewport(1)');await idle();s=await state();assert.equal(s.view.image,null);assert.equal(s.notice.disabled,true);assert.equal(s.notice.count,0);assert.equal(s.notice.open,false);assert.deepEqual(s.notice.messages,[]);record('clearing the active pane removes its old notes, closes the popup and leaves a muted disabled icon');await evaluate('window.__v.setLayout(1)');await openSeries(id(3));
    record('switching the active pane or frame closes stale popups and points the notice content at the actually displayed image');
    await evaluate('window.__shadow.getElementById("inspector-tab-details").click()');s=await state();const noticedBounds={canvas:s.canvas,details:s.details};await openSeries(id(8));s=await verify(frames.clean[0],[],0);assert.equal(s.notice.disabled,true);sameBox(s.canvas,noticedBounds.canvas);sameBox(s.details,noticedBounds.details);await openSeries(id(3));await verify(frames.ab[0],[A,B],0);await click('#toggle-inspector');await focusIcon();s=await state();assert.equal(s.notice.open,true);assert.ok(s.notice.messages.includes(B));await screenshot('notices-with-inspector-hidden');await close();await click('#toggle-inspector');
    record('noticed and clean images have exactly the same viewport and Details height, and the header icon remains reachable with the inspector hidden');
    const independent=await evaluate('window.__other()');assert.equal(independent.count,1);assert.ok(independent.message.includes(A));await verify(frames.ab[0],[A,B],0);await evaluate('(async()=>{window.__o.dispose();await window.__o.whenDisposed();return true;})()');
    record('an independently embedded viewer does not inherit another viewer’s read state');
    await browser.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await browser.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});await evaluate('window.scrollTo(0,0);if(window.__shadow.getElementById("toggle-inspector").getAttribute("aria-expanded")==="true")window.__shadow.getElementById("toggle-inspector").click()');let p=await point('.image-notice-button');assert.ok(p.box.width>=24&&p.box.height>=24&&p.box.left>=0&&p.box.right<=390);await browser.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:p.x,y:p.y}]});await browser.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await browser.until('window.__shadow.querySelector(".image-notice-popover").matches(":popover-open")','A native touch tap did not open the notice.');const mobile=await evaluate('(()=>{const p=window.__shadow.querySelector(".image-notice-popover"),r=p.getBoundingClientRect();return{rect:r.toJSON(),overflow:document.documentElement.scrollWidth-innerWidth};})()');assert.ok(mobile.rect.left>=0&&mobile.rect.right<=391&&mobile.rect.top>=0&&mobile.rect.bottom<=844);assert.ok(mobile.overflow<=1);await verify(frames.ab[0],[A,B],0);await screenshot('compact-notice-touch-narrow');await close();await browser.send('Emulation.setTouchEmulationEnabled',{enabled:false});await browser.send('Emulation.setDeviceMetricsOverride',{width:1540,height:1050,deviceScaleFactor:1,mobile:false});await click('#toggle-inspector');
    record('the compact icon is touch reachable at 390 pixels and its full scrollable popup fits the narrow viewport without horizontal overflow');
    await evaluate('window.__stressStart()');const stressButton='.stress-notice-mount .image-notice-button',stressPopup='.stress-notice-mount .image-notice-popover';await move(stressButton,'__stressShadow');await browser.until('window.__stress.isOpen()','The generated long-notice component did not open.');await move(stressPopup,'__stressShadow');await delay(300);let stress=await evaluate('(()=>{const s=window.__stressShadow,m=s.querySelector(".stress-notice-mount"),p=m.querySelector(".image-notice-popover"),b=m.querySelector(".image-notice-body"),shell=s.querySelector(".viewer-shell").getBoundingClientRect();return{open:window.__stress.isOpen(),rect:p.getBoundingClientRect().toJSON(),shell:shell.toJSON(),scrollHeight:b.scrollHeight,clientHeight:b.clientHeight,messages:p.querySelectorAll(".image-notice-message").length,markup:p.querySelectorAll("img,em,b,script").length,literal:p.textContent.includes("<img src=x onerror=alert(1)>"),badge:m.querySelector(".image-notice-badge").textContent};})()');assert.equal(stress.open,true);assert.equal(stress.messages,120);assert.equal(stress.markup,0);assert.equal(stress.literal,true);assert.equal(stress.badge,'99+');assert.ok(stress.rect.left>=stress.shell.left&&stress.rect.right<=stress.shell.right&&stress.rect.top>=stress.shell.top&&stress.rect.bottom<=stress.shell.bottom);assert.ok(stress.scrollHeight>stress.clientHeight);const wheel=await point('.stress-notice-mount .image-notice-body','__stressShadow');await browser.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:wheel.x,y:wheel.y,deltaX:0,deltaY:800});await browser.until('window.__stressShadow.querySelector(".stress-notice-mount .image-notice-body").scrollTop>0','Native wheel did not scroll the generated long notes.');await screenshot('long-literal-notices-embedded-scroll');await pointerClick('.stress-notice-mount .image-notice-acknowledge','__stressShadow');assert.equal(await evaluate('window.__stressShadow.querySelector(".stress-notice-mount .image-notice-badge").hidden'),true);assert.equal(await evaluate('window.__stressShadow.querySelectorAll(".stress-notice-mount .image-notice-message").length'),120);const stressStopped=await evaluate('window.__stressStop()');assert.equal(stressStopped.removed,true);assert.equal(stressStopped.imageNotices,0);
    record('long literal messages never create markup, remain scrollable after crossing the hover gap, clamp to an offset embedded viewer and disappear on disposal');
    await evaluate('window.__v.openFiles([window.__files.a0,window.__files.a1])');await idle();await verify(frames.a[0],[A],1);await read();const failed=await evaluate('window.__v.openFiles([window.__files.invalid]).then(()=>false,()=>true)');assert.equal(failed,true);assert.equal(await evaluate('window.__shadow.getElementById("error-banner").hidden'),false);assert.ok(await evaluate('window.__shadow.getElementById("error-message").textContent.length'));await verify(frames.a[0],[A],0);await click('#dismiss-error');
    record('a fresh legacy source has fresh read state and compact notices never suppress a subsequent image-loading error or alter retained pixels');
    await evaluate('window.__v.closeSession()');await idle();assert.equal((await state()).catalog.counts.patients,0);await add();s=await state();const reopened=s.catalog.patients[0].studies.find(study=>study.studyUid===`${uid}.1`).series.find(item=>item.seriesUid===`${uid}.1.1`);await openSeries(reopened.id);await verify(frames.a[0],[A],1);assert.deepEqual(await evaluate('({local:localStorage.length,session:sessionStorage.length})'),{local:0,session:0});
    record('closing and reopening the session resets read state without persistent browser storage');
    assert.deepEqual(await evaluate('window.__hashes()'), originalHashes);
    const final = await evaluate('(async()=>{window.__v.dispose();await window.__v.whenDisposed();return{resources:window.__v.getPerformance().resources,workers:window.__qa.workers,jobs:window.__qa.jobs.length};})()');assert.equal(final.resources.workerCount, 0);assert.equal(final.resources.encodedBytes, 0);assert.equal(final.resources.decodedCacheBytes, 0);assert.equal(final.workers.created, final.workers.terminated);
    assert.equal(browser.errors.length, 0, JSON.stringify(browser.errors));assert.equal(browser.consoleErrors.length, 0, JSON.stringify(browser.consoleErrors));assert.equal(browser.requests.filter(request => !['GET', 'HEAD'].includes(request.method)).length, 0);assert.equal(browser.requests.filter(request => !request.url.startsWith(origin) && !request.url.startsWith('data:') && !request.url.startsWith('blob:')).length, 0);assert.equal(await sourceDigest(root), build.sourceDigest);assert.equal(JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8')).sourceDigest, build.sourceDigest);
    record('generated source bytes remain unchanged, all workers/buffers are released, and no uploads, external requests or browser errors occur', final);
    await writeFile(resolve(output, 'results.json'), JSON.stringify({passed: checks.length, checks, sourceDigest: build.sourceDigest, harnessSha256: hash(await readFile(import.meta.filename)), originalImagingFilesUsed: false, sourceHashes: originalHashes, uploads: 0, externalRequests: 0, browserExceptions: 0, consoleErrors: 0}, null, 2) + '\n');console.log(`Notice acknowledgement browser checks: ${checks.length} passed.`);
} catch (error) {if (browser) await screenshot('failure').catch(() => {});await writeFile(resolve(output, 'failure.json'), JSON.stringify({checks, error: {name: error.name, message: error.message, stack: error.stack}, browserExceptions: browser?.errors ?? [], consoleErrors: browser?.consoleErrors ?? []}, null, 2) + '\n');throw error;}
finally {browser?.close();await server?.close();if (temporary) await rm(temporary, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});}
