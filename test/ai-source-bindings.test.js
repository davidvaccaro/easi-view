import test from 'node:test';
import assert from 'node:assert/strict';
import { AiSourceBindings } from '../src/ai/AiSourceBindings.js';
import { WorkspaceModel } from '../src/runtime/workspace.js';
import { FrameCache } from '../src/runtime/frame-cache.js';

test('AI frame binding retains an opaque stable ordinal across insertion and sorting', () => {
    const a = { id: 'private-instance-A/0', samples: new Uint16Array([1]) }, b = { id: 'private-instance-B/0' };
    const series = { frames: [a, b] }, bindings = new AiSourceBindings();
    const captured = bindings.bind(series, b);
    assert.deepEqual(captured, { key: 'source-1', index: 0 });
    assert.ok(!JSON.stringify(captured).includes('private-instance'));
    assert.deepEqual(bindings.resolve(captured, [series]), { series, index: 1 });
    series.frames.unshift({ id: 'new-before-A/0' });
    assert.deepEqual(bindings.resolve(captured, [series]), { series, index: 2 });
    series.frames.reverse();
    assert.deepEqual(bindings.resolve(captured, [series]), { series, index: 0 });
    assert.deepEqual(bindings.bind(series, b), captured);
    assert.deepEqual(bindings.bind(series, a), { key: 'source-1', index: 1 });
});

test('replacing descriptors with the same immutable IDs preserves binding; changing ID at the old offset never retargets', () => {
    const series = { frames: [{ id: 'A' }, { id: 'B' }] }, bindings = new AiSourceBindings();
    const captured = bindings.bind(series, series.frames[1]);
    series.frames = [{ id: 'B', newDescriptor: true }, { id: 'C' }];
    assert.deepEqual(bindings.resolve(captured, [series]), { series, index: 0 });
    series.frames[0] = { id: 'C' };
    assert.equal(bindings.resolve(captured, [series]), null);
});

test('removed, disposed and absent sources cannot resolve or silently select another frame', () => {
    const series = { frames: [{ id: 'A' }, { id: 'B' }] }, other = { frames: [{ id: 'B' }] }, bindings = new AiSourceBindings();
    const captured = bindings.bind(series, series.frames[1]);
    assert.equal(bindings.resolve(captured, [other]), null);
    assert.equal(bindings.resolve(captured, []), null);
    series.frames.pop(); assert.equal(bindings.resolve(captured, [series]), null);
    series.frames.push({ id: 'B' }); assert.deepEqual(bindings.resolve(captured, [series]), { series, index: 1 });
    series.disposed = true; assert.equal(bindings.resolve(captured, [series]), null);
    assert.equal(bindings.bind(series, series.frames[1]), null); assert.equal(bindings.key(series), null);
});

test('series with identical frame IDs remain isolated and supplied source lists are not retained', () => {
    const one = { frames: [{ id: 'A' }] }, two = { frames: [{ id: 'A' }] }, bindings = new AiSourceBindings();
    const a = bindings.bind(one, one.frames[0]), b = bindings.bind(two, two.frames[0]);
    assert.notEqual(a.key, b.key); assert.equal(a.index, b.index);
    assert.deepEqual(bindings.resolve(a, [two, one, one]), { series: one, index: 0 });
    assert.deepEqual(bindings.resolve(b, [one, two]), { series: two, index: 0 });
    assert.equal(bindings.resolve(a, [two]), null);
});

test('ambiguous duplicate IDs and missing/nonprimitive IDs fail closed', () => {
    const bindings = new AiSourceBindings(), series = { frames: [{ id: 'A' }, { id: 'B' }] };
    const captured = bindings.bind(series, series.frames[0]);
    series.frames.push({ id: 'A' });
    assert.equal(bindings.bind(series, series.frames[0]), null); assert.equal(bindings.resolve(captured, [series]), null);
    for (const id of [undefined, null, '', {}, [], () => {}, NaN, Infinity]) {
        const invalid = { frames: [{ id }] }; assert.equal(bindings.bind(invalid, invalid.frames[0]), null);
    }
    assert.equal(bindings.bind(null, {}), null); assert.equal(bindings.bind({ frames: [] }, { id: 'absent' }), null);
});

test('reset and disposal invalidate previous keys without reusing them', () => {
    const bindings = new AiSourceBindings(), series = { frames: [{ id: 0 }] };
    const first = bindings.bind(series, series.frames[0]); bindings.reset();
    assert.equal(bindings.resolve(first, [series]), null);
    const next = bindings.bind(series, series.frames[0]); assert.notEqual(next.key, first.key);
    bindings.dispose(); assert.equal(bindings.resolve(next, [series]), null);
    assert.notEqual(bindings.key(series), next.key);
});

test('invalid/forged ordinals never become array offsets', () => {
    const bindings = new AiSourceBindings(), series = { frames: [{ id: 'A' }, { id: 'B' }] };
    const capture = bindings.bind(series, series.frames[1]);
    for (const source of [null, { key: capture.key, index: -1 }, { key: capture.key, index: 1 }, { key: capture.key, index: NaN },
        { key: capture.key, index: '0' }, { key: 'unknown', index: 0 }]) assert.equal(bindings.resolve(source, [series]), null);
    assert.equal(bindings.resolve(capture, null), null);
});

test('pre-render identity checks require the exact original series and unique bound decoded frame', () => {
    const bindings = new AiSourceBindings(), series = { frames: [{ id: 'A' }, { id: 'B' }] }, other = { frames: [{ id: 'B' }] };
    const captured = bindings.bind(series, series.frames[1]);
    assert.equal(bindings.matches(captured, [series], series, { id: 'B' }), true);
    assert.equal(bindings.matches(captured, [series], series, { id: 'A' }), false);
    assert.equal(bindings.matches(captured, [series, other], other, { id: 'B' }), false);
    series.frames.reverse();
    assert.equal(bindings.matches(captured, [series], series, { id: 'B' }), true);
    series.frames.push({ id: 'B' });
    assert.equal(bindings.matches(captured, [series], series, { id: 'B' }), false);
    assert.equal(bindings.matches(captured, [], series, { id: 'B' }), false);
});

test('queued evidence decode cannot retarget after frame sorting; pre-render guard preserves the previous image', async () => {
    const frame = id => ({ id, rows: 1, columns: 1, samples: new Uint16Array([id === 'A' ? 1 : 2]) });
    const a = frame('A'), b = frame('B'), workspace = new WorkspaceModel(), bindings = new AiSourceBindings();
    const series = { id: 'generated', frames: [a, b], _session: { cache: new FrameCache(1024) },
        async getFrame(index) { return this.frames[index]; }, dispose() { this.disposed = true; } };
    const lease = workspace.registerSource([series]);
    let unblock;
    try {
        await workspace.slots[0].assignSeries(lease, series.id, { index: 0 });
        const captured = bindings.bind(series, b), resolved = bindings.resolve(captured, [series]);
        const blocker = workspace.request({ async getFrame() { return new Promise(resolve => { unblock = () => resolve(a); }); } }, 0, new AbortController().signal);
        // Let the blocker enter getFrame so the evidence job must remain queued.
        while (!unblock) await Promise.resolve();
        let rendered = a, renderCalls = 0;
        const evidence = workspace.slots[0].requestFrame(resolved.index, { onFrame(decoded) {
            if (!bindings.matches(captured, [series], series, decoded)) throw new Error('Captured AI evidence changed before display.');
            rendered = decoded; renderCalls++;
        } });
        series.frames.reverse();
        assert.equal(bindings.resolve(captured, [series]).index, 0);
        unblock(); await blocker;
        await assert.rejects(evidence, /evidence changed before display/);
        assert.equal(renderCalls, 0); assert.equal(rendered, a); assert.equal(workspace.slots[0].frame, a);
        assert.equal(workspace.slots[0].frame.id, 'A');
    } finally { unblock?.(); workspace.dispose(); }
});
