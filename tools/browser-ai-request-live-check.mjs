import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {browserSession,delay} from './browser-session.mjs';

// Explicit, bounded genuine-provider qualification using generated imaging only.
// No mock provider, native-fetch replacement, retries, screenshots or originals.
const args=process.argv.slice(2),option=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
const budget=Number(option('--live-budget'));
if(!Number.isSafeInteger(budget)||budget<1||budget>4)throw new Error('Specify an explicit --live-budget between one and four.');
const origin=new URL(option('--origin')).origin;
if(origin!=='https://d3gv6o0ove04h3.cloudfront.net')throw new Error('Use the existing authorized hosted demonstration origin.');
const root=resolve(option('--source-root')??resolve(import.meta.dirname,'..')),output=resolve(option('--output')??resolve(root,'artifacts/browser-ai-request-live'));
const importRoot=name=>import(pathToFileURL(resolve(root,name))),quote=JSON.stringify;
const expectedModel=option('--expected-model')??'gpt-6.1-sol',expectedDigest=option('--expected-digest');
const CASES=[
    {id:'fresh-pair',mode:'fresh',command:'Show this CT in lung and soft-tissue windows side by side.'},
    {id:'continue-right-window',mode:'continue',command:'Apply a bone window to the right pane. Keep the current layout and images.'},
    {id:'continue-collapse',mode:'continue',command:'Use one pane with a bone window on the active image.'},
    {id:'new-request-fresh-lung',mode:'fresh',command:'Prepare a one-pane lung review of this CT.'}
];
const requested=option('--cases')?.split(',')??CASES.map(item=>item.id),selected=CASES.filter(item=>requested.includes(item.id));
if(selected.length!==budget||selected.length!==new Set(requested).size||requested.some(id=>!CASES.some(item=>item.id===id)))throw new Error('Choose distinct known --cases with --live-budget equal to their count.');
const checks=[],calls=[],authCalls=[],resources=new Map();let browser,temporary,build,profile,stopObserve,currentCase='startup',lastPlanAt=0;
const evaluate=expression=>browser.evaluate(expression),busy='document.querySelector(".ai-assist-workflow")?.getAttribute("aria-busy")==="true"';
const record=(name,details={})=>{checks.push({name,...details});console.log(`PASS ${name}`);};
async function click(css){
    const point=await evaluate(`(()=>{const n=document.querySelector(${quote(css)});if(!n||n.hidden||n.disabled)return null;n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return r.width&&r.height?{x:r.left+r.width/2,y:r.top+r.height/2}:null;})()`);
    assert.ok(point,'A required standalone control is unavailable.');
    await browser.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await browser.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
}
async function nativeFetch(){assert.equal(await evaluate('Function.prototype.toString.call(globalThis.fetch).includes("[native code]")'),true);}
async function settle(){await browser.until(`!(${busy})`,'The task did not settle.',650);}
async function openAssist(){await click('#header-ai-assist');await browser.until('document.querySelector(".ai-assist").open&&!document.querySelector(".ai-assist-workflow").hidden','Tasks did not open.');}
async function state(){
    return evaluate(`(()=>{const normalize=value=>value.replaceAll(',','').replaceAll('−','-');const panes=[...document.querySelectorAll('.workspace-pane')].map(p=>{const frame=p.querySelector('[data-pane-id=frame-overlay]').textContent.match(/Image\\s+(\\d+)\\s*\\/\\s*(\\d+)/),window=normalize(p.querySelector('[data-pane-id=window-overlay]').textContent).match(/W\\s+(-?[\\d.]+)\\s*·\\s*L\\s+(-?[\\d.]+)/);return{slot:Number(p.dataset.slot),empty:!p.querySelector('[data-pane-id=viewport-empty]').hidden,frame:frame?Number(frame[1]):null,total:frame?Number(frame[2]):null,window:window?{width:Number(window[1]),center:Number(window[2])}:null};});const bindings=[...document.querySelectorAll('.session-library-series')].flatMap(card=>{const number=card.querySelector('.session-library-series-counts')?.textContent.match(/Series (\\d+)\\b/);return[...card.querySelectorAll('.session-library-pane-badge')].map(badge=>({slot:badge.textContent.charCodeAt(badge.textContent.length-1)-65,number:number?Number(number[1]):null}));}).sort((a,b)=>a.slot-b.slot);return{layout:Number(document.querySelector('#workspace').dataset.layout),active:Number(document.querySelector('.workspace-pane.active')?.dataset.slot),panes,bindings,sync:{slice:document.querySelector('#sync-slices').checked,window:document.querySelector('#sync-window').checked,camera:document.querySelector('#sync-camera').checked},playing:document.querySelector('#cine-toggle').getAttribute('aria-pressed')==='true',tool:document.querySelector('.primary-tools [data-tool][aria-pressed=true]')?.dataset.tool??null,session:document.querySelector('#session-summary').textContent};})()`);
}
async function selectSeries(number){
    const id=await evaluate(`(()=>{const card=[...document.querySelectorAll('.session-library-series')].find(card=>new RegExp('Series '+${number}+'(?: ·|$)').test(card.querySelector('.session-library-series-counts')?.textContent??''));return card?.dataset.seriesId??null;})()`);
    assert.ok(id,'The expected generated series card is unavailable.');await click(`.session-library-series[data-series-id=${quote(id)}] [data-session-series-select]`);
    await browser.until(`(()=>{const card=document.querySelector('.session-library-series[data-series-id='+${quote(quote(id))}+']');return card?.classList.contains('is-selected')&&document.querySelector('.workspace-pane.active [data-pane-id=frame-overlay]').textContent.endsWith('/ 5')&&!document.querySelector('.workspace-pane.active').classList.contains('frame-loading');})()`,'The generated source did not open.');
}
async function setMode(mode){await evaluate(`(()=>{const n=document.querySelector('[data-ai-workflow-mode]');n.value=${quote(mode)};n.dispatchEvent(new Event('change',{bubbles:true}));})()`);assert.equal(await evaluate('document.querySelector("[data-ai-workflow-mode]").value'),mode);}
async function plan(item){
    if(lastPlanAt){const remaining=11000-(Date.now()-lastPlanAt);if(remaining>0)await delay(remaining);}
    assert.ok(calls.length<budget,'The planner request budget is exhausted.');currentCase=item.id;await setMode(item.mode);
    await evaluate(`(()=>{const n=document.querySelector('.ai-workflow-command');n.value=${quote(item.command)};n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const count=calls.length,before=await state();lastPlanAt=Date.now();await click('[data-ai-workflow-action="plan"]');
    await browser.until(`!document.querySelector('.ai-workflow-review').hidden&&!(${busy})||!document.querySelector('.ai-workflow-error').hidden`,'The proposed workflow did not return.',650);
    assert.equal(calls.length,count+1);assert.equal(calls.at(-1).status,200);assert.equal(calls.at(-1).mode,item.mode);assert.equal(await evaluate('document.querySelector(".ai-workflow-error").hidden'),true);
    assert.deepEqual(await state(),before,'Planning must preserve the actual workspace.');assert.equal(await evaluate('document.querySelectorAll("[data-ai-workflow-choice]").length'),0);
    assert.equal(await evaluate('document.querySelector("[data-ai-workflow-action=run]").disabled'),false);
}
async function run(){await click('[data-ai-workflow-action="run"]');await settle();assert.equal(await evaluate('document.querySelector(".ai-workflow-error").hidden'),true);}
async function undo(before){await click('[data-ai-workflow-action="undo"]');await settle();assert.equal(await evaluate('document.querySelector(".ai-workflow-error").hidden'),true);assert.deepEqual(await state(),before,'Undo must restore the actual prior workspace.');}
try{
    await mkdir(output,{recursive:true,mode:0o700});await rm(resolve(output,'results.json'),{force:true});await rm(resolve(output,'failure.json'),{force:true});temporary=await mkdtemp(join(tmpdir(),'easi-ai-request-live-'));
    build=await(await fetch(`${origin}/build-info.json`)).json();const{sourceDigest}=await importRoot('tools/source-digest.mjs');assert.equal(build.sourceDigest,await sourceDigest(root));if(expectedDigest)assert.equal(build.sourceDigest,expectedDigest);
    profile=(await(await fetch(`${origin}/viewer-config.json`)).json()).ai;assert.equal(profile.model,expectedModel);assert.equal(profile.workflows,true);assert.equal(profile.workflowPreferences?.routineCt,'blended');
    const passcode=JSON.parse(await readFile(resolve(option('--passcode-file')??join(homedir(),'.config/easi-view/ai-demo-access.json')),'utf8')).passcode;
    browser=await browserSession(resolve(temporary,'chrome'));await browser.send('Emulation.setDeviceMetricsOverride',{width:1600,height:1050,deviceScaleFactor:1,mobile:false});await browser.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    const byRequest=new Map();stopObserve=browser.onEvent((method,event)=>{
        if(method==='Network.requestWillBeSent'){
            const request=event.request,url=new URL(request.url),resource={path:url.pathname,method:request.method,status:null};resources.set(event.requestId,resource);
            if(request.method==='POST'&&url.origin===origin&&url.pathname==='/api/ai/login')authCalls.push(resource);
            if(request.method!=='POST'||url.origin!==origin||url.pathname!=='/api/ai/plan')return;
            let value;try{value=JSON.parse(request.postData);}catch{value=null;}
            const allowed=['version','task','command','mode'],item=CASES.find(item=>item.id===currentCase),call={case:currentCase,path:url.pathname,mode:value?.mode??null,onlyAllowedFields:!!value&&Object.keys(value).length===allowed.length&&Object.keys(value).every(key=>allowed.includes(key)),commandMatchesGenericCase:!!item&&item.command===value?.command,requestBytes:Buffer.byteLength(request.postData??''),modelGuardMatches:Object.entries(request.headers).find(([key])=>key.toLowerCase()==='x-easi-ai-model')?.[1]===profile.model,status:null};calls.push(call);byRequest.set(event.requestId,call);
        }else if(method==='Network.responseReceived'){
            if(resources.has(event.requestId))resources.get(event.requestId).status=event.response.status;if(byRequest.has(event.requestId))byRequest.get(event.requestId).status=event.response.status;
        }
    });
    currentCase='sign-in';await browser.send('Page.navigate',{url:`${origin}/api/ai/login`});await browser.until('document.readyState==="complete"&&location.pathname==="/api/ai/login"&&Boolean(document.querySelector("#passcode"))','The sign-in page did not mount.',600);
    const form=await browser.send('Runtime.evaluate',{expression:'document.querySelector("#login")',returnByValue:false}),listeners=await browser.send('DOMDebugger.getEventListeners',{objectId:form.result.objectId});assert.ok(listeners.listeners.some(listener=>listener.type==='submit'),'The real POST form handler must be installed before invitation entry.');
    await click('#passcode');await browser.send('Input.insertText',{text:passcode});await click('#login button[type="submit"]');await browser.until('location.pathname==="/"','Sign-in did not redirect.',600);assert.equal(authCalls.length,1);assert.equal(authCalls[0].status,200);
    await browser.until('Boolean(document.querySelector("#header-ai-assist")&&!document.querySelector("#header-ai-assist").hidden)','The configured viewer did not mount.',600);await nativeFetch();assert.equal(calls.length,0);record('real hosted sign-in uses its installed POST handler without an automatic AI request');
    const{createAiConceptStudyFiles}=await importRoot('test/fixtures/ai-concept-studies.js'),files=[];
    for(const[index,file]of createAiConceptStudyFiles().entries()){const path=resolve(temporary,`${index}-${file.name}`);await writeFile(path,new Uint8Array(await file.arrayBuffer()));files.push(path);}
    currentCase='generated-import';await click('#header-import');await click('[data-open-action="images"]');await browser.send('Page.setInterceptFileChooserDialog',{enabled:true});await click('[data-open-action="pick-files"]');
    const input=await browser.send('Runtime.evaluate',{expression:'document.querySelector("#file-input")',returnByValue:false});await browser.send('DOM.setFileInputFiles',{objectId:input.result.objectId,files});
    await browser.until('Boolean(document.querySelector("[data-open-action=add]")&&!document.querySelector("[data-open-action=add]").disabled)','The generated image review did not finish.',600);await click('[data-open-action="add"]');await browser.until('!document.querySelector(".open-workflow").open&&document.querySelector("#frame-overlay").textContent.startsWith("Image ")','The generated study did not open.',600);
    await selectSeries(312);await click('button[data-layout="2"]');await click('.workspace-pane[data-slot="1"] canvas');await selectSeries(313);
    await evaluate('(()=>{const n=document.querySelector("#frame-slider");n.value="2";n.dispatchEvent(new Event("input",{bubbles:true}));})()');await browser.until('/Image\\s+0?3\\b/.test(document.querySelector(".workspace-pane.active [data-pane-id=frame-overlay]").textContent)','The generated active pane did not reach image three.');
    const baseline=await state();assert.equal(baseline.layout,2);assert.equal(baseline.active,1);assert.deepEqual(baseline.bindings,[{slot:0,number:312},{slot:1,number:313}]);assert.equal(baseline.panes[1].frame,3);assert.equal(calls.length,0);await openAssist();
    record('one native generated-study import creates distinct sources in populated panes A and B before the bounded requests');
    for(const item of selected){
        if(item.id==='new-request-fresh-lung'){const count=calls.length;await click('[data-ai-workflow-action="new-request"]');assert.equal(await evaluate('document.querySelector(".ai-workflow-command").value'),'');assert.equal(await evaluate('document.querySelector("[data-ai-workflow-mode]").value'),'fresh');assert.deepEqual(await state(),baseline);assert.equal(calls.length,count);}
        const before=await state();assert.deepEqual(before,baseline);await plan(item);await run();const after=await state();assert.equal(after.session,baseline.session);
        if(item.id==='fresh-pair'){
            assert.equal(after.layout,2);assert.deepEqual(after.bindings,[{slot:0,number:317},{slot:1,number:317}]);assert.deepEqual(after.panes[0].window,{width:1500,center:-600});assert.deepEqual(after.panes[1].window,{width:400,center:40});assert.equal(after.playing,false);
        }else if(item.id==='continue-right-window'){
            assert.equal(after.layout,2);assert.deepEqual(after.bindings,baseline.bindings);assert.deepEqual(after.panes[0],baseline.panes[0]);assert.equal(after.panes[1].frame,baseline.panes[1].frame);assert.deepEqual(after.panes[1].window,{width:2000,center:500});
        }else if(item.id==='continue-collapse'){
            assert.equal(after.layout,1);assert.equal(after.active,0);assert.deepEqual(after.bindings,[{slot:0,number:313}]);assert.equal(after.panes[0].frame,3);assert.deepEqual(after.panes[0].window,{width:2000,center:500});
        }else{
            assert.equal(after.layout,1);assert.equal(after.active,0);assert.deepEqual(after.bindings,[{slot:0,number:317}]);assert.deepEqual(after.panes[0].window,{width:1500,center:-600});assert.deepEqual(after.sync,{slice:false,window:false,camera:false});
        }
        assert.ok(after.panes.every(pane=>!pane.empty&&pane.total===5));record('genuine request '+item.id+' executes its reviewed mode against the actual generated workspace',{case:item.id,mode:item.mode,layout:after.layout,active:after.active,bindings:after.bindings,panes:after.panes});
        await undo(before);record('genuine request '+item.id+' Undo restores both original generated panes and positions');
    }
    await nativeFetch();assert.equal(calls.length,budget);assert.ok(calls.every(call=>call.onlyAllowedFields&&call.commandMatchesGenericCase&&call.modelGuardMatches&&call.status===200));
    assert.equal(browser.requests.filter(request=>!request.url.startsWith(origin)&&!request.url.startsWith('blob:')&&!request.url.startsWith('data:')).length,0);assert.equal(browser.requests.filter(request=>request.method==='POST'&&!request.url.startsWith(`${origin}/api/ai/`)).length,0);assert.equal(browser.errors.length,0);assert.equal(browser.consoleErrors.length,0);
    record('exactly '+budget+' explicit genuine planning requests send command text and bounded mode only, with no image upload or foreign request');
    await writeFile(resolve(output,'results.json'),JSON.stringify({passed:checks.length,checks,sourceDigest:build.sourceDigest,harnessSha256:createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'),model:profile.model,genuineProviderUsed:true,genuineProviderCalls:calls.length,authorizedRequestBudget:budget,qualifiedCases:selected.map(item=>item.id),automaticRetries:0,actualStandaloneApplication:true,nativeFetchUntouched:true,originalImagingFilesUsed:false,generatedStudyImports:1,generatedManualPreparationUsed:true,commandsOrModelProseRecorded:false,credentialsRecorded:false,screenshotsRecorded:false,pixelCapturePerformed:false,requests:calls,signInPost:{count:authCalls.length,statuses:authCalls.map(call=>call.status)},browserExceptions:0,consoleErrors:0,externalBrowserRequests:0},null,2)+'\n',{mode:0o600});console.log(`Live request-flow qualification: ${checks.length} checks passed with ${calls.length} genuine planning requests.`);
}catch(error){
    let observed=null;try{observed=await state();}catch{}
    await writeFile(resolve(output,'failure.json'),JSON.stringify({checks,currentCase,sourceDigest:build?.sourceDigest,requests:calls,signInPost:{count:authCalls.length,statuses:authCalls.map(call=>call.status)},observed,failure:{name:error.name},genuineProviderUsed:true,genuineProviderCalls:calls.length,automaticRetries:0,originalImagingFilesUsed:false,credentialsRecorded:false,commandsOrModelProseRecorded:false,screenshotsRecorded:false},null,2)+'\n',{mode:0o600});console.error('Live request-flow qualification failed at '+currentCase+' ('+error.name+').');process.exitCode=1;
}finally{stopObserve?.();browser?.close();if(temporary)await rm(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
