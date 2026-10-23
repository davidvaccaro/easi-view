import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

// Test-only driver is supplied externally. Never bundle Playwright into the viewer.
const driverPath = process.env.PLAYWRIGHT_MODULE;
if (!driverPath) throw new Error('Set PLAYWRIGHT_MODULE to the pinned external Playwright index.mjs.');
const { chromium, firefox, webkit } = await import(pathToFileURL(resolve(driverPath)).href);
const engines = { chromium, firefox, webkit };
const selected = (process.env.EASI_VIEW_ENGINES || 'chromium,firefox,webkit').split(',');
const modes = (process.env.EASI_VIEW_RENDER_MODES || 'auto,cpu').split(',');
assert.ok(selected.every(name => Object.hasOwn(engines, name)) && modes.every(mode => ['auto', 'cpu'].includes(mode)));
const dist = resolve(process.env.EASI_VIEW_DIST || 'dist');
const output = resolve(process.env.EASI_VIEW_ENGINE_OUTPUT || '/tmp/easi-view-engine-results');
const fixturePath = resolve(process.env.EASI_VIEW_ENGINE_FIXTURES || '/fixtures.json');
const sustained = process.env.EASI_VIEW_SUSTAINED === '1';
const buildInfo = JSON.parse(await readFile(resolve(dist, 'build-info.json'), 'utf8'));
const fixtureBytes = await readFile(fixturePath), fixtureData = JSON.parse(fixtureBytes);
assert.equal(fixtureData.schemaVersion, 1); assert.equal(fixtureData.cases.length, 20);
await mkdir(output, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const technicalRequests = [], control = { slow: null };
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
const hostHtml = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/qa/host.css"></head><body><main id="mount"></main><script type="module" src="/qa/host.js"></script></body></html>';
const hostScript = `import{createViewer}from'/assets/easi-view.js';window.__data=await(await fetch('/qa/fixtures.json')).json();window.__case=null;window.__readouts=new WeakMap();window.__uploads=new WeakMap();window.__workers={created:0,terminated:0,alive:0};window.__events=[];window.__capture=true;window.__mountCount=0;window.__expectedNativeSelectViolations=0;
const WorkerBase=window.Worker;window.Worker=class extends WorkerBase{constructor(...args){super(...args);window.__workers.created++;window.__workers.alive++;this.__ended=false;}terminate(){if(!this.__ended){this.__ended=true;window.__workers.terminated++;window.__workers.alive--;}return super.terminate();}};
const getContext=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(kind,...args){if(window.__cpu&&kind==='webgl2')return null;const gl=getContext.call(this,kind,...args);if(kind==='webgl2'&&gl&&!gl.__engineHook){gl.__engineHook=true;const canvas=this,draw=gl.drawArrays.bind(gl),upload=gl.texImage2D.bind(gl);gl.texImage2D=(...args)=>{if(args[8]?.length&&(args[6]===gl.RED||args[6]===gl.RGB))window.__uploads.set(canvas,Array.from(args[8]));return upload(...args);};gl.drawArrays=(...args)=>{draw(...args);const f=window.__case;if(!f||!window.__capture)return;const program=gl.getParameter(gl.CURRENT_PROGRAM),m=gl.getUniform(program,gl.getUniformLocation(program,'imageToClip'));if(!m)return;const values=[];for(let row=0;row<f.rows;row++)for(let column=0;column<f.columns;column++){const x=column+.5,y=row+.5,p=new Uint8Array(4);gl.readPixels(Math.floor((m[0]*x+m[3]*y+m[6]+1)*canvas.width/2),Math.floor((m[1]*x+m[4]*y+m[7]+1)*canvas.height/2),1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);values.push(...p);}window.__readouts.set(canvas,values);};}return gl;};
window.__file=name=>{const f=window.__data.cases.find(x=>x.name===name);return new File([Uint8Array.from(atob(f.encoded),x=>x.charCodeAt(0))],'synthetic-'+name+'.dcm',{type:'application/dicom'});};
window.__mount=async()=>{if(window.__v){window.__v.dispose();await window.__v.whenDisposed();}window.__v=createViewer(document.getElementById('mount'));for(const type of['framechange','sourcechange','annotationchange','error'])window.__v.on(type,detail=>window.__events.push({type,detail}));await window.__v.ready;window.__mountCount++;window.__shadow=document.getElementById('mount').querySelector('easi-view-embed').shadowRoot;window.__expectedNativeSelectViolations+=window.__shadow.querySelectorAll('select').length;};
window.__open=async name=>{window.__case=window.__data.cases.find(x=>x.name===name);await window.__v.openFiles([window.__file(name)]);};
window.__pixels=()=>{const f=window.__case,canvas=window.__shadow.querySelector('.workspace-pane[data-slot="'+window.__v.getWorkspaceState().activeViewport+'"] canvas'),gl=canvas.getContext('webgl2');if(gl)return{backend:'WebGL2',pixels:window.__readouts.get(canvas),stored:window.__uploads.get(canvas)};const context=canvas.getContext('2d'),r=canvas.getBoundingClientRect(),spacing=f.pixelSpacing||[.75,.75],scale=Math.min(r.width/(f.columns*spacing[1]),r.height/(f.rows*spacing[0])),left=(r.width-scale*f.columns*spacing[1])/2,top=(r.height-scale*f.rows*spacing[0])/2,pixels=[];for(let row=0;row<f.rows;row++)for(let column=0;column<f.columns;column++){const x=left+scale*spacing[1]*(column+.5),y=top+scale*spacing[0]*(row+.5);pixels.push(...context.getImageData(Math.floor(x*canvas.width/r.width),Math.floor(y*canvas.height/r.height),1,1).data);}return{backend:'Canvas2D',pixels,stored:null};};
window.__probe=()=>{const f=window.__case,canvas=window.__shadow.querySelector('.workspace-pane[data-slot="'+window.__v.getWorkspaceState().activeViewport+'"] canvas'),r=canvas.getBoundingClientRect(),spacing=f.pixelSpacing||[.75,.75],scale=Math.min(r.width/(f.columns*spacing[1]),r.height/(f.rows*spacing[0])),left=(r.width-scale*f.columns*spacing[1])/2,top=(r.height-scale*f.rows*spacing[0])/2;window.__v.setTool('probe');canvas.dispatchEvent(new PointerEvent('pointermove',{clientX:r.left+left+scale*spacing[1]*.5,clientY:r.top+top+scale*spacing[0]*.5,bubbles:true}));return{coordinate:window.__shadow.getElementById('probe-coordinate').textContent,stored:window.__shadow.getElementById('probe-stored').textContent};};
window.__snapshot=()=>({state:window.__v.getState(),performance:window.__v.getPerformance(),workspace:window.__v.getWorkspaceState(),workers:{...window.__workers},backendLabel:window.__shadow.querySelector('[data-pane-id="renderer-label"]').textContent});await window.__mount();window.__ready=true;`;
const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'report-sample' 'sha256-${buildInfo.inlineStyleSha256}'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`);
    if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    const send = (type, bytes) => { response.writeHead(200, { 'Content-Type': type }); response.end(bytes); };
    if (path === '/qa/index.html') { send(contentTypes['.html'], hostHtml); return; }
    if (path === '/qa/host.css') { send(contentTypes['.css'], 'body{margin:0;background:#101820}#mount{height:950px;width:100%}'); return; }
    if(path==='/qa/csp.html'){send(contentTypes['.html'],'<!doctype html><div id="control"></div><script type="module" src="/qa/csp.js"></script>');return;}
    if(path==='/qa/csp.js'){send(contentTypes['.js'],`const root=document.getElementById('control');root.innerHTML='<select><option>Synthetic</option></select><span id="prohibited" style="color:rgb(255,0,0)">Synthetic</span>';await new Promise(r=>setTimeout(r,100));window.__cspColor=getComputedStyle(document.getElementById('prohibited')).color;window.__ready=true;`);return;}
    if (path === '/qa/host.js') { send(contentTypes['.js'], hostScript); return; }
    if (path === '/qa/fixtures.json') { send(contentTypes['.json'], fixtureBytes); return; }
    if (path.endsWith('/metadata') && path.startsWith('/archive/')) {
        technicalRequests.push({ type: 'metadata' }); send('application/dicom+json', JSON.stringify(fixtureData.archive.instances.map(item => item.metadata))); return;
    }
    const instance = path.match(/^\/archive\/studies\/[^/]+\/series\/[^/]+\/instances\/([^/]+)$/);
    if (instance) {
        const index = fixtureData.archive.instances.findIndex(item => item.sopUid === instance[1]);
        if (index < 0) { response.writeHead(404); response.end(); return; }
        const log = { type: 'instance', index }; technicalRequests.push(log);
        response.on('close', () => { if (!response.writableEnded) log.canceled = true; });
        // Keep this request pending across software-GPU readbacks and pane UI
        // activation; cancellation must reach a genuinely in-flight HTTP fetch.
        if (index === control.slow) await new Promise(resolveDelay => setTimeout(resolveDelay, 5000));
        if (!response.destroyed) send('application/dicom', Buffer.from(fixtureData.archive.instances[index].encoded, 'base64')); return;
    }
    let file;
    try { file = resolve(dist, '.' + decodeURIComponent(path)); if (!file.startsWith(dist + sep) || !(await stat(file)).isFile()) throw new Error(); }
    catch { response.writeHead(404); response.end(); return; }
    send(contentTypes[extname(file)] || 'application/octet-stream', await readFile(file));
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;
const receipts = [];

function expectedRgba(fixture, frame, series = 0) {
    const encoded = fixture.enhanced ? fixture.expectedGroups[series][frame] : frame;
    if (fixture.expectedRgb) return fixture.expectedRgb[frame].flatMap((value, index) => index % 3 === 2 ? [value, 255] : [value]);
    if (fixture.expectedLevels) return fixture.expectedLevels[frame].flatMap(level => [Math.round(level * 255), Math.round(level * 255), Math.round(level * 255), 255]);
    const original = fixture.expectedSamples[encoded];
    if (fixture.samplesPerPixel === 3) return original.flatMap((value, index) => index % 3 === 2 ? [value, 255] : [value]);
    const slope = fixture.enhanced ? encoded + 1 : 1, intercept = fixture.enhanced ? -100 * (encoded + 1) : 0;
    const { center, width } = fixture.window;
    return original.flatMap(value => { const level = Math.round(Math.max(0, Math.min(1, (value * slope + intercept - (center - 0.5)) / (width - 1) + 0.5)) * 255); return [level, level, level, 255]; });
}
function checkPixels(actual, expected, tolerance) {
    assert.equal(actual.length, expected.length);
    actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <= (index % 4 === 3 ? 0 : tolerance), `Rendered sample ${index} differs from synthetic reference: ${value} / ${expected[index]}`));
}
function checkResources(snapshot) {
    assert.equal(snapshot.resources.overlayBytes,0);assert.equal(snapshot.resources.overlayRenderBytes,0);
    assert.ok(snapshot.resources.encodedBytes <= 256 * 1024 * 1024);
    assert.ok((snapshot.resources.thumbnailBytes||0) <= 4*1024*1024);
    assert.ok((snapshot.resources.encodedCacheBytes||0) <= 64*1024*1024);
    assert.ok(snapshot.resources.decodedCacheBytes <= 64 * 1024 * 1024);
    assert.ok(snapshot.resources.workerCount <= 1); assert.ok(snapshot.measurements.length <= 256);
}

try {
    for (const name of selected) for (const mode of modes) {
        const checks = [], errors = [], consoleErrors = [], requests = [];
        const record = (description, detail = {}) => { checks.push({ description, ...detail }); console.error(`PASS ${name}/${mode} ${description}`); };
        const launchOptions = { headless: true, ...(name === 'chromium' ? { chromiumSandbox: true } : {}) };
        const browser = await engines[name].launch(launchOptions);
        const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 });
        await context.addInitScript(({ cpu }) => { window.__cpu = cpu;window.__csp=[];document.addEventListener('securitypolicyviolation',event=>window.__csp.push({disposition:event.disposition,effectiveDirective:event.effectiveDirective,blockedURI:event.blockedURI,sample:event.sample,sourcePath:event.sourceFile?new URL(event.sourceFile).pathname:null})); }, { cpu: mode === 'cpu' });
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
        page.on('request', request => requests.push({ sameOrigin: request.url().startsWith(origin + '/'), method: request.method() }));
        await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
        try {
            const controlPage=await context.newPage();await controlPage.goto(origin+'/qa/csp.html');await controlPage.waitForFunction(()=>window.__ready);const cspControl=await controlPage.evaluate(()=>({color:window.__cspColor,violations:window.__csp}));await controlPage.close();
            assert.equal(cspControl.color,'rgb(0, 0, 0)');assert.equal(cspControl.violations.filter(v=>v.sample==='color:rgb(255,0,0)'&&v.effectiveDirective==='style-src-attr'&&v.disposition==='enforce').length,1);const controlNative=cspControl.violations.filter(v=>v.sample==='text-overflow:inherit'&&v.effectiveDirective==='style-src-attr'&&v.disposition==='enforce').length;assert.equal(controlNative,name==='webkit'?1:0);assert.equal(cspControl.violations.length,1+controlNative);
            await page.goto(origin + '/qa/index.html'); await page.waitForFunction(() => window.__ready);
            const capabilities = await page.evaluate(() => ({ userAgent: navigator.userAgent, secureContext: isSecureContext,
                crossOriginIsolated, workers: typeof Worker === 'function', wasm: typeof WebAssembly === 'object', cpuForced: window.__cpu }));
            const styleScope=await page.evaluate(async()=>{const s=window.__shadow,style=s.querySelector('style'),hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(style.textContent));return{hash:btoa(String.fromCharCode(...new Uint8Array(hash))),rules:style.sheet?.cssRules?.length,display:getComputedStyle(s.getElementById('workspace')).display};});assert.equal(styleScope.hash,buildInfo.inlineStyleSha256);assert.ok(styleScope.rules>250);assert.equal(styleScope.display,'grid');
            record('strict CSP blocks prohibited inline styles while the exact embedded stylesheet hash and grid styling apply',{nativeSelectControlViolationReproduced:controlNative===1});
            const profiles = [];
            for (const fixture of fixtureData.cases) {
                await page.evaluate(name => window.__open(name), fixture.name);
                const seriesCount = fixture.seriesCount ?? 1;
                const observed = [];
                for (let series = 0; series < seriesCount; series++) {
                    if (seriesCount > 1) await page.evaluate(index => window.__v.setSeries(index), series);
                    for (const frame of [...new Set([0, fixture.frameCount - 1])]) {
                        await page.evaluate(async ({ frame, window: range }) => { await window.__v.setFrame(frame); if (range) window.__v.setWindow(range); else window.__v.reset(); }, { frame, window: fixture.samplesPerPixel === 1 ? fixture.window : null });
                        const pixels = await page.evaluate(() => window.__pixels());
                        checkPixels(pixels.pixels, expectedRgba(fixture, frame, series), (fixture.tolerance || 0) + (fixture.samplesPerPixel === 3 ? 0 : 1));
                        if (pixels.stored && !fixture.presentation) {
                            const original = fixture.expectedSamples[fixture.enhanced ? fixture.expectedGroups[series][frame] : frame];
                            assert.equal(pixels.stored.length, original.length);
                            pixels.stored.forEach((value, index) => assert.ok(Math.abs(value - original[index]) <= fixture.tolerance));
                        }
                        const probe=await page.evaluate(()=>window.__probe());assert.equal(probe.coordinate,'Pixel (0, 0)');const encoded=fixture.enhanced?fixture.expectedGroups[series][frame]:frame;const original=fixture.expectedSamples[encoded];if(fixture.samplesPerPixel===3){const rgb=probe.stored.match(/R (\d+) · G (\d+) · B (\d+)/);assert.ok(rgb);rgb.slice(1).forEach((value,index)=>assert.ok(Math.abs(Number(value)-original[index])<=fixture.tolerance));}else{const stored=probe.stored.match(/Stored(?: index)?: (-?[\d,.]+)/);assert.ok(stored);assert.ok(Math.abs(Number(stored[1].replaceAll(',',''))-original[0])<=fixture.tolerance);}
                        observed.push({ series, frame, backend: pixels.backend, originalProbeVerified:true });
                    }
                }
                profiles.push({ name: fixture.name, checks: observed, sampleTolerance: fixture.tolerance, displayTolerance: fixture.tolerance + (fixture.samplesPerPixel === 3 ? 0 : 1) });
                record(fixture.name + ' independent first/last-frame display and probes; original GPU samples when available', { selectedFrames: observed.length, backends: [...new Set(observed.map(value => value.backend))] });
            }
            await page.evaluate(async () => { await window.__open('timed');window.__v.play(); });
            await page.waitForFunction(() => window.__v.getState().frameIndex === 3 && !window.__v.getState().playing);
            assert.equal(await page.evaluate(() => window.__shadow.getElementById('cine-fps').value), 'native');
            record('declared variable FrameTimeVector selects Recorded timing and stops at its final original frame');
            await page.evaluate(() => window.__open('native-16'));
            await page.evaluate(async () => { await window.__v.setLayout(4); for (let slot = 1; slot < 4; slot++) await window.__v.assignViewportSeries(slot, 0); window.__v.setActiveViewport(1); await window.__v.setFrame(19); window.__v.setWindow({ center: 128, width: 256 }); });
            let snapshot = await page.evaluate(() => window.__snapshot());
            assert.deepEqual(snapshot.workspace.viewports.map(value => value.frameIndex), [0, 19, 0, 0]);
            assert.equal(snapshot.workspace.viewports[0].window.width, 4096); assert.equal(snapshot.workspace.viewports[1].window.width, 256); checkResources(snapshot.performance);
            const geometry=await page.evaluate(()=>Array.from(window.__shadow.querySelectorAll('.workspace-pane')).map(p=>{const r=p.getBoundingClientRect();return{left:r.left,top:r.top,width:r.width,height:r.height};}));assert.equal(geometry.length,4);geometry.forEach(r=>{assert.ok(r.width>100);assert.ok(r.height>100);});assert.ok(geometry[0].left!==geometry[1].left);assert.ok(geometry[0].top!==geometry[2].top);
            await page.evaluate(async () => { await window.__v.setLayout(2); await window.__v.setLayout(1); });
            record('1/2/4 layouts keep independent pane navigation and windows within one decoded budget');

            const annotations = await page.evaluate(async () => { const v=window.__v; v.setActiveViewport(0); await v.setFrame(0); const annotation=v.addAnnotation({tool:'rectangle',points:[{x:0,y:0},{x:8,y:8}]}); const result=v.measureAnnotation(annotation.id); const exported=v.exportAnnotations();v.clearAnnotations();v.importAnnotations(exported);const unsub=[v.on('annotationchange',()=>{throw new Error('Synthetic host callback failure');}),v.on('framechange',async()=>{throw new Error('Synthetic asynchronous host callback failure');})];try{v.addAnnotation({tool:'length',points:[{x:.5,y:.5},{x:1.5,y:.5}]});await v.setFrame(1);await v.setFrame(0);await new Promise(resolve=>setTimeout(resolve,20));return{result,count:v.getAnnotationState().count};}finally{unsub.forEach(fn=>fn());}});
            assert.equal(annotations.result.statistics.pixelCount, 64); assert.equal(annotations.result.statistics.stored.mean, 0); assert.equal(annotations.count, 2);
            record('image-bound annotation statistics/import and failing synchronous/asynchronous host observers remain isolated');

            const canceledStart = technicalRequests.length; control.slow = 1;
            await page.evaluate(async ({ origin, study, series }) => { const v=window.__v;v.configureArchive({baseUrl:origin+'/archive/'});await v.openArchiveSeries(study,series);await v.setLayout(2);await v.assignViewportSeries(1,0);v.setActiveViewport(0);window.__pending=v.setFrame(1).then(()=>({success:true}),error=>({success:false,name:error.name})); }, { origin, study: fixtureData.archive.studyUid, series: fixtureData.archive.seriesUid });
            for (let step = 0; step < 100 && !technicalRequests.slice(canceledStart).some(request => request.index === 1); step++) await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
            await page.evaluate(async () => { window.__v.setActiveViewport(1);window.__neighbor=window.__v.setFrame(2).then(()=>({success:true}),error=>({success:false,name:error.name}));window.__v.setActiveViewport(0);await window.__v.setFrame(0); });
            const canceled = await page.evaluate(async () => ({ pending: await window.__pending, neighbor: await window.__neighbor, state: window.__v.getWorkspaceState() }));
            assert.equal(canceled.pending.success, false); assert.equal(canceled.pending.name, 'AbortError'); assert.equal(canceled.neighbor.success, true);
            assert.deepEqual(canceled.state.viewports.map(value => value.frameIndex), [0, 2]); control.slow = null;
            for (let step = 0; step < 100 && !technicalRequests.slice(canceledStart).some(request => request.index === 1 && request.canceled); step++) await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
            assert.ok(technicalRequests.slice(canceledStart).some(request => request.index === 1 && request.canceled), JSON.stringify(technicalRequests.slice(canceledStart)));
            record('canceled lazy archive navigation stops its HTTP request without canceling the neighboring pane');

            if(await page.evaluate(()=>typeof window.__v.setPrefetch==='function')){const prefetchStart=technicalRequests.length;control.slow=1;await page.evaluate(()=>window.__v.setPrefetch({enabled:true,neighbors:1}));for(let step=0;step<100&&!technicalRequests.slice(prefetchStart).some(r=>r.index===1);step++)await new Promise(r=>setTimeout(r,10));assert.ok(technicalRequests.slice(prefetchStart).some(r=>r.index===1));await page.evaluate(()=>window.__v.setFrame(2));for(let step=0;step<100&&!technicalRequests.slice(prefetchStart).some(r=>r.index===1&&r.canceled);step++)await new Promise(r=>setTimeout(r,10));assert.ok(technicalRequests.slice(prefetchStart).some(r=>r.index===1&&r.canceled));await page.evaluate(()=>window.__v.setPrefetch({enabled:false}));control.slow=null;record('opt-in idle prefetch is preempted by foreground navigation and retains bounded shared caches');}
            let session = null;
            if (sustained) {
                await page.evaluate(async () => { await window.__v.setLayout(1);await window.__open('native-16');window.__v.clearAnnotations();window.__capture=false; });
                const start = Date.now();
                const seeks = await page.evaluate(async () => { const samples=[];for(let index=0;index<1000;index++){await window.__v.setFrame(index%20);if(index%10===0)window.__v.setTool(index%20?'pan':'window');if(index%50===0){const p=window.__v.getPerformance();samples.push({step:index,resources:p.resources,measurements:p.measurements.length});}}return{samples,final:window.__v.getPerformance()}; });
                seeks.samples.forEach(value => checkResources({ resources: value.resources, measurements: Array(value.measurements) })); checkResources(seeks.final);
                const mounts = await page.evaluate(async () => { const records=[];for(let index=0;index<50;index++){window.__v.dispose();await window.__v.whenDisposed();const p=window.__v.getPerformance();if(p.resources.workerCount||p.resources.encodedBytes||p.resources.decodedCacheBytes||p.resources.overlayBytes||p.resources.overlayRenderBytes||p.resources.cleanupPending)throw new Error('Disposal retained owned resources or incomplete cleanup');await window.__mount();await window.__open('native-16');records.push({index,resources:window.__v.getPerformance().resources});}return records; });
                await page.evaluate(async()=>{window.__capture=true;await window.__v.setFrame(19);});checkPixels((await page.evaluate(()=>window.__pixels())).pixels,expectedRgba(fixtureData.cases[0],19),1);
                mounts.forEach(value => checkResources({ resources: value.resources, measurements: [] }));
                session = { seeks: 1000, sourceRemounts: 50, elapsedMs: Date.now() - start, samples: seeks.samples, resourcesAfterLastMount: mounts.at(-1).resources,
                    scope: 'Retained application pixel/cache/worker counters, not process heap or GPU allocation.' };
                record('1000 seeks/tool changes and 50 dispose/remount cycles retain bounded pixels/workers/history');
            }
            const disposed = await page.evaluate(async () => {const before=window.__v.getPerformance();window.__v.dispose();await window.__v.whenDisposed();return{before,after:window.__v.getPerformance(),workers:window.__workers,events:window.__events};});
            assert.equal(disposed.after.resources.encodedBytes, 0); assert.equal(disposed.after.resources.decodedCacheBytes, 0); assert.equal(disposed.after.resources.workerCount, 0); assert.equal(disposed.workers.alive, 0);assert.equal(disposed.after.resources.overlayBytes,0);assert.equal(disposed.after.resources.overlayRenderBytes,0);assert.equal(disposed.after.resources.cleanupPending,false);
            assert.ok(!/"(?:sopUid|seriesUid|studyUid|patientName|patientId|points|samples|pixelData)"\s*:|2\.25\.(?:970|980|810)/.test(JSON.stringify(disposed.events)));
            assert.ok(requests.every(request => request.sameOrigin && request.method === 'GET'));
            assert.equal(errors.length,0,JSON.stringify(errors));
            const cspViolations=await page.evaluate(()=>window.__csp),expectedNative=await page.evaluate(()=>window.__expectedNativeSelectViolations);
            const nativeSelectViolations=cspViolations.filter(v=>name==='webkit'&&controlNative===1&&v.disposition==='enforce'&&v.effectiveDirective==='style-src-attr'&&v.blockedURI==='inline'&&v.sample==='text-overflow:inherit'&&v.sourcePath==='/assets/easi-view.js');
            assert.equal(cspViolations.length,nativeSelectViolations.length,'Unexpected CSP violation');
            assert.equal(nativeSelectViolations.length,name==='webkit'?expectedNative:0);
            const nativeConsoleMessage="Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.";
            assert.equal(consoleErrors.length,nativeSelectViolations.length);
            assert.ok(consoleErrors.every(message=>message===nativeConsoleMessage));
            record('disposal releases retained resources and all operations keep files/IDs/pixels private without uploads');
            const receipt = { engine: name, engineVersion: browser.version(), mode, passed: checks.length, checks, capabilities, profiles, sustained: session,
                sourceDigest: buildInfo.sourceDigest, buildArtifactFiles: buildInfo.files, harnessSha256: hash(await readFile(import.meta.filename)), fixtureSha256: hash(fixtureBytes),
                environment: { platform: process.platform, arch: process.arch, node: process.version, containerImage: process.env.EASI_VIEW_ENGINE_IMAGE || null, isolatedLoopbackOnly: true },
                boundary: 'Pinned Playwright Linux browser engines in an isolated container; this does not substitute for native Safari or mobile-device verification.',
                browserExceptions:errors,applicationConsoleErrors:[],consoleErrors,csp:{styleScope,positiveControl:cspControl,nativeSelectViolationCount:nativeSelectViolations.length,nativeSelectViolations,applicationViolations:[],limitation:nativeSelectViolations.length?'WebKit27.2 user-agent select-control text-overflow:inherit triggers style-src-attr enforcement; reproduced in an otherwise empty select. Strict policy was preserved.':null,upstreamReference:'https://github.com/WebKit/WebKit/blob/main/Source/WebCore/html/HTMLSelectElement.cpp'},requests: { count: requests.length, uploads: 0, external: 0 }, finalResources: disposed.after.resources,
                originalImagingFilesUsed: false, profilesSaved: false };
            await writeFile(resolve(output, `${name}-${mode}.json`), JSON.stringify(receipt, null, 2) + '\n');
            receipts.push({ engine: name, mode, passed: checks.length, engineVersion: receipt.engineVersion, sourceDigest: buildInfo.sourceDigest });
        } catch(error){await writeFile(resolve(output,`${name}-${mode}-failure.json`),JSON.stringify({engine:name,mode,sourceDigest:buildInfo.sourceDigest,completed:checks,error:{name:error.name,message:error.message},browserExceptions:errors,consoleErrors,csp:await page.evaluate(()=>window.__csp).catch(()=>[]),originalImagingFilesUsed:false},null,2)+'\n');throw error;} finally { await context.close(); await browser.close(); }
    }
    await writeFile(resolve(output, 'summary.json'), JSON.stringify({ passed: receipts.reduce((sum, receipt) => sum + receipt.passed, 0), receipts,
        sourceDigest: buildInfo.sourceDigest, fixtureSha256: hash(fixtureBytes), originalImagingFilesUsed: false }, null, 2) + '\n');
    console.error(`Cross-engine checks passed: ${receipts.reduce((sum, receipt) => sum + receipt.passed, 0)} groups.`);
} finally { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); }
