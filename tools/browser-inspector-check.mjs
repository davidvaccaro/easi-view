import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile, readFile, rm, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { independentNativeFixture, j, sq } from '../test/derived-fixtures.js';
import { browserSession, delay } from './browser-session.mjs';

// Inspector QA uses independently written, synthetic Part10 data exclusively.
const root=resolve(import.meta.dirname,'..'),qa=resolve(root,'dist/qa-inspector'),output=resolve(root,'artifacts/browser-inspector');
const target=new URL(process.env.EASI_VIEW_URL||'http://127.0.0.1:5186/');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname));
const tabs=['details','measurements','attributes','performance','objects'],checks=[],quote=JSON.stringify;
const record=(name,detail={})=>{checks.push({name,...detail});console.log(`PASS ${name}`);};
function fixture(marker,index){
    const pixels=new Uint8Array(64),view=new DataView(pixels.buffer);Array.from({length:32},(_,i)=>(i%16)*10+index*200+(i>=16?1000:0)).forEach((v,i)=>view.setUint16(i*2,v,true));
    const binary=Buffer.from('SYNTHETIC_BINARY_NOT_FOR_ATTRIBUTE_TEXT_'.repeat(512));
    const metadata={'00080005':j('CS','ISO_IR 192'),'00080016':j('UI','1.2.840.10008.5.1.4.1.1.7.3'),'00080018':j('UI',`2.25.995.${index+1}.1`),
        '00080060':j('CS','OT'),'00081030':j('LO','Synthetic inspector study'),'0008103E':j('LO',`Synthetic inspector ${marker}`),
        '00081110':sq({'00081155':j('UI',`2.25.996.${index+1}`),'0008103E':j('LO',`NESTED_MARKER_${marker}`),
            '00081140':sq({'00080050':j('SH',`NESTED_${marker}`),'00110010':j('LO','EASI_NESTED_QA'),'00111020':j('LO',`DEEP_PRIVATE_${marker}`)})},
            {'0008103E':j('LO',`SIBLING_ITEM_${marker}`)}),
        '00081115':sq({'0008103E':j('LO',`INDEPENDENT_BRANCH_${marker}`)}),
        '00100010':j('PN',`SYNTHETIC^PANE_${marker}`),'00100020':j('LO',`QA_PANE_${marker}`),
        '00104000':j('LT',`LONG_TEXT_${marker} `+'0123456789 '.repeat(80)),
        '00110010':j('LO','EASI_INSPECTOR_QA'),'00111010':j('LO',`PRIVATE_MARKER_${marker}`),
        '00111011':{vr:'OB',InlineBinary:binary.toString('base64')},
        '00111012':j('LO',`TEXT_ONLY_${marker}<img src=x onerror="window.__unsafe=true">`),
        '00111013':j('UT',`TRUNCATED_${marker} `+'bounded preview '.repeat(420)),
        '0020000D':j('UI','2.25.995'),'0020000E':j('UI',`2.25.995.${index+1}`),'00200052':j('UI','2.25.995.99'),'00200013':j('IS',1),
        '00200032':j('DS',0,0,0),'00200037':j('DS',1,0,0,0,1,0),
        '00280002':j('US',1),'00280004':j('CS','MONOCHROME2'),'00280008':j('IS',2),'00280010':j('US',4),'00280011':j('US',4),'00280030':j('DS',2,3),
        '00280100':j('US',16),'00280101':j('US',16),'00280102':j('US',15),'00280103':j('US',0),
        '00281050':j('DS',100),'00281051':j('DS',400),'00281052':j('DS',0),'00281053':j('DS',1),'00281054':j('LO','HU'),
        '7FE00010':{vr:'OW',InlineBinary:Buffer.from(pixels).toString('base64')}};
    for(let n=0;n<85;n++)metadata['0011'+(0x1030+n).toString(16).toUpperCase().padStart(4,'0')]=j('LO',`PRIVATE_PAGE_${marker}_${String(n).padStart(3,'0')}`);
    return {bytes:independentNativeFixture(metadata),metadata};
}
const fixtures=[fixture('A',0),fixture('B',1),fixture('ARCHIVE',2)],encoded=fixtures.map(f=>Buffer.from(f.bytes).toString('base64'));
const archiveStudy='2.25.995',archiveSeries='2.25.995.3',archiveSop='2.25.995.3.1',archiveRequests=[];
const archiveMetadata={...fixtures[2].metadata,'00100010':{vr:'PN',Value:[{Alphabetic:'SYNTHETIC^ARCHIVE'}]},
    '00111011':{vr:'OB',BulkDataURI:'../secret-query?token=SYNTHETIC_PRIVATE_URI'},
    '00111012':j('LO','../SYNTHETIC_TEXT_NOT_BULK'),'7FE00010':{vr:'OW',BulkDataURI:'https://synthetic.invalid/never-fetch-bulk'}};
let browser,temporary,archiveServer,archiveBase;
async function startArchive(){
    archiveServer=createServer((request,response)=>{
        response.setHeader('Access-Control-Allow-Origin',target.origin);response.setHeader('Access-Control-Allow-Headers','Accept');response.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');response.setHeader('Cache-Control','no-store');
        if(request.method==='OPTIONS'){response.writeHead(204);response.end();return;}
        assert.equal(request.method,'GET');const path=new URL(request.url,'http://localhost').pathname;
        if(path===`/dicom-web/studies/${archiveStudy}/series/${archiveSeries}/metadata`){archiveRequests.push({type:'metadata'});response.writeHead(200,{'Content-Type':'application/dicom+json'});response.end(JSON.stringify([archiveMetadata]));return;}
        if(path===`/dicom-web/studies/${archiveStudy}/series/${archiveSeries}/instances/${archiveSop}`){archiveRequests.push({type:'instance'});response.writeHead(200,{'Content-Type':'application/dicom'});response.end(fixtures[2].bytes);return;}
        if(path===`/dicom-web/studies/${archiveStudy}/series/${archiveSeries}/instances/${archiveSop}/frames/1`){
            const pixels=Buffer.from(fixtures[2].metadata['7FE00010'].InlineBinary,'base64').subarray(0,32),boundary='synthetic-inspector-frame';archiveRequests.push({type:'frame',frameNumber:1,bytes:pixels.length});
            response.writeHead(200,{'Content-Type':`multipart/related; type="application/octet-stream"; boundary=${boundary}; transfer-syntax=1.2.840.10008.1.2.1`});
            response.end(Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream; transfer-syntax=1.2.840.10008.1.2.1\r\nContent-Location: ${path}\r\n\r\n`),pixels,Buffer.from(`\r\n--${boundary}--\r\n`)]));return;
        }
        response.writeHead(404);response.end();
    });await new Promise(done=>archiveServer.listen(0,'127.0.0.1',done));archiveBase=new URL(`http://127.0.0.1:${archiveServer.address().port}/dicom-web/`);return archiveBase.href;
}
const select=(name,owner='__v')=>browser.evaluate(`(()=>{const s=window.${owner}===window.__v?window.__shadow:window.__secondShadow;s.getElementById('inspector-tab-${name}').click();})()`);
async function search(value){await browser.evaluate(`(()=>{const input=window.__shadow.querySelector('#attributes-search,.attributes-search');input.value=${quote(value)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);await delay(50);}
const active=()=>browser.evaluate('window.__tabs()');
async function verifyActive(name){const result=await active();assert.deepEqual(result.selected,[name]);assert.deepEqual(result.visible,[name]);assert.equal(result.roving.length,1);assert.equal(result.roving[0],name);}
const rows=()=>browser.evaluate('window.__attributeRows()');
const key=async(value,code)=>{const native=value==='Enter'?{windowsVirtualKeyCode:13,nativeVirtualKeyCode:13}:value===' '?{windowsVirtualKeyCode:32,nativeVirtualKeyCode:32}:{},text=value==='Enter'?'\r':value===' '?' ':undefined;await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:value,code,...native,...(text?{text,unmodifiedText:text}:{})});await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key:value,code,...native});};
const tree=()=>browser.evaluate('window.__attributeTree()');
const rootSequence='dataset/(0008,1110)',firstItem=rootSequence+'/item[1]',secondItem=rootSequence+'/item[2]',nestedSequence=firstItem+'/(0008,1140)',nestedItem=nestedSequence+'/item[1]',deepAttribute=nestedItem+'/(0011,1020)',otherSequence='dataset/(0008,1115)',otherItem=otherSequence+'/item[1]';
async function toggleAttribute(path,keyboard){
    const expression=`(()=>{const row=Array.from(window.__shadow.querySelectorAll('.attributes-row')).find(row=>row.querySelector('.attributes-path')?.textContent===${quote(path)}),button=row?.querySelector('.attributes-toggle');if(!button)throw new Error('Synthetic attribute branch is not available');button.${keyboard?'focus':'click'}();})()`;
    await browser.evaluate(expression);if(keyboard)await key(keyboard==='Enter'?'Enter':' ',keyboard==='Enter'?'Enter':'Space');await delay(30);
}
async function openMainAttributeBranch(){for(const path of[rootSequence,firstItem,nestedSequence,nestedItem]){const branch=(await tree()).find(row=>row.path===path);if(branch?.expanded==='false')await toggleAttribute(path);}}
async function showAttributeHierarchy(){
    await browser.evaluate(`(()=>{const s=window.__shadow,row=Array.from(s.querySelectorAll('.attributes-row')).find(row=>row.querySelector('.attributes-path')?.textContent===${quote(rootSequence)}),scroll=s.querySelector('.inspector-scroll');scroll.scrollTop+=row.getBoundingClientRect().top-scroll.getBoundingClientRect().top-8;})()`);
}
async function captureAttributePanel(name){
    await browser.evaluate('(async()=>{await document.fonts.ready;await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));})()');
    const clip=await browser.evaluate('(()=>{const r=window.__shadow.getElementById("inspector-panel").getBoundingClientRect();return{x:r.left+scrollX,y:r.top+scrollY,width:r.width,height:r.height,scale:1};})()');
    const result=await browser.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip});await writeFile(resolve(output,name+'.png'),Buffer.from(result.data,'base64'));
}

try{
    await mkdir(qa,{recursive:true});await mkdir(output,{recursive:true});temporary=await mkdtemp(join(tmpdir(),'easi-view-inspector-'));
    await startArchive();
    const info=JSON.parse(await readFile(resolve(root,'dist/build-info.json'),'utf8'));
    await writeFile(resolve(qa,'fixtures.json'),JSON.stringify(encoded));
    await writeFile(resolve(qa,'host.css'),'body{margin:0;background:#090f18;color:#f0f5ff}#host-nav{height:26px;display:flex;align-items:center}#one{height:980px;width:100%}#two{height:740px;width:100%}');
    await writeFile(resolve(qa,'index.html'),'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="host.css"><nav id="host-nav"><button id="host-action">Host application control</button></nav><main id="one"></main><section id="two"></section><script type="module" src="host.js"></script>');
    await writeFile(resolve(qa,'host.js'),`import{createViewer}from'../assets/easi-view.js';const fixtures=await(await fetch('./fixtures.json')).json();window.__file=index=>new File([Uint8Array.from(atob(fixtures[index]),c=>c.charCodeAt(0))],'synthetic-inspector-'+index+'.dcm');window.__v=createViewer(document.getElementById('one'),{initialDemo:null});window.__second=createViewer(document.getElementById('two'),{initialDemo:null});window.__observations=[];for(const kind of['sourcechange','framechange','viewportchange','annotationchange'])window.__v.on(kind,detail=>window.__observations.push({kind,detail}));await Promise.all([window.__v.ready,window.__second.ready]);window.__shadow=document.getElementById('one').querySelector('easi-view-embed').shadowRoot;window.__secondShadow=document.getElementById('two').querySelector('easi-view-embed').shadowRoot;
window.__tabs=()=>{const nodes=Array.from(window.__shadow.querySelectorAll('[data-inspector-tab]')),panels=Array.from(window.__shadow.querySelectorAll('[data-inspector-panel]'));return{selected:nodes.filter(t=>t.getAttribute('aria-selected')==='true').map(t=>t.dataset.inspectorTab),visible:panels.filter(p=>!p.hidden).map(p=>p.dataset.inspectorPanel),roving:nodes.filter(t=>t.tabIndex===0).map(t=>t.dataset.inspectorTab),focused:window.__shadow.activeElement?.dataset.inspectorTab||null};};
window.__attributeRows=()=>Array.from(window.__shadow.querySelectorAll('.attributes-row')).map(row=>({tag:row.querySelector('.attributes-tag')?.textContent||'',name:row.querySelector('.attributes-name')?.textContent||'',vr:row.querySelector('.attributes-vr')?.textContent||'',value:row.querySelector('.attributes-value')?.textContent||'',path:row.querySelector('.attributes-path')?.textContent||''}));
window.__attributeTree=()=>Array.from(window.__shadow.querySelectorAll('.attributes-row')).map(row=>{const toggle=row.querySelector('.attributes-toggle'),cells=Array.from(row.children),cellBackground=getComputedStyle(cells[0]).backgroundColor;return{path:row.querySelector('.attributes-path')?.textContent,kind:row.dataset.kind,level:Number(row.dataset.level),tone:row.dataset.tone,expanded:toggle?.getAttribute('aria-expanded')??null,disabled:toggle?.disabled??null,focused:toggle===window.__shadow.activeElement,background:cellBackground==='rgba(0, 0, 0, 0)'?getComputedStyle(row).backgroundColor:cellBackground,columns:cells.map(cell=>cell.getBoundingClientRect().left),nameLeft:row.querySelector('.attributes-name-text').getBoundingClientRect().left,namePadding:getComputedStyle(row.querySelector('.attributes-name')).paddingLeft};});window.__ready=true;`);
    browser=await browserSession(temporary);await browser.send('Emulation.setDeviceMetricsOverride',{width:1500,height:1100,deviceScaleFactor:1,mobile:false});
    await browser.send('Page.navigate',{url:new URL('qa-inspector/index.html',target).href});await browser.until('window.__ready','Inspector host did not mount.');
    const semantics=await browser.evaluate(`(()=>{const s=window.__shadow;return{role:s.getElementById('inspector-tabs').getAttribute('role'),tabs:${quote(tabs)}.map(name=>{const t=s.getElementById('inspector-tab-'+name),p=s.getElementById('inspector-panel-'+name);return{role:t.getAttribute('role'),control:t.getAttribute('aria-controls'),panel:p.getAttribute('role'),label:p.getAttribute('aria-labelledby')};})};})()`);
    assert.equal(semantics.role,'tablist');semantics.tabs.forEach((item,i)=>{assert.equal(item.role,'tab');assert.equal(item.control,'inspector-panel-'+tabs[i]);assert.equal(item.panel,'tabpanel');assert.equal(item.label,'inspector-tab-'+tabs[i]);});await verifyActive('details');
    record('five inspector tabs expose linked tab/tabpanel semantics, one roving focus target and Details by default');
    await browser.evaluate('window.__v.openFiles([window.__file(0),window.__file(1)])');
    const networkStart=browser.requests.length,initialFrame=await browser.evaluate('window.__v.getState().frameIndex');for(const name of tabs){await select(name);await verifyActive(name);}assert.equal(browser.requests.length,networkStart);
    record('desktop tabs switch exactly one visible panel without fetching images or metadata');
    await select('details');await browser.evaluate('window.__shadow.getElementById("inspector-tab-details").focus()');await key('ArrowRight','ArrowRight');await verifyActive('measurements');assert.equal((await active()).focused,'measurements');
    await key('End','End');await verifyActive('objects');await key('ArrowRight','ArrowRight');await verifyActive('details');await key('ArrowLeft','ArrowLeft');await verifyActive('objects');await key('Home','Home');await verifyActive('details');assert.equal(await browser.evaluate('window.__v.getState().frameIndex'),initialFrame);
    record('Left/Right/Home/End provide wrapping roving keyboard navigation without moving image frames');
    assert.equal(await browser.evaluate('window.__v.getState().frameCount'),2);await key('ArrowDown','ArrowDown');await delay(120);assert.equal(await browser.evaluate('window.__v.getState().frameIndex'),initialFrame);
    await browser.evaluate('window.__shadow.getElementById("inspector-panel-details").focus()');await key('ArrowDown','ArrowDown');await key('ArrowUp','ArrowUp');await delay(120);assert.equal(await browser.evaluate('window.__v.getState().frameIndex'),initialFrame);
    record('Up/Down image shortcuts stay inactive inside focused inspector tabs and panels in a two-frame source');
    await select('attributes');await search('QA_PANE_A');let found=await rows();assert.equal(found.length,1,JSON.stringify(await browser.evaluate('({count:window.__shadow.getElementById("attributes-count").textContent,empty:window.__shadow.querySelector(".attributes-empty").textContent,context:window.__shadow.getElementById("inspector-context-label").textContent})')));assert.match(found[0].tag.replace(/[^\da-f]/gi,''),/00100020/i);assert.match(found[0].value,/QA_PANE_A/);
    await search('00111010');found=await rows();assert.equal(found.length,1);assert.match(found[0].value,/PRIVATE_MARKER_A/);
    await search('patient id');found=await rows();assert.ok(found.some(row=>/QA_PANE_A/.test(row.value)));
    record('Attributes searches actual parsed DICOM values, dictionary names and numeric private tags');
    await search('DEEP_PRIVATE_A');found=await rows();assert.equal(found.length,1);assert.ok(found[0].path.length>0);assert.match(found[0].value,/DEEP_PRIVATE_A/);
    await search('NESTED_MARKER_A');found=await rows();assert.equal(found.length,1);assert.ok(found[0].path.length>0);
    record('nested sequence and private values retain their original item paths rather than becoming top-level approximations');
    await search('');let hierarchy=await tree();assert.equal(hierarchy.find(row=>row.path===rootSequence).expanded,'false');assert.equal(hierarchy.find(row=>row.path===otherSequence).expanded,'false');assert.ok(hierarchy.every(row=>row.kind!=='item'));
    await toggleAttribute(rootSequence,'Enter');hierarchy=await tree();assert.equal(hierarchy.find(row=>row.path===rootSequence).expanded,'true');assert.equal(hierarchy.find(row=>row.path===firstItem).level,1);assert.equal(hierarchy.find(row=>row.path===secondItem).expanded,'false');assert.ok(!hierarchy.some(row=>row.path===nestedSequence));
    await toggleAttribute(firstItem,'Space');hierarchy=await tree();assert.equal(hierarchy.find(row=>row.path===firstItem).expanded,'true');assert.equal(hierarchy.find(row=>row.path===nestedSequence).level,2);assert.equal(hierarchy.find(row=>row.path===nestedSequence).expanded,'false');assert.ok(!hierarchy.some(row=>row.path===nestedItem));assert.equal(await browser.evaluate('window.__v.getState().playing'),false);assert.equal(await browser.evaluate('window.__v.getState().frameIndex'),initialFrame);
    await toggleAttribute(nestedSequence);await toggleAttribute(nestedItem);hierarchy=await tree();const chain=[rootSequence,firstItem,nestedSequence,nestedItem,deepAttribute].map(path=>hierarchy.find(row=>row.path===path));assert.ok(chain.every(Boolean));assert.deepEqual(chain.map(row=>row.level),[0,1,2,3,4]);assert.deepEqual(chain.map(row=>row.tone),['0','1','2','3','4']);
    for(let index=1;index<chain.length;index++){assert.notEqual(chain[index].background,chain[index-1].background);assert.deepEqual(chain[index].columns,chain[0].columns);assert.equal(chain[index].nameLeft,chain[0].nameLeft);assert.equal(chain[index].namePadding,chain[0].namePadding);}
    assert.equal(chain[4].expanded,null);
    record('collapsed sequence and item parents expand independently with native Enter/Space; five hierarchy levels use distinct rendered tones and aligned unindented columns');
    await toggleAttribute(otherSequence);await toggleAttribute(otherItem);await toggleAttribute(secondItem);await toggleAttribute(firstItem);hierarchy=await tree();assert.ok(!hierarchy.some(row=>row.path===deepAttribute));assert.ok(hierarchy.some(row=>row.path===secondItem+'/(0008,103e)'));assert.ok(hierarchy.some(row=>row.path===otherItem+'/(0008,103e)'));assert.equal(hierarchy.find(row=>row.path===firstItem).focused,true);
    await toggleAttribute(rootSequence);hierarchy=await tree();assert.ok(!hierarchy.some(row=>row.path===secondItem));assert.ok(hierarchy.some(row=>row.path===otherItem+'/(0008,103e)'));assert.equal(hierarchy.find(row=>row.path===rootSequence).focused,true);
    await search('DEEP_PRIVATE_A');hierarchy=await tree();assert.equal(hierarchy.length,1);assert.equal(hierarchy[0].path,deepAttribute);assert.equal(hierarchy[0].level,4);await search('');hierarchy=await tree();assert.equal(hierarchy.find(row=>row.path===rootSequence).expanded,'false');assert.equal(hierarchy.find(row=>row.path===otherSequence).expanded,'true');assert.ok(!hierarchy.some(row=>row.path===deepAttribute));
    await openMainAttributeBranch();await search('QA_PANE_A');assert.equal((await rows()).length,1);await search('');assert.ok((await tree()).some(row=>row.path===deepAttribute));assert.equal(browser.requests.length,networkStart);
    record('collapsing a parent hides its descendants and retains toggle focus without closing sibling branches; deep search ignores collapsed state and restores prior expansion on clear without fetching');
    await browser.evaluate('window.__shadow.querySelector(".attributes-collapse-all").click()');assert.ok((await tree()).every(row=>row.kind!=='item'));await browser.evaluate('window.__shadow.querySelector(".attributes-expand-all").click()');assert.ok((await tree()).some(row=>row.path===deepAttribute));await browser.evaluate('window.__shadow.querySelector(".attributes-collapse-all").click()');
    record('Expand all and Collapse all traverse retained nested items while keeping individual metadata paths intact');
    await search('PRIVATE_PAGE_A');found=await rows();assert.equal(found.length,50);const firstPage=found.map(row=>row.value);assert.match(await browser.evaluate('window.__shadow.querySelector("#attributes-count,.attributes-count").textContent'),/85/);
    await browser.evaluate('window.__shadow.querySelector("#attributes-next,.attributes-next").click()');found=await rows();assert.equal(found.length,35);assert.ok(found.every(row=>!firstPage.includes(row.value)));
    await browser.evaluate('window.__shadow.querySelector("#attributes-prev,.attributes-previous").click()');assert.deepEqual((await rows()).map(row=>row.value),firstPage);
    record('bounded 50-row paging visits all 85 synthetic private attributes without duplicating or skipping values');
    await search('LONG_TEXT_A');const expanded=await browser.evaluate('(()=>{const details=window.__shadow.querySelector(".attributes-expanded-value");if(!details)return null;details.open=true;return details.querySelector("pre")?.textContent;})()');assert.equal(expanded,('LONG_TEXT_A '+'0123456789 '.repeat(80)).trimEnd());
    await search('TEXT_ONLY_A');assert.equal(await browser.evaluate('window.__shadow.getElementById("attributes-content").querySelectorAll("img,script").length'),0);assert.equal(await browser.evaluate('Boolean(window.__unsafe)'),false);
    await search('00111011');found=await rows();assert.equal(found.length,1);assert.ok(!found[0].value.includes('SYNTHETIC_BINARY_NOT_FOR_ATTRIBUTE_TEXT'));await search('7FE00010');found=await rows();assert.equal(found.length,1);
    assert.ok(!/[\[\{].*0,\s*10,\s*20/s.test(found[0].value));assert.equal(await browser.evaluate('window.__shadow.getElementById("attributes-content").querySelectorAll("a[href]").length'),0);assert.equal(browser.requests.length,networkStart);
    record('long text expands explicitly as text, hostile markup stays inert and binary/Pixel Data remain summaries without dumps, links or network requests');
    await search('TRUNCATED_A');const bounded=await browser.evaluate('(()=>{const s=window.__shadow,pre=s.querySelector(".attributes-expanded-value pre"),warning=s.querySelector(".attributes-warning");return{length:pre?.textContent.length,value:pre?.textContent,warning:warning.textContent,visible:!warning.hidden};})()');assert.equal(bounded.length,4096);assert.ok(bounded.value.endsWith('…'));assert.ok(bounded.visible);assert.match(bounded.warning,/4,096|4096/);
    record('overlong retained metadata stays bounded to 4096 characters with an explicit visible shortening warning');
    await search('');const savedScroll=await browser.evaluate('(()=>{const scroll=window.__shadow.querySelector(".inspector-scroll");scroll.scrollTop=240;return scroll.scrollTop;})()');assert.ok(savedScroll>0);await select('details');assert.equal(await browser.evaluate('window.__shadow.querySelector(".inspector-scroll").scrollTop'),0);await select('attributes');assert.equal(await browser.evaluate('window.__shadow.querySelector(".inspector-scroll").scrollTop'),savedScroll);
    record('switching inspector sections restores separate tab scroll positions without carrying an unrelated panel offset');
    await browser.evaluate('window.__v.setLayout(2)');await browser.evaluate('window.__v.assignViewportSeries(1,1)');await browser.evaluate('window.__v.setActiveViewport(1)');await search('QA_PANE');found=await rows();assert.equal(found.length,1);assert.match(found[0].value,/QA_PANE_B/);
    await browser.evaluate('window.__v.setActiveViewport(0)');await search('QA_PANE');found=await rows();assert.equal(found.length,1);assert.match(found[0].value,/QA_PANE_A/);
    record('Attributes follows the active viewport original instance and never shows another assigned pane metadata');
    await browser.evaluate('window.__v.setFrame(1)');await verifyActive('attributes');assert.match(await browser.evaluate('window.__shadow.getElementById("inspector-context-label").textContent'),/PANE 1.*FRAME 2/);await search('QA_PANE_A');assert.equal((await rows()).length,1);await browser.evaluate('window.__v.setFrame(0)');await verifyActive('attributes');
    record('frame navigation preserves the selected inspector tab and identifies the current original multiframe image');
    await select('details');await browser.evaluate('(()=>{const menu=window.__shadow.getElementById("measurement-tools");menu.querySelector("summary").click();menu.querySelector("[data-tool=rectangle]").click();})()');await verifyActive('measurements');const annotation=await browser.evaluate('window.__v.addAnnotation({tool:"rectangle",points:[{x:0,y:0},{x:2,y:2}]})');assert.equal(await browser.evaluate('window.__shadow.getElementById("annotation-list").children.length'),1);
    const statistics=await browser.evaluate(`window.__v.measureAnnotation(${quote(annotation.id)})`);assert.equal(statistics.statistics.pixelCount,4);assert.equal(statistics.statistics.stored.mean,25);
    await browser.evaluate('window.__shadow.getElementById("annotation-undo").click()');assert.equal(await browser.evaluate('window.__v.getAnnotationState().count'),0);await browser.evaluate('window.__shadow.getElementById("annotation-redo").click()');assert.equal(await browser.evaluate('window.__v.getAnnotationState().count'),1);
    record('measurement tool selection reveals Measurements and moved undo/redo/statistics controls retain independent ROI values');
    await select('objects');await browser.evaluate('window.__v.addOverlay({id:"inspector-mask",kind:"binary",values:Array.from({length:16},(_,i)=>i%2),opacity:.5,color:[0,200,160]})');assert.equal(await browser.evaluate('window.__shadow.getElementById("derived-overlay-list").children.length'),1);
    await browser.evaluate('window.__shadow.getElementById("derived-overlay-list").querySelector("button").click()');assert.equal(await browser.evaluate('window.__v.getDerivedState().overlayCount'),0);await verifyActive('objects');
    await select('performance');assert.match(await browser.evaluate('window.__shadow.getElementById("performance-first-display").textContent'),/ms/);await browser.evaluate('window.__shadow.getElementById("reset-performance").click()');assert.equal(await browser.evaluate('window.__v.getPerformance().measurements.length'),0);
    record('Objects and Performance retain functioning overlay removal, timing values and explicit reset after relocation');
    await browser.evaluate('window.__second.openFiles([window.__file(1)])');await select('attributes','__second');await select('details');await browser.evaluate('window.__shadow.getElementById("inspector-tab-details").focus()');await key('ArrowRight','ArrowRight');await verifyActive('measurements');assert.equal(await browser.evaluate('window.__secondShadow.getElementById("inspector-tab-attributes").getAttribute("aria-selected")'),'true');
    await browser.evaluate('document.getElementById("host-action").focus()');const beforeOutside=await active();await key('ArrowRight','ArrowRight');assert.deepEqual(await active(),beforeOutside);
    record('tab keyboard handling stays inside the focused embedded viewer and leaves sibling viewers and host controls alone');
    await select('attributes');await search('QA_PANE_A');await browser.evaluate('window.__v.openFiles([window.__file(1)])');await search('QA_PANE');found=await rows();assert.equal(found.length,1);assert.match(found[0].value,/QA_PANE_B/);assert.ok(!JSON.stringify(found).includes('QA_PANE_A'));
    await search('this_tag_does_not_exist');assert.equal((await rows()).length,0);assert.match(await browser.evaluate('window.__shadow.querySelector(".attributes-empty").textContent'),/match|found/i);await search('');
    record('source replacement removes prior parsed metadata and empty searches have an explicit bounded empty state');
    await browser.evaluate('window.__v.setLayout(1);window.__v.setActiveViewport(0)');await select('attributes');await search('');await openMainAttributeBranch();await showAttributeHierarchy();await browser.screenshot('inspector-desktop-synthetic');await copyFile(join(temporary,'inspector-desktop-synthetic.png'),resolve(output,'inspector-desktop-synthetic.png'));await captureAttributePanel('inspector-attributes-desktop-synthetic');
    await browser.send('Emulation.setDeviceMetricsOverride',{width:480,height:960,deviceScaleFactor:1,mobile:true});await browser.evaluate('window.scrollTo(0,0);const b=window.__shadow.getElementById("toggle-inspector");if(b.getAttribute("aria-expanded")!=="true")b.click()');
    const mobile=await browser.evaluate('(()=>{const tabs=Array.from(window.__shadow.querySelectorAll("[data-inspector-tab]")).map(t=>t.getBoundingClientRect().toJSON()),panel=window.__shadow.getElementById("inspector-panel").getBoundingClientRect().toJSON();return{width:innerWidth,tabs,panel};})()');assert.equal(mobile.width,480);assert.ok(mobile.tabs.every(r=>r.width>20&&r.left>=0&&r.right<=480));assert.ok(mobile.panel.left>=0&&mobile.panel.right<=480);
    for(const name of tabs){await select(name);await verifyActive(name);}await select('attributes');
    const mobileTree=await tree(),mobileChain=[rootSequence,firstItem,nestedSequence,nestedItem,deepAttribute].map(path=>mobileTree.find(row=>row.path===path));assert.ok(mobileChain.every(Boolean));for(const row of mobileChain){assert.deepEqual(row.columns,mobileChain[0].columns);assert.equal(row.nameLeft,mobileChain[0].nameLeft);}assert.equal(await browser.evaluate('(()=>{const s=window.__shadow.querySelector(".attributes-table-scroll");return s.scrollWidth<=s.clientWidth+1;})()'),true);
    record('true 480px mobile inspector exposes readable reachable tab labels and one active panel without horizontal overflow');
    await browser.evaluate('window.__shadow.getElementById("toggle-inspector").click();window.__v.setTool("rectangle")');await verifyActive('measurements');assert.equal(await browser.evaluate('window.__shadow.getElementById("toggle-inspector").getAttribute("aria-expanded")'),'false');assert.equal(await browser.evaluate('getComputedStyle(window.__shadow.getElementById("inspector-panel")).display'),'none');
    await browser.evaluate('window.__shadow.getElementById("toggle-inspector").click()');await select('attributes');await showAttributeHierarchy();await browser.screenshot('inspector-mobile-synthetic');await copyFile(join(temporary,'inspector-mobile-synthetic.png'),resolve(output,'inspector-mobile-synthetic.png'));await captureAttributePanel('inspector-attributes-mobile-synthetic');
    record('mobile measurement tool selection updates the inspector tab while keeping a collapsed overlay closed so the drawing canvas remains available');
    await browser.evaluate(`(async()=>{await window.__v.setLayout(2);window.__v.configureArchive({baseUrl:${quote(archiveBase.href)}});await window.__v.addArchiveSeries(${quote(archiveStudy)},${quote(archiveSeries)},{viewport:1});window.__v.setActiveViewport(1);})()`);await select('attributes');await search('QA_PANE_ARCHIVE');found=await rows();assert.equal(found.length,1);assert.match(found[0].value,/QA_PANE_ARCHIVE/);
    await search('7FE00010');found=await rows();assert.equal(found.length,1);assert.ok(!found[0].value.includes('synthetic.invalid'));const archiveNetwork=archiveRequests.length;await select('details');await select('performance');await select('attributes');assert.equal(archiveRequests.length,archiveNetwork);
    await browser.evaluate('window.__v.disconnectArchive()');assert.equal(await browser.evaluate('window.__shadow.getElementById("attributes-content").textContent.includes("QA_PANE_ARCHIVE")'),false);assert.equal((await rows()).length,0);await browser.evaluate('window.__v.setActiveViewport(0)');await search('QA_PANE_B');found=await rows();assert.equal(found.length,1);assert.match(found[0].value,/QA_PANE_B/);assert.deepEqual(archiveRequests.map(request=>request.type),['metadata','instance']);
    record('disconnect clears protected archive attribute DOM while retaining a local pane; archive tab browsing never follows bulk URLs or retrieves more pixels');
    const frameRequestsStart=archiveRequests.length;await browser.evaluate(`(async()=>{window.__v.configureArchive({baseUrl:${quote(archiveBase.href)},retrievalMode:'frame'});await window.__v.addArchiveSeries(${quote(archiveStudy)},${quote(archiveSeries)},{viewport:1});window.__v.setActiveViewport(1);})()`);await select('attributes');assert.deepEqual(await browser.evaluate('window.__v.getState().image&&({rows:window.__v.getState().image.rows,columns:window.__v.getState().image.columns})'),{rows:4,columns:4});
    await search('00111011');found=await rows();assert.equal(found.length,1);assert.equal(found[0].vr,'OB');assert.match(found[0].value,/bulk|deferred/i);assert.ok(!/secret-query|SYNTHETIC_PRIVATE_URI/.test(await browser.evaluate('window.__shadow.textContent')));assert.equal(await browser.evaluate('window.__shadow.getElementById("attributes-content").querySelectorAll("a[href]").length'),0);
    await search('00111012');found=await rows();assert.equal(found.length,1);assert.equal(found[0].vr,'LO');assert.equal(found[0].value,'../SYNTHETIC_TEXT_NOT_BULK');assert.deepEqual(archiveRequests.slice(frameRequestsStart),[{type:'metadata'},{type:'frame',frameNumber:1,bytes:32}]);
    await browser.evaluate('window.__v.disconnectArchive()');assert.equal((await rows()).length,0);assert.ok(!/SYNTHETIC_PRIVATE_URI|SYNTHETIC_TEXT_NOT_BULK|QA_PANE_ARCHIVE/.test(await browser.evaluate('window.__shadow.getElementById("attributes-content").textContent')));await browser.evaluate('window.__v.setActiveViewport(0)');await search('QA_PANE_B');found=await rows();assert.equal(found.length,1);assert.match(found[0].value,/QA_PANE_B/);
    record('native frame retrieval preserves private JSON VR provenance, hides private bulk references without guessing from URL-like text, and clears revoked metadata');
    const disposal=await browser.evaluate('(async()=>{const first=window.__shadow,second=window.__secondShadow;window.__v.dispose();window.__second.dispose();await Promise.all([window.__v.whenDisposed(),window.__second.whenDisposed()]);return{first:first.textContent,second:second.textContent,resources:window.__v.getPerformance().resources};})()');assert.ok(!/QA_PANE_[AB]|PRIVATE_MARKER_[AB]|DEEP_PRIVATE_[AB]/.test(disposal.first+disposal.second));assert.equal(disposal.resources.workerCount,0);assert.equal(disposal.resources.cleanupPending,false);
    assert.equal(browser.errors.length,0);assert.equal(browser.consoleErrors.length,0);assert.ok(browser.requests.every(request=>['GET','OPTIONS'].includes(request.method)&&[target.origin,archiveBase.origin].includes(new URL(request.url).origin)));
    record('disposing embedded viewers clears retained attribute DOM and workers; all test files stay local with no external requests or uploads');
    const observations=await browser.evaluate('window.__observations');assert.ok(observations.some(event=>event.kind==='sourcechange'));assert.ok(!/QA_PANE_|PRIVATE_MARKER_|DEEP_PRIVATE_|LONG_TEXT_|SYNTHETIC_PRIVATE_URI|SYNTHETIC_TEXT_NOT_BULK|SYNTHETIC\^PANE_|2\.25\.995/.test(JSON.stringify(observations)));
    record('automatic SDK events stay operational and omit inspected patient fields, private text and source identifiers');
    assert.equal(JSON.parse(await readFile(resolve(root,'dist/build-info.json'),'utf8')).sourceDigest,info.sourceDigest);
    const version=await browser.send('Browser.getVersion');
    await writeFile(resolve(output,'results.json'),JSON.stringify({passed:checks.length,checks,sourceDigest:info.sourceDigest,harnessSha256:createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'),fixtureSha256:createHash('sha256').update(JSON.stringify({encoded,archiveMetadata})).digest('hex'),browser:version.product,desktop:{width:1500,height:1100,dpr:1},mobile:{width:480,height:960,dpr:1},archiveRequests,browserExceptions:0,consoleErrors:0,uploads:0,externalRequests:0,capturedNetworkRequests:browser.requests.length,originalImagingFilesUsed:false,profilesSaved:false},null,2)+'\n');console.log(`Inspector browser checks: ${checks.length} passed.`);
}finally{browser?.close();archiveServer?.closeAllConnections();if(archiveServer)await new Promise(done=>archiveServer.close(done));await rm(qa,{recursive:true,force:true});if(temporary){await delay(200);await rm(temporary,{recursive:true,force:true});}}
