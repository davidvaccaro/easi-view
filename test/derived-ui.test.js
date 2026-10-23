import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DerivedObjectPanel } from '../src/ui/DerivedObjectPanel.js';
import { createImageReference } from '../src/annotations/model.js';
import { segFixture, srFixture, gspsFixture, sourceFrame, writeFixture } from './derived-fixtures.js';

function panel(frames, options = {}) {
    const events = [], state = { frame: frames[0], resolves: 0 };
    const instance = new DerivedObjectPanel(null, { getFrame: () => state.frame,
        resolveSource: (uid, number) => { ++state.resolves; return frames.find(frame => frame.sopUid === uid && (number == null || frame.frameIndex === number - 1)); },
        onChange: value => events.push(value), ...options });
    return { instance, events, state };
}
const ai = (frame, id = 'ai-mask') => ({ id, kind: 'probability', values: Array.from({ length: frame.rows * frame.columns }, (_, index) => index % 2), opacity: .6, color: [240, 80, 20] });

test('SEG import is local/atomic and state returns completed counts without original samples or identifiers', async () => {
    const f = segFixture(), p = panel(f.sources), originals = f.sources.map(frame => [...frame.samples]);
    try {
        const result = await p.instance.import(new Blob([await writeFixture(f.metadata)], { type: 'application/dicom' }));
        assert.equal(result.overlayCount, 3); assert.equal(result.busy, false); assert.equal(p.instance.getState().overlayCount, 3);
        assert.deepEqual(f.sources.map(frame => [...frame.samples]), originals);
        assert.ok(p.events.every(event => !/sop|uid|patient|points|values|samples/i.test(JSON.stringify(event))));
        const exported = p.instance.exportOverlays(); assert.equal(exported.schema, 'easi-view.overlays'); assert.deepEqual(exported.overlays[0].values, [1, 0, 1]);
    } finally { p.instance.dispose(); }
});

test('failed later SEG source resolution preserves all previously committed overlays', async () => {
    const f = segFixture(), p = panel([f.sources[0]]);
    p.instance.addAiOverlay(ai(f.sources[0], 'keep'), f.sources[0]); const before = p.instance.exportOverlays();
    await assert.rejects(p.instance.import(await writeFixture(f.metadata)), /source frame is not loaded/);
    assert.deepEqual(p.instance.exportOverlays(), before); assert.equal(p.instance.getState().busy, false); p.instance.dispose();
});

test('missing source frame number needs authoritative single-frame proof and never guesses frame1', async () => {
    const f = segFixture(); delete f.metadata['52009230'].Value[0]['00089124'].Value[0]['00082112'].Value[0]['00081160'];
    const bytes = await writeFixture(f.metadata), p = panel(f.sources);
    await assert.rejects(p.instance.import(bytes), /verified single-frame/); assert.equal(p.instance.getState().overlayCount, 0); p.instance.dispose();
    const verified = panel(f.sources, { resolveSource: (uid, number) => { const frame = f.sources.find(value => value.sopUid === uid && (number == null || value.frameIndex === number - 1)); return frame ? { frame, _record: { frameCount: 1 } } : null; } });
    try { assert.equal((await verified.instance.import(bytes)).overlayCount, 3); } finally { verified.instance.dispose(); }
});

test('explicit AI overlay styles/visibility and JSON roundtrip preserve the exact source and original samples', async () => {
    const frame = sourceFrame(), p = panel([frame]), samples = [...frame.samples];
    const result = p.instance.addAiOverlay(ai(frame)); assert.deepEqual(result, { id: 'ai-mask' });
    p.instance.updateStyle(result.id, { visible: false }); assert.equal(p.instance.store.listDescriptors()[0].opacity, 0);
    p.instance.updateStyle(result.id, { visible: true }); assert.equal(p.instance.store.listDescriptors()[0].opacity, .6);
    p.instance.updateStyle(result.id, { color: [0, 0, 255], opacity: .2 });
    const saved = p.instance.exportOverlays(); p.instance.clear(); await p.instance.import(JSON.stringify(saved));
    assert.deepEqual(p.instance.exportOverlays(), saved); assert.deepEqual([...frame.samples], samples);
    assert.equal(p.instance.removeOverlay('ai-mask'), true); assert.equal(p.instance.removeOverlay('ai-mask'), false); p.instance.dispose();
});

for (const field of ['frameNumber', 'frameOfReferenceUid', 'geometryFingerprint', 'rows']) test(`overlay JSON rejects mismatched ${field} atomically`, async () => {
    const frame = sourceFrame(), p = panel([frame]); p.instance.addAiOverlay(ai(frame)); const saved = p.instance.exportOverlays(); p.instance.clear();
    const raw = saved.overlays[0].image;
    raw[field] = field === 'frameNumber' || field === 'rows' ? raw[field] + 1 : field === 'geometryFingerprint' ? 'g1-ffffffff' : '2.25.999';
    await assert.rejects(p.instance.import(saved)); assert.equal(p.instance.getState().overlayCount, 0); p.instance.dispose();
});

test('AI validation rejects source impersonation and omitted grid proof in JSON rather than narrowing scope', async () => {
    const frame = sourceFrame(), p = panel([frame]); assert.throws(() => p.instance.addAiOverlay({ ...ai(frame), source: 'seg' }), /impersonate/);
    p.instance.addAiOverlay(ai(frame)); const saved = p.instance.exportOverlays(); p.instance.clear(); delete saved.overlays[0].image.geometryFingerprint;
    await assert.rejects(p.instance.import(saved), /exact source grid/); assert.equal(p.instance.getState().overlayCount, 0); p.instance.dispose();
});

test('reported SR and GSPS import as bounded result documents, and presentation requires a separate explicit action', async () => {
    const sr = srFixture(), gsps = gspsFixture(), calls = [], original = [...gsps.sources[0].samples];
    const p = panel(gsps.sources, { onApplyGsps: (document, frame) => { calls.push({ document, frame }); } });
    try {
        await p.instance.import(await writeFixture(sr.metadata)); await p.instance.import(await writeFixture(gsps.metadata));
        assert.equal(p.instance.getState().reportedMeasurementCount, 1); assert.equal(p.instance.getState().gspsCount, 1); assert.equal(calls.length, 0);
        await p.instance.applyGsps(1); assert.equal(calls.length, 1); assert.equal(calls[0].document.window.width, 400);
        assert.equal(p.instance.getState().appliedPresentationCount, 1); assert.deepEqual([...gsps.sources[0].samples], original);
        const saved = p.instance.exportResults(); p.instance.clear(); await p.instance.importResults(saved); assert.deepEqual(p.instance.exportResults(), saved);
        assert.equal(p.instance.getState().appliedPresentationCount, 0);
    } finally { p.instance.dispose(); }
});

test('result JSON enforces loaded reference scope,1MiB document budget and duplicate atomicity', async () => {
    const f = srFixture(), p = panel(f.sources); await p.instance.import(await writeFixture(f.metadata)); const saved = p.instance.exportResults();
    await assert.rejects(p.instance.importResults(saved), /duplicate/); assert.deepEqual(p.instance.exportResults(), saved);
    const modified = structuredClone(saved); modified.documents[0].measurements[0].image.frameOfReferenceUid = '2.25.998';
    await assert.rejects(p.instance.importResults(modified, { mode: 'replace' })); assert.deepEqual(p.instance.exportResults(), saved);
    await assert.rejects(p.instance.importResults(' '.repeat(1024 * 1024 + 1)), /byte budget/);
    const unknown = structuredClone(saved); unknown.documents[0].patientName = 'FORBIDDEN'; await assert.rejects(p.instance.importResults(unknown));
    assert.deepEqual(p.instance.exportResults(), saved); p.instance.dispose();
});

test('cancel/clear/dispose stop unresolved local imports without publishing partial masks or late callbacks', async () => {
    const f = segFixture(); let resolvePending, started;
    const start = new Promise(resolve => { started = resolve; }), p = panel(f.sources, { resolveSource: () => new Promise(resolve => { resolvePending = resolve; started(); }) });
    const pending = p.instance.import(await writeFixture(f.metadata)); await start; p.instance.clear();
    await assert.rejects(pending, { name: 'AbortError' }); resolvePending(f.sources[0]); await Promise.resolve();
    assert.equal(p.instance.getState().overlayCount, 0); assert.equal(p.instance.getState().busy, false);
    const events = p.events.length; p.instance.dispose(); assert.equal(p.instance.getState().overlayBytes, 0); await Promise.resolve(); assert.equal(p.events.length, events);
    await assert.rejects(p.instance.import(new Uint8Array()), /disposed/);
});

test('latest explicit import supersedes delayed prior work and observer exceptions/rejections are isolated', async () => {
    const f = segFixture(); let began, release;
    const begun = new Promise(resolve => { began = resolve; }), p = panel(f.sources, { resolveSource: () => new Promise(resolve => { release = resolve; began(); }),
        onChange: () => Promise.reject(new Error('Synthetic observer')) });
    const old = p.instance.import(await writeFixture(f.metadata)); await begun;
    const empty = { schema: 'easi-view.overlays', version: 1, coordinateSystem: 'image-grid', frameNumberBase: 1, overlays: [] };
    const next = await p.instance.import(empty); assert.equal(next.busy, false); await assert.rejects(old, { name: 'AbortError' }); release(f.sources[0]);
    await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(p.instance.getState().overlayCount, 0); p.instance.dispose();
});

test('SVG reported graphics are numeric image-edge geometry with exact original-frame binding and no editable annotation injection', async () => {
    const f = srFixture(), p = panel(f.sources); await p.instance.import(await writeFixture(f.metadata));
    class Element { constructor(name) { this.name = name; this.children = []; this.attributes = {}; this.ownerDocument = doc; } setAttribute(k,v) { this.attributes[k]=v; } append(n) { this.children.push(n); } replaceChildren() { this.children=[]; } querySelector() { return this.children.find(n => Object.hasOwn(n.attributes,'data-derived-graphics')); } }
    const doc = { createElementNS: (_, name) => new Element(name) }, layer = new Element('svg');
    const viewport = { imageToScreen: (x,y) => ({ x: 10+y*2, y: 20-x*3 }) };
    assert.equal(p.instance.drawGraphics(f.sources[0],layer,viewport),1);
    assert.equal(layer.children[0].children[0].attributes.points,'10,20 22,-4'); assert.equal(layer.children[0].children[0].attributes.fill,'none');
    assert.equal(p.instance.drawGraphics({ ...f.sources[0],frameIndex:1 },layer,viewport),0); assert.equal(layer.children[0].children.length,0);
    assert.equal(p.instance.getState().reportedMeasurementCount,1); p.instance.dispose();
});


test('canceling JSON reference validation rejects promptly even when a resolver ignores its signal', async () => {
    const frame = sourceFrame(), original = panel([frame]); original.instance.addAiOverlay(ai(frame)); const saved = original.instance.exportOverlays(); original.instance.dispose();
    let began, release; const started = new Promise(resolve => { began = resolve; });
    const p = panel([frame], { resolveSource: () => new Promise(resolve => { release = resolve; began(); }) });
    const controller = new AbortController(), pending = p.instance.import(saved, { signal: controller.signal }); await started; controller.abort();
    await assert.rejects(pending, { name: 'AbortError' }); release(frame); await Promise.resolve(); assert.equal(p.instance.getState().overlayCount, 0); p.instance.dispose();
});

test('failed or wrong-frame GSPS application never marks a presentation applied', async () => {
    const f = gspsFixture(), p = panel(f.sources, { onApplyGsps: () => { throw new Error('Synthetic presentation failure'); } });
    await p.instance.import(await writeFixture(f.metadata)); await assert.rejects(p.instance.applyGsps(0), /presentation failure/);
    assert.equal(p.instance.getState().appliedPresentationCount, 0); p.state.frame = { ...f.sources[0], frameIndex: 1 };
    await assert.rejects(p.instance.applyGsps(0), /original frame/); assert.equal(p.instance.getState().appliedPresentationCount, 0); p.instance.dispose();
});


test('same-UID changed GSPS JSON needs explicit reapplication while identical content keeps its applied status', async () => {
    const f=gspsFixture(),p=panel(f.sources,{onApplyGsps:()=>{}});await p.instance.import(await writeFixture(f.metadata));await p.instance.applyGsps(0);
    const saved=p.instance.exportResults();await p.instance.importResults(saved,{mode:'replace'});assert.equal(p.instance.getState().appliedPresentationCount,1);
    const changed=structuredClone(saved);changed.documents[0].window.center+=1;changed.documents[0].graphics[0].points[1].x-=1;
    await p.instance.importResults(changed,{mode:'replace'});assert.equal(p.instance.getState().appliedPresentationCount,0);
    await p.instance.applyGsps(0);assert.equal(p.instance.getState().appliedPresentationCount,1);p.instance.dispose();
});

test('pane-specific presentation graphics disappear after its reset while reported SR remains visible', async () => {
    const f=gspsFixture(),s=srFixture(),p=panel(f.sources,{onApplyGsps:()=>{}});
    await p.instance.import(await writeFixture(f.metadata));await p.instance.import(await writeFixture(s.metadata));await p.instance.applyGsps(0);
    class Element {constructor(){this.children=[];this.attributes={};this.ownerDocument=doc;}setAttribute(k,v){this.attributes[k]=v;}append(n){this.children.push(n);}replaceChildren(){this.children=[];}querySelector(){return this.children.find(n=>Object.hasOwn(n.attributes,'data-derived-graphics'));}}
    const doc={createElementNS:()=>new Element()},layer=new Element(),viewport={imageToScreen:(x,y)=>({x,y})};
    assert.equal(p.instance.drawGraphics(f.sources[0],layer,viewport),3);
    assert.equal(p.instance.drawGraphics(f.sources[0],layer,viewport,{presentationSopUid:f.metadata['00080018'].Value[0]}),3);
    assert.equal(p.instance.drawGraphics(f.sources[0],layer,viewport,{presentationSopUid:null}),1);
    assert.equal(p.instance.drawGraphics(f.sources[0],layer,viewport,{presentationSopUid:'2.25.999'}),1);p.instance.dispose();
});
