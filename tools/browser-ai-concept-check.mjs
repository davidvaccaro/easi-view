import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir, mkdtemp, readFile, writeFile, rm, stat} from 'node:fs/promises';
import {resolve, join, extname, sep} from 'node:path';
import {tmpdir, homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {browserSession, delay} from './browser-session.mjs';

// Qualify real standalone controls, source indexing and display. The default
// authenticated HTTP gateway has a deterministic intent provider. Explicit
// --origin + --live-budget opts into genuine planner calls; live mode never
// intercepts or replaces the provider, native fetch, source catalog or UI.
// All imaging files are independently generated and enter through File API.
const args=process.argv.slice(2), option=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
const root=resolve(option('--source-root')??resolve(import.meta.dirname,'..'));
const output=resolve(option('--output')??resolve(root,'artifacts/browser-ai-concept'));
const live=Boolean(option('--origin')), importRoot=name=>import(pathToFileURL(resolve(root,name))), quote=JSON.stringify;
const CASES=Object.freeze([
    {id:'routine-windows',command:'Set up this chest CT for routine review.',layout:2,series:[317,317],windows:['lung','soft-tissue'],sync:{slice:true,window:false,camera:true}},
    {id:'lung-review',command:'Prepare a one-pane lung review of this CT.',layout:1,series:[317],windows:['lung']},
    {id:'bone-review',command:'Prepare a one-pane bone review of this CT.',layout:1,series:[317],windows:['bone']},
    {id:'energy-comparison',command:'Compare the lowest-energy monoenergetic axial CT reconstruction with the blended axial reconstruction side by side, both in soft-tissue windows.',layout:2,series:[313,317],windows:['soft-tissue','soft-tissue']},
    {id:'three-windows',command:'Show the routine axial CT in lung, soft-tissue and bone windows in three panes of a four-pane layout.',layout:4,series:[317,317,317],windows:['lung','soft-tissue','bone']},
    {id:'middle-ellipse',command:'Open the routine axial CT at its middle image and activate the ellipse measurement tool.',layout:1,series:[317],positions:[3],tool:'ellipse'},
    {id:'middle-distance',command:'Open the routine axial CT at its middle image and activate the distance measurement tool.',layout:1,series:[317],positions:[3],tool:'distance'},
    {id:'cine',command:'Open the routine axial CT and play through its images.',layout:1,series:[317],playing:true},
    {id:'first-last',command:'Show the first and last images of the routine axial CT side by side without linking them.',layout:2,series:[317,317],positions:[1,5],sync:{slice:false,window:false,camera:false}},
    {id:'prior-comparison',command:'Compare this current CT with the most recent prior CT side by side in soft-tissue windows, without linking them.',includePrior:true,layout:2,series:[317,417],windows:['soft-tissue','soft-tissue'],sync:{slice:false,window:false,camera:false}}
]);
const requested=option('--cases')?.split(',')??CASES.map(item=>item.id), selected=CASES.filter(item=>requested.includes(item.id));
if(!selected.length||selected.length!==requested.length||selected.length!==new Set(requested).size||requested.some(id=>!CASES.some(item=>item.id===id)))throw new Error('--cases must contain distinct known conceptual scenario IDs.');
if(live&&Number(option('--live-budget'))!==selected.length)throw new Error('Live qualification requires --live-budget equal to the selected case count (maximum ten requests).');
const cadence=live?Number(option('--live-interval-ms')??11000):0;
if(!Number.isSafeInteger(cadence)||cadence<0||cadence>60000)throw new Error('Choose a bounded live planner interval.');
const checks=[],calls=[],authRequests=[],resources=new Map();let browser,temporary,server,origin,build,profile,stopObserve,lastPlanAt=0,currentCase=null;
const evaluate=expression=>browser.evaluate(expression),busy='document.querySelector(".ai-assist-workflow")?.getAttribute("aria-busy")==="true"';
const record=(name,details={})=>{checks.push({name,...details});console.log(`PASS ${name}`);};
const PRESETS={lung:{width:1500,center:-600},'soft-tissue':{width:400,center:40},bone:{width:2000,center:500}};
const selector=changes=>({study:'active',modality:'CT',plane:'axial',contrast:null,bodyPart:null,purpose:'routine',reconstruction:'ordinary',energyKeV:null,energyPreference:null,thickness:null,kernel:null,...changes});
const view=(viewport,changes)=>({type:'select-view',viewport,selector:selector(changes)});
const window=(viewport,preset)=>({type:'window',viewport,preset});
const sync=(slice=false,camera=false)=>({type:'synchronize',slice,window:false,camera});
function fixturePlan(command){
    const item=CASES.find(item=>item.command===command);
    if(command==='Find the largest liver slice and measure the right lobe.')return{version:1,status:'unsupported',summary:'Automatic anatomical image analysis and measurement are unavailable.',question:null,actions:[]};
    assert.ok(item,'Only independently authored conceptual commands are accepted by the fixture provider.');
    const actions=[{type:'layout',count:item.layout}];
    if(item.id==='energy-comparison')actions.push(view(0,{purpose:'soft-tissue',reconstruction:'monoenergetic',energyPreference:'lowest'}),view(1,{purpose:'soft-tissue',reconstruction:'blended'}));
    else if(item.id==='prior-comparison')actions.push(view(0,{purpose:'soft-tissue'}),view(1,{study:'prior',purpose:'soft-tissue'}));
    else for(let viewport=0;viewport<item.series.length;viewport++)actions.push(view(viewport,{purpose:item.id==='lung-review'?'lung':item.id==='bone-review'?'bone':'routine'}));
    for(const [viewport,preset]of(item.windows??[]).entries())actions.push(window(viewport,preset));
    if(item.id==='first-last')actions.push({type:'position',viewport:0,position:'first'},{type:'position',viewport:1,position:'last'});
    else if(item.positions)actions.push({type:'position',viewport:0,position:'middle'});
    if(item.tool)actions.push({type:'tool',tool:item.tool==='distance'?'length':item.tool});
    if(item.playing)actions.push({type:'cine',viewport:0,playing:true});
    if(item.sync)actions.push(sync(item.sync.slice,item.sync.camera));
    assert.ok(actions.length<=12);
    return{version:1,status:'ready',summary:'Prepare the requested viewing workflow for local review.',question:null,actions};
}
async function click(css){
    const point=await evaluate(`(()=>{const n=document.querySelector(${quote(css)});if(!n||n.hidden||n.disabled)return null;n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return r.width&&r.height?{x:r.left+r.width/2,y:r.top+r.height/2}:null;})()`);
    assert.ok(point,`Required standalone control unavailable: ${css}`);
    await browser.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await browser.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
}
async function nativeFetch(){assert.equal(await evaluate('Function.prototype.toString.call(globalThis.fetch).includes("[native code]")'),true);}
async function ready(){await browser.until('Boolean(document.querySelector("#header-ai-assist")&&!document.querySelector("#header-ai-assist").hidden)','The standalone viewer did not mount.',live?600:240);await nativeFetch();}
async function closeAssist(){if(await evaluate('Boolean(document.querySelector(".ai-assist")?.open)'))await click('[data-ai-action="close"]');}
async function openAssist(){await click('#header-ai-assist');await browser.until('document.querySelector(".ai-assist").open&&!document.querySelector(".ai-assist-workflow").hidden','The Tasks tab did not mount.');}
async function settle(){await browser.until(`!(${busy})`,'The viewer task did not settle.',live?650:200);}
async function state(){
    return evaluate(`(()=>{const normalized=value=>value.replaceAll(',','').replaceAll('−','-');const panes=[...document.querySelectorAll('.workspace-pane')].map(p=>{const label=p.querySelector('[data-pane-id=frame-overlay]').textContent,match=label.match(/Image\\s+(\\d+)\\s*\\/\\s*(\\d+)/),win=normalized(p.querySelector('[data-pane-id=window-overlay]').textContent).match(/W\\s+(-?[\\d.]+)\\s*·\\s*L\\s+(-?[\\d.]+)/);return{slot:Number(p.dataset.slot),empty:!p.querySelector('[data-pane-id=viewport-empty]').hidden,frame:match?Number(match[1]):null,total:match?Number(match[2]):null,window:win?{width:Number(win[1]),center:Number(win[2])}:null};});const bindings=[...document.querySelectorAll('.session-library-series')].flatMap(card=>{const number=card.querySelector('.session-library-series-counts')?.textContent.match(/Series (\\d+)\\b/),study=card.closest('.session-library-study');return[...card.querySelectorAll('.session-library-pane-badge')].map(badge=>({slot:badge.textContent.charCodeAt(badge.textContent.length-1)-65,seriesNumber:number?Number(number[1]):null,study:study?.querySelector('.session-library-study-description')?.textContent??null}));});return{layout:Number(document.querySelector('#workspace').dataset.layout),panes,bindings,sync:{slice:document.querySelector('#sync-slices').checked,window:document.querySelector('#sync-window').checked,camera:document.querySelector('#sync-camera').checked},playing:document.querySelector('#cine-toggle').getAttribute('aria-pressed')==='true',tool:document.querySelector('.primary-tools [data-tool][aria-pressed=true]')?.dataset.tool??null,selected:document.querySelector('.session-library-series.is-selected .session-library-series-title')?.textContent??null,session:document.querySelector('#session-summary').textContent};})()`);
}
async function fresh(files,includePrior=false){
    await closeAssist();
    if(await evaluate('!document.querySelector("#session-summary").textContent.startsWith("0 patients")')){await click('#primary-menu-toggle');await click('#primary-menu-close');await browser.until('document.querySelector("#session-summary").textContent.startsWith("0 patients")','The prior generated session did not close.');}
    await click('#header-import');await click('[data-open-action="images"]');await browser.send('Page.setInterceptFileChooserDialog',{enabled:true});await click('[data-open-action="pick-files"]');
    const input=await browser.send('Runtime.evaluate',{expression:'document.querySelector("#file-input")',returnByValue:false});await browser.send('DOM.setFileInputFiles',{objectId:input.result.objectId,files});
    await browser.until('Boolean(document.querySelector("[data-open-action=add]")&&!document.querySelector("[data-open-action=add]").disabled)','Generated import review did not finish.');await click('[data-open-action="add"]');
    await browser.until('!document.querySelector(".open-workflow").open&&document.querySelector("#frame-overlay").textContent.startsWith("Image ")','Generated images did not open.');
    const before=await state();assert.equal(before.layout,1);assert.match(before.selected,/SCOUT/);assert.equal(before.bindings[0]?.seriesNumber,301);assert.match(before.session,includePrior?/1 patient · 2 studies/:/1 patient · 1 study/);assert.equal(before.playing,false);await openAssist();return before;
}
async function plan(command){
    if(live&&lastPlanAt){const remaining=cadence-(Date.now()-lastPlanAt);if(remaining>0)await delay(remaining);}
    await evaluate(`(()=>{const n=document.querySelector('.ai-workflow-command');n.value=${quote(command)};n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const count=calls.length;lastPlanAt=Date.now();await click('[data-ai-workflow-action="plan"]');await browser.until(`!document.querySelector('.ai-workflow-review').hidden&&!(${busy})||!document.querySelector('.ai-workflow-error').hidden`,'The reviewed plan did not return.',live?650:180);
    assert.equal(calls.length,count+1);assert.equal(calls.at(-1).status,200);assert.equal(await evaluate('document.querySelector(".ai-workflow-error").hidden'),true,'The planner must return a valid bounded task.');
}
async function run(){assert.equal(await evaluate('document.querySelector("[data-ai-workflow-action=run]").disabled'),false,'An unambiguous, grounded conceptual task should enable Run.');await click('[data-ai-workflow-action="run"]');await settle();assert.equal(await evaluate('document.querySelector(".ai-workflow-error").hidden'),true,'The reviewed task should execute.');}
async function revealPriorForVerification(){
    // A collapsed library card has no DOM assignment badges. Expand it only
    // after Run completed to inspect the existing assignment; never select a
    // source or prepare the workflow manually. Closing preserves Undo.
    await closeAssist();
    const target=await evaluate('[...document.querySelectorAll(".session-library-study")].find(n=>n.querySelector(".session-library-study-description")?.textContent==="SYNTHETIC PRIOR CT")?.dataset.studyId');assert.ok(target);
    const css=`[data-session-action="toggle-study"][data-study-id=${quote(target)}]`;
    if(await evaluate(`document.querySelector(${quote(css)}).getAttribute('aria-expanded')!=="true"`))await click(css);
    await openAssist();
}
async function startMock(){
    const{AiGateway}=await importRoot('examples/ai-gateway/gateway.mjs'),passcode='generated-conceptual-workflow-invitation';let gateway;
    const provider={model:'generated-concept-qualification',async*generate(){yield'Connected.';},async plan(request){return{version:1,model:this.model,plan:fixturePlan(request.command)};}};
    const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.wasm':'application/wasm'};
    server=createServer(async(request,response)=>{response.setHeader('Cache-Control','no-store');response.setHeader('X-Content-Type-Options','nosniff');const path=new URL(request.url,origin).pathname;
        if(path.startsWith('/api/ai/')){let body='';for await(const chunk of request){body+=chunk;if(Buffer.byteLength(body)>32768){response.writeHead(413);response.end();return;}}const result=await gateway.handle({method:request.method,path,headers:request.headers,body,ip:'generated-concept-fixture'});response.writeHead(result.status,result.headers);if(typeof result.body==='string')response.end(result.body);else{for await(const chunk of result.body)response.write(chunk);response.end();}return;}
        if(!['GET','HEAD'].includes(request.method)){response.writeHead(405);response.end();return;}
        if(path==='/viewer-config.json'){response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({ai:{enabled:true,workflows:true,workflowPreferences:{routineCt:'blended'},baseUrl:'/api/ai',label:'Generated conceptual workflow qualification',recipient:'Deterministic loopback only',model:provider.model,credentials:'same-origin'}}));return;}
        const target=resolve(root,'dist','.'+(path==='/'?'/index.html':path));if(!target.startsWith(resolve(root,'dist')+sep)){response.writeHead(404);response.end();return;}
        try{if(!(await stat(target)).isFile())throw new Error();const bytes=await readFile(target);response.writeHead(200,{'Content-Type':types[extname(target)]??'application/octet-stream','Content-Length':bytes.length});response.end(request.method==='HEAD'?undefined:bytes);}catch{response.writeHead(404);response.end();}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;gateway=new AiGateway({provider,passcode,allowedOrigins:[origin],secureCookies:false,requireModelBinding:true,quota:{consume:async()=>true}});return passcode;
}
try{
    await mkdir(output,{recursive:true});await rm(resolve(output,'results.json'),{force:true});await rm(resolve(output,'failure.json'),{force:true});temporary=await mkdtemp(join(tmpdir(),'easi-ai-concept-'));
    let passcode;if(live){origin=new URL(option('--origin')).origin;if(!origin.startsWith('https:')&&!['http://127.0.0.1:5188','http://localhost:5188'].includes(origin))throw new Error('Live qualification requires HTTPS or the approved loopback demo.');passcode=JSON.parse(await readFile(resolve(option('--passcode-file')??join(homedir(),'.config/easi-view/ai-demo-access.json')),'utf8')).passcode;}else passcode=await startMock();
    build=await(await fetch(`${origin}/build-info.json`)).json();const{sourceDigest}=await importRoot('tools/source-digest.mjs');assert.equal(build.sourceDigest,await sourceDigest(root));profile=(await(await fetch(`${origin}/viewer-config.json`)).json()).ai;assert.equal(profile.workflows,true);assert.equal(profile.workflowPreferences?.routineCt,'blended');if(option('--expected-model'))assert.equal(profile.model,option('--expected-model'));
    browser=await browserSession(resolve(temporary,'chrome'));await browser.send('Emulation.setDeviceMetricsOverride',{width:1600,height:1050,deviceScaleFactor:1,mobile:false});await browser.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    const byRequest=new Map();stopObserve=browser.onEvent((method,event)=>{
        if(method==='Network.requestWillBeSent'){const request=event.request,url=new URL(request.url);resources.set(event.requestId,{path:url.pathname,method:request.method,status:null});if(request.method==='POST'&&url.origin===origin&&url.pathname==='/api/ai/login')authRequests.push(resources.get(event.requestId));if(request.method!=='POST'||url.origin!==origin||url.pathname!=='/api/ai/plan')return;let value;try{value=JSON.parse(request.postData);}catch{value=null;}const allowed=['version','task','command'],call={case:currentCase,path:url.pathname,onlyAllowedFields:!!value&&Object.keys(value).length===allowed.length&&Object.keys(value).every(key=>allowed.includes(key)),requestBytes:Buffer.byteLength(request.postData??''),modelGuardMatches:Object.entries(request.headers).find(([key])=>key.toLowerCase()==='x-easi-ai-model')?.[1]===profile.model,status:null};calls.push(call);byRequest.set(event.requestId,call);}
        else if(method==='Network.responseReceived'){if(resources.has(event.requestId))resources.get(event.requestId).status=event.response.status;if(byRequest.has(event.requestId))byRequest.get(event.requestId).status=event.response.status;}
        else if(method==='Network.loadingFailed'&&resources.has(event.requestId))resources.get(event.requestId).failed=true;
    });
    await browser.send('Page.navigate',{url:`${origin}/api/ai/login`});await browser.until('document.readyState==="complete"&&location.pathname==="/api/ai/login"&&Boolean(document.querySelector("#passcode"))','The sign-in UI did not finish loading.',live?600:240);
    const form=await browser.send('Runtime.evaluate',{expression:'document.querySelector("#login")',returnByValue:false}),listeners=await browser.send('DOMDebugger.getEventListeners',{objectId:form.result.objectId});assert.ok(listeners.listeners.some(listener=>listener.type==='submit'),'Verify installed real form handling before entering the invitation.');await click('#passcode');await browser.send('Input.insertText',{text:passcode});await click('#login button[type="submit"]');await browser.until('location.pathname==="/"','Sign-in did not redirect after POST.',live?600:240);assert.equal(authRequests.length,1);assert.equal(authRequests[0].status,200);await ready();assert.equal(calls.length,0);record('standalone native-fetch sign-in uses its installed real POST handler and mounts Tasks without an automatic AI request');
    const{createAiConceptStudyFiles}=await importRoot('test/fixtures/ai-concept-studies.js'),save=async includePrior=>{const dir=resolve(temporary,includePrior?'current-and-prior':'current-only');await mkdir(dir);return Promise.all(createAiConceptStudyFiles({includePrior}).map(async(file,index)=>{const path=resolve(dir,`${index}-${file.name}`);await writeFile(path,new Uint8Array(await file.arrayBuffer()));return path;}));};
    const current=await save(false),comparison=await save(true);
    for(const item of selected){
        currentCase=item.id;const before=await fresh(item.includePrior?comparison:current,item.includePrior);const priorCalls=calls.length;await plan(item.command);assert.deepEqual(await state(),before,'Planning must leave the fresh scout workspace unchanged.');assert.equal(await evaluate('document.querySelectorAll("[data-ai-workflow-choice]").length'),0,'The declared routine preference and recorded requested metadata must resolve these generated cases without a series chooser.');await run();
        if(item.playing)await browser.until('document.querySelector("#cine-toggle").getAttribute("aria-pressed")==="true"&&Number(document.querySelector("#frame-slider").value)>0','The selected CT cine did not advance.');
        if(item.includePrior)await revealPriorForVerification();
        const after=await state();assert.equal(after.layout,item.layout);for(const[slot,number]of item.series.entries()){const pane=after.panes[slot];assert.equal(pane.empty,false);assert.equal(pane.total,5);assert.equal(after.bindings.find(binding=>binding.slot===slot)?.seriesNumber,number,`Concept ${item.id} must ground pane ${slot} against the expected recorded metadata.`);if(item.windows)assert.deepEqual(pane.window,PRESETS[item.windows[slot]]);if(item.positions)assert.equal(pane.frame,item.positions[slot]);}
        if(item.sync)assert.deepEqual(after.sync,item.sync);if(item.tool)assert.equal(after.tool,item.tool);if(item.playing)assert.equal(after.playing,true);assert.equal(calls.length,priorCalls+1);record(`concept ${item.id} starts from a fresh scout, reviews and executes without a series number or manual series navigation`,{case:item.id,layout:after.layout,bindings:after.bindings,panes:after.panes.map(({slot,empty,frame,total,window})=>({slot,empty,frame,total,window})),...(item.tool?{tool:after.tool}:{}),...(item.playing?{cineAdvanced:true}:{}),...(item.includePrior?{verificationOnlyStudyExpansion:true,preparatorySeriesNavigationUsed:false}:{})});
        await click('[data-ai-workflow-action="undo"]');await settle();assert.equal(await evaluate('document.querySelector(".ai-workflow-error").hidden'),true);assert.deepEqual(await state(),before,'Undo must restore the fresh scout workspace, tools, layout and synchronization.');
    }
    if(!live){
        currentCase='unsupported-anatomy';let before=await fresh(current);await plan('Find the largest liver slice and measure the right lobe.');assert.equal(await evaluate('document.querySelector("[data-ai-workflow-action=run]").disabled'),true);assert.deepEqual(await state(),before);record('unsupported anatomical detection or automatic measurement never enables execution or changes the workspace');
        currentCase='missing-prior';before=await fresh(current);await plan(CASES.find(item=>item.id==='prior-comparison').command);assert.equal(await evaluate('document.querySelector("[data-ai-workflow-action=run]").disabled'),true);assert.equal(await evaluate('document.querySelectorAll("[data-ai-workflow-choice]").length'),0);assert.deepEqual(await state(),before);record('a missing prior examination cannot silently select the current study twice');
        currentCase='stale-review';before=await fresh(current);await plan(CASES[0].command);await evaluate('(()=>{const n=document.querySelector("#frame-slider");n.value="1";n.dispatchEvent(new Event("input",{bubbles:true}));})()');await browser.until('document.querySelector("#frame-slider").value==="1"','The external frame change did not commit.');await click('[data-ai-workflow-action="run"]');await settle();assert.equal((await state()).layout,1);assert.equal(await evaluate('!document.querySelector(".ai-workflow-error").hidden'),true);record('a stale reviewed conceptual task cannot overwrite a later manual frame change');
    }
    await closeAssist();await nativeFetch();assert.ok(calls.every(call=>call.onlyAllowedFields&&call.modelGuardMatches&&call.status===200));if(live)assert.equal(calls.length,selected.length);assert.equal(browser.requests.filter(request=>!request.url.startsWith(origin)&&!request.url.startsWith('blob:')&&!request.url.startsWith('data:')).length,0);assert.equal(browser.requests.filter(request=>request.method==='POST'&&!request.url.startsWith(`${origin}/api/ai/`)).length,0);assert.equal(browser.errors.length,0);assert.equal(browser.consoleErrors.length,0);record('only reviewed command text enters the planner: no catalog, DICOM upload, foreign browser request, browser exception or console error');
    await writeFile(resolve(output,'results.json'),JSON.stringify({passed:checks.length,conceptCases:selected.map(item=>item.id),checks,sourceDigest:build.sourceDigest,harnessSha256:createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'),model:profile.model,actualStandaloneApplication:true,freshStudyPerCase:true,manualSeriesSelectionUsed:false,preparatorySeriesNavigationUsed:false,verificationOnlyStudyExpansion:selected.some(item=>item.includePrior),commandsContainSeriesNumbers:false,nativeFetchUntouched:true,networkObservation:'CDP only',hostPreference:profile.workflowPreferences,genuineProviderUsed:live,genuineProviderCalls:live?calls.filter(call=>call.status===200).length:0,originalImagingFilesUsed:false,credentialsRecorded:false,commandsOrModelProseRecorded:false,screenshotsRecorded:false,requests:calls,signInPost:{count:authRequests.length,statuses:authRequests.map(call=>call.status)},browserExceptions:0,consoleErrors:0,externalBrowserRequests:0},null,2)+'\n');console.log(`Conceptual workflow browser checks: ${checks.length} passed (${selected.length} fresh-study concepts).`);
}catch(error){
    let mount=null;try{mount=await evaluate('({path:location.pathname,queryPresent:!!location.search,ready:document.readyState,loginPresent:!!document.querySelector("#login"),appPresent:!!document.querySelector("#workspace"),aiControlPresent:!!document.querySelector("#header-ai-assist"),aiControlHidden:document.querySelector("#header-ai-assist")?.hidden??null})');}catch{}
    await writeFile(resolve(output,'failure.json'),JSON.stringify({checks,currentCase,sourceDigest:build?.sourceDigest,requests:calls,mount,signInPost:{count:authRequests.length,statuses:authRequests.map(call=>call.status)},failedResources:[...resources.values()].filter(item=>item.failed||item.status>=400),browserExceptions:browser?.errors.length??null,consoleErrors:browser?.consoleErrors.length??null,failure:{name:error.name,message:error.message},originalImagingFilesUsed:false,credentialsRecorded:false,screenshotsRecorded:false},null,2)+'\n');throw error;
}finally{stopObserve?.();browser?.close();if(server)await new Promise(resolve=>server.close(resolve));if(temporary)await rm(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
