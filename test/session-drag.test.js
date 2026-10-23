import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionDragRegistry, SESSION_ITEM_TYPE } from '../src/integration/SessionDragRegistry.js';
const transfer = () => {
    const values = new Map();
    return { get types() { return [...values.keys()]; }, clearData() { values.clear(); },
        setData(key, value) { values.set(key, value); }, getData(key) { return values.get(key) ?? ''; } };
};
test('session dragging carries only a one-use random token and retains opaque references privately', () => {
    const owner = new SessionDragRegistry(), data = transfer();
    owner.begin(data, { seriesId: 'session-series-7', instanceId: 'local-instance-9' });
    assert.deepEqual(data.types, [SESSION_ITEM_TYPE]); assert.match(data.getData(SESSION_ITEM_TYPE), /^[0-9a-f-]{36}$/u);
    assert.doesNotMatch(data.getData(SESSION_ITEM_TYPE), /session|local|instance|series/);
    assert.equal(data.effectAllowed, 'copy'); assert.equal(owner.accepts(data), true);
    assert.deepEqual(owner.consume(data), { seriesId: 'session-series-7', instanceId: 'local-instance-9', stackIndex: 0, frameIndex: 0 });
    assert.equal(owner.consume(data), null);
});
test('cross-viewer, stale and forged drag payloads cannot resolve an image', () => {
    const a = new SessionDragRegistry(), b = new SessionDragRegistry(), data = transfer();
    a.begin(data, { seriesId: 'session-series-1' }); assert.equal(b.consume(data), null);
    const old = transfer(); old.setData(SESSION_ITEM_TYPE, data.getData(SESSION_ITEM_TYPE));
    a.begin(data, { seriesId: 'session-series-2' }); assert.equal(a.consume(old), null);
    a.clear(); assert.equal(a.consume(data), null);
    const forged = transfer(); forged.setData(SESSION_ITEM_TYPE, 'session-series-1'); assert.equal(a.consume(forged), null);
});
test('invalid drags fail before writing a transferable payload', () => {
    const owner = new SessionDragRegistry();
    for (const reference of [{}, {seriesId: 'x', frameIndex: -1}, {seriesId: 'x', stackIndex: Infinity}, {seriesId: 'x', instanceId: {}}]) {
        const data = transfer(); assert.throws(() => owner.begin(data, reference), /Drag/); assert.deepEqual(data.types, []);
    }
});
