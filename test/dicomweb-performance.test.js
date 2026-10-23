import test from 'node:test';
import assert from 'node:assert/strict';
import { DicomWebClient, MAX_METADATA_BYTES } from '../src/data/DicomWebClient.js';
import { clockNow } from '../src/runtime/performance.js';

const STUDY = '2.25.401';
const SERIES = '2.25.401.1';
const SOP = '2.25.401.1.1';
const encoder = new TextEncoder();
const attributes = {
    '0020000D': { vr: 'UI', Value: [STUDY] },
    '0020000E': { vr: 'UI', Value: [SERIES] },
    '00080018': { vr: 'UI', Value: [SOP] }
};
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred() { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; }
function client(onMeasure, options = {}) {
    return new DicomWebClient({ baseUrl: 'https://secret-archive.invalid/dicom-web/', ...options }, { onMeasure });
}
function metadataResponse(value = [attributes]) {
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/dicom+json' } });
}
async function withFetch(stub, action) {
    const original = globalThis.fetch;
    globalThis.fetch = stub;
    try { return await action(); } finally { globalThis.fetch = original; }
}
function assertSafeEvents(events) {
    const fields = new Set(['phase', 'status', 'durationMs', 'bytes', 'source']);
    for (const event of events) {
        assert(Object.keys(event).every(key => fields.has(key)));
        assert(Number.isFinite(event.durationMs));
        assert(event.durationMs >= 0);
        assert(['success', 'error', 'canceled'].includes(event.status));
    }
    assert.doesNotMatch(JSON.stringify(events), /secret-archive|SECRET-PATIENT|SECRET-TOKEN|SECRET-BODY|2\.25\.401/);
}

test('client metrics are an internal constructor option and do not broaden the host archive configuration', () => {
    assert.throws(() => new DicomWebClient({ baseUrl: 'https://archive.invalid', onMeasure() {} }), /supported DICOMweb connection/);
    assert.equal(typeof client().searchStudies, 'function');
    assert.equal(typeof new DicomWebClient({ baseUrl: 'https://archive.invalid' }, { onMeasure: null }).searchStudies, 'function');
});

test('study metrics separate consumed metadata bytes from canonical parsing bytes without patient or connection fields', async () => {
    const events = [];
    const wire = ' \n[{ "0020000D": { "Value": ["2.25.401"], "vr": "UI" } }]\n';
    const canonical = '[{"0020000D":{"vr":"UI","Value":["2.25.401"]}}]';
    await withFetch(async () => new Response(wire, { headers: { 'Content-Type': 'application/dicom+json' } }), async () => {
        const result = await client(event => events.push(event), { headers: { Authorization: 'Bearer SECRET-TOKEN' } })
            .searchStudies({ patientId: 'SECRET-PATIENT' });
        assert.equal(result.items[0].studyUid, STUDY);
    });
    assert.deepEqual(events.map(event => event.phase), ['metadata-read', 'metadata-parse', 'study-query']);
    assert(events.every(event => event.status === 'success' && event.source === 'archive'));
    assert.equal(events[0].bytes, encoder.encode(wire).byteLength);
    assert.equal(events[1].bytes, encoder.encode(canonical).byteLength);
    assert.equal(events[2].bytes, undefined);
    assert(events[2].durationMs + 0.000001 >= events[0].durationMs + events[1].durationMs);
    assertSafeEvents(events);
});

test('query totals include authentication, response headers and body reading without inventing overlapping phase sums', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance');
    let now = clockNow() + 100;
    Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => now } });
    const events = [];
    const bytes = encoder.encode(JSON.stringify([{ '0020000D': attributes['0020000D'] }]));
    let sent = false;
    const body = new ReadableStream({ pull(controller) {
        if (!sent) { sent = true; now += 40; controller.enqueue(bytes); } else controller.close();
    } }, { highWaterMark: 0 });
    try {
        await withFetch(async () => { now += 20; return new Response(body, { headers: { 'Content-Type': 'application/dicom+json' } }); }, async () => {
            await client(event => events.push(event), { headers: async () => { now += 10; return { Authorization: 'Bearer SECRET-TOKEN' }; } }).searchStudies();
        });
        assert.ok(Math.abs(events.find(event => event.phase === 'study-query').durationMs - 70) < 1e-9);
        assert.ok(Math.abs(events.find(event => event.phase === 'metadata-read').durationMs - 40) < 1e-9);
        assert.equal(events.find(event => event.phase === 'metadata-parse').durationMs, 0);
        assertSafeEvents(events);
    } finally { Object.defineProperty(globalThis, 'performance', descriptor); }
});

test('series listing and instance metadata report their distinct endpoint intervals once', async () => {
    const events = [];
    await withFetch(async () => metadataResponse(), async () => {
        const remote = client(event => events.push(event));
        assert.equal((await remote.listSeries(STUDY)).items[0].seriesUid, SERIES);
        assert.equal((await remote.getSeriesMetadata(STUDY, SERIES)).length, 1);
    });
    assert.deepEqual(events.map(event => event.phase), ['metadata-read', 'metadata-parse', 'series-query',
        'metadata-read', 'metadata-parse', 'series-metadata']);
    assert(events.every(event => event.status === 'success'));
    assertSafeEvents(events);
});

test('instance header measurement includes auth and ends before any pixel body is consumed', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance');
    let now = clockNow() + 100;
    Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => now } });
    const events = [];
    let pulls = 0;
    const body = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(Uint8Array.of(1, 2)); } }, { highWaterMark: 0 });
    try {
        await withFetch(async () => { now += 20; return new Response(body, { headers: { 'Content-Type': 'application/dicom', 'Content-Length': '999' } }); }, async () => {
            const result = await client(event => events.push(event), { headers: async () => { now += 10; return {}; } })
                .retrieveInstance(STUDY, SERIES, SOP);
            assert.equal(pulls, 0);
            assert.equal(result.body.locked, false);
            assert.equal(events.length, 1);
            assert.equal(events[0].phase, 'instance-headers');
            assert.ok(Math.abs(events[0].durationMs - 30) < 1e-9);
            assert.equal(events[0].status, 'success');
            assert.equal(events[0].bytes, undefined);
            await result.body.cancel();
        });
        assertSafeEvents(events);
    } finally { Object.defineProperty(globalThis, 'performance', descriptor); }
});

test('HTTP failures record endpoint errors without logging status text, URLs, headers or response bodies', async () => {
    const events = [];
    await withFetch(async () => new Response('SECRET-BODY', { status: 401 }), async () => {
        const remote = client(event => events.push(event));
        await assert.rejects(remote.searchStudies(), /HTTP 401/);
        await assert.rejects(remote.listSeries(STUDY), /HTTP 401/);
        await assert.rejects(remote.getSeriesMetadata(STUDY, SERIES), /HTTP 401/);
        await assert.rejects(remote.retrieveInstance(STUDY, SERIES, SOP), /HTTP 401/);
    });
    assert.deepEqual(events.map(event => event.phase), ['study-query', 'series-query', 'series-metadata', 'instance-headers']);
    assert(events.every(event => event.status === 'error' && event.bytes === undefined));
    assertSafeEvents(events);
});

test('schema failures count only observed metadata bytes and do not emit a successful parse or query', async () => {
    const events = [];
    const body = '[{"SECRET-PATIENT":"SECRET-BODY"}]';
    await withFetch(async () => new Response(body, { headers: { 'Content-Type': 'application/dicom+json' } }), async () => {
        await assert.rejects(client(event => events.push(event)).searchStudies(), /invalid DICOM JSON/);
    });
    assert.deepEqual(events.map(event => event.phase), ['metadata-read', 'study-query']);
    assert(events.every(event => event.status === 'error'));
    assert.equal(events[0].bytes, encoder.encode(body).byteLength);
    assertSafeEvents(events);
});

test('metadata header rejection retains the unread body guard and emits only a failed query interval', async () => {
    for (const headers of [{ 'Content-Type': 'text/html' },
        { 'Content-Type': 'application/dicom+json', 'Content-Length': String(MAX_METADATA_BYTES + 1) }]) {
        const events = [];
        let pulls = 0;
        let canceled = false;
        const body = new ReadableStream({ pull() { pulls++; }, cancel() { canceled = true; } }, { highWaterMark: 0 });
        await withFetch(async () => new Response(body, { headers }), async () => {
            await assert.rejects(client(event => events.push(event)).searchStudies(), /application\/dicom\+json|8 MiB/);
        });
        assert.equal(pulls, 0);
        assert.equal(canceled, true);
        assert.equal(body.locked, false);
        assert.deepEqual(events.map(event => [event.phase, event.status]), [['study-query', 'error']]);
        assertSafeEvents(events);
    }
});

test('actual metadata byte overflow remains enforced with instrumentation enabled', async () => {
    const events = [];
    let canceled = false;
    const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(MAX_METADATA_BYTES + 1)); },
        cancel() { canceled = true; } }, { highWaterMark: 0 });
    await withFetch(async () => new Response(body, { headers: { 'Content-Type': 'application/dicom+json' } }), async () => {
        await assert.rejects(client(event => events.push(event)).searchStudies(), /8 MiB/);
    });
    assert.equal(canceled, true);
    assert.equal(body.locked, false);
    assert.equal(events.find(event => event.phase === 'metadata-read').bytes, MAX_METADATA_BYTES + 1);
    assert(events.every(event => event.status === 'error'));
    assertSafeEvents(events);
});

test('auth cancellation emits one synchronous canceled interval and suppresses late observer success', async () => {
    const events = [];
    const auth = deferred();
    const controller = new AbortController();
    let requests = 0;
    await withFetch(async () => { requests++; return metadataResponse(); }, async () => {
        const pending = client(event => events.push(event), { headers: () => auth.promise })
            .searchStudies({}, { signal: controller.signal });
        controller.abort();
        assert.deepEqual(events.map(event => [event.phase, event.status]), [['study-query', 'canceled']]);
        await assert.rejects(pending, { name: 'AbortError' });
        auth.resolve({ Authorization: 'Bearer SECRET-TOKEN' });
        await pause();
        assert.equal(events.length, 1);
        assert.equal(requests, 0);
    });
    assertSafeEvents(events);
});

test('pending body cancellation records canceled phases without invented complete byte counts or late parse success', async () => {
    const events = [];
    const reading = deferred();
    let sent = false;
    let canceled = false;
    const body = new ReadableStream({ pull(controller) {
        if (!sent) { sent = true; controller.enqueue(encoder.encode('[]')); }
        else { reading.resolve(); return new Promise(() => {}); }
    }, cancel() { canceled = true; } }, { highWaterMark: 0 });
    const controller = new AbortController();
    await withFetch(async () => new Response(body, { headers: { 'Content-Type': 'application/dicom+json' } }), async () => {
        const pending = client(event => events.push(event)).searchStudies({}, { signal: controller.signal });
        await reading.promise;
        controller.abort();
        assert.deepEqual(events.map(event => event.phase).sort(), ['metadata-read', 'study-query']);
        assert(events.every(event => event.status === 'canceled' && event.bytes === undefined));
        await assert.rejects(pending, { name: 'AbortError' });
        await pause();
        assert.equal(events.length, 2);
        assert.equal(canceled, true);
        assert.equal(body.locked, false);
    });
    assertSafeEvents(events);
});

test('throwing and rejecting observers cannot change client results or create unhandled promise rejections', async () => {
    const unhandled = [];
    const handler = error => unhandled.push(error);
    process.on('unhandledRejection', handler);
    try {
        for (const observer of [() => { throw new Error('Observer SECRET-BODY'); },
            async () => { throw new Error('Observer SECRET-BODY'); }]) {
            await withFetch(async () => metadataResponse(), async () => {
                const remote = client(observer);
                assert.equal((await remote.searchStudies()).items[0].studyUid, STUDY);
                assert.equal((await remote.listSeries(STUDY)).items[0].seriesUid, SERIES);
                assert.equal((await remote.getSeriesMetadata(STUDY, SERIES)).length, 1);
            });
            await withFetch(async () => new Response(null, { status: 404 }), async () => {
                await assert.rejects(client(observer).searchStudies(), /HTTP 404/);
            });
        }
        await pause();
        await pause();
        assert.deepEqual(unhandled, []);
    } finally { process.removeListener('unhandledRejection', handler); }
});

test('instrumentation preserves malformed request option validation before contacting the endpoint', async () => {
    const events = [];
    let requests = 0;
    await withFetch(async () => { requests++; return metadataResponse(); }, async () => {
        await assert.rejects(client(event => events.push(event)).searchStudies({}, { signal: {} }),
            error => error.message === 'Use an AbortSignal for DICOMweb cancellation.');
        await assert.rejects(client(event => events.push(event)).searchStudies({}, { arbitrary: 'SECRET-TOKEN' }), /supported DICOMweb request/);
        assert.equal(requests, 0);
    });
    assertSafeEvents(events);
});
