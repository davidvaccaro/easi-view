import test from 'node:test';
import assert from 'node:assert/strict';
import EASI, { Tag } from '@xinonix/easi-js';
import { createDicomFixture } from '../src/data/synthetic.js';
import { loadFiles, normalizeInstance } from '../src/data/sources.js';
import { PHILIPS_PRIVATE_CT_SYNTAX, PHILIPS_PRIVATE_PIXEL_PROFILE } from '../src/data/philips-private.js';
import { decodeFrame } from '../src/data/compressed.js';
import { NativeDecoder } from '../src/runtime/native-decoder.js';

const encoded = Uint8Array.of(0x5a, 0xe8, 0x03, 1, 0xfe, 3), expected = [1000, 1001, 999, 1002];
function fixture(options = {}) {
    return createDicomFixture({ transferSyntax: PHILIPS_PRIVATE_CT_SYNTAX, signed: false, bitsStored: 12,
        slope: 2, intercept: -1000, ...options, extraAttributes: { '7FE00010': null,
            '07A10010': ['LO', 'ELSCINT1'], '07A11011': ['CS', 'PMSCT_RLE1'], '07A1100A': ['OB', encoded], ...options.extraAttributes } });
}
async function parse(bytes) {
    return (await EASI.pipelineBuilder().fromByteStream().ofDicomData({ includePart10Header: true })
        .toInstances().build().process({ source: bytes })).first();
}

test('generated private Part10 loads through EASI, keeps original transfer syntax/attribute provenance, and decodes exact canonical stored values', async () => {
    const bytes = fixture(), original = bytes.slice(); let originalSyntax, originalPayloadVr, noStandardPixels;
    const sources = await loadFiles([new File([bytes], 'generated-private-philips.dcm')], { onInstance(instance) {
        originalSyntax = instance.metaSet.value(Tag.find('00020010'));
        originalPayloadVr = instance.dataSet.find(Tag.find('07A1100A')).vr.ID;
        noStandardPixels = !instance.dataSet.has(Tag.find('7FE00010'));
    } });
    try {
        assert.equal(originalSyntax, PHILIPS_PRIVATE_CT_SYNTAX); assert.equal(originalPayloadVr, 'OB'); assert.equal(noStandardPixels, true);
        const source = sources[0], descriptor = source.frames[0], frame = await source.getFrame(0);
        assert.equal(frame.transferSyntax, PHILIPS_PRIVATE_CT_SYNTAX); assert.equal(frame.pixelDecodingProfile, PHILIPS_PRIVATE_PIXEL_PROFILE);
        assert.deepEqual([...frame.samples], expected); assert.equal(frame.unit, 'HU'); assert.deepEqual(frame.range, { min: 998, max: 1004 });
        assert.equal(descriptor._record.bytes.length, 8); assert.equal(source.sourceBytes, 8);
        assert.equal(await source.getFrame(0), frame);
        const attrs = source.getAttributes(0).rows;
        assert.ok(attrs.some(row => row.tag === '(0002,0010)' && row.value === PHILIPS_PRIVATE_CT_SYNTAX));
        assert.ok(attrs.some(row => row.tag === '(07a1,100a)' && row.vr === 'OB' && row.kind === 'binary'));
        assert.ok(!attrs.some(row => row.tag === '(7fe0,0010)'));
    } finally { sources.forEach(source => source.dispose()); }
    assert.deepEqual(bytes, original); assert.equal(sources[0].cacheBytes, 0); assert.equal(sources[0].sourceBytes, 0);
});

test('metadata-only recognition does not expand/clear private pixels and residual source budgets reject expansion before retaining it', async () => {
    const instance = await parse(fixture()), payload = instance.dataSet.find(Tag.find('07A1100A'));
    const before = payload.access().slice();
    const record = normalizeInstance(instance, { metadataOnly: true });
    assert.equal(record.bytes, null); assert.equal(record.common.transferSyntax, PHILIPS_PRIVATE_CT_SYNTAX);
    assert.equal(record.common.pixelDecodingProfile, PHILIPS_PRIVATE_PIXEL_PROFILE);
    assert.deepEqual(payload.access(), before);
    assert.throws(() => normalizeInstance(instance, { maxPixelBytes: 7 }), /retained pixel data exceeds/);
    assert.deepEqual(payload.access(), before);
    const complete = normalizeInstance(instance, { maxPixelBytes: 8 }); assert.equal(complete.bytes.byteLength, 8);
});

test('canonical private dispatch requires the exact private UID, profile marker, native length and stored sample layout', async () => {
    const record = normalizeInstance(await parse(fixture()));
    assert.deepEqual([...(await decodeFrame(record.bytes, record.common)).samples], expected);
    for (const changes of [{ transferSyntax: '1.2.840.10008.1.2.1' }, { pixelDecodingProfile: null }, { pixelDecodingProfile: 'unknown' },
        { littleEndian: false }, { signed: true }, { bitsStored: 16 }, { highBit: 12 }, { samplesPerPixel: 3 }, { photometric: 'RGB' }]) {
        await assert.rejects(decodeFrame(record.bytes, { ...record.common, ...changes }), /verified canonical/);
    }
    await assert.rejects(decodeFrame(record.bytes.subarray(0, 6), record.common), /verified canonical/);
    await assert.rejects(decodeFrame(encoded, record.common), /verified canonical/);
});

test('worker and worker-less paths preserve the same exact private UID/canonical marker and independently checked stored samples', async () => {
    const record = normalizeInstance(await parse(fixture())), previous = globalThis.Worker, workers = [];
    const direct = new NativeDecoder();
    try { assert.deepEqual([...(await direct.decode(record.bytes, record.common)).samples], expected); }
    finally { direct.dispose(); }
    class OwnedTestWorker {
        constructor() { workers.push(this); }
        postMessage(message) {
            this.message = message;
            queueMicrotask(async () => {
                try { const result = await decodeFrame(new Uint8Array(message.bytes), message.metadata);
                    this.onmessage({ data: { id: message.id, ...result } }); }
                catch (error) { this.onmessage({ data: { id: message.id, error: error.message } }); }
            });
        }
        terminate() { this.terminated = true; }
    }
    globalThis.Worker = OwnedTestWorker; const decoder = new NativeDecoder();
    try {
        assert.deepEqual([...(await decoder.decode(record.bytes, record.common)).samples], expected);
        assert.equal(workers[0].message.metadata.transferSyntax, PHILIPS_PRIVATE_CT_SYNTAX);
        assert.equal(workers[0].message.metadata.pixelDecodingProfile, PHILIPS_PRIVATE_PIXEL_PROFILE);
        await assert.rejects(decoder.decode(record.bytes, { ...record.common, pixelDecodingProfile: 'unknown' }), /verified canonical/);
        assert.equal(workers[0].terminated, true);
    } finally { decoder.dispose(); globalThis.Worker = previous; }
});

test('private transfer syntax never bypasses wrong ownership, compressed representation or ambiguous standard Pixel Data', async () => {
    for (const extraAttributes of [{ '07A10010': ['LO', 'OTHER'] }, { '07A11011': ['CS', 'PMSCT_RGB1'] },
        { '7FE00010': ['OW', new Uint8Array(8)] }, { '07A1100A': ['OW', encoded] }]) {
        await assert.rejects(loadFiles([new File([fixture({ extraAttributes })], 'generated-invalid-private.dcm')]), /Philips/);
    }
});
