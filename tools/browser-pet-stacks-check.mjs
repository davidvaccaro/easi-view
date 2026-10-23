import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createCompressedDicom } from '../test/compressed-fixtures.js';
import { loadFiles } from '../src/data/sources.js';
import { nearestSyncedSlice, compatibleWindow } from '../src/runtime/workspace.js';
import { validateVolumeGeometry } from '../src/volume/geometry.js';
import { Volume } from '../src/volume/Volume.js';
import { browserSession } from './browser-session.mjs';
import { startCorpusServer } from './local-corpus-check.mjs';
import { sourceDigest } from './source-digest.mjs';

// Independent generated JPEG samples only. No original imaging corpus is read.
const root = resolve(import.meta.dirname, '..'), output = resolve(root, 'artifacts/browser-pet-stacks');
const quote = JSON.stringify, fixtures = [], checks = [];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const record = (name, details = {}) => { checks.push({name, ...details}); console.log(`PASS ${name}`); };
const families = [{type: 'WHOLE BODY', slices: 5, count: 5, groups: 1}, {type: 'STATIC', slices: 3, count: 3, groups: 1},
    {type: 'DYNAMIC', slices: 2, count: 4, groups: 2}, {type: 'GATED', slices: 2, count: 8, groups: 4}];
let browser, server, temporary;
const evaluate = expression => browser.evaluate(expression);
const idle = () => browser.until('!window.__v.getState().busy&&!window.__v.getSessionState().busy&&!window.__v.getOpenWorkflowState().busy', 'Generated PET navigation did not settle.');
async function pixels(expected) {
    const observed = await evaluate('({state:window.__v.getState(),workspace:window.__v.getWorkspaceState(),upload:window.__qa.uploads.at(-1),draw:window.__qa.draws.at(-1)})');
    assert.deepEqual(observed.upload.samples, expected); assert.equal(observed.state.image.photometric, 'MONOCHROME2');
    const window = observed.workspace.viewports[0].window;
    for (const [index, value] of expected.entries()) {
        const target = Math.round(Math.max(0, Math.min(1, (value - (window.center - .5)) / (window.width - 1) + .5)) * 255);
        for (const channel of observed.draw.pixels[index].slice(0, 3)) assert.ok(Math.abs(channel - target) <= 2, `GPU value differs at generated sample ${index}`);
        assert.equal(observed.draw.pixels[index][3], 255);
    }
    return observed;
}
try {
    await mkdir(output, {recursive: true}); await rm(resolve(output, 'results.json'), {force: true}); await rm(resolve(output, 'failure.json'), {force: true});
    const build = JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8'));
    assert.equal(await sourceDigest(root), build.sourceDigest, 'Rebuild before qualifying PET navigation.');
    for (const [familyIndex, family] of families.entries()) {
        family.seriesUid = `2.25.996.1.${familyIndex + 1}`; family.fixtures = [];
        for (let ordinal = 0; ordinal < family.count; ordinal++) {
            const phase = Math.floor(ordinal / family.slices), slot = phase % 2 + 1, rr = Math.floor(phase / 2) + 1;
            const referenceTime = familyIndex < 2 ? 1000 + ordinal * 100 : 1000 + (family.type === 'DYNAMIC' ? phase : 0) * 100;
            const samples = Array.from({length: 4}, (_, pixel) => 100 + familyIndex * 1000 + ordinal * 80 + pixel * 20);
            const sopUid = `${family.seriesUid}.${ordinal + 1}`, extraAttributes = {
                '00100010': ['PN', 'SYNTHETIC^PET_STACKS'], '00100020': ['LO', 'SYNTHETIC_PET_STACKS'], '00100021': ['LO', 'SYNTHETIC_TEST'],
                '0020000D': ['UI', '2.25.996.1'], '00200052': ['UI', '2.25.996.1.99'], '00080008': ['CS', ['ORIGINAL', 'PRIMARY']],
                '00081030': ['LO', 'Generated PET navigation'], '0008103E': ['LO', `Generated ${family.type}`],
                '00541000': ['CS', [family.type, 'IMAGE']], '00541001': ['CS', 'BQML'], '00541002': ['CS', 'EMISSION'], '00541102': ['CS', 'START'],
                '00540081': ['US', family.slices], '00541300': ['DS', referenceTime], '00541330': ['US', ordinal + 1], '00280051': ['CS', ['ATTN', 'DECY']],
                '00281050': ['DS', 2500], '00281051': ['DS', 5000]
            };
            if (family.type === 'DYNAMIC') extraAttributes['00540101'] = ['US', 2];
            if (family.type === 'GATED') Object.assign(extraAttributes, {'00540061': ['US', 2], '00540071': ['US', 2], '00181060': ['DS', slot * 50],
                '00181063': ['DS', 50], '00181080': ['CS', 'Y'], '00181081': ['IS', rr * 500], '00181082': ['IS', rr * 500 + 100]});
            const encoded = await createCompressedDicom({codec: 'jpeg-lossless', rows: 2, columns: 2, bitsAllocated: 16, bitsStored: 16, signed: false,
                frameSamples: [samples], modality: 'PT', sopClass: '1.2.840.10008.5.1.4.1.1.128', sopUid, seriesUid: family.seriesUid,
                instanceNumber: ordinal + 1, position: [0, 0, ordinal % family.slices], pixelSpacing: [1, 1], slope: 1, intercept: 0, extraAttributes});
            const fixture = {name: `GENERATED_PET_${familyIndex}_${ordinal}`, bytes: encoded.bytes, familyIndex, ordinal, sopUid, referenceTime, samples};
            fixtures.push(fixture); family.fixtures.push(fixture);
        }
        const sources = await loadFiles(family.fixtures.map(item => new File([item.bytes], item.name)));
        try {
            assert.equal(sources.length, family.groups); assert.equal(sources.reduce((sum, source) => sum + source.frames.length, 0), family.count);
            for (const source of sources) for (const frame of source.frames) assert.equal(frame.classicDimensions.petFrameReferenceTime, family.fixtures.find(item => item.sopUid === frame.sopUid).referenceTime);
            if (familyIndex < 2) {
                assert.equal(nearestSyncedSlice(sources[0].frames[0], [sources[0].frames[1]], 10).matched, false);
                assert.equal(compatibleWindow(sources[0].frames[0], sources[0].frames[1]), false);
                assert.throws(() => validateVolumeGeometry(sources[0].frames)); await assert.rejects(Volume.fromSeries(sources[0]));
            }
        } finally { sources.forEach(source => source.dispose()); }
        record(`${family.type} preserves ${family.count} original PET instances in ${family.groups} navigation stack(s)`);
    }
    record('merged navigation retains literal frame times and strict spatial synchronization, window linking and volume compatibility');
    const originalHashes = fixtures.map(item => sha256(item.bytes));
    temporary = await mkdtemp(join(tmpdir(), 'easi-view-pet-stacks-')); const host = resolve(temporary, 'host'); await mkdir(host); const fixturePaths = []; for (const fixture of fixtures) { const path = resolve(host, fixture.name); await writeFile(path, fixture.bytes); fixturePaths.push(path); }
    await writeFile(resolve(host, 'fixtures.json'), JSON.stringify(fixtures.map(({bytes, ...item}) => ({...item, encoded: Buffer.from(bytes).toString('base64')}))));
    await writeFile(resolve(host, 'index.html'), '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="host.css"><main id="mount"></main><script type="module" src="host.js"></script>');
    await writeFile(resolve(host, 'host.css'), 'body{margin:0;background:#09121b}#mount{height:100dvh;width:100%}');
    await writeFile(resolve(host, 'host.js'), `
import {createViewer} from '/assets/easi-view.js';
window.__fixtures=await(await fetch('./fixtures.json')).json();window.__files=window.__fixtures.map(item=>new File([Uint8Array.from(atob(item.encoded),c=>c.charCodeAt(0))],item.name));
window.__qa={uploads:[],draws:[],jobs:[],workers:{created:0,terminated:0}};
const NativeWorker=window.Worker;window.Worker=class extends NativeWorker{constructor(...args){super(...args);window.__qa.workers.created++;}postMessage(message,...args){if(message.metadata&&message.bytes)window.__qa.jobs.push({syntax:message.metadata.transferSyntax});return super.postMessage(message,...args);}terminate(){if(!this.__qaTerminated){this.__qaTerminated=true;window.__qa.workers.terminated++;}return super.terminate();}};
const upload=WebGL2RenderingContext.prototype.texImage2D,draw=WebGL2RenderingContext.prototype.drawArrays;
WebGL2RenderingContext.prototype.texImage2D=function(...args){if(args[8]?.length===4){this.canvas.__qaSamples=Array.from(args[8]);window.__qa.uploads.push({samples:this.canvas.__qaSamples});}return upload.apply(this,args);};
WebGL2RenderingContext.prototype.drawArrays=function(...args){const result=draw.apply(this,args);if(this.canvas.__qaSamples){const program=this.getParameter(this.CURRENT_PROGRAM),matrix=program&&this.getUniform(program,this.getUniformLocation(program,'imageToClip'));if(matrix){const pixels=[[0,0],[1,0],[0,1],[1,1]].map(([x,y])=>{const a=x+.5,b=y+.5,clipX=matrix[0]*a+matrix[3]*b+matrix[6],clipY=matrix[1]*a+matrix[4]*b+matrix[7],pixel=new Uint8Array(4);this.readPixels(Math.floor((clipX+1)*this.canvas.width/2),Math.floor((clipY+1)*this.canvas.height/2),1,1,this.RGBA,this.UNSIGNED_BYTE,pixel);return Array.from(pixel);});window.__qa.draws.push({pixels});}}return result;};
window.__hashes=async()=>Promise.all(window.__files.map(async file=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer())),value=>value.toString(16).padStart(2,'0')).join('')));
window.__v=createViewer(document.getElementById('mount'),{initialDemo:null});await window.__v.ready;window.__shadow=document.querySelector('easi-view-embed').shadowRoot;window.__ready=true;
`);
    server = await startCorpusServer({dist: resolve(root, 'dist'), host, styleHash: build.inlineStyleSha256}); const origin = new URL(server.url).origin;
    browser = await browserSession(resolve(temporary, 'chrome')); await browser.send('Emulation.setDeviceMetricsOverride', {width: 1540, height: 1050, deviceScaleFactor: 1, mobile: false});
    await browser.send('Page.setInterceptFileChooserDialog', {enabled: true}); await browser.send('Page.navigate', {url: server.url}); await browser.until('window.__ready', 'Generated PET viewer did not mount.');
    await evaluate('window.__v.open("images")'); await evaluate(`window.__shadow.querySelector('[data-open-action="pick-files"]').click()`);
    const input = await browser.send('Runtime.evaluate', {expression: 'window.__shadow.getElementById("file-input")', returnByValue: false});
    await browser.send('DOM.setFileInputFiles', {objectId: input.result.objectId, files: fixturePaths}); await idle();
    await evaluate(`window.__shadow.querySelector('[data-open-action="add"]').click()`); await idle();
    assert.equal(await evaluate('window.__v.getSessionCatalog().counts.series'), 4);
    for (const [familyIndex, family] of families.entries()) {
        await evaluate(`(()=>{window.__target=window.__v.getSessionCatalog().patients.flatMap(p=>p.studies.flatMap(s=>s.series)).find(s=>s.seriesUid===${quote(family.seriesUid)});window.__shadow.querySelector('.session-library-series[data-series-id="'+CSS.escape(window.__target.id)+'"] [data-session-series-select]').click();})()`); await idle();
        assert.equal(await evaluate('window.__v.getSessionCatalog().patients.flatMap(p=>p.studies.flatMap(s=>s.series)).find(s=>s.id===window.__target.id).stackGroups.length'), family.groups);
        if (familyIndex < 2) {
            for (const index of [0, Math.floor(family.count / 2), family.count - 1]) {
                await evaluate(`window.__v.setFrame(${index})`); await idle(); const observed = await pixels(family.fixtures[index].samples); assert.equal(observed.state.frameCount, family.count); assert.equal(observed.state.frameIndex, index);
                const identity = await evaluate('(()=>{const a=window.__v.addAnnotation({tool:"length",points:[{x:.5,y:.5},{x:1.5,y:.5}]});window.__v.removeAnnotation(a.id);return a.image;})()');
                assert.equal(identity.sopUid, family.fixtures[index].sopUid); assert.equal(identity.frameNumber, 1);
                await evaluate('window.__shadow.getElementById("inspector-tab-attributes").click()');
                await evaluate('(()=>{const i=window.__shadow.getElementById("attributes-search");i.value="00541300";i.dispatchEvent(new Event("input",{bubbles:true}));})()');
                assert.equal(await evaluate('window.__shadow.querySelector(".attributes-table tbody .attributes-value").textContent.trim()'), String(family.fixtures[index].referenceTime));
                await evaluate('window.__shadow.getElementById("inspector-tab-details").click()');
            }
            const rejected = await evaluate('(async()=>{try{await window.__v.openReconstruction();return false;}catch{return true;}})()'); assert.equal(rejected, true); assert.equal(await evaluate('window.__v.getState().frameIndex'), family.count - 1);
        } else {
            for (let stackIndex = 0; stackIndex < family.groups; stackIndex++) {
                await evaluate(`window.__shadow.querySelector('.session-library-series[data-series-id="'+CSS.escape(window.__target.id)+'"] [data-session-action="open-group"][data-stack-index="${stackIndex}"]').click()`); await idle();
                const observed = await pixels(family.fixtures[stackIndex * family.slices].samples); assert.equal(observed.state.frameCount, family.slices);
            }
        }
        record(`native ${family.type} series selection uses correct logical stacks, decoded samples and GPU pixels`, {groups: family.groups, frames: family.count});
    }
    assert.deepEqual(await evaluate('window.__hashes()'), originalHashes);
    const final = await evaluate('(async()=>{const performance=window.__v.getPerformance(),jobs=window.__qa.jobs;window.__v.dispose();await window.__v.whenDisposed();return{before:performance.resources,resources:window.__v.getPerformance().resources,workers:window.__qa.workers,jobs};})()');
    assert.ok(final.before.workerCount > 0); assert.ok(final.jobs.length >= 10); assert.ok(final.jobs.every(job => job.syntax === '1.2.840.10008.1.2.4.70'));
    for (const key of ['workerCount', 'encodedBytes', 'decodedCacheBytes']) assert.equal(final.resources[key], 0); assert.equal(final.workers.created, final.workers.terminated);
    assert.equal(browser.errors.length, 0, JSON.stringify(browser.errors)); assert.equal(browser.consoleErrors.length, 0, JSON.stringify(browser.consoleErrors));
    assert.equal(browser.requests.filter(request => !['GET', 'HEAD'].includes(request.method)).length, 0);
    assert.equal(browser.requests.filter(request => !request.url.startsWith(origin) && !request.url.startsWith('data:') && !request.url.startsWith('blob:')).length, 0);
    assert.equal(await sourceDigest(root), build.sourceDigest); record('real worker decode and disposal preserve generated source bytes with no uploads, external requests or browser errors', {workerJobs: final.jobs.length, workers: final.workers});
    await writeFile(resolve(output, 'results.json'), JSON.stringify({passed: checks.length, checks, sourceDigest: build.sourceDigest, harnessSha256: sha256(await readFile(import.meta.filename)), originalImagingFilesUsed: false, uploads: 0, externalRequests: 0, browserExceptions: 0, consoleErrors: 0}, null, 2) + '\n');
    console.log(`PET navigation browser checks: ${checks.length} passed.`);
} catch (error) {
    await writeFile(resolve(output, 'failure.json'), JSON.stringify({checks, error: {name: error.name, message: error.message, stack: error.stack}, browserExceptions: browser?.errors ?? [], consoleErrors: browser?.consoleErrors ?? []}, null, 2) + '\n'); throw error;
} finally { browser?.close(); await server?.close(); if (temporary) await rm(temporary, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}); }
