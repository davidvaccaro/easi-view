import test from 'node:test';
import assert from 'node:assert/strict';
import { SpecialtyWorkspace } from '../src/ui/SpecialtyWorkspace.js';
import { MAX_SPECIALTY_BYTES } from '../src/specialties/index.js';
import { reconstructionDom } from './reconstruction-ui-fixtures.js';
import { xaFixture, doseFixture, breastFixture, slideFixture, cineFixture, j, independentNativeFixture } from './specialties-fixtures.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
const native = values => new Blob([independentNativeFixture(values)], { type: 'application/dicom' });
const json = values => new Blob([JSON.stringify(values)], { type: 'application/dicom+json' });
function fixture(hooks = {}) {
    const dom = reconstructionDom(), changes = [], errors = [];
    const prototype = Object.getPrototypeOf(dom.root);
    prototype.removeEventListener = function(type, listener) { this.listeners[type] = (this.listeners[type] ?? []).filter(item => item !== listener); };
    const prior = dom.document.createElement('button'); prior.inert = true; dom.root.append(prior); prior.focus();
    const workspace = new SpecialtyWorkspace(dom.root, { onChange: state => { changes.push(state); return hooks.onChange?.(state); }, onError: error => { errors.push(error); return hooks.onError?.(error); } });
    return { ...dom, workspace, prior, changes, errors };
}

test('XA workspace displays independent signed subtraction, explicit window and allocation-free stored probes', async () => {
    const f = fixture(), original = xaFixture(), file = native(original);
    try {
        const state = await f.workspace.openFiles([file]); assert.equal(state.profile, 'xa'); assert.equal(state.frameIndex, 2); assert.equal(state.ready, true);
        assert.deepEqual(f.workspace.probe(0, 0), { kind: 'xa-subtraction', column: 0, row: 0, frameIndex: 2, stored: 10, value: 11,
            units: 'stored-intensity difference', relationship: 'LIN', relationshipSign: -1 });
        await f.workspace.configure({ window: { center: 11, width: 22 } }); assert.deepEqual([...f.canvases()[0].context.image], [128, 128, 128, 255, 104, 104, 104, 255, 255, 255, 255, 255]);
        assert.equal(f.workspace.probe(1, 0).stored, 20); assert.equal(f.workspace.probe(1, 0).value, 9);
        const bytes = f.workspace.getState().bytes; for (let index = 0; index < 1000; index++) assert.equal(f.workspace.probe(0, 0).stored, 10); assert.equal(f.workspace.getState().bytes, bytes);
        await f.workspace.setFrame(3); assert.equal(f.workspace.probe(1, 0).value, -1); assert.equal(f.workspace.probe(1, 0).stored, 10);
        await f.workspace.setFrame(0); assert.equal(f.workspace.probe(0, 0), null); assert.equal(f.canvases()[0].width, 0); // Timeline outside valid contrast range.
        await f.workspace.setFrame(2); assert.equal(f.workspace.probe(0, 0).value, 11);
        const report = JSON.parse(f.workspace.exportReport()); assert.equal(report.units, 'stored-intensity difference'); assert.equal(report.sourceReferences[0].sopUid, '2.25.811');
        assert.equal(report.display.window.width, 22); assert.equal(report.display.voiFunction, 'LINEAR_EXACT');
        assert.ok(!/Patient|SYNTHETIC\^|InlineBinary|samples|rgba|PixelData/.test(JSON.stringify(report)));
        assert.ok(!/2\.25\.|sopUid|seriesUid|patient|samples|rgba|window/.test(JSON.stringify(f.changes))); assert.ok(f.changes.every(state => state.bytes <= state.budget));
    } finally { await f.workspace.dispose(); }
    assert.equal(f.workspace.getState().bytes, 0); assert.equal(f.prior.inert, true); assert.equal(f.document.activeElement, f.prior);
});
test('RT Dose selected original planes preserve uint32, GY/RELATIVE values, LPS and anisotropic display aspect', async () => {
    const f = fixture();
    try {
        await f.workspace.openFiles([native(doseFixture({ bits: 32 }))]); await f.workspace.configure({ window: { center: 5, width: 12 } }); await f.workspace.setFrame(2);
        assert.deepEqual(f.workspace.probe(1, 1), { kind: 'dose', column: 1, row: 1, frameIndex: 2, stored: 25, value: 12.5, units: 'GY', patientLpsMm: [13, 22, 35] });
        assert.equal(f.canvases()[0].context.image[0], 234); assert.equal(f.canvases()[0].style.aspectRatio, '1.5');
        assert.equal(f.canvases()[0].style.objectFit, 'fill'); // Element owns physical aspect; intrinsic bitmap does not letterbox again.
        assert.equal(f.canvases()[0].parentNode.className, 'specialty-display');
        assert.equal(JSON.parse(f.workspace.exportReport()).units, 'GY');
        await f.workspace.openFiles([native(doseFixture({ '30040002': j('CS', 'RELATIVE') }))]); assert.equal(f.workspace.probe(1, 1).units, 'RELATIVE');
        assert.equal(JSON.parse(f.workspace.exportReport()).display.window.width, 1);
    } finally { await f.workspace.dispose(); }
});
test('successful frame, window and source commits clear stale displayed quantitative probe labels', async () => {
    const f = fixture(), canvas = f.canvases()[0], label = f.root.querySelectorAll('output').find(element => element.className === 'specialty-probe');
    const hover = () => { for (const listener of canvas.listeners.pointermove) listener({ clientX: 1.5, clientY: 1.5 }); };
    try {
        await f.workspace.openFiles([native(doseFixture())]); hover(); assert.match(label.textContent, /Original frame 1.*stored 5.*2\.5 GY/);
        await f.workspace.setFrame(2); assert.equal(label.textContent, ''); hover(); assert.match(label.textContent, /Original frame 3.*stored 25.*12\.5 GY/);
        await f.workspace.configure({ window: { center: 5, width: 12 } }); assert.equal(label.textContent, ''); hover(); assert.match(label.textContent, /stored 25/);
        await f.workspace.openFiles([native(doseFixture({ '30040002': j('CS', 'RELATIVE') }))]); assert.equal(label.textContent, ''); hover(); assert.match(label.textContent, /Original frame 1.*RELATIVE/);
        await f.workspace.openFiles([json(cineFixture())]); assert.equal(label.textContent, '');
    } finally { await f.workspace.dispose(); }
});
test('replacement profile/geometry/budget failures preserve committed quantitative samples and canvas', async () => {
    const f = fixture();
    try {
        await f.workspace.openFiles([native(doseFixture())]); const before = f.workspace.probe(1, 1), image = [...f.canvases()[0].context.image], modelBytes = f.workspace.getState().modelBytes;
        for (const file of [native(doseFixture({ offsets: [0, 2, 2] })), native(doseFixture({ '00080016': j('UI', '1.2.840.10008.5.1.4.1.1.2') })),
            native(xaFixture({ '00280010': j('US', 4096), '00280011': j('US', 4096) }))]) {
            await assert.rejects(f.workspace.openFiles([file]), /Unsupported/); assert.deepEqual(f.workspace.probe(1, 1), before); assert.deepEqual([...f.canvases()[0].context.image], image);
            assert.equal(f.workspace.getState().modelBytes, modelBytes); assert.equal(f.workspace.getState().pendingBytes, 0);
        }
        assert.throws(() => f.workspace.configure({ window: { center: 0, width: 0 } }), /display window/); assert.throws(() => f.workspace.setFrame(100), /valid original/);
    } finally { await f.workspace.dispose(); }
});
test('canvas upload failure rolls back its dimensions, original values and display options', async () => {
    const f = fixture();
    try {
        await f.workspace.openFiles([native(doseFixture())]); const image = [...f.canvases()[0].context.image], before = f.workspace.probe(1, 1);
        f.canvases()[0].context.rejectNext = true; await assert.rejects(f.workspace.setFrame(2), /Canvas2D/);
        assert.deepEqual([...f.canvases()[0].context.image], image); assert.deepEqual(f.workspace.probe(1, 1), before); assert.equal(f.workspace.getState().frameIndex, 0);
    } finally { await f.workspace.dispose(); }
});
test('cine timeline stepping, manual timing and declared sweep play are operational without unverified pixels', async t => {
    const f = fixture();
    try {
        await f.workspace.openFiles([json(cineFixture({ '00181244': j('US', 1) }))]); assert.equal(f.workspace.getState().profile, 'cine'); assert.equal(f.workspace.getState().hasCine, true);
        assert.equal(f.canvases()[0].width, 0); assert.equal(f.workspace.probe(0, 0), null); await f.workspace.setFrame(3);
        await f.workspace.configure({ manualRateFps: 50 }); assert.equal(f.workspace.getState().timing, 'manual');
        t.mock.timers.enable({ apis: ['setTimeout'] });
        f.workspace.play(); await flush(); assert.equal(f.workspace.getState().frameIndex, 3); assert.equal(f.workspace.getState().playing, true);
        t.mock.timers.tick(20); await flush(); assert.equal(f.workspace.getState().frameIndex, 2);
        t.mock.timers.tick(20); await flush(); assert.equal(f.workspace.getState().frameIndex, 1);
        f.workspace.pause(); t.mock.timers.tick(100); await flush(); assert.equal(f.workspace.getState().frameIndex, 1); assert.equal(f.workspace.getState().playing, false);
        const report = JSON.parse(f.workspace.exportReport()); assert.equal(report.cine.sequencing, 'sweep'); assert.deepEqual(report.cine.sequence, [1, 2, 3, 2]); assert.equal(report.cine.physiologicalPhase, null);
    } finally { t.mock.timers.reset(); await f.workspace.dispose(); }
});
test('native XA can gain an explicit manual cine plan while its quantitative source remains valid', async () => {
    const f = fixture();
    try {
        await f.workspace.openFiles([native(xaFixture())]); assert.equal(f.workspace.getState().hasCine, false);
        await f.workspace.configure({ manualFrameTimeMs: 33 }); assert.equal(f.workspace.getState().hasCine, true); assert.equal(f.workspace.getState().timing, 'manual');
        assert.equal(f.workspace.probe(0, 0).value, 11); assert.equal(JSON.parse(f.workspace.exportReport()).cine.durationsMs[0], 33);
    } finally { await f.workspace.dispose(); }
});
test('breast multi-file workspace shows missing/ambiguous slots and exports scoped references only on request', async () => {
    const f = fixture();
    try {
        await f.workspace.openFiles([json(breastFixture()), json(breastFixture({ sopUid: '2.25.840' })), json(breastFixture({ laterality: 'L', sopUid: '2.25.841' }))]);
        const state = f.workspace.getState(); assert.equal(state.profile, 'breast'); assert.equal(state.sourceCount, 3); assert.equal(state.readyLayoutSlots, 1); assert.equal(state.ambiguousLayoutSlots, 1);
        const report = JSON.parse(f.workspace.exportReport()); assert.equal(report.breastLayout.orientationPolicy, 'source-unchanged'); assert.equal(report.breastLayout.slots[0].status, 'ambiguous');
        assert.equal(f.canvases()[0].width, 0); assert.throws(() => f.workspace.play(), /no supported cine/);
    } finally { await f.workspace.dispose(); }
});
test('WSI metadata/index workspace supports region and unit-safe slide coordinates without any pixel or network request', async () => {
    const f = fixture(); let requests = 0; const previous = globalThis.fetch; globalThis.fetch = () => { requests++; throw new Error('unexpected request'); };
    try {
        await f.workspace.openFiles([json(slideFixture({ '7FE00010': { vr: 'OB', BulkDataURI: 'https://example.invalid/pixels' } }))]);
        assert.equal(f.workspace.getState().profile, 'slide'); assert.equal(f.workspace.getState().tileQueryCount, 1); assert.equal(f.canvases()[0].width, 0);
        await f.workspace.configure({ slideRegion: { column: 2, row: 1, width: 3, height: 2 }, slidePoint: { xMm: 9.994, yMm: 20.006, zUm: 300 } });
        assert.equal(f.workspace.getState().tileQueryCount, 4); const report = JSON.parse(f.workspace.exportReport()); assert.equal(report.slideIndex.preview, 'index-only');
        assert.deepEqual(report.slideIndex.tiles.map(tile => tile.frameNumber), [1, 2, 4, 5]); assert.ok(Math.abs(report.slideIndex.pointPixel.column - 2) < 1e-8); assert.equal(requests, 0);
        await f.workspace.openFiles([native(slideFixture({ '7FE00010': { vr: 'OB', InlineBinary: Buffer.alloc(256 * 1024).toString('base64') } }))]);
        assert.equal(f.workspace.getState().tileQueryCount, 1); assert.ok(f.workspace.getState().modelBytes < 20000); assert.equal(f.workspace.getState().outputBytes, 0);
    } finally { globalThis.fetch = previous; await f.workspace.dispose(); }
});
test('close aborts an incomplete local EASI stream promptly and dispose restores inert/focus and removes listeners', async () => {
    const f = fixture(); let canceled = 0;
    class HangingSlice extends Blob { stream() { return new ReadableStream({ start(controller) { controller.enqueue(independentNativeFixture(xaFixture()).subarray(0, 150)); }, cancel() { canceled++; } }); } }
    class HangingFile extends Blob { slice(start, end) { const slice = super.slice(start, end); return end - start <= 256 ? slice : new HangingSlice([slice]); } }
    const pending = f.workspace.openFiles([new HangingFile([independentNativeFixture(xaFixture())])]), rejected = assert.rejects(pending, { name: 'AbortError' });
    await tick(); assert.equal(f.workspace.getState().busy, true); const close = f.workspace.close(); await rejected; await close; assert.equal(canceled, 1);
    assert.equal(f.workspace.getState().bytes, 0); assert.equal(f.workspace.getState().open, false); assert.equal(f.prior.inert, true); assert.equal(f.document.activeElement, f.prior);
    const dialog = f.workspace.element; await f.workspace.dispose(); assert.equal(f.root.children.length, 1); assert.ok(Object.values(dialog.listeners).every(list => list.length === 0));
    assert.throws(() => f.workspace.openFiles([native(xaFixture())]), /disposed/);
});
test('old queued close cannot erase a reopened local stream cancellation owner before later close or dispose', { timeout: 2000 }, async () => {
    for (const dispose of [false, true]) {
        const f = fixture(); let started = false, canceled = 0;
        const bytes = independentNativeFixture(xaFixture());
        class HangingSlice extends Blob { stream() { return new ReadableStream({ start(controller) { started = true; controller.enqueue(bytes.subarray(0, 150)); }, cancel() { canceled++; } }); } }
        class HangingFile extends Blob { slice(start, end) { const slice = super.slice(start, end); return end - start <= 256 ? slice : new HangingSlice([slice]); } }
        try {
            await f.workspace.openFiles([native(doseFixture())]);
            const closing = f.workspace.close();
            const reopening = f.workspace.openFiles([new HangingFile([bytes])]), rejected = assert.rejects(reopening, { name: 'AbortError' });
            await closing; await tick(); assert.equal(started, true); assert.equal(f.workspace.getState().open, true); assert.equal(f.workspace.getState().busy, true);
            await (dispose ? f.workspace.dispose() : f.workspace.close()); await rejected;
            assert.equal(canceled, 1); assert.equal(f.workspace.getState().bytes, 0); assert.equal(f.workspace.getState().busy, false);
            assert.equal(f.workspace.getState().open, false); assert.equal(f.workspace.getState().disposed, dispose);
            assert.equal(f.prior.inert, true); assert.equal(f.document.activeElement, f.prior);
        } finally { await f.workspace.dispose(); }
    }
});
test('an open queued during disposal rejects before local streaming and leaves zero owned resources', { timeout: 2000 }, async () => {
    const f = fixture(), bytes = independentNativeFixture(doseFixture()); let started = false, canceled = 0;
    class HangingSlice extends Blob { stream() { return new ReadableStream({ start(controller) { started = true; controller.enqueue(bytes.subarray(0, 150)); }, cancel() { canceled++; } }); } }
    class HangingFile extends Blob { slice(start, end) { const slice = super.slice(start, end); return end - start <= 256 ? slice : new HangingSlice([slice]); } }
    await f.workspace.openFiles([native(doseFixture())]);
    const disposing = f.workspace.dispose(), pending = f.workspace.openFiles([new HangingFile([bytes])]);
    const rejected = assert.rejects(pending, { name: 'AbortError' }); await disposing; await rejected;
    assert.equal(started, false); assert.equal(canceled, 0); assert.equal(f.workspace.getState().bytes, 0);
    assert.equal(f.workspace.getState().disposed, true); assert.equal(f.workspace.getState().busy, false); assert.equal(f.root.children.length, 1);
});
test('pre-cancel, oversized input and unknown options reject before local processing; hostile errors stay sanitized', async () => {
    const f = fixture();
    try {
        const controller = new AbortController(); controller.abort(); assert.throws(() => f.workspace.openFiles([native(xaFixture())], { signal: controller.signal }), { name: 'AbortError' });
        class Oversized extends Blob { get size() { return MAX_SPECIALTY_BYTES + 1; } stream() { throw new Error('must not read'); } }
        assert.throws(() => f.workspace.openFiles([new Oversized([])]), /budget/); assert.throws(() => f.workspace.openFiles(['https://private.invalid']), /local Blob/);
        assert.throws(() => f.workspace.openFiles([native(xaFixture())], { unknown: true }), TypeError);
        class BrokenSlice extends Blob { stream() { throw new Error('secret patient identifier https://private.invalid credential'); } }
        class Broken extends Blob { slice(start, end) { const slice = super.slice(start, end); return end - start <= 256 ? slice : new BrokenSlice([slice]); } }
        await assert.rejects(f.workspace.openFiles([new Broken([independentNativeFixture(xaFixture())])]), error => !/secret|identifier|private|credential/.test(error.message));
        assert.equal(f.workspace.getState().bytes, 0);
    } finally { await f.workspace.dispose(); }
});
test('dimension swaps release canvas height before width and cannot allocate a hidden giant intermediate backing', async () => {
    const f = fixture(), canvas = f.canvases()[0]; let peak = 0;
    Object.defineProperties(canvas, { width: { configurable: true, get() { return this._width; }, set(value) { this._width = value; this.context.image = null; peak = Math.max(peak, this._width * this._height * 4); } },
        height: { configurable: true, get() { return this._height; }, set(value) { this._height = value; this.context.image = null; peak = Math.max(peak, this._width * this._height * 4); } } });
    try {
        const samples = Array(400000).fill(10);
        await f.workspace.openFiles([native(doseFixture({ rows: 4000, columns: 100, offsets: [0], samples }))]);
        await f.workspace.openFiles([native(doseFixture({ rows: 100, columns: 4000, offsets: [0], samples }))]);
        assert.equal(peak, 400000 * 4); assert.ok(f.changes.every(state => state.bytes <= MAX_SPECIALTY_BYTES));
    } finally { await f.workspace.dispose(); }
});
test('rapid patches publish only the final window and observer errors cannot break a committed profile', async () => {
    const f = fixture({ onChange: () => Promise.reject(new Error('ignored')), onError: () => Promise.reject(new Error('ignored')) });
    try {
        await f.workspace.openFiles([native(doseFixture())]); const first = f.workspace.configure({ window: { center: 5, width: 10 } }), rejected = assert.rejects(first, { name: 'AbortError' });
        await f.workspace.configure({ window: { center: 10, width: 20 } }); await rejected;
        assert.equal(JSON.parse(f.workspace.exportReport()).display.window.center, 10); assert.equal(f.workspace.probe(1, 1).value, 2.5); await tick();
    } finally { await f.workspace.dispose(); }
});
