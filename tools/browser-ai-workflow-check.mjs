import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir, mkdtemp, readFile, writeFile, rm, stat, copyFile} from 'node:fs/promises';
import {resolve, join, extname, sep} from 'node:path';
import {tmpdir, homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {browserSession, delay} from './browser-session.mjs';
import {WORKFLOW_COMMANDS, workflowFixturePlan, workflowUltrasoundFixture, generatedVoiceWav, generatedSpokenVoiceWav} from './browser-ai-workflow-fixtures.mjs';

// Actual standalone page and native browser fetch. No SDK mount, original
// medical input, user browser, request-capture wrapper, or provider secret.
const args = process.argv.slice(2), option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const root = resolve(option('--source-root') ?? resolve(import.meta.dirname, '..'));
const output = resolve(option('--output') ?? resolve(root, 'artifacts/browser-ai-workflow'));
const live = Boolean(option('--origin')), checks = [], calls = [], mock = {delayed: 0};
const liveVoiceOnly = args.includes('--live-voice-only');
const liveVoice = args.includes('--live-voice') || liveVoiceOnly;
if (liveVoice && !live) throw new Error('--live-voice requires an explicit --origin and makes three genuine calls.');
const importRoot = path => import(pathToFileURL(resolve(root, path)));
const quote = JSON.stringify, record = (name, details = {}) => { checks.push({name, ...details}); console.log(`PASS ${name}`); };
let browser, temporary, server, origin, build, profile, nativeFetchId, stopObserve, voiceFixture;
const evaluate = expression => browser.evaluate(expression);

async function click(selector) {
    const point = await evaluate(`(() => { const n = document.querySelector(${quote(selector)}); if (!n || n.hidden || n.disabled) return null; n.scrollIntoView({block:'center'}); const r = n.getBoundingClientRect(); return r.width && r.height ? {x:r.left+r.width/2,y:r.top+r.height/2} : null; })()`);
    assert.ok(point, `A required standalone control is unavailable: ${selector}`);
    await browser.send('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', clickCount: 1, ...point});
    await browser.send('Input.dispatchMouseEvent', {type: 'mouseReleased', button: 'left', clickCount: 1, ...point});
}
async function nativeFetch() {
    if (!nativeFetchId) nativeFetchId = (await browser.send('Runtime.evaluate', {expression: 'globalThis.fetch', returnByValue: false})).result.objectId;
    const value = await browser.send('Runtime.callFunctionOn', {objectId: nativeFetchId, functionDeclaration: 'function(){return this===globalThis.fetch&&Function.prototype.toString.call(this).includes("[native code]");}', returnByValue: true});
    assert.equal(value.result?.value, true, 'The browser must retain its original native fetch.');
}
async function ready() {
    await browser.until('Boolean(document.querySelector("#header-ai-assist")&&!document.querySelector("#header-ai-assist").hidden)', 'The actual standalone viewer did not mount.', live ? 600 : 240);
    nativeFetchId = null; await nativeFetch();
}
const workflowBusy = 'document.querySelector(".ai-assist-workflow")?.getAttribute("aria-busy")==="true"';
async function settle() { await browser.until(`!(${workflowBusy})`, 'The task did not settle.', live ? 650 : 150); }
async function openAssist() { await click('#header-ai-assist'); await browser.until('document.querySelector(".ai-assist").open&&!document.querySelector(".ai-assist-workflow").hidden', 'Tasks must be the actual configured default.'); }
async function closeAssist() { if (await evaluate('Boolean(document.querySelector(".ai-assist")?.open)')) await click('[data-ai-action="close"]'); }
async function command(value) {
    await evaluate(`(() => {const n=document.querySelector('.ai-workflow-command'); n.value=${quote(value)};n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function plan(value) {
    if (value != null) await command(value); const count = calls.length; await click('[data-ai-workflow-action="plan"]');
    await browser.until(`document.querySelector('.ai-workflow-review')&&!document.querySelector('.ai-workflow-review').hidden&&!(${workflowBusy})||!document.querySelector('.ai-workflow-error').hidden`, 'The reviewed task plan did not appear.', live ? 650 : 150);
    assert.equal(calls.length, count + 1, 'Planning is exactly one explicit request.');
    assert.equal(await evaluate('document.querySelector(".ai-workflow-error").hidden'), true, 'The generated task must plan successfully.');
}
async function run() {
    await click('[data-ai-workflow-action="run"]'); await settle();
    assert.equal(await evaluate('document.querySelector(".ai-workflow-error").hidden'), true, 'The reviewed task must execute without a workflow error.');
}
async function resetSession() {
    await closeAssist(); await click('#primary-menu-toggle');
    if (await evaluate('!document.querySelector("#primary-menu-close").disabled')) {
        await click('#primary-menu-close');
        try { await browser.until('document.querySelector("#session-summary").textContent.startsWith("0 patients")', 'Session cleanup did not complete.'); }
        catch { const diagnostic = await evaluate('({summary:document.querySelector("#session-summary").textContent,empty:!document.querySelector("#viewport-empty").hidden,menuOpen:document.querySelector("#primary-menu").open,menuStatus:document.querySelector(".primary-menu-message").textContent})');throw new Error(`Generated-session cleanup did not complete: ${JSON.stringify(diagnostic)}`); }
    }
    else await click('#primary-menu-dismiss');
}
async function openFiles(files) {
    await closeAssist(); await click('#header-import'); await click('[data-open-action="images"]'); await browser.send('Page.setInterceptFileChooserDialog', {enabled: true}); await click('[data-open-action="pick-files"]');
    const input = await browser.send('Runtime.evaluate', {expression: 'document.querySelector("#file-input")', returnByValue: false}); await browser.send('DOM.setFileInputFiles', {objectId: input.result.objectId, files});
    await browser.until('Boolean(document.querySelector("[data-open-action=add]")&&!document.querySelector("[data-open-action=add]").disabled)', 'Generated file review did not finish.'); await click('[data-open-action="add"]');
    await browser.until('!document.querySelector(".open-workflow").open&&document.querySelector("#frame-overlay").textContent.startsWith("Image ")', 'Generated images did not open.');
}
async function paneState() {
    return evaluate(`(() => ({layout:Number(document.querySelector('#workspace').dataset.layout),panes:[...document.querySelectorAll('.workspace-pane')].map(p=>({slot:Number(p.dataset.slot),window:p.querySelector('[data-pane-id=window-overlay]').textContent,frame:p.querySelector('[data-pane-id=frame-overlay]').textContent})),slice:document.querySelector('#sync-slices').checked,window:document.querySelector('#sync-window').checked,camera:document.querySelector('#sync-camera').checked,playing:document.querySelector('#cine-toggle').getAttribute('aria-pressed')==='true',frame:Number(document.querySelector('#frame-slider').value)}))()`);
}
async function imagePixel(slot = 0) {
    // Sample the first image quadrant away from UI labels, using Chrome's final
    // composited screenshot. Keep only the decoded RGB count, never an image.
    const clip = await evaluate(`(() => {const r=document.querySelector('.workspace-pane[data-slot="${slot}"] canvas').getBoundingClientRect(),size=Math.min(r.width,r.height);return{x:r.left+r.width/2-size/4,y:r.top+r.height/2-size/4,width:2,height:2,scale:1};})()`);
    const screenshot = await browser.send('Page.captureScreenshot', {format: 'jpeg', quality: 100, clip, captureBeyondViewport: false});
    const jpeg = (await importRoot('node_modules/jpeg-js/index.js')).default;
    return [...jpeg.decode(Buffer.from(screenshot.data, 'base64'), {useTArray: true}).data.slice(0, 3)];
}
async function login(passcode) {
    await browser.send('Page.navigate', {url: `${origin}/api/ai/login`});
    await browser.until('document.readyState==="complete"&&location.pathname==="/api/ai/login"&&Boolean(document.querySelector("#passcode"))', 'The real sign-in UI did not finish loading.', 240);
    await click('#passcode'); await browser.send('Input.insertText', {text: passcode}); await click('#login button[type="submit"]'); await ready();
}
async function startMock() {
    const {AiGateway} = await importRoot('examples/ai-gateway/gateway.mjs');
    const provider = {model: 'synthetic-workflow-model', async *generate() { yield 'Connected.'; },
        async plan(request, {signal}) { if (request.command === WORKFLOW_COMMANDS.cancel) { mock.delayed++; await new Promise((resolve, reject) => { const timer=setTimeout(resolve, 1500);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('Canceled fixture'));},{once:true}); }); } return {version: 1, model: this.model, plan: workflowFixturePlan(request.command)}; },
        async transcribe() { return {version: 1, model: 'gpt-transcribe', text: WORKFLOW_COMMANDS.frame}; }};
    const passcode = 'synthetic-workflow-invitation-no-secret'; let gateway;
    const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.wasm':'application/wasm'};
    server = createServer(async (request, response) => {
        response.setHeader('Cache-Control','no-store'); response.setHeader('X-Content-Type-Options','nosniff'); response.setHeader('Referrer-Policy','no-referrer');
        const path = new URL(request.url, origin).pathname;
        if (path.startsWith('/api/ai/')) {
            const controller = new AbortController(); request.on('aborted',()=>controller.abort()); response.on('close',()=>{if(!response.writableEnded)controller.abort();});
            let body=''; for await (const chunk of request) {body+=chunk;if(Buffer.byteLength(body)>3000000){response.writeHead(413);response.end();return;}}
            const result = await gateway.handle({method:request.method,path,headers:request.headers,body,ip:'generated-fixture',signal:controller.signal});
            if(response.destroyed)return;response.writeHead(result.status,result.headers);if(typeof result.body==='string')response.end(result.body);else{for await(const chunk of result.body)response.write(chunk);response.end();}return;
        }
        if (!['GET','HEAD'].includes(request.method)) {response.writeHead(405);response.end();return;}
        if(path==='/viewer-config.json'){response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({ai:{enabled:true,workflows:true,baseUrl:'/api/ai',label:'Generated workflow qualification',recipient:'Deterministic local fixture only',model:provider.model,credentials:'same-origin'}}));return;}
        const target=resolve(root,'dist','.'+(path==='/'?'/index.html':path));
        if(!target.startsWith(resolve(root,'dist')+sep)){response.writeHead(404);response.end();return;}
        try{if(!(await stat(target)).isFile())throw new Error();const bytes=await readFile(target);response.writeHead(200,{'Content-Type':types[extname(target)]??'application/octet-stream','Content-Length':bytes.length});response.end(request.method==='HEAD'?undefined:bytes);}catch{response.writeHead(404);response.end();}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
    gateway=new AiGateway({provider,passcode,allowedOrigins:[origin],secureCookies:false,requireModelBinding:true,quota:{consume:async()=>true}});
    return passcode;
}

try {
    await mkdir(output,{recursive:true}); await rm(resolve(output,'results.json'),{force:true});await rm(resolve(output,'failure.json'),{force:true}); temporary=await mkdtemp(join(tmpdir(),'easi-workflow-browser-'));
    let passcode;
    if(live){origin=new URL(option('--origin')).origin;if(!origin.startsWith('https:')&&!['http://127.0.0.1:5188','http://localhost:5188'].includes(origin))throw new Error('Use the approved loopback demonstration or HTTPS.');const raw=await readFile(resolve(option('--passcode-file')??join(homedir(),'.config/easi-view/ai-demo-access.json')),'utf8');passcode=JSON.parse(raw).passcode;}
    else passcode=await startMock();
    build=await(await fetch(`${origin}/build-info.json`)).json();const {sourceDigest}=await importRoot('tools/source-digest.mjs');assert.equal(build.sourceDigest,await sourceDigest(root));
    profile=(await(await fetch(`${origin}/viewer-config.json`)).json()).ai;assert.equal(profile.workflows,true);if(option('--expected-model'))assert.equal(profile.model,option('--expected-model'));
    const wave=resolve(temporary,'GENERATED-VOICE.wav');
    if(liveVoice)voiceFixture=await generatedSpokenVoiceWav(wave);else await writeFile(wave,generatedVoiceWav());
    // Disposable-browser fixture policy only: macOS' sandboxed audio service
    // cannot read this generated fake-input file. Product capture is unchanged.
    browser=await browserSession(resolve(temporary,'chrome'),['--use-fake-device-for-media-stream',`--use-file-for-fake-audio-capture=${wave}`,
        ...(liveVoice?['--disable-features=AudioServiceSandbox','--autoplay-policy=no-user-gesture-required']:[])]);await browser.send('Emulation.setDeviceMetricsOverride',{width:1500,height:1000,deviceScaleFactor:1,mobile:false});
    await browser.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    const index=new Map();stopObserve=browser.onEvent((method,event)=>{
        if(method==='Network.requestWillBeSent'){
            const request=event.request,url=new URL(request.url);if(request.method!=='POST'||url.origin!==origin||!['/api/ai/plan','/api/ai/transcribe','/api/ai/test'].includes(url.pathname))return;
            let value;try{value=JSON.parse(request.postData);}catch{value=null;}
            const guard=Object.entries(request.headers).find(([key])=>key.toLowerCase()==='x-easi-ai-model')?.[1],allowed=url.pathname.endsWith('/plan')?['version','task','command']:url.pathname.endsWith('/transcribe')?['version','task','mimeType','audio']:['version','task','facts'];
            const call={path:url.pathname,task:value?.task??null,requestBytes:Buffer.byteLength(request.postData??''),onlyAllowedFields:!!value&&Object.keys(value).length===allowed.length&&Object.keys(value).every(key=>allowed.includes(key)),modelGuardMatches:guard===profile.model,status:null};calls.push(call);index.set(event.requestId,call);
        }else if(method==='Network.responseReceived'&&index.has(event.requestId))index.get(event.requestId).status=event.response.status;
    });
    await login(passcode);assert.equal(calls.length,0);record('actual standalone sign-in mounts Tasks without an automatic AI request and preserves native fetch');
    const {createDicomFixture}=await importRoot('src/data/synthetic.js'),{createWorkflowStudyFiles}=await importRoot('test/fixtures/workflow-studies.js');
    const save=async(files,name)=>{const directory=resolve(temporary,name);await mkdir(directory);return Promise.all(files.map(async(file,index)=>{const path=resolve(directory,`${index}-${file.name}`);await writeFile(path,new Uint8Array(await file.arrayBuffer()));return path;}));};
    const ct=await save(createWorkflowStudyFiles({kind:'ct-missing-agent'}),'ct'),mr=await save(createWorkflowStudyFiles({kind:'mr-multiple-contrast'}),'mr'),us=await save([workflowUltrasoundFixture(createDicomFixture)],'us');
    if(!liveVoiceOnly){
    await openFiles(ct);const before=await paneState();assert.equal(before.layout,1);await openAssist();const count=calls.length;await command(WORKFLOW_COMMANDS.paired);assert.equal(calls.length,count);record('typing a task and importing generated DICOM files make no AI calls or uploads');
    await plan(WORKFLOW_COMMANDS.paired);assert.equal((await paneState()).layout,1);assert.equal(await evaluate('document.querySelector("[data-ai-workflow-action=run]").disabled'),false);
    if(liveVoice){await browser.screenshot('workflow-reviewed-ct-synthetic');await copyFile(resolve(temporary,'chrome/workflow-reviewed-ct-synthetic.png'),resolve(output,'workflow-reviewed-ct-synthetic.png'));}
    await run();const applied=await paneState();assert.equal(applied.layout,2);
    const normalizedWindow = value => value.replaceAll(',', '').replaceAll('−', '-');
    assert.equal(normalizedWindow(applied.panes[0].window), 'W 1500 · L -600');
    assert.equal(normalizedWindow(applied.panes[1].window), 'W 400 · L 40');
    assert.equal(applied.slice,true);assert.equal(applied.window,false);assert.equal(applied.camera,true);
    await closeAssist();const left=await imagePixel(0),right=await imagePixel(1);assert.notDeepEqual(left,right);await openAssist();await click('[data-ai-workflow-action="undo"]');await settle();assert.deepEqual(await paneState(),before);record('displayed CT executes distinct lung/soft-tissue pixels with independent windows, then Undo survives close and reopen',{firstPaneRgb:left,secondPaneRgb:right});
    }
    if(!live){
        await resetSession();await openFiles(mr);await openAssist();await plan(WORKFLOW_COMMANDS.mr);const options=await evaluate('[...document.querySelectorAll("[data-ai-workflow-choice]")].map(n=>({id:n.dataset.aiWorkflowChoice,label:n.parentNode.textContent}))');assert.equal(options.length,3);assert.ok(options.every(item=>/100[123]/.test(item.label)&&!item.label.includes('11001')));assert.equal(await evaluate('document.querySelector("[data-ai-workflow-action=run]").disabled'),true);const chosen=options.find(item=>item.label.includes('1002'));await click(`[data-ai-workflow-choice=${quote(chosen.id)}]`);await settle();await run();await closeAssist();assert.equal(await evaluate('document.querySelector(".session-library-series.is-selected .session-library-series-counts").textContent.includes("Series 1002")'),true);record('ambiguous original contrast MRI requires an explicit grounded series choice and excludes derived subtraction');
        await resetSession();await openFiles(ct);await openAssist();await plan(WORKFLOW_COMMANDS.contrast);assert.equal(await evaluate('document.querySelector("[data-ai-workflow-action=run]").disabled'),true);assert.equal(await evaluate('document.querySelectorAll("[data-ai-workflow-choice]").length'),0);assert.equal((await paneState()).layout,1);record('with-contrast study wording cannot manufacture absent series contrast evidence or enable Run');
        await command(WORKFLOW_COMMANDS.cancel);await click('[data-ai-workflow-action="plan"]');await browser.until(workflowBusy,'Delayed planning did not start.');await click('[data-ai-workflow-action="cancel"]');await settle();await delay(1600);assert.equal(await evaluate('document.querySelector(".ai-workflow-review").hidden'),true);assert.equal((await paneState()).layout,1);record('canceled planning cannot surface or run a late response');
        await plan(WORKFLOW_COMMANDS.stale);await evaluate('(()=>{const n=document.querySelector("#frame-slider");n.value="1";n.dispatchEvent(new Event("input",{bubbles:true}));})()');await browser.until('document.querySelector("#frame-slider").value==="1"','The simulated external frame change did not commit.');await click('[data-ai-workflow-action="run"]');await settle();assert.equal((await paneState()).layout,1);assert.equal(await evaluate('!document.querySelector(".ai-workflow-error").hidden'),true);record('a reviewed plan cannot execute after an external frame change invalidates its local snapshot');
    }
    await resetSession();await openFiles(us);await evaluate('document.querySelector("#cine-fps").value="5"');await click('#cine-toggle');await browser.until('document.querySelector("#cine-toggle").getAttribute("aria-pressed")==="true"','Generated US cine did not start.');await openAssist();
    if(liveVoice){
        await browser.send('Browser.setPermission',{permission:{name:'microphone'},setting:'granted',origin});const beforeVoice=calls.length;
        await click('[data-ai-workflow-action="record"]');await browser.until('document.querySelector("[data-ai-workflow-action=record]").getAttribute("aria-pressed")==="true"','The generated speech recording did not start.');
        await delay(voiceFixture.durationMs);await click('[data-ai-workflow-action="record"]');
        await browser.until('document.querySelector(".ai-workflow-status").textContent.includes("Transcript ready")&&!('+workflowBusy+')||!document.querySelector(".ai-workflow-error").hidden','The genuine speech transcription did not return an editable transcript.',650);
        assert.equal(await evaluate('document.querySelector(".ai-workflow-error").hidden'),true,'The genuine transcription returned a controlled service error; inspect the route/status receipt before retrying.');
        assert.equal(calls.length,beforeVoice+1);assert.equal(calls.at(-1).path,'/api/ai/transcribe');assert.equal(calls.at(-1).status,200);
        assert.equal(await evaluate('(()=>{const n=document.querySelector(".ai-workflow-command");return !n.disabled&&/pause/i.test(n.value)&&/forty|\\b40\\b/i.test(n.value);})()'),true,'The genuine transcript must recognize the benign pause/frame-forty instruction.');
        await delay(200);assert.equal(calls.length,beforeVoice+1);record('offline generated speech passes through actual Record/Stop and genuine transcription into an editable reviewed command without auto-planning',{transcriptionModel:'gpt-transcribe',sampleRate:voiceFixture.sampleRate,channels:voiceFixture.channels});
        await plan();
    }else await plan(WORKFLOW_COMMANDS.frame);
    await run();const applied=await paneState();assert.equal(applied.frame,39);assert.equal(applied.playing,false);assert.ok(applied.panes[0].frame.includes('40 / 50'));record('one-based frame forty selects actual US frame index39 and pauses cine');
    if(!live){
        await browser.send('Browser.setPermission',{permission:{name:'microphone'},setting:'denied',origin});await click('[data-ai-workflow-action="record"]');await browser.until('document.querySelector(".ai-workflow-error").textContent.includes("permission")','Denied microphone did not show typing fallback.');record('denied microphone access leaves an actionable typed-task fallback without transmitting audio');
        await browser.send('Browser.setPermission',{permission:{name:'microphone'},setting:'granted',origin});let audioCount=calls.filter(call=>call.path.endsWith('/transcribe')).length;await click('[data-ai-workflow-action="record"]');await browser.until('document.querySelector("[data-ai-workflow-action=record]").getAttribute("aria-pressed")==="true"','Generated microphone recording did not start.');await click('[data-ai-workflow-action="cancel"]');await delay(350);assert.equal(calls.filter(call=>call.path.endsWith('/transcribe')).length,audioCount);record('cancel discards actual MediaRecorder capture before any transcription request');
        await click('[data-ai-workflow-action="record"]');await browser.until('document.querySelector("[data-ai-workflow-action=record]").getAttribute("aria-pressed")==="true"','Second generated recording did not start.');await delay(600);await click('[data-ai-workflow-action="record"]');await browser.until('document.querySelector(".ai-workflow-status").textContent.includes("Transcript ready")&&!('+workflowBusy+')','Generated recording did not become an editable transcript.');assert.equal(calls.filter(call=>call.path.endsWith('/transcribe')).length,audioCount+1);const planCount=calls.filter(call=>call.path.endsWith('/plan')).length;assert.equal(await evaluate('document.querySelector(".ai-workflow-command").disabled'),false);await delay(150);assert.equal(calls.filter(call=>call.path.endsWith('/plan')).length,planCount);record('real MediaRecorder output uses only transcription, then stops at an editable transcript without auto-planning');
    }
    await closeAssist();await nativeFetch();assert.ok(calls.every(call=>call.onlyAllowedFields&&call.modelGuardMatches));if(liveVoice)assert.deepEqual(calls.map(call=>call.path),liveVoiceOnly?['/api/ai/transcribe','/api/ai/plan']:['/api/ai/plan','/api/ai/transcribe','/api/ai/plan']);const external=browser.requests.filter(request=>!request.url.startsWith(origin)&&!request.url.startsWith('blob:')&&!request.url.startsWith('data:'));assert.equal(external.length,0);const uploads=browser.requests.filter(request=>request.method==='POST'&&!request.url.startsWith(`${origin}/api/ai/`));assert.equal(uploads.length,0);assert.equal(browser.errors.length,0);assert.equal(browser.consoleErrors.length,0);record('native fetch, exact allowlisted requests and local-only imaging persist with no browser exceptions or external requests');
    const hasScreenshot=liveVoice&&!liveVoiceOnly;
    await writeFile(resolve(output,'results.json'),JSON.stringify({passed:checks.length,checks,sourceDigest:build.sourceDigest,harnessSha256:createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'),gatewayOrigin:origin,model:profile.model,actualStandaloneApplication:true,nativeFetchUntouched:true,networkObservation:'CDP only',operationalEventPrivacy:'separately qualified by integration unit tests; standalone entrypoint has no event subscriber',genuineProviderUsed:live,genuineProviderCalls:live?calls.filter(call=>call.status===200).length:0,genuineVoiceTranscription:liveVoice,...(liveVoice?{generatedVoiceSource:voiceFixture.source,isolatedBrowserAudioFlags:['--disable-features=AudioServiceSandbox','--autoplay-policy=no-user-gesture-required'],productAudioCaptureUnchanged:true}:{}),...(hasScreenshot?{syntheticReviewScreenshot:'workflow-reviewed-ct-synthetic.png',screenshotScope:'Generated CT and generic reviewed workflow only; no original medical files or secrets'}:{}),requests:calls,originalImagingFilesUsed:false,credentialsRecorded:false,commandOrTranscriptRecorded:hasScreenshot,transcriptRecorded:false,modelProseRecorded:hasScreenshot,screenshotsRecorded:hasScreenshot,browserExceptions:0,consoleErrors:0,externalBrowserRequests:0},null,2)+'\n');console.log(`Standalone workflow checks: ${checks.length} passed.`);
}catch(error){
    let controlledUiCode=null;try{const message=await evaluate('document.querySelector(".ai-workflow-error")?.textContent??""'),{AI_ERROR_CODES,aiError}=await importRoot('src/ai/protocol.js');controlledUiCode=AI_ERROR_CODES.find(code=>aiError(code).message===message)??null;}catch{/* Never retain arbitrary UI text. */}
    const hasScreenshot=await stat(resolve(output,'workflow-reviewed-ct-synthetic.png')).then(()=>true,()=>false);
    await writeFile(resolve(output,'failure.json'),JSON.stringify({checks,sourceDigest:build?.sourceDigest,requests:calls,failure:{name:error.name,message:error.message,controlledUiCode},...(liveVoice?{isolatedBrowserAudioFlags:['--disable-features=AudioServiceSandbox','--autoplay-policy=no-user-gesture-required'],productAudioCaptureUnchanged:true}:{}),originalImagingFilesUsed:false,credentialsRecorded:false,commandOrTranscriptRecorded:hasScreenshot,transcriptRecorded:false,modelProseRecorded:hasScreenshot,screenshotsRecorded:hasScreenshot,...(hasScreenshot?{syntheticReviewScreenshot:'workflow-reviewed-ct-synthetic.png'}:{})},null,2)+'\n');throw error;}
finally{stopObserve?.();browser?.close();if(server)await new Promise(resolve=>server.close(resolve));if(temporary)await rm(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
