import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm, stat, copyFile } from 'node:fs/promises';
import { resolve, join, dirname, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { browserSession, delay } from './browser-session.mjs';

// Qualification of the shipped standalone application, without a test-only app
// entry point. Invented removable media enters Chrome's native File API; fetch,
// file reading, rendering and the actual opening workflow remain unchanged.
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const root = resolve(option('--source-root') ?? resolve(import.meta.dirname, '..'));
const output = resolve(option('--output') ?? resolve(root, 'artifacts/browser-base-release'));
const quote = JSON.stringify, checks = [];
const fromRoot = name => import(pathToFileURL(resolve(root, name)));
const record = (name, details = {}) => { checks.push({ name, ...details }); console.log(`PASS ${name}`); };
let browser, server, temporary, origin, build, phase = 'startup';
const evaluate = expression => browser.evaluate(expression);

async function click(selector) {
    const point = await evaluate(`(() => {const n=document.querySelector(${quote(selector)});if(!n||n.hidden||n.disabled)return null;n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return r.width&&r.height?{x:r.left+r.width/2,y:r.top+r.height/2}:null;})()`);
    assert.ok(point, `A required standalone control is unavailable: ${selector}`);
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
}

async function snapshot() {
    return evaluate(`(() => ({layout:Number(document.querySelector('#workspace').dataset.layout),session:document.querySelector('#session-summary').textContent,panes:[...document.querySelectorAll('.workspace-pane')].map(p=>({slot:Number(p.dataset.slot),empty:!p.querySelector('[data-pane-id=viewport-empty]').hidden,frame:p.querySelector('[data-pane-id=frame-overlay]').textContent})),annotations:Number(document.querySelector('#inspector-measurement-count').textContent||0)}))()`);
}

async function enterFiles(kind, paths) {
    await click('#header-import');
    await click(`[data-open-action="${kind === 'study' ? 'study' : 'images'}"]`);
    await browser.send('Page.setInterceptFileChooserDialog', { enabled: true });
    await click(`[data-open-action="${kind === 'study' ? 'pick-study-folder' : 'pick-files'}"]`);
    const result = await browser.send('Runtime.evaluate', { expression: `document.querySelector(${quote(kind === 'study' ? '#folder-input' : '#file-input')})`, returnByValue: false });
    await browser.send('DOM.setFileInputFiles', { objectId: result.result.objectId, files: paths });
}

async function selectPatient(number) {
    const id = await evaluate(`[...document.querySelectorAll('[data-open-action="patient"]')].find(n=>n.textContent.includes('FLOW_${number}'))?.dataset.patientId`);
    assert.ok(id, 'The generated media patient was not offered.');
    await click(`[data-open-action="patient"][data-patient-id=${quote(id)}]`);
    await browser.until('document.querySelector(".open-workflow-title").textContent==="Choose studies"', 'Local studies did not appear.');
}

async function addReviewed() {
    const paints = await evaluate('window.__baseReleaseQa.paints.filter(p=>p.phase==="add").length');
    await click('[data-open-action="add"]');
    await browser.until(`window.__baseReleaseQa.paints.filter(p=>p.phase==='add').length>${paints}`, 'The final Add operation did not paint a blocking overlay.');
    await browser.until('!document.querySelector(".open-workflow").open', 'The final Add operation did not finish.', 300);
}

async function startServer() {
    const dist = resolve(root, 'dist');
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8' };
    server = createServer(async (request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'sha256-${build.inlineStyleSha256}'; connect-src 'self'; worker-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
        if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
        let target;
        try {
            const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
            target = resolve(dist, '.' + (path === '/' ? '/index.html' : path));
            if (!target.startsWith(dist + sep) || !(await stat(target)).isFile()) throw new Error();
            const bytes = await readFile(target);
            response.writeHead(200, { 'Content-Type': types[extname(target)] ?? 'application/octet-stream', 'Content-Length': bytes.length });
            response.end(request.method === 'HEAD' ? undefined : bytes);
        } catch { response.writeHead(404); response.end(); }
    });
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
    origin = `http://127.0.0.1:${server.address().port}`;
}

try {
    await mkdir(output, { recursive: true });
    for (const name of ['results.json', 'failure.json', 'standalone-synthetic-ultrasound.png']) await rm(resolve(output, name), { force: true });
    build = JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8'));
    const { sourceDigest } = await fromRoot('tools/source-digest.mjs');
    assert.equal(build.sourceDigest, await sourceDigest(root), 'Build the frozen release source before browser qualification.');
    assert.equal(typeof globalThis.document, 'undefined');
    const sdk = await fromRoot('dist/assets/easi-view.js');
    assert.deepEqual(Object.keys(sdk), ['createEnterpriseViewer', 'createViewer', 'evaluateReadingProtocol', 'getDefaultReadingProtocols', 'normalizeReadingProtocol', 'normalizeReadingProtocols']);
    assert.equal(typeof sdk.createViewer, 'function');
    assert.equal(typeof globalThis.document, 'undefined');
    record('the published SDK imports in Node without a DOM and exports the viewer factories and reading-protocol helpers');
    temporary = await mkdtemp(join(tmpdir(), 'easi-view-base-release-'));
    const { createOpeningStudyMedia } = await fromRoot('test/fixtures/opening-study-media.js');
    const saveMedia = async (options, name) => {
        const folder = resolve(temporary, name); await mkdir(folder);
        for (const file of createOpeningStudyMedia(options).files) {
            const path = resolve(folder, file.path); await mkdir(dirname(path), { recursive: true }); await writeFile(path, file.bytes);
        }
        return folder;
    };
    const media = await saveMedia({}, 'GENERATED-MEDIA');
    const slow = await saveMedia({ instancesPerStudy: 10 }, 'GENERATED-SLOW-MEDIA');
    const bad = await saveMedia({ malformed: true }, 'GENERATED-BAD-MEDIA');
    const { makeDemoFiles } = await fromRoot('src/data/synthetic.js');
    const ultrasound = resolve(temporary, 'GENERATED_US_WITHOUT_EXTENSION');
    await writeFile(ultrasound, Buffer.from(await makeDemoFiles('us')[0].arrayBuffer()));
    await startServer();
    browser = await browserSession(resolve(temporary, 'chrome'));
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1050, deviceScaleFactor: 1, mobile: false });
    await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await browser.send('Page.navigate', { url: origin + '/' });
    await browser.until('document.readyState==="complete"&&Boolean(document.querySelector("#header-import"))', 'The standalone release did not mount.');
    assert.equal(await evaluate('Function.prototype.toString.call(fetch).includes("[native code]")'), true);
    assert.equal(await evaluate('document.querySelectorAll("#header-ai-assist,.ai-assist,[data-primary-action=ai]").length'), 0);
    assert.equal(await evaluate('document.querySelector("#viewport-empty strong").textContent'), 'Open a Study or Image');
    assert.equal(browser.requests.filter(r => /viewer-config\.json|\/api\/ai|openai|bedrock|login|transcrib|completions|responses/i.test(r.url)).length, 0);
    record('the shipped standalone opens directly to an empty session with native fetch, no AI controls and no configuration, authentication or model request');
    const embedded = await evaluate(`(async () => {
        const {createViewer}=await import('/assets/easi-view.js'),mount=document.createElement('div');mount.hidden=true;document.body.append(mount);
        let rejected=false;try{createViewer(mount,{ai:false});}catch(error){rejected=/ai/.test(error.message);}
        const untouched=mount.children.length===0,viewer=createViewer(mount,{initialDemo:null});await viewer.ready;
        const removed=['openAiAssist','closeAiAssist','cancelAiAssist','getAiState','getAiDraft'].every(name=>!(name in viewer)),noAiState=!('ai' in viewer.getState());
        let eventRejected=false;try{viewer.on('aichange',()=>{});}catch{eventRejected=true;}
        viewer.dispose();await viewer.whenDisposed();const disposed=mount.children.length===0;mount.remove();
        return{rejected,untouched,removed,noAiState,eventRejected,disposed};
    })()`);
    assert.deepEqual(embedded, { rejected: true, untouched: true, removed: true, noAiState: true, eventRejected: true, disposed: true });
    record('embedded options reject AI configuration before mounting; ready state, methods and events contain no AI experiment and disposal releases the host');
    await evaluate(`(() => {
        const q=window.__baseReleaseQa={paints:[],transitions:[],last:''};
        const sample=paint=>{const d=document.querySelector('.open-workflow'),p=d?.querySelector('.open-workflow-progress'),c=d?.querySelector('.open-workflow-content'),s=d?.querySelector('.open-workflow-stage');if(!d?.open||!p||p.hidden||!c?.inert)return;
            const label=d.querySelector('.open-workflow-progress-label')?.textContent??'',phase=label.startsWith('Adding')?'add':'index',entry={phase,inert:c.inert,busy:d.getAttribute('aria-busy')==='true',stageBusy:s.dataset.busy==='true',cancelEnabled:[...d.querySelectorAll('[data-open-action=close]')].some(n=>!n.disabled),paint};
            const key=JSON.stringify(entry);if(phase==='index'&&q.cancelNextIndex){q.cancelNextIndex=false;setTimeout(()=>{q.cancelWasBusy=d.getAttribute('aria-busy')==='true';const button=d.querySelector('.open-workflow-footer [data-open-action=close]');if(button&&!button.disabled)button.click();q.cancelDone=true;},0);}
            if(paint){if(q.paints.length<1000)q.paints.push(entry);}else if(key!==q.last){q.last=key;q.transitions.push(entry);}};
        new MutationObserver(()=>sample(false)).observe(document.documentElement,{subtree:true,childList:true,attributes:true});const frame=()=>{sample(true);requestAnimationFrame(frame);};requestAnimationFrame(frame);
    })()`);

    phase = 'cancel-index';
    const empty = await snapshot();
    await evaluate('Object.assign(window.__baseReleaseQa,{cancelNextIndex:true,cancelDone:false,cancelWasBusy:false})');
    await enterFiles('study', [slow]);
    await browser.until('window.__baseReleaseQa.cancelDone', 'The painted indexing overlay did not offer its real Cancel control.');
    assert.equal(await evaluate('window.__baseReleaseQa.cancelWasBusy'), true);
    await browser.until('!document.querySelector(".open-workflow").open', 'Cancel indexing did not close the workflow.');
    await delay(250); assert.deepEqual(await snapshot(), empty);
    record('native folder confirmation paints an inert indexing overlay; cancellation while busy preserves the empty session');

    phase = 'index-error';
    await enterFiles('study', [bad]);
    await browser.until('!document.querySelector(".open-workflow-error").hidden&&document.querySelector(".open-workflow-progress").hidden', 'Malformed media did not return an unblocked error.');
    assert.equal(await evaluate('document.querySelector(".open-workflow-content").inert'), false);
    assert.equal(await evaluate('document.querySelector(".open-workflow").getAttribute("aria-busy")'), 'false');
    await click('.open-workflow-footer [data-open-action="close"]');
    assert.deepEqual(await snapshot(), empty);
    record('a malformed generated DICOMDIR releases the overlay and inert state without adding studies');

    phase = 'bulk-selection';
    await enterFiles('study', [media]);
    await browser.until('document.querySelector(".open-workflow-title")?.textContent==="Choose a patient"', 'The native media folder did not finish indexing.', 300);
    await selectPatient(1);
    assert.equal(await evaluate('document.querySelectorAll("[data-open-study]").length'), 25);
    await click('[data-open-select-all]');
    assert.match(await evaluate('document.querySelector("[data-open-action=add]").textContent'), /30/);
    await click('[data-open-action="studies-next"]');
    assert.equal(await evaluate('document.querySelectorAll("[data-open-study]").length'), 5);
    assert.equal(await evaluate('[...document.querySelectorAll("[data-open-study]")].every(n=>n.checked)'), true);
    await click('[data-open-action="clear-studies"]');
    assert.equal(await evaluate('document.querySelector("[data-open-action=add]").disabled'), true);
    await click('[data-open-study]');
    assert.equal(await evaluate('document.querySelector("[data-open-select-all]").indeterminate'), true);
    assert.equal(await evaluate('document.querySelector("[data-open-select-all]").getAttribute("aria-checked")'), 'mixed');
    await click('[data-open-select-all]');
    assert.match(await evaluate('document.querySelector("[data-open-action=add]").textContent'), /30/);
    await click('[data-open-action="back"]'); await selectPatient(2);
    assert.equal(await evaluate('document.querySelector("[data-open-action=add]").disabled'), true);
    await click('[data-open-select-all]');
    assert.match(await evaluate('document.querySelector("[data-open-action=add]").textContent'), /2 studies/);
    await click('[data-open-action="back"]'); await selectPatient(1); await click('[data-open-select-all]');
    await addReviewed();
    assert.match((await snapshot()).session, /1 patient · 30 studies/);
    record('Select all covers thirty local studies across pages; Clear, mixed state and patient isolation remain correct');
    const paints = await evaluate('window.__baseReleaseQa.paints');
    for (const phase of ['index', 'add']) assert.ok(paints.some(p => p.phase === phase && p.inert && p.busy && p.stageBusy && p.cancelEnabled));
    record('indexing and final Add each paint a blocking overlay with accessible Cancel before heavy work');

    phase = 'ultrasound';
    await click('#primary-menu-toggle'); await click('#primary-menu-close');
    await browser.until('document.querySelector("#viewport-empty").hidden===false', 'Closing the session did not clear the image.');
    await enterFiles('images', [ultrasound]);
    await browser.until('document.querySelector(".open-workflow-title")?.textContent==="Review selected images"', 'The extensionless generated US file did not enter review.', 300);
    await addReviewed();
    await browser.until('document.querySelector("#modality-badge").textContent==="US"&&/\\/\\s*24/.test(document.querySelector("#frame-overlay").textContent)&&!document.querySelector("#image-stage").classList.contains("frame-loading")', 'The generated US clip did not display.');
    await evaluate('(()=>{const n=document.querySelector("#frame-slider");n.value="23";n.dispatchEvent(new Event("input",{bubbles:true}));})()');
    await browser.until('/Image\\s+24\\s*\\/\\s*24/.test(document.querySelector("#frame-overlay").textContent)', 'The final ultrasound frame did not display.');
    await click('#cine-toggle');
    await browser.until('document.querySelector("#cine-toggle").getAttribute("aria-pressed")==="true"&&Number(document.querySelector("#frame-slider").value)<23', 'The ultrasound clip did not play through its frame boundary.');
    await click('#cine-toggle');
    assert.equal(await evaluate('document.querySelector("#cine-toggle").getAttribute("aria-pressed")'), 'false');
    assert.equal(await evaluate('document.querySelector("#error-banner").hidden'), true);
    record('an extensionless native local ultrasound file displays all twenty-four frames, plays across the final-frame boundary and pauses');
    await browser.screenshot('standalone-synthetic-ultrasound');
    await copyFile(resolve(temporary, 'chrome/standalone-synthetic-ultrasound.png'), resolve(output, 'standalone-synthetic-ultrasound.png'));

    phase = 'boundary';
    const unexpected = browser.requests.filter(r => !r.url.startsWith(origin + '/') && !r.url.startsWith('blob:') && !r.url.startsWith('data:'));
    const writes = browser.requests.filter(r => !['GET', 'HEAD'].includes(r.method));
    const forbidden = browser.requests.filter(r => /viewer-config\.json|\/api\/ai|openai|bedrock|login|transcrib|completions|responses/i.test(r.url));
    assert.equal(unexpected.length, 0); assert.equal(writes.length, 0); assert.equal(forbidden.length, 0);
    assert.equal(browser.errors.length, 0, JSON.stringify(browser.errors));
    assert.equal(browser.consoleErrors.length, 0, JSON.stringify(browser.consoleErrors));
    assert.equal(await evaluate('Function.prototype.toString.call(fetch).includes("[native code]")'), true);
    assert.equal(build.sourceDigest, await sourceDigest(root), 'Source inputs changed during browser qualification.');
    record('the shipped viewer makes zero uploads, external, AI, authentication or configuration requests and raises no browser errors');
    const version = await browser.send('Browser.getVersion');
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ passed: checks.length, checks, sourceDigest: build.sourceDigest, version: build.version, easiJsVersion: build.easiJsVersion,
        harnessSha256: createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'), browser: version.product, nativeFileApi: true, nativeFetch: true,
        originalImagingFilesUsed: false, uploads: 0, externalRequests: 0, aiRequests: 0, configurationRequests: 0, authenticationRequests: 0, browserExceptions: 0, consoleErrors: 0,
        capturedNetworkRequests: browser.requests.length, syntheticScreenshots: ['standalone-synthetic-ultrasound.png'] }, null, 2) + '\n');
    console.log(`Base release browser checks: ${checks.length} passed.`);
} catch (error) {
    await mkdir(output, { recursive: true });
    await writeFile(resolve(output, 'failure.json'), JSON.stringify({ phase, checks, sourceDigest: build?.sourceDigest, error: { name: error.name, message: error.message },
        browserExceptions: browser?.errors.length ?? null, consoleErrors: browser?.consoleErrors ?? [], originalImagingFilesUsed: false, genuineProviderUsed: false }, null, 2) + '\n');
    throw error;
} finally {
    browser?.close();
    if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
    if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
