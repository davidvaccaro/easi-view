import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { build as bundle } from 'esbuild';
import { createDicomFixture } from '../src/data/synthetic.js';
import { createDicomdirFixture } from '../test/dicomdir-fixtures.js';
import { browserSession } from './browser-session.mjs';
import { startCorpusServer } from './local-corpus-check.mjs';
import { sourceDigest } from './source-digest.mjs';

// Generated sources only. Identical demographics deliberately lack an issuer,
// so the two imports must stay separate until the user confirms an association.
const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'artifacts/browser-patient-matches');
const uid = '2.25.995', identity = {name: 'SYNTHETIC^MATCH', id: 'MATCH_001', birth: '19700101'};
const studies = [
    {number: 1, name: 'Generated MR target', modality: 'MR', base: 100, date: '20261010'},
    {number: 2, name: 'Generated CT current', modality: 'CT', base: 300, date: '20261018'},
    {number: 3, name: 'Generated CT prior', modality: 'CT', base: 500, date: '20260901'},
    {number: 4, name: 'Unchecked examination', modality: 'CT', base: 700, date: '20260801'}
];
const images = studies.flatMap(study => [1, 2].map(instance => {
    const base = study.base + (instance - 1) * 10, values = [base, base + 10, base + 20, base + 30];
    const name = `IM${study.number}${instance}`, studyUid = `${uid}.${study.number}`, seriesUid = `${studyUid}.1`, sopUid = `${seriesUid}.${instance}`;
    return {key: name, name, path: `MATCH_MEDIA/IMAGES/${name}`, study: study.number, studyUid, seriesUid, sopUid, values,
        bytes: createDicomFixture({rows: 2, columns: 2, values, modality: study.modality, sopClass: `1.2.840.10008.5.1.4.1.1.${study.modality === 'MR' ? '4' : '2'}`,
            sopUid, seriesUid, description: `${study.modality} generated series`, instanceNumber: instance, position: [0, 0, instance - 1], pixelSpacing: [1, 1], window: {center: 512, width: 1024},
            extraAttributes: {'00080020': ['DA', study.date], '00081030': ['LO', study.name], '00100010': ['PN', identity.name], '00100020': ['LO', identity.id], '00100021': ['LO', ''], '00100030': ['DA', identity.birth], '0020000D': ['UI', studyUid], '00200011': ['IS', 1], '00200052': ['UI', `${studyUid}.99`]}})};
}));
const records = [{type: 'PATIENT', patientName: identity.name, patientId: identity.id, attributes: {'00100030': ['DA', identity.birth]},
    children: studies.slice(1).map(study => ({type: 'STUDY', studyUid: `${uid}.${study.number}`, studyDate: study.date, studyDescription: study.name,
        children: [{type: 'SERIES', seriesUid: `${uid}.${study.number}.1`, seriesNumber: 1, modality: study.modality,
            children: images.filter(image => image.study === study.number).map(image => ({type: 'IMAGE', fileId: ['IMAGES', image.name], sopUid: image.sopUid, instanceNumber: Number(image.name.at(-1))}))}]}))}];
const media = [{key: 'directory', name: 'DICOMDIR', path: 'MATCH_MEDIA/DICOMDIR', bytes: createDicomdirFixture(records)}, ...images.filter(image => image.study !== 1)];
const collections = {mr: images.filter(image => image.study === 1), ct: media};
const quote = JSON.stringify, checks = [];
let browser, server, temporary;
const evaluate = value => browser.evaluate(value);
const click = selector => evaluate(`(()=>{const node=window.__shadow.querySelector(${quote(selector)});if(!node)throw new Error('Missing patient-review control: '+${quote(selector)});node.focus();node.click();})()`);
const idle = () => browser.until('!window.__v.getState().busy&&!window.__v.getSessionState().busy&&!window.__v.getOpenWorkflowState().busy', 'Patient operation did not finish.');
const state = () => evaluate('({view:window.__v.getState(),catalog:window.__v.getSessionCatalog(),workspace:window.__v.getWorkspaceState(),annotations:window.__v.getAnnotationState(),document:window.__v.exportAnnotations(),performance:window.__v.getPerformance(),uploads:window.__qa.uploads})');
const record = (name, details = {}) => {checks.push({name, ...details});console.log(`PASS ${name}`);};
const screenshot = async name => {await browser.screenshot(name);await copyFile(resolve(temporary, 'chrome', `${name}.png`), resolve(output, `${name}.png`));};
const samples = slot => evaluate(`window.__qa.uploads.filter(item=>item.slot===${slot}).at(-1)?.samples`);
const verifyFramebuffer = async (slot,values) => {const observed=await evaluate(`({window:window.__v.getWorkspaceState().viewports[${slot}].window,pixel:window.__qa.draws.filter(item=>item.slot===${slot}).at(-1)?.rgba})`),scale=value=>Math.round(Math.max(0,Math.min(1,(value-(observed.window.center-.5))/(observed.window.width-1)+.5))*255);assert.equal(observed.pixel[3],255);for(const value of observed.pixel.slice(0,3))assert.ok(value>=scale(Math.min(...values))-2&&value<=scale(Math.max(...values))+2,JSON.stringify(observed));return observed.pixel;};
const snapshotIds = catalog => Object.fromEntries(catalog.patients.flatMap(patient => patient.studies).map(study => [study.studyUid, {id: study.id, series: study.series.map(series => ({id: series.id, uid: series.seriesUid, instances: series.instances.map(instance => ({id: instance.id, sopUid: instance.sopUid}))}))}]));
const addMr = async () => {
    await evaluate('window.__v.open("images")');await click('[data-open-action="pick-files"]');await evaluate('window.__input("file-input","mr")');await idle();await click('[data-open-action="add"]');await idle();
};
const addSelectedCt = async () => {
    await evaluate('window.__v.open("study")');await click('[data-open-action="pick-study-folder"]');await evaluate('window.__input("folder-input","ct")');await idle();
    assert.equal(await evaluate('window.__shadow.querySelectorAll("[data-open-study]").length'), 3);
    await evaluate('Array.from(window.__shadow.querySelectorAll("[data-open-study]")).filter(input=>!input.closest("label").textContent.includes("Unchecked examination")).forEach(input=>input.click())');
    assert.equal(await evaluate('window.__v.getOpenWorkflowState().selectedStudyIds.length'), 2);await click('[data-open-action="add"]');await idle();
};
const prepare = async () => {
    await addMr();let observed = await state();const target = observed.catalog.patients[0];
    await evaluate('window.__v.setFrame(1)');await evaluate('window.__v.setWindow({center:700,width:1400})');await evaluate('window.__v.setLayout(2)');await evaluate(`window.__v.openSessionSeries(${quote(target.studies[0].series[0].id)},{viewport:1,frameIndex:0})`);await evaluate('window.__v.setActiveViewport(0)');
    await evaluate('window.__v.addAnnotation({tool:"length",points:[{x:.5,y:.5},{x:1.5,y:.5}]})');await addSelectedCt();observed = await state();
    const source = observed.catalog.patients.find(patient => patient.id !== target.id);assert.ok(source);assert.equal(source.studies.length, 2);assert.equal(observed.catalog.counts.patients, 2);assert.equal(observed.catalog.counts.studies, 3);
    assert.ok(!JSON.stringify(observed.catalog).includes('Unchecked examination'));return {target, source};
};

try {
    await mkdir(output, {recursive: true});await rm(resolve(output, 'results.json'), {force: true});await rm(resolve(output, 'failure.json'), {force: true});
    const buildInfo = JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8'));assert.equal(buildInfo.sourceDigest, await sourceDigest(root), 'Rebuild before patient association qualification.');
    temporary = await mkdtemp(join(tmpdir(), 'easi-view-patient-matches-browser-'));const host = resolve(temporary, 'host');await mkdir(host);
    await writeFile(resolve(host, 'fixtures.json'), JSON.stringify(Object.fromEntries(Object.entries(collections).map(([name, files]) => [name, files.map(({bytes, ...data}) => ({...data, encoded: Buffer.from(bytes).toString('base64')}))]))));
    await writeFile(resolve(host, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./host.css"></head><body><main id="mount"></main><aside id="guard-panel"></aside><script type="module" src="./host-bundle.js"></script></body></html>');
    await writeFile(resolve(host, 'host.css'), 'body{margin:0;background:#09121b}#mount{height:100dvh;width:100%}#guard-panel{position:fixed;left:-2200px;top:0;width:244px;height:800px}');
    await writeFile(resolve(host, 'host.js'), `
import {createViewer} from '/assets/easi-view.js';
import {SessionLibraryPanel} from ${quote(resolve(root, 'src/ui/SessionLibraryPanel.js'))};
const data=await(await fetch('./fixtures.json')).json();window.__qa={uploads:[],draws:[]};
const upload=WebGL2RenderingContext.prototype.texImage2D,draw=WebGL2RenderingContext.prototype.drawArrays;
WebGL2RenderingContext.prototype.texImage2D=function(...args){if(args[3]===2&&args[4]===2&&args[8]?.length===4)window.__qa.uploads.push({slot:Number(this.canvas.closest('.workspace-pane')?.dataset.slot??0),samples:Array.from(args[8])});return upload.apply(this,args);};
WebGL2RenderingContext.prototype.drawArrays=function(...args){const result=draw.apply(this,args),pixel=new Uint8Array(4);this.readPixels(Math.floor(this.canvas.width/2),Math.floor(this.canvas.height/2),1,1,this.RGBA,this.UNSIGNED_BYTE,pixel);window.__qa.draws.push({slot:Number(this.canvas.closest('.workspace-pane')?.dataset.slot??0),rgba:Array.from(pixel)});return result;};
const cache=Object.fromEntries(Object.entries(data).map(([name,items])=>[name,items.map(item=>{const file=new File([Uint8Array.from(atob(item.encoded),c=>c.charCodeAt(0))],item.name);if(item.path)Object.defineProperty(file,'webkitRelativePath',{value:item.path});return{file,...item};})]));
window.__files=name=>cache[name].map(item=>item.file);window.__selectedCt=()=>cache.ct.filter(item=>item.study===2||item.study===3).map(item=>item.file);
window.__input=(id,name)=>{const input=window.__shadow.getElementById(id),transfer=new DataTransfer();window.__files(name).forEach(file=>transfer.items.add(file));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));};
window.__reset=async()=>{if(window.__v){window.__v.dispose();await window.__v.whenDisposed();}window.__v=createViewer(document.getElementById('mount'),{initialDemo:null});await window.__v.ready;window.__shadow=document.querySelector('easi-view-embed').shadowRoot;};
window.__checkHints=overrides=>{window.__guard?.dispose();const root=document.getElementById('guard-panel');window.__guard=new SessionLibraryPanel(root,{onSelectPatient(){},onAssociatePatients(){}});const target={id:'hint-target',kind:'local',sourceId:'local',source:{kind:'local',id:'local'},patientId:'MATCH_001',patientName:'SYNTHETIC^MATCH',patientBirthDate:'19700101',issuerOfPatientId:'',identityStatus:'batch-scoped',studies:[]},candidate={...target,id:'hint-source',...overrides};window.__guard.setCatalog({patients:[target,candidate],activePatientId:target.id},{activePatientId:target.id});const banners=root.querySelectorAll('.session-library-match-banner').length;root.querySelector('[data-session-action=change-patient]').click();return{banners,badges:root.querySelectorAll('.session-library-match-badge').length};};
await window.__reset();window.__ready=true;
`);
    await bundle({entryPoints: [resolve(host, 'host.js')], outfile: resolve(host, 'host-bundle.js'), bundle: true, format: 'esm', platform: 'browser', external: ['/assets/easi-view.js'], logLevel: 'silent'});
    server = await startCorpusServer({dist: resolve(root, 'dist'), host, styleHash: buildInfo.inlineStyleSha256});const origin = new URL(server.url).origin;
    browser = await browserSession(resolve(temporary, 'chrome'));await browser.send('Emulation.setDeviceMetricsOverride', {width: 1540, height: 1050, deviceScaleFactor: 1, mobile: false});await browser.send('Page.setInterceptFileChooserDialog', {enabled: true});await browser.send('Page.navigate', {url: server.url});await browser.until('window.__ready', 'The generated patient-review host did not mount.');

    let {target, source} = await prepare(), observed = await state();const beforeIds = snapshotIds(observed.catalog);
    assert.equal(await evaluate('window.__shadow.querySelectorAll(".session-library-match-banner").length'), 1);assert.match(await evaluate('window.__shadow.querySelector(".session-library-match-banner").textContent'), /Possible same patient/u);
    record('separate no-issuer imports retain two patients and three selected studies while offering an explicit exact-match review');
    const blocked = await evaluate(`window.__v.associateLocalPatient(${quote(target.provenance.patientId)},${quote(source.provenance.patientId)},{confirmed:true}).then(()=>false,error=>/measurements/i.test(error.message))`);assert.equal(blocked, true);assert.equal((await state()).catalog.counts.patients, 2);assert.deepEqual(snapshotIds((await state()).catalog), beforeIds);
    record('a measured outside patient cannot be combined into another context before its measurements are handled');
    await evaluate(`window.__v.selectSessionPatient(${quote(target.id)})`);await idle();const targetView = await state();assert.equal(targetView.annotations.count, 1);assert.equal(targetView.workspace.layout, 2);assert.equal(targetView.workspace.viewports[0].frameIndex, 1);assert.deepEqual(targetView.workspace.viewports[0].window, {center: 700, width: 1400});await verifyFramebuffer(0,[110,120,130,140]);await screenshot('patient-match-banner-desktop');
    await click(`.session-library-match-banner [data-session-action="review-association"][data-from-patient-id="${source.id}"]`);assert.equal(await evaluate('window.__shadow.querySelectorAll(".session-library-match-badge").length'), 1);assert.equal(await evaluate('window.__shadow.querySelector(".session-library-association input").checked'), false);assert.equal(await evaluate('window.__shadow.querySelector("[data-session-action=confirm-association]").disabled'), true);await click('[data-session-action="cancel-association"]');observed = await state();assert.deepEqual(observed.workspace.viewports, targetView.workspace.viewports);assert.equal(observed.annotations.count, 1);assert.equal(observed.catalog.counts.patients, 2);
    record('review shows both identities with unchecked required consent and Cancel preserves the target layout, frame, window and measurement');
    await click(`.session-library-match-banner [data-session-action="review-association"][data-from-patient-id="${source.id}"]`);
    for (const [name, width, height] of [['desktop', 1540, 1050], ['narrow', 430, 930]]) {
        await browser.send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: width < 600});
        if (width < 600) {await click('#toggle-library');await evaluate('(async()=>{await Promise.allSettled(window.__shadow.getElementById("library-panel").getAnimations({subtree:true}).map(item=>item.finished));return true;})()');}
        await evaluate('window.__shadow.querySelector(".session-library-association").scrollIntoView({block:"start"})');
        const bounds = await evaluate('(()=>{const panel=window.__shadow.getElementById("library-panel"),review=window.__shadow.querySelector(".session-library-association"),box=review.getBoundingClientRect();return{scrollWidth:panel.scrollWidth,clientWidth:panel.clientWidth,left:box.left,right:box.right,width:innerWidth};})()');assert.ok(bounds.scrollWidth <= bounds.clientWidth + 1);assert.ok(bounds.left >= 0 && bounds.right <= width + 1);await screenshot(`patient-association-review-${name}`);
    }
    record('exact-match review and confirmation remain readable in desktop and narrow session libraries');
    await browser.send('Emulation.setDeviceMetricsOverride', {width: 1540, height: 1050, deviceScaleFactor: 1, mobile: false});await click('.session-library-association input');assert.equal(await evaluate('window.__shadow.querySelector("[data-session-action=confirm-association]").disabled'), false);await click('[data-session-action="confirm-association"]');await idle();observed = await state();
    assert.equal(observed.catalog.counts.patients, 1);assert.equal(observed.catalog.counts.studies, 3);assert.equal(observed.catalog.activePatientId, target.id);assert.deepEqual(snapshotIds(observed.catalog), beforeIds);assert.deepEqual(observed.workspace.viewports, targetView.workspace.viewports);assert.equal(observed.annotations.count, 1);assert.deepEqual(observed.document, targetView.document);assert.ok(!JSON.stringify(observed.catalog).includes('Unchecked examination'));
    const targetCard = `.session-library-series[data-series-id="${target.studies[0].series[0].id}"]`;assert.deepEqual(await evaluate(`Array.from(window.__shadow.querySelector(${quote(targetCard)}).querySelectorAll('.session-library-pane-badge')).map(node=>node.textContent)`), ['Pane A', 'Pane B']);
    record('confirmed review combines only the three selected studies with stable study, series and instance IDs while retaining target views, pane badges and annotations');await screenshot('patient-studies-combined-desktop');
    for (const definition of studies.slice(0, 3)) {
        const study = observed.catalog.patients[0].studies.find(study => study.studyUid === `${uid}.${definition.number}`);await evaluate(`window.__v.openSessionStudy(${quote(study.id)})`);await idle();assert.deepEqual(await samples(0), [definition.base, definition.base + 10, definition.base + 20, definition.base + 30]);await verifyFramebuffer(0,[definition.base,definition.base+10,definition.base+20,definition.base+30]);await evaluate('window.__v.setFrame(1)');assert.deepEqual(await samples(0), [definition.base + 10, definition.base + 20, definition.base + 30, definition.base + 40]);
    }
    const combined = (await state()).catalog.patients[0], mr = combined.studies.find(study => study.studyUid === `${uid}.1`), ct = combined.studies.find(study => study.studyUid === `${uid}.3`);await evaluate('window.__v.setFrame(0)');await evaluate(`window.__v.compareSessionStudies(${quote(mr.id)},${quote(ct.id)})`);await idle();assert.deepEqual(await samples(0), [100, 110, 120, 130]);assert.deepEqual(await samples(1), [500, 510, 520, 530]);assert.equal((await state()).annotations.count, 1);assert.equal((await state()).document.annotations[0].image.sopUid, `${uid}.1.1.2`);assert.equal((await state()).document.annotations[0].image.seriesUid, `${uid}.1.1`);
    record('every associated study opens and compares using its original source image and measurement references');
    await evaluate('window.__v.importLocalFiles(window.__selectedCt())');await idle();observed = await state();assert.equal(observed.catalog.counts.patients, 1);assert.equal(observed.catalog.counts.studies, 3);assert.deepEqual(snapshotIds(observed.catalog), beforeIds);assert.ok(!JSON.stringify(observed.catalog).includes('Unchecked examination'));assert.equal(observed.annotations.count, 1);
    record('later selected-source imports reuse the combined patient and stable IDs without admitting the unchecked study');

    const positive = await evaluate('window.__checkHints({})');assert.deepEqual(positive, {banners: 1, badges: 1});
    for (const [name, patch] of Object.entries({remote: {kind: 'remote', source: {kind: 'remote', id: 'local'}}, foreign: {sourceId: 'other', source: {kind: 'local', id: 'other'}}, conflictingBirth: {patientBirthDate: '19800101'}, missingBirth: {patientBirthDate: ''}, partialName: {patientName: 'SYNTHETIC'}, missingIdentifier: {patientId: ''}, synthetic: {kind: 'test', synthetic: true}})) {
        assert.deepEqual(await evaluate(`window.__checkHints(${quote(patch)})`), {banners: 0, badges: 0}, name);
    }
    record('the actual browser panel suppresses automatic hints for remote, foreign-source, conflicting, incomplete and synthetic identities');

    await evaluate(`window.__v.removeSessionPatient(${quote(target.id)})`);await idle();observed = await state();assert.equal(observed.catalog.counts.patients, 0);assert.equal(await evaluate('window.__v.getLocalCatalog().counts.instances'), 0);assert.ok(observed.workspace.viewports.every(pane => !pane.assigned));await addMr();observed = await state();assert.equal(observed.catalog.counts.patients, 1);assert.equal(observed.catalog.counts.studies, 1);assert.notEqual(observed.catalog.patients[0].id, target.id);assert.equal(observed.annotations.count, 0);assert.equal(await evaluate('window.__shadow.querySelectorAll(".session-library-match-banner").length'), 0);
    record('closing the combined workspace releases all associated local records and reopening does not restore prior patients, studies or measurements');

    await evaluate('window.__reset()');({target, source} = await prepare());const sourceBefore = await state();assert.equal(sourceBefore.catalog.activePatientId, source.id);assert.equal(sourceBefore.annotations.count, 0);
    await evaluate(`window.__v.associateLocalPatient(${quote(source.provenance.patientId)},${quote(target.provenance.patientId)},{confirmed:true})`);await idle();observed = await state();assert.equal(observed.catalog.counts.patients, 1);assert.equal(observed.catalog.activePatientId, target.id);assert.deepEqual(observed.workspace.viewports, sourceBefore.workspace.viewports);assert.equal(observed.annotations.count, 1);assert.equal(observed.document.annotations[0].image.sopUid, `${uid}.1.1.2`);assert.deepEqual(await samples(0), [300, 310, 320, 330]);await evaluate(`window.__v.openSessionStudy(${quote(target.studies[0].id)})`);await idle();assert.deepEqual(await samples(0), [100, 110, 120, 130]);assert.equal((await state()).annotations.count, 1);
    record('the legacy SDK can associate an active source patient while preserving its image and restoring the target measurement document');
    const resources = await evaluate('(async()=>{window.__guard.dispose();window.__v.dispose();await window.__v.whenDisposed();return window.__v.getPerformance().resources;})()');assert.equal(resources.workerCount, 0);assert.equal(resources.encodedBytes, 0);assert.equal(resources.decodedCacheBytes, 0);
    assert.equal(browser.errors.length, 0, JSON.stringify(browser.errors));assert.equal(browser.consoleErrors.length, 0, JSON.stringify(browser.consoleErrors));assert.equal(browser.requests.filter(request => !['GET', 'HEAD'].includes(request.method)).length, 0);assert.equal(browser.requests.filter(request => !request.url.startsWith(origin) && !request.url.startsWith('data:') && !request.url.startsWith('blob:')).length, 0);assert.equal(await sourceDigest(root), buildInfo.sourceDigest);assert.equal(JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8')).sourceDigest, buildInfo.sourceDigest);
    record('generated patient-review qualification releases resources and makes no uploads or external requests and has no browser errors');
    await writeFile(resolve(output, 'results.json'), JSON.stringify({passed: checks.length, checks, sourceDigest: buildInfo.sourceDigest, harnessSha256: createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'), originalImagingFilesUsed: false, uploads: 0, externalRequests: 0, browserExceptions: 0, consoleErrors: 0}, null, 2) + '\n');console.log(`Patient match browser checks: ${checks.length} passed.`);
} catch (error) {
    if (browser) await screenshot('failure').catch(() => {});await writeFile(resolve(output, 'failure.json'), JSON.stringify({checks, error: {name: error.name, message: error.message, stack: error.stack}, browserExceptions: browser?.errors ?? [], consoleErrors: browser?.consoleErrors ?? []}, null, 2) + '\n');throw error;
} finally {browser?.close();await server?.close();if (temporary) await rm(temporary, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});}
