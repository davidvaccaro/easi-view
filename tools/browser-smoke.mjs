import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { createDicomFixture } from '../src/data/synthetic.js';
import { browserSession, delay } from './browser-session.mjs';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'artifacts/browser');
const target = new URL(process.env.EASI_VIEW_URL || 'http://127.0.0.1:5174/');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname), 'Browser smoke tests require an isolated local preview.');
const qa = resolve(root, 'dist/qa');
const checks = [];
const record = (name, detail = {}) => { checks.push({ name, ...detail }); console.log(`PASS ${name}`); };
const esc = value => JSON.stringify(value);
await mkdir(output, { recursive: true });
await mkdir(qa, { recursive: true });
await writeFile(resolve(output, 'qa-entry.js'), [
    "export { createDicomFixture } from '../../src/data/synthetic.js';",
    "export { createImageTransform, transformPoint } from '../../src/render/ViewportTransform.js';",
    "export { startApp } from '../../src/ui/app.js';"
].join('\n'));
await build({ entryPoints: [resolve(output, 'qa-entry.js')], outfile: resolve(qa, 'exports.js'), bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022', minify: true });
await cp(resolve(root, 'dist/assets/decode-worker.js'), resolve(qa, 'decode-worker.js'));
await writeFile(resolve(qa, 'lifecycle.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/assets/app.css"></head><body><div id="app"></div></body></html>');

const files = Array.from({ length: 3 }, (_, index) => createDicomFixture({ rows: 24, columns: 32,
    sopUid: `1.2.826.0.1.3680043.10.543.901.${index + 1}`, seriesUid: '1.2.826.0.1.3680043.10.543.901',
    position: [0, 0, index * 2], instanceNumber: index + 1, intercept: -1024,
    values: Array.from({ length: 24 * 32 }, (_, pixel) => 300 + pixel * 2 + index * 50) }));
const bad = createDicomFixture({ sopUid: '1.2.826.0.1.3680043.10.543.902', photometric: 'RGB' });
const responses = [];
const timers = new Set();
const boundary = 'EASI_VIEW_SYNTHETIC_QA';
const part = Buffer.from(`--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`);
const server = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', target.origin);
    response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Accept');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    if (request.url === '/empty') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Viewer navigation QA</title>'); return; }
    if (request.url === '/405') { response.writeHead(405); response.end(); return; }
    if (request.url === '/bad-native') { response.setHeader('Content-Type', 'application/dicom'); response.end(bad); return; }
    if (request.url !== '/study' && request.url !== '/partial-failure') { response.writeHead(404); response.end(); return; }
    const state = { path: request.url, ended: false, canceled: false, sent: 1, cookies: request.headers.cookie ?? null };
    responses.push(state);
    response.setHeader('Content-Type', `multipart/related; type="application/dicom"; boundary="${boundary}"`);
    response.write(part); response.write(files[0]); response.write(Buffer.from('\r\n')); response.write(part);
    const tail = request.url === '/study' ? [files[1], files[2]] : [bad];
    const later = (operation, milliseconds) => {
        const timer = setTimeout(() => { timers.delete(timer); if (!response.destroyed) operation(); }, milliseconds);
        timers.add(timer);
    };
    tail.forEach((bytes, index) => later(() => {
        response.write(bytes); state.sent++;
        if (index < tail.length - 1) { response.write(Buffer.from('\r\n')); response.write(part); }
        else { state.ended = true; response.end(Buffer.from(`\r\n--${boundary}--\r\n`)); }
    }, (index + 1) * 1200));
    response.on('close', () => { if (!state.ended) state.canceled = true; });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
let browser;

const readState = async () => browser.evaluate(`(() => {
    const text=id=>document.getElementById(id)?.textContent.trim();
    const canvas=document.getElementById('image-canvas'), rectangle=canvas?.getBoundingClientRect();
    return {title:text('image-title'),modality:text('modality-badge'),source:text('source-badge'),frames:Number(text('detail-frames')),
        frame:Number(text('frame-number')),overlay:text('frame-overlay'),status:text('status-text'),
        center:Number(document.getElementById('window-center')?.value),width:Number(document.getElementById('window-width')?.value),
        zoom:text('zoom-overlay'),playing:document.getElementById('cine-toggle')?.getAttribute('aria-pressed')==='true',
        error:!document.getElementById('error-banner')?.hidden,errorMessage:text('error-message'),
        empty:!document.getElementById('viewport-empty')?.hidden,matrix:text('detail-matrix'),samples:text('detail-samples'),
        flip:document.getElementById('flip-view')?.getAttribute('aria-pressed'),invert:document.getElementById('invert-view')?.getAttribute('aria-pressed'),
        fps:document.getElementById('cine-fps')?.value,canvas:rectangle?{x:rectangle.x,y:rectangle.y,width:rectangle.width,height:rectangle.height}:null,
        uploads:window.__qaUploads?.length??0,lastUpload:window.__qaUploads?.at(-1)??null,
        viewportWidth:innerWidth,documentWidth:document.documentElement.scrollWidth};
})()`);
const click = async selector => browser.evaluate(`document.querySelector(${esc(selector)}).click()`);
const ready = async (modality, count, source = 'SYNTHETIC DATA') => browser.until(`(() => {
    const text=id=>document.getElementById(id)?.textContent.trim();
    return text('modality-badge')===${esc(modality)} && text('source-badge')===${esc(source)} && Number(text('detail-frames'))===${count}
        && text('status-text').includes('ready') && document.getElementById('error-banner').hidden
        && !document.getElementById('viewport-empty').hidden===false && !document.querySelector('#image-stage').classList.contains('frame-loading');
})()`, `The ${modality} ${count}-frame source did not become ready.`);
const waitError = message => browser.until(`(() => {const banner=document.getElementById('error-banner');return banner&&!banner.hidden&&document.getElementById('error-message')?.textContent.includes(${esc(message)});})()`, `Expected viewer error: ${message}`);
const setField = async (id, value) => browser.evaluate(`(() => { const input=document.getElementById(${esc(id)}); input.value=${esc(String(value))}; input.dispatchEvent(new Event('change',{bubbles:true})); return input.value; })()`);
const slider = async value => {
    await browser.evaluate(`(() => { const input=document.getElementById('frame-slider');input.value=${value};input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await browser.until(`document.getElementById('frame-overlay').textContent.startsWith('Image ${String(value + 1).padStart(2, '0')} /') && !document.querySelector('#image-stage').classList.contains('frame-loading')`, 'Frame slider did not commit the requested frame.');
};
const mouse = async (type, x, y, buttons = 0) => browser.send('Input.dispatchMouseEvent', { type, x, y, button: buttons ? 'left' : 'none', buttons, clickCount: type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0 });
const drag = async (start, end) => {
    await mouse('mouseMoved', start.x, start.y);
    await mouse('mousePressed', start.x, start.y, 1);
    await mouse('mouseMoved', end.x, end.y, 1);
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: end.x, y: end.y, button: 'left', buttons: 0, clickCount: 1 });
};
const key = async (key, code, virtualKey) => {
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKey });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKey });
};
const openUrl = async path => browser.evaluate(`(() => {document.getElementById('dicom-url').value=${esc(endpoint + path)};document.getElementById('url-form').requestSubmit();})()`);
const importFiles = async options => browser.evaluate(`(() => {
    const transfer=new DataTransfer();
    for(const option of ${esc(options)}) transfer.items.add(new File([window.__qaExports.createDicomFixture(option)],'synthetic-local.dcm',{type:'application/dicom'}));
    const input=document.getElementById('file-input'); input.files=transfer.files; input.dispatchEvent(new Event('change',{bubbles:true}));
})()`);
const pixels = async () => {
    // Error banners resize the canvas. Let ResizeObserver settle before sampling;
    // compare image-space samples for rollback, screen-space pixels for panning.
    await delay(80);
    return browser.evaluate(`(() => {
    const input=document.getElementById('window-center');input.dispatchEvent(new Event('change',{bubbles:true}));
    const canvas=document.getElementById('image-canvas'),gl=canvas.getContext('webgl2');
    const pixels=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    let hash=2166136261,nonblack=0;
    for(let index=0;index<pixels.length;index+=16){for(let channel=0;channel<3;channel++){const byte=pixels[index+channel];hash=Math.imul(hash^byte,16777619)>>>0;if(byte>0)nonblack++;}}
    const dimensions=document.getElementById('detail-matrix').textContent.split('×').map(Number);
    const spacing=document.getElementById('detail-spacing').textContent.match(/[\\d.]+/g)?.map(Number)??null;
    const rectangle=canvas.getBoundingClientRect();
    const matrix=window.__qaExports.createImageTransform({columns:dimensions[0],rows:dimensions[1],pixelSpacing:spacing},
        {zoom:1,panX:0,panY:0,rotation:0,flipX:false,flipY:false},rectangle.width,rectangle.height);
    const imagePixels=[];
    for(let row=0;row<4;row++)for(let column=0;column<4;column++){
        const point=window.__qaExports.transformPoint(matrix,(column+0.5)/4*dimensions[0],(row+0.5)/4*dimensions[1]);
        const pixel=new Uint8Array(4);gl.readPixels(Math.floor(point.x*canvas.width/rectangle.width),canvas.height-1-Math.floor(point.y*canvas.height/rectangle.height),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
        imagePixels.push([...pixel]);
    }
    return {hash,nonblack,imagePixels};
})()`);
};
const installHooks = async () => browser.evaluate(`(async()=>{
    window.__qaExports=await import('/qa/exports.js');window.__qaUploads=[];
    const gl=document.getElementById('image-canvas').getContext('webgl2');if(!gl)throw new Error('Integration GPU QA requires WebGL2.');
    const original=gl.texImage2D.bind(gl);gl.texImage2D=(...args)=>{const samples=args[8];window.__qaUploads.push({rows:args[4],columns:args[3],count:samples?.length,first:samples?Array.from(samples.slice(0,4)):[]});return original(...args);};
})()`);

try {
    browser = await browserSession(output);
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await browser.send('Page.navigate', { url: target.href });
    await ready('CT', 16);
    await installHooks();
    let state = await readState();
    assert.equal(state.documentWidth, state.viewportWidth);
    assert.ok(state.canvas.width > 500 && state.canvas.height > 300);
    assert.ok((await pixels()).nonblack > 0);
    await browser.screenshot('desktop-ct');
    record('desktop layout and actual WebGL2 CT image', { canvas: state.canvas });

    for (const [kind, modality, count, rows, columns] of [['mr', 'MR', 12, 224, 224], ['xr', 'XR', 1, 384, 320], ['us', 'US', 24, 192, 192], ['ct', 'CT', 16, 192, 256]]) {
        await click(`[data-demo="${kind}"]`); await ready(modality, count);
        state = await readState();
        assert.equal(state.lastUpload.rows, rows); assert.equal(state.lastUpload.columns, columns);
        assert.equal(state.lastUpload.count, rows * columns);
        assert.ok((await pixels()).nonblack > 0);
        record(`${modality} synthetic DICOM source and native pixels`, { frames: count });
    }

    const beforeInteraction = (await readState()).uploads;
    const rectangle = (await readState()).canvas;
    const center = { x: rectangle.x + rectangle.width / 2, y: rectangle.y + rectangle.height / 2 };
    await click('[data-tool="window"]');
    await drag(center, { x: center.x + 32, y: center.y + 18 });
    assert.notEqual((await readState()).width, 400);
    await click('[data-tool="zoom"]');
    await drag(center, { x: center.x, y: center.y - 35 });
    assert.notEqual((await readState()).zoom, '100%');
    await click('[data-tool="pan"]');
    const beforePan = await pixels();
    await drag(center, { x: center.x + 47, y: center.y + 17 });
    assert.notEqual((await pixels()).hash, beforePan.hash);
    await click('#rotate-view'); await click('#flip-view'); await click('#invert-view');
    state = await readState(); assert.equal(state.flip, 'true'); assert.equal(state.invert, 'true');
    assert.equal(state.uploads, beforeInteraction);
    record('window, zoom, pan, rotation, flips and inversion reuse raw GPU texture');
    await setField('window-width', 780); await setField('window-center', 123);
    const preserved = await readState(); await slider(3); state = await readState();
    for (const property of ['width', 'center', 'zoom', 'flip', 'invert']) assert.equal(state[property], preserved[property]);
    assert.equal(state.frame, 4); record('frame navigation preserves display state');
    await click('#reset-view'); state = await readState();
    assert.equal(state.width, 400); assert.equal(state.center, 40); assert.equal(state.zoom, '100%');
    assert.equal(state.flip, 'false'); assert.equal(state.invert, 'false'); record('reset restores source window and view');

    const localOptions = { rows: 2, columns: 2, values: [-1000, -500, 0, 1000], signed: true,
        slope: 2, intercept: -1024, pixelSpacing: [2, 3], window: { center: -1024, width: 4001 }, sopUid: '1.2.3.500' };
    const requestsBeforeLocal = browser.requests.length;
    await importFiles([localOptions]); await ready('CT', 1, 'LOCAL FILES');
    const localRequests = browser.requests.slice(requestsBeforeLocal);
    assert.ok(localRequests.every(request => request.method === 'GET' && request.url.startsWith(target.origin + '/assets/decode-worker.js')));
    record('local synthetic File import performs no upload or external request', { requests: localRequests });
    const points = await browser.evaluate(`(() => {
        const canvas=document.getElementById('image-canvas'),r=canvas.getBoundingClientRect();
        const matrix=window.__qaExports.createImageTransform({rows:2,columns:2,pixelSpacing:[2,3]},
            {zoom:1,panX:0,panY:0,rotation:0,flipX:false,flipY:false},r.width,r.height);
        return [[0.5,0.5],[1.5,0.5]].map(([x,y])=>{const point=window.__qaExports.transformPoint(matrix,x,y);return{x:point.x+r.x,y:point.y+r.y};});
    })()`);
    await click('[data-tool="probe"]'); await mouse('mouseMoved', points[0].x, points[0].y);
    let probeValue = await browser.evaluate(`({coordinate:document.getElementById('probe-coordinate').textContent,value:document.getElementById('probe-value').textContent,stored:document.getElementById('probe-stored').textContent})`);
    assert.match(probeValue.coordinate, /Pixel \(0, 0\)/); assert.match(probeValue.value, /-3,024.*HU/); assert.match(probeValue.stored, /-1,000/);
    await click('[data-tool="distance"]'); await drag(points[0], points[1]);
    assert.equal(await browser.evaluate(`document.querySelector('.measurement-label')?.textContent`), '3 mm');
    record('signed intensity probe and calibrated anisotropic distance', probeValue);

    const localSnapshot = await readState(); const localPixels = await pixels();
    await importFiles([{ photometric: 'RGB' }]); await waitError('MONOCHROME');
    state = await readState(); assert.equal(state.source, localSnapshot.source); assert.equal(state.frames, 1); assert.equal(state.matrix, '2 × 2');
    assert.deepEqual((await pixels()).imagePixels, localPixels.imagePixels); record('unsupported local file preserves committed image');
    await click('#dismiss-error');

    await browser.evaluate(`(() => {const gl=document.getElementById('image-canvas').getContext('webgl2');const original=gl.getError.bind(gl);let once=true;gl.getError=()=>once?(once=false,gl.INVALID_OPERATION):original();window.__qaRestoreGl=()=>{gl.getError=original;};})()`);
    await importFiles([{ sopUid: '1.2.3.501', rows: 2, columns: 2, values: [50, 60, 70, 80] }]);
    await waitError('GPU'); await browser.evaluate('window.__qaRestoreGl()');
    state = await readState(); assert.equal(state.matrix, '2 × 2'); assert.equal(state.source, 'LOCAL FILES');
    assert.deepEqual((await pixels()).imagePixels, localPixels.imagePixels); record('first-frame GPU failure rolls back to committed image');
    await click('#dismiss-error');
    await browser.evaluate(`window.__qaWorker=window.Worker;window.Worker=class{constructor(){throw new Error('QA new source worker unavailable');}};`);
    await importFiles([{ sopUid: '1.2.3.502' }]); await waitError('QA new source worker unavailable');
    await browser.evaluate('window.Worker=window.__qaWorker');
    assert.equal((await readState()).matrix, '2 × 2'); assert.deepEqual((await pixels()).imagePixels, localPixels.imagePixels);
    await click('#dismiss-error'); record('first-frame decoder failure rolls back to committed image');

    await openUrl('/study');
    await browser.until(`document.getElementById('source-badge').textContent==='REMOTE SOURCE' && document.getElementById('frame-overlay').textContent==='Image 01 / 1' && document.getElementById('detail-matrix').textContent==='32 × 24'`, 'First streamed remote frame was not displayed.');
    assert.equal(responses.at(-1).ended, false); assert.ok((await pixels()).nonblack > 0);
    record('DICOMweb first image displays before multipart response ends', { sentParts: responses.at(-1).sent });
    await ready('CT', 3, 'REMOTE SOURCE'); assert.equal(responses.at(-1).ended, true); assert.equal(responses.at(-1).cookies, null);
    record('DICOMweb response completes as a three-frame stack without credentials');
    const remoteSnapshot = await readState(); const remotePixels = await pixels();
    await openUrl('/study');
    await browser.until(`document.getElementById('frame-overlay').textContent==='Image 01 / 1'`, 'Replacement stream did not display its first image.');
    await openUrl('/405'); await waitError('HTTP 405');
    state = await readState(); assert.equal(state.frames, 3); assert.deepEqual((await pixels()).imagePixels, remotePixels.imagePixels);
    assert.equal(responses.at(-1).canceled, true); await click('#dismiss-error');
    record('superseding a partial stream cancels it and preserves the last committed source');
    for (const [path, message] of [['/405', 'HTTP 405'], ['/bad-native', 'MONOCHROME']]) {
        await openUrl(path); await waitError(message); state = await readState();
        assert.equal(state.frames, remoteSnapshot.frames); assert.equal(state.matrix, remoteSnapshot.matrix);
        assert.deepEqual((await pixels()).imagePixels, remotePixels.imagePixels); await click('#dismiss-error');
        record(`${path} retrieval error preserves committed image`);
    }
    await openUrl('/partial-failure');
    await browser.until(`document.getElementById('source-badge').textContent==='REMOTE SOURCE' && document.getElementById('frame-overlay').textContent==='Image 01 / 1'`, 'Partial failure did not show its first image.');
    assert.equal(responses.at(-1).ended, false);
    await waitError('MONOCHROME'); state = await readState();
    assert.equal(state.frames, 3); assert.equal(state.matrix, remoteSnapshot.matrix); assert.deepEqual((await pixels()).imagePixels, remotePixels.imagePixels);
    await click('#dismiss-error'); record('malformed multipart tail rolls back after progressive first display');

    await browser.evaluate(`document.querySelector('[data-demo="ct"]').click();document.querySelector('[data-demo="us"]').click();document.querySelector('[data-demo="mr"]').click();`);
    await ready('MR', 12); await delay(150); state = await readState(); assert.equal(state.modality, 'MR'); assert.equal(state.frames, 12);
    record('rapid source switches commit only the latest source');
    await click('[data-demo="us"]'); await ready('US', 24); await browser.screenshot('desktop-us');
    await click('#cine-toggle'); await browser.until(`document.getElementById('frame-number').textContent.trim()!=='01'`, 'Cine did not advance.');
    assert.equal((await readState()).playing, true); await click('#cine-toggle'); const paused = (await readState()).frame;
    await delay(160); assert.equal((await readState()).frame, paused); record('multiframe US cine advances and pauses');
    await browser.evaluate(`document.getElementById('image-canvas').focus()`);
    await key('ArrowRight', 'ArrowRight', 39); await browser.until(`Number(document.getElementById('frame-number').textContent)===${paused + 1}`, 'Arrow key did not advance a frame.');
    await key(' ', 'Space', 32); assert.equal((await readState()).playing, true); await key(' ', 'Space', 32); assert.equal((await readState()).playing, false);
    await browser.until(`!document.getElementById('image-stage').classList.contains('frame-loading')`, 'The paused frame did not finish.');
    const beforeFocusedInput = (await readState()).frame;
    await browser.evaluate(`document.getElementById('dicomweb-panel').open=true;document.getElementById('dicom-url').focus()`);
    assert.equal(await browser.evaluate(`document.activeElement.id`), 'dicom-url');
    await key('ArrowRight', 'ArrowRight', 39); await key(' ', 'Space', 32);
    assert.equal((await readState()).frame, beforeFocusedInput); assert.equal((await readState()).playing, false);
    record('arrow/space shortcuts work and leave focused inputs alone');

    await browser.evaluate(`document.getElementById('image-canvas').focus()`); await key(' ', 'Space', 32);
    const originalTarget = (await browser.send('Target.getTargetInfo')).targetInfo.targetId;
    const background = await browser.send('Target.createTarget', { url: 'about:blank' });
    await browser.send('Target.activateTarget', { targetId: background.targetId });
    await browser.until(`document.hidden && document.getElementById('cine-toggle').getAttribute('aria-pressed')==='false'`, 'Backgrounding the page did not pause cine.', 40);
    await browser.send('Target.closeTarget', { targetId: background.targetId });
    await browser.send('Target.activateTarget', { targetId: originalTarget });
    record('actual background-tab visibility pauses cine');

    await browser.evaluate(`(() => {
        const Original=window.Worker;window.__qaUndelayedWorker=Original;
        window.Worker=class extends Original{constructor(...args){super(...args);Object.defineProperty(this,'onmessage',{
            configurable:true,set:handler=>this.addEventListener('message',event=>setTimeout(()=>handler(event),350))
        });}};
    })()`);
    await click('[data-demo="us"]'); await ready('US', 24);
    const frozenBefore = await readState(); const frozenPixels = await pixels();
    await click('#cine-toggle');
    await browser.until(`document.getElementById('image-stage').classList.contains('frame-loading')`, 'Delayed cine did not begin decoding.');
    await click('#cine-toggle'); await delay(450);
    state = await readState(); assert.equal(state.playing, false); assert.equal(state.frame, frozenBefore.frame);
    assert.equal(state.overlay, frozenBefore.overlay); assert.equal(state.uploads, frozenBefore.uploads);
    assert.deepEqual((await pixels()).imagePixels, frozenPixels.imagePixels);
    record('pausing an in-flight cine decode freezes the displayed frame');
    await click('#cine-toggle');
    await browser.until(`document.getElementById('image-stage').classList.contains('frame-loading')`, 'Second delayed cine decode did not begin.');
    await slider(6); state = await readState(); assert.equal(state.frame, 7); assert.equal(state.playing, false);
    await browser.evaluate(`window.Worker=window.__qaUndelayedWorker`);
    record('seeking during in-flight cine commits the requested manual frame');

    await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await delay(120); state = await readState(); assert.equal(state.documentWidth, 390); assert.ok(state.canvas.width > 200 && state.canvas.height > 200);
    if (!await browser.evaluate(`document.getElementById('app').classList.contains('inspector-hidden')`)) await click('#toggle-inspector');
    await browser.screenshot('mobile-us'); await click('#toggle-inspector'); await browser.screenshot('mobile-inspector');
    assert.equal((await readState()).documentWidth, 390); await click('#toggle-inspector'); await click('#toggle-library');
    assert.equal(await browser.evaluate(`document.getElementById('app').classList.contains('library-open')`), true);
    await click('[data-demo="xr"]'); await ready('XR', 1);
    assert.equal(await browser.evaluate(`document.getElementById('app').classList.contains('library-open')`), false);
    assert.equal((await readState()).documentWidth, 390); await browser.screenshot('mobile-xr'); record('mobile layout and library controls have no document overflow');

    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const history = await browser.send('Page.getNavigationHistory'); const entry = history.entries[history.currentIndex].id;
    await browser.send('Page.navigate', { url: endpoint + '/empty' }); await browser.until(`document.title==='Viewer navigation QA'`, 'Navigation QA page did not load.');
    await browser.send('Page.navigateToHistoryEntry', { entryId: entry });
    await browser.until(`document.getElementById('status-text')?.textContent.includes('ready') && document.getElementById('viewport-empty')?.hidden`, 'Back navigation did not restore an active image.');
    await click('[data-demo="mr"]'); await ready('MR', 12); record('back navigation returns a working viewer after pagehide');

    // Cold start with no committed image exercises blank-state rollback separately.
    const injection = await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__qaOriginalWorker=window.Worker;window.Worker=class{constructor(){throw new Error('QA decoding worker unavailable');}};` });
    await browser.send('Page.navigate', { url: target.href + '?qa=cold' }); await waitError('QA decoding worker unavailable');
    await browser.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injection.identifier });
    await browser.evaluate(`window.Worker=window.__qaOriginalWorker`);
    await openUrl('/partial-failure');
    await browser.until(`document.getElementById('source-badge').textContent==='REMOTE SOURCE' && document.getElementById('frame-overlay').textContent==='Image 01 / 1'`, 'Cold partial source did not display.');
    await waitError('MONOCHROME'); state = await readState(); assert.equal(state.empty, true); assert.equal(state.overlay, 'No image loaded');
    assert.ok(['—', ''].includes(state.matrix)); assert.ok(['—', ''].includes(state.samples)); record('failed first source clears progressive pixels and stale metadata');
    await installHooks();
    await importFiles([{ rows: 2, columns: 2, frames: 3, bitsAllocated: 8, bitsStored: 8,
        values: [0, 30, 60, 90, 10, 40, 70, 100, 20, 50, 80, 110], modality: 'US',
        sopClass: '1.2.840.10008.5.1.4.1.1.3.1', sopUid: '1.2.3.503', frameTime: 40, rescaleType: 'US' }]);
    await ready('US', 3, 'LOCAL FILES'); assert.equal((await readState()).fps, '25');
    record('native multiframe timing selects the exact declared 25 fps');

    // Exercise the mount/dispose API on a dedicated root without the normal app bootstrap.
    await browser.send('Page.navigate', { url: target.origin + '/qa/lifecycle.html' });
    await browser.until(`document.readyState==='complete'`, 'Lifecycle QA document did not load.');
    await browser.evaluate(`(async()=>{window.__qaExports=await import('/qa/exports.js');const original=window.Worker;window.__qaWorkerCount=0;window.Worker=class extends original{constructor(...args){super(...args);window.__qaWorkerCount++;}};window.__qaApp=window.__qaExports.startApp(document.getElementById('app'));})()`);
    await ready('CT', 16); await browser.evaluate(`window.__qaApp.dispose();window.__qaApp.dispose();window.__qaApp=window.__qaExports.startApp(document.getElementById('app'))`);
    await ready('CT', 16); const workersBeforeDrop = await browser.evaluate('window.__qaWorkerCount');
    await browser.evaluate(`(() => {const transfer=new DataTransfer();transfer.items.add(new File([window.__qaExports.createDicomFixture({sopUid:'1.2.3.999'})],'synthetic-drop.dcm',{type:'application/dicom'}));document.getElementById('app').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));})()`);
    await ready('CT', 1, 'LOCAL FILES'); assert.equal(await browser.evaluate('window.__qaWorkerCount'), workersBeforeDrop + 1);
    record('mount/dispose/remount releases listeners and handles each file drop once');
    await browser.evaluate('window.__qaApp.dispose()');

    assert.deepEqual(browser.errors, []); assert.deepEqual(browser.consoleErrors, []);
    record('no uncaught browser exceptions or console errors');
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ target: target.href, checks, requests: browser.requests,
        exceptions: browser.errors, consoleErrors: browser.consoleErrors, multipartResponses: responses }, null, 2) + '\n');
    await Promise.all(['failure.json', 'failure.png'].map(name => rm(resolve(output, name), { force: true })));
    console.log(`Browser smoke passed: ${checks.length} integration groups.`);
} catch (error) {
    await writeFile(resolve(output, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack, checks,
        state: browser ? await readState().catch(() => null) : null, exceptions: browser?.errors, consoleErrors: browser?.consoleErrors, multipartResponses: responses }, null, 2) + '\n');
    if (browser) await browser.screenshot('failure').catch(() => {});
    throw error;
} finally {
    browser?.close(); for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(qa, { recursive: true, force: true });
}
