import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeDecoder } from '../src/runtime/native-decoder.js';
import { ScopedDecoder } from '../src/runtime/scoped-decoder.js';
import { WorkspaceModel } from '../src/runtime/workspace.js';
import { loadFiles } from '../src/data/sources.js';
import { createDicomFixture } from '../src/data/synthetic.js';
import { createCompressedDicom } from './compressed-fixtures.js';
import { decodeFrame } from '../src/data/compressed.js';

const metadata = { rows: 2, columns: 2, bitsAllocated: 16, bitsStored: 16, highBit: 15, signed: true, littleEndian: true,
    slope: 1, intercept: 0, photometric: 'MONOCHROME2', samplesPerPixel: 1, transferSyntax: '1.2.840.10008.1.2.1' };
const bytes = values => { const result = new Uint8Array(values.length * 2), view = new DataView(result.buffer); values.forEach((value, index) => view.setInt16(index * 2, value, true)); return result; };
const file = value => ({ size: value.length, stream: () => new Blob([value]).stream() });
const turn = () => new Promise(resolve => setTimeout(resolve, 0));
function workers({ automatic = false } = {}) {
    const list = []; let alive = 0, maximum = 0;
    class Worker {
        constructor() { this.closed = false; this.messages = []; alive++; maximum = Math.max(maximum, alive); list.push(this); }
        postMessage(message) { this.messages.push(message); if (automatic) queueMicrotask(() => this.complete(message)); }
        async complete(message = this.messages.at(-1)) {
            const result = await decodeFrame(new Uint8Array(message.bytes), message.metadata);
            if (!this.closed) this.onmessage?.({ data: { id: message.id, ...result } });
        }
        terminate() { if (!this.closed) { this.closed = true; alive--; } }
    }
    return { Worker, list, get alive() { return alive; }, get maximum() { return maximum; } };
}

test('disposing a queued scope cancels only its jobs and leaves another active source worker alive', async () => {
    const old = globalThis.Worker, fake = workers(); globalThis.Worker = fake.Worker;
    const decoder = new NativeDecoder(), first = new ScopedDecoder(decoder), second = new ScopedDecoder(decoder);
    try {
        const a = first.decode(bytes([1, -1, 2, -2]), metadata), b = second.decode(bytes([3, 4, 5, 6]), metadata);
        const rejected = assert.rejects(b, { name: 'AbortError' }); assert.equal(decoder.queue.length, 1);
        second.dispose(); await rejected; assert.equal(fake.alive, 1); assert.equal(fake.list.length, 1);
        await fake.list[0].complete(); assert.deepEqual([...(await a).samples], [1, -1, 2, -2]);
        assert.equal(first.disposed, false); assert.equal(first.worker, fake.list[0]);
    } finally { first.dispose(); second.dispose(); decoder.dispose(); globalThis.Worker = old; }
    assert.equal(fake.alive, 0);
});

test('worker compatibility warnings survive the decoder boundary without sharing mutable worker arrays', async () => {
    const old = globalThis.Worker, fake = workers(); globalThis.Worker = fake.Worker;
    const decoder = new NativeDecoder();
    try {
        const pending = decoder.decode(bytes([1, 2, 3, 4]), metadata);
        const message = fake.list[0].messages[0], warnings = ['Synthetic compatibility warning'];
        fake.list[0].onmessage({ data: { id: message.id, samples: new Int16Array([1, 2, 3, 4]),
            range: { min: 1, max: 4 }, encodingWarnings: warnings } });
        const frame = await pending;
        assert.deepEqual(frame.encodingWarnings, ['Synthetic compatibility warning']);
        warnings[0] = 'Changed after delivery';
        assert.deepEqual(frame.encodingWarnings, ['Synthetic compatibility warning']);
        assert.deepEqual([...frame.samples], [1, 2, 3, 4]);
    } finally { decoder.dispose(); globalThis.Worker = old; }
    assert.equal(fake.alive, 0);
});

test('disposing an active scope terminates its worker and the queued other scope resumes with at most one live worker', async () => {
    const old = globalThis.Worker, fake = workers(); globalThis.Worker = fake.Worker;
    const decoder = new NativeDecoder(), first = new ScopedDecoder(decoder), second = new ScopedDecoder(decoder);
    try {
        const a = first.decode(bytes([1, 2, 3, 4]), metadata), b = second.decode(bytes([5, 6, 7, 8]), metadata);
        const rejected = assert.rejects(a, { name: 'AbortError' }); first.dispose(); await rejected;
        assert.equal(fake.list[0].closed, true); assert.equal(fake.alive, 1); assert.equal(fake.maximum, 1);
        await fake.list[1].complete(); assert.deepEqual([...(await b).samples], [5, 6, 7, 8]);
        assert.equal(second.disposed, false); assert.equal(decoder.disposed, false);
        await assert.rejects(first.decode(bytes([1, 2, 3, 4]), metadata), /disposed/);
    } finally { first.dispose(); second.dispose(); decoder.dispose(); globalThis.Worker = old; }
    assert.equal(fake.alive, 0);
});

test('two real EASI source sessions reuse one worker for native/WASM frames and borrowed sources regain independent lazy decoders', async () => {
    const old = globalThis.Worker, fake = workers({ automatic: true }); globalThis.Worker = fake.Worker;
    const raw = createDicomFixture({ rows: 2, columns: 2, signed: true, values: [1, -1, 2, -2] });
    const compressed = await createCompressedDicom({ codec: 'jpeg-ls', rows: 2, columns: 2, signed: true, bitsAllocated: 16, bitsStored: 12,
        frameSamples: [[-100, -1, 0, 100]], sopUid: '2.25.899.1', seriesUid: '2.25.899' });
    const a = await loadFiles([file(raw)]), b = await loadFiles([file(compressed.bytes)]), workspace = new WorkspaceModel({ layout: 2 });
    try {
        const priorA = a[0]._session.decoder, priorB = b[0]._session.decoder;
        const leaseA = workspace.registerSource(a, { owned: false }), leaseB = workspace.registerSource(b, { owned: false });
        assert.equal(priorA.disposed, true); assert.equal(priorB.disposed, true);
        await workspace.assignSeries(leaseA, a[0].id); await workspace.assignSeries(leaseB, b[0].id, { slot: 1 });
        assert.equal(fake.list.length, 1); assert.equal(fake.alive, 1); assert.equal(workspace.snapshot().workerCount, 1);
        assert.equal(a[0]._session.decoder.worker, b[0]._session.decoder.worker);
        assert.deepEqual([...workspace.slots[0].frame.samples], [1, -1, 2, -2]);
        assert.deepEqual([...workspace.slots[1].frame.samples], [-100, -1, 0, 100]);
        const messages = fake.list[0].messages.length; await workspace.slots[1].requestFrame(0); assert.equal(fake.list[0].messages.length, messages);
        workspace.releaseSource(leaseA); workspace.slots[0].clear();
        assert.equal(a[0]._session.decoder instanceof NativeDecoder, true); assert.equal(a[0]._session.decoder.worker, null);
        assert.equal(fake.alive, 1); assert.equal(b[0]._session.decoder.disposed, false);
        workspace.dispose(); assert.equal(fake.alive, 0); assert.equal(workspace.snapshot().workerCount, 0);
        assert.equal(b[0]._session.decoder instanceof NativeDecoder, true); assert.equal(b[0]._session.decoder.worker, null);
        assert.deepEqual([...(await b[0].getFrame(0)).samples], [-100, -1, 0, 100]); assert.equal(fake.alive, 1);
    } finally { workspace.dispose(); [...a, ...b].forEach(source => source.dispose()); globalThis.Worker = old; }
    assert.equal(fake.alive, 0);
});

test('registration refuses an active standalone decode before cache ownership changes and rejects cross-workspace decoder reuse', async () => {
    const old = globalThis.Worker, fake = workers(); globalThis.Worker = fake.Worker;
    const sources = await loadFiles([file(createDicomFixture())]), workspace = new WorkspaceModel(), other = new WorkspaceModel();
    try {
        const original = sources[0]._session.cache, pending = sources[0].getFrame(0); await turn();
        assert.throws(() => workspace.registerSource(sources), /active source decode/); assert.equal(sources[0]._session.cache, original);
        await fake.list[0].complete(); await pending;
        workspace.registerSource(sources); assert.equal(fake.alive, 0);
        assert.throws(() => other.registerSource(sources), /another workspace/);
    } finally { workspace.dispose(); other.dispose(); sources.forEach(source => source.dispose()); globalThis.Worker = old; }
});
