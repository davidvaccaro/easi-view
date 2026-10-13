import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameCache } from '../src/runtime/frame-cache.js';
import { NativeDecoder } from '../src/runtime/native-decoder.js';
import { decodeNative } from '../src/data/native.js';

test('LRU evicts by decoded bytes and preserves a recently touched frame', () => {
    const cache = new FrameCache(12);
    const frame = id => ({ id, samples: new Int16Array(3) });
    cache.set('a', frame('a'));
    cache.set('b', frame('b'));
    assert.equal(cache.bytes, 12);
    cache.get('a');
    cache.set('c', frame('c'));
    assert.equal(cache.get('b'), null);
    assert.ok(cache.get('a'));
    assert.equal(cache.bytes, 12);
    cache.set('c', { id: 'c', samples: new Uint16Array(2) });
    assert.equal(cache.bytes, 10);
    cache.set('oversize', { samples: new Uint16Array(10) });
    assert.equal(cache.get('oversize'), null);
    assert.equal(cache.bytes, 10);
    cache.clear();
    assert.equal(cache.bytes, 0);
});

test('queued and active CPU decodes cancel, and dispose rejects pending work', async () => {
    const decoder = new NativeDecoder();
    const bytes = new Uint8Array([0, 1]);
    const metadata = { rows: 1, columns: 2, bitsAllocated: 8, bitsStored: 8, highBit: 7, signed: false };
    const firstController = new AbortController();
    const queuedController = new AbortController();
    const first = decoder.decode(bytes, metadata, { signal: firstController.signal });
    const queued = decoder.decode(bytes, metadata, { signal: queuedController.signal });
    const firstRejected = assert.rejects(first, { name: 'AbortError' });
    const queuedRejected = assert.rejects(queued, { name: 'AbortError' });
    queuedController.abort();
    firstController.abort();
    await Promise.all([firstRejected, queuedRejected]);
    const next = decoder.decode(bytes, metadata);
    assert.deepEqual([...(await next).samples], [0, 1]);
    decoder.dispose();
    await assert.rejects(decoder.decode(bytes, metadata), /disposed/);
});

test('worker receives exactly one transferred frame and a whitelisted small metadata record', async () => {
    const previousWorker = globalThis.Worker;
    let captured;
    class FakeWorker {
        constructor() { captured = this; }
        postMessage(message, transfer) { this.message = message; this.transfer = transfer; }
        terminate() { this.terminated = true; }
    }
    globalThis.Worker = FakeWorker;
    try {
        const decoder = new NativeDecoder();
        const retained = new Uint8Array(1024 * 1024);
        retained.set([10, 20], 900);
        const promise = decoder.decode(retained.subarray(900, 902), {
            rows: 1, columns: 2, bitsAllocated: 8, bitsStored: 8, highBit: 7, signed: false,
            _record: { bytes: retained }, hugeUnusedField: retained, orientation: [1, 0, 0, 0, 1, 0]
        });
        assert.equal(captured.message.bytes.byteLength, 2);
        assert.equal(captured.transfer.length, 1);
        assert.equal(captured.transfer[0], captured.message.bytes);
        assert.equal(retained.byteLength, 1024 * 1024);
        assert.equal('_record' in captured.message.metadata, false);
        assert.equal('hugeUnusedField' in captured.message.metadata, false);
        const decoded = decodeNative(new Uint8Array(captured.message.bytes), captured.message.metadata);
        captured.onmessage({ data: { id: captured.message.id, ...decoded } });
        assert.deepEqual([...(await promise).samples], [10, 20]);
        decoder.dispose();
        assert.equal(captured.terminated, true);
    } finally { globalThis.Worker = previousWorker; }
});
