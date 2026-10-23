import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { createCompressedDicom } from '../test/compressed-fixtures.js';
import { browserSession } from './browser-session.mjs';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'artifacts/browser-compressed');
const qa = resolve(root, 'dist/qa');
const target = new URL(process.env.EASI_VIEW_URL || 'http://127.0.0.1:5174/');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname), 'Compressed browser checks require an isolated local preview.');
const checks = [], fixtures = {};
const quote = JSON.stringify;
const record = (name, detail = {}) => { checks.push({ name, ...detail }); console.log(`PASS ${name}`); };
let browser;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function quadrantSamples(rows, columns, values) {
    return Array.from({ length: rows * columns }, (_, index) =>
        values[(Math.floor(index / columns) >= rows / 2 ? 2 : 0) + (index % columns >= columns / 2 ? 1 : 0)]).flat();
}

async function makeFixture(name, options, reference, tolerance = 0) {
    const rows = options.rows ?? 8, columns = options.columns ?? 8;
    const frameSamples = Array.from({ length: 8 }, (_, frame) => quadrantSamples(rows, columns, reference(frame)));
    const fixture = await createCompressedDicom({ rows, columns, frameSamples, frameTime: 40,
        sopUid: `1.2.826.0.1.3680043.10.543.997.${Object.keys(fixtures).length + 1}`, ...options });
    fixtures[name] = { encoded: Buffer.from(fixture.bytes).toString('base64'),
        expected: fixture.expectedSamples, metadata: fixture.metadata, tolerance };
}

const state = () => browser.evaluate(`(()=>{const text=id=>document.getElementById(id)?.textContent.trim();return{
    frame:Number(text('frame-number')),frames:Number(text('detail-frames')),photometric:text('detail-photometric'),
    center:Number(document.getElementById('window-center').value),width:Number(document.getElementById('window-width').value),
    upload:window.__compressedUploads.at(-1),gpu:window.__compressedGpu,decodes:window.__compressedDecodes,
    error:!document.getElementById('error-banner').hidden,errorMessage:text('error-message')};})()`);
const ready = async () => { await browser.until(`!document.getElementById('error-banner').hidden || (document.getElementById('source-badge').textContent==='LOCAL FILES' &&
    Number(document.getElementById('detail-frames').textContent)===8 && document.getElementById('error-banner').hidden &&
    document.getElementById('viewport-empty').hidden && document.getElementById('viewport-loading').hidden &&
    document.getElementById('status-text').textContent.includes('ready') && !document.getElementById('image-stage').classList.contains('frame-loading'))`,
    'The generated compressed image did not become ready.');
    const current = await state();
    if (current.error) throw new Error(`Generated compressed fixture rejected: ${current.errorMessage}`);
};
const importFixture = name => browser.evaluate(`(()=>{window.__activeCompressed=${quote(name)};const transfer=new DataTransfer();
    transfer.items.add(window.__compressed.file(${quote(name)}));const input=document.getElementById('file-input');
    input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
const slide = async index => {
    await browser.evaluate(`(()=>{const input=document.getElementById('frame-slider');input.value=${index};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await browser.until(`Number(document.getElementById('frame-number').textContent)===${index + 1} && !document.getElementById('image-stage').classList.contains('frame-loading')`, 'A compressed seek did not commit its selected frame.');
};

function assertSamples(name, frame, actual) {
    const fixture = fixtures[name], expected = fixture.expected[frame];
    assert.equal(actual.length, expected.length, `${name} decoded sample count`);
    actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <= fixture.tolerance,
        `${name} stored sample ${index}: ${value} differs from independent reference ${expected[index]}`));
}

function assertGpu(name, frame, current) {
    const fixture = fixtures[name], { rows, columns, samplesPerPixel } = fixture.metadata;
    assert.equal(current.gpu.length, 4);
    const indices = [[Math.floor(columns / 4), Math.floor(rows / 4)], [Math.floor(columns * 3 / 4), Math.floor(rows / 4)],
        [Math.floor(columns / 4), Math.floor(rows * 3 / 4)], [Math.floor(columns * 3 / 4), Math.floor(rows * 3 / 4)]];
    indices.forEach(([x, y], index) => {
        for (let channel = 0; channel < 3; channel++) {
            const sample = fixture.expected[frame][(y * columns + x) * samplesPerPixel + (samplesPerPixel === 3 ? channel : 0)];
            const expected = samplesPerPixel === 3 ? sample :
                Math.round(Math.max(0, Math.min(1, (sample - (current.center - .5)) / (current.width - 1) + .5)) * 255);
            assert.ok(Math.abs(current.gpu[index][channel] - expected) <= fixture.tolerance + 2,
                `${name} GPU quadrant ${index}, channel ${channel} differs from the independent display reference.`);
        }
        assert.equal(current.gpu[index][3], 255);
    });
}

try {
    const buildInfo = JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8'));
    await makeFixture('rle-signed', { codec: 'rle', bitsAllocated: 16, signed: true, bitsStored: 12 },
        frame => [-2048 + frame, -1 - frame, frame, 2047 - frame]);
    await makeFixture('rle-rgb', { codec: 'rle', samplesPerPixel: 3, planarConfiguration: 1, bot: false },
        frame => [[255 - frame, 0, 0], [0, 255 - frame, 0], [0, 0, 255 - frame], [17 + frame, 31, 129]]);
    await makeFixture('jpeg-gray', { codec: 'jpeg', rows: 16, columns: 16, bot: false, fragmentsPerFrame: 3 },
        frame => [16 + frame, 80 + frame, 128 + frame, 240 - frame], 1);
    await makeFixture('jpeg-rgb', { codec: 'jpeg', rows: 16, columns: 16, samplesPerPixel: 3, fragmentsPerFrame: 3 },
        frame => [[255 - frame, 0, 0], [0, 255 - frame, 0], [0, 0, 255 - frame], [17 + frame, 31, 129]], 3);
    await makeFixture('jpeg-lossless', { codec: 'jpeg-lossless', bitsAllocated: 16, signed: true, fragmentsPerFrame: 2 },
        frame => [-32768 + frame, -1 - frame, frame, 32767 - frame]);
    await makeFixture('jpeg-lossless-p2', { codec: 'jpeg-lossless', transferSyntax: '1.2.840.10008.1.2.4.57',
        bitsAllocated: 16, fragmentsPerFrame: 2, encoderOptions: { predictor: 2 } },
        frame => [frame, 255 + frame, 32768 + frame, 65535 - frame]);
    await makeFixture('jpeg-ls', { codec: 'jpeg-ls', bitsAllocated: 16, bitsStored: 12, fragmentsPerFrame: 2, bot: false },
        frame => [frame, 255 + frame, 1024 + frame, 4095 - frame]);
    await makeFixture('jpeg-ls-near', { codec: 'jpeg-ls-near', rows: 16, columns: 16,
        bitsAllocated: 8, fragmentsPerFrame: 2, encoderOptions: { allowedLossyError: 2 } },
        frame => [16 + frame, 80 + frame, 128 + frame, 240 - frame], 2);
    await makeFixture('jpeg2000', { codec: 'jpeg2000', bitsAllocated: 16, signed: true, fragmentsPerFrame: 2 },
        frame => [-32768 + frame, -1 - frame, frame, 32767 - frame]);
    await makeFixture('jpeg2000-lossy', { codec: 'jpeg2000-lossy', rows: 16, columns: 16,
        bitsAllocated: 8, fragmentsPerFrame: 2, encoderOptions: { rate: 1 } },
        frame => [16 + frame, 80 + frame, 128 + frame, 240 - frame], 3);
    await makeFixture('jpeg2000-rct', { codec: 'jpeg2000', samplesPerPixel: 3, photometric: 'YBR_RCT', extendedOffsets: true },
        frame => [[255 - frame, 0, 0], [0, 255 - frame, 0], [0, 0, 255 - frame], [17 + frame, 31, 129]]);
    const invalid = await createCompressedDicom({ codec: 'jpeg', rows: 16, columns: 16,
        frameSamples: Array.from({ length: 8 }, () => Array(256).fill(90)), metadataOverrides: { rows: 17 } });
    fixtures['bad-dimensions'] = { encoded: Buffer.from(invalid.bytes).toString('base64'), metadata: invalid.metadata };
    await mkdir(output, { recursive: true }); await mkdir(qa, { recursive: true });
    const entry = resolve(output, 'qa-entry.js');
    await writeFile(entry, `export {createImageTransform,transformPoint} from '../../src/render/ViewportTransform.js';
export const fixtures=${quote(fixtures)};
export function file(name){const fixture=fixtures[name];return new File([Uint8Array.from(atob(fixture.encoded),value=>value.charCodeAt(0))],'synthetic-'+name+'.dcm',{type:'application/dicom'});}`);
    await build({ entryPoints: [entry], outfile: resolve(qa, 'compressed.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true });
    await writeFile(resolve(qa, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./host.css"></head><body><main id="mount"></main><script type="module" src="./host.js"></script></body></html>');
    await writeFile(resolve(qa, 'host.css'), 'body{margin:0}#mount{height:850px;width:100%}');
    await writeFile(resolve(qa, 'host.js'), `import{createViewer}from'../assets/easi-view.js';import{file,fixtures}from'./compressed.js';
const NativeWorker=window.Worker;window.__workers={created:0,terminated:0};window.Worker=class extends NativeWorker{constructor(...args){super(...args);window.__workers.created++;this.__ended=false;}terminate(){if(!this.__ended){this.__ended=true;window.__workers.terminated++;}return super.terminate();}};
window.__sdk={viewer:createViewer(document.getElementById('mount')),file,fixtures,events:[]};for(const type of['sourcechange','framechange','error'])window.__sdk.viewer.on(type,detail=>window.__sdk.events.push({type,detail}));await window.__sdk.viewer.ready;window.__sdk.ready=true;`);
    browser = await browserSession(output);
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await browser.send('Page.navigate', { url: target.href });
    await browser.until(`document.getElementById('status-text')?.textContent.includes('ready') && document.getElementById('viewport-empty')?.hidden`, 'The initial synthetic viewer did not become ready.');
    await browser.evaluate(`(async()=>{window.__compressed=await import('/qa/compressed.js');window.__compressedUploads=[];window.__compressedGpu=[];window.__compressedDecodes=0;
const post=Worker.prototype.postMessage;Worker.prototype.postMessage=function(...args){window.__compressedDecodes++;return post.apply(this,args);};
const canvas=document.getElementById('image-canvas'),gl=canvas.getContext('webgl2');if(!gl)throw new Error('Compressed pixel QA requires WebGL2.');
const upload=gl.texImage2D.bind(gl);gl.texImage2D=(...args)=>{const pixels=args[8];if(pixels?.length)window.__compressedUploads.push({count:pixels.length,samples:Array.from(pixels)});return upload(...args);};
const draw=gl.drawArrays.bind(gl);gl.drawArrays=(...args)=>{draw(...args);const fixture=window.__compressed.fixtures[window.__activeCompressed];if(!fixture)return;const{rows,columns}=fixture.metadata,r=canvas.getBoundingClientRect();const t=window.__compressed.createImageTransform({rows,columns,pixelSpacing:[.75,.75]},{zoom:1,panX:0,panY:0,rotation:0,flipX:false,flipY:false},r.width,r.height);window.__compressedGpu=[[Math.floor(columns/4),Math.floor(rows/4)],[Math.floor(columns*3/4),Math.floor(rows/4)],[Math.floor(columns/4),Math.floor(rows*3/4)],[Math.floor(columns*3/4),Math.floor(rows*3/4)]].map(([x,y])=>{const p=window.__compressed.transformPoint(t,x+.5,y+.5),color=new Uint8Array(4);gl.readPixels(Math.floor(p.x*canvas.width/r.width),canvas.height-1-Math.floor(p.y*canvas.height/r.height),1,1,gl.RGBA,gl.UNSIGNED_BYTE,color);return Array.from(color);});};})()`);
    const localStart = browser.requests.length;
    for (const name of Object.keys(fixtures).filter(name => name !== 'bad-dimensions')) {
        await importFixture(name); await ready(); let current = await state();
        assert.equal(current.frames, 8); assertSamples(name, 0, current.upload.samples); assertGpu(name, 0, current);
        assert.equal(current.photometric, fixtures[name].metadata.samplesPerPixel === 3 ? 'RGB' : 'MONOCHROME2');
        await slide(7); current = await state(); assertSamples(name, 7, current.upload.samples); assertGpu(name, 7, current);
        const before = current.decodes; await slide(0); current = await state(); assertSamples(name, 0, current.upload.samples);
        assert.equal(current.decodes, before, 'Returning to a decoded compressed frame must use the cache.');
        await browser.evaluate(`document.querySelector('[data-tool="probe"]').click()`);
        const point = await browser.evaluate(`(()=>{const f=window.__compressed.fixtures[${quote(name)}].metadata,c=document.getElementById('image-canvas'),r=c.getBoundingClientRect();const t=window.__compressed.createImageTransform({rows:f.rows,columns:f.columns,pixelSpacing:[.75,.75]},{zoom:1,panX:0,panY:0,rotation:0,flipX:false,flipY:false},r.width,r.height);const p=window.__compressed.transformPoint(t,Math.floor(f.columns/4)+.5,Math.floor(f.rows/4)+.5);return{x:r.x+p.x,y:r.y+p.y};})()`);
        await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
        const probe = await browser.until(`document.getElementById('probe-stored').textContent.startsWith(${quote(fixtures[name].metadata.samplesPerPixel === 3 ? 'R ' : 'Stored: ')}) && document.getElementById('probe-stored').textContent`, 'Compressed stored-value probe did not update.');
        const values = probe.replaceAll(',', '').match(/-?\d+(?:\.\d+)?/g).map(Number), channels = fixtures[name].metadata.samplesPerPixel;
        const offset = (Math.floor(fixtures[name].metadata.rows / 4) * fixtures[name].metadata.columns + Math.floor(fixtures[name].metadata.columns / 4)) * channels;
        values.slice(0, channels).forEach((value, channel) => assert.ok(Math.abs(value - fixtures[name].expected[0][offset + channel]) <= fixtures[name].tolerance,
            `${name} stored-value probe differs from its independent original reference: ${probe}`));
        record(`${name}: original-reference worker samples, GPU output, stored-value probe, distant seek and cache reuse`,
            { frames: 8, syntax: fixtures[name].metadata.transferSyntax, tolerance: fixtures[name].tolerance });
    }
    await importFixture('jpeg-gray'); await ready();
    await browser.evaluate(`(()=>{document.getElementById('cine-fps').value='5';document.getElementById('cine-fps').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('cine-toggle').click();})()`);
    await browser.until(`Number(document.getElementById('frame-number').textContent)>1 && !document.getElementById('image-stage').classList.contains('frame-loading')`, 'Compressed cine did not advance.');
    await browser.evaluate(`document.getElementById('cine-toggle').click()`);
    let current = await state(); assertSamples('jpeg-gray', current.frame - 1, current.upload.samples);
    record('compressed multiframe cine advances selected frames and pauses with matching original-reference pixels');
    const prior = await state(); await importFixture('bad-dimensions');
    await browser.until(`!document.getElementById('error-banner').hidden`, 'A mismatched compressed codestream did not reject.');
    current = await state(); assert.match(current.errorMessage, /dimensions|metadata/i);
    assert.deepEqual(current.upload.samples, prior.upload.samples); assert.equal(current.frame, prior.frame);
    record('compressed codestream metadata mismatch rejects and rolls back to the prior displayed frame');
    await browser.evaluate(`document.getElementById('dismiss-error').click()`);
    assert.ok(browser.requests.slice(localStart).every(request => request.method === 'GET' && new URL(request.url).origin === target.origin),
        'Local compressed viewing must not upload images or contact archives.');
    await browser.screenshot('synthetic-compressed-desktop');
    await browser.send('Page.navigate', { url: new URL('qa/index.html', target).href });
    await browser.until('window.__sdk?.ready', 'The embedded compressed mount did not become ready.');
    const sdk = await browser.evaluate(`(async()=>{const v=window.__sdk.viewer,results=[];
for(const name of ['jpeg-lossless','jpeg-ls','jpeg2000-rct']){await v.openFiles([window.__sdk.file(name)]);await v.setFrame(7);const s=v.getState(),p=v.getPerformance();results.push({name,frame:s.frameIndex,count:s.frameCount,photometric:s.image.photometric,workerCount:p.resources.workerCount,decodeSuccess:p.summary.decode?.successCount??0});}
await v.openFiles([window.__sdk.file('jpeg-ls')]);v.resetPerformance();const seeks=await Promise.allSettled([v.setFrame(2),v.setFrame(3),v.setFrame(7)]);const s=v.getState(),p=v.getPerformance();const eventKinds=window.__sdk.events.map(e=>e.type);const privateByDefault=!/"(?:patientName|patientId|samples|pixelData|studyUid|seriesUid|sopUid)":|1\\.2\\.826/.test(JSON.stringify(window.__sdk.events));
v.dispose();return{results,seeks:seeks.map(s=>s.status),lastFrame:s.frameIndex,performance:p,events:eventKinds,privateByDefault,disposed:v.getState().disposed,after:v.getPerformance(),workers:window.__workers};})()`);
    sdk.results.forEach(result => { assert.equal(result.frame, 7); assert.equal(result.count, 8); assert.equal(result.workerCount, 1); assert.ok(result.decodeSuccess > 0); });
    assert.equal(sdk.results[2].photometric, 'RGB'); assert.equal(sdk.lastFrame, 7); assert.ok(sdk.performance.summary.frame.canceledCount >= 1);
    assert.ok(sdk.performance.resources.decodedCacheBytes <= 64 * 1024 * 1024); assert.ok(sdk.performance.measurements.length <= 256);
    assert.equal(sdk.privateByDefault, true); assert.equal(sdk.disposed, true); assert.equal(sdk.after.measurements.length, 0);
    assert.equal(sdk.after.resources.workerCount, 0); assert.equal(sdk.after.resources.encodedBytes, 0); assert.equal(sdk.after.resources.decodedCacheBytes, 0);
    assert.equal(sdk.workers.created, sdk.workers.terminated); assert.ok(sdk.events.includes('sourcechange') && sdk.events.includes('framechange'));
    record('embedded compressed codecs survive rapid superseded seeks, bounded caches and private events, then release every worker on dispose',
        { workersCreated: sdk.workers.created, workersTerminated: sdk.workers.terminated, canceledFrames: sdk.performance.summary.frame.canceledCount });
    assert.equal(browser.errors.length, 0); assert.equal(browser.consoleErrors.length, 0);
    assert.equal(JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8')).sourceDigest, buildInfo.sourceDigest,
        'The browser distribution changed during compressed QA.');
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ passed: checks.length, checks, browserExceptions: 0,
        consoleErrors: 0, originalImagingFilesUsed: false, sourceDigest: buildInfo.sourceDigest, version: buildInfo.version,
        harnessSha256: sha256(await readFile(import.meta.filename)),
        fixtureHelperSha256: sha256(await readFile(resolve(root, 'test/compressed-fixtures.js'))),
        fixtures: Object.entries(fixtures).filter(([, fixture]) => fixture.expected).map(([name, fixture]) => ({ name,
            syntax: fixture.metadata.transferSyntax, rows: fixture.metadata.rows, columns: fixture.metadata.columns,
            frames: fixture.expected.length, samplesPerPixel: fixture.metadata.samplesPerPixel,
            bitsStored: fixture.metadata.bitsStored, signed: fixture.metadata.signed, photometric: fixture.metadata.photometric,
            maximumSampleError: fixture.tolerance, part10Sha256: sha256(Buffer.from(fixture.encoded, 'base64')) })),
        reference: 'Generated original rasters; exact lossless values and stated fixture-specific JPEG error bounds; GPU samples from actual WebGL2 draws.' }, null, 2) + '\n');
    console.log(`Compressed browser checks: ${checks.length} passed.`);
} finally { browser?.close(); await rm(qa, { recursive: true, force: true }); }
