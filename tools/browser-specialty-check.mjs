import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { browserSession, delay } from './browser-session.mjs';
import { xaFixture, doseFixture, breastFixture, slideFixture, cineFixture, j, independentNativeFixture } from '../test/specialties-fixtures.js';

// Run only against a frozen local production build with the specialty SDK wired.
// All files, UIDs, pixel values, captures and reports are generated synthetic QA.
const root = resolve(import.meta.dirname, '..'), qa = resolve(root, 'dist/qa-specialty'), output = resolve(root, 'artifacts/browser-specialty');
const target = new URL(process.env.EASI_VIEW_URL || 'http://127.0.0.1:5182/');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname), 'Specialty QA requires an explicit local target.');
const checks = [], record = (name, details = {}) => { checks.push({ name, ...details }); console.log(`PASS ${name}`); };
const methods = ['openSpecialtyFiles', 'setSpecialty', 'setSpecialtyFrame', 'playSpecialty', 'pauseSpecialty', 'probeSpecialty', 'exportSpecialtyReport', 'closeSpecialty', 'getSpecialtyState'];
const native = data => ({ type: 'application/dicom', data: Buffer.from(independentNativeFixture(data)).toString('base64') });
const json = data => ({ type: 'application/dicom+json', data: Buffer.from(JSON.stringify(data)).toString('base64') });
const samples = Array(400000).fill(10);
const fixtures = {
    xa: native(xaFixture()), dose: native(doseFixture({ bits: 32 })), relative: native(doseFixture({ bits: 32, '30040002': j('CS', 'RELATIVE') })),
    badDose: native(doseFixture({ offsets: [0, 2, 2] })), overBudget: native(xaFixture({ '00280010': j('US', 4096), '00280011': j('US', 4096) })),
    cine: json(cineFixture({ '00181244': j('US', 1) })), breastR: json(breastFixture()), breastDuplicate: json(breastFixture({ sopUid: '2.25.840' })),
    breastL: json(breastFixture({ laterality: 'L', sopUid: '2.25.841' })),
    slideJson: json(slideFixture({ '7FE00010': { vr: 'OB', BulkDataURI: 'https://synthetic.invalid/not-followed' } })),
    slideNative: native(slideFixture({ '7FE00010': { vr: 'OB', InlineBinary: Buffer.alloc(256 * 1024).toString('base64') } })),
    tall: native(doseFixture({ bits: 16, rows: 4000, columns: 100, offsets: [0], samples })),
    wide: native(doseFixture({ bits: 16, rows: 100, columns: 4000, offsets: [0], samples }))
};
const quote = JSON.stringify, resourceCheck = state => {
    assert.ok(state.bytes >= 0 && state.bytes <= state.budget); assert.equal(state.budget, 64 * 1024 * 1024);
    for (const key of ['modelBytes', 'outputBytes', 'canvasBytes', 'pendingBytes']) assert.ok(Number.isSafeInteger(state[key]) && state[key] >= 0);
};
let browser, temporary;
try {
    await mkdir(output, { recursive: true }); await mkdir(qa, { recursive: true }); temporary = await mkdtemp(join(tmpdir(), 'easi-view-specialty-'));
    const build = JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8'));
    await writeFile(resolve(qa, 'fixtures.json'), JSON.stringify(fixtures));
    await writeFile(resolve(qa, 'host.css'), 'body{margin:0;background:#090f18}#mount{width:100%;height:980px}');
    await writeFile(resolve(qa, 'index.html'), '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="host.css"><div id="mount"></div><script type="module" src="host.js"></script>');
    await writeFile(resolve(qa, 'host.js'), `import{createViewer}from'../assets/easi-view.js';
        const fixtures=await(await fetch('./fixtures.json')).json();window.__v=createViewer(document.getElementById('mount'));
        window.__events=[];window.__v.on('specialtychange',state=>window.__events.push(state));await window.__v.ready;
        window.__file=key=>new File([Uint8Array.from(atob(fixtures[key].data),c=>c.charCodeAt(0))],'synthetic-specialty-'+key+(fixtures[key].type.includes('json')?'.json':'.dcm'),{type:fixtures[key].type});
        window.__shadow=document.getElementById('mount').querySelector('easi-view-embed').shadowRoot;
        window.__canvas=()=>window.__shadow.querySelector('.specialty-canvas');
        window.__pixel=(column,row)=>Array.from(window.__canvas().getContext('2d').getImageData(column,row,1,1).data);
        window.__hangingFile=()=>{const raw=Uint8Array.from(atob(fixtures.xa.data),c=>c.charCodeAt(0));window.__localCanceled=0;
            class HangingSlice extends Blob{stream(){return new ReadableStream({start(controller){controller.enqueue(raw.slice(0,150));},cancel(){window.__localCanceled++;}});}}
            class HangingFile extends File{slice(start,end){const result=super.slice(start,end);return end-start<=256?result:new HangingSlice([result]);}}
            return new HangingFile([raw],'synthetic-pending.dcm',{type:'application/dicom'});};
        window.__ready=true;`);
    browser = await browserSession(temporary);
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
    await browser.send('Page.navigate', { url: new URL('qa-specialty/index.html', target).href });
    await browser.until('window.__ready', 'Specialty QA host did not mount.');
    const absent = await browser.evaluate(`${quote(methods)}.filter(name=>typeof window.__v[name]!=='function')`);
    assert.deepEqual(absent, [], `Wire the frozen specialty SDK first; missing methods: ${absent.join(', ')}`);
    let state = await browser.evaluate('window.__v.getSpecialtyState()'); assert.equal(state.open, false); assert.equal(state.bytes, 0); resourceCheck(state);
    record('specialty workspace starts closed with zero allocations and explicit public methods');

    await browser.evaluate('window.__v.openDemo("ct")'); const original = await browser.evaluate('window.__v.getWorkspaceState()');
    await browser.evaluate('window.__v.openSpecialtyFiles([window.__file("xa")])');
    let probe = await browser.evaluate('window.__v.probeSpecialty(0,0)'); assert.equal(probe.stored, 10); assert.equal(probe.value, 11); assert.equal(probe.units, 'stored-intensity difference'); assert.equal(probe.relationshipSign, -1);
    await browser.evaluate('window.__v.setSpecialty({window:{center:11,width:22}})');
    assert.deepEqual(await browser.evaluate('window.__pixel(0,0)'), [128, 128, 128, 255]); assert.deepEqual(await browser.evaluate('window.__pixel(1,0)'), [104, 104, 104, 255]);
    await browser.evaluate('window.__v.setSpecialtyFrame(3)'); probe = await browser.evaluate('window.__v.probeSpecialty(1,0)'); assert.equal(probe.stored, 10); assert.equal(probe.value, -1);
    const xaReport = await browser.evaluate('JSON.parse(window.__v.exportSpecialtyReport())'); assert.equal(xaReport.processing.operation, 'contrast-average-minus-mask-average'); assert.equal(xaReport.display.window.width, 22);
    assert.deepEqual(await browser.evaluate('window.__v.getWorkspaceState()'), original); resourceCheck(await browser.evaluate('window.__v.getSpecialtyState()'));
    record('actual EASI native XA AVG_SUB produces independent signed values and Canvas2D transfer without changing original panes');
    const rejectedMain = await browser.evaluate('window.__v.openFiles([window.__file("xa")]).then(()=>false,()=>true)'); assert.equal(rejectedMain, true);
    assert.deepEqual(await browser.evaluate('window.__v.getWorkspaceState()'), original);
    record('ordinary image opening still rejects active XA subtraction instead of silently bypassing its profile guard');

    await browser.evaluate('window.__v.openSpecialtyFiles([window.__file("dose")])'); await browser.evaluate('window.__v.setSpecialty({window:{center:5,width:12}})'); await browser.evaluate('window.__v.setSpecialtyFrame(2)');
    probe = await browser.evaluate('window.__v.probeSpecialty(1,1)'); assert.equal(probe.stored, 25); assert.equal(probe.value, 12.5); assert.equal(probe.units, 'GY'); assert.deepEqual(probe.patientLpsMm, [13, 22, 35]);
    assert.deepEqual(await browser.evaluate('window.__pixel(0,0)'), [234, 234, 234, 255]);
    const aspect = await browser.evaluate('(()=>{const c=window.__canvas(),r=c.getBoundingClientRect();return{ratio:r.width/r.height,fit:getComputedStyle(c).objectFit,width:r.width,height:r.height};})()');
    assert.ok(Math.abs(aspect.ratio - 1.5) < 0.01, 'Canvas element must preserve physical 3/2 pixel spacing.'); assert.equal(aspect.fit, 'fill');
    await browser.evaluate('(()=>{const c=window.__canvas(),r=c.getBoundingClientRect();c.dispatchEvent(new PointerEvent("pointermove",{bubbles:true,clientX:r.left+r.width*.75,clientY:r.top+r.height*.75}));})()');
    const pointer = await browser.evaluate('window.__shadow.querySelector(".specialty-probe").textContent'); assert.match(pointer, /stored 25/); assert.match(pointer, /12\.5 GY/); assert.match(pointer, /13\.000, 22\.000, 35\.000/);
    await browser.evaluate('window.__v.setSpecialtyFrame(0)'); assert.equal(await browser.evaluate('window.__shadow.querySelector(".specialty-probe").textContent'), '');
    await browser.evaluate('window.__v.setSpecialtyFrame(2)');
    record('uint32 dose uses original-plane nonuniform offsets and actual physically anisotropic Canvas2D pointer probes');
    const doseProbe = probe, pixels = await browser.evaluate('window.__pixel(1,1)');
    for (const key of ['badDose', 'overBudget']) {
        assert.equal(await browser.evaluate(`window.__v.openSpecialtyFiles([window.__file(${quote(key)})]).then(()=>false,()=>true)`), true);
        assert.deepEqual(await browser.evaluate('window.__v.probeSpecialty(1,1)'), doseProbe); assert.deepEqual(await browser.evaluate('window.__pixel(1,1)'), pixels); resourceCheck(await browser.evaluate('window.__v.getSpecialtyState()'));
    }
    record('invalid dose geometry and over-budget replacement preserve the last quantitative image and source storage');
    await browser.evaluate('window.__v.openSpecialtyFiles([window.__file("relative")])'); assert.equal((await browser.evaluate('window.__v.probeSpecialty(1,1)')).units, 'RELATIVE');
    assert.equal(await browser.evaluate('window.__shadow.querySelector(".specialty-probe").textContent'), '');
    const relative = await browser.evaluate('JSON.parse(window.__v.exportSpecialtyReport())'); assert.equal(relative.units, 'RELATIVE'); assert.equal(relative.display.window.width, 1);
    record('relative doses remain explicitly relative and display presets never alter quantitative scaling');

    await browser.evaluate('window.__v.openSpecialtyFiles([window.__file("cine")])'); await browser.evaluate('window.__v.setSpecialty({manualRateFps:5})'); await browser.evaluate('window.__v.setSpecialtyFrame(3)');
    state = await browser.evaluate('window.__v.getSpecialtyState()'); assert.equal(state.profile, 'cine'); assert.equal(state.timing, 'manual'); assert.equal(state.outputBytes, 0);
    assert.deepEqual(await browser.evaluate('[window.__canvas().width,window.__canvas().height]'), [0, 0]);
    await browser.evaluate('window.__v.playSpecialty()'); await browser.until('window.__v.getSpecialtyState().frameIndex===2', 'Declared sweep did not advance to its next original frame.');
    await browser.evaluate('window.__v.pauseSpecialty()'); const paused = await browser.evaluate('window.__v.getSpecialtyState().frameIndex'); await delay(300); assert.equal(await browser.evaluate('window.__v.getSpecialtyState().frameIndex'), paused);
    const cine = await browser.evaluate('JSON.parse(window.__v.exportSpecialtyReport()).cine'); assert.deepEqual(cine.sequence, [1, 2, 3, 2]); assert.ok(cine.durationsMs.every(value => value === 200)); assert.equal(cine.physiologicalPhase, null);
    record('cine plan-only stepping/play obeys prescribed trim/sweep and explicit manual timing without an ECG or pixel claim');

    await browser.evaluate('window.__v.openSpecialtyFiles([window.__file("breastR"),window.__file("breastDuplicate"),window.__file("breastL")])');
    state = await browser.evaluate('window.__v.getSpecialtyState()'); assert.equal(state.profile, 'breast'); assert.equal(state.readyLayoutSlots, 1); assert.equal(state.ambiguousLayoutSlots, 1);
    const breast = await browser.evaluate('JSON.parse(window.__v.exportSpecialtyReport()).breastLayout'); assert.deepEqual(breast.slots.map(slot => slot.status), ['ambiguous', 'ready', 'missing', 'missing']); assert.equal(breast.orientationPolicy, 'source-unchanged');
    record('explicit breast CC/MLO laterality manifest preserves ambiguous/missing references and never infers flips');
    for (const key of ['slideJson', 'slideNative']) {
        await browser.evaluate(`window.__v.openSpecialtyFiles([window.__file(${quote(key)})])`);
        assert.equal((await browser.evaluate('window.__v.getSpecialtyState()')).outputBytes, 0);
        await browser.evaluate('window.__v.setSpecialty({slideRegion:{column:2,row:1,width:3,height:2},slidePoint:{xMm:9.994,yMm:20.006,zUm:300}})');
        const slide = await browser.evaluate('JSON.parse(window.__v.exportSpecialtyReport()).slideIndex'); assert.deepEqual(slide.tiles.map(tile => tile.frameNumber), [1, 2, 4, 5]);
        assert.ok(Math.abs(slide.pointPixel.column - 2) < 1e-8); assert.ok(Math.abs(slide.pointPixel.row - 3) < 1e-8); assert.equal(slide.preview, 'index-only');
        await browser.evaluate('window.__v.setSpecialtyFrame(8)'); assert.match(await browser.evaluate('window.__shadow.querySelector(".specialty-details").textContent'), /Selected original tile frame 9: column 6, row 4/);
    }
    record('JSON and streamed native WSI stay index-only while exact tile order, clipped edges and mm/µm coordinates are functional');

    await browser.evaluate('window.__v.openSpecialtyFiles([window.__file("tall")])'); await browser.evaluate('window.__canvasPeak=0;window.__oversizedCanvas=false;(()=>{const c=window.__canvas(),w=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,"width"),h=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,"height");for(const[key,d]of[["width",w],["height",h]])Object.defineProperty(c,key,{configurable:true,get(){return d.get.call(this);},set(value){const proposed=key==="width"?value*h.get.call(this):w.get.call(this)*value;window.__canvasPeak=Math.max(window.__canvasPeak,proposed*4);if(proposed*4>2*1024*1024){window.__oversizedCanvas=true;throw new Error("Synthetic unadmitted intermediate canvas");}d.set.call(this,value);}});})();');
    await browser.evaluate('window.__v.openSpecialtyFiles([window.__file("wide")])'); assert.equal(await browser.evaluate('window.__oversizedCanvas'), false); assert.equal(await browser.evaluate('window.__canvasPeak'), 400000 * 4);
    resourceCheck(await browser.evaluate('window.__v.getSpecialtyState()')); record('real canvas dimension swaps zero height before width and cannot allocate a hidden64MiB backing');
    await browser.evaluate('window.__v.openSpecialtyFiles([window.__file("dose")])');
    const stale = await browser.evaluate('(async()=>{const old=window.__v.setSpecialty({window:{center:5,width:10}}).then(()=>null,e=>e.name);await window.__v.setSpecialty({window:{center:10,width:20}});return await old;})()'); assert.equal(stale, 'AbortError');
    assert.equal((await browser.evaluate('JSON.parse(window.__v.exportSpecialtyReport())')).display.window.center, 10); record('rapid display patches cancel stale generations without changing stored dose values');

    await browser.screenshot('specialty-dose-synthetic'); await copyFile(join(temporary, 'specialty-dose-synthetic.png'), resolve(output, 'specialty-dose-synthetic.png'));
    const modal = await browser.evaluate('({inert:Array.from(window.__shadow.querySelector(".viewer-shell").children).filter(n=>!n.classList.contains("specialty-workspace")).every(n=>n.inert),focus:window.__shadow.activeElement?.textContent,role:window.__shadow.querySelector(".specialty-workspace").getAttribute("role")})');
    assert.equal(modal.inert, true); assert.equal(modal.focus, 'Close'); assert.equal(modal.role, 'dialog');
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await browser.until('!window.__v.getSpecialtyState().open', 'Escape did not close the specialty dialog.');
    state = await browser.evaluate('window.__v.getSpecialtyState()'); assert.equal(state.bytes, 0); assert.equal(state.canvasBytes, 0); assert.deepEqual(await browser.evaluate('window.__v.getWorkspaceState()'), original);
    record('modal focus/inert and Escape close return all specialty buffers to zero and preserve the ordinary image workspace');
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 480, height: 900, deviceScaleFactor: 1, mobile: true }); await browser.evaluate('window.__v.openSpecialtyFiles([window.__file("dose")])');
    const mobile = await browser.evaluate('(()=>{const r=window.__canvas().getBoundingClientRect(),d=window.__shadow.querySelector(".specialty-workspace").getBoundingClientRect();return{canvasWidth:r.width,canvasHeight:r.height,dialogWidth:d.width};})()');
    assert.ok(mobile.canvasWidth > 20 && mobile.canvasHeight > 20 && mobile.dialogWidth <= 480, `Mobile specialty dimensions: ${JSON.stringify(mobile)}`); await browser.screenshot('specialty-mobile-synthetic'); await copyFile(join(temporary, 'specialty-mobile-synthetic.png'), resolve(output, 'specialty-mobile-synthetic.png'));
    await browser.evaluate('window.__v.closeSpecialty()'); await browser.send('Emulation.clearDeviceMetricsOverride'); record('mobile specialty preview remains visible, physically scaled and bounded');

    await browser.evaluate('window.__pending=window.__v.openSpecialtyFiles([window.__hangingFile()]).then(()=>null,e=>e.name);true'); await browser.until('window.__v.getSpecialtyState().busy', 'Pending local stream did not start.');
    await browser.evaluate('window.__v.closeSpecialty()'); assert.equal(await browser.evaluate('window.__pending'), 'AbortError'); assert.equal(await browser.evaluate('window.__localCanceled'), 1); assert.equal((await browser.evaluate('window.__v.getSpecialtyState()')).bytes, 0);
    record('closing pending local parsing cancels its stream and returns no late specialty model');
    await browser.evaluate('window.__v.openSpecialtyFiles([window.__file("dose")])');
    await browser.evaluate('window.__oldClosing=window.__v.closeSpecialty();window.__reopening=window.__v.openSpecialtyFiles([window.__hangingFile()]).then(()=>null,e=>e.name);window.__oldClosing');
    await browser.until('window.__v.getSpecialtyState().busy&&window.__v.getSpecialtyState().open', 'Reopened local stream lost its cancellation owner.');
    await browser.evaluate('window.__v.closeSpecialty()'); assert.equal(await browser.evaluate('window.__reopening'), 'AbortError'); assert.equal(await browser.evaluate('window.__localCanceled'), 1);
    assert.equal((await browser.evaluate('window.__v.getSpecialtyState()')).bytes, 0);
    record('close followed immediately by reopening retains the new stream owner and later close cancels it');
    await browser.evaluate('window.__v.openSpecialtyFiles([window.__file("dose")])');
    const disposed = await browser.evaluate('(async()=>{window.__v.dispose();await window.__v.whenDisposed();return{state:window.__v.getSpecialtyState(),events:window.__events};})()');
    assert.equal(disposed.state.disposed, true); assert.equal(disposed.state.bytes, 0); assert.equal(disposed.state.canvasBytes, 0);
    assert.ok(!/"(?:patientName|patientId|sopUid|studyUid|seriesUid|frameOfReferenceUid|samples|rgba|position|stored|patientLpsMm)"\s*:|2\.25\.8\d+/u.test(JSON.stringify(disposed.events)));
    assert.ok(!/Patient|SYNTHETIC\^|InlineBinary|samples|rgba|PixelData/u.test(JSON.stringify(xaReport)));
    for (const request of browser.requests) { const url = new URL(request.url); assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol === 'blob:' && url.origin === target.origin, 'No remote request or upload is permitted.'); assert.equal(request.method, 'GET'); }
    assert.equal(browser.errors.length, 0); assert.equal(browser.consoleErrors.length, 0);
    record('disposal releases specialty buffers, automatic events exclude identifiers/pixels and all requests remain local static GETs');
    assert.equal(JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8')).sourceDigest, build.sourceDigest);
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ passed: checks.length, checks, sourceDigest: build.sourceDigest,
        harnessSha256: createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'), fixtureSha256: createHash('sha256').update(JSON.stringify(fixtures)).digest('hex'),
        browserExceptions: 0, consoleErrors: 0, originalImagingFilesUsed: false, profilesSaved: false, remoteRequests: 0, uploads: 0 }, null, 2) + '\n');
    console.log(`Specialty browser checks: ${checks.length} passed.`);
} finally {
    browser?.close(); await rm(qa, { recursive: true, force: true }); if (temporary) { await delay(200); await rm(temporary, { recursive: true, force: true }); }
}
