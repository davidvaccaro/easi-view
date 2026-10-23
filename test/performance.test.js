import test from 'node:test';
import assert from 'node:assert/strict';
import { beginMeasure, clockNow, PerformanceRecorder } from '../src/runtime/performance.js';

test('performance history is bounded, detached and stripped of unknown identifying fields', () => {
    const recorder = new PerformanceRecorder({ limit: 2 });
    const privateFields = { url: 'https://private.example/PatientID=secret', uid: '1.2.3', patientName: 'Private Name',
        error: 'A private response body', metadata: { token: 'secret' } };
    recorder.record({ phase: 'stream', status: 'success', durationMs: 1, bytes: 100, source: 'archive', ...privateFields });
    recorder.record({ phase: 'decode', status: 'success', durationMs: 2, decodedBytes: 8, ...privateFields });
    recorder.record({ phase: 'frame', status: 'success', durationMs: 3, decodedCacheHit: true, encodedCacheHit: false,
        encodedCacheBytes: 16, decodedCacheBytes: 8, ...privateFields });
    const snapshot = recorder.snapshot();
    assert.equal(snapshot.limit, 2); assert.equal(snapshot.measurements.length, 2);
    assert.deepEqual(snapshot.measurements[0], { phase: 'decode', durationMs: 2, status: 'success', decodedBytes: 8 });
    assert.ok(!JSON.stringify(snapshot).includes('secret'));
    snapshot.measurements[0].durationMs = 999; snapshot.summary.frame.count = 999;
    assert.equal(recorder.snapshot().measurements[0].durationMs, 2);
    assert.equal(recorder.snapshot().summary.frame.count, 1);
});

test('summary counts all statuses but median and nearest-rank p95 use successes only', () => {
    const recorder = new PerformanceRecorder();
    for (const durationMs of [20, 10, 40, 30]) recorder.record({ phase: 'frame', status: 'success', durationMs });
    recorder.record({ phase: 'frame', status: 'canceled', durationMs: 999 });
    recorder.record({ phase: 'frame', status: 'error', durationMs: 555 });
    assert.deepEqual(recorder.snapshot().summary.frame, {
        count: 6, successCount: 4, errorCount: 1, canceledCount: 1, lastMs: 555, medianMs: 25, p95Ms: 40
    });
    recorder.record({ phase: 'pipeline', status: 'error', durationMs: 11 });
    assert.equal(recorder.snapshot().summary.pipeline.medianMs, null);
    assert.equal(recorder.snapshot().summary.pipeline.p95Ms, null);
    recorder.reset();
    for (let durationMs = 1; durationMs <= 20; durationMs++) recorder.record({ phase: 'frame', status: 'success', durationMs });
    assert.equal(recorder.snapshot().summary.frame.medianMs, 10.5);
    assert.equal(recorder.snapshot().summary.frame.p95Ms, 19);
});

test('invalid measurement schema and unsupported labels cannot enter history', () => {
    const recorder = new PerformanceRecorder();
    for (const event of [null, {}, { phase: 'private-patient-phase', status: 'success', durationMs: 1 },
        { phase: 'frame', status: 'success', durationMs: Infinity }, { phase: 'frame', status: 'success', durationMs: 1e308 },
        { phase: 'frame', status: 'success', durationMs: -1 },
        { phase: 'frame', status: 'private-message', durationMs: 1 }]) assert.equal(recorder.record(event), false);
    recorder.record({ phase: 'frame', status: 'success', durationMs: 0, bytes: -1, decodedBytes: 'private',
        encodedCacheBytes: NaN, decodedCacheBytes: Number.MAX_SAFE_INTEGER + 1, decodedCacheHit: 'true', source: 'private-url' });
    assert.deepEqual(recorder.snapshot().measurements, [{ phase: 'frame', durationMs: 0, status: 'success' }]);
    assert.throws(() => new PerformanceRecorder({ limit: 0 }), /limit/);
    assert.throws(() => new PerformanceRecorder({ limit: 4097 }), /limit/);
});

test('measurement completion is monotonic, synchronous on cancellation and emitted only once', async () => {
    const events = [];
    const controller = new AbortController();
    const finish = beginMeasure(event => events.push(event), 'decode', { signal: controller.signal });
    const firstClock = clockNow();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(clockNow() >= firstClock);
    controller.abort();
    assert.equal(events.length, 1); assert.equal(events[0].status, 'canceled');
    assert.ok(events[0].durationMs >= 0);
    assert.equal(finish('success', { bytes: 99 }), null);
    assert.equal(events.length, 1);
    const alreadyCanceled = new AbortController(); alreadyCanceled.abort();
    beginMeasure(event => events.push(event), 'pipeline', { signal: alreadyCanceled.signal });
    assert.equal(events.length, 2); assert.equal(events[1].status, 'canceled');
});

test('observing timing cannot fail an operation through synchronous errors or rejected promises', async () => {
    assert.doesNotThrow(() => beginMeasure(() => { throw new Error('Private observer failure'); }, 'frame')());
    assert.doesNotThrow(() => beginMeasure(() => Promise.reject(new Error('Private observer rejection')), 'frame')());
    const received = [];
    const finish = beginMeasure(event => received.push(event), 'frame');
    finish('success', { source: 'archive', bytes: 8, url: 'https://private.example', error: 'private' });
    assert.deepEqual(Object.keys(received[0]).sort(), ['bytes', 'durationMs', 'phase', 'source', 'status']);
    assert.equal(finish(), null);
    await new Promise(resolve => setTimeout(resolve, 5));
});

test('disposing a recorder clears all observations and ignores late callbacks', () => {
    const recorder = new PerformanceRecorder();
    const finish = beginMeasure(event => recorder.record(event), 'decode');
    recorder.record({ phase: 'stream', status: 'success', durationMs: 1 });
    recorder.dispose(); finish();
    assert.deepEqual(recorder.snapshot(), { limit: 256, measurements: [], summary: {} });
    assert.equal(recorder.record({ phase: 'frame', status: 'success', durationMs: 1 }), false);
});
