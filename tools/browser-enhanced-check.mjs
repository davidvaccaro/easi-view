import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { browserSession } from './browser-session.mjs';
import { createDicomFixture } from '../src/data/synthetic.js';
import { createEnhancedDicom, enhancedAttributes, pixels, expectedGroups, presentationFixtures,
    createVariableCineDicom, binaryAttributes } from '../test/enhanced-fixtures.js';

const root = resolve(import.meta.dirname, '..'), output = resolve(root, 'artifacts/browser-enhanced');
const qa = resolve(root, 'dist/qa'), target = new URL(process.env.EASI_VIEW_URL || 'http://127.0.0.1:5175/');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname), 'Enhanced checks require an isolated local preview.');
const quote = JSON.stringify, checks = [];
const record = (name, detail = {}) => { checks.push({ name, ...detail }); console.log(`PASS ${name}`); };
let browser;
function words(values) { const b = new Uint8Array(values.length * 2), v = new DataView(b.buffer); values.forEach((x,i) => v.setUint16(i*2,x&65535,true)); return b; }
const generated = {
    enhanced: createEnhancedDicom(enhancedAttributes()),
    badPalette: createDicomFixture({bitsAllocated:8,values:[0,1,2,3],photometric:'PALETTE COLOR',modality:'OT',sopUid:'2.25.920.4',
        extraAttributes:{'00281056':null,'00281101':['US',words([4,0,8])],'00281102':['US',words([4,0,8])],'00281103':['US',words([4,0,8])],
            '00281201':['OW',words([255])],'00281202':['OW',words([0,255,0,31])],'00281203':['OW',words([0,0,255,129])]}})
};
const presentationCases = presentationFixtures();
for (const [name, fixture] of Object.entries(presentationCases)) generated[name] = fixture.bytes;
const variableCine = createVariableCineDicom(); generated.variableCine = variableCine.bytes;
const precisionAttributes = structuredClone(presentationCases.voiLut.attributes);
precisionAttributes['00080018'] = ['UI','2.25.920.5'];
precisionAttributes['00281052'] = ['DS',0]; precisionAttributes['00281053'] = ['DS',16777217];
generated.badGpuPrecision = createDicomFixture({signed:true,modality:'OT',sopClass:'1.2.840.10008.5.1.4.1.1.7',
    sopUid:'2.25.920.5',values:presentationCases.voiLut.expectedSamples[0],extraAttributes:binaryAttributes(precisionAttributes)});

try {
    const buildInfo = JSON.parse(await readFile(resolve(root,'dist/build-info.json'),'utf8'));
    await mkdir(qa,{recursive:true});await mkdir(output,{recursive:true});
    const entry = resolve(output,'qa-entry.js');
    await writeFile(entry,`export{ImageViewport,probe}from'../../src/render/ImageViewport.js';export{createImageTransform,transformPoint}from'../../src/render/ViewportTransform.js';
export const files=${quote(Object.fromEntries(Object.entries(generated).map(([name,bytes])=>[name,Buffer.from(bytes).toString('base64')])))};
export function file(name){return new File([Uint8Array.from(atob(files[name]),c=>c.charCodeAt(0))],'synthetic-'+name+'.dcm',{type:'application/dicom'});}`);
    await build({entryPoints:[entry],outfile:resolve(qa,'enhanced.js'),bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true});
    await writeFile(resolve(qa,'index.html'),'<!doctype html><html><head><link rel="stylesheet" href="./host.css"></head><body><section id="gpu-stage"><canvas id="gpu-canvas" width="320" height="320"></canvas></section><main id="mount"></main><script type="module" src="./host.js"></script></body></html>');
    await writeFile(resolve(qa,'host.css'),'body{margin:0}#gpu-stage{width:320px;height:320px}#gpu-canvas{width:320px;height:320px}#mount{height:900px;width:100%}');
    await writeFile(resolve(qa,'host.js'),`import{createViewer}from'../assets/easi-view.js';import*as qa from'./enhanced.js';window.__qa=qa;window.__viewer=createViewer(document.getElementById('mount'));window.__events=[];for(const kind of['sourcechange','framechange','error'])window.__viewer.on(kind,detail=>window.__events.push({kind,detail}));await window.__viewer.ready;window.__ready=true;`);
    browser = await browserSession(output);
    await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1300,deviceScaleFactor:1,mobile:false});
    await browser.send('Page.navigate',{url:new URL('qa/index.html',target).href});
    await browser.until('window.__ready','The enhanced/presentation host did not become ready.');
    await browser.evaluate(`(()=>{const canvas=document.getElementById('gpu-canvas');window.__viewport=new window.__qa.ImageViewport(canvas);const gl=canvas.getContext('webgl2');if(!gl)throw new Error('Enhanced display QA requires WebGL2.');window.__sourceUploads=[];const upload=gl.texImage2D.bind(gl);gl.texImage2D=(...args)=>{if(args[3]===2&&args[4]===2&&args[6]===gl.RED&&args[7]===gl.FLOAT)window.__sourceUploads.push(Array.from(args[8]));return upload(...args);};window.__read=()=>{window.__viewport.render();const frame=window.__viewport.frame,r=canvas.getBoundingClientRect(),t=window.__qa.createImageTransform(frame,window.__viewport.state,r.width,r.height);return[0,1,2,3].map(i=>{const p=window.__qa.transformPoint(t,i%2+.5,Math.floor(i/2)+.5),color=new Uint8Array(4);gl.readPixels(Math.floor(p.x),canvas.height-1-Math.floor(p.y),1,1,gl.RGBA,gl.UNSIGNED_BYTE,color);return Array.from(color);});};window.__cpuRead=frame=>{const c=document.createElement('canvas');c.width=320;c.height=320;const context=c.getContext.bind(c);c.getContext=(kind,...args)=>kind==='webgl2'?null:context(kind,...args);document.body.append(c);const v=new window.__qa.ImageViewport(c);try{v.setFrame(frame);v.render();const r=c.getBoundingClientRect(),t=window.__qa.createImageTransform(frame,v.state,r.width,r.height);return[0,1,2,3].map(i=>{const p=window.__qa.transformPoint(t,i%2+.5,Math.floor(i/2)+.5);return Array.from(c.getContext('2d').getImageData(Math.floor(p.x),Math.floor(p.y),1,1).data);});}finally{v.dispose();c.remove();}};})()`);
    const scalar = {rows:2,columns:2,samplesPerPixel:1,bitsAllocated:16,bitsStored:16,highBit:15,signed:true,
        photometric:'MONOCHROME2',slope:1,intercept:0,voiFunction:'LINEAR',window:{center:2048,width:4096},pixelSpacing:[.5,.75],presentationInvert:false};
    const gpu = async (samples, extra = {}, action = '') => browser.evaluate(`(()=>{const f={...${quote(scalar)},...${quote(extra)},samples:Int16Array.from(${quote(samples)})};
for(const key of['modalityLut','voiLut'])if(f[key])f[key].entries=Uint16Array.from(f[key].entries);if(f.palette)for(const key of['red','green','blue'])f.palette[key]=Uint16Array.from(f.palette[key]);window.__viewport.setFrame(f);${action}return{pixels:window.__read(),cpuPixels:window.__cpuRead(f),stored:Array.from(window.__viewport.frame.samples),state:window.__viewport.state,probe:window.__qa.probe(f,.5,.5),uploads:window.__sourceUploads.length};})()`);
    const assertGray = (actual, expected) => actual.forEach((rgba,i)=>{for(let channel=0;channel<3;channel++)assert.ok(Math.abs(rgba[channel]-expected[i])<=1,`Pixel${i} channel${channel}: actual${rgba[channel]}, independent reference${expected[i]}`);assert.equal(rgba[3],255);});
    let observed = await gpu([-3,-2,0,4],{modalityLut:{count:4,firstMapped:-2,bits:16,entries:[0,1000,2000,4095],unit:'HU'}});
    assert.deepEqual(observed.stored,[-3,-2,0,4]);assertGray(observed.pixels,[0,0,125,255]);assertGray(observed.cpuPixels,[0,0,125,255]);assert.equal(observed.probe.stored,-3);assert.equal(observed.probe.rescaled,0);
    record('actual GPU Modality LUT clamps signed original samples and probes preserve separate stored and mapped values');
    observed = await gpu([-2,-1,0,1],{modalityLut:{count:4,firstMapped:-2,bits:16,entries:[0,1,2,3]},voiLut:{count:4,firstMapped:0,bits:8,entries:[16,64,128,240]},voiMode:'lut',window:{center:1.5,width:4}});
    assertGray(observed.pixels,[16,64,128,240]);assertGray(observed.cpuPixels,[16,64,128,240]);const uploads=observed.uploads;
    const manual = await browser.evaluate(`(()=>{window.__viewport.setWindow(2,4);return{pixels:window.__read(),state:window.__viewport.state,uploads:window.__sourceUploads.length};})()`);
    assertGray(manual.pixels,[0,85,170,255]);assert.equal(manual.state.voiMode,'window');assert.equal(manual.uploads,uploads);
    const reset = await browser.evaluate(`(()=>{window.__viewport.reset();return{pixels:window.__read(),state:window.__viewport.state};})()`);assertGray(reset.pixels,[16,64,128,240]);assert.equal(reset.state.voiMode,'lut');
    record('GPU Modality→VOI chain applies once, manual window reuses original texture and reset restores the first LUT');
    observed = await gpu([-50,0,25,50],{voiFunction:'SIGMOID',window:{center:0,width:100}});assertGray(observed.pixels,[30,128,186,225]);assertGray(observed.cpuPixels,[30,128,186,225]);
    record('GPU SIGMOID follows independent logistic reference points');
    observed = await gpu([0,64,128,255],{photometric:'MONOCHROME1',presentationInvert:true,window:{center:128,width:256}});assertGray(observed.pixels,[255,191,127,0]);assertGray(observed.cpuPixels,[255,191,127,0]);
    const inverted = await browser.evaluate(`(()=>{window.__viewport.setTransform({invert:true});return window.__read();})()`);assertGray(inverted,[0,64,128,255]);
    record('DICOM MONOCHROME1/Presentation Shape polarity and user inversion combine exactly once');
    for (const bits of [8,16]) {
        const scale=bits===8?1:257;
        observed=await gpu([0,1,2,3],{signed:false,photometric:'PALETTE COLOR',window:null,palette:{count:4,firstMapped:0,bits,
            red:[255,0,0,17].map(x=>x*scale),green:[0,255,0,31].map(x=>x*scale),blue:[0,0,255,129].map(x=>x*scale)}});
        const expected=[[255,0,0,255],[0,255,0,255],[0,0,255,255],[17,31,129,255]];assert.deepEqual(observed.pixels,expected);assert.deepEqual(observed.cpuPixels,expected);assert.deepEqual(observed.stored,[0,1,2,3]);assert.equal(observed.probe.stored,0);assert.deepEqual(observed.probe.rgb,[255,0,0]);
        const guards=await browser.evaluate(`(()=>{let windowRejected=false,invertRejected=false;try{window.__viewport.setWindow(0,1);}catch{windowRejected=true;}try{window.__viewport.setTransform({invert:true});}catch{invertRejected=true;}return{windowRejected,invertRejected};})()`);assert.deepEqual(guards,{windowRejected:true,invertRejected:true});
        record(`GPU ${bits}-bit direct palette maps original indices to exact RGB and rejects scalar presentation controls`);
    }
    await browser.evaluate(`(()=>{window.__shadow=document.getElementById('mount').querySelector('easi-view-embed').shadowRoot;const canvas=window.__shadow.getElementById('image-canvas'),gl=canvas.getContext('webgl2');window.__hostStored=[];window.__hostGpu=[];const upload=gl.texImage2D.bind(gl);gl.texImage2D=(...args)=>{if(args[3]===2&&args[4]===2&&args[6]===gl.RED&&args[7]===gl.FLOAT)window.__hostStored=Array.from(args[8]);return upload(...args);};const draw=gl.drawArrays.bind(gl);gl.drawArrays=(...args)=>{draw(...args);const r=canvas.getBoundingClientRect(),spacing=window.__shadow.getElementById('detail-spacing').textContent.match(/[0-9]+(?:\\.[0-9]+)?/g)?.slice(0,2).map(Number)??[.75,.75];const t=window.__qa.createImageTransform({rows:2,columns:2,pixelSpacing:spacing},{zoom:1,panX:0,panY:0,rotation:0,flipX:false,flipY:false},r.width,r.height);window.__hostGpu=[0,1,2,3].map(i=>{const p=window.__qa.transformPoint(t,i%2+.5,Math.floor(i/2)+.5),color=new Uint8Array(4);gl.readPixels(Math.floor(p.x*canvas.width/r.width),canvas.height-1-Math.floor(p.y*canvas.height/r.height),1,1,gl.RGBA,gl.UNSIGNED_BYTE,color);return Array.from(color);});};})()`);
    const enhanced = await browser.evaluate(`(async()=>{const v=window.__viewer;await v.openFiles([window.__qa.file('enhanced')]);const results=[];for(let series=0;series<4;series++){await v.setSeries(series);for(let frame=0;frame<2;frame++){await v.setFrame(frame);v.setWindow({center:0,width:20000});results.push({series,frame,state:v.getState(),stored:window.__hostStored,gpu:window.__hostGpu});}}return{results,performance:v.getPerformance()};})()`);
    assert.equal(enhanced.results.length,8);enhanced.results.forEach(result=>{
        assert.equal(result.state.seriesCount,4);assert.equal(result.state.frameCount,2);assert.equal(result.state.frameIndex,result.frame);assert.equal(result.state.image.calibrated,true);
        const index=expectedGroups[result.series][result.frame];assert.deepEqual(result.stored,pixels[index]);
        const expected=pixels[index].map(value=>Math.round(Math.max(0,Math.min(1,(value*(index+1)-100*(index+1)+.5)/19999+.5))*255));assertGray(result.gpu,expected);
    });
    record('embedded enhanced MR exposes four independent temporal/echo partitions with two correctly navigable calibrated slices each',
        {partitions:4,selectedFrames:8,encodedGroups:expectedGroups});
    const point=async(x=.5,y=.5)=>browser.evaluate(`(()=>{const canvas=window.__shadow.getElementById('image-canvas'),r=canvas.getBoundingClientRect(),spacing=window.__shadow.getElementById('detail-spacing').textContent.match(/[0-9]+(?:\\.[0-9]+)?/g).slice(0,2).map(Number);const t=window.__qa.createImageTransform({rows:2,columns:2,pixelSpacing:spacing},{zoom:1,panX:0,panY:0,rotation:0,flipX:false,flipY:false},r.width,r.height),p=window.__qa.transformPoint(t,${x},${y});return{x:r.x+p.x,y:r.y+p.y};})()`);
    await browser.evaluate(`window.__viewer.setTool('probe')`);let p=await point();await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x,y:p.y,button:'none',buttons:0});
    const enhancedProbe=await browser.until(`window.__shadow.getElementById('probe-stored').textContent.startsWith('Stored: ') && {stored:window.__shadow.getElementById('probe-stored').textContent,value:window.__shadow.getElementById('probe-value').textContent}`,'Enhanced stored/modality probe did not update.');
    assert.match(enhancedProbe.stored.replaceAll(',',''),/-1400/);assert.match(enhancedProbe.value.replaceAll(',',''),/-10500/);
    await browser.evaluate(`window.__viewer.setTool('distance')`);const a=await point(),b=await point(1.5,.5);
    await browser.send('Input.dispatchMouseEvent',{type:'mousePressed',x:a.x,y:a.y,button:'left',buttons:1,clickCount:1});await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:b.x,y:b.y,button:'left',buttons:1});await browser.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:b.x,y:b.y,button:'left',buttons:0,clickCount:1});
    assert.equal(await browser.evaluate(`window.__shadow.querySelector('.measurement-label')?.textContent`),'0.75 mm');
    record('enhanced per-frame transforms preserve original probes and calibrated image-plane distances');
    for(const[name,fixture]of Object.entries(presentationCases)){
        const observations=await browser.evaluate(`(async()=>{const v=window.__viewer;await v.openFiles([window.__qa.file(${quote(name)})]);const results=[];for(let frame=0;frame<${fixture.expectedSamples.length};frame++){await v.setFrame(frame);v.reset();results.push({state:v.getState(),stored:window.__hostStored,gpu:window.__hostGpu});}return results;})()`);
        observations.forEach((observation,frame)=>{assert.deepEqual(observation.stored,fixture.expectedSamples[frame]);
            if(fixture.expectedLevels)assertGray(observation.gpu,fixture.expectedLevels[frame].map(level=>Math.round(level*255)));
            else observation.gpu.forEach((rgba,index)=>{assert.deepEqual(rgba.slice(0,3),fixture.expectedRgb[frame].slice(index*3,index*3+3));assert.equal(rgba[3],255);});
        });
        if(name.startsWith('palette')){
            const guards=await browser.evaluate(`(()=>{const v=window.__viewer;let windowRejected=false,invertRejected=false;try{v.setWindow({center:0,width:1});}catch{windowRejected=true;}try{v.setTool('window');}catch{invertRejected=true;}return{windowRejected,invertRejected,state:v.getState(),disabled:window.__shadow.getElementById('window-center').disabled};})()`);assert.equal(guards.windowRejected,true);assert.equal(guards.invertRejected,true);assert.equal(guards.disabled,true);assert.equal(guards.state.window,null);
            await browser.evaluate(`window.__viewer.setTool('probe')`);p=await point();await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x,y:p.y,button:'none',buttons:0});
            const paletteProbe=await browser.until(`window.__shadow.getElementById('probe-stored').textContent.includes('2,000') || window.__shadow.getElementById('probe-stored').textContent.includes('2000')`, 'The palette probe did not preserve its original stored index.');assert.equal(paletteProbe,true);
            const text=await browser.evaluate(`({stored:window.__shadow.getElementById('probe-stored').textContent,value:window.__shadow.getElementById('probe-value').textContent})`);
            assert.match(text.stored.replaceAll(',',''),/2000/);assert.match(text.value,/255/);
        }
        record(`${name}: real synthetic Part10 pipeline, source worker and embedded GPU match independent presentation references`);
    }
    const rollback=await browser.evaluate(`(async()=>{const v=window.__viewer,prior=v.getState(),stored=[...window.__hostStored],gpu=window.__hostGpu.map(x=>[...x]);let rejected=false,reason='';try{await v.openFiles([window.__qa.file('badPalette')]);}catch(error){rejected=true;reason=error.message;}return{rejected,reason,prior,state:v.getState(),priorStored:stored,stored:window.__hostStored,priorGpu:gpu,gpu:window.__hostGpu,privateEvents:!/"(?:patientName|patientId|samples|pixelData|studyUid|seriesUid|sopUid)":|2\\.25\\.8/.test(JSON.stringify(window.__events))};})()`);
    assert.equal(rollback.rejected,true);assert.match(rollback.reason,/palette.*data length/i);assert.deepEqual(rollback.stored,rollback.priorStored);assert.deepEqual(rollback.gpu,rollback.priorGpu);assert.equal(rollback.state.frameCount,rollback.prior.frameCount);assert.equal(rollback.state.image.photometric,'PALETTE COLOR');assert.equal(rollback.privateEvents,true);
    record('malformed palette replacement rolls back the committed frame and default host events keep data private');
    const precisionRollback=await browser.evaluate(`(async()=>{const v=window.__viewer,stored=[...window.__hostStored],prior=v.getState();let rejected=false,reason='';try{await v.openFiles([window.__qa.file('badGpuPrecision')]);}catch(error){rejected=true;reason=error.message;}return{rejected,reason,stored:window.__hostStored,priorStored:stored,state:v.getState(),prior};})()`);
    assert.equal(precisionRollback.rejected,true);assert.match(precisionRollback.reason,/GPU.*exact|precision/i);assert.deepEqual(precisionRollback.stored,precisionRollback.priorStored);assert.equal(precisionRollback.state.image.photometric,'PALETTE COLOR');assert.equal(precisionRollback.state.frameIndex,precisionRollback.prior.frameIndex);
    record('GPU-inexact VOI table arithmetic rejects the replacement before overwriting the committed source texture');
    await browser.evaluate(`(async()=>{await window.__viewer.openFiles([window.__qa.file('variableCine')]);window.__recordedFrames=[];window.__removeRecorded=window.__viewer.on('framechange',state=>window.__recordedFrames.push(state.frameIndex));window.__viewer.play();})()`);
    assert.equal(await browser.evaluate(`window.__shadow.getElementById('cine-fps').value`),'native');
    await browser.until(`window.__viewer.getState().frameIndex===3 && !window.__viewer.getState().playing`,'Recorded timing did not stop at the final frame.');
    const recorded=await browser.evaluate(`({state:window.__viewer.getState(),frames:window.__recordedFrames,stored:window.__hostStored})`);
    assert.deepEqual(recorded.stored,variableCine.expectedSamples[3]);assert.deepEqual(recorded.frames,[1,2,3]);
    await browser.evaluate(`(async()=>{window.__removeRecorded();await window.__viewer.setFrame(0);window.__manualFrames=[];window.__removeManual=window.__viewer.on('framechange',state=>window.__manualFrames.push(state.frameIndex));const clock=window.__shadow.getElementById('cine-fps');clock.value='30';clock.dispatchEvent(new Event('change',{bubbles:true}));window.__viewer.play();})()`);
    await browser.until(`window.__manualFrames.some((frame,index,array)=>index>0&&array[index-1]===3&&frame===0) && window.__viewer.getState().playing`,'Manual FPS did not retain its documented looping behavior.');
    await browser.evaluate(`window.__viewer.pause();window.__removeManual();`);
    record('actual FrameTimeVector selects Recorded timing and stops at the last frame; explicit manual FPS keeps looping',
        {recordedFrames:[1,2,3],declaredOffsetsMs:variableCine.acquisitionOffsetsMs,nextIntervalsMs:variableCine.nextIntervalsMs});
    const override=await browser.evaluate(`(async()=>{const v=window.__viewer;await v.setFrame(0);v.setWindow({center:20,width:40});await v.setFrame(3);return{state:v.getState(),stored:window.__hostStored,gpu:window.__hostGpu};})()`);
    assert.deepEqual(override.state.window,{center:20,width:40});assert.deepEqual(override.stored,variableCine.expectedSamples[3]);
    assertGray(override.gpu,variableCine.expectedSamples[3].map(value=>Math.round(Math.max(0,Math.min(1,(value-19.5)/39+.5))*255)));
    record('manual window override survives subsequent multiframe seeks with independently checked shader pixels');
    assert.equal(browser.errors.length,0);assert.equal(browser.consoleErrors.length,0);
    await browser.evaluate('window.__viewport.dispose();window.__viewer.dispose();');
    assert.equal(JSON.parse(await readFile(resolve(root,'dist/build-info.json'),'utf8')).sourceDigest,buildInfo.sourceDigest);
    await writeFile(resolve(output,'results.json'),JSON.stringify({passed:checks.length,checks,sourceDigest:buildInfo.sourceDigest,
        harnessSha256:createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'),
        fixtureReference:{encodedGroups:expectedGroups,storedSamples:pixels,recordedOffsetsMs:variableCine.acquisitionOffsetsMs},browserExceptions:0,consoleErrors:0,originalImagingFilesUsed:false},null,2)+'\n');
    console.log(`Enhanced/presentation browser checks: ${checks.length} passed.`);
} finally {browser?.close();await rm(qa,{recursive:true,force:true});}
