import test from 'node:test';
import assert from 'node:assert/strict';
import EASI from '@xinonix/easi-js';
import { DicomWebClient } from '../src/data/DicomWebClient.js';
import { loadArchiveSeries } from '../src/data/archive-source.js';
import { createDicomFixture } from '../src/data/synthetic.js';
import { loadResponse, normalizeInstance, MAX_SOURCE_BYTES } from '../src/data/sources.js';
import { createCompressedDicom, createEncapsulatedDicom } from './compressed-fixtures.js';
import { PIXEL_ENCODING_ERROR_CODE } from '../src/data/encapsulated.js';

const STUDY = '2.25.6001', SERIES = '2.25.6001.1', SOP = '2.25.6001.1.1';
const SOP_CLASS = '1.2.840.10008.5.1.4.1.1.7';
const PROFILE = { rows: 8, columns: 8, bitsAllocated: 8, bitsStored: 8, highBit: 7,
    photometric: 'MONOCHROME2', samplesPerPixel: 1, modality: 'OT', sopClass: SOP_CLASS, sopUid: SOP, seriesUid: SERIES,
    extraAttributes: { '0020000D': ['UI', STUDY], '00281054': null } };
const VALUES = Array.from({ length: 64 }, (_, index) => index);
function join(...parts) {
    const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let position = 0;
    for (const part of parts) { result.set(part, position); position += part.length; }
    return result;
}
function native(overrides = {}) { return createDicomFixture({ ...PROFILE, values: VALUES, ...overrides }); }
function response(bytes, headers = {}) {
    return new Response(bytes, { headers: { 'content-type': 'application/dicom', ...headers } });
}
async function metadata() {
    const result = await EASI.pipelineBuilder().fromByteStream().ofDicomData().toInstances().build().process({ source: native() });
    return result.toArray();
}
async function badOriginal(overrides = {}) {
    const generated = await createCompressedDicom({ codec: 'jpeg', ...PROFILE, frameSamples: [VALUES] });
    // Independent trailer mimics a malformed original encapsulated JPEG frame;
    // the decoder/indexer must never accept it by dropping arbitrary bytes.
    return createEncapsulatedDicom([join(generated.frames[0], Uint8Array.of(17, 31, 47, 61))], {
        ...PROFILE, transferSyntax: generated.metadata.transferSyntax, ...overrides
    });
}
async function open(retrieve, options = {}) {
    const instances = await metadata(), calls = [];
    const client = { async getSeriesMetadata() { return instances; },
        async retrieveInstance(study, series, sop, settings) {
            assert.deepEqual([study, series, sop], [STUDY, SERIES, SOP]);
            calls.push(settings);
            return retrieve(settings, calls.length);
        } };
    return { calls, sources: await loadArchiveSeries(client, STUDY, SERIES, options) };
}
function disposedCounters(stack) { assert.equal(stack.sourceBytes, 0); assert.equal(stack.cacheBytes, 0); }

test('tagged malformed JPEG boundary errors survive the EASI callback unchanged', async () => {
    await assert.rejects(loadResponse(response(await badOriginal())), error =>
        error.code === PIXEL_ENCODING_ERROR_CODE && /extra data/.test(error.message));
});

test('archive original JPEG trailers trigger one native request with exact samples and no unrelated requests', async () => {
    const original = await badOriginal();
    const { sources, calls } = await open(settings => response(settings.native ? native() : original));
    const stack = sources[0];
    try {
        assert.deepEqual(calls, []);
        assert.deepEqual([...(await stack.getFrame(0)).samples], VALUES);
        assert.equal(calls.length, 2); assert.equal(calls[0].native, undefined); assert.equal(calls[1].native, true);
        assert.equal(calls[0].signal, calls[1].signal);
        assert.equal(stack.sourceBytes, 64); assert.equal(stack.cacheBytes, 128);
        assert.equal(await stack.getFrame(0), await stack.getFrame(0)); assert.equal(calls.length, 2);
    } finally { stack.dispose(); disposedCounters(stack); }
});

test('an unsupported original transfer syntax can request native encoding without weakening local profile checks', async () => {
    const generated = await createCompressedDicom({ codec: 'jpeg', ...PROFILE, frameSamples: [VALUES] });
    const original = createEncapsulatedDicom(generated.frames, { ...PROFILE, transferSyntax: '1.2.840.10008.1.2.4.52' });
    const { sources, calls } = await open(settings => response(settings.native ? native() : original));
    try { assert.deepEqual([...(await sources[0].getFrame(0)).samples], VALUES); assert.equal(calls.length, 2); }
    finally { sources.forEach(stack => stack.dispose()); }
});

test('a repeated encoding error stops after the native attempt and leaves both caches empty', async () => {
    const original = await badOriginal();
    const { sources, calls } = await open(() => response(original));
    try {
        await assert.rejects(sources[0].getFrame(0), error => error.code === PIXEL_ENCODING_ERROR_CODE);
        assert.equal(calls.length, 2); disposedCounters(sources[0]);
    } finally { sources.forEach(stack => stack.dispose()); }
});

for (const [label, overrides, errorPattern] of [
    ['wrong instance identity', { sopUid: '2.25.6001.1.99' }, /identity/],
    ['wrong image geometry', { position: [0, 0, 100] }, /geometry/],
    ['wrong pixel dimensions', { rows: 4 }, /dimensions/],
    ['unsupported object class', { sopClass: '1.2.840.10008.5.1.4.1.1.88.22' }, /object type/]
]) {
    test(`${label} combined with malformed pixels never triggers native fallback`, async () => {
        const original = await badOriginal(overrides);
        const { sources, calls } = await open(() => response(original));
        try {
            await assert.rejects(sources[0].getFrame(0), errorPattern);
            assert.equal(calls.length, 1); disposedCounters(sources[0]);
        } finally { sources.forEach(stack => stack.dispose()); }
    });
}

test('HTTP errors and response byte limits never trigger a fallback or poison cache counters', async () => {
    for (const retrieve of [
        () => new Response('denied', { status: 401 }),
        () => response(native(), { 'content-length': String(MAX_SOURCE_BYTES + 1) })
    ]) {
        const { sources, calls } = await open(retrieve);
        try {
            await assert.rejects(sources[0].getFrame(0), /HTTP 401|256 MiB/);
            assert.equal(calls.length, 1); disposedCounters(sources[0]);
        } finally { sources.forEach(stack => stack.dispose()); }
    }
});

test('the native retry still enforces its own response budget and exact identity', async () => {
    const original = await badOriginal();
    for (const retrieveNative of [
        () => response(native(), { 'content-length': String(MAX_SOURCE_BYTES + 1) }),
        () => response(native({ sopUid: '2.25.6001.1.99' }))
    ]) {
        const { sources, calls } = await open(settings => settings.native ? retrieveNative() : response(original));
        try {
            await assert.rejects(sources[0].getFrame(0), /256 MiB|identity/);
            assert.equal(calls.length, 2); disposedCounters(sources[0]);
        } finally { sources.forEach(stack => stack.dispose()); }
    }
});

test('host cancellation after the original encoding failure stops before starting the native request', async () => {
    const controller = new AbortController(), original = await badOriginal();
    const { sources, calls } = await open(() => response(original), {
        onProgress(progress) { if (progress.message === 'Original pixel encoding requires native DICOM retrieval') controller.abort(); }
    });
    try {
        await assert.rejects(sources[0].getFrame(0, { signal: controller.signal }), { name: 'AbortError' });
        assert.equal(calls.length, 1); disposedCounters(sources[0]);
    } finally { sources.forEach(stack => stack.dispose()); }
});

test('cancellation during native retry cancels the stream and disposes partial temporary sources', async () => {
    const controller = new AbortController(), original = await badOriginal();
    let started = false, canceled = false, nativeBody;
    const { sources, calls } = await open(settings => {
        if (!settings.native) return response(original);
        nativeBody = new ReadableStream({
            pull() { started = true; }, cancel() { canceled = true; }
        }, { highWaterMark: 0 });
        return new Response(nativeBody, { headers: { 'content-type': 'application/dicom' } });
    });
    try {
        const frame = sources[0].getFrame(0, { signal: controller.signal });
        for (let step = 0; !started && step < 100; step++) await new Promise(resolve => setTimeout(resolve, 1));
        assert.equal(started, true); controller.abort();
        await assert.rejects(frame, { name: 'AbortError' });
        assert.equal(canceled, true); assert.equal(nativeBody.locked, false); assert.equal(calls.length, 2);
        disposedCounters(sources[0]);
    } finally { sources.forEach(stack => stack.dispose()); }
});

test('native retrieval is a strict internal boolean while initial requests preserve original compression and host auth', async () => {
    const originalFetch = globalThis.fetch, requests = [], suppliedSignals = [], controller = new AbortController();
    globalThis.fetch = async (url, settings) => { requests.push({ url: String(url), settings }); return response(native()); };
    try {
        let authCalls = 0;
        const client = new DicomWebClient({ baseUrl: 'https://archive.example.test/dicom-web', credentials: 'include',
            headers({ signal }) { suppliedSignals.push(signal); return { Authorization: `Bearer synthetic-${++authCalls}` }; } });
        for (const nativeOption of [undefined, false, true]) {
            const options = { signal: controller.signal, ...(nativeOption === undefined ? {} : { native: nativeOption }) };
            const fetched = await client.retrieveInstance(STUDY, SERIES, SOP, options); await fetched.body.cancel();
        }
        assert.equal(requests.length, 3); assert.equal(authCalls, 3);
        assert.match(requests[0].settings.headers.get('accept'), /transfer-syntax=\*/);
        assert.match(requests[1].settings.headers.get('accept'), /transfer-syntax=\*/);
        assert.match(requests[2].settings.headers.get('accept'), /transfer-syntax=1\.2\.840\.10008\.1\.2\.1/);
        assert.doesNotMatch(requests[2].settings.headers.get('accept'), /transfer-syntax=\*/);
        assert.ok(requests.every(request => request.settings.credentials === 'include' && request.settings.signal === controller.signal));
        assert.ok(suppliedSignals.every(signal => signal === controller.signal));
        assert.equal(requests[2].settings.headers.get('authorization'), 'Bearer synthetic-3');
        for (const value of [null, undefined, 1, 'true', {}]) {
            await assert.rejects(client.retrieveInstance(STUDY, SERIES, SOP, { native: value }), /boolean/);
        }
        await assert.rejects(client.getSeriesMetadata(STUDY, SERIES, { native: true }), /supported/);
        assert.equal(requests.length, 3);
    } finally { globalThis.fetch = originalFetch; }
});
