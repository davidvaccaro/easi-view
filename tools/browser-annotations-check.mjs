import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { createDicomFixture } from '../src/data/synthetic.js';
import { createEnhancedDicom, expectedGroups } from '../test/enhanced-fixtures.js';
import { browserSession } from './browser-session.mjs';

const root = resolve(import.meta.dirname, '..'), qa = resolve(root, 'dist/qa'), output = resolve(root, 'artifacts/browser-annotations');
const target = new URL(process.env.EASI_VIEW_URL || 'http://127.0.0.1:5175/');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname), 'Annotation checks require an isolated local preview.');
const quote = JSON.stringify, checks = [];
const record = (name, detail = {}) => { checks.push({ name, ...detail }); console.log(`PASS ${name}`); };
const study = '2.25.960', baseSamples = Array.from({ length: 16 }, (_, index) => index * 10);
const scalar = { rows: 4, columns: 4, frames: 3, bitsAllocated: 16, bitsStored: 16, signed: false,
    sopClass: '1.2.840.10008.5.1.4.1.1.7.3', modality: 'OT', rescaleType: 'TEST', slope: 2, intercept: -100,
    sopUid: `${study}.1.1`, seriesUid: `${study}.1`, values: [0, 200, 400].flatMap(offset => baseSamples.map(value => value + offset)),
    pixelSpacing: [2, 3], window: { center: 50, width: 400 }, extraAttributes: { '0020000D': ['UI', study], '00200052': ['UI', `${study}.2`] } };
const fixtures = {
    scalar: createDicomFixture(scalar),
    other: createDicomFixture({ ...scalar, sopUid: `${study}.1.2`, seriesUid: `${study}.3` }),
    uncalibrated: createDicomFixture({ ...scalar, sopUid: `${study}.1.3`, extraAttributes: { ...scalar.extraAttributes, '00280030': null } }),
    legacy: createDicomFixture({ ...scalar, frames: 1, values: baseSamples, photometric: 'MONOCHROME1',
        sopUid: `${study}.1.5`, seriesUid: '2.25.0960.007', pixelSpacing: [0.139, 0.139],
        extraAttributes: { ...scalar.extraAttributes, '00200052': null } }),
    enhanced: createEnhancedDicom(),
    rgb: createDicomFixture({ rows: 4, columns: 4, frames: 1, bitsAllocated: 8, bitsStored: 8,
        rawPixelBytes: Uint8Array.from(baseSamples.flatMap((value, index) => [value, 255 - value, index])), photometric: 'RGB',
        sopClass: '1.2.840.10008.5.1.4.1.1.7', modality: 'OT', sopUid: `${study}.1.4`, seriesUid: `${study}.4`, pixelSpacing: [2, 3],
        extraAttributes: { '00280002': ['US', 3], '00280006': ['US', 0] } })
};
let browser;
const approximate = (value, expected, tolerance = 1e-7) => assert.ok(Math.abs(value - expected) <= tolerance, `${value} versus independent reference ${expected}`);

try {
    const buildInfo = JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8'));
    await mkdir(qa, { recursive: true }); await mkdir(output, { recursive: true });
    const entry = resolve(output, 'entry.js');
    await writeFile(entry, `export{createImageTransform,transformPoint}from'../../src/render/ViewportTransform.js';
export const fixtures=${quote(Object.fromEntries(Object.entries(fixtures).map(([name, bytes]) => [name, Buffer.from(bytes).toString('base64')])))};
export function file(name){return new File([Uint8Array.from(atob(fixtures[name]),c=>c.charCodeAt(0))],'synthetic-annotations-'+name+'.dcm',{type:'application/dicom'});}`);
    await build({ entryPoints: [entry], outfile: resolve(qa, 'fixtures.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true });
    await writeFile(resolve(qa, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="./host.css"></head><body><main id="one"></main><aside id="two"></aside><script type="module" src="./host.js"></script></body></html>');
    await writeFile(resolve(qa, 'host.css'), 'body{margin:0;background:#101820}#one{height:1050px;width:100%}#two{height:750px;width:100%}');
    await writeFile(resolve(qa, 'host.js'), `import{createViewer}from'../assets/easi-view.js';import*as qa from'./fixtures.js';window.__qa=qa;window.__events=[];window.__viewer=createViewer(document.getElementById('one'));for(const kind of['annotationchange','annotationselectionchange','framechange','sourcechange','error'])window.__viewer.on(kind,detail=>window.__events.push({kind,detail}));await window.__viewer.ready;window.__shadow=document.getElementById('one').querySelector('easi-view-embed').shadowRoot;window.__pane=slot=>window.__shadow.querySelector('.workspace-pane[data-slot="'+slot+'"]');window.__canvas=slot=>window.__pane(slot).querySelector('canvas');window.__ready=true;`);
    browser = await browserSession(output);
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1200, deviceScaleFactor: 1, mobile: false });
    await browser.send('Page.navigate', { url: new URL('qa/index.html', target).href });
    await browser.until('window.__ready', 'Annotation host did not mount.');
    await browser.evaluate('window.__viewer.openFiles([window.__qa.file("scalar")])');
    assert.deepEqual(await browser.evaluate('({count:window.__viewer.getAnnotationState().count,frameCount:window.__viewer.getAnnotationState().frameCount})'), { count: 0, frameCount: 0 });
    const menu=await browser.evaluate(`(()=>{const menu=window.__shadow.getElementById('measurement-tools');menu.querySelector('summary').click();const opened=menu.open;menu.querySelector('[data-tool="rectangle"]').click();return{opened,closed:!menu.open,tool:window.__viewer.getState().tool,pressed:menu.querySelector('[data-tool="rectangle"]').getAttribute('aria-pressed')};})()`);
    assert.equal(menu.opened,true);assert.equal(menu.closed,true);assert.equal(menu.tool,'rectangle');assert.equal(menu.pressed,'true');
    record('desktop measurement menu opens, selects an advanced tool, updates its pressed state and closes');
    const point = async (x, y, slot = 0, spacing = [2, 3], dimensions = [4, 4]) => browser.evaluate(`(()=>{const canvas=window.__canvas(${slot}),r=canvas.getBoundingClientRect(),state=window.__viewer.getWorkspaceState().viewports[${slot}].transform,t=window.__qa.createImageTransform({rows:${dimensions[0]},columns:${dimensions[1]},pixelSpacing:${quote(spacing)}},state,r.width,r.height),p=window.__qa.transformPoint(t,${x},${y});return{x:r.x+p.x,y:r.y+p.y};})()`);
    const mouse = (type, p, buttons = 0) => browser.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: buttons ? 'left' : 'none', buttons, ...(type === 'mousePressed' || type === 'mouseReleased' ? { clickCount: 1 } : {}) });
    const click = async p => { await mouse('mousePressed', p, 1); await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 }); };
    const drag = async (a, b) => { await mouse('mouseMoved', a); await mouse('mousePressed', a, 1); await mouse('mouseMoved', b, 1); await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 0, clickCount: 1 }); };
    const key = async (key, code, modifiers = 0) => { await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers }); await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers }); };
    const annotations = () => browser.evaluate('window.__viewer.getAnnotations()');
    const measure = id => browser.evaluate(`window.__viewer.measureAnnotation(${quote(id)})`);
    const choose = tool => browser.evaluate(`window.__viewer.setTool(${quote(tool)})`);

    await choose('distance'); await drag(await point(0.5, 0.5), await point(1.5, 0.5));
    let items = await annotations(); assert.equal(items.length, 1); assert.equal(items[0].tool, 'length');
    let result = await measure(items[0].id); approximate(result.geometry.value, 3, 0.03); assert.equal(result.geometry.unit, 'mm'); assert.equal(result.geometry.calibrated, true);
    record('real pointer distance creates a durable image-bound measurement with anisotropic DICOM calibration');

    await choose('rectangle'); await drag(await point(0.01, 0.01), await point(1.99, 1.99));
    items = await annotations(); const rectangle = items.find(annotation => annotation.tool === 'rectangle'); assert.ok(rectangle);
    result = await measure(rectangle.id); assert.equal(result.statistics.pixelCount, 4); assert.equal(result.statistics.stored.mean, 25);
    approximate(result.statistics.stored.stdDev, Math.sqrt(425)); assert.equal(result.statistics.modality.mean, -50);
    approximate(result.statistics.modality.stdDev, 2 * Math.sqrt(425)); assert.equal(result.statistics.stored.min, 0); assert.equal(result.statistics.stored.max, 50);
    assert.equal(result.statistics.sampledArea, 24); assert.equal(result.statistics.areaUnit, 'mm2'); assert.equal(result.statistics.unit, 'TEST');
    approximate(result.geometry.value, 1.98 ** 2 * 6, 0.25);
    assert.match(await browser.evaluate('window.__shadow.getElementById("annotation-statistics").textContent'), /Mean -50 TEST.*SD 41\.231/);
    record('drawn rectangle reports independent stored/modality population statistics and calibrated area', { storedMean: 25, modalityMean: -50, includedPixels: 4, sampledAreaMm2: 24 });

    await browser.evaluate('window.__beforeWindowStats=window.__viewer.measureAnnotation('+quote(rectangle.id)+');window.__viewer.setWindow({center:500,width:10})');
    assert.deepEqual(await measure(rectangle.id), result);
    record('window and level do not alter ROI stored values, modality transform or statistics');

    await choose('ellipse'); await drag(await point(2.01, 2.01), await point(3.99, 3.99));
    items = await annotations(); const ellipse = items.find(annotation => annotation.tool === 'ellipse'); assert.ok(ellipse);
    const ellipseResult = await measure(ellipse.id); assert.equal(ellipseResult.statistics.pixelCount, 4); assert.equal(ellipseResult.statistics.stored.mean, 125);
    approximate(ellipseResult.geometry.value, Math.PI * 1.98 ** 2 * 6 / 4, 0.2);
    await choose('angle'); for (const p of [[0.5, 2.5], [0.5, 3.5], [1.5, 3.5]]) await click(await point(...p));
    const angle = (await annotations()).find(annotation => annotation.tool === 'angle'); assert.ok(angle); approximate((await measure(angle.id)).geometry.value, 90, 0.5);
    await choose('polygon'); for (const p of [[2.01, 0.01], [3.99, 0.01], [3.99, 1.99], [2.01, 1.99]]) await click(await point(...p)); await key('Enter', 'Enter');
    const polygon = (await annotations()).find(annotation => annotation.tool === 'polygon'); assert.ok(polygon); const polygonResult = await measure(polygon.id);
    assert.equal(polygonResult.statistics.pixelCount, 4); assert.equal(polygonResult.statistics.stored.mean, 45);
    approximate(polygonResult.geometry.value, 1.98 ** 2 * 6, 0.25);
    record('ellipse, three-point angle and click-to-close polygon gestures create independently measured annotations');

    const selected = await browser.evaluate(`(()=>{const list=window.__viewer.getAnnotations(),index=list.findIndex(x=>x.id===${quote(rectangle.id)});window.__shadow.getElementById('annotation-list').children[index].click();return window.__viewer.getAnnotationState();})()`);
    assert.equal(selected.selected, true); await drag(await point(...Object.values(rectangle.points[1])), await point(2.99, 1.99));
    const edited = (await annotations()).find(annotation => annotation.id === rectangle.id); assert.equal(edited.points.length, 2); approximate(edited.points[1].x, 2.99, 0.015);
    const editedStats = await measure(rectangle.id); assert.equal(editedStats.statistics.pixelCount, 6); assert.equal(editedStats.statistics.stored.mean, 30);
    await browser.evaluate('window.__shadow.getElementById("annotation-undo").click()');
    assert.deepEqual((await annotations()).find(annotation => annotation.id === rectangle.id), rectangle);
    await browser.evaluate('window.__shadow.getElementById("annotation-redo").click()');
    assert.deepEqual((await annotations()).find(annotation => annotation.id === rectangle.id), edited);
    record('selected handle edits update ROI statistics and UI undo/redo restore the exact committed points');

    const originalCount = (await annotations()).length;
    await browser.evaluate('window.__canvas(0).focus()'); await key('Delete', 'Delete'); assert.equal((await annotations()).length, originalCount - 1);
    await key('z', 'KeyZ', 2); assert.equal((await annotations()).length, originalCount);
    await choose('polygon'); await click(await point(0.2, 2.2)); await click(await point(1.8, 2.2)); await key('Escape', 'Escape');
    assert.equal((await annotations()).length, originalCount);
    assert.equal(await browser.evaluate('window.__pane(0).querySelectorAll(".annotation-draft").length'), 0);
    record('focused delete is undoable and Escape cancels an unfinished polygon without committing data');

    const beforeFrame = await annotations(); await browser.evaluate('window.__viewer.setFrame(1)');
    assert.equal((await annotations()).length, 0); assert.equal(await browser.evaluate('window.__pane(0).querySelectorAll(".persistent-annotations .measurement-line").length'), 0);
    const secondFrame = await browser.evaluate('window.__viewer.addAnnotation({tool:"length",points:[{x:.5,y:.5},{x:.5,y:1.5}]})');
    assert.equal(secondFrame.image.frameNumber, 2);
    await browser.evaluate('window.__viewer.setFrame(0)'); assert.deepEqual(await annotations(), beforeFrame);
    await browser.evaluate('window.__viewer.setLayout(2);window.__viewer.assignViewportSeries(1,0)');
    assert.equal(await browser.evaluate('window.__viewer.getAnnotations({viewport:1}).length'), beforeFrame.length);
    await browser.evaluate('window.__viewer.setActiveViewport(1);window.__viewer.setFrame(1)');
    assert.equal(await browser.evaluate('window.__viewer.getAnnotations({viewport:0}).length'), beforeFrame.length);
    assert.equal(await browser.evaluate('window.__viewer.getAnnotations({viewport:1})[0].image.frameNumber'), 2);
    record('annotations bind to SOP/original frame rather than selected pane and reappear on independently navigated shared-series panes');

    await browser.evaluate('window.__viewer.setActiveViewport(0);window.__viewer.setTool("pan")');
    const a = await point(2, 2), b = { x: a.x + 20, y: a.y + 10 };
    const pointsBeforePan = await annotations();
    await drag(a, b); assert.deepEqual(await annotations(), pointsBeforePan);
    assert.ok(await browser.evaluate('window.__viewer.getWorkspaceState().viewports[0].transform.panX>0'));
    assert.equal(await browser.evaluate('window.__pane(0).querySelectorAll(".persistent-annotations .measurement-line").length'), pointsBeforePan.length);
    await browser.evaluate('window.__shadow.getElementById("rotate-view").click();window.__shadow.getElementById("flip-view").click();window.__viewer.reset()');
    assert.deepEqual(await annotations(), pointsBeforePan);
    record('pan, rotation, flip and reset redraw durable image-space annotations without rewriting their coordinates');

    const exported = await browser.evaluate('window.__viewer.exportAnnotations()'); assert.equal(exported.schema, 'easi-view.annotations'); assert.equal(exported.coordinateSystem, 'image-edge'); assert.equal(exported.frameNumberBase, 1);
    assert.equal(exported.annotations.length, originalCount + 1); assert.ok(exported.annotations.every(annotation => annotation.image.sopUid && !Object.hasOwn(annotation, 'samples')));
    await browser.evaluate('window.__viewer.clearAnnotations()'); assert.equal(await browser.evaluate('window.__viewer.getAnnotationState().count'), 0);
    await browser.evaluate(`window.__viewer.importAnnotations(${quote(exported)},{mode:'replace'})`); assert.deepEqual(await browser.evaluate('window.__viewer.exportAnnotations()'), exported);
    const atomic = await browser.evaluate(`(()=>{const v=window.__viewer,prior=v.exportAnnotations(),invalid=structuredClone(prior);invalid.annotations[0].points[0].x=-1;let rejected=false;try{v.importAnnotations(invalid,{mode:'replace'});}catch{rejected=true;}return{rejected,unchanged:JSON.stringify(v.exportAnnotations())===JSON.stringify(prior)};})()`);
    assert.deepEqual(atomic, { rejected: true, unchanged: true });
    await browser.evaluate(`(()=>{const v=window.__viewer;v.clearAnnotations();const transfer=new DataTransfer();transfer.items.add(new File([${quote(JSON.stringify(exported))}],'synthetic-annotations.json',{type:'application/json'}));const input=window.__shadow.getElementById('annotation-input');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
    await browser.until(`window.__viewer.getAnnotationState().count===${exported.annotations.length}`,'UI annotation file import did not commit the generated document.');
    const uiExport=await browser.evaluate(`(async()=>{const create=URL.createObjectURL,click=HTMLAnchorElement.prototype.click;let body,filename;URL.createObjectURL=function(blob){body=blob.text();return create.call(this,blob);};HTMLAnchorElement.prototype.click=function(){if(this.download==='easi-view-annotations-v1.json'){filename=this.download;return;}return click.call(this);};try{window.__shadow.getElementById('annotation-export').click();return{filename,document:JSON.parse(await body)};}finally{URL.createObjectURL=create;HTMLAnchorElement.prototype.click=click;}})()`);
    assert.equal(uiExport.filename,'easi-view-annotations-v1.json');assert.deepEqual(uiExport.document,exported);
    record('explicit versioned JSON export/import round-trips SOP/frame references and rejects malformed replacement atomically');

    await browser.evaluate('window.__viewer.clearAnnotations();window.__viewer.openFiles([window.__qa.file("uncalibrated")])');
    const pixelLength = await browser.evaluate('window.__viewer.addAnnotation({tool:"length",points:[{x:.5,y:.5},{x:1.5,y:.5}]})');
    const pixelMeasure = await measure(pixelLength.id); assert.equal(pixelMeasure.geometry.value, 1); assert.equal(pixelMeasure.geometry.unit, 'px'); assert.equal(pixelMeasure.geometry.calibrated, false);
    await browser.evaluate('window.__shadow.getElementById("annotation-list").firstElementChild.click()');
    assert.match(await browser.evaluate('window.__shadow.getElementById("annotation-statistics").textContent'), /Uncalibrated image pixels/);
    record('missing Pixel Spacing produces explicit pixel units rather than inferred millimeters');

    await browser.evaluate('window.__viewer.openFiles([window.__qa.file("rgb")])');
    const rgbRoi = await browser.evaluate('window.__viewer.addAnnotation({tool:"rectangle",points:[{x:0,y:0},{x:2,y:2}]})');
    const rgbStats = await measure(rgbRoi.id); assert.equal(rgbStats.statistics.status, 'color-intensity-unavailable'); assert.equal(rgbStats.statistics.stored, null); assert.equal(rgbStats.statistics.modality, null); assert.equal(rgbStats.geometry.unit, 'mm2');
    record('RGB images retain calibrated geometry while declining scalar intensity statistics');

    await browser.evaluate('window.__viewer.openFiles([window.__qa.file("enhanced")])');
    const enhanced = await browser.evaluate('window.__viewer.addAnnotation({tool:"length",points:[{x:.5,y:.5},{x:1.5,y:.5}]})');
    assert.equal(enhanced.image.frameNumber, expectedGroups[0][0] + 1); approximate((await measure(enhanced.id)).geometry.value, 0.75);
    await browser.evaluate('window.__viewer.setFrame(1)'); assert.equal((await annotations()).length, 0);
    await browser.evaluate('window.__viewer.setFrame(0)'); assert.equal((await annotations())[0].image.frameNumber, 6);
    record('enhanced partitions bind annotations to the encoded original frame number instead of the sorted slice index');

    await browser.evaluate('(async()=>{await window.__viewer.setLayout(1);window.__viewer.setActiveViewport(0);await window.__viewer.openFiles([window.__qa.file("legacy")]);window.__viewer.clearAnnotations();})()');
    await choose('ellipse'); await drag(await point(0.5, 0.5, 0, [0.139, 0.139]), await point(3.5, 3.5, 0, [0.139, 0.139]));
    const legacyItems = await annotations(); assert.equal(legacyItems.length, 1); const legacyEllipse = legacyItems[0];
    assert.equal(legacyEllipse.tool, 'ellipse'); assert.equal(legacyEllipse.image.seriesUid, '2.25.0960.007');
    assert.equal(legacyEllipse.image.frameNumber, 1); assert.equal(Object.hasOwn(legacyEllipse.image, 'frameOfReferenceUid'), false);
    const legacyStats = await measure(legacyEllipse.id); approximate(legacyStats.geometry.value, Math.PI * 1.5 ** 2 * 0.139 ** 2, 0.001);
    assert.equal(legacyStats.geometry.unit, 'mm2'); assert.equal(legacyStats.geometry.calibrated, true);
    assert.equal(legacyStats.statistics.pixelCount, 4); assert.equal(legacyStats.statistics.stored.mean, 75); assert.equal(legacyStats.statistics.modality.mean, 50);
    await browser.evaluate('window.__viewer.setWindow({center:500,width:10})'); assert.deepEqual(await measure(legacyEllipse.id), legacyStats);
    assert.equal(await browser.evaluate('window.__shadow.getElementById("error-banner").hidden'), true);
    record('real pointer ellipse works for MONOCHROME1 with a literal legacy Series reference and no Frame of Reference, retaining calibrated area and source intensity statistics');

    const legacyDocument = await browser.evaluate('window.__viewer.exportAnnotations()');
    await browser.evaluate('window.__viewer.clearAnnotations()');
    await browser.evaluate(`window.__viewer.importAnnotations(${quote(legacyDocument)},{mode:'replace'})`);
    assert.deepEqual(await browser.evaluate('window.__viewer.exportAnnotations()'), legacyDocument);
    await browser.evaluate('window.__viewer.undoAnnotations()'); assert.equal((await annotations()).length, 0);
    await browser.evaluate('window.__viewer.redoAnnotations()'); assert.deepEqual(await annotations(), legacyItems);
    const seriesConflict = await browser.evaluate(`(()=>{const v=window.__viewer,prior=v.exportAnnotations(),conflict=structuredClone(prior);conflict.annotations[0].id='synthetic-canonical-series';conflict.annotations[0].image.seriesUid='2.25.960.7';let rejected=false;try{v.importAnnotations(conflict,{mode:'merge'});}catch{rejected=true;}return{rejected,unchanged:JSON.stringify(v.exportAnnotations())===JSON.stringify(prior)};})()`);
    assert.deepEqual(seriesConflict, { rejected: true, unchanged: true });
    await browser.evaluate('window.__viewer.openFiles([window.__qa.file("other")])'); assert.equal((await annotations()).length, 0);
    await browser.evaluate('window.__viewer.openFiles([window.__qa.file("legacy")])'); assert.deepEqual(await annotations(), legacyItems);
    record('legacy Series spellings survive export/import and undo/redo without aliasing canonical identifiers or another image');

    const privacy = await browser.evaluate('({state:window.__viewer.getState(),events:window.__events,localStorageLength:localStorage.length,sessionStorageLength:sessionStorage.length})');
    const serialized = JSON.stringify({ state: privacy.state, events: privacy.events });
    assert.ok(!/"(?:patientName|patientId|studyUid|seriesUid|sopUid|points|samples|pixelData)"\s*:|2\.25\.(?:960|810|811)/.test(serialized));
    assert.ok(privacy.events.some(event => event.kind === 'annotationchange')); assert.equal(privacy.localStorageLength, 0); assert.equal(privacy.sessionStorageLength, 0);
    assert.ok(browser.requests.every(request => !/\/dicom-web\//.test(request.url) && request.method === 'GET'));
    record('default annotation events contain operational counts and flags, with no image IDs, points, pixel arrays or persistent browser storage');

    await browser.evaluate('(async()=>{await window.__viewer.openFiles([window.__qa.file("scalar")]);await window.__viewer.setLayout(1);})()');
    await browser.evaluate('window.__viewer.clearAnnotations();window.__viewer.addAnnotation({tool:"rectangle",points:[{x:0,y:0},{x:2,y:2}]});window.__shadow.getElementById("annotation-list").firstElementChild.click()');
    await browser.screenshot('annotations-synthetic');
    const isolatedObservers=await browser.evaluate(`(async()=>{const v=window.__viewer,remove=[v.on('annotationchange',()=>{throw new Error('Synthetic synchronous host observer failure');}),v.on('annotationchange',async()=>{throw new Error('Synthetic asynchronous host observer failure');}),v.on('framechange',async()=>{throw new Error('Synthetic asynchronous frame observer failure');})];try{v.clearAnnotations();v.addAnnotation({tool:'rectangle',points:[{x:0,y:0},{x:2,y:2}]});await v.setFrame(1);v.setWindow({center:20,width:40});await v.setFrame(0);await new Promise(resolve=>setTimeout(resolve,30));return{state:v.getState(),annotations:v.getAnnotationState(),statistics:v.measureAnnotation(v.getAnnotations()[0].id).statistics};}finally{remove.forEach(unsubscribe=>unsubscribe());}})()`);
    assert.equal(isolatedObservers.state.frameIndex,0);assert.deepEqual(isolatedObservers.state.window,{center:20,width:40});assert.equal(isolatedObservers.annotations.count,1);assert.equal(isolatedObservers.annotations.frameCount,1);assert.equal(isolatedObservers.statistics.stored.mean,25);
    assert.equal(browser.errors.length,0);assert.equal(browser.consoleErrors.length,0);
    record('synchronous throwing and asynchronous rejecting host observers cannot break annotation edits, navigation, windowing or the browser');
    const isolation = await browser.evaluate(`(async()=>{const{createViewer}=await import('../assets/easi-view.js');window.__other=createViewer(document.getElementById('two'));await window.__other.ready;await window.__other.openFiles([window.__qa.file('other')]);window.__other.addAnnotation({tool:'length',points:[{x:.5,y:.5},{x:1.5,y:.5}]});window.__viewer.dispose();await window.__viewer.whenDisposed();return{disposed:window.__viewer.getAnnotationState(),other:window.__other.getAnnotationState()};})()`);
    assert.equal(isolation.disposed.count, 0); assert.equal(isolation.disposed.bytes, 0); assert.equal(isolation.other.count, 1);
    await browser.evaluate('(async()=>{window.__other.dispose();await window.__other.whenDisposed();})()');
    assert.equal(browser.errors.length, 0); assert.equal(browser.consoleErrors.length, 0);
    assert.equal(JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8')).sourceDigest, buildInfo.sourceDigest);
    record('annotation stores and listeners dispose independently without changing a sibling viewer');
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ passed: checks.length, checks, sourceDigest: buildInfo.sourceDigest,
        harnessSha256: createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'),
        fixtureReference: { dimensions: [4, 4], pixelSpacing: [2, 3], storedSamples: baseSamples, slope: 2, intercept: -100,
            rectangleStoredValues: [0, 10, 40, 50], varianceDefinition: 'population', enhancedEncodedGroups: expectedGroups },
        browserExceptions: 0, consoleErrors: 0, originalImagingFilesUsed: false }, null, 2) + '\n');
    console.log(`Annotation browser checks: ${checks.length} passed.`);
} finally {
    browser?.close(); await rm(qa, { recursive: true, force: true });
    for (const entry of await readdir(output, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory() && entry.name.startsWith('profile-')) await rm(resolve(output, entry.name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
}
