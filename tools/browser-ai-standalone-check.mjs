import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {tmpdir, homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {browserSession} from './browser-session.mjs';

// Qualify the shipped standalone application, not an SDK mount. The page's
// native fetch is never replaced, bound, or wrapped. CDP observes only bounded
// AI test requests; login credentials, cookies and model text are not retained.
const args = process.argv.slice(2), option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const root = resolve(option('--source-root') ?? resolve(import.meta.dirname, '..'));
const origin = new URL(option('--origin') ?? 'http://127.0.0.1:5188').origin;
if (!['http://127.0.0.1:5188', 'http://localhost:5188'].includes(origin) && !origin.startsWith('https://')) throw new Error('Use HTTPS or the explicit loopback demonstration service.');
const output = resolve(option('--output') ?? resolve(root, 'artifacts/browser-ai-standalone'));
const accessFile = resolve(option('--passcode-file') ?? join(homedir(), '.config/easi-view/ai-demo-access.json'));
const checks = [], calls = [], requestIndex = new Map(), loginRequests = [], loginRequestIndex = new Map();
let browser, temporary, nativeFetchId, build;
const quote = JSON.stringify, evaluate = expression => browser.evaluate(expression);
const record = (name, details = {}) => { checks.push({name, ...details}); console.log(`PASS ${name}`); };

async function click(selector) {
    const point = await evaluate(`(() => { const element = document.querySelector(${quote(selector)}); if (!element || element.hidden || element.disabled) return null; element.scrollIntoView({block: 'center'}); const box = element.getBoundingClientRect(); return box.width && box.height ? {x: box.left + box.width / 2, y: box.top + box.height / 2} : null; })()`);
    assert.ok(point, `The expected standalone control must be visible and enabled: ${selector}`);
    await browser.send('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', clickCount: 1, ...point});
    await browser.send('Input.dispatchMouseEvent', {type: 'mouseReleased', button: 'left', clickCount: 1, ...point});
}

async function viewerReady() {
    await browser.until('Boolean(document.querySelector("#header-ai-assist") && !document.querySelector("#header-ai-assist").hidden)', 'The standalone AI viewer did not mount.');
    const result = await browser.send('Runtime.evaluate', {expression: 'globalThis.fetch', returnByValue: false});
    nativeFetchId = result.result.objectId;
    await assertNativeFetch();
}

async function assertNativeFetch() {
    const result = await browser.send('Runtime.callFunctionOn', {objectId: nativeFetchId, functionDeclaration: 'function () { return this === globalThis.fetch && Function.prototype.toString.call(this).includes("[native code]"); }', returnByValue: true});
    assert.equal(result.result?.value, true, 'The standalone application must keep its original native fetch function.');
}

async function settled() {
    await browser.until('Boolean(document.querySelector(".ai-assist-error") && (!document.querySelector(".ai-assist-error").hidden || document.querySelector(".ai-assist-status").textContent.includes("Connection succeeded")))', 'The standalone connection test did not complete.', 650);
}

async function loginDiagnostics() {
    let page = {currentPath: null, errorCategory: 'unavailable'};
    try {
        page = await evaluate(`(() => { const status = document.querySelector('#login #status')?.textContent ?? ''; return {currentPath: location.pathname, errorCategory: status.includes('Too many attempts') ? 'rate-limited' : status.includes('invitation could not be verified') ? 'invitation-rejected' : status.includes('service is unavailable') ? 'service-unavailable' : status.includes('Checking invitation') ? 'checking-invitation' : 'none'}; })()`);
    } catch { /* A document may be navigating; never capture its URL/query. */ }
    return {postCount: loginRequests.length, responses: loginRequests.map(request => ({status: request.status})), ...page};
}

try {
    await mkdir(output, {recursive: true});
    await rm(resolve(output, 'results.json'), {force: true}); await rm(resolve(output, 'failure.json'), {force: true});
    const {sourceDigest} = await import(pathToFileURL(resolve(root, 'tools/source-digest.mjs')));
    build = await (await fetch(`${origin}/build-info.json`, {redirect: 'error'})).json();
    assert.equal(build.sourceDigest, await sourceDigest(root), 'The live standalone viewer must match the current source fingerprint.');
    const response = await fetch(`${origin}/viewer-config.json`, {redirect: 'error'}); assert.equal(response.status, 200);
    const {ai: profile} = await response.json();
    assert.equal(profile.enabled, true); assert.equal(new URL(profile.baseUrl, origin).origin, origin);
    assert.ok(typeof profile.model === 'string' && profile.model.length > 0);
    if (option('--expected-model')) assert.equal(profile.model, option('--expected-model'));
    temporary = await mkdtemp(join(tmpdir(), 'easi-view-ai-standalone-'));
    browser = await browserSession(resolve(temporary, 'chrome'));
    await browser.send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false});
    browser.onEvent((method, event) => {
        if (method === 'Network.requestWillBeSent') {
            const request = event.request, url = new URL(request.url);
            if (request.method === 'POST' && url.origin === origin && url.pathname === '/api/ai/login') {
                const login = {status: null}; loginRequests.push(login); loginRequestIndex.set(event.requestId, login); return;
            }
            if (request.method !== 'POST' || url.origin !== origin || url.pathname !== '/api/ai/test') return;
            // Deliberately never inspect login bodies, cookie/authorization
            // headers, response bodies, or provider-generated prose.
            let value; try { value = JSON.parse(request.postData); } catch { value = null; }
            const headers = request.headers ?? {}, guard = Object.entries(headers).find(([key]) => key.toLowerCase() === 'x-easi-ai-model')?.[1];
            const call = {task: value?.task ?? null, requestBytes: Buffer.byteLength(request.postData ?? ''), exactSyntheticRequest: request.postData === '{"version":1,"task":"connection-test","facts":[]}', modelGuardMatches: guard === profile.model, status: null};
            calls.push(call); requestIndex.set(event.requestId, call);
        } else if (method === 'Network.responseReceived') {
            if (requestIndex.has(event.requestId)) requestIndex.get(event.requestId).status = event.response.status;
            if (loginRequestIndex.has(event.requestId)) loginRequestIndex.get(event.requestId).status = event.response.status;
        }
    });
    await browser.send('Page.navigate', {url: `${origin}/`}); await viewerReady();
    assert.equal(calls.length, 0, 'Mounting the standalone viewer must not call the model.');
    await click('#header-ai-assist'); await click('[data-ai-action="test"]'); await settled();
    assert.equal(calls.length, 1, 'The actual Test control must make exactly one gateway request.');
    assert.equal(calls[0].status, 401, 'A fresh browser without a private session must reach the gateway and receive unauthorized.');
    assert.equal(await evaluate('document.querySelector(".ai-assist-error").textContent.includes("Sign in")'), true, 'Unauthorized must show the controlled sign-in guidance.');
    assert.equal(calls[0].exactSyntheticRequest, true); assert.equal(calls[0].modelGuardMatches, true); await assertNativeFetch();
    record('actual standalone native fetch reaches the gateway and shows sign-in guidance for a fresh unauthorized session');

    if (!args.includes('--unauthenticated-only')) {
        const content = await readFile(accessFile, 'utf8');
        const passcode = content.trim().startsWith('{') ? JSON.parse(content).passcode : content.trim();
        assert.ok(typeof passcode === 'string' && passcode.length >= 24, 'The private invitation file must contain a valid code.');
        await browser.send('Page.navigate', {url: `${origin}/api/ai/login`});
        // Complete waits for the deferred login script to install its submit
        // handler before entering a private invitation into the real form.
        await browser.until('document.readyState === "complete" && location.pathname === "/api/ai/login" && Boolean(document.querySelector("#login #passcode"))', 'The actual invitation form and its deferred script did not finish loading.');
        await click('#passcode'); await browser.send('Input.insertText', {text: passcode}); await click('#login button[type="submit"]');
        await viewerReady();
        assert.equal(loginRequests.length, 1, 'The actual invitation form must submit exactly one POST.');
        assert.equal(loginRequests[0].status, 200, 'The invitation form must establish access before entering the viewer.');
        assert.equal(calls.length, 1, 'Signing in and opening the viewer must not call the model.');
        record('private invitation is entered through the actual sign-in UI without recording credentials or issuing inference');

        const {createDicomFixture} = await import(pathToFileURL(resolve(root, 'src/data/synthetic.js')));
        const fixture = resolve(temporary, 'GENERATED_STANDALONE_AI_CHECK');
        await writeFile(fixture, createDicomFixture({rows: 2, columns: 2, values: [10, 20, 30, 40], modality: 'CT', pixelSpacing: [.5, .75], sopUid: '2.25.706.1.1.1', seriesUid: '2.25.706.1.1', extraAttributes: {'00100010': ['PN', 'SYNTHETIC^STANDALONE_AI'], '00100020': ['LO', 'SYNTHETIC_STANDALONE'], '0020000D': ['UI', '2.25.706.1']}}));
        await click('#header-import'); await click('[data-open-action="images"]');
        await browser.send('Page.setInterceptFileChooserDialog', {enabled: true}); await click('[data-open-action="pick-files"]');
        const input = await browser.send('Runtime.evaluate', {expression: 'document.querySelector("#file-input")', returnByValue: false});
        await browser.send('DOM.setFileInputFiles', {objectId: input.result.objectId, files: [fixture]});
        await browser.until('Boolean(document.querySelector("[data-open-action=add]") && !document.querySelector("[data-open-action=add]").disabled)', 'Generated local-file review did not complete.');
        await click('[data-open-action="add"]');
        await browser.until('!document.querySelector(".open-workflow").open && document.querySelector("#detail-matrix").textContent === "2 × 2" && document.querySelector("#frame-overlay").textContent === "Image 01 / 1"', 'The generated file did not load through the actual Open Images workflow.');
        assert.equal(calls.length, 1, 'Importing and displaying a local image must not issue AI requests.'); await assertNativeFetch();
        record('actual Open Images file selection loads and displays a generated extensionless DICOM without AI or upload requests');

        await click('#header-ai-assist');
        const context = await evaluate('JSON.parse(document.querySelector(".ai-assist-context").textContent)');
        assert.equal(context.task, 'explain-series'); assert.ok(context.facts.length > 0);
        assert.equal(calls.length, 1, 'Preparing a reviewed image context must not send it.');
        await click('[data-ai-action="test"]'); await settled();
        assert.equal(calls.length, 2, 'Exactly one authenticated synthetic connection test is allowed.');
        assert.equal(calls[1].status, 200, 'The actual standalone Test action must reach the genuine configured service.');
        assert.equal(await evaluate('document.querySelector(".ai-assist-error").hidden && document.querySelector(".ai-assist-status").textContent.includes("Connection succeeded")'), true, 'The genuine connection test must visibly succeed.');
        assert.equal(calls[1].exactSyntheticRequest, true); assert.equal(calls[1].modelGuardMatches, true);
        assert.equal(await evaluate('document.querySelector(".ai-assist-output").textContent.trim().length'), 0, 'A connection test must not display a model draft.');
        await assertNativeFetch();
        record('actual standalone Test connection succeeds with one genuine call and sends no facts from the displayed synthetic image');
        await click('[data-ai-action="close"]');
    }
    const aiPosts = browser.requests.filter(request => request.method === 'POST' && request.url.startsWith(`${origin}/api/ai/`));
    assert.equal(aiPosts.length, args.includes('--unauthenticated-only') ? 1 : 3, 'Only the expected login and explicit tests may post to the gateway.');
    const unexpectedPosts = browser.requests.filter(request => request.method === 'POST' && !request.url.startsWith(`${origin}/api/ai/`));
    assert.equal(unexpectedPosts.length, 0, 'Local files must never be uploaded.');
    const external = browser.requests.filter(request => !request.url.startsWith(origin) && !request.url.startsWith('blob:') && !request.url.startsWith('data:'));
    assert.equal(external.length, 0); assert.equal(browser.errors.length, 0); assert.equal(browser.consoleErrors.length, 0);
    record('native fetch stays unchanged with no unexpected uploads, external browser requests or runtime errors');
    await writeFile(resolve(output, 'results.json'), JSON.stringify({passed: checks.length, checks, sourceDigest: build.sourceDigest, harnessSha256: createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'), gatewayOrigin: origin, model: profile.model, actualStandaloneApplication: true, nativeFetchUntouched: true, sdkMountedByHarness: false, networkObservation: 'CDP only', syntheticFileImportedThroughUi: !args.includes('--unauthenticated-only'), genuineProviderCalls: args.includes('--unauthenticated-only') ? 0 : 1, requests: calls, login: await loginDiagnostics(), originalImagingFilesUsed: false, credentialsRecorded: false, modelTextRecorded: false, browserExceptions: 0, consoleErrors: 0, externalBrowserRequests: 0}, null, 2) + '\n');
    console.log(`Standalone AI browser checks: ${checks.length} passed.`);
} catch (error) {
    await writeFile(resolve(output, 'failure.json'), JSON.stringify({checks, sourceDigest: build?.sourceDigest, actualStandaloneApplication: true, nativeFetchUntouched: true, requests: calls, login: browser ? await loginDiagnostics() : null, failure: {name: error.name, message: error.message}, originalImagingFilesUsed: false, credentialsRecorded: false, modelTextRecorded: false}, null, 2) + '\n');
    throw error;
} finally {
    browser?.close();
    if (temporary) await rm(temporary, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
}
