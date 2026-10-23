import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createDicomFixture } from '../src/data/synthetic.js';
import { browserSession } from './browser-session.mjs';
import { startCorpusServer } from './local-corpus-check.mjs';
import { sourceDigest } from './source-digest.mjs';

// Generated independent 2x2 rasters only. Distinct Acquisition Number values
// correctly partition a single catalog series without inventing image geometry.
const root = resolve(import.meta.dirname, '..'), output = resolve(root, 'artifacts/browser-large-series');
const uid = '2.25.991', quote = JSON.stringify, checks = [], fixtures = [];
const definitions = [{number: 1, count: 419}, {number: 2, count: 283}, {number: 3, count: 1025}];
const pixels = (series, index) => {const base = series === 1 ? 100 + index * 100 : series === 2 ? 20000 + index * 100 : 100 + index * 30;return [base, base + 1, base + 2, base + 3];};
for (const {number, count} of definitions) for (let index = 0; index < count; index++) {
    const bytes = createDicomFixture({rows: 2, columns: 2, values: pixels(number, index), bitsAllocated: 16, bitsStored: 16, signed: false,
        modality: 'CT', sopUid: `${uid}.1.${number}.${index + 1}`, seriesUid: `${uid}.1.${number}`,
        instanceNumber: index + 1, position: [0, 0, 0], pixelSpacing: [1, 1], description: `Generated ${count}-partition series`,
        window: {center: 32768, width: 65536}, extraAttributes: {'0020000D': ['UI', `${uid}.1`], '00200011': ['IS', number],
            '00200012': ['IS', index + 1], '00200052': ['UI', `${uid}.1.99`], '00081030': ['LO', 'Generated large-series examination'],
            '00100010': ['PN', 'SYNTHETIC^LARGE_SERIES'], '00100020': ['LO', 'LARGE_SERIES'], '00100021': ['LO', 'SYNTHETIC_STACK_QA']}});
    fixtures.push({name: `GENERATED_S${number}_I${index + 1}`, series: number, index, encoded: Buffer.from(bytes).toString('base64')});
}
let browser, server, temporary;
const evaluate = value => browser.evaluate(value);
const click = selector => evaluate(`(()=>{const n=window.__shadow.querySelector(${quote(selector)});if(!n)throw new Error('Missing generated large-series control: '+${quote(selector)});n.click();})()`);
const pointerClick = async selector => {
    const point = await evaluate(`(()=>{const n=window.__shadow.querySelector(${quote(selector)});if(!n)throw new Error('Missing generated pointer target: '+${quote(selector)});n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return{x:r.x+Math.min(r.width/2,45),y:r.y+Math.min(r.height/2,15)};})()`);
    await browser.send('Input.dispatchMouseEvent', {type: 'mouseMoved', ...point, button: 'none', buttons: 0});await browser.send('Input.dispatchMouseEvent', {type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1});await browser.send('Input.dispatchMouseEvent', {type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1});
};
const idle = () => browser.until('!window.__v.getState().busy&&!window.__v.getSessionState().busy&&!window.__v.getOpenWorkflowState().busy', 'The generated large-series operation did not settle.', 600);
const state = () => evaluate('({view:window.__v.getState(),catalog:window.__v.getSessionCatalog(),workspace:window.__v.getWorkspaceState(),samples:window.__qa.uploads.at(-1)?.samples,draw:window.__qa.draws.at(-1),jobs:window.__qa.jobs,resources:window.__v.getPerformance().resources,error:{visible:!window.__shadow.getElementById("error-banner").hidden,message:window.__shadow.getElementById("error-message").textContent},assigned:Array.from(window.__shadow.querySelectorAll(".session-library-series")).filter(card=>card.querySelector(".session-library-pane-badge")).map(card=>card.dataset.seriesId)})');
const record = (name, details = {}) => {checks.push({name, ...details});console.log(`PASS ${name}`);};
const screenshot = async name => {await browser.screenshot(name);await copyFile(resolve(temporary, 'chrome', `${name}.png`), resolve(output, `${name}.png`));};
const card = id => `.session-library-series[data-series-id="${id}"]`;
async function groupPage(id, index) {
    const selector = `${card(id)} [data-session-action="open-group"][data-stack-index="${index}"]`;
    for (let attempt = 0; attempt < 50; attempt++) {
        if (await evaluate(`Boolean(window.__shadow.querySelector(${quote(selector)}))`)) return selector;
        await click(`${card(id)} [data-session-action="stacks-next"]`);
    }
    throw new Error('A global image-stack index was not reachable through the page controls.');
}
async function verify(id, expected, {probe = false} = {}) {
    const current = await state();assert.equal(current.error.visible, false, current.error.message);assert.deepEqual(current.assigned, [id]);assert.deepEqual(current.samples, expected);assert.equal(current.view.frameCount, 1);assert.equal(current.view.frameIndex, 0);
    const window = current.workspace.viewports[0].window;
    for (const [index, actual] of current.draw.pixels.entries()) {
        const target = Math.round(Math.max(0, Math.min(1, (expected[index] - (window.center - .5)) / (window.width - 1) + .5)) * 255);
        assert.equal(actual[3], 255);for (const channel of actual.slice(0, 3)) assert.ok(Math.abs(channel - target) <= 2, JSON.stringify({index, actual, target}));
    }
    if (probe) {
        await evaluate('window.__v.setTool("probe")');const point = await evaluate('window.__qa.draws.at(-1).points[0]');await browser.send('Input.dispatchMouseEvent', {type: 'mouseMoved', ...point, button: 'none', buttons: 0});
        const text = await evaluate('window.__shadow.getElementById("probe-stored").textContent');assert.equal(Number(text.replace(/^Stored:\s*/u, '').replaceAll(',', '').trim()), expected[0]);await evaluate('window.__v.setTool("window")');
    }
    return current;
}
try {
    await mkdir(output, {recursive: true});await rm(resolve(output, 'results.json'), {force: true});await rm(resolve(output, 'failure.json'), {force: true});
    const build = JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8'));assert.equal(build.sourceDigest, await sourceDigest(root), 'Rebuild before large-series qualification.');
    temporary = await mkdtemp(join(tmpdir(), 'easi-view-large-series-browser-'));const host = resolve(temporary, 'host');await mkdir(host);
    await writeFile(resolve(host, 'fixtures.json'), JSON.stringify(fixtures));
    await writeFile(resolve(host, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./host.css"></head><body><main id="mount"></main><script type="module" src="./host.js"></script></body></html>');
    await writeFile(resolve(host, 'host.css'), 'body{margin:0;background:#09121b}#mount{height:100dvh;width:100%}');
    await writeFile(resolve(host, 'host.js'), `
import{createViewer}from'/assets/easi-view.js';
const fixtures=await(await fetch('./fixtures.json')).json();window.__files=fixtures.map(item=>new File([Uint8Array.from(atob(item.encoded),c=>c.charCodeAt(0))],item.name));window.__qa={uploads:[],draws:[],jobs:0,workers:{created:0,terminated:0}};
const NativeWorker=window.Worker;window.Worker=class extends NativeWorker{constructor(...args){super(...args);window.__qa.workers.created++;}postMessage(message,...args){if(message.metadata&&message.bytes)window.__qa.jobs++;return super.postMessage(message,...args);}terminate(){if(!this.__qaTerminated){this.__qaTerminated=true;window.__qa.workers.terminated++;}return super.terminate();}};
const upload=WebGL2RenderingContext.prototype.texImage2D,draw=WebGL2RenderingContext.prototype.drawArrays;
WebGL2RenderingContext.prototype.texImage2D=function(...args){if(args[3]===2&&args[4]===2&&args[8]?.length===4){this.canvas.__qaSamples=Array.from(args[8]);window.__qa.uploads.push({samples:this.canvas.__qaSamples});}return upload.apply(this,args);};
WebGL2RenderingContext.prototype.drawArrays=function(...args){const result=draw.apply(this,args);if(this.canvas.__qaSamples){const program=this.getParameter(this.CURRENT_PROGRAM),m=program&&this.getUniform(program,this.getUniformLocation(program,'imageToClip'));if(m){const r=this.canvas.getBoundingClientRect(),points=[],pixels=[[0,0],[1,0],[0,1],[1,1]].map(([x,y])=>{const a=x+.5,b=y+.5,cx=m[0]*a+m[3]*b+m[6],cy=m[1]*a+m[4]*b+m[7],p=new Uint8Array(4);points.push({x:r.left+(cx+1)*r.width/2,y:r.top+(1-cy)*r.height/2});this.readPixels(Math.floor((cx+1)*this.canvas.width/2),Math.floor((cy+1)*this.canvas.height/2),1,1,this.RGBA,this.UNSIGNED_BYTE,p);return Array.from(p);});window.__qa.draws.push({pixels,points});}}return result;};
window.__v=createViewer(document.getElementById('mount'),{initialDemo:null});await window.__v.ready;window.__shadow=document.querySelector('easi-view-embed').shadowRoot;window.__ready=true;
`);
    server = await startCorpusServer({dist: resolve(root, 'dist'), host, styleHash: build.inlineStyleSha256});const origin = new URL(server.url).origin;
    browser = await browserSession(resolve(temporary, 'chrome'));await browser.send('Emulation.setDeviceMetricsOverride', {width: 1540, height: 1050, deviceScaleFactor: 1, mobile: false});await browser.send('Page.setInterceptFileChooserDialog', {enabled: true});await browser.send('Page.navigate', {url: server.url});await browser.until('window.__ready', 'The generated large-series host did not mount.');
    await evaluate('window.__v.open("images")');await click('[data-open-action="pick-files"]');await evaluate('(()=>{const i=window.__shadow.getElementById("file-input"),dt=new DataTransfer();window.__files.forEach(file=>dt.items.add(file));i.files=dt.files;i.dispatchEvent(new Event("change",{bubbles:true}));})()');await idle();await click('[data-open-action="add"]');await idle();
    let current = await state();assert.equal(current.catalog.counts.patients, 1);assert.equal(current.catalog.counts.studies, 1);assert.equal(current.catalog.counts.series, 3);assert.equal(current.catalog.counts.instances, 1727);
    const series = Object.fromEntries(current.catalog.patients[0].studies[0].series.map(item => [Number(item.seriesNumber), item.id]));
    await verify(series[1], pixels(1, 0));assert.equal(current.catalog.patients[0].studies[0].series.find(item => item.id === series[1]).stackGroups.length, 419);
    record('a logical 419-partition series admits as one catalog series and renders its first requested image');
    await pointerClick(`${card(series[2])} [data-session-series-select]`);await idle();await verify(series[2], pixels(2, 0));current = await state();assert.equal(current.catalog.patients[0].studies[0].series.find(item => item.id === series[2]).stackGroups.length, 283);assert.equal(current.view.seriesCount, 702);assert.ok(current.jobs < 10, `Only requested pixels should decode, not ${current.jobs} frames.`);assert.ok(current.resources.decodedCacheBytes < 1024);
    record('a second 283-partition series selects by actual card click while 702 metadata stacks retain bounded decoded pixels', {workerJobs: current.jobs, decodedBytes: current.resources.decodedCacheBytes});
    await pointerClick(`${card(series[1])} [data-session-series-select]`);await idle();
    const mid = await groupPage(series[1], 128);await pointerClick(mid);await idle();await verify(series[1], pixels(1, 128), {probe: true});
    const last = await groupPage(series[1], 418);await pointerClick(last);await idle();await verify(series[1], pixels(1, 418), {probe: true});
    const indexes = await evaluate(`Array.from(window.__shadow.querySelectorAll(${quote(`${card(series[1])} [data-session-action=open-group]`)})).map(node=>Number(node.dataset.stackIndex))`);assert.ok(indexes.length <= 24);assert.ok(indexes.includes(418));assert.ok(Math.min(...indexes) >= 408);
    record('paged global stack indices 128 and 418 open their independently declared texture, GPU intensity and stored pixel probe values', {lastPageIndices: indexes});await screenshot('large-series-last-stack-desktop');
    await click(`${card(series[1])} [data-session-action="toggle-instances"]`);
    for (let page = 0; page < 16; page++) await click(`${card(series[1])} [data-session-action="instances-next"]`);
    const lastInstance = `${card(series[1])} .session-library-instance:last-child`;await pointerClick(lastInstance);await idle();await verify(series[1], pixels(1, 418), {probe: true});
    const lastSelected = await evaluate(`window.__shadow.querySelector(${quote(lastInstance)}).getAttribute('aria-pressed')`);assert.equal(lastSelected, 'true');
    record('an individual instance beyond index 128 resolves its own global stack and exact image rather than reopening the previous texture');
    const secondLast = await groupPage(series[2], 282);await pointerClick(secondLast);await idle();await verify(series[2], pixels(2, 282), {probe: true});
    await pointerClick(`${card(series[1])} [data-session-series-select]`);await idle();await verify(series[1], pixels(1, 0));
    record('the final stack of the second large series and a cached first-card reopen both preserve the requested pane assignment and expected pixels');
    await browser.send('Emulation.setDeviceMetricsOverride', {width: 430, height: 930, deviceScaleFactor: 1, mobile: true});await click('#toggle-library');await evaluate('(async()=>{await Promise.allSettled(window.__shadow.getElementById("library-panel").getAnimations({subtree:true}).filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished));return true;})()');
    await evaluate(`window.__shadow.querySelector(${quote(card(series[1]))}).scrollIntoView({block:'start'})`);
    const narrow = await evaluate(`(()=>{const panel=window.__shadow.getElementById('library-panel'),card=window.__shadow.querySelector(${quote(card(series[1]))}),box=card.getBoundingClientRect();return{overflow:panel.scrollWidth-panel.clientWidth,left:box.left,right:box.right,width:innerWidth,groups:card.querySelectorAll('[data-session-action=open-group]').length};})()`);assert.ok(narrow.overflow <= 1);assert.ok(narrow.left >= 0 && narrow.right <= narrow.width + 1);assert.ok(narrow.groups <= 24);await screenshot('large-series-pager-narrow');
    record('the large-series pager stays limited to 24 controls and fits the narrow session library');
    await browser.send('Emulation.setDeviceMetricsOverride', {width: 1540, height: 1050, deviceScaleFactor: 1, mobile: false});const before = await state();await pointerClick(`${card(series[3])} [data-session-series-select]`);await idle();current = await state();assert.equal(current.error.visible, true);assert.match(current.error.message, /budget|1,024|1024|too (?:large|many)/iu);assert.deepEqual(current.samples, before.samples);assert.deepEqual(current.assigned, before.assigned);assert.deepEqual(current.workspace.viewports, before.workspace.viewports);await screenshot('oversized-source-explicit-error');
    record('a genuinely oversized 1025-stack selection shows a global error while retaining the prior requested assignment, texture and presentation');
    await click('#dismiss-error');const aborted = await evaluate(`(async()=>{const controller=new AbortController(),pending=window.__v.openSessionSeries(${quote(series[3])},{signal:controller.signal});queueMicrotask(()=>controller.abort());return pending.then(()=>false,error=>error.name==='AbortError');})()`);assert.equal(aborted, true);await idle();current = await state();assert.equal(current.error.visible, false);assert.deepEqual(current.samples, before.samples);assert.deepEqual(current.assigned, before.assigned);
    record('canceling a pending selection stays quiet and preserves the previous displayed image');
    const final = await evaluate('(async()=>{window.__v.dispose();await window.__v.whenDisposed();return{resources:window.__v.getPerformance().resources,workers:window.__qa.workers,jobs:window.__qa.jobs};})()');assert.equal(final.resources.workerCount, 0);assert.equal(final.resources.encodedBytes, 0);assert.equal(final.resources.decodedCacheBytes, 0);assert.equal(final.workers.created, final.workers.terminated);
    assert.equal(browser.errors.length, 0, JSON.stringify(browser.errors));assert.equal(browser.consoleErrors.length, 0, JSON.stringify(browser.consoleErrors));assert.equal(browser.requests.filter(request => !['GET', 'HEAD'].includes(request.method)).length, 0);assert.equal(browser.requests.filter(request => !request.url.startsWith(origin) && !request.url.startsWith('data:') && !request.url.startsWith('blob:')).length, 0);assert.equal(await sourceDigest(root), build.sourceDigest);
    record('the generated browser gate releases all resources and has no uploads, external requests or browser errors', final);
    await writeFile(resolve(output, 'results.json'), JSON.stringify({passed: checks.length, checks, sourceDigest: build.sourceDigest, harnessSha256: createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'), originalImagingFilesUsed: false, uploads: 0, externalRequests: 0, browserExceptions: 0, consoleErrors: 0}, null, 2) + '\n');console.log(`Large-series browser checks: ${checks.length} passed.`);
} catch (error) {if (browser) await screenshot('failure').catch(() => {});await writeFile(resolve(output, 'failure.json'), JSON.stringify({checks, error: {name: error.name, message: error.message, stack: error.stack}, browserExceptions: browser?.errors ?? [], consoleErrors: browser?.consoleErrors ?? []}, null, 2) + '\n');throw error;}
finally {browser?.close();await server?.close();if (temporary) await rm(temporary, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});}
