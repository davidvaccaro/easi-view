import test from 'node:test';
import assert from 'node:assert/strict';
import EASI from '@xinonix/easi-js';
import { createDicomFixture } from '../src/data/synthetic.js';
import { loadDemo, loadFiles, loadResponse } from '../src/data/sources.js';
import { loadArchiveSeries } from '../src/data/archive-source.js';

const study = '1.2.826.0.1.3680043.10.543.900.1';
const series = `${study}.1`;
const sop = `${series}.1`;

function fixture() { return createDicomFixture({ sopUid: sop, seriesUid: series, frames: 2,
    values: [1, 2, 3, 4, 11, 12, 13, 14] }); }
function file() { return new File([fixture()], 'generated-performance.dcm', { type: 'application/dicom' }); }
function response() { return new Response(fixture(), { headers: { 'content-type': 'application/dicom' } }); }

async function client(retrieve = () => response()) {
    const attribute = (vr, ...Value) => ({ vr, Value });
    const metadata = {
        '00080016': attribute('UI', '1.2.840.10008.5.1.4.1.1.2'), '00080018': attribute('UI', sop),
        '0020000D': attribute('UI', study), '0020000E': attribute('UI', series),
        '00280002': attribute('US', 1), '00280004': attribute('CS', 'MONOCHROME2'), '00280008': attribute('IS', 2),
        '00280010': attribute('US', 2), '00280011': attribute('US', 2),
        '00280100': attribute('US', 16), '00280101': attribute('US', 16), '00280102': attribute('US', 15), '00280103': attribute('US', 0),
        '00280030': attribute('DS', 0.75, 0.75), '00200032': attribute('DS', 0, 0, 0), '00200037': attribute('DS', 1, 0, 0, 0, 1, 0)
    };
    const instances = (await EASI.pipelineBuilder().fromByteStream().ofDicomMetadata().toInstances().build()
        .process({ source: new TextEncoder().encode(JSON.stringify([metadata])) })).toArray();
    return { async getSeriesMetadata() { return instances; }, retrieveInstance(_study, _series, _sop, options) { return retrieve(options); } };
}

async function until(predicate) {
    for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.ok(predicate(), 'The expected asynchronous source operation did not start.');
}

test('local streaming/pipeline measurements preserve source behavior and later lazy frames retain their observer', async () => {
    const measurements = [];
    const sources = await loadFiles([file()], { onMeasure: event => measurements.push(event) });
    try {
        assert.equal(measurements.filter(event => event.phase === 'pipeline').length, 1);
        assert.equal(measurements.filter(event => event.phase === 'stream').length, 1);
        assert.equal(measurements.find(event => event.phase === 'stream').bytes, fixture().byteLength);
        const first = await sources[0].getFrame(0);
        assert.deepEqual([...first.samples], [1, 2, 3, 4]);
        const cold = measurements.find(event => event.phase === 'frame');
        assert.equal(cold.decodedCacheHit, false); assert.equal(cold.decodedBytes, 8);
        assert.equal(cold.encodedCacheBytes, 16); assert.equal(cold.decodedCacheBytes, 8);
        const count = measurements.length;
        assert.equal(await sources[0].getFrame(0), first);
        assert.equal(measurements.length, count + 1);
        assert.equal(measurements.at(-1).phase, 'frame'); assert.equal(measurements.at(-1).decodedCacheHit, true);
        assert.ok(measurements.every(event => !('uid' in event) && !('url' in event) && event.source === 'files'));
    } finally { sources.forEach(stack => stack.dispose()); }
    assert.equal(sources[0]._session.onMeasure, null);
});

test('frame-specific observers override the source observer without changing cached frame identity', async () => {
    const loading = [], current = [];
    const sources = await loadFiles([file()], { onMeasure: event => loading.push(event) });
    try {
        const count = loading.length;
        const frame = await sources[0].getFrame(0, { onMeasure: event => current.push(event) });
        assert.equal(loading.length, count); assert.deepEqual(current.map(event => event.phase), ['decode', 'frame']);
        assert.equal(await sources[0].getFrame(0, { onMeasure: event => current.push(event) }), frame);
        assert.equal(current.at(-1).decodedCacheHit, true);
    } finally { sources.forEach(stack => stack.dispose()); }
});

test('pipeline wall time includes awaited instance callbacks rather than claiming isolated parsing CPU', async () => {
    const measurements = [];
    let entered = false, release;
    const waiting = new Promise(resolve => { release = resolve; });
    const pending = loadFiles([file()], { onMeasure: event => measurements.push(event), onSeries: async () => {
        entered = true; await waiting;
    } });
    await until(() => entered);
    assert.equal(measurements.some(event => event.phase === 'pipeline'), false);
    await new Promise(resolve => setTimeout(resolve, 12)); release();
    const sources = await pending;
    try {
        assert.ok(measurements.find(event => event.phase === 'pipeline').durationMs >= 10);
        assert.ok(measurements.find(event => event.phase === 'pipeline').durationMs >= measurements.find(event => event.phase === 'stream').durationMs);
    } finally { sources.forEach(stack => stack.dispose()); }
});

test('archive observations distinguish cold requests, encoded reuse and decoded hits with bounded cache counters', async () => {
    const measurements = [];
    const sources = await loadArchiveSeries(await client(), study, series, { onMeasure: event => measurements.push(event) });
    try {
        assert.deepEqual(measurements.map(event => event.phase), ['metadata-index']); // No timed network operation in the fake client.
        await sources[0].getFrame(0);
        const cold = measurements.find(event => event.phase === 'frame');
        assert.equal(cold.encodedCacheHit, false); assert.equal(cold.decodedCacheHit, false);
        assert.equal(cold.encodedCacheBytes, 16); assert.equal(cold.decodedCacheBytes, 8);
        await sources[0].getFrame(1);
        const reuse = measurements.filter(event => event.phase === 'frame').at(-1);
        assert.equal(reuse.encodedCacheHit, true); assert.equal(reuse.decodedCacheHit, false);
        const count = measurements.length;
        await sources[0].getFrame(1);
        assert.equal(measurements.length, count + 1); assert.equal(measurements.at(-1).decodedCacheHit, true);
        assert.ok(measurements.every(event => event.source === 'archive'));
        assert.ok(measurements.every(event => (event.encodedCacheBytes ?? 0) <= 64 * 1024 * 1024));
    } finally { sources.forEach(stack => stack.dispose()); }
    assert.equal(sources[0]._session.onMeasure, null);
});

test('superseding an archive frame records cancellation once and cannot later emit success', async () => {
    const measurements = [];
    let requests = 0;
    const archive = await client(({ signal }) => {
        if (++requests > 1) return response();
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')), { once: true }));
    });
    const sources = await loadArchiveSeries(archive, study, series, { onMeasure: event => measurements.push(event) });
    try {
        const first = sources[0].getFrame(0);
        const rejected = assert.rejects(first, { name: 'AbortError' });
        assert.deepEqual([...(await sources[0].getFrame(1)).samples], [11, 12, 13, 14]);
        await rejected;
        const frames = measurements.filter(event => event.phase === 'frame');
        assert.equal(frames.filter(event => event.status === 'canceled').length, 1);
        assert.equal(frames.filter(event => event.status === 'success').length, 1);
    } finally { sources.forEach(stack => stack.dispose()); }
});

test('archive indexing completes before image callbacks and reports invalid descriptors separately', async () => {
    const measurements = [];
    const sources = await loadArchiveSeries(await client(), study, series, {
        onMeasure: event => measurements.push(event), onSeries: async available => {
            assert.deepEqual(measurements.map(event => [event.phase, event.status]), [['metadata-index', 'success']]);
            await available[0].getFrame(0);
        }
    });
    sources.forEach(stack => stack.dispose());
    const invalid = await client(); invalid.getSeriesMetadata = async () => [];
    const rejected = [];
    await assert.rejects(loadArchiveSeries(invalid, study, series, { onMeasure: event => rejected.push(event) }), /no image metadata/);
    assert.deepEqual(rejected.map(event => [event.phase, event.status]), [['metadata-index', 'error']]);
});

test('stream cancellation publishes no later pipeline/stream success or identifying error details', async () => {
    const measurements = [];
    let reading = false, canceled = false, step = 0;
    const body = new ReadableStream({ pull(controller) {
        if (step++ === 0) controller.enqueue(fixture().subarray(0, 140));
        else { reading = true; return new Promise(() => {}); }
    }, cancel() { canceled = true; } });
    const controller = new AbortController();
    const pending = loadResponse(new Response(body, { headers: { 'content-type': 'application/dicom' } }), {
        signal: controller.signal, onMeasure: event => measurements.push(event)
    });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await until(() => reading); controller.abort();
    const immediate = measurements.length;
    await rejected; await until(() => canceled);
    assert.equal(measurements.length, immediate);
    assert.deepEqual(measurements.map(event => [event.phase, event.status]).sort(), [['pipeline', 'canceled'], ['stream', 'canceled']]);
    assert.ok(measurements.every(event => !('error' in event) && !('bytes' in event)));
});

test('source observers cannot break loading or decoding by throwing or rejecting', async () => {
    for (const observer of [() => { throw new Error('Observer-only failure'); }, () => Promise.reject(new Error('Observer-only rejection'))]) {
        const sources = await loadFiles([file()], { onMeasure: observer });
        try { assert.deepEqual([...(await sources[0].getFrame(0)).samples], [1, 2, 3, 4]); }
        finally { sources.forEach(stack => stack.dispose()); }
    }
    await new Promise(resolve => setTimeout(resolve, 5));
});

test('source disposal finishes active observations synchronously and ignores a terminated worker result', async () => {
    const measurements = [];
    const sources = await loadFiles([file()], { onMeasure: event => measurements.push(event) });
    const previousWorker = globalThis.Worker;
    let worker;
    globalThis.Worker = class {
        constructor() { worker = this; }
        postMessage(message) { this.message = message; }
        terminate() { this.terminated = true; }
    };
    try {
        const pending = sources[0].getFrame(0);
        const rejected = assert.rejects(pending, { name: 'AbortError' });
        assert.ok(worker);
        sources[0].dispose();
        const count = measurements.length;
        assert.equal(measurements.filter(event => event.status === 'canceled').length, 2);
        assert.equal(worker.terminated, true);
        worker.onmessage({ data: { id: worker.message.id, samples: new Uint16Array([1, 2, 3, 4]), range: { min: 1, max: 4 } } });
        await rejected;
        assert.equal(measurements.length, count);
        assert.equal(sources[0]._session.onMeasure, null);
        assert.equal(sources[0].sourceBytes, 0); assert.equal(sources[0].cacheBytes, 0);
    } finally { globalThis.Worker = previousWorker; sources.forEach(stack => stack.dispose()); }
});

test('generated demo observations keep their demo classification through later lazy decoding', async () => {
    const measurements = [];
    const sources = await loadDemo('xr', { onMeasure: event => measurements.push(event) });
    try {
        await sources[0].getFrame(0);
        assert.ok(measurements.length >= 4); assert.ok(measurements.every(event => event.source === 'demo'));
    } finally { sources.forEach(stack => stack.dispose()); }
});
