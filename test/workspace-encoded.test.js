import test from 'node:test';
import assert from 'node:assert/strict';
import EASI, { Tag } from '@xinonix/easi-js';
import { WorkspaceModel } from '../src/runtime/workspace.js';
import { EncodedInstanceCache } from '../src/runtime/encoded-cache.js';
import { loadArchiveSeries } from '../src/data/archive-source.js';
import { createCompressedDicom } from './compressed-fixtures.js';
import { createDicomFixture } from '../src/data/synthetic.js';

const study = '2.25.880';
async function archive(number, { compressed = true, delayed = null } = {}) {
    const seriesUid = `${study}.${number}`, sopUid = `${seriesUid}.1`, values = [number, -1, 100, -100];
    const options = { rows: 2, columns: 2, signed: true, bitsAllocated: 16, bitsStored: 12, seriesUid, sopUid,
        extraAttributes: { '0020000D': ['UI', study], '00200052': ['UI', '2.25.889'] } };
    const raw = compressed ? (await createCompressedDicom({ ...options, codec: 'rle', frameSamples: [values] })).bytes : createDicomFixture({ ...options, values });
    const result = await EASI.pipelineBuilder().fromByteStream().ofDicomData().toInstances().build().process({ source: raw });
    const instance = result.toArray()[0]; instance.dataSet.find(Tag.find('7FE00010')).clear();
    let requests = 0;
    const client = { async getSeriesMetadata() { return [instance]; }, async retrieveInstance(_study, _series, _sop, { signal }) {
        requests++; if (delayed) return delayed(raw, signal);
        return new Response(raw, { headers: { 'content-type': 'application/dicom' } });
    } };
    return { sources: await loadArchiveSeries(client, study, seriesUid), values, get requests() { return requests; } };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('two real archive sessions share one encoded budget, transfer indexes safely, and evict one scope without breaking a displayed neighbor', async () => {
    const a = await archive(1), b = await archive(2), first = await a.sources[0].getFrame(0);
    const original = [...a.sources[0]._session.encoded.entries.values()][0];
    const index = original.encapsulated, dispose = index.dispose.bind(index); let releases = 0;
    index.dispose = () => { releases++; dispose(); };
    const workspace = new WorkspaceModel({ layout: 2, cacheBudget: 64, encodedCacheBudget: original.bytes.byteLength + 1 });
    try {
        const leaseA = workspace.registerSource(a.sources, { owned: false });
        assert.equal(releases, 0); assert.equal(original.encapsulated, index);
        await workspace.assignSeries(leaseA, a.sources[0].id);
        assert.equal(workspace.slots[0].frame, first); assert.equal(a.requests, 1);
        const leaseB = workspace.registerSource(b.sources, { owned: false }); await workspace.assignSeries(leaseB, b.sources[0].id, { slot: 1 });
        assert.equal(releases, 1); assert.equal(original.bytes.byteLength, 0); assert.equal(original.encapsulated, null);
        assert.deepEqual([...workspace.slots[0].frame.samples], a.values); assert.deepEqual([...workspace.slots[1].frame.samples], b.values);
        assert.equal(a.sources[0]._session.encoded.bytes, 0); assert.ok(b.sources[0]._session.encoded.bytes > 0);
        assert.equal(workspace.snapshot().encodedCacheBytes, b.sources[0]._session.encoded.bytes);
        assert.ok(workspace.snapshot().encodedCacheBytes <= workspace.encodedCache.budget);
        workspace.releaseSource(leaseA); workspace.slots[0].clear();
        assert.equal(a.sources[0]._session.encoded instanceof EncodedInstanceCache, true);
        assert.equal(a.sources[0]._session.encoded.bytes, 0); assert.equal(releases, 1);
        await workspace.slots[1].requestFrame(0); assert.equal(b.requests, 1);
        workspace.dispose(); assert.equal(workspace.snapshot().encodedCacheBytes, 0);
        assert.equal(b.sources[0]._session.encoded instanceof EncodedInstanceCache, true);
    } finally { workspace.dispose(); [...a.sources, ...b.sources].forEach(source => source.dispose()); }
});

test('archive foreground cancellation leaves the other encoded scope and shared LUT ownership live within aggregate budgets', async () => {
    let started = false, canceled = false, firstResponse = true;
    const a = await archive(3), b = await archive(4, { compressed: false, delayed: (_raw, signal) => {
        if (firstResponse) { firstResponse = false; return new Response(_raw, { headers: { 'content-type': 'application/dicom' } }); }
        return new Promise((_resolve, reject) => {
        started = true; const abort = () => { canceled = true; reject(new DOMException('Synthetic archive canceled.', 'AbortError')); };
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    }); } });
    const workspace = new WorkspaceModel({ layout: 2, cacheBudget: 64, encodedCacheBudget: 200 });
    try {
        const leaseA = workspace.registerSource(a.sources), leaseB = workspace.registerSource(b.sources);
        const frame = await workspace.assignSeries(leaseA, a.sources[0].id);
        const second = await workspace.assignSeries(leaseB, b.sources[0].id, { slot: 1 });
        const shared = new Uint16Array([0, 64, 128, 255]);
        // Independent shared-table ownership reference, rather than duplicated LUT bytes.
        frame.voiLut = { entries: shared }; second.voiLut = { entries: shared };
        workspace.cache.clear(); a.sources[0]._session.cache.set(frame.id, frame); b.sources[0]._session.cache.set(second.id, second);
        assert.equal(workspace.snapshot().decodedBytes, 24);
        b.sources[0]._session.cache.delete(second.id); b.sources[0]._session.encoded.clear();
        const pending = workspace.slots[1].requestFrame(0);
        const rejected = assert.rejects(pending, { name: 'AbortError' }); while (!started) await tick();
        workspace.slots[1].cancel(); await rejected; await tick(); assert.equal(canceled, true);
        assert.equal(b.sources[0]._session.encoded.bytes, 0); assert.equal(workspace.slots[0].frame, frame);
        assert.ok(a.sources[0]._session.encoded.bytes > 0); assert.equal(workspace.snapshot().encodedCacheBytes, a.sources[0]._session.encoded.bytes);
        assert.equal(workspace.snapshot().decodedBytes, 24);
        await workspace.slots[0].requestFrame(0); assert.equal(a.requests, 1);
        workspace.releaseSource(leaseB); workspace.slots[1].clear();
        assert.ok(a.sources[0]._session.encoded.bytes > 0); assert.equal(workspace.snapshot().decodedBytes, 16);
    } finally { workspace.dispose(); }
    assert.equal(workspace.snapshot().encodedCacheBytes, 0); assert.equal(workspace.snapshot().decodedBytes, 0);
});

test('encoded scoped registration rejects a second workspace and preserves exact duplicate ownership until the last lease', async () => {
    const a = await archive(5), first = new WorkspaceModel(), other = new WorkspaceModel();
    try {
        const owned = first.registerSource(a.sources), borrowed = first.registerSource({ series: a.sources }, { owned: false });
        await first.assignSeries(borrowed, a.sources[0].id);
        const retained = first.snapshot().encodedCacheBytes;
        assert.throws(() => other.registerSource(a.sources), /another workspace/);
        first.releaseSource(owned); assert.equal(a.sources[0].disposed, false); assert.equal(first.snapshot().encodedCacheBytes, retained);
        first.releaseSource(borrowed); first.slots[0].clear(); assert.equal(a.sources[0].disposed, true); assert.equal(first.snapshot().encodedCacheBytes, 0);
    } finally { first.dispose(); other.dispose(); }
});
