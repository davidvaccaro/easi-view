import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameCache } from '../src/runtime/frame-cache.js';
import { WorkspaceModel, nearestSyncedSlice, compatibleWindow, patientCamera, frameWorldCenter } from '../src/runtime/workspace.js';
import { loadDemo, loadFiles } from '../src/data/sources.js';
import { createDicomFixture } from '../src/data/synthetic.js';

function frame(index = 0, options = {}) {
    return { id: `frame-${index}`, rows: 2, columns: 2, photometric: 'MONOCHROME2',
        samples: new Uint16Array([index, index + 1, index + 2, index + 3]), frameIndex: index,
        orientation: [1, 0, 0, 0, 1, 0], position: [0, 0, index], pixelSpacing: [1, 1],
        frameOfReferenceUid: '2.25.900', modality: 'CT', unit: 'HU', slope: 1, intercept: 0,
        window: { center: 40, width: 400 }, ...options };
}
function source(id, values = [frame(0), frame(1)], getter) {
    const session = { cache: new FrameCache(1024) };
    return { id, frames: values, _session: session, disposed: false, disposals: 0,
        async getFrame(index, options) {
            if (getter) return getter(index, options);
            const key = `${id}/${index}`, cached = session.cache.get(key);
            if (cached) return cached;
            const result = { ...values[index], id: key }; session.cache.set(key, result); return result;
        },
        dispose() { this.disposals++; this.disposed = true; session.cache.clear(); }
    };
}
const turn = () => new Promise(resolve => setTimeout(resolve, 0));

test('layout slots share sources, keep independent frames, and release explicit ownership exactly once', async () => {
    const workspace = new WorkspaceModel({ layout: 4 }), series = source('ct'), lease = workspace.registerSource([series]);
    await Promise.all(workspace.slots.map((_, slot) => workspace.assignSeries(lease, 'ct', { slot, index: slot % 2 })));
    assert.equal(lease.references, 5); assert.deepEqual(workspace.snapshot().slots.map(slot => slot.frameIndex), [0, 1, 0, 1]);
    workspace.releaseSource(lease);
    workspace.setLayout(2); assert.equal(lease.references, 2); assert.equal(series.disposals, 0);
    workspace.setActiveSlot(1); assert.equal(workspace.snapshot().activeSlot, 1);
    workspace.dispose(); workspace.dispose();
    assert.equal(series.disposals, 1); assert.equal(workspace.cache.bytes, 0); assert.equal(lease.released, true);
});

test('overlapping owned and borrowed leases preserve an active series and defer owned disposal', async () => {
    const workspace = new WorkspaceModel({ layout: 2 }), shared = source('shared');
    const first = workspace.registerSource([shared]), second = workspace.registerSource({ series: [shared] }, { owned: false });
    await workspace.assignSeries(second, 'shared', { slot: 1 });
    workspace.releaseSource(first); assert.equal(shared.disposals, 0);
    workspace.releaseSource(second); assert.equal(shared.disposals, 0);
    workspace.slots[1].clear(); assert.equal(shared.disposals, 1);
    workspace.dispose(); assert.equal(shared.disposals, 1);
});

test('borrowed sources regain an independent empty cache after the workspace releases them', async () => {
    const workspace = new WorkspaceModel(), series = source('borrowed'), lease = workspace.registerSource([series], { owned: false });
    await workspace.assignSeries(lease, 'borrowed'); workspace.dispose();
    assert.equal(series.disposals, 0); assert.equal(series._session.cache instanceof FrameCache, true);
    assert.equal(series._session.cache.bytes, 0);
    assert.deepEqual([...((await series.getFrame(1)).samples)], [1, 2, 3, 4]);
});

test('per-slot generation cancellation rejects promptly and ignores an uncooperative late result', async () => {
    let complete;
    const events = [], workspace = new WorkspaceModel({ layout: 2, onEvent: (type, detail) => events.push([type, detail.slot]) });
    const slow = source('slow', [frame()], () => new Promise(resolve => complete = resolve));
    const fast = source('fast');
    const pending = workspace.assignSeries([slow], 'slow', { slot: 0 });
    const rejected = assert.rejects(pending, { name: 'AbortError' }); await turn();
    workspace.slots[0].cancel(); await rejected;
    const other = workspace.assignSeries([fast], 'fast', { slot: 1, index: 1 });
    complete(frame()); await other;
    assert.equal(workspace.slots[0].frame, null); assert.equal(workspace.slots[1].frame.frameIndex, 1);
    assert.deepEqual(events.filter(([type]) => type === 'framechange'), [['framechange', 1]]);
    workspace.dispose();
});

test('shared broker serializes different viewport requests rather than invoking archive supersede concurrently', async () => {
    let active = 0, maximum = 0;
    const series = source('archive', [frame(0), frame(1)], async index => {
        maximum = Math.max(maximum, ++active); await turn(); active--; return frame(index);
    });
    const workspace = new WorkspaceModel({ layout: 2 }), lease = workspace.registerSource([series]);
    await Promise.all([workspace.assignSeries(lease, 'archive', { slot: 0 }), workspace.assignSeries(lease, 'archive', { slot: 1, index: 1 })]);
    assert.equal(maximum, 1); workspace.dispose();
});

test('aggregate samples and shared LUT buffers count once, while scope disposal cannot clear other sessions', async () => {
    const table = new Uint16Array([0, 64, 128, 255]);
    const first = source('a', [frame(0, { voiLut: { entries: table } })]);
    const second = source('b', [frame(1, { voiLut: { entries: table } })]);
    const workspace = new WorkspaceModel({ layout: 2, cacheBudget: 32 });
    const a = workspace.registerSource([first]), b = workspace.registerSource([second]);
    await workspace.assignSeries(a, 'a', { slot: 0 }); await workspace.assignSeries(b, 'b', { slot: 1 });
    assert.equal(workspace.cache.bytes, 24);
    assert.equal(first._session.cache.bytes + second._session.cache.bytes, 24);
    workspace.releaseSource(a); workspace.slots[0].clear();
    assert.equal(workspace.cache.bytes, 16); assert.equal(second._session.cache.bytes, 16);
    assert.deepEqual([...(await workspace.slots[1].requestFrame(0)).samples], [1, 2, 3, 4]);
    workspace.dispose();
});

test('displayed buffers are admitted against the aggregate budget, even after cache eviction', async () => {
    const workspace = new WorkspaceModel({ layout: 2, cacheBudget: 8 }), a = source('a'), b = source('b');
    await workspace.assignSeries([a], 'a');
    await assert.rejects(workspace.assignSeries([b], 'b', { slot: 1 }), /decoded byte budget/);
    assert.equal(workspace.slots[0].frame.samples.byteLength, 8); assert.equal(workspace.slots[1].frame, null);
    workspace.dispose();
});

test('source cache migration preserves cached frames and rejects a second workspace borrowing the same session', async () => {
    const series = source('migrated'), initial = await series.getFrame(0);
    const workspace = new WorkspaceModel(); workspace.registerSource([series]);
    assert.equal(await workspace.assignSeries([series], 'migrated'), initial);
    const other = new WorkspaceModel(); assert.throws(() => other.registerSource([series]), /another workspace/);
    other.dispose(); workspace.dispose();
});

test('nearest plane requires exact reference family, parallel geometry, tolerance and a unique match', () => {
    const origin = frame(0);
    assert.deepEqual(frameWorldCenter(origin), [0.5, 0.5, 0]);
    assert.deepEqual(nearestSyncedSlice(origin, [frame(3), frame(0)], 1), { matched: true, index: 1, distanceMm: 0 });
    assert.equal(nearestSyncedSlice(origin, [frame(2)], 1).reason, 'outside-slice-tolerance');
    assert.equal(nearestSyncedSlice(origin, [frame(0), frame(0)], 1).reason, 'ambiguous-nearest-slice');
    assert.equal(nearestSyncedSlice(origin, [frame(0, { frameOfReferenceUid: '2.25.901' })]).reason, 'frame-of-reference-mismatch');
    assert.equal(nearestSyncedSlice(origin, [frame(0, { orientation: [1, 0, 0, 0, 0, 1] })]).reason, 'nonparallel-planes');
    assert.equal(nearestSyncedSlice(origin, [frame(0, { frameOfReferenceUid: null })]).reason, 'missing-patient-geometry');
    assert.equal(nearestSyncedSlice(frame(0, { dimensions: { temporalPositionIndex: 1 } }), [frame(0, { dimensions: { temporalPositionIndex: 2 } })]).reason, 'temporal-or-echo-family-mismatch');
    assert.equal(nearestSyncedSlice(frame(0, { dimensions: { indices: [{ known: false }] } }), [origin]).matched, false);
});

test('window and patient camera synchronization reject differing semantics and convert physical field-of-view coordinates', () => {
    const first = frame(), second = frame(0, { rows: 4, columns: 4, pixelSpacing: [0.5, 0.5] });
    assert.equal(compatibleWindow(first, second), true);
    assert.equal(compatibleWindow(first, frame(0, { unit: '' })), false);
    assert.equal(compatibleWindow(first, frame(0, { slope: 2 })), false);
    assert.equal(compatibleWindow(first, frame(0, { photometric: 'RGB' })), false);
    assert.equal(compatibleWindow(frame(0, { modality: 'CT', unit: '' }), frame(0, { modality: 'MR', unit: '' })), false);
    assert.equal(compatibleWindow(frame(0, { modality: 'MR', unit: '', seriesUid: '2.25.8' }), frame(0, { modality: 'MR', unit: '', seriesUid: '2.25.8' })), true);
    assert.equal(compatibleWindow(frame(0, { modality: 'MR', unit: '', seriesUid: '2.25.8' }), frame(0, { modality: 'MR', unit: '', seriesUid: '2.25.9' })), false);
    const camera = { center: [0.5, 0.5, 0], pixelsPerMm: 12 };
    assert.deepEqual(patientCamera(first, second, camera), { matched: true, camera });
    assert.equal(patientCamera(first, second, { center: [100, 100, 0], pixelsPerMm: 12 }).reason, 'outside-field-of-view');
});

test('sync returns clear unmatched results and snapshots are detached, with callback errors isolated', async () => {
    const workspace = new WorkspaceModel({ layout: 2, onEvent() { throw new Error('Host callback failure'); } });
    await workspace.assignSeries([source('a')], 'a', { slot: 0 });
    await workspace.assignSeries([source('b', [frame(0, { frameOfReferenceUid: '2.25.901' })])], 'b', { slot: 1 });
    const result = await workspace.synchronize(0, { slice: true });
    assert.equal(result[0].reason, 'frame-of-reference-mismatch');
    const snapshot = workspace.snapshot(); snapshot.slots[0].frameIndex = 999;
    assert.equal(workspace.snapshot().slots[0].frameIndex, 0); workspace.dispose();
    assert.equal(workspace.snapshot().decodedBytes, 0);
});

test('partial linking preserves the committed slice when presentation semantics cannot link', async () => {
    const workspace = new WorkspaceModel({ layout: 2 });
    const a = source('slice-a', [frame(0), frame(2)]), b = source('slice-b', [frame(0, { unit: 'OTHER' }), frame(2, { unit: 'OTHER' })]);
    await workspace.assignSeries([a], a.id, { index: 1 }); await workspace.assignSeries([b], b.id, { slot: 1 });
    workspace.slots[0].window = { center: 10, width: 20 };
    const commits = [];
    const [result] = await workspace.synchronize(0, { slice: true, window: true, onFrame: (slot, value, index) => commits.push([slot, value.frameIndex, index]) });
    assert.deepEqual(result, { slot: 1, matched: false, index: 1, reason: 'presentation-semantics-mismatch' });
    assert.deepEqual(commits, [[1, 2, 1]]); assert.equal(workspace.slots[1].frameIndex, 1); workspace.dispose();
});

test('renderer rejection cannot publish a failed decoded frame or retain its cache entry', async () => {
    const workspace = new WorkspaceModel(), series = source('render');
    const first = await workspace.assignSeries([series], series.id);
    await assert.rejects(workspace.slots[0].requestFrame(1, { onFrame() { throw new Error('Synthetic renderer validation failure.'); } }), /renderer validation/);
    assert.equal(workspace.slots[0].frame, first); assert.equal(workspace.slots[0].frameIndex, 0);
    assert.equal(workspace.cache.bytes, first.samples.byteLength); workspace.dispose();
});

test('source synchronization cancellation prevents a late target commit and leaves prior presentation intact', async () => {
    let finish;
    const workspace = new WorkspaceModel({ layout: 2 }), a = source('sync-a', [frame(0), frame(2)]);
    const b = source('sync-b', [frame(0), frame(2)], index => index ? new Promise(resolve => finish = () => resolve(frame(2))) : frame(0));
    await workspace.assignSeries([a], a.id, { index: 1 }); const previous = await workspace.assignSeries([b], b.id, { slot: 1 });
    const controller = new AbortController(), commits = [];
    const pending = workspace.synchronize(0, { slice: true, signal: controller.signal, onFrame: value => commits.push(value) });
    const rejected = assert.rejects(pending, { name: 'AbortError' }); await turn(); controller.abort(); await rejected;
    finish(); await turn(); assert.equal(workspace.slots[1].frame, previous); assert.deepEqual(commits, []); workspace.dispose();
});

test('rollback-held buffers remain in the aggregate snapshot and constrain new admissions', async () => {
    const workspace = new WorkspaceModel({ cacheBudget: 8 }), series = source('hold');
    workspace.heldFrames = [frame(9)]; assert.equal(workspace.snapshot().decodedBytes, 8);
    await assert.rejects(workspace.assignSeries([series], series.id), /decoded byte budget/);
    workspace.heldFrames = []; await workspace.slots[0].requestFrame(0); assert.equal(workspace.snapshot().decodedBytes, 8); workspace.dispose();
});

test('built-in CT and MR have distinct stable references and matching CT panes link without changing generic fixtures', async () => {
    const ct = await loadDemo('ct'), mr = await loadDemo('mr'), workspace = new WorkspaceModel({ layout: 2 });
    const bytes = createDicomFixture(), generic = await loadFiles([{ size: bytes.length, stream: () => new Blob([bytes]).stream() }]);
    try {
        const ctReference = ct[0].frames[0].frameOfReferenceUid, mrReference = mr[0].frames[0].frameOfReferenceUid;
        assert.ok(ctReference); assert.ok(mrReference); assert.notEqual(ctReference, mrReference);
        assert.ok(ct[0].frames.every(frame => frame.frameOfReferenceUid === ctReference));
        assert.ok(mr[0].frames.every(frame => frame.frameOfReferenceUid === mrReference));
        assert.equal(generic[0].frames[0].frameOfReferenceUid, null);
        const lease = workspace.registerSource(ct);
        await workspace.assignSeries(lease, ct[0].id, { index: 7 }); await workspace.assignSeries(lease, ct[0].id, { slot: 1 });
        const [result] = await workspace.synchronize(0, { slice: true, window: true });
        assert.equal(result.matched, true); assert.equal(workspace.slots[1].frameIndex, 7);
        assert.equal(nearestSyncedSlice(ct[0].frames[7], mr[0].frames).reason, 'frame-of-reference-mismatch');
    } finally { workspace.dispose(); mr.forEach(series => series.dispose()); generic.forEach(series => series.dispose()); }
});
