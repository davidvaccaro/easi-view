import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceModel } from '../src/runtime/workspace.js';
import { FrameCache } from '../src/runtime/frame-cache.js';
import { loadFiles } from '../src/data/sources.js';
import { createDicomFixture } from '../src/data/synthetic.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const aborted = () => new DOMException('Synthetic operation canceled.', 'AbortError');
function source({ delay = 0, fail = false } = {}) {
    const cache = new FrameCache(1024), requests = [], completions = [];
    const frames = Array.from({ length: 5 }, (_, frameIndex) => ({ id: `synthetic-${frameIndex}`, frameIndex, rows: 2, columns: 2,
        samples: new Uint16Array([frameIndex, 1, 2, 3]), photometric: 'MONOCHROME2' }));
    const session = { cache };
    return { id: 'synthetic-stack', frames, _session: session, requests, completions, disposed: false,
        async getFrame(index, { signal }) {
            requests.push(index);
            const cached = session.cache.get(frames[index].id); if (cached) return cached;
            if (index && delay) await new Promise((resolve, reject) => {
                const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); resolve(); };
                const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(aborted()); };
                const timer = setTimeout(finish, delay); signal.addEventListener('abort', cancel, { once: true });
            });
            if (signal.aborted) throw aborted();
            if (index && fail) throw new Error('Synthetic failure includes a private token that must never escape.');
            completions.push(index); session.cache.set(frames[index].id, frames[index]); return frames[index];
        },
        dispose() { this.disposed = true; session.cache.clear(); }
    };
}

test('prefetch is absent by default and explicitly loads at most two adjacent frames without changing pane state', async () => {
    const workspace = new WorkspaceModel(), series = source();
    try {
        await workspace.assignSeries([series], series.id, { index: 2 });
        assert.deepEqual(series.requests, [2]); const frame = workspace.slots[0].frame;
        const result = await workspace.prefetchNeighbors(0, { neighbors: 2, delayMs: 0 });
        assert.deepEqual(result, { requested: 2, completed: 2, canceled: false }); assert.deepEqual(series.requests, [2, 3, 1]);
        assert.equal(workspace.slots[0].frame, frame); assert.equal(workspace.slots[0].frameIndex, 2);
        assert.equal(workspace.snapshot().decodedBytes, 24); assert.equal(workspace.cache.get('source-1|synthetic-3'), series.frames[3]);
    } finally { workspace.dispose(); }
});

test('foreground navigation cancels pending idle prefetch before it starts any extra source request', async () => {
    const workspace = new WorkspaceModel(), series = source();
    try {
        await workspace.assignSeries([series], series.id);
        const pending = workspace.prefetchNeighbors(0, { delayMs: 1000 });
        await workspace.slots[0].requestFrame(4);
        assert.deepEqual(await pending, { requested: 1, completed: 0, canceled: true }); assert.deepEqual(series.requests, [0, 4]);
    } finally { workspace.dispose(); }
});

test('foreground requests preempt active background reads while preserving the shared broker and neighboring pane', async () => {
    const workspace = new WorkspaceModel({ layout: 2 }), series = source({ delay: 30 });
    try {
        const lease = workspace.registerSource([series]); await workspace.assignSeries(lease, series.id); await workspace.assignSeries(lease, series.id, { slot: 1 });
        const pending = workspace.prefetchNeighbors(0, { delayMs: 0 });
        while (!series.requests.includes(1)) await tick();
        await workspace.slots[1].requestFrame(4);
        assert.equal((await pending).canceled, true); assert.deepEqual(series.completions, [0, 4]);
        assert.equal(workspace.slots[0].frameIndex, 0); assert.equal(workspace.slots[1].frameIndex, 4);
    } finally { workspace.dispose(); }
});

test('an explicit new prefetch cancels older delayed work and cannot accumulate background queues', async () => {
    const workspace = new WorkspaceModel(), series = source();
    try {
        await workspace.assignSeries([series], series.id, { index: 2 });
        const first = workspace.prefetchNeighbors(0, { delayMs: 1000 });
        const second = workspace.prefetchNeighbors(0, { delayMs: 0, neighbors: 1 });
        assert.equal((await first).canceled, true); assert.deepEqual(await second, { requested: 1, completed: 1, canceled: false });
        assert.deepEqual(series.requests, [2, 3]); assert.equal(workspace.queue.length, 0);
    } finally { workspace.dispose(); }
});

test('prefetch cannot displace displayed buffers or rollback-held buffers over the aggregate decoded budget', async () => {
    const workspace = new WorkspaceModel({ cacheBudget: 8 }), series = source();
    try {
        await workspace.assignSeries([series], series.id);
        await assert.rejects(workspace.prefetchNeighbors(0, { delayMs: 0 }), /workspace profile or budget/);
        assert.equal(workspace.slots[0].frame, series.frames[0]); assert.equal(workspace.snapshot().decodedBytes, 8);
        assert.equal(workspace.cache.get('source-1|synthetic-1'), null);
    } finally { workspace.dispose(); }
});

test('layout, host cancellation, registration release and disposal cancel scheduled prefetch without leaking timers', async () => {
    for (const mode of ['layout', 'signal', 'release', 'dispose']) {
        const workspace = new WorkspaceModel(), series = source(), lease = workspace.registerSource([series]);
        await workspace.assignSeries(lease, series.id);
        const controller = new AbortController(), pending = workspace.prefetchNeighbors(0, { delayMs: 1000, signal: controller.signal });
        if (mode === 'layout') workspace.setLayout(2);
        if (mode === 'signal') controller.abort();
        if (mode === 'release') workspace.releaseSource(lease);
        if (mode === 'dispose') workspace.dispose();
        assert.equal((await pending).canceled, true); assert.deepEqual(series.requests, [0]); workspace.dispose();
    }
});

test('prefetch options fail before source requests and background error messages contain no input context', async () => {
    const workspace = new WorkspaceModel(), series = source({ fail: true });
    await assert.rejects(workspace.prefetchNeighbors(), /displayed pane/);
    await workspace.assignSeries([series], series.id);
    for (const options of [{ neighbors: 3 }, { neighbors: 0 }, { delayMs: -1 }, { delayMs: Infinity }, { delayMs: 10001 }, { signal: {} }, { onMeasure: 'invalid' }]) {
        await assert.rejects(workspace.prefetchNeighbors(0, options), TypeError);
    }
    assert.deepEqual(series.requests, [0]);
    await assert.rejects(workspace.prefetchNeighbors(0, { delayMs: 0 }), error => !/private|token|synthetic-stack/.test(error.message));
    workspace.dispose(); await assert.rejects(workspace.prefetchNeighbors(), /disposed/);
});

test('actual EASI source prefetch reuses native stored samples and supplies a later foreground decoded cache hit', async () => {
    const measurements = [];
    const files = Array.from({ length: 3 }, (_, index) => {
        const bytes = createDicomFixture({ rows: 2, columns: 2, signed: true, values: [index * 10, -1, 2, 3], sopUid: `2.25.800.${index + 1}`, position: [0, 0, index] });
        return { size: bytes.length, stream: () => new Blob([bytes]).stream() };
    });
    const foreground = [];
    const series = await loadFiles(files, { onMeasure: event => foreground.push(event) }), workspace = new WorkspaceModel({ cacheBudget: 32 });
    try {
        const lease = workspace.registerSource(series); await workspace.assignSeries(lease, series[0].id);
        foreground.length = 0;
        await workspace.prefetchNeighbors(0, { delayMs: 0 });
        assert.equal(foreground.length, 0, 'Background preparation must not overwrite foreground observations.');
        const decoded = await workspace.slots[0].requestFrame(1, { onMeasure: event => measurements.push(event) });
        assert.deepEqual([...decoded.samples], [10, -1, 2, 3]);
        assert.ok(measurements.some(event => event.phase === 'frame' && event.decodedCacheHit));
        assert.ok(workspace.snapshot().decodedBytes <= 32);
    } finally { workspace.dispose(); }
});
