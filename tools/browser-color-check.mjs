import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { browserSession, delay } from './browser-session.mjs';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'artifacts/browser-color');
const qa = resolve(root, 'dist/qa');
const target = new URL(process.env.EASI_VIEW_URL || 'http://127.0.0.1:5174/');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname), 'Color browser checks require an isolated local preview.');
const checks = [];
const quote = JSON.stringify;
const record = (name, detail = {}) => { checks.push({ name, ...detail }); console.log(`PASS ${name}`); };
const first = [255, 0, 0, 0, 255, 0, 0, 0, 255, 17, 73, 201];
const second = [11, 22, 33, 45, 67, 89, 101, 123, 145, 203, 219, 237];
const planar = samples => Array.from({length:3},(_,channel)=>samples.filter((_value,index)=>index%3===channel)).flat();
let browser;
const click = selector => browser.evaluate(`document.querySelector(${quote(selector)}).click()`);
const ready = (count = 1) => browser.until(`(() => {
    const text=id=>document.getElementById(id)?.textContent.trim();
    return text('source-badge')==='LOCAL FILES' && Number(text('detail-frames'))===${count}
        && text('status-text').includes('ready') && document.getElementById('error-banner').hidden
        && document.getElementById('viewport-empty').hidden
        && !document.getElementById('image-stage').classList.contains('frame-loading');
})()`, `The ${count}-frame synthetic color source did not become ready.`);
const state = () => browser.evaluate(`(() => {
    const text=id=>document.getElementById(id)?.textContent.trim();
    return {photometric:text('detail-photometric'),frame:Number(text('frame-number')),frames:Number(text('detail-frames')),
        matrix:text('detail-matrix'),probe:text('probe-value'),probeStored:text('probe-stored'),
        windowDisabled:document.querySelector('[data-tool="window"]').disabled,invertDisabled:document.getElementById('invert-view').disabled,
        widthDisabled:document.getElementById('window-width').disabled,centerDisabled:document.getElementById('window-center').disabled,
        tool:document.querySelector('[data-tool].active')?.dataset.tool,upload:window.__qaUploads?.at(-1)??null,
        error:!document.getElementById('error-banner').hidden,errorMessage:text('error-message')};
})()`);
const importColor = (planarConfiguration = 0, frames = 1, extras = {}) => browser.evaluate(`(() => {
    const all=${quote(frames===1?[first]:[first,second])};
    const raw=all.flatMap(samples=>${planarConfiguration}===1?[0,1,2].flatMap(channel=>samples.filter((_v,index)=>index%3===channel)):samples);
    const bytes=window.__qa.createDicomFixture({rows:2,columns:2,frames:${frames},bitsAllocated:8,bitsStored:8,
        modality:'US',sopClass:${quote(frames>1?'1.2.840.10008.5.1.4.1.1.3.1':'1.2.840.10008.5.1.4.1.1.6.1')},
        photometric:'RGB',sopUid:'1.2.826.0.1.3680043.10.543.997.'+${(planarConfiguration+1)*10+frames},
        rawPixelBytes:new Uint8Array(raw),extraAttributes:{'00280002':['US',3],'00280006':['US',${planarConfiguration}],
            '00281050':null,'00281051':null,'00281052':null,'00281053':null,'00281054':null,'00281056':null,...${quote(extras)}}});
    const transfer=new DataTransfer();transfer.items.add(new File([bytes],'synthetic-rgb.dcm',{type:'application/dicom'}));
    const input=document.getElementById('file-input');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
})()`);
const importMono = () => browser.evaluate(`(() => {
    const bytes=window.__qa.createDicomFixture({rows:2,columns:2,bitsAllocated:8,bitsStored:8,values:[0,127,128,255],
        window:{center:128,width:256},sopUid:'1.2.826.0.1.3680043.10.543.997.99'});
    const transfer=new DataTransfer();transfer.items.add(new File([bytes],'synthetic-gray.dcm',{type:'application/dicom'}));
    const input=document.getElementById('file-input');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
})()`);
const slide = async index => {
    await browser.evaluate(`(() => {const slider=document.getElementById('frame-slider');slider.value=${index};slider.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await browser.until(`Number(document.getElementById('frame-number').textContent)===${index + 1} && !document.getElementById('image-stage').classList.contains('frame-loading')`, 'Color frame navigation did not commit.');
};
const point = (x,y) => browser.evaluate(`(() => {
    const canvas=document.getElementById('image-canvas'),r=canvas.getBoundingClientRect();
    const transform=window.__qa.createImageTransform({rows:2,columns:2,pixelSpacing:[.75,.75]},
        {zoom:1,panX:0,panY:0,rotation:0,flipX:false,flipY:false},r.width,r.height);
    const p=window.__qa.transformPoint(transform,${x},${y});return{x:r.x+p.x,y:r.y+p.y};
})()`);
const drag = async (a,b) => {
    await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:a.x,y:a.y,button:'none',buttons:0});
    await browser.send('Input.dispatchMouseEvent',{type:'mousePressed',x:a.x,y:a.y,button:'left',buttons:1,clickCount:1});
    await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:b.x,y:b.y,button:'left',buttons:1});
    await browser.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:b.x,y:b.y,button:'left',buttons:0,clickCount:1});
};

try {
    await mkdir(output,{recursive:true});await mkdir(qa,{recursive:true});
    const entry=resolve(output,'qa-entry.js');
    await writeFile(entry,[
        "export {createDicomFixture} from '../../src/data/synthetic.js';",
        "export {ImageViewport,renderColorToRgba} from '../../src/render/ImageViewport.js';",
        "export {createImageTransform,transformPoint} from '../../src/render/ViewportTransform.js';"
    ].join('\n'));
    await build({entryPoints:[entry],outfile:resolve(qa,'color.js'),bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true});
    browser=await browserSession(output);
    await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await browser.send('Page.navigate',{url:target.href});
    await browser.until(`document.getElementById('status-text')?.textContent.includes('ready') && document.getElementById('viewport-empty')?.hidden`, 'Initial synthetic viewer did not become ready.');
    await browser.evaluate(`(async()=>{window.__qa=await import('/qa/color.js');window.__qaUploads=[];window.__qaDecodeCalls=0;const post=Worker.prototype.postMessage;Worker.prototype.postMessage=function(...args){window.__qaDecodeCalls++;return post.apply(this,args);};
        const gl=document.getElementById('image-canvas').getContext('webgl2');if(!gl)throw new Error('Color QA requires WebGL2.');
        const upload=gl.texImage2D.bind(gl);gl.texImage2D=(...args)=>{const samples=args[8];if(samples?.length)window.__qaUploads.push({rows:args[4],columns:args[3],count:samples.length,type:samples.constructor.name,samples:Array.from(samples)});return upload(...args);};
    })()`);
    const localStart=browser.requests.length;
    const renderer=await browser.evaluate(`(() => {
        const {ImageViewport,renderColorToRgba}=window.__qa;
        const canvas=document.createElement('canvas');canvas.style.width='300px';canvas.style.height='200px';document.body.append(canvas);
        const viewport=new ImageViewport(canvas),gl=canvas.getContext('webgl2');if(!gl)throw new Error('Color GPU shader QA requires WebGL2.');
        const samples=new Uint8Array([255,0,0,0,255,0,0,0,255,17,73,201,250,128,3,0,0,0]);
        const frame={id:'synthetic-rgb-shader',rows:2,columns:3,pixelSpacing:[1,1],photometric:'RGB',samplesPerPixel:3,bitsAllocated:8,bitsStored:8,highBit:7,signed:false,planarConfiguration:0,
            samples,window:null,range:null,slope:1,intercept:0,unit:'RGB'};
        viewport.setFrame(frame);
        const known=Array.from(samples).flatMap((value,index)=>index%3===2?[value,255]:[value]);
        const reference=Array.from(renderColorToRgba(frame));
        if(JSON.stringify(reference)!==JSON.stringify(known))throw new Error('RGB CPU reference changed stored channel bytes.');
        const read=()=>Array.from({length:6},(_unused,index)=>{const p=viewport.imageToScreen(index%3+.5,Math.floor(index/3)+.5);const pixel=new Uint8Array(4);gl.readPixels(Math.floor(p.x),canvas.height-1-Math.floor(p.y),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);return Array.from(pixel);});
        const actual=read();for(let index=0;index<6;index++)for(let channel=0;channel<4;channel++)if(Math.abs(actual[index][channel]-known[index*4+channel])>1)throw new Error('RGB GPU shader differs at pixel '+index+' channel '+channel);
        let uploads=0;const upload=gl.texImage2D.bind(gl);gl.texImage2D=(...args)=>{uploads++;return upload(...args);};
        viewport.setTransform({zoom:1.1,panX:2});viewport.setTransform({rotation:90,flipX:true});
        if(uploads!==0)throw new Error('Color transforms reuploaded unchanged channel samples.');
        if(samples.some((value,index)=>value!==frame.samples[index]))throw new Error('Color interaction changed stored channels.');
        let rejectedWindow=false,rejectedInvert=false;try{viewport.setWindow(100,200)}catch{rejectedWindow=true}try{viewport.setTransform({invert:true})}catch{rejectedInvert=true}
        if(!rejectedWindow||!rejectedInvert)throw new Error('Grayscale presentation must be rejected for RGB.');
        gl.texImage2D=upload;
        const gray={id:'gray-regression',rows:2,columns:2,pixelSpacing:[1,1],photometric:'MONOCHROME2',samples:new Uint16Array([0,127,128,255]),window:{center:128,width:256},range:{min:0,max:255},slope:1,intercept:0,voiFunction:'LINEAR'};
        viewport.setFrame(gray);const grayPixels=[];for(let i=0;i<4;i++){const p=viewport.imageToScreen(i%2+.5,Math.floor(i/2)+.5),pixel=new Uint8Array(4);gl.readPixels(Math.floor(p.x),canvas.height-1-Math.floor(p.y),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);grayPixels.push(Array.from(pixel));for(let c=0;c<3;c++)if(Math.abs(pixel[c]-gray.samples[i])>1)throw new Error('Grayscale GPU regression after RGB.');}
        viewport.dispose();canvas.remove();
        const cpuCanvas=document.createElement('canvas');cpuCanvas.style.width='300px';cpuCanvas.style.height='200px';document.body.append(cpuCanvas);
        const native=cpuCanvas.getContext.bind(cpuCanvas);cpuCanvas.getContext=(name,...args)=>name==='webgl2'?null:native(name,...args);
        const cpu=new ImageViewport(cpuCanvas);cpu.setFrame(frame);const ctx=cpuCanvas.getContext('2d');const cpuPixels=[];
        for(let index=0;index<6;index++){const p=cpu.imageToScreen(index%3+.5,Math.floor(index/3)+.5);const pixel=Array.from(ctx.getImageData(Math.floor(p.x),Math.floor(p.y),1,1).data);cpuPixels.push(pixel);for(let channel=0;channel<4;channel++)if(pixel[channel]!==known[index*4+channel])throw new Error('Canvas2D RGB fallback differs from original channel bytes.');}
        cpu.dispose();cpuCanvas.remove();
        return{gpu:actual,cpu:cpuPixels,gray:grayPixels,interactionUploads:uploads,rejectedWindow,rejectedInvert};
    })()`);
    record('owned RGB GPU shader and Canvas2D fallback preserve primaries and nontrivial channel values',renderer);
    record('RGB transforms reuse source textures, grayscale presentation rejects, and subsequent monochrome shading remains correct');

    await importColor(0);await ready();let current=await state();
    assert.equal(current.photometric,'RGB');assert.equal(current.matrix,'2 × 2');
    assert.equal(current.upload.type,'Uint8Array');assert.deepEqual(current.upload.samples,first);
    assert.equal(current.windowDisabled,true);assert.equal(current.invertDisabled,true);assert.equal(current.widthDisabled,true);assert.equal(current.centerDisabled,true);assert.equal(current.tool,'pan');
    record('local native RGB interleaved import reaches the GPU with original channels and disables grayscale controls');
    await importColor(1);await ready();current=await state();assert.deepEqual(current.upload.samples,first);
    record('local planar RGB imports canonicalize channels to the same interleaved image');

    await click('[data-tool="probe"]');const pixel=await point(1.5,1.5);
    await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:pixel.x,y:pixel.y,button:'none',buttons:0});
    await browser.until(`document.getElementById('probe-value').textContent.includes('201')`,'The color pixel probe did not show its blue channel.');
    current=await state();assert.match(current.probe,/17/);assert.match(current.probe,/73/);assert.match(current.probe,/201/);assert.match(current.probe,/RGB/i);
    await click('[data-tool="distance"]');await drag(await point(.5,.5),await point(1.5,.5));
    assert.equal(await browser.evaluate(`document.querySelector('.measurement-label')?.textContent`),'0.75 mm');
    record('RGB pixel probes show exact triplets and image-plane distance calibration remains available');

    await importColor(1,2);await ready(2);await slide(1);current=await state();assert.deepEqual(current.upload.samples,second);
    const decodesBeforeCache=await browser.evaluate('window.__qaDecodeCalls');
    await slide(0);current=await state();assert.deepEqual(current.upload.samples,first);assert.equal(await browser.evaluate('window.__qaDecodeCalls'),decodesBeforeCache);
    await browser.evaluate(`document.getElementById('cine-fps').value='5';document.getElementById('cine-fps').dispatchEvent(new Event('change',{bubbles:true}));`);
    await click('#cine-toggle');await browser.until(`Number(document.getElementById('frame-number').textContent)===2`,'Color multiframe playback did not advance.');await click('#cine-toggle');
    record('planar RGB multiframe worker decoding, seeking, cache reuse and cine preserve each frame’s channels');
    await importMono();await ready();current=await state();assert.equal(current.photometric,'MONOCHROME2');
    assert.equal(current.windowDisabled,false);assert.equal(current.invertDisabled,false);assert.equal(current.widthDisabled,false);assert.equal(current.centerDisabled,false);
    await click('[data-tool="window"]');assert.equal((await state()).tool,'window');
    await importColor(0);await ready();current=await state();assert.equal(current.windowDisabled,true);assert.equal(current.tool,'pan');
    record('monochrome and RGB source changes restore appropriate presentation controls');
    await browser.screenshot('synthetic-rgb-desktop');

    const beforeFailure=await state();await importColor(0,1,{'00282002':['CS','ADOBERGB']});
    await browser.until(`!document.getElementById('error-banner').hidden`,'Unsupported declared color-space replacement did not report its profile.');
    current=await state();assert.deepEqual(current.upload.samples,beforeFailure.upload.samples);assert.equal(current.photometric,'RGB');
    record('unsupported color replacement reports an error and preserves the committed RGB image');
    const requests=browser.requests.slice(localStart);
    assert.ok(requests.every(request=>request.method==='GET'&&new URL(request.url).origin===target.origin),'Local color viewing must not upload files or connect to archives.');
    assert.equal(browser.errors.length,0);assert.equal(browser.consoleErrors.length,0);
    await writeFile(resolve(output,'results.json'),JSON.stringify({passed:checks.length,checks,browserExceptions:0,consoleErrors:0,originalImagingFilesUsed:false},null,2)+'\n');
    console.log(`Color browser checks: ${checks.length} passed.`);
} finally {
    browser?.close();await rm(qa,{recursive:true,force:true});
}
