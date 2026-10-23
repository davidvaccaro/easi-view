import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir, mkdtemp, readFile, writeFile, rm, stat} from 'node:fs/promises';
import {resolve, join, extname, sep} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {browserSession, delay} from './browser-session.mjs';
import {workflowUltrasoundFixture} from './browser-ai-workflow-fixtures.mjs';

// The real standalone app, native fetch, and the real invitation/session code.
// Only the model is a deterministic in-process fixture. No original medical
// inputs, provider credentials, personal browser, or paid requests are used.
const args = process.argv.slice(2), option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const root = resolve(option('--source-root') ?? resolve(import.meta.dirname, '..'));
const output = resolve(option('--output') ?? resolve(root, 'artifacts/browser-ai-signin'));
const importRoot = path => import(pathToFileURL(resolve(root, path)));
const quote = JSON.stringify, checks = [], requests = [], passcode = 'synthetic-signin-invitation-not-a-secret';
const command = 'Show two panes for review.';
let browser, popup, server, temporary, origin, build, now = Date.now(), providerCalls = 0;
const record = name => { checks.push({name}); console.log(`PASS ${name}`); };

async function click(page, selector) {
    const point = await page.evaluate(`(() => { const n = document.querySelector(${quote(selector)}); if (!n || n.hidden || n.disabled) return null; n.scrollIntoView({block:'center'}); const r=n.getBoundingClientRect(); return r.width&&r.height?{x:r.left+r.width/2,y:r.top+r.height/2}:null; })()`);
    assert.ok(point, `A required control is unavailable: ${selector}`);
    await page.send('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', clickCount: 1, ...point});
    await page.send('Input.dispatchMouseEvent', {type: 'mouseReleased', button: 'left', clickCount: 1, ...point});
}
async function nativeFetch(page) {
    assert.equal(await page.evaluate('Function.prototype.toString.call(globalThis.fetch).includes("[native code]")'), true, 'The page must retain native browser fetch.');
}
async function ready(page = browser) {
    await page.until('Boolean(document.querySelector("#header-ai-assist")&&!document.querySelector("#header-ai-assist").hidden)', 'The standalone viewer did not mount.', 240);
    await nativeFetch(page);
}
async function openAssist() {
    await click(browser, '#header-ai-assist');
    await browser.until('document.querySelector(".ai-assist").open&&!document.querySelector(".ai-assist-workflow").hidden', 'Tasks must be the configured default.');
}
const inferenceRequests = () => requests.filter(item => ['/api/ai/plan', '/api/ai/transcribe', '/api/ai/test', '/api/ai/generate'].includes(item.path));
async function state() {
    return browser.evaluate(`(() => ({
        pathname:location.pathname,command:document.querySelector('.ai-workflow-command').value,
        dialogOpen:document.querySelector('.ai-assist').open,layout:Number(document.querySelector('#workspace').dataset.layout),
        frame:Number(document.querySelector('#frame-slider').value),image:document.querySelector('#frame-overlay').textContent,
        session:document.querySelector('#session-summary').textContent,
        selected:[...document.querySelectorAll('.session-library-series.is-selected')].map(n=>n.textContent),
        canvas:[...document.querySelectorAll('.workspace-pane canvas')].map(n=>({width:n.width,height:n.height}))
    }))()`);
}

// Existing browserSession owns one page socket. Attach to the trusted link's
// second tab with nested CDP messages, without modifying that shared helper.
async function attachPage(targetId) {
    const {sessionId} = await browser.send('Target.attachToTarget', {targetId, flatten: false});
    const pending = new Map(), errors = [], consoleErrors = []; let sequence = 0;
    const stop = browser.onEvent((method, event) => {
        if (method !== 'Target.receivedMessageFromTarget' || event.sessionId !== sessionId) return;
        const message = JSON.parse(event.message), item = pending.get(message.id);
        if (item) { clearTimeout(item.timer); pending.delete(message.id); message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result); }
        else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
        else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') consoleErrors.push('A login-tab console error occurred.');
    });
    const send = async (method, params = {}) => {
        const id = ++sequence;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} in login tab timed out.`)); }, 15000);
            pending.set(id, {resolve, reject, timer});
            browser.send('Target.sendMessageToTarget', {sessionId, message: JSON.stringify({id, method, params})}).catch(error => { clearTimeout(timer); pending.delete(id); reject(error); });
        });
    };
    const evaluate = async expression => {
        const result = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
        if (result.exceptionDetails) throw new Error('The isolated login tab raised a browser exception.');
        return result.result?.value;
    };
    const until = async (expression, message, attempts = 120) => {
        for (let index = 0; index < attempts; index++) { const value = await evaluate(expression); if (value) return value; if (errors.length) throw new Error('The isolated login tab raised a browser exception.'); await delay(100); }
        throw new Error(message);
    };
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
    return {send, evaluate, until, errors, consoleErrors, close: async () => { stop(); for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Login tab closed.')); } pending.clear(); await browser.send('Target.closeTarget', {targetId}); }};
}
async function signInFromLink() {
    const previous = new Set((await browser.send('Target.getTargets')).targetInfos.map(target => target.targetId));
    await click(browser, '.ai-assist-sign-in');
    let target;
    for (let index = 0; index < 120; index++) {
        target = (await browser.send('Target.getTargets')).targetInfos.find(item => !previous.has(item.targetId) && item.type === 'page' && item.url === `${origin}/api/ai/login`);
        if (target) break; await delay(100);
    }
    assert.ok(target, 'Trusted sign-in click must open the configured same-origin login in a new tab.');
    popup = await attachPage(target.targetId);
    await popup.until('document.readyState==="complete"&&Boolean(document.querySelector("#passcode"))', 'The real invitation form did not mount.');
    assert.equal(await popup.evaluate('window.opener===null'), true, 'The login tab must not retain an opener.');
    assert.equal(await popup.evaluate('document.referrer'), '', 'The login request must not disclose a referrer.');
    await nativeFetch(popup); await click(popup, '#passcode'); await popup.send('Input.insertText', {text: passcode}); await click(popup, '#login button[type="submit"]');
    // The current public login sends successful visitors to a new viewer tab.
    // A future return-to-original-tab success page is equally acceptable here.
    await popup.until('location.pathname==="/"||document.querySelector("#status")?.textContent.includes("Return")', 'The real invitation exchange did not complete.', 240);
    assert.equal(popup.errors.length, 0); assert.equal(popup.consoleErrors.length, 0);
    await popup.close(); popup = null; await browser.send('Page.bringToFront');
}
async function openGeneratedFile(path) {
    await click(browser, '[data-ai-action="close"]'); await click(browser, '#header-import'); await click(browser, '[data-open-action="images"]');
    await browser.send('Page.setInterceptFileChooserDialog', {enabled: true}); await click(browser, '[data-open-action="pick-files"]');
    const input = await browser.send('Runtime.evaluate', {expression: 'document.querySelector("#file-input")', returnByValue: false});
    await browser.send('DOM.setFileInputFiles', {objectId: input.result.objectId, files: [path]});
    await browser.until('Boolean(document.querySelector("[data-open-action=add]")&&!document.querySelector("[data-open-action=add]").disabled)', 'Generated file review did not finish.');
    await click(browser, '[data-open-action="add"]');
    await browser.until('!document.querySelector(".open-workflow").open&&document.querySelector("#frame-overlay").textContent.includes("/ 50")', 'Generated multiframe image did not open.');
    await browser.evaluate('(()=>{const n=document.querySelector("#frame-slider");n.value="11";n.dispatchEvent(new Event("input",{bubbles:true}));})()');
    await browser.until('document.querySelector("#frame-overlay").textContent.includes("12 / 50")', 'Generated frame twelve was not rendered.');
    await openAssist();
}
async function startMock() {
    const {AiGateway} = await importRoot('examples/ai-gateway/gateway.mjs');
    const provider = {model: 'synthetic-signin-model', async *generate() { providerCalls++; yield 'Connected.'; },
        async plan(request) { providerCalls++; assert.equal(request.command, command); return {version: 1, model: this.model, plan: {version: 1, status: 'ready', summary: 'Display two panes.', question: null, actions: [{type: 'layout', count: 2}]}}; }};
    let gateway;
    const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm'};
    server = createServer(async (request, response) => {
        response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
        const path = new URL(request.url, origin).pathname;
        if (path.startsWith('/api/ai/')) {
            let body = ''; for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 32768) { response.writeHead(413); response.end(); return; } }
            const output = await gateway.handle({method: request.method, path, headers: request.headers, body, ip: 'synthetic-signin-fixture'});
            requests.push({path, method: request.method, status: output.status, hasReferrer: Boolean(request.headers.referer)});
            response.writeHead(output.status, output.headers);
            if (typeof output.body === 'string') response.end(output.body); else { for await (const chunk of output.body) response.write(chunk); response.end(); }
            return;
        }
        if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
        if (path === '/viewer-config.json') {
            response.writeHead(200, {'Content-Type': 'application/json'}); response.end(JSON.stringify({ai: {enabled: true, workflows: true, baseUrl: '/api/ai', signInUrl: '/api/ai/login', label: 'Generated sign-in qualification', recipient: 'Deterministic local fixture only', model: provider.model, credentials: 'same-origin'}})); return;
        }
        const target = resolve(root, 'dist', '.' + (path === '/' ? '/index.html' : path));
        if (!target.startsWith(resolve(root, 'dist') + sep)) { response.writeHead(404); response.end(); return; }
        try { if (!(await stat(target)).isFile()) throw new Error(); const bytes = await readFile(target); response.writeHead(200, {'Content-Type': types[extname(target)] ?? 'application/octet-stream', 'Content-Length': bytes.length}); response.end(request.method === 'HEAD' ? undefined : bytes); }
        catch { response.writeHead(404); response.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
    gateway = new AiGateway({provider, passcode, allowedOrigins: [origin], secureCookies: false, requireModelBinding: true, now: () => now, quota: {consume: async () => true}});
}

try {
    await mkdir(output, {recursive: true}); await rm(resolve(output, 'results.json'), {force: true}); await rm(resolve(output, 'failure.json'), {force: true});
    temporary = await mkdtemp(join(tmpdir(), 'easi-ai-signin-browser-')); await startMock();
    build = await (await fetch(`${origin}/build-info.json`)).json(); const {sourceDigest} = await importRoot('tools/source-digest.mjs'); assert.equal(build.sourceDigest, await sourceDigest(root));
    browser = await browserSession(resolve(temporary, 'chrome')); await browser.send('Emulation.setDeviceMetricsOverride', {width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false});
    await browser.send('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]});
    await browser.send('Page.navigate', {url: origin}); await ready(); await openAssist();
    const link = await browser.evaluate('(()=>{const n=document.querySelector(".ai-assist-sign-in");return n&&{hidden:n.hidden,href:n.href,target:n.target,rel:n.rel,referrerPolicy:n.referrerPolicy};})()');
    assert.deepEqual(link, {hidden: false, href: `${origin}/api/ai/login`, target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer'});
    await browser.send('Page.reload', {ignoreCache: true}); await ready(); await openAssist();
    assert.equal(await browser.evaluate('!document.querySelector(".ai-assist-sign-in").hidden'), true); assert.equal(inferenceRequests().length, 0); assert.equal(providerCalls, 0);
    record('public viewer refresh exposes an explicit safe sign-in link without any automatic AI request');
    await signInFromLink(); assert.equal(inferenceRequests().length, 0); assert.equal(providerCalls, 0);
    const {createDicomFixture} = await importRoot('src/data/synthetic.js'), file = workflowUltrasoundFixture(createDicomFixture), path = resolve(temporary, file.name);
    await writeFile(path, new Uint8Array(await file.arrayBuffer())); await openGeneratedFile(path);
    await browser.evaluate(`(()=>{const n=document.querySelector('.ai-workflow-command');n.value=${quote(command)};n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const original = await state(); assert.equal(original.frame, 11); assert.ok(original.image.includes('12 / 50')); assert.ok(original.selected.length); assert.equal(original.layout, 1);
    now += 31 * 60 * 1000; await click(browser, '[data-ai-workflow-action="plan"]');
    await browser.until('!document.querySelector(".ai-assist-auth-notice").hidden&&!document.querySelector(".ai-workflow-error").hidden', 'An expired real gateway session must expose the common sign-in recovery notice.');
    assert.deepEqual(await state(), original); assert.deepEqual(inferenceRequests().map(item => item.status), [401]); assert.equal(providerCalls, 0);
    record('real 30-minute session expiry returns401, highlights sign-in recovery, and retains the typed task and local multiframe image');
    await signInFromLink(); await delay(300); assert.deepEqual(await state(), original); assert.deepEqual(inferenceRequests().map(item => item.status), [401]); assert.equal(providerCalls, 0);
    const logins = requests.filter(item => item.method === 'POST' && item.path === '/api/ai/login'); assert.equal(logins.length, 2); assert.ok(logins.every(item => item.status === 200));
    assert.ok(requests.filter(item => item.method === 'GET' && item.path === '/api/ai/login').every(item => !item.hasReferrer));
    record('trusted new-tab invitation login restores the real cookie without navigation, local-source loss, or automatic retry in the original viewer');
    await click(browser, '[data-ai-workflow-action="plan"]');
    await browser.until('!document.querySelector(".ai-workflow-review").hidden&&!document.querySelector("[data-ai-workflow-action=run]").disabled', 'Explicit retry must yield a reviewed runnable plan.');
    assert.equal(await browser.evaluate('Number(document.querySelector("#workspace").dataset.layout)'), 1); assert.deepEqual(inferenceRequests().map(item => item.status), [401, 200]); assert.equal(providerCalls, 1);
    assert.equal(await browser.evaluate('document.querySelector(".ai-assist-auth-notice").hidden'), true);
    await click(browser, '[data-ai-workflow-action="run"]'); await browser.until('document.querySelector("#workspace").dataset.layout==="2"&&document.querySelector(".ai-assist-workflow").getAttribute("aria-busy")==="false"', 'The explicitly reviewed layout must run.');
    assert.equal((await state()).frame, 11); assert.deepEqual(inferenceRequests().map(item => item.status), [401, 200]); assert.equal(providerCalls, 1);
    record('only explicit retry invokes the fixture planner and only Run changes the layout, preserving the selected local frame');
    await nativeFetch(browser); assert.equal(browser.errors.length, 0); assert.equal(browser.consoleErrors.length, 0);
    assert.equal(browser.requests.filter(item => !item.url.startsWith(origin) && !item.url.startsWith('blob:') && !item.url.startsWith('data:')).length, 0);
    assert.equal(browser.requests.filter(item => item.method === 'POST' && !item.url.startsWith(`${origin}/api/ai/`)).length, 0);
    record('native fetch stays untouched and generated local imaging produces no uploads, external requests, or browser exceptions');
    await writeFile(resolve(output, 'results.json'), JSON.stringify({passed: checks.length, checks, sourceDigest: build.sourceDigest, harnessSha256: createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'), actualStandaloneApplication: true, nativeFetchUntouched: true, sessionImplementation: 'AiGateway and DemoSessions with a mutable fixture clock', realInvitationFormUsed: true, clickedSeparateSignInTab: true, originalLocalFileRetained: true, automaticAiRequests: 0, inferenceRequests: inferenceRequests().map(({path, status}) => ({path, status})), deterministicProviderCalls: providerCalls, genuineProviderCalls: 0, originalImagingFilesUsed: false, secretsOrPatientDataRecorded: false, screenshotsRecorded: false, browserExceptions: 0, consoleErrors: 0}, null, 2) + '\n');
    console.log(`Standalone AI sign-in checks: ${checks.length} passed.`);
} catch (error) {
    await writeFile(resolve(output, 'failure.json'), JSON.stringify({checks, sourceDigest: build?.sourceDigest, failure: {name: error.name, message: error.message}, inferenceRequests: inferenceRequests().map(({path, status}) => ({path, status})), deterministicProviderCalls: providerCalls, genuineProviderCalls: 0, originalImagingFilesUsed: false, secretsOrPatientDataRecorded: false, screenshotsRecorded: false}, null, 2) + '\n'); throw error;
} finally {
    if (popup) await popup.close().catch(() => {}); browser?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (temporary) await rm(temporary, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
}
