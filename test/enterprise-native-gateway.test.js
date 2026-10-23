import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { nativeFrameTransformer, proveNativeFrameLocation, validateNativeFrameMedia } from '../examples/gateway/native-frame-stream.mjs';

const upstream = 'https://archive.invalid/dicom-web/studies/2.25.1/series/2.25.2/instances/2.25.3/frames/4';
const downstream = 'https://viewer.invalid/dicom-web/studies/2.25.1/series/2.25.2/instances/2.25.3/frames/4';
const boundary = 'synthetic-native-boundary';
const mime = `multipart/related; type="application/octet-stream"; boundary=${boundary}`;
const pixels = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
function envelope({ location = upstream, type = 'application/octet-stream; transfer-syntax=1.2.840.10008.1.2.1', length = pixels.length, body = pixels, suffix = `\r\n--${boundary}--\r\n`, extra = '' } = {}) {
    return Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: ${type}\r\nContent-Location: ${location}\r\nContent-Length: ${length}\r\n${extra}\r\n`), body, Buffer.from(suffix)]);
}
async function transform(bytes, size = 1, options = {}) {
    const chunks = []; await pipeline(Readable.from((function* () { for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size); })()),
        nativeFrameTransformer({ contentType: mime, upstreamUrl: upstream, downstreamUrl: downstream, ...options }), new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); } }));
    return Buffer.concat(chunks);
}

test('native frame MIME header rewriting preserves exact binary pixels across every chunk boundary with bounded header/tail storage', async () => {
    for (const size of [1, 2, 7, 53, 1024]) {
        const result = await transform(envelope(), size), split = result.indexOf('\r\n\r\n');
        assert.match(result.subarray(0, split).toString(), /https:\/\/viewer\.invalid/u); assert.ok(!result.subarray(0, split).toString().includes('archive.invalid'));
        assert.deepEqual(result.subarray(split + 4, split + 4 + pixels.length), pixels);
        assert.equal(result.subarray(split + 4 + pixels.length).toString(), `\r\n--${boundary}--\r\n`);
    }
});

test('validated relative locations and default Explicit Little Endian media are rewritten without following a URI', async () => {
    const result = await transform(envelope({ location: '/dicom-web/studies/2.25.1/series/2.25.2/instances/2.25.3/frames/4', type: 'application/octet-stream' }), 11);
    assert.ok(result.includes(Buffer.from(downstream))); assert.equal(proveNativeFrameLocation('./4', upstream, downstream), downstream);
});

test('single-part native frame media obeys the same Explicit Little Endian gate', () => {
    validateNativeFrameMedia('application/octet-stream');
    validateNativeFrameMedia('application/octet-stream; transfer-syntax="1.2.840.10008.1.2.1"');
    for (const media of ['application/dicom', 'application/octet-stream; transfer-syntax=1.2.840.10008.1.2.4.50', 'application/octet-stream; charset=utf-8']) assert.throws(() => validateNativeFrameMedia(media));
});

for (const [label, options] of [
    ['foreign location', { location: upstream.replace('archive.invalid', 'foreign.invalid') }],
    ['wrong original frame', { location: upstream.replace('/frames/4', '/frames/5') }],
    ['wrong SOP', { location: upstream.replace('/instances/2.25.3', '/instances/2.25.9') }],
    ['credentials', { location: upstream.replace('https://', 'https://secret@') }],
    ['unknown syntax', { type: 'application/octet-stream; transfer-syntax=1.2.840.10008.1.2.4.50' }],
    ['extra part', { suffix: `\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\nextra\r\n--${boundary}--\r\n` }],
    ['wrong length', { length: pixels.length + 1 }], ['missing closing boundary', { suffix: '' }],
    ['epilogue', { suffix: `\r\n--${boundary}--\r\nextra` }], ['duplicate header', { extra: 'Content-Type: application/octet-stream\r\n' }]
]) test(`gateway native-frame rejects ${label} instead of weakening frame identity`, async () => {
    await assert.rejects(transform(envelope(options), 17));
});

test('oversized headers and pixels fail within explicit bounds, while first pixel bytes flow before the response tail', async () => {
    await assert.rejects(transform(envelope({ extra: `X-Unknown: ${'a'.repeat(17000)}\r\n` }), 512), /16KiB/u);
    await assert.rejects(transform(envelope(), 17, { maxBytes: 10 }));
    let release; const tail = new Promise(resolve => release = resolve), chunks = [];
    const head = envelope().subarray(0, envelope().length - (`\r\n--${boundary}--\r\n`).length);
    const pending = pipeline(Readable.from((async function* () { yield head; await tail; yield Buffer.from(`\r\n--${boundary}--\r\n`); })()),
        nativeFrameTransformer({ contentType: mime, upstreamUrl: upstream, downstreamUrl: downstream }), new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); } }));
    await new Promise(resolve => setTimeout(resolve, 0)); const partial = Buffer.concat(chunks); const headerEnd = partial.indexOf('\r\n\r\n');
    assert.ok(partial.length > headerEnd + 4); release(); await pending;
});
