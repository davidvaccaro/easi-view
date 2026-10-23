import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createDicomFixture } from '../src/data/synthetic.js';
import { browserSession } from './browser-session.mjs';
import { startCorpusServer } from './local-corpus-check.mjs';
import { sourceDigest } from './source-digest.mjs';

// Generated data only: one DICOM series contains two incompatible orientations.
// First-pixel expectations are declared independently of display labels.
const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'artifacts/browser-stack-labels');
const description = 'Generated intentionally verbose acquisition description that should not be repeated on every image stack button';
const uid = '2.25.999.23';
const fixtures = ['Axial', 'Coronal'].flatMap((plane, group) => [0, 1].map(index => {
    const base = group ? 300 + index * 10 : 100 + index * 10;
    const values = [base, base + 10, base + 20, base + 30];
    const bytes = createDicomFixture({rows: 2, columns: 2, values, modality: 'CT', description,
        sopUid: `${uid}.1.${group * 2 + index + 1}`, seriesUid: `${uid}.1`, instanceNumber: group * 2 + index + 1,
        orientation: group ? [1, 0, 0, 0, 0, -1] : [1, 0, 0, 0, 1, 0], position: group ? [0, index, 0] : [0, 0, index],
        pixelSpacing: [1, 1], window: {center: 512, width: 1024}, extraAttributes: {
            '0020000D': ['UI', uid], '00200052': ['UI', `${uid}.99`], '00081030': ['LO', 'Generated mixed-orientation examination'],
            '00100010': ['PN', 'SYNTHETIC^STACKS'], '00100020': ['LO', 'STACK_LABELS'], '00100021': ['LO', 'SYNTHETIC_STACK_QA']
        }});
    return {name: `GENERATED_${plane}_${index + 1}`, plane, values, encoded: Buffer.from(bytes).toString('base64')};
}));
const quote = JSON.stringify, checks = [];
let browser, server, temporary;
const evaluate = value => browser.evaluate(value);
const click = selector => evaluate(`(()=>{const node=window.__shadow.querySelector(${quote(selector)});if(!node)throw new Error('Missing stack control: '+${quote(selector)});node.focus();node.click();})()`);
const idle = () => browser.until('!window.__v.getState().busy&&!window.__v.getSessionState().busy&&!window.__v.getOpenWorkflowState().busy', 'The image stack did not finish opening.');
const record = (name, details = {}) => {checks.push({name, ...details});console.log(`PASS ${name}`);};
const screenshot = async name => {await browser.screenshot(name);await copyFile(resolve(temporary, 'chrome', `${name}.png`), resolve(output, `${name}.png`));};

try {
    await mkdir(output, {recursive: true});await rm(resolve(output, 'results.json'), {force: true});await rm(resolve(output, 'failure.json'), {force: true});
    const buildInfo = JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8'));
    assert.equal(buildInfo.sourceDigest, await sourceDigest(root), 'Rebuild before image stack qualification.');
    temporary = await mkdtemp(join(tmpdir(), 'easi-view-stack-labels-browser-'));const host = resolve(temporary, 'host');await mkdir(host);
    await writeFile(resolve(host, 'fixtures.json'), JSON.stringify(fixtures));
    await writeFile(resolve(host, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./host.css"></head><body><main id="mount"></main><script type="module" src="./host.js"></script></body></html>');
    await writeFile(resolve(host, 'host.css'), 'body{margin:0;background:#09121b}#mount{height:100dvh;width:100%}');
    await writeFile(resolve(host, 'host.js'), `
import {createViewer} from '/assets/easi-view.js';
const fixtures=await(await fetch('./fixtures.json')).json();
window.__files=fixtures.map(item=>new File([Uint8Array.from(atob(item.encoded),c=>c.charCodeAt(0))],item.name));
window.__qa={uploads:[],draws:[]};
const upload=WebGL2RenderingContext.prototype.texImage2D,draw=WebGL2RenderingContext.prototype.drawArrays;
WebGL2RenderingContext.prototype.texImage2D=function(...args){if(args[3]===2&&args[4]===2&&args[8]?.length===4)window.__qa.uploads.push(Array.from(args[8]));return upload.apply(this,args);};
WebGL2RenderingContext.prototype.drawArrays=function(...args){const result=draw.apply(this,args);const pixel=new Uint8Array(4);this.readPixels(Math.floor(this.canvas.width/2),Math.floor(this.canvas.height/2),1,1,this.RGBA,this.UNSIGNED_BYTE,pixel);window.__qa.draws.push(Array.from(pixel));return result;};
window.__v=createViewer(document.getElementById('mount'),{initialDemo:null});await window.__v.ready;window.__shadow=document.querySelector('easi-view-embed').shadowRoot;window.__ready=true;
`);
    server = await startCorpusServer({dist: resolve(root, 'dist'), host, styleHash: buildInfo.inlineStyleSha256});const origin = new URL(server.url).origin;
    browser = await browserSession(resolve(temporary, 'chrome'));await browser.send('Emulation.setDeviceMetricsOverride', {width: 1540, height: 1050, deviceScaleFactor: 1, mobile: false});await browser.send('Page.setInterceptFileChooserDialog', {enabled: true});
    await browser.send('Page.navigate', {url: server.url});await browser.until('window.__ready', 'The generated stack host did not mount.');
    await evaluate('window.__v.open("images")');await click('[data-open-action="pick-files"]');
    await evaluate('(()=>{const input=window.__shadow.getElementById("file-input"),transfer=new DataTransfer();window.__files.forEach(file=>transfer.items.add(file));input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));})()');await idle();await click('[data-open-action="add"]');await idle();
    const catalog = await evaluate('window.__v.getSessionCatalog()');assert.equal(catalog.counts.patients, 1);assert.equal(catalog.counts.studies, 1);assert.equal(catalog.counts.series, 1);assert.equal(catalog.counts.instances, 4);
    const series = catalog.patients[0].studies[0].series[0];assert.equal(series.stackGroups.length, 2);assert.equal(await evaluate('window.__v.getState().frameCount'), 2);
    record('one generated series stays one session series while its two orientations form separate two-image stacks');
    const labels = await evaluate('Array.from(window.__shadow.querySelectorAll(".session-library-stack-groups [data-session-action=open-group]")).map(node=>({label:node.textContent,stackIndex:Number(node.dataset.stackIndex),title:node.title}))');
    assert.equal(labels.length, 2);assert.equal(new Set(labels.map(item => item.label)).size, 2);
    assert.equal(await evaluate('window.__shadow.querySelector(".session-library-stack-groups > span").textContent'), 'Image stacks');
    assert.ok(labels.some(item => /Axial/u.test(item.label)));assert.ok(labels.some(item => /Coronal/u.test(item.label)));
    for (const item of labels) {assert.ok(item.label.length <= 80, item.label);assert.ok(!item.label.includes(description));assert.ok(!item.label.includes(uid));}
    assert.equal(await evaluate('window.__shadow.querySelector(".session-library-stack-groups").textContent.includes("Display groups")'), false);
    record('Image stacks uses distinct compact orientation labels without repeating descriptions or DICOM UIDs', {labels});
    for (const item of labels) {
        const plane = /Axial/u.test(item.label) ? 'Axial' : 'Coronal', expected = fixtures.find(fixture => fixture.plane === plane).values;
        await click(`[data-session-action="open-group"][data-stack-index="${item.stackIndex}"]`);await idle();
        assert.equal(await evaluate('window.__v.getState().frameIndex'), 0);assert.equal(await evaluate('window.__v.getState().frameCount'), 2);
        await browser.until(`JSON.stringify(window.__qa.uploads.at(-1))===${quote(JSON.stringify(expected))}`, 'The stack label did not open its expected synthetic pixels.');
        const rendered = await evaluate('window.__qa.draws.at(-1)');assert.equal(rendered[3], 255);assert.equal(rendered[0], rendered[1]);assert.equal(rendered[1], rendered[2]);
        assert.ok(rendered[0] >= (plane === 'Axial' ? 20 : 70) && rendered[0] <= (plane === 'Axial' ? 40 : 90), JSON.stringify(rendered));
        await evaluate('window.__v.setFrame(1)');const second = fixtures.filter(fixture => fixture.plane === plane)[1].values;assert.deepEqual(await evaluate('window.__qa.uploads.at(-1)'), second);
        record(`${plane} stack selection and navigation render the independently declared image samples`, {firstSamples: expected, secondSamples: second, renderedCenterRgba: rendered});
    }
    const desktopBounds = await evaluate('Array.from(window.__shadow.querySelectorAll(".session-library-stack-groups [data-session-action=open-group]")).map(node=>({text:node.textContent,scrollWidth:node.scrollWidth,clientWidth:node.clientWidth,left:node.getBoundingClientRect().left,right:node.getBoundingClientRect().right,cardLeft:node.closest(".session-library-series").getBoundingClientRect().left,cardRight:node.closest(".session-library-series").getBoundingClientRect().right}))');
    for (const box of desktopBounds) {assert.ok(box.scrollWidth <= box.clientWidth + 1, JSON.stringify(box));assert.ok(box.left >= box.cardLeft && box.right <= box.cardRight + 1);}
    await screenshot('image-stacks-desktop');record('compact image stack controls fit the desktop session card without overflow');
    await browser.send('Emulation.setDeviceMetricsOverride', {width: 430, height: 930, deviceScaleFactor: 1, mobile: true});await click('#toggle-library');await evaluate('(async()=>{await Promise.allSettled(window.__shadow.getElementById("library-panel").getAnimations({subtree:true}).filter(animation=>animation.effect?.getComputedTiming().iterations!==Infinity).map(animation=>animation.finished));return true;})()');
    const narrowBounds = await evaluate('(()=>{const panel=window.__shadow.getElementById("library-panel"),box=panel.getBoundingClientRect();return{left:box.left,right:box.right,width:innerWidth,buttons:Array.from(panel.querySelectorAll("[data-session-action=open-group]")).map(node=>({scrollWidth:node.scrollWidth,clientWidth:node.clientWidth,right:node.getBoundingClientRect().right}))};})()');
    assert.ok(narrowBounds.left >= 0 && narrowBounds.right <= narrowBounds.width + 1);for (const box of narrowBounds.buttons) {assert.ok(box.scrollWidth <= box.clientWidth + 1);assert.ok(box.right <= narrowBounds.right + 1);}
    await screenshot('image-stacks-narrow');record('image stack labels remain readable inside the narrow-screen session library');
    const resources = await evaluate('(async()=>{window.__v.dispose();await window.__v.whenDisposed();return window.__v.getPerformance().resources;})()');assert.equal(resources.workerCount, 0);assert.equal(resources.encodedBytes, 0);assert.equal(resources.decodedCacheBytes, 0);
    assert.equal(browser.errors.length, 0, JSON.stringify(browser.errors));assert.equal(browser.consoleErrors.length, 0, JSON.stringify(browser.consoleErrors));
    assert.equal(browser.requests.filter(request => !['GET', 'HEAD'].includes(request.method)).length, 0);assert.equal(browser.requests.filter(request => !request.url.startsWith(origin) && !request.url.startsWith('data:') && !request.url.startsWith('blob:')).length, 0);
    assert.equal(JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8')).sourceDigest, buildInfo.sourceDigest);assert.equal(await sourceDigest(root), buildInfo.sourceDigest);
    record('generated stack qualification releases resources and produces no uploads, external requests or browser errors');
    await writeFile(resolve(output, 'results.json'), JSON.stringify({passed: checks.length, checks, sourceDigest: buildInfo.sourceDigest, harnessSha256: createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'), originalImagingFilesUsed: false, uploads: 0, externalRequests: 0, browserExceptions: 0, consoleErrors: 0}, null, 2) + '\n');
    console.log(`Image stack browser checks: ${checks.length} passed.`);
} catch (error) {
    if (browser) await screenshot('failure').catch(() => {});await writeFile(resolve(output, 'failure.json'), JSON.stringify({checks, error: {name: error.name, message: error.message, stack: error.stack}, browserExceptions: browser?.errors ?? [], consoleErrors: browser?.consoleErrors ?? []}, null, 2) + '\n');throw error;
} finally {browser?.close();await server?.close();if (temporary) await rm(temporary, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});}
