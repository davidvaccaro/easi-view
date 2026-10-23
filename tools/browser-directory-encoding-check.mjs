import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createDicomFixture } from '../src/data/synthetic.js';
import { createDicomdirFixture } from '../test/dicomdir-fixtures.js';
import { browserSession } from './browser-session.mjs';
import { startCorpusServer } from './local-corpus-check.mjs';
import { sourceDigest } from './source-digest.mjs';

// Every image, text byte and filesystem reference below is generated. Nothing
// discovers, reads, serves, copies or captures any original local medical data.
const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'artifacts/browser-directory-encoding');
const uid = '2.25.996.88', patientId = 'ENCODING_TEST';
const invalidDescription = new Uint8Array([66, 65, 68, 32, 0xb0]);
const latinDescription = new Uint8Array([76, 97, 116, 105, 110, 32, 0xb0]);
const imageFiles = [1, 2].flatMap(series => [1, 2].map(instance => {
    const base = series === 1 ? 100 + (instance - 1) * 10 : 300 + (instance - 1) * 10;
    const values = [base, base + 10, base + 20, base + 30], name = `IM${series}${instance}`;
    return {key: name, name, path: `SYNTHETIC_MEDIA/IMAGES/${name}`, values,
        bytes: createDicomFixture({rows: 2, columns: 2, values, sopUid: `${uid}.${series}.${instance}`, seriesUid: `${uid}.${series}`,
            description: series === 1 ? 'Generated first series' : 'Generated second series', instanceNumber: instance,
            position: [0, 0, instance - 1], pixelSpacing: [1, 1], window: {center: 512, width: 1024}, extraAttributes: {
                '0020000D': ['UI', uid], '00200011': ['IS', series], '00200052': ['UI', `${uid}.99`],
                '00100010': ['PN', 'SYNTHETIC^ENCODING'], '00100020': ['LO', patientId], '00100021': ['LO', 'SYNTHETIC_ENCODING'],
                '00081030': ['LO', 'Generated encoding examination']
            }})};
}));
function media({badStudy = false, badSeries = false, badIdentity = false} = {}) {
    const records = [{type: 'PATIENT', patientName: 'SYNTHETIC^ENCODING', patientId: badIdentity ? invalidDescription : patientId,
        children: [{type: 'STUDY', studyUid: uid, studyDescription: badStudy ? invalidDescription : 'Generated media examination',
            children: [1, 2].map(series => ({type: 'SERIES', seriesUid: `${uid}.${series}`, modality: 'CT', seriesNumber: series,
                attributes: series === 1 ? {'00080005': ['CS', 'ISO_IR 100'], '0008103E': ['LO', latinDescription]}
                    : {'0008103E': ['LO', badSeries ? invalidDescription : 'Valid second description']},
                children: [1, 2].map(instance => ({type: 'IMAGE', fileId: ['IMAGES', `IM${series}${instance}`], sopUid: `${uid}.${series}.${instance}`, instanceNumber: instance}))}))}]}];
    return [{key: 'directory', name: 'DICOMDIR', path: 'SYNTHETIC_MEDIA/DICOMDIR', bytes: createDicomdirFixture(records)}, ...imageFiles];
}
const baseline = {key: 'baseline', name: 'GENERATED_BASELINE', bytes: createDicomFixture({rows: 2, columns: 2, values: [700, 710, 720, 730],
    sopUid: '2.25.996.90.1.1', seriesUid: '2.25.996.90.1', window: {center: 512, width: 1024}, extraAttributes: {'0020000D': ['UI', '2.25.996.90']}})};
const collections = {series: media({badSeries: true}), study: media({badStudy: true}), combined: media({badStudy: true, badSeries: true}), identity: media({badSeries: true, badIdentity: true}), baseline: [baseline]};
const quote = JSON.stringify, checks = [];
let browser, server, temporary;
const evaluate = value => browser.evaluate(value);
const click = selector => evaluate(`(()=>{const node=window.__shadow.querySelector(${quote(selector)});if(!node)throw new Error('Missing generated media control: '+${quote(selector)});node.focus();node.click();})()`);
const idle = () => browser.until('!window.__v.getState().busy&&!window.__v.getSessionState().busy&&!window.__v.getOpenWorkflowState().busy', 'The generated media operation did not finish.');
const state = () => evaluate('({view:window.__v.getState(),workspace:window.__v.getWorkspaceState(),catalog:window.__v.getSessionCatalog(),annotations:window.__v.getAnnotationState(),performance:window.__v.getPerformance(),uploads:window.__qa.uploads})');
const record = (name, details = {}) => {checks.push({name, ...details});console.log(`PASS ${name}`);};
const screenshot = async name => {await browser.screenshot(name);await copyFile(resolve(temporary, 'chrome', `${name}.png`), resolve(output, `${name}.png`));};
const preview = async collection => {
    await evaluate('window.__v.open("study")');await click('[data-open-action="pick-study-folder"]');
    await evaluate(`(()=>{const input=window.__shadow.getElementById('folder-input'),transfer=new DataTransfer();window.__files(${quote(collection)}).forEach(file=>transfer.items.add(file));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);await idle();
};
const notice = () => evaluate('({text:window.__shadow.querySelector(".open-workflow-warnings")?.textContent,error:window.__v.getOpenWorkflowState().error,step:window.__v.getOpenWorkflowState().step,patients:window.__v.getOpenWorkflowState().patientCount,studies:window.__shadow.querySelectorAll("[data-open-study]").length})');
const assertWarning = async () => {const current = await notice();assert.equal(current.error, '');assert.equal(current.step, 'local-studies');assert.equal(current.patients, 1);assert.equal(current.studies, 1);assert.match(current.text, /optional study or series description.*invalid text encoding.*omitted/u);};

try {
    await mkdir(output, {recursive: true});await rm(resolve(output, 'results.json'), {force: true});await rm(resolve(output, 'failure.json'), {force: true});
    const build = JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8'));assert.equal(build.sourceDigest, await sourceDigest(root), 'Rebuild before malformed-description qualification.');
    temporary = await mkdtemp(join(tmpdir(), 'easi-view-directory-encoding-browser-'));const host = resolve(temporary, 'host');await mkdir(host);
    await writeFile(resolve(host, 'fixtures.json'), JSON.stringify(Object.fromEntries(Object.entries(collections).map(([name, files]) => [name, files.map(({bytes, ...data}) => ({...data, encoded: Buffer.from(bytes).toString('base64')}))]))));
    await writeFile(resolve(host, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./host.css"></head><body><main id="mount"></main><script type="module" src="./host.js"></script></body></html>');
    await writeFile(resolve(host, 'host.css'), 'body{margin:0;background:#09121b}#mount{height:100dvh;width:100%}');
    await writeFile(resolve(host, 'host.js'), `
import {createViewer} from '/assets/easi-view.js';
const media=await(await fetch('./fixtures.json')).json();window.__qa={uploads:[],draws:[]};
const upload=WebGL2RenderingContext.prototype.texImage2D,draw=WebGL2RenderingContext.prototype.drawArrays;
WebGL2RenderingContext.prototype.texImage2D=function(...args){if(args[3]===2&&args[4]===2&&args[8]?.length===4)window.__qa.uploads.push(Array.from(args[8]));return upload.apply(this,args);};
WebGL2RenderingContext.prototype.drawArrays=function(...args){const result=draw.apply(this,args),pixel=new Uint8Array(4);this.readPixels(Math.floor(this.canvas.width/2),Math.floor(this.canvas.height/2),1,1,this.RGBA,this.UNSIGNED_BYTE,pixel);window.__qa.draws.push(Array.from(pixel));return result;};
window.__files=name=>media[name].map(item=>{const file=new File([Uint8Array.from(atob(item.encoded),c=>c.charCodeAt(0))],item.name);if(item.path)Object.defineProperty(file,'webkitRelativePath',{value:item.path});return file;});
window.__v=createViewer(document.getElementById('mount'),{initialDemo:null});await window.__v.ready;window.__shadow=document.querySelector('easi-view-embed').shadowRoot;window.__ready=true;
`);
    server = await startCorpusServer({dist: resolve(root, 'dist'), host, styleHash: build.inlineStyleSha256});const origin = new URL(server.url).origin;
    browser = await browserSession(resolve(temporary, 'chrome'));await browser.send('Emulation.setDeviceMetricsOverride', {width: 1540, height: 1050, deviceScaleFactor: 1, mobile: false});await browser.send('Page.setInterceptFileChooserDialog', {enabled: true});await browser.send('Page.navigate', {url: server.url});await browser.until('window.__ready', 'The generated directory host did not mount.');
    await evaluate('window.__v.openFiles(window.__files("baseline"))');await evaluate('window.__v.addAnnotation({tool:"length",points:[{x:.5,y:.5},{x:1.5,y:.5}]})');const original = await state();assert.deepEqual(original.uploads.at(-1), [700, 710, 720, 730]);
    await preview('series');await assertWarning();let observed = await state();assert.equal(observed.catalog.counts.patients, 0);assert.equal(observed.uploads.length, original.uploads.length);assert.equal(observed.performance.resources.workerCount, original.performance.resources.workerCount);
    record('a malformed undeclared series description after a Latin-1 sibling previews normally with an explicit omission notice and no image decoding');
    await click('[data-open-action="close"]');observed = await state();assert.deepEqual(observed.workspace.viewports, original.workspace.viewports);assert.equal(observed.annotations.count, 1);assert.deepEqual(observed.uploads.at(-1), [700, 710, 720, 730]);assert.equal(observed.catalog.counts.patients, 0);
    record('Cancel preserves the previous rendered workspace and measurement after a recovered DICOMDIR preview');
    await preview('study');await assertWarning();await click('[data-open-action="close"]');record('malformed optional study-description bytes are also omitted with a visible notice');
    await preview('combined');await assertWarning();await click('.open-workflow-warnings summary');
    for (const [name, width, height] of [['desktop', 1540, 1050], ['narrow', 430, 930]]) {
        await browser.send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: width < 600});
        const bounds = await evaluate('(()=>{const node=window.__shadow.querySelector(".open-workflow"),box=node.getBoundingClientRect();return{left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:innerWidth,height:innerHeight,scrollWidth:node.scrollWidth,clientWidth:node.clientWidth};})()');
        assert.ok(bounds.left >= 0 && bounds.right <= width + 1 && bounds.top >= 0 && bounds.bottom <= height + 1);assert.ok(bounds.scrollWidth <= bounds.clientWidth + 1);
        await screenshot(`directory-description-warning-${name}`);
    }
    record('the recoverable description notice remains readable on desktop and narrow study-selection dialogs');
    await browser.send('Emulation.setDeviceMetricsOverride', {width: 1540, height: 1050, deviceScaleFactor: 1, mobile: false});await click('[data-open-study]');await click('[data-open-action="add"]');await idle();observed = await state();
    assert.deepEqual(observed.catalog.counts, {patients: 1, studies: 1, series: 2, instances: 4, frames: 4});assert.deepEqual(observed.uploads.at(-1), [100, 110, 120, 130]);assert.equal(observed.view.frameCount, 2);
    const firstRender = await evaluate('window.__qa.draws.at(-1)');assert.equal(firstRender[3], 255);assert.ok(firstRender[0] >= 20 && firstRender[0] <= 40);
    record('committing the recovered media admits exactly one patient and two series and renders the first independent image samples', {firstSamples: [100, 110, 120, 130], renderedCenterRgba: firstRender});
    const second = observed.catalog.patients[0].studies[0].series.find(series => series.seriesUid === `${uid}.2`);assert.ok(second);await evaluate(`window.__v.openSessionSeries(${quote(second.id)})`);await idle();assert.deepEqual((await state()).uploads.at(-1), [300, 310, 320, 330]);await evaluate('window.__v.setFrame(1)');assert.deepEqual((await state()).uploads.at(-1), [310, 320, 330, 340]);
    record('the second series remains selectable and its instances decode and render with their declared samples');
    await evaluate('window.__v.addAnnotation({tool:"length",points:[{x:.5,y:.5},{x:1.5,y:.5}]})');const beforeRejected = await state();await preview('identity');const rejected = await notice();assert.match(rejected.error, /invalid text encoding/u);assert.equal(rejected.patients, 0);observed = await state();assert.deepEqual(observed.catalog.counts, beforeRejected.catalog.counts);assert.deepEqual(observed.workspace.viewports, beforeRejected.workspace.viewports);assert.equal(observed.annotations.count, beforeRejected.annotations.count);assert.equal(observed.uploads.length, beforeRejected.uploads.length);assert.equal(await evaluate('window.__shadow.querySelector(".open-workflow-error").hidden'), false);await click('[data-open-action="close"]');
    record('invalid patient-ID bytes remain a strict error and cannot alter or merge the current patient workspace');
    const resources = await evaluate('(async()=>{window.__v.dispose();await window.__v.whenDisposed();return window.__v.getPerformance().resources;})()');assert.equal(resources.workerCount, 0);assert.equal(resources.encodedBytes, 0);assert.equal(resources.decodedCacheBytes, 0);
    assert.equal(browser.errors.length, 0, JSON.stringify(browser.errors));assert.equal(browser.consoleErrors.length, 0, JSON.stringify(browser.consoleErrors));assert.equal(browser.requests.filter(request => !['GET', 'HEAD'].includes(request.method)).length, 0);assert.equal(browser.requests.filter(request => !request.url.startsWith(origin) && !request.url.startsWith('data:') && !request.url.startsWith('blob:')).length, 0);
    assert.equal(JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8')).sourceDigest, build.sourceDigest);assert.equal(await sourceDigest(root), build.sourceDigest);
    record('generated encoding qualification releases resources and produces no uploads, external requests or browser errors');
    await writeFile(resolve(output, 'results.json'), JSON.stringify({passed: checks.length, checks, sourceDigest: build.sourceDigest, harnessSha256: createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'), originalImagingFilesUsed: false, uploads: 0, externalRequests: 0, browserExceptions: 0, consoleErrors: 0}, null, 2) + '\n');console.log(`Directory encoding browser checks: ${checks.length} passed.`);
} catch (error) {
    if (browser) await screenshot('failure').catch(() => {});await writeFile(resolve(output, 'failure.json'), JSON.stringify({checks, error: {name: error.name, message: error.message, stack: error.stack}, browserExceptions: browser?.errors ?? [], consoleErrors: browser?.consoleErrors ?? []}, null, 2) + '\n');throw error;
} finally {browser?.close();await server?.close();if (temporary) await rm(temporary, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});}
