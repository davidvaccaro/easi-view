import test from 'node:test';
import assert from 'node:assert/strict';
import { readNativeFrame, MAX_BULK_FRAME_BYTES } from '../src/data/bulk-frame.js';
import { DicomWebClient } from '../src/data/DicomWebClient.js';

const url = 'https://archive.example/dicom-web/studies/1/series/2/instances/3/frames/2';
const pixels = Uint8Array.of(0, 128, 13, 10, 255, 0, 64, 32);
const encode = text => new TextEncoder().encode(text);
function fixture({ boundary = 'fixture_boundary', location = url, payload = pixels,
    headers = '', tail = '', type = 'application/octet-stream; transfer-syntax=1.2.840.10008.1.2.1' } = {}) {
    return new Uint8Array([...encode(`--${boundary}\r\nContent-Type: ${type}\r\nContent-Location: ${location}\r\n${headers}\r\n`),
        ...payload, ...encode(`\r\n--${boundary}--\r\n${tail}`)]);
}
function response(bytes = fixture(), outer = 'multipart/related; type="application/octet-stream"; boundary=fixture_boundary') {
    let offset = 0;
    return new Response(new ReadableStream({ pull(controller) {
        if (offset === bytes.length) { controller.close(); return; }
        controller.enqueue(bytes.slice(offset, offset + 3)); offset = Math.min(bytes.length, offset + 3);
    } }), { headers: { 'content-type': outer } });
}
const settings = { expectedUrl: url, expectedBytes: pixels.length };

test('native frame preserves exact samples across every MIME/chunk boundary and owns only its payload', async () => {
    const data = fixture();
    const result = await readNativeFrame(response(data), settings);
    assert.deepEqual(result, pixels);
    assert.equal(result.buffer.byteLength, pixels.length);
    data.fill(0); assert.deepEqual(result, pixels);
});

test('relative Content-Location binds to the requested frame without following a bulk URI', async () => {
    assert.deepEqual(await readNativeFrame(response(fixture({ location: '/dicom-web/studies/1/series/2/instances/3/frames/2' })), settings), pixels);
});

for (const [label, make] of [
    ['wrong frame', () => response(fixture({ location: url.replace('/frames/2', '/frames/1') }))],
    ['foreign archive', () => response(fixture({ location: url.replace('archive.example', 'other.example') }))],
    ['missing location', () => response(fixture({ location: '' }))],
    ['rendered JPEG', () => response(fixture({ type: 'image/jpeg' }))],
    ['wrong transfer syntax', () => response(fixture({ type: 'application/octet-stream; transfer-syntax=1.2.840.10008.1.2.4.50' }))],
    ['short pixel frame', () => response(fixture({ payload: pixels.slice(1) }))],
    ['long pixel frame', () => response(fixture({ payload: Uint8Array.of(...pixels, 0) }))],
    ['extra MIME part', () => response(fixture({ tail: '\r\n--fixture_boundary\r\nContent-Type: application/octet-stream\r\n\r\nextra' }))],
    ['duplicate header', () => response(fixture({ headers: 'Content-Type: application/octet-stream\r\n' }))],
    ['encoded payload', () => response(fixture({ headers: 'Content-Transfer-Encoding: base64\r\n' }))],
    ['incorrect part length', () => response(fixture({ headers: 'Content-Length: 99\r\n' }))],
    ['incorrect outer type', () => response(fixture(), 'multipart/related; type="image/jpeg"; boundary=fixture_boundary')],
    ['duplicate boundary', () => response(fixture(), 'multipart/related; type="application/octet-stream"; boundary=fixture_boundary; boundary=second')],
]) test(`native frame explicitly rejects ${label}`, async () => {
    await assert.rejects(readNativeFrame(make(), settings), /unsupported or malformed/);
});

test('byte budgets reject oversized declared and streamed envelopes and cancel unread bodies', async () => {
    let canceled = 0;
    const stream = () => new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(32768)); }, cancel() { canceled++; } });
    const headers = { 'content-type': 'multipart/related; type="application/octet-stream"; boundary=fixture_boundary' };
    await assert.rejects(readNativeFrame(new Response(stream(), { headers: { ...headers, 'content-length': '100000' } }), settings));
    assert.equal(canceled, 1);
    await assert.rejects(readNativeFrame(new Response(stream(), { headers }), settings));
    assert.equal(canceled, 2);
    await assert.rejects(readNativeFrame(response(), { ...settings, expectedBytes: MAX_BULK_FRAME_BYTES + 1 }));
});

test('canceling a streaming selected frame stops the reader and retains no pixel result', async () => {
    const controller = new AbortController(); let canceled = false;
    const body = new ReadableStream({ start(stream) { stream.enqueue(encode('--fixture_boundary\r\n')); }, cancel() { canceled = true; } });
    const pending = readNativeFrame(new Response(body, { headers: { 'content-type': 'multipart/related; type="application/octet-stream"; boundary=fixture_boundary' } }),
        { ...settings, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' }); assert.equal(canceled, true);
});

test('DICOMweb native-frame request uses one original frame, explicit native Accept and managed authentication', async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async (requested, options) => {
        requests++;
        assert.equal(requested.href, url);
        assert.equal(options.headers.get('authorization'), 'synthetic-token');
        assert.match(options.headers.get('accept'), /application\/octet-stream.*1\.2\.840\.10008\.1\.2\.1/);
        assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
        return response();
    };
    try {
        const client = new DicomWebClient({ baseUrl: 'https://archive.example/dicom-web', headers: { authorization: 'synthetic-token' } });
        assert.deepEqual(await client.retrieveNativeFrame('1', '2', '3', 2, pixels.length), pixels);
        await assert.rejects(client.retrieveNativeFrame('1', '2', '3', 0, pixels.length), /one-based/);
        await assert.rejects(client.retrieveNativeFrame('1', '2', '3', 4097, pixels.length), /one-based/);
        assert.equal(requests, 1);
    } finally { globalThis.fetch = originalFetch; }
});
