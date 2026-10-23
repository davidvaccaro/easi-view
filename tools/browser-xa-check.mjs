import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { browserSession, delay } from './browser-session.mjs';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'artifacts/browser-xa');
const qa = resolve(root, 'dist/qa');
const target = new URL(process.env.EASI_VIEW_URL || 'http://127.0.0.1:5174/');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname), 'XA browser checks require an isolated local preview.');
const checks=[];
const quote=JSON.stringify;
const record=(name,detail={})=>{checks.push({name,...detail});console.log(`PASS ${name}`);};
let browser;
const click=selector=>browser.evaluate(`document.querySelector(${quote(selector)}).click()`);
const ready=()=>browser.until(`document.getElementById('source-badge').textContent==='LOCAL FILES' && Number(document.getElementById('detail-frames').textContent)===96 && document.getElementById('error-banner').hidden && document.getElementById('viewport-empty').hidden && document.getElementById('viewport-loading').hidden && document.getElementById('status-text').textContent.includes('ready') && !document.getElementById('image-stage').classList.contains('frame-loading')`, 'The synthetic classic XA cine did not become ready.');
const state=()=>browser.evaluate(`(()=>{const text=id=>document.getElementById(id)?.textContent.trim();return{frame:Number(text('frame-number')),frames:Number(text('detail-frames')),photometric:text('detail-photometric'),matrix:text('detail-matrix'),spacing:text('detail-spacing'),fps:Number(document.getElementById('cine-fps').value),nativeRate:document.querySelector('#cine-fps [data-native-rate]')?.value,playing:document.getElementById('cine-toggle').getAttribute('aria-pressed')==='true',upload:window.__xaUploads?.at(-1)??null,decodes:window.__xaDecodes,error:!document.getElementById('error-banner').hidden,errorMessage:text('error-message')};})()`);
const importXa=options=>browser.evaluate(`(()=>{const file=window.__xa.file(${quote(options)});const transfer=new DataTransfer();transfer.items.add(file);const input=document.getElementById('file-input');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
const slide=async index=>{await browser.evaluate(`(()=>{const s=document.getElementById('frame-slider');s.value=${index};s.dispatchEvent(new Event('input',{bubbles:true}));})()`);await browser.until(`Number(document.getElementById('frame-number').textContent)===${index+1} && !document.getElementById('image-stage').classList.contains('frame-loading')`,'XA navigation did not commit its selected frame.');};
const point=(x,y)=>browser.evaluate(`(()=>{const c=document.getElementById('image-canvas'),r=c.getBoundingClientRect();const t=window.__xa.createImageTransform({rows:2,columns:2,pixelSpacing:null},{zoom:1,panX:0,panY:0,rotation:0,flipX:false,flipY:false},r.width,r.height);const p=window.__xa.transformPoint(t,${x},${y});return{x:r.x+p.x,y:r.y+p.y};})()`);
const drag=async(a,b)=>{await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:a.x,y:a.y,button:'none',buttons:0});await browser.send('Input.dispatchMouseEvent',{type:'mousePressed',x:a.x,y:a.y,button:'left',buttons:1,clickCount:1});await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:b.x,y:b.y,button:'left',buttons:1});await browser.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:b.x,y:b.y,button:'left',buttons:0,clickCount:1});};
const gpuSamples=()=>browser.evaluate(`(()=>{document.getElementById('window-center').dispatchEvent(new Event('change',{bubbles:true}));const c=document.getElementById('image-canvas'),r=c.getBoundingClientRect(),gl=c.getContext('webgl2');const t=window.__xa.createImageTransform({rows:2,columns:2,pixelSpacing:null},{zoom:1,panX:0,panY:0,rotation:0,flipX:false,flipY:false},r.width,r.height);return Array.from({length:4},(_,i)=>{const p=window.__xa.transformPoint(t,i%2+.5,Math.floor(i/2)+.5),pixel=new Uint8Array(4);gl.readPixels(Math.floor(p.x),c.height-1-Math.floor(p.y),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);return Array.from(pixel);});})()`);

try {
    await mkdir(output,{recursive:true});await mkdir(qa,{recursive:true});
    const entry=resolve(output,'qa-entry.js');
    await writeFile(entry,`
import {createDicomFixture} from '../../src/data/synthetic.js';
export {createImageTransform,transformPoint} from '../../src/render/ViewportTransform.js';
export const values=Array.from({length:96},(_,index)=>[index,index+64,index+128,255-index]).flat();
// Independent defined-length SQ/item encoding; no source-library DICOM writer is used.
function maskSequence(operation) {
    const value=new TextEncoder().encode(operation.length%2?operation+' ':operation);
    const element=new Uint8Array(8+value.length);const e=new DataView(element.buffer);
    e.setUint16(0,0x0028,true);e.setUint16(2,0x6101,true);element.set(new TextEncoder().encode('CS'),4);e.setUint16(6,value.length,true);element.set(value,8);
    const numbers=new Uint8Array(10);const n=new DataView(numbers.buffer);n.setUint16(0,0x0028,true);n.setUint16(2,0x6110,true);numbers.set(new TextEncoder().encode('US'),4);n.setUint16(6,2,true);n.setUint16(8,operation==='NONE'?0:1,true);
    const item=new Uint8Array(8+element.length+numbers.length);const v=new DataView(item.buffer);v.setUint16(0,0xfffe,true);v.setUint16(2,0xe000,true);v.setUint32(4,element.length+numbers.length,true);item.set(element,8);item.set(numbers,8+element.length);return item;
}
export function file(options={}) {
    const bytes=createDicomFixture({rows:2,columns:2,frames:96,bitsAllocated:8,bitsStored:8,values,frameTime:33,
        modality:'XA',sopClass:'1.2.840.10008.5.1.4.1.1.12.1',photometric:'MONOCHROME2',window:{center:128,width:256},
        sopUid:'1.2.826.0.1.3680043.10.543.996.'+(options.mask==='AVG_SUB'?2:options.shutter?3:1),
        extraAttributes:{'00280030':null,'00200032':null,'00200037':null,'00281040':['CS','LIN'],
            '00281041':['SS',-1],'00281090':['CS','NAT'],'00281052':null,'00281053':null,'00281054':null,
            '00286100':['SQ',maskSequence(options.mask??'NONE')],...(options.shutter?{'00181600':['CS','RECTANGULAR']}:{}),...options.extraAttributes}});
    return new File([bytes],'synthetic-classic-xa.dcm',{type:'application/dicom'});
}
`);
    await build({entryPoints:[entry],outfile:resolve(qa,'xa.js'),bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true});
    await writeFile(resolve(qa,'index.html'),'<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="./host.css"></head><body><main id="mount"></main><script type="module" src="./host.js"></script></body></html>');
    await writeFile(resolve(qa,'host.css'),'body{margin:0}#mount{height:800px;width:100%}');
    await writeFile(resolve(qa,'host.js'),`import{createViewer}from'../assets/easi-view.js';import{file}from'./xa.js';window.__sdk={viewer:createViewer(document.getElementById('mount')),file,events:[]};for(const type of ['sourcechange','framechange','error'])window.__sdk.viewer.on(type,detail=>window.__sdk.events.push({type,detail}));await window.__sdk.viewer.ready;window.__sdk.ready=true;`);
    browser=await browserSession(output);
    await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await browser.send('Page.navigate',{url:target.href});
    await browser.until(`document.getElementById('status-text')?.textContent.includes('ready') && document.getElementById('viewport-empty')?.hidden`,'The initial synthetic study did not become ready.');
    await browser.evaluate(`(async()=>{window.__xa=await import('/qa/xa.js');window.__xaUploads=[];window.__xaDecodes=0;const post=Worker.prototype.postMessage;Worker.prototype.postMessage=function(...args){window.__xaDecodes++;return post.apply(this,args);};const gl=document.getElementById('image-canvas').getContext('webgl2');if(!gl)throw new Error('XA pixel QA requires WebGL2.');const upload=gl.texImage2D.bind(gl);gl.texImage2D=(...args)=>{const pixels=args[8];if(pixels?.length)window.__xaUploads.push({count:pixels.length,samples:Array.from(pixels)});return upload(...args);};})()`);
    const localStart=browser.requests.length;
    await importXa({});await ready();let current=await state();
    assert.equal(current.photometric,'MONOCHROME2');assert.equal(current.matrix,'2 × 2');assert.equal(current.frames,96);assert.deepEqual(current.upload.samples,[0,64,128,255]);
    let pixels=await gpuSamples();for(let i=0;i<4;i++)for(let c=0;c<3;c++)assert.ok(Math.abs(pixels[i][c]-current.upload.samples[i])<=1,'XA intensity sign must not invert MONOCHROME2 display.');
    record('classic XA native 96-frame cine and inactive subtraction open with exact worker samples and native polarity');
    assert.ok(Math.abs(current.fps-1000/33)<1e-9);assert.ok(Math.abs(Number(current.nativeRate)-1000/33)<1e-9);
    await slide(95);current=await state();assert.deepEqual(current.upload.samples,[95,159,223,160]);assert.ok(Math.abs(current.fps-1000/33)<1e-9);
    pixels=await gpuSamples();for(let i=0;i<4;i++)for(let c=0;c<3;c++)assert.ok(Math.abs(pixels[i][c]-current.upload.samples[i])<=1);
    const beforeCached=current.decodes;await slide(0);current=await state();assert.equal(current.decodes,beforeCached);assert.deepEqual(current.upload.samples,[0,64,128,255]);
    record('first and last XA frames preserve samples, fixed 33ms metadata rate and lazy cache reuse');
    await click('#cine-toggle');await browser.until(`Number(document.getElementById('frame-number').textContent)>2`,'XA playback did not advance.');await click('#cine-toggle');
    current=await state();assert.equal(current.playing,false);assert.ok(Math.abs(current.fps-1000/33)<1e-9);await slide(0);
    record('XA cine playback advances at its selected native-rate setting and pauses without stale frames');
    assert.equal((await state()).spacing,'Not available');await click('[data-tool="distance"]');await drag(await point(.5,.5),await point(1.5,.5));
    assert.match(await browser.evaluate(`document.querySelector('.measurement-label')?.textContent`),/^1 px.*uncalibrated/);
    record('XA without image-plane calibration measures only in pixels');
    await browser.screenshot('synthetic-xa-desktop');
    const prior=await state();await importXa({mask:'AVG_SUB'});await browser.until(`!document.getElementById('error-banner').hidden`,'Active XA mask subtraction did not reject.');current=await state();assert.match(current.errorMessage,/subtraction|mask/i);assert.equal(current.frames,96);assert.deepEqual(current.upload.samples,prior.upload.samples);await click('#dismiss-error');
    await importXa({shutter:true});await browser.until(`!document.getElementById('error-banner').hidden`,'Unsupported XA display shutter did not reject.');current=await state();assert.match(current.errorMessage,/shutter/i);assert.deepEqual(current.upload.samples,prior.upload.samples);
    record('active subtraction and display-shutter replacements reject and preserve the prior XA image');
    assert.ok(browser.requests.slice(localStart).every(request=>request.method==='GET'&&new URL(request.url).origin===target.origin),'Local XA viewing must not upload images or contact archives.');
    await browser.send('Page.navigate',{url:new URL('qa/index.html',target).href});await browser.until('window.__sdk?.ready','The embedded XA QA mount did not become ready.');
    const sdk=await browser.evaluate(`(async()=>{const v=window.__sdk.viewer;await v.openFiles([window.__sdk.file()]);await v.setFrame(95);const s=v.getState();const eventKinds=window.__sdk.events.map(e=>e.type);const privateByDefault=!/SYNTHETIC|"(?:patientName|patientId|samples|pixelData|studyUid|seriesUid|sopUid)":|1\\.2\\.826/.test(JSON.stringify(window.__sdk.events));v.dispose();return{state:s,eventKinds,privateByDefault,disposed:v.getState().disposed};})()`);
    assert.equal(sdk.state.modality,'XA');assert.equal(sdk.state.frameCount,96);assert.equal(sdk.state.frameIndex,95);assert.equal(sdk.state.image.photometric,'MONOCHROME2');assert.equal(sdk.state.image.calibrated,false);assert.equal(sdk.privateByDefault,true);assert.equal(sdk.disposed,true);assert.ok(sdk.eventKinds.includes('sourcechange')&&sdk.eventKinds.includes('framechange'));
    record('embedded host API navigates classic XA cine and preserves private-by-default events and cleanup');
    assert.equal(browser.errors.length,0);assert.equal(browser.consoleErrors.length,0);
    await writeFile(resolve(output,'results.json'),JSON.stringify({passed:checks.length,checks,browserExceptions:0,consoleErrors:0,originalImagingFilesUsed:false},null,2)+'\n');
    console.log(`XA browser checks: ${checks.length} passed.`);
} finally {browser?.close();await rm(qa,{recursive:true,force:true});}
