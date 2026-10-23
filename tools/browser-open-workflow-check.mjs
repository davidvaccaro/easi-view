import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createLocalLibraryFixtures } from '../test/local-library-fixtures.js';
import { createDicomdirMedia } from '../test/dicomdir-fixtures.js';
import { createDicomFixture } from '../src/data/synthetic.js';
import { browserSession, delay } from './browser-session.mjs';
import { startCorpusServer } from './local-corpus-check.mjs';
import { sourceDigest } from './source-digest.mjs';

// Every input is generated here. This harness never discovers, reads, copies or
// serves personal imaging files, and uses a disposable browser profile.
const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'artifacts/browser-open-workflow');
const fixtures = createLocalLibraryFixtures();
const media = createDicomdirMedia({multiPatient: true});
const quote = JSON.stringify, checks = [], remoteRequests = [], archiveBehavior = {retrieveDelayMs: 0};
const record = (name, details = {}) => { checks.push({name, ...details}); console.log(`PASS ${name}`); };
const encodeFixture = ({bytes, ...metadata}) => ({...metadata, encoded: Buffer.from(bytes).toString('base64')});
const attribute = (vr, ...Value) => ({Value, vr});
const uid = '2.25.996', sopClass = '1.2.840.10008.5.1.4.1.1.2';
const remoteStudy = index => ({
    '00080020': attribute('DA', index === 0 ? '20261019' : '20260901'), '00080030': attribute('TM', '100000'),
    '00080050': attribute('SH', index === 0 ? 'MATCH' : `PRIOR${index}`), '00080061': attribute('CS', 'CT'),
    '00081030': attribute('LO', `Synthetic remote examination ${index + 1}`),
    '00100010': attribute('PN', {Alphabetic: 'SYNTHETIC^REMOTE_ALPHA'}), '00100020': attribute('LO', 'REMOTE_ALPHA'),
    '00100021': attribute('LO', 'SYNTHETIC_REMOTE'), '00100030': attribute('DA', '19700101'),
    '0020000D': attribute('UI', `${uid}.${index + 1}`), '00201206': attribute('IS', '1'), '00201208': attribute('IS', '2')
});
const remoteStudies = Array.from({length: 27}, (_, index) => remoteStudy(index));
const json = (response, data) => { response.writeHead(200, {'Content-Type': 'application/dicom+json', 'Cache-Control': 'no-store'}); response.end(JSON.stringify(data)); };
const descriptors = studyUid => Array.from({length: 2}, (_, index) => ({
    '00100010': attribute('PN', {Alphabetic: 'SYNTHETIC^REMOTE_ALPHA'}), '00100020': attribute('LO', 'REMOTE_ALPHA'), '00100021': attribute('LO', 'SYNTHETIC_REMOTE'), '00100030': attribute('DA', '19700101'),
    '00080016': attribute('UI', sopClass), '00080018': attribute('UI', `${studyUid}.1.${index + 1}`),
    '00080060': attribute('CS', 'CT'), '0008103E': attribute('LO', 'Synthetic remote axial stack'),
    '0020000D': attribute('UI', studyUid), '0020000E': attribute('UI', `${studyUid}.1`),
    '00200013': attribute('IS', `${index + 1}`), '00200032': attribute('DS', 0, 0, index),
    '00200037': attribute('DS', 1, 0, 0, 0, 1, 0), '00200052': attribute('UI', `${uid}.99`),
    '00280002': attribute('US', 1), '00280004': attribute('CS', 'MONOCHROME2'), '00280008': attribute('IS', '1'),
    '00280010': attribute('US', 2), '00280011': attribute('US', 2), '00280030': attribute('DS', 1, 1),
    '00280100': attribute('US', 16), '00280101': attribute('US', 16), '00280102': attribute('US', 15), '00280103': attribute('US', 0),
    '00281050': attribute('DS', 512), '00281051': attribute('DS', 1024), '00281052': attribute('DS', 0), '00281053': attribute('DS', 1), '00281054': attribute('LO', 'HU'), '00281056': attribute('CS', 'LINEAR'),
    '7FE00010': {BulkDataURI: 'not-followed', vr: 'OW'}
}));

let browser, staticServer, proxy, temporary;
const evaluate = expression => browser.evaluate(expression);
const run = source => evaluate(`(async () => { ${source} })()`);
const click = selector => evaluate(`(() => { const node=window.__shadow.querySelector(${quote(selector)}); if(!node)throw new Error('Missing workflow control: '+${quote(selector)}); node.click(); })()`);
const action = (name, extra = '') => click(`[data-open-action="${name}"]${extra}`);
const state = () => evaluate('({view:window.__v.getState(),session:window.__v.getSessionState(),workflow:window.__v.getOpenWorkflowState(),annotations:window.__v.getAnnotationState(),workspace:window.__v.getWorkspaceState(),upload:window.__qa.uploads.at(-1),draws:window.__qa.draws,performance:window.__v.getPerformance()})');
const catalog = () => evaluate('window.__v.getSessionCatalog()');
const idle = () => browser.until('!window.__v.getOpenWorkflowState().busy&&!window.__v.getState().busy&&!window.__v.getSessionState().busy', 'The opening workflow did not finish.');
const screenshot = async name => { await browser.screenshot(name); await copyFile(resolve(temporary, 'chrome', `${name}.png`), resolve(output, `${name}.png`)); };
const inputFiles = async (keys, {kind = 'images', folder = false, collection = 'images'} = {}) => {
    await evaluate(`window.__v.open(${quote(kind)})`);
    await action(kind === 'study' ? 'pick-study-folder' : folder ? 'pick-images-folder' : 'pick-files');
    await evaluate(`(() => { const input=window.__shadow.getElementById(${quote(folder || kind === 'study' ? 'folder-input' : 'file-input')}),transfer=new DataTransfer(); for(const file of window.__files(${quote(keys)},${quote(collection)}))transfer.items.add(file);input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await idle();
};
const check = id => evaluate(`(() => { const box=window.__shadow.querySelector('[data-open-study='+CSS.escape(${quote(id)})+']');if(!box)throw new Error('Missing study checkbox');box.click(); })()`);
const filter = (name, value) => evaluate(`(() => { const field=window.__shadow.querySelector('[data-open-filter="${name}"]');if(!field)throw new Error('Missing patient criterion');field.value=${quote(value)};field.dispatchEvent(new Event('input',{bubbles:true})); })()`);
const findPatients = () => evaluate('window.__shadow.querySelector("[data-open-form=criteria]").requestSubmit()');

async function serveGeneratedArchive(request, response, url) {
    const path = url.pathname.slice('/dicom-web/'.length), offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 25);
    const log = {path, method: request.method, filters: Object.fromEntries(url.searchParams), offset, limit}; remoteRequests.push(log);
    response.on('close', () => { if (!response.writableEnded) log.aborted = true; });
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
    if (path === 'studies') {
        const patientId = url.searchParams.get('PatientID'), name = url.searchParams.get('PatientName');
        let selected = remoteStudies;
        if (name === 'PAGE') selected = Array.from({length: 26}, (_, index) => ({...remoteStudy(index), '00100010': attribute('PN', {Alphabetic: `SYNTHETIC^PAGE${index}`}), '00100020': attribute('LO', `PAGE${index}`), '0020000D': attribute('UI', `${uid}.100.${index + 1}`)}));
        else if (patientId && patientId !== 'REMOTE_ALPHA') selected = [];
        if (url.searchParams.get('StudyDate')) selected = selected.filter(study => study['00080020'].Value[0] === url.searchParams.get('StudyDate'));
        if (url.searchParams.get('AccessionNumber')) selected = selected.filter(study => study['00080050'].Value[0] === url.searchParams.get('AccessionNumber'));
        json(response, selected.slice(offset, offset + limit)); return;
    }
    const match = path.match(/^studies\/([^/]+)\/series(?:\/([^/]+)(?:\/(metadata|instances)(?:\/([^/]+))?)?)?$/);
    if (!match) { response.writeHead(404); response.end(); return; }
    const [, studyUid, seriesUid, operation, sopUid] = match;
    if (!seriesUid) { json(response, [{'0020000D': attribute('UI', studyUid), '0020000E': attribute('UI', `${studyUid}.1`), '00080060': attribute('CS', 'CT'), '0008103E': attribute('LO', 'Synthetic remote axial stack'), '00200011': attribute('IS', '1'), '00201209': attribute('IS', '2')}]); return; }
    if (operation === 'metadata' || operation === 'instances' && !sopUid) { json(response, descriptors(studyUid)); return; }
    if (operation === 'instances' && sopUid) {
        if (archiveBehavior.retrieveDelayMs) await delay(archiveBehavior.retrieveDelayMs);
        if (response.destroyed) return;
        const index = descriptors(studyUid).findIndex(item => item['00080018'].Value[0] === sopUid);
        if (index < 0) { response.writeHead(404); response.end(); return; }
        const bytes = createDicomFixture({rows: 2, columns: 2, values: [117 + index * 10, 137, 157, 177], sopUid, seriesUid, position: [0, 0, index], pixelSpacing: [1, 1], instanceNumber: index + 1, window: {center: 512, width: 1024}, extraAttributes: {'0020000D': ['UI', studyUid], '00200052': ['UI', `${uid}.99`], '00100010': ['PN', 'SYNTHETIC^REMOTE_ALPHA'], '00100020': ['LO', 'REMOTE_ALPHA'], '00100021': ['LO', 'SYNTHETIC_REMOTE'], '00100030': ['DA', '19700101']}});
        response.writeHead(200, {'Content-Type': 'application/dicom', 'Content-Length': bytes.length}); response.end(bytes); return;
    }
    response.writeHead(404); response.end();
}

try {
    await mkdir(output, {recursive: true}); await rm(resolve(output, 'results.json'), {force: true}); await rm(resolve(output, 'failure.json'), {force: true});
    const buildInfo = JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8'));
    assert.equal(buildInfo.sourceDigest, await sourceDigest(root), 'Rebuild the viewer before opening-workflow qualification.');
    temporary = await mkdtemp(join(tmpdir(), 'easi-view-open-workflow-browser-')); const host = resolve(temporary, 'host'); await mkdir(host);
    await writeFile(resolve(host, 'fixtures.json'), JSON.stringify({images: fixtures.map(encodeFixture), media: media.files.map(encodeFixture)}));
    await writeFile(resolve(host, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./host.css"></head><body><main id="mount"></main><script type="module" src="./host.js"></script></body></html>');
    await writeFile(resolve(host, 'host.css'), 'body{margin:0;background:#09121b}#mount{height:100dvh;width:100%}');
    await writeFile(resolve(host, 'host.js'), `
import {createViewer} from '/assets/easi-view.js';
const fixtures=await(await fetch('./fixtures.json')).json();
window.__qa={uploads:[],draws:0,events:[]};
const upload=WebGL2RenderingContext.prototype.texImage2D,draw=WebGL2RenderingContext.prototype.drawArrays;
WebGL2RenderingContext.prototype.texImage2D=function(...args){if(args[3]===2&&args[4]===2&&args[8]?.length===4)window.__qa.uploads.push({samples:Array.from(args[8]),slot:Number(this.canvas.closest('.workspace-pane')?.dataset.slot??0)});return upload.apply(this,args);};
WebGL2RenderingContext.prototype.drawArrays=function(...args){window.__qa.draws++;return draw.apply(this,args);};
const collections=Object.fromEntries(Object.entries(fixtures).map(([name,items])=>[name,new Map(items.map(item=>{const file=new File([Uint8Array.from(atob(item.encoded),c=>c.charCodeAt(0))],item.name);if(item.path)Object.defineProperty(file,'webkitRelativePath',{value:item.path});return[item.key,file];}))]));
window.__files=(keys,collection='images')=>keys.map(key=>collections[collection].get(key));
window.__reset=async options=>{if(window.__v){window.__v.dispose();await window.__v.whenDisposed();}window.__v=createViewer(document.getElementById('mount'),{initialDemo:null,...options});await window.__v.ready;window.__shadow=document.getElementById('mount').querySelector('easi-view-embed').shadowRoot;for(const type of ['sourcechange','librarychange','annotationchange','error'])window.__v.on(type,detail=>window.__qa.events.push({type,detail}));};
await window.__reset();window.__ready=true;
`);
    staticServer = await startCorpusServer({dist: resolve(root, 'dist'), host, styleHash: buildInfo.inlineStyleSha256});
    const internal = new URL(staticServer.url).origin;
    proxy = createServer(async (request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        try {
            if (url.pathname.startsWith('/dicom-web/')) { await serveGeneratedArchive(request, response, url); return; }
            const result = await fetch(`${internal}${url.pathname}${url.search}`, {method: request.method}); response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
        } catch { if (!response.headersSent) response.writeHead(500); response.end(); }
    });
    await new Promise((done, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', done); });
    const origin = `http://127.0.0.1:${proxy.address().port}`;
    browser = await browserSession(resolve(temporary, 'chrome'));
    await browser.send('Emulation.setDeviceMetricsOverride', {width: 1540, height: 1050, deviceScaleFactor: 1, mobile: false});
    await browser.send('Page.setInterceptFileChooserDialog', {enabled: true});
    await browser.send('Page.navigate', {url: `${origin}/qa-corpus/`}); await browser.until('window.__ready', 'Generated opening-workflow host did not mount.');

    let observed = await state(); assert.equal(observed.view.image, null); assert.equal(observed.session.patients, 0);
    const entrypoints = await evaluate('Array.from(window.__shadow.querySelectorAll("button")).filter(button=>button.getClientRects().length&&/^(Open|Add files|Add folder|Archive)/.test(button.textContent.trim())).map(button=>button.id)');
    assert.deepEqual(entrypoints, ['header-import']); await click('#header-import');
    assert.equal(await evaluate('window.__shadow.querySelectorAll("[data-open-action=images],[data-open-action=study],[data-open-action=test]").length'), 3); await screenshot('open-desktop'); await action('close');
    record('one visible Open launcher exposes exactly three intent paths without duplicate archive or import controls');

    await inputFiles(['current-lung-1', 'current-lung-2']); observed = await state(); assert.equal(observed.workflow.step, 'local-images'); assert.equal(observed.session.patients, 0); assert.equal(observed.view.image, null); assert.equal(observed.performance.resources.workerCount, 0); assert.equal(observed.upload, undefined); await action('close'); assert.equal((await state()).session.patients, 0);
    record('preview and Cancel leave the session empty and do not decode selected files');
    await inputFiles(['current-lung-1', 'current-lung-2']); await action('add'); await idle(); observed = await state(); assert.equal(observed.workflow.open, false); assert.equal(observed.view.frameCount, 2); assert.equal(observed.session.patients, 1); assert.deepEqual(observed.upload.samples, fixtures.find(item => item.key === 'current-lung-1').values); assert.ok(observed.draws > 0);
    record('extensionless selected files commit as one rendered two-instance series stack');
    await evaluate('window.__v.setFrame(1)'); observed = await state(); assert.equal(observed.view.frameIndex, 1); assert.deepEqual(observed.upload.samples, fixtures.find(item => item.key === 'current-lung-2').values);
    assert.equal(await evaluate('window.__shadow.getElementById("session-patient-banner").hidden'), false); assert.match(await evaluate('window.__shadow.getElementById("session-patient-banner").textContent'), /SYNTHETIC ALPHA.*ALPHA/);
    record('stack navigation renders independently declared second-instance samples and displays persistent patient identity');
    await evaluate('window.__v.addAnnotation({tool:"length",points:[{x:.5,y:.5},{x:1.5,y:.5}]})'); assert.equal((await state()).annotations.count, 1);
    let session = await catalog(), alpha = session.patients.find(patient => patient.patientId === 'ALPHA'), current = alpha.studies[0];
    await inputFiles(['prior', 'prior-soft', 'current-soft', 'other-patient']); assert.equal((await state()).session.patients, 1); await action('add'); await idle(); observed = await state(); assert.equal(observed.session.patients, 2); assert.equal(observed.view.frameIndex, 1); assert.equal(observed.annotations.count, 1);
    session = await catalog(); alpha = session.patients.find(patient => patient.issuerOfPatientId === 'SYNTHETIC_HOSPITAL_A'); const beta = session.patients.find(patient => patient.issuerOfPatientId === 'SYNTHETIC_HOSPITAL_B'), prior = alpha.studies.find(study => study.studyUid === fixtures.find(item => item.key === 'prior').studyUid);
    assert.ok(alpha && beta && prior); assert.notEqual(alpha.id, beta.id);
    record('additive imports preserve the active image and annotation while equal IDs from different issuers remain separate patients');
    await evaluate(`window.__v.compareSessionStudies(${quote(current.id)},${quote(prior.id)})`); observed = await state(); assert.equal(observed.workspace.layout, 2); assert.equal(observed.session.comparisonStudyId, prior.id); assert.equal(observed.annotations.count, 1); for (const field of ['slice','window','camera']) assert.equal(observed.workspace.synchronization[field], false);
    const comparisonBadges = await evaluate('Array.from(window.__shadow.querySelectorAll(".local-study-badge")).filter(node=>!node.hidden).map(node=>node.textContent)'); assert.ok(comparisonBadges.some(text => /CURRENT.*2026-10-16/.test(text))); assert.ok(comparisonBadges.some(text => /COMPARISON.*2026-09-01/.test(text))); await screenshot('session-comparison-desktop');
    record('explicit current and comparison studies render in separate labeled panes with automatic synchronization off');
    const priorSoft = prior.series.find(series => series.description === 'Axial soft tissue prior'), currentSoft = alpha.studies.find(study => study.id === current.id).series.find(series => series.description === 'Axial soft tissue'); assert.ok(priorSoft && currentSoft);
    await evaluate('window.__v.setActiveViewport(1)'); await evaluate(`window.__v.openSessionSeries(${quote(priorSoft.id)})`); observed = await state(); assert.equal(observed.workspace.layout, 2); assert.equal(observed.workspace.viewports[0].frameIndex, 1); assert.equal(observed.session.comparisonStudyId, prior.id); assert.equal(observed.upload.samples[0], 350);
    record('opening a comparison series replaces only the active pane and preserves the current-study image and comparison role');
    await evaluate('window.__v.setLayout(4)'); await evaluate('window.__v.setActiveViewport(2)'); await evaluate(`window.__v.openSessionSeries(${quote(currentSoft.id)})`); await evaluate('window.__v.setActiveViewport(3)'); await evaluate(`window.__v.openSessionSeries(${quote(prior.series[0].id)})`); observed = await state(); assert.equal(observed.workspace.layout, 4); assert.ok(observed.workspace.viewports.every(pane => pane.assigned)); assert.equal(observed.workspace.viewports[0].frameIndex, 1); assert.equal(observed.annotations.count, 1);
    record('series assignment fills a four-pane patient workspace without collapsing its layout or replacing existing panes');
    await evaluate(`window.__v.selectSessionPatient(${quote(beta.id)})`); assert.equal((await state()).annotations.count, 0); await evaluate(`window.__v.selectSessionPatient(${quote(alpha.id)})`); observed = await state(); assert.equal(observed.annotations.count, 1); assert.equal(observed.workspace.layout, 4); assert.ok(observed.workspace.viewports.every(pane => pane.assigned)); assert.equal(observed.workspace.viewports[0].frameIndex, 1); assert.equal(observed.session.comparisonStudyId, prior.id);
    record('switching patient workspaces isolates measurements and restores the prior comparison layout');

    await evaluate('window.__reset()');
    await inputFiles(media.files.map(file => file.key), {kind: 'study', collection: 'media'}); assert.equal((await state()).workflow.step, 'local-patients'); await action('patient'); observed = await state(); assert.equal(observed.workflow.step, 'local-studies'); assert.equal(observed.workflow.selectedStudyIds.length, 0);
    const selectedMediaStudy = await evaluate('window.__shadow.querySelector("[data-open-study]").dataset.openStudy'); await check(selectedMediaStudy); await action('add'); await idle(); session = await catalog(); assert.equal(session.counts.patients, 1); assert.equal(session.counts.studies, 1); assert.ok(!JSON.stringify(session).includes('Unreferenced decoy')); assert.ok(!session.patients.some(patient => patient.patientId === 'MEDIA_BETA'));
    record('DICOMDIR selection adds only the checked patient study and excludes unchecked studies, another patient and unreferenced images');
    await evaluate('window.__reset()'); await inputFiles(media.files.map(file => file.key), {folder: true, collection: 'media'}); assert.equal((await state()).workflow.step, 'local-images'); await action('add'); await idle(); session = await catalog(); assert.equal(session.counts.patients, 2); assert.equal(session.counts.studies, 4); assert.ok(JSON.stringify(session).includes('Unreferenced decoy'));
    record('Open Images scans exactly the selected folder contents, including a valid unreferenced image, without following DICOMDIR implicitly');

    await evaluate('window.__v.open("test")'); await action('open-test', '[data-test-id="us"]'); await idle(); observed = await state(); session = await catalog(); const testPatient = session.patients.find(patient => patient.synthetic); assert.ok(testPatient); assert.equal(observed.session.activePatientId ?? observed.session.patientId, testPatient.id); assert.ok(observed.view.frameCount > 1); assert.equal(await evaluate('window.__shadow.getElementById("session-patient-banner").dataset.synthetic'), 'true'); const cineStart = observed.view.frameIndex;
    await evaluate('window.__v.play()'); await browser.until(`window.__v.getState().frameIndex!==${cineStart}`, 'Synthetic ultrasound cine did not advance.'); await evaluate('window.__v.pause()'); await evaluate('window.__v.setFrame(2)'); assert.equal((await state()).view.frameIndex, 2);
    record('synthetic ultrasound opens an isolated labeled test workspace with frame selection and working cine playback');

    await evaluate('window.__reset()');
    await evaluate(`window.__v.registerSource({id:"generated-pacs",name:"Generated research archive",type:"dicomweb",baseUrl:${quote(`${origin}/dicom-web/`)}})`); await evaluate('window.__v.open("study")'); await action('remote'); assert.match(await evaluate('window.__shadow.querySelector(".open-workflow-body").textContent'), /Generated research archive/); await action('source'); await filter('patientName', 'PAGE'); await findPatients(); await idle(); assert.equal((await state()).workflow.patientCount, 25); await action('patients-next'); await idle(); assert.equal((await state()).workflow.patientOffset, 25); assert.equal((await state()).workflow.patientCount, 1);
    record('configured remote repositories use bounded patient-result paging with truthful page state');
    await action('back'); await filter('patientName', ''); await filter('patientId', 'REMOTE_ALPHA'); await filter('studyDate', '2026-10-19'); await findPatients(); await idle(); assert.equal((await state()).workflow.patientCount, 1); const beforePatientQuery = remoteRequests.length; await action('patient'); await idle(); const refreshedQuery = remoteRequests.slice(beforePatientQuery).find(request => request.path === 'studies'); assert.ok(refreshedQuery); assert.equal(refreshedQuery.filters.PatientID, 'REMOTE_ALPHA'); assert.equal(refreshedQuery.filters.StudyDate, undefined); assert.equal(refreshedQuery.filters.AccessionNumber, undefined);
    record('selecting a remote patient issues a fresh patient study query without carrying the initial study-date restriction');
    let remoteCheckbox = await evaluate('window.__shadow.querySelector("[data-open-study]").dataset.openStudy'); await check(remoteCheckbox); await action('studies-next'); await idle(); const secondRemoteCheckbox = await evaluate('window.__shadow.querySelector("[data-open-study]").dataset.openStudy'); await check(secondRemoteCheckbox); assert.equal((await state()).workflow.selectedStudyIds.length, 2); await screenshot('remote-study-selection'); await action('add'); await idle(); session = await catalog(); const remotePatient = session.patients.find(patient => patient.sourceId === 'generated-pacs'); assert.equal(remotePatient.studies.length, 2); assert.equal(remotePatient.studies.filter(study => study.seriesLoaded).length, 1);
    record('study checkboxes survive paging and add exactly the two checked remote examinations');
    const unopenedRemote = remotePatient.studies.find(study => !study.seriesLoaded); await evaluate(`window.__v.openSessionStudy(${quote(unopenedRemote.id)})`); observed = await state(); assert.equal(observed.view.frameCount, 2); assert.equal(observed.upload.samples[0], 117); assert.equal(observed.view.sourceType, 'archive'); await evaluate('window.__v.setFrame(1)'); assert.equal((await state()).upload.samples[0], 127);
    record('an admitted remote study retrieves, parses and renders the generated DICOMweb stack on demand');
    await evaluate('window.__v.openFiles(window.__files(["other-patient"]))'); observed = await state(); assert.equal(observed.upload.samples[0], 600); assert.equal(observed.session.activePatientId, null); assert.equal(await evaluate('window.__shadow.getElementById("session-patient-banner").hidden'), true);
    record('legacy SDK file replacement detaches patient-session identity so a new source never inherits an old patient banner');
    await evaluate('window.__v.importLocalFiles(window.__files(["current-lung-1","current-lung-2"]))'); session = await catalog(); const legacyPatient = session.patients.find(patient => patient.issuerOfPatientId === 'SYNTHETIC_HOSPITAL_A'); assert.ok(legacyPatient); await evaluate(`window.__v.selectSessionPatient(${quote(legacyPatient.id)})`); observed = await state(); assert.equal(observed.view.frameCount, 2); assert.equal(observed.upload.samples[0], 100);
    record('legacy additive import interoperates with the unified session catalog and patient-opening API');
    await evaluate(`window.__v.configureArchive({baseUrl:${quote(`${origin}/dicom-web/`)}})`); assert.equal((await state()).session.activePatientId, legacyPatient.id);
    const verifiedReference = {archiveKey:'generated-legacy',studyUid:`${uid}.1`,seriesUid:`${uid}.1.1`,sopUid:`${uid}.1.1.1`};
    const viewingContext = {version:1,layout:1,activeViewport:0,viewports:[{slot:0,reference:verifiedReference,frameIndex:0,originalFrameNumber:1}]};
    await evaluate(`window.__v.applyStudyContext(${quote(viewingContext)},{archiveKey:'generated-legacy',scope:${quote(verifiedReference)}})`); observed = await state(); assert.equal(observed.session.activePatientId, null); assert.equal(await evaluate('window.__shadow.getElementById("session-patient-banner").hidden'), true); assert.equal(observed.upload.samples[0], 117);
    const exportedContext = await evaluate('window.__v.exportStudyContext({archiveKey:"generated-legacy"})'); assert.equal(exportedContext.viewports[0].reference.sopUid, verifiedReference.sopUid); assert.equal(exportedContext.viewports[0].originalFrameNumber, 1);
    const scopeRejected = await evaluate(`window.__v.applyStudyContext(${quote(viewingContext)},{archiveKey:'generated-legacy',scope:{archiveKey:'generated-legacy',studyUid:'2.25.996.999'}}).then(()=>false,error=>/scope/.test(error.message))`); assert.equal(scopeRejected, true); assert.equal((await state()).upload.samples[0], 117);
    record('host-scoped study context replacement detaches the old patient identity, round-trips original frame references and rejects an out-of-scope restore');

    await evaluate('window.__reset()'); await evaluate('window.__v.open("test")'); await action('open-test', '[data-test-id="us"]'); await idle(); const beforeCancel = await state();
    await evaluate(`window.__v.registerSource({id:"slow-pacs",name:"Generated slow archive",type:"dicomweb",baseUrl:${quote(`${origin}/dicom-web/`)}})`); await evaluate('window.__v.open("study")'); await action('remote'); await action('source'); await filter('patientId', 'REMOTE_ALPHA'); await findPatients(); await idle(); await action('patient'); await idle(); const slowStudy = await evaluate('window.__shadow.querySelector("[data-open-study]").dataset.openStudy'); await check(slowStudy); archiveBehavior.retrieveDelayMs = 1000; const beforeRequests = remoteRequests.length; await action('add');
    for (let attempt = 0; attempt < 100 && !remoteRequests.slice(beforeRequests).some(request => /instances\/[^/]+$/.test(request.path)); attempt++) await delay(30);
    assert.ok(remoteRequests.slice(beforeRequests).some(request => /instances\/[^/]+$/.test(request.path)), 'The cancellation case must reach an actual pixel request.'); await action('close'); await idle(); observed = await state(); assert.equal(observed.session.activePatientId, beforeCancel.session.activePatientId); assert.equal(observed.view.sourceType, beforeCancel.view.sourceType); assert.equal(observed.view.frameCount, beforeCancel.view.frameCount); await delay(1100); assert.equal((await state()).session.activePatientId, beforeCancel.session.activePatientId); assert.ok(remoteRequests.slice(beforeRequests).some(request => request.aborted)); archiveBehavior.retrieveDelayMs = 0;
    record('Cancel interrupts an actual delayed remote pixel request and preserves the previous synthetic patient workspace without a late commit');

    await browser.send('Emulation.setDeviceMetricsOverride', {width: 430, height: 930, deviceScaleFactor: 1, mobile: true}); await evaluate('window.__v.open()'); await screenshot('open-narrow');
    const bounds = await evaluate('(()=>{const dialog=window.__shadow.querySelector(".open-workflow"),box=dialog.getBoundingClientRect();return{left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:innerWidth,height:innerHeight,scrollWidth:dialog.scrollWidth,clientWidth:dialog.clientWidth};})()'); assert.ok(bounds.left >= 0 && bounds.right <= bounds.width + 1 && bounds.top >= 0 && bounds.bottom <= bounds.height + 1); assert.ok(bounds.scrollWidth <= bounds.clientWidth + 1); await action('close');
    record('the opening dialog remains usable inside a narrow viewport without horizontal overflow');
    await evaluate('window.__reset({ui:{demos:false},opening:{localImages:true,localStudies:false,remoteStudies:false,tests:false}})'); await evaluate('window.__v.open()'); assert.equal(await evaluate('window.__shadow.querySelectorAll("[data-open-action=test]").length'), 0); assert.equal(await evaluate('window.__shadow.querySelectorAll("[data-open-action=study]").length'), 0); await action('close');
    record('embedding policy removes disabled opening pathways and synthetic tests');
    const final = await run('window.__v.dispose();await window.__v.whenDisposed();return window.__v.getPerformance();'); assert.equal(final.resources.workerCount, 0); assert.equal(final.resources.encodedBytes, 0); assert.equal(final.resources.decodedCacheBytes, 0);
    record('disposing the viewer releases every generated image worker and pixel resource');
    assert.equal(browser.errors.length, 0, JSON.stringify(browser.errors)); assert.equal(browser.consoleErrors.length, 0, JSON.stringify(browser.consoleErrors));
    assert.equal(browser.requests.filter(request => !['GET', 'HEAD'].includes(request.method)).length, 0); assert.equal(browser.requests.filter(request => !request.url.startsWith(origin) && !request.url.startsWith('data:') && !request.url.startsWith('blob:')).length, 0);
    assert.equal(JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8')).sourceDigest, buildInfo.sourceDigest); assert.equal(await sourceDigest(root), buildInfo.sourceDigest, 'Source inputs changed during browser qualification.');
    record('qualification produces zero uploads, external requests, browser exceptions or console errors and matches the built source digest');
    await writeFile(resolve(output, 'results.json'), JSON.stringify({passed: checks.length, checks, sourceDigest: buildInfo.sourceDigest, harnessSha256: createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'), originalImagingFilesUsed: false, uploads: 0, externalRequests: 0, browserExceptions: 0, consoleErrors: 0, remoteRequests}, null, 2) + '\n');
    console.log(`Opening workflow browser checks: ${checks.length} passed.`);
} catch (error) {
    if (browser) await screenshot('failure').catch(() => {});
    await writeFile(resolve(output, 'failure.json'), JSON.stringify({checks, error: {name: error.name, message: error.message, stack: error.stack}, browserExceptions: browser?.errors ?? [], consoleErrors: browser?.consoleErrors ?? [], remoteRequests}, null, 2) + '\n'); throw error;
} finally {
    browser?.close(); if (proxy) { proxy.closeAllConnections(); await new Promise(done => proxy.close(done)); } await staticServer?.close();
    if (temporary) await rm(temporary, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
}
