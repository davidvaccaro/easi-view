import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createCompressedDicom, createEncapsulatedDicom } from '../test/compressed-fixtures.js';
import { createJpegAlignmentFixture } from '../test/jpeg-alignment-fixtures.js';
import { createDicomFixture } from '../src/data/synthetic.js';
import { loadFiles } from '../src/data/sources.js';
import { browserSession } from './browser-session.mjs';
import { startCorpusServer } from './local-corpus-check.mjs';
import { sourceDigest } from './source-digest.mjs';

// Generated rasters and codestreams only. Classic PET remains one frame per SOP
// instance; the viewer assembles these four valid instances into one PT stack.
const root = resolve(import.meta.dirname, '..'), output = resolve(root, 'artifacts/browser-pet-padding');
const quote = JSON.stringify, checks = [], fixtures = {}, petExpected = [];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const concat = parts => {const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));let offset = 0;for (const part of parts) {result.set(part, offset);offset += part.length;}return result;};
const record = (name, details = {}) => {checks.push({name, ...details});console.log(`PASS ${name}`);};
function oddJpeg(frame) {
    assert.deepEqual(Array.from(frame.slice(0, 2)), [255, 216]);assert.deepEqual(Array.from(frame.slice(-2)), [255, 217]);
    // A legal one-character COM segment adds five bytes without changing pixels.
    return frame.length % 2 ? frame : concat([frame.slice(0, 2), new Uint8Array([255, 254, 0, 3, 66]), frame.slice(2)]);
}
const petOptions = index => ({rows: 8, columns: 8, bitsAllocated: 16, bitsStored: 16, signed: false,
    transferSyntax: '1.2.840.10008.1.2.4.70', modality: 'PT', sopClass: '1.2.840.10008.5.1.4.1.1.128',
    sopUid: `2.25.994.1.1.${index + 1}`, seriesUid: '2.25.994.1.1', instanceNumber: index + 1,
    position: [0, 0, index], pixelSpacing: [1, 1], window: {center: 1024, width: 2048}, extraAttributes: {
        '0020000D': ['UI', '2.25.994.1'], '00200052': ['UI', '2.25.994.1.99'], '00100010': ['PN', 'SYNTHETIC^PET_PADDING'],
        '00100020': ['LO', 'SYNTHETIC_PET_PADDING'], '00541000': ['CS', ['STATIC', 'IMAGE']], '00541001': ['CS', 'BQML'],
        '00541002': ['CS', 'EMISSION'], '00541102': ['CS', 'START'], '00540081': ['US', 4], '00541300': ['DS', 1000],
        '00541330': ['US', index + 1], '00280051': ['CS', ['ATTN', 'DECY']]
    }});
let browser, server, temporary;
const evaluate = expression => browser.evaluate(expression);
const idle = () => browser.until('!window.__v.getState().busy', 'The generated image did not finish opening.');
const screenshot = async name => {await browser.screenshot(name);await copyFile(resolve(temporary, 'chrome', `${name}.png`), resolve(output, `${name}.png`));};
const state = () => evaluate('({view:window.__v.getState(),workspace:window.__v.getWorkspaceState(),performance:window.__v.getPerformance(),upload:window.__qa.uploads.at(-1),draw:window.__qa.draws.at(-1),jobs:window.__qa.jobs,workers:window.__qa.workers})');
async function verifyCompatibilityNotice(warnings) {
    const observation = await evaluate(`(()=>{
        const root=window.__shadow,button=root.querySelector('.image-notice-button'),notice=root.querySelector('.image-notice-popover');
        const canvas=root.querySelector('.workspace-pane.active .viewport-canvas')||root.querySelector('.viewport-canvas');
        const bounds=()=>{const rect=canvas.getBoundingClientRect();return[rect.x,rect.y,rect.width,rect.height];},before=bounds();
        button.click();const group=notice.querySelector('[data-notice-group="encoding"]');
        const result={disabled:button.disabled,unread:button.dataset.unread,opened:!notice.hidden,
            messages:group?[...group.querySelectorAll('.image-notice-message')].map(node=>node.textContent):[],
            inlineNotice:!!root.getElementById('geometry-notice')||!!root.getElementById('detail-geometry-notice')};
        notice.querySelector('.image-notice-close').click();result.closed=notice.hidden;
        result.viewportUnchanged=before.every((value,index)=>Math.abs(value-bounds()[index])<0.5);return result;
    })()`);
    assert.equal(observation.disabled, false);assert.equal(observation.unread, 'true');assert.equal(observation.opened, true);assert.equal(observation.closed, true);
    assert.equal(observation.inlineNotice, false);assert.equal(observation.viewportUnchanged, true);
    for (const warning of warnings) assert.ok(observation.messages.includes(warning));
    return observation;
}

async function verifyPixels(expected, {color = false, rows = 8, columns = 8} = {}) {
    const observed = await state();assert.deepEqual(observed.upload.samples, expected);assert.equal(observed.draw.pixels.length, 4);
    const locations = [[Math.floor(columns / 4), Math.floor(rows / 4)], [Math.floor(columns * 3 / 4), Math.floor(rows / 4)], [Math.floor(columns / 4), Math.floor(rows * 3 / 4)], [Math.floor(columns * 3 / 4), Math.floor(rows * 3 / 4)]];
    for (const [index, [x, y]] of locations.entries()) {
        const pixel = observed.draw.pixels[index], window = observed.workspace.viewports[0].window;
        for (let channel = 0; channel < 3; channel++) {
            const value = expected[(y * columns + x) * (color ? 3 : 1) + (color ? channel : 0)];
            const target = color ? value : Math.round(Math.max(0, Math.min(1, (value - (window.center - .5)) / (window.width - 1) + .5)) * 255);
            assert.ok(Math.abs(pixel[channel] - target) <= 2, JSON.stringify({index, channel, target, actual: pixel[channel]}));
        }
        assert.equal(pixel[3], 255);
    }
    return observed;
}

try {
    await mkdir(output, {recursive: true});await rm(resolve(output, 'results.json'), {force: true});await rm(resolve(output, 'failure.json'), {force: true});
    const build = JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8'));assert.equal(build.sourceDigest, await sourceDigest(root), 'Rebuild before PET alignment qualification.');
    let firstOdd;
    for (let frame = 0; frame < 4; frame++) {
        const values = Array.from({length: 64}, (_, index) => 31 + frame * 90 + index * 17);petExpected.push(values);
        const encoded = await createCompressedDicom({codec: 'jpeg-lossless', rows: 8, columns: 8, bitsAllocated: 16, frameSamples: [values]});
        const odd = oddJpeg(encoded.frames[0]);assert.equal(odd.length % 2, 1);firstOdd ??= odd;
        const bytes = createEncapsulatedDicom([concat([odd, new Uint8Array([0x31])])], petOptions(frame));
        fixtures[`pet-${frame}`] = {name: `GENERATED_PT_${frame + 1}`, bytes, frame, codestreamBytes: odd.length, padByte: 0x31, expected: values};
    }
    for (const [label, suffix] of [['multiple trailing bytes', new Uint8Array([0x31, 0x32, 0x33])], ['second codestream', firstOdd]]) {
        const bytes = createEncapsulatedDicom([concat([firstOdd, suffix])], petOptions(0));await assert.rejects(loadFiles([new File([bytes], 'GENERATED_INVALID_BOUNDARY')]), /extra data|JPEG|encapsulated/iu);
        record(`the shared image pipeline rejects ${label} after the verified JPEG end marker`);
    }
    const precisionExpected = [[0, 4095, 4096, 65535], [8192, 16384, 32768, 65535]];
    const precision = await createJpegAlignmentFixture({rows: 2, columns: 2, bitsAllocated: 16, bitsStored: 16,
        frameSamples: precisionExpected, metadataOverrides: {bitsStored: 12, highBit: 11}, modality: 'OT',
        sopClass: '1.2.840.10008.5.1.4.1.1.7.3', sopUid: '2.25.994.3.1.1', seriesUid: '2.25.994.3.1',
        extraAttributes: {'0020000D': ['UI', '2.25.994.3'], '00281050': ['DS', 32768], '00281051': ['DS', 65536]}}, 0x31);
    fixtures.precision = {name: 'GENERATED_SV1_DECLARED12_CODED16', bytes: precision.bytes, expected: precisionExpected};
    const precisionSources = await loadFiles([new File([precision.bytes], 'GENERATED_PRECISION_REFERENCE')]);
    try {for (let index = 0; index < 2; index++) {const frame = await precisionSources[0].getFrame(index);assert.equal(frame.bitsStored, 16);assert.equal(frame.highBit, 15);assert.deepEqual(Array.from(frame.samples), precisionExpected[index]);}}
    finally {precisionSources.forEach(source => source.dispose());}
    record('the shared pipeline preserves coded 16-bit unsigned samples and effective frame precision for the exact declared-12 compatibility case');
    const rgbExpected = [[255, 0, 0, 0, 255, 0, 0, 0, 255, 17, 73, 201], [11, 22, 33, 45, 67, 89, 101, 123, 145, 203, 219, 237], [83, 41, 197, 251, 119, 13, 21, 168, 231, 91, 121, 151]];
    fixtures.rgb = {name: 'GENERATED_MULTIFRAME_TRUE_COLOR_SC', expected: rgbExpected, bytes: createDicomFixture({rows: 2, columns: 2, frames: 3, bitsAllocated: 8, bitsStored: 8, photometric: 'RGB', modality: 'OT', sopClass: '1.2.840.10008.5.1.4.1.1.7.4', sopUid: '2.25.994.2.1.1', seriesUid: '2.25.994.2.1', rawPixelBytes: new Uint8Array(rgbExpected.flat()), frameTime: 80, extraAttributes: {'0020000D': ['UI', '2.25.994.2'], '00280002': ['US', 3], '00280006': ['US', 0], '00281050': null, '00281051': null, '00281052': null, '00281053': null, '00281054': null, '00281056': null}})};
    const originalHashes = Object.fromEntries(Object.entries(fixtures).map(([key, item]) => [key, sha256(item.bytes)]));
    temporary = await mkdtemp(join(tmpdir(), 'easi-view-pet-padding-browser-'));const host = resolve(temporary, 'host');await mkdir(host);
    await writeFile(resolve(host, 'fixtures.json'), JSON.stringify(Object.fromEntries(Object.entries(fixtures).map(([key, {bytes, ...item}]) => [key, {...item, encoded: Buffer.from(bytes).toString('base64')}]))));
    await writeFile(resolve(host, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./host.css"></head><body><main id="mount"></main><script type="module" src="./host.js"></script></body></html>');
    await writeFile(resolve(host, 'host.css'), 'body{margin:0;background:#09121b}#mount{height:100dvh;width:100%}');
    await writeFile(resolve(host, 'host.js'), `
import {createViewer} from '/assets/easi-view.js';
const fixtures=await(await fetch('./fixtures.json')).json();window.__files=Object.fromEntries(Object.entries(fixtures).map(([key,item])=>[key,new File([Uint8Array.from(atob(item.encoded),c=>c.charCodeAt(0))],item.name)]));
window.__qa={uploads:[],draws:[],jobs:[],responses:[],workers:{created:0,terminated:0}};
const NativeWorker=window.Worker;window.Worker=class extends NativeWorker{constructor(...args){super(...args);window.__qa.workers.created++;this.addEventListener('message',event=>{if(event.data.samples)window.__qa.responses.push({bitsStored:event.data.bitsStored,highBit:event.data.highBit,warnings:event.data.encodingWarnings});});}postMessage(message,...args){if(message.metadata&&message.bytes)window.__qa.jobs.push({syntax:message.metadata.transferSyntax,rows:message.metadata.rows,columns:message.metadata.columns,bitsStored:message.metadata.bitsStored,highBit:message.metadata.highBit,byteLength:message.bytes.byteLength});return super.postMessage(message,...args);}terminate(){if(!this.__qaTerminated){this.__qaTerminated=true;window.__qa.workers.terminated++;}return super.terminate();}};
const upload=WebGL2RenderingContext.prototype.texImage2D,draw=WebGL2RenderingContext.prototype.drawArrays;
WebGL2RenderingContext.prototype.texImage2D=function(...args){if(args[8]?.length&&[4,12,64].includes(args[8].length)){this.canvas.__qaSamples=Array.from(args[8]);this.canvas.__qaRows=args[4];this.canvas.__qaColumns=args[3];window.__qa.uploads.push({samples:this.canvas.__qaSamples,rows:args[4],columns:args[3]});}return upload.apply(this,args);};
WebGL2RenderingContext.prototype.drawArrays=function(...args){const result=draw.apply(this,args);if(this.canvas.__qaSamples){const program=this.getParameter(this.CURRENT_PROGRAM),matrix=program&&this.getUniform(program,this.getUniformLocation(program,'imageToClip'));if(matrix){const rows=this.canvas.__qaRows,columns=this.canvas.__qaColumns,locations=[[Math.floor(columns/4),Math.floor(rows/4)],[Math.floor(columns*3/4),Math.floor(rows/4)],[Math.floor(columns/4),Math.floor(rows*3/4)],[Math.floor(columns*3/4),Math.floor(rows*3/4)]],points=[],rect=this.canvas.getBoundingClientRect(),pixels=locations.map(([x,y])=>{const a=x+.5,b=y+.5,clipX=matrix[0]*a+matrix[3]*b+matrix[6],clipY=matrix[1]*a+matrix[4]*b+matrix[7],pixel=new Uint8Array(4);points.push({x:rect.left+(clipX+1)*rect.width/2,y:rect.top+(1-clipY)*rect.height/2});this.readPixels(Math.floor((clipX+1)*this.canvas.width/2),Math.floor((clipY+1)*this.canvas.height/2),1,1,this.RGBA,this.UNSIGNED_BYTE,pixel);return Array.from(pixel);});window.__qa.draws.push({pixels,points});}}return result;};
window.__hashes=async()=>Object.fromEntries(await Promise.all(Object.entries(window.__files).map(async([key,file])=>{const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()));return[key,Array.from(digest,value=>value.toString(16).padStart(2,'0')).join('')];})));
window.__v=createViewer(document.getElementById('mount'),{initialDemo:null});await window.__v.ready;window.__shadow=document.querySelector('easi-view-embed').shadowRoot;window.__ready=true;
`);
    server = await startCorpusServer({dist: resolve(root, 'dist'), host, styleHash: build.inlineStyleSha256});const origin = new URL(server.url).origin;
    browser = await browserSession(resolve(temporary, 'chrome'));await browser.send('Emulation.setDeviceMetricsOverride', {width: 1540, height: 1050, deviceScaleFactor: 1, mobile: false});await browser.send('Page.navigate', {url: server.url});await browser.until('window.__ready', 'The generated PET host did not mount.');
    assert.deepEqual(await evaluate('window.__hashes()'), originalHashes);
    await evaluate('window.__v.openFiles([0,1,2,3].map(index=>window.__files["pet-"+index]))');await idle();let observed = await verifyPixels(petExpected[0]);assert.equal(observed.view.modality, 'PT');assert.equal(observed.view.frameCount, 4);assert.ok(observed.jobs.some(job => job.syntax === '1.2.840.10008.1.2.4.70'));assert.ok(observed.performance.resources.workerCount > 0);
    assert.ok(observed.view.image.encodingWarnings.some(message => /nonstandard single JPEG alignment byte.*Original DICOM bytes are unchanged/u.test(message)));await verifyCompatibilityNotice(observed.view.image.encodingWarnings);
    record('generated PET SV1 instances decode in real workers and render exact stored samples with an on-demand compatibility notice and unchanged viewport', {workerJobs: observed.jobs.length, gpu: observed.draw.pixels});
    for (const frame of [1, 2, 3, 0]) {await evaluate(`window.__v.setFrame(${frame})`);await verifyPixels(petExpected[frame]);}
    await evaluate('window.__v.play()');await browser.until('window.__v.getState().frameIndex!==0', 'PET stack playback did not advance.');await evaluate('window.__v.pause()');await evaluate('window.__v.setFrame(2)');observed = await verifyPixels(petExpected[2]);assert.ok(observed.jobs.filter(job => job.syntax === '1.2.840.10008.1.2.4.70').length >= 4);assert.deepEqual(await evaluate('window.__hashes()'), originalHashes);await screenshot('generated-pet-alignment-notice');
    record('PET stack frame navigation and playback preserve exact samples, source hashes and the validated four-image series boundary');
    await evaluate('window.__v.openFiles([window.__files.precision])');await idle();observed = await verifyPixels(precisionExpected[0], {rows: 2, columns: 2});
    const response = await evaluate('window.__qa.responses.at(-1)');assert.equal(response.bitsStored, 16);assert.equal(response.highBit, 15);assert.equal(observed.jobs.at(-1).bitsStored, 12);assert.equal(observed.jobs.at(-1).highBit, 11);
    assert.ok(observed.view.image.encodingWarnings.some(message => /alignment byte/u.test(message)));assert.ok(observed.view.image.encodingWarnings.some(message => /precision|12-bit|Bits Stored/iu.test(message)));await verifyCompatibilityNotice(observed.view.image.encodingWarnings);
    await evaluate('window.__v.setTool("probe")');
    for (const [index, expected] of precisionExpected[0].entries()) {const point = observed.draw.points[index];await browser.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0});const text = await evaluate('window.__shadow.getElementById("probe-stored").textContent');assert.equal(Number(text.replace(/^Stored:\s*/u, '').replaceAll(',', '').trim()), expected);}
    await evaluate('window.__v.setFrame(1)');await verifyPixels(precisionExpected[1], {rows: 2, columns: 2});
    record('real worker decode, GPU shading and pixel probes preserve values above 4095 with effective 16/15 precision and combined compatibility notices', {declared: {bitsStored: 12, highBit: 11}, effective: {bitsStored: response.bitsStored, highBit: response.highBit}, samples: precisionExpected});
    await evaluate('window.__shadow.getElementById("inspector-tab-attributes").click()');
    for (const [tag, expected] of [['00280101', '12'], ['00280102', '11']]) {await evaluate(`(()=>{const input=window.__shadow.getElementById('attributes-search');input.value=${quote(tag)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);assert.equal(await evaluate('window.__shadow.querySelector(".attributes-table tbody .attributes-value").textContent.trim()'), expected);}
    await evaluate('(()=>{const input=window.__shadow.getElementById("attributes-search");input.value="0028010";input.dispatchEvent(new Event("input",{bubbles:true}));})()');
    await screenshot('generated-jpeg-precision-original-attributes');assert.deepEqual(await evaluate('window.__hashes()'), originalHashes);await evaluate('window.__shadow.getElementById("inspector-tab-details").click()');
    record('the Attributes inspector retains original declared Bits Stored 12 and High Bit 11 while source files remain byte-identical');
    await evaluate('window.__v.openFiles([window.__files.rgb])');await idle();observed = await verifyPixels(rgbExpected[0], {color: true, rows: 2, columns: 2});assert.equal(observed.view.image.photometric, 'RGB');assert.equal(observed.view.frameCount, 3);
    for (const frame of [1, 2]) {await evaluate(`window.__v.setFrame(${frame})`);await verifyPixels(rgbExpected[frame], {color: true, rows: 2, columns: 2});}
    await evaluate('window.__v.play()');await browser.until('window.__v.getState().frameIndex!==2', 'True Color SC playback did not advance.');await evaluate('window.__v.pause()');await evaluate('window.__v.setFrame(1)');await verifyPixels(rgbExpected[1], {color: true, rows: 2, columns: 2});await screenshot('generated-multiframe-true-color-sc');
    record('Multi-frame True Color Secondary Capture .7.4 renders original RGB channels and supports frame selection and playback');
    assert.deepEqual(await evaluate('window.__hashes()'), originalHashes);const final = await evaluate('(async()=>{window.__v.dispose();await window.__v.whenDisposed();return{resources:window.__v.getPerformance().resources,workers:window.__qa.workers,jobs:window.__qa.jobs.length};})()');assert.equal(final.resources.workerCount, 0);assert.equal(final.resources.encodedBytes, 0);assert.equal(final.resources.decodedCacheBytes, 0);assert.equal(final.workers.created, final.workers.terminated);
    assert.equal(browser.errors.length, 0, JSON.stringify(browser.errors));assert.equal(browser.consoleErrors.length, 0, JSON.stringify(browser.consoleErrors));assert.equal(browser.requests.filter(request => !['GET', 'HEAD'].includes(request.method)).length, 0);assert.equal(browser.requests.filter(request => !request.url.startsWith(origin) && !request.url.startsWith('data:') && !request.url.startsWith('blob:')).length, 0);assert.equal(await sourceDigest(root), build.sourceDigest);assert.equal(JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8')).sourceDigest, build.sourceDigest);
    record('qualification keeps generated source bytes unchanged, disposes workers and buffers, and makes no uploads or external requests', {workerJobs: final.jobs, workers: final.workers});
    await writeFile(resolve(output, 'results.json'), JSON.stringify({passed: checks.length, checks, sourceDigest: build.sourceDigest, harnessSha256: sha256(await readFile(import.meta.filename)), originalImagingFilesUsed: false, sourceHashes: originalHashes, uploads: 0, externalRequests: 0, browserExceptions: 0, consoleErrors: 0}, null, 2) + '\n');console.log(`PET alignment browser checks: ${checks.length} passed.`);
} catch (error) {if (browser) await screenshot('failure').catch(() => {});await writeFile(resolve(output, 'failure.json'), JSON.stringify({checks, error: {name: error.name, message: error.message, stack: error.stack}, browserExceptions: browser?.errors ?? [], consoleErrors: browser?.consoleErrors ?? []}, null, 2) + '\n');throw error;}
finally {browser?.close();await server?.close();if (temporary) await rm(temporary, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});}
