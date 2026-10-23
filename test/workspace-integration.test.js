import test from 'node:test';
import assert from 'node:assert/strict';
import EASI from '@xinonix/easi-js';
import { createDicomFixture } from '../src/data/synthetic.js';
import { loadFiles } from '../src/data/sources.js';
import { loadArchiveSeries } from '../src/data/archive-source.js';
import { WorkspaceModel } from '../src/runtime/workspace.js';
import { createEnhancedDicom, expectedGroups, pixels } from './enhanced-fixtures.js';

const STUDY = '2.25.940', FOR = '2.25.941';
const file = bytes => ({ size: bytes.length, stream: () => new Blob([bytes]).stream() });
function fixture(series, index, options = {}) {
    return createDicomFixture({ rows: 2, columns: 2, signed: true, bitsStored: 12,
        sopUid: `2.25.940.${series}.${index + 1}`, seriesUid: `2.25.940.${series}`,
        position: [0, 0, index * 2], instanceNumber: index + 1,
        values: [index * 100, index * 100 + 1, -1, -100], slope: 1, intercept: 0,
        ...options, extraAttributes: { '0020000D': ['UI', STUDY], '00200052': ['UI', FOR], ...options.extraAttributes } });
}
const load = (series, count = 3, options = {}) => loadFiles(Array.from({ length: count }, (_, index) => file(fixture(series, index, options))));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('real EASI sources share one decoded frame across four panes and retain independent slice positions', async () => {
    const measurements = [], sources = await loadFiles([file(fixture(1, 0)), file(fixture(1, 1))], { onMeasure: event => measurements.push(event) });
    const first = await sources[0].getFrame(0), workspace = new WorkspaceModel({ layout: 4, cacheBudget: 16 });
    try {
        const lease = workspace.registerSource(sources);
        await Promise.all(workspace.slots.map((_, slot) => workspace.assignSeries(lease, sources[0].id, { slot })));
        assert.ok(workspace.slots.every(slot => slot.frame === first));
        assert.equal(workspace.cache.bytes, 8);
        assert.equal(measurements.filter(event => event.phase === 'decode' && event.status === 'success').length, 1);
        await workspace.slots[2].requestFrame(1);
        assert.deepEqual(workspace.snapshot().slots.map(slot => slot.frameIndex), [0, 0, 1, 0]);
        assert.deepEqual([...workspace.slots[2].frame.samples], [100, 101, -1, -100]);
        assert.equal(workspace.cache.bytes, 16);
        assert.equal(measurements.filter(event => event.phase === 'decode' && event.status === 'success').length, 2);
        workspace.releaseSource(lease); workspace.setLayout(2);
        assert.equal(sources[0].disposed, false);
    } finally { workspace.dispose(); }
    assert.equal(sources[0].disposed, true); assert.equal(sources[0].sourceBytes, 0);
    assert.equal(sources[0]._session.decoder.disposed, true);
});

test('two actual source sessions respect one aggregate decoded budget and dispose their cache scopes independently', async () => {
    const a = await load(2, 1), b = await load(3, 1), workspace = new WorkspaceModel({ layout: 2, cacheBudget: 16 });
    const leaseA = workspace.registerSource(a), leaseB = workspace.registerSource(b);
    try {
        await workspace.assignSeries(leaseA, a[0].id, { slot: 0 });
        await workspace.assignSeries(leaseB, b[0].id, { slot: 1 });
        const retainedB = workspace.slots[1].frame;
        assert.equal(workspace.cache.bytes, 16);
        workspace.releaseSource(leaseA); workspace.slots[0].clear();
        assert.equal(a[0].disposed, true); assert.equal(a[0]._session.decoder.disposed, true);
        assert.equal(b[0].disposed, false); assert.equal(workspace.cache.bytes, 8);
        assert.equal(await workspace.slots[1].requestFrame(0), retainedB);
        assert.deepEqual([...retainedB.samples], [0, 1, -1, -100]);
    } finally { workspace.dispose(); }
    assert.equal(workspace.cache.bytes, 0); assert.equal(b[0].disposed, true);
});

test('decoded admission failure preserves the other pane and cannot retain pixels over the shared byte budget', async () => {
    const a = await load(4, 1), b = await load(5, 1), workspace = new WorkspaceModel({ layout: 2, cacheBudget: 8 });
    try {
        await workspace.assignSeries(a, a[0].id, { slot: 0 }); const committed = workspace.slots[0].frame;
        await assert.rejects(workspace.assignSeries(b, b[0].id, { slot: 1 }), /decoded byte budget/);
        assert.equal(workspace.slots[0].frame, committed); assert.equal(workspace.slots[1].frame, null);
        assert.ok(workspace.cache.bytes <= 8);
        assert.deepEqual([...committed.samples], [0, 1, -1, -100]);
    } finally { workspace.dispose(); }
});

test('different SOPs synchronize by patient-plane distance while missing/different references block slice sync', async () => {
    const a = await load(6), b = await loadFiles([file(fixture(7, 0, { position: [0, 0, 0.3] })),
        file(fixture(7, 1, { position: [0, 0, 3.9] })), file(fixture(7, 2, { position: [0, 0, 8] }))]);
    const wrong = await load(8, 1, { extraAttributes: { '00200052': ['UI', '2.25.942'] } });
    const missing = await load(9, 1, { extraAttributes: { '00200052': null } });
    const workspace = new WorkspaceModel({ layout: 4 });
    try {
        for (const [slot, source] of [a, b, wrong, missing].entries()) await workspace.assignSeries(source, source[0].id, { slot });
        await workspace.slots[0].requestFrame(2);
        const results = await workspace.synchronize(0, { slice: true, toleranceMm: 0.5 });
        assert.equal(results[0].matched, true); assert.equal(results[0].index, 1);
        assert.ok(Math.abs(workspace.slots[0].frame.position[2] - workspace.slots[1].frame.position[2] - 0.1) < 1e-12);
        assert.equal(workspace.slots[1].frameIndex, 1);
        assert.equal(workspace.slots[1].frame.sopUid !== workspace.slots[0].frame.sopUid, true);
        assert.equal(results[1].reason, 'frame-of-reference-mismatch');
        assert.equal(results[2].reason, 'missing-patient-geometry');
        assert.deepEqual(workspace.snapshot().slots.map(slot => slot.frameIndex), [2, 1, 0, 0]);
    } finally { workspace.dispose(); }
});

test('enhanced temporal/echo partitions retain their encoded frame indices and shared source bytes across panes', async () => {
    const sources = await loadFiles([file(createEnhancedDicom())]), workspace = new WorkspaceModel({ layout: 4 });
    try {
        const lease = workspace.registerSource(sources), encodedBytes = sources.reduce((sum, series) => sum + series.sourceBytes, 0);
        await Promise.all(sources.map((series, slot) => workspace.assignSeries(lease, series.id, { slot, index: 1 })));
        workspace.slots.forEach((slot, index) => {
            assert.equal(slot.frame.frameIndex, expectedGroups[index][1]);
            assert.deepEqual([...slot.frame.samples], pixels[expectedGroups[index][1]]);
        });
        assert.equal(encodedBytes, 64); assert.equal(workspace.cache.bytes, 32);
        const results = await workspace.synchronize(0, { slice: true });
        assert.ok(results.every(result => !result.matched && result.reason === 'temporal-or-echo-family-mismatch'));
        workspace.releaseSource(lease); workspace.setLayout(1);
        assert.equal(sources[0].disposed, false); assert.equal(sources.reduce((sum, series) => sum + series.sourceBytes, 0), 64);
    } finally { workspace.dispose(); }
    assert.ok(sources.every(series => series.disposed)); assert.equal(sources[0]._session.recordOwners.size, 0);
});

test('canceling one actual lazy archive fetch does not supersede the queued other pane or poison its decoded cache', async () => {
    const entry = (vr, ...Value) => ({ vr, Value });
    const objects = [0, 1].map(index => ({
        '00080016': entry('UI', '1.2.840.10008.5.1.4.1.1.2'), '00080018': entry('UI', `2.25.940.10.${index + 1}`),
        '00080060': entry('CS', 'CT'), '0020000D': entry('UI', STUDY), '0020000E': entry('UI', '2.25.940.10'),
        '00200052': entry('UI', FOR), '00200013': entry('IS', index + 1),
        '00200032': entry('DS', 0, 0, index * 2), '00200037': entry('DS', 1, 0, 0, 0, 1, 0),
        '00280030': entry('DS', 0.75, 0.75), '00280002': entry('US', 1), '00280004': entry('CS', 'MONOCHROME2'),
        '00280010': entry('US', 2), '00280011': entry('US', 2), '00280100': entry('US', 16),
        '00280101': entry('US', 12), '00280102': entry('US', 11), '00280103': entry('US', 1),
        '00281052': entry('DS', 0), '00281053': entry('DS', 1),
        '7FE00010': { vr: 'OW', BulkDataURI: 'https://synthetic.invalid/never-follow' }
    }));
    const instances = (await EASI.pipelineBuilder().fromByteStream().ofDicomMetadata().toInstances().build()
        .process({ source: new TextEncoder().encode(JSON.stringify(objects)) })).toArray();
    const calls = [], aborted = [];
    const client = {
        async getSeriesMetadata() { return instances; },
        async retrieveInstance(_study, _series, sop, { signal }) {
            const index = sop.endsWith('.1') ? 0 : 1; calls.push(index);
            if (index === 0) return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
                aborted.push(index); reject(new DOMException('Synthetic fetch canceled.', 'AbortError'));
            }, { once: true }));
            return new Response(fixture(10, index), { headers: { 'content-type': 'application/dicom' } });
        }
    };
    const sources = await loadArchiveSeries(client, STUDY, '2.25.940.10'), workspace = new WorkspaceModel({ layout: 2 });
    try {
        const pending = workspace.assignSeries(sources, sources[0].id, { slot: 0 });
        const canceled = assert.rejects(pending, { name: 'AbortError' });
        for (let step = 0; step < 100 && !calls.length; step++) await tick();
        assert.deepEqual(calls, [0]);
        const queued = workspace.assignSeries(sources, sources[0].id, { slot: 1, index: 1 });
        workspace.slots[0].cancel(); await canceled;
        const frame = await queued;
        assert.deepEqual(aborted, [0]); assert.deepEqual(calls, [0, 1]);
        assert.equal(workspace.slots[0].frame, null); assert.equal(workspace.slots[1].frameIndex, 1);
        assert.deepEqual([...frame.samples], [100, 101, -1, -100]);
        assert.equal(await workspace.slots[1].requestFrame(1), frame); assert.deepEqual(calls, [0, 1]);
    } finally { workspace.dispose(); }
    assert.equal(sources[0]._session.encoded.bytes, 0); assert.equal(sources[0]._session.decoder.disposed, true);
});

test('independent workspaces keep their EASI source sessions alive when the other viewer is disposed', async () => {
    const a = await load(11, 1), b = await load(12, 1), one = new WorkspaceModel(), two = new WorkspaceModel();
    try {
        await one.assignSeries(a, a[0].id); const frame = await two.assignSeries(b, b[0].id);
        one.dispose(); assert.equal(a[0].disposed, true); assert.equal(b[0].disposed, false);
        assert.equal(await two.slots[0].requestFrame(0), frame); assert.equal(two.cache.bytes, 8);
        assert.equal(one.cache.bytes, 0);
    } finally { one.dispose(); two.dispose(); }
});
