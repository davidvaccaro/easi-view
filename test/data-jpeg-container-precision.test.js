import test from 'node:test';
import assert from 'node:assert/strict';
import EASI from '@xinonix/easi-js';
import { createJpegAlignmentFixture } from './jpeg-alignment-fixtures.js';
import { JPEG_ALIGNMENT_WARNING } from '../src/data/encapsulated.js';
import { JPEG_STORED_PRECISION_WARNING, decodeWasmFrame } from '../src/data/wasm-codecs.js';
import { decodeFrame } from '../src/data/compressed.js';
import { loadFiles } from '../src/data/sources.js';
import { loadArchiveSeries } from '../src/data/archive-source.js';
import { NativeDecoder } from '../src/runtime/native-decoder.js';
import { Volume } from '../src/volume/Volume.js';
import { frameGeometry } from '../src/volume/geometry.js';

// Independently selected values intentionally cross the declared12-bit range.
// 4096 and65535 must never become0 or4095 through native masking.
const values = [0, 4095, 4096, 65535], syntax = suffix => `1.2.840.10008.1.2.4.${suffix}`;
const options = { rows: 2, columns: 2, bitsAllocated: 16, bitsStored: 16,
    metadataOverrides: { bitsStored: 12, highBit: 11 }, frameSamples: [values] };
const warning = [JPEG_ALIGNMENT_WARNING, JPEG_STORED_PRECISION_WARNING];
const attribute = (snapshot, tag) => snapshot.rows.find(row => row.tag === tag)?.value;

for (const suffix of [57, 70]) for (const photometric of ['MONOCHROME1', 'MONOCHROME2']) {
    test(`JPEG Lossless .${suffix} ${photometric} uses coded16-bit precision without truncating values to declared12 bits`, async () => {
        const generated = await createJpegAlignmentFixture({ ...options, photometric, transferSyntax: syntax(suffix) });
        const before = generated.bytes.slice(), metadataBefore = structuredClone(generated.metadata);
        const raw = await decodeWasmFrame(generated.frames[0], generated.metadata);
        assert.equal(raw.metadataOverrides.bitsStored, 16); assert.equal(raw.metadataOverrides.highBit, 15);
        assert.deepEqual(Array.from(new Uint16Array(raw.bytes.buffer)), values);
        const decoded = await decodeFrame(generated.frames[0], generated.metadata);
        assert.deepEqual([...decoded.samples], values); assert.equal(decoded.bitsStored, 16); assert.equal(decoded.highBit, 15);
        assert.deepEqual(decoded.encodingWarnings, [JPEG_STORED_PRECISION_WARNING]);
        const stacks = await loadFiles([new File([generated.bytes], 'generated-precision-container')]);
        try {
            const frame = await stacks[0].getFrame(0), record = [...stacks[0]._records.values()][0];
            assert.deepEqual([...frame.samples], values); assert.ok(frame.samples instanceof Uint16Array);
            assert.equal(frame.bitsStored, 16); assert.equal(frame.highBit, 15); assert.deepEqual(frame.encodingWarnings, warning);
            assert.deepEqual(frame.range, { min: 0, max: 65535 }); assert.equal(await stacks[0].getFrame(0), frame);
            assert.equal(stacks[0].frames[0].bitsStored, 12); assert.equal(stacks[0].frames[0].highBit, 11);
            assert.equal(record.common.bitsStored, 12); assert.equal(record.common.highBit, 11);
            assert.equal(attribute(stacks[0].getAttributes(0), '(0028,0101)'), '12');
            assert.equal(attribute(stacks[0].getAttributes(0), '(0028,0102)'), '11');
            assert.deepEqual(generated.bytes, before); assert.deepEqual(generated.metadata, metadataBefore);
        } finally { stacks.forEach(stack => stack.dispose()); }
    });
}

test('effective JPEG precision preserves numeric rescale, declared unit and scalar padding rather than inventing a new transform', async () => {
    const generated = await createJpegAlignmentFixture({ ...options, slope: 2, intercept: -3,
        extraAttributes: { '00281054': ['LO', 'BQML'], '00280120': ['US', 4095] } });
    const stacks = await loadFiles([new File([generated.bytes], 'generated-precision-rescale')]);
    try {
        const frame = await stacks[0].getFrame(0);
        assert.deepEqual([...frame.samples], values); assert.equal(frame.bitsStored, 16);
        assert.equal(frame.slope, 2); assert.equal(frame.intercept, -3); assert.equal(frame.unit, 'BQML');
        assert.deepEqual(frame.padding, { value: 4095, limit: 4095 }); assert.deepEqual(frame.range, { min: -3, max: 131067 });
    } finally { stacks.forEach(stack => stack.dispose()); }
});

test('all other JPEG precision, component, signedness and LUT mismatches reject before codec allocation', async () => {
    const generated = await createJpegAlignmentFixture(options), metadata = generated.metadata;
    for (const changes of [{ signed: true }, { rows: 3 }, { columns: 3 }, { samplesPerPixel: 3, photometric: 'RGB', planarConfiguration: 0 },
        { bitsStored: 11, highBit: 10 }, { bitsStored: 8, highBit: 7 }, { bitsStored: 13, highBit: 12 },
        { highBit: 12 }, { photometric: 'PALETTE COLOR' }, { transferSyntax: syntax(51) }, { transferSyntax: syntax(80) },
        { modalityLut: { pending: true } }, { voiLut: { pending: true } }, { hasVoiLut: true }]) {
        await assert.rejects(decodeWasmFrame(generated.frames[0], { ...metadata, ...changes }, { wasmBytes: new Uint8Array() }), /header|do not match|profile/);
    }
    const lowerPrecision = generated.frames[0].slice();
    const sof = lowerPrecision.findIndex((value, index) => value === 255 && lowerPrecision[index + 1] === 195);
    lowerPrecision[sof + 4] = 12;
    await assert.rejects(decodeWasmFrame(lowerPrecision, { ...metadata, bitsStored: 16, highBit: 15 }, { wasmBytes: new Uint8Array() }), /do not match/);
    const matched = await decodeFrame(generated.frames[0], { ...metadata, bitsStored: 16, highBit: 15 });
    assert.deepEqual([...matched.samples], values); assert.deepEqual(matched.encodingWarnings ?? [], []);
    assert.equal(matched.bitsStored, undefined);
});

test('qualified lossless container mismatch retains predictor and point-transform guards', async () => {
    const generated = await createJpegAlignmentFixture(options);
    const scan = generated.frames[0].findIndex((value, index) => value === 255 && generated.frames[0][index + 1] === 218);
    for (const [position, value] of [[scan + 7, 2], [scan + 9, 1]]) {
        const changed = generated.frames[0].slice(); changed[position] = value;
        await assert.rejects(decodeWasmFrame(changed, generated.metadata, { wasmBytes: new Uint8Array() }), /predictor|point transform/);
    }
    const predictor2 = await createJpegAlignmentFixture({ ...options, transferSyntax: syntax(57), encoderOptions: { predictor: 2 } });
    assert.deepEqual([...(await decodeFrame(predictor2.frames[0], predictor2.metadata)).samples], values);
});

test('DICOMweb caches effective16-bit frames while preserving original12-bit archive descriptors and attributes', async () => {
    const studyUid = '2.25.9301', seriesUid = '2.25.9301.1', sopUid = '2.25.9301.1.1';
    const generated = await createJpegAlignmentFixture({ ...options, studyUid, seriesUid, sopUid,
        extraAttributes: { '0020000D': ['UI', studyUid] } });
    const instances = (await EASI.pipelineBuilder().fromByteStream().ofDicomData().toInstances().build().process({ source: generated.canonicalBytes })).toArray();
    const calls = [], client = { async getSeriesMetadata() { return instances; },
        async retrieveInstance(study, series, sop, settings) {
            assert.deepEqual([study, series, sop], [studyUid, seriesUid, sopUid]); calls.push(settings);
            return new Response(generated.bytes, { headers: { 'content-type': 'application/dicom' } });
        } };
    const stacks = await loadArchiveSeries(client, studyUid, seriesUid);
    try {
        const frame = await stacks[0].getFrame(0);
        assert.deepEqual([...frame.samples], values); assert.equal(frame.bitsStored, 16); assert.equal(frame.highBit, 15);
        assert.deepEqual(frame.encodingWarnings, warning); assert.equal(stacks[0].frames[0].bitsStored, 12);
        assert.equal(attribute(stacks[0].getAttributes(0), '(0028,0101)'), '12');
        assert.equal(await stacks[0].getFrame(0), frame); assert.equal(calls.length, 1); assert.equal(calls[0].native, undefined);
    } finally { stacks.forEach(stack => stack.dispose()); }
});

function generatedWorkers() {
    const list = [];
    class Worker {
        constructor() { list.push(this); }
        postMessage(message) { this.message = message; queueMicrotask(async () => {
            try { this.onmessage({ data: { id: message.id, ...await decodeFrame(new Uint8Array(message.bytes), message.metadata) } }); }
            catch (error) { this.onmessage({ data: { id: message.id, error: error.message } }); }
        }); }
        terminate() { this.terminated = true; }
    }
    return { Worker, list };
}

test('the worker response retains actual precision and65535 samples while passing only a VOI-presence flag', async () => {
    const generated = await createJpegAlignmentFixture(options), previous = globalThis.Worker, fake = generatedWorkers();
    globalThis.Worker = fake.Worker; let stacks = [];
    try {
        stacks = await loadFiles([new File([generated.bytes], 'generated-worker-precision')]);
        const frame = await stacks[0].getFrame(0);
        assert.deepEqual([...frame.samples], values); assert.equal(frame.bitsStored, 16); assert.equal(frame.highBit, 15);
        assert.deepEqual(frame.encodingWarnings, warning);
        assert.equal(fake.list[0].message.metadata.bitsStored, 12); assert.equal(fake.list[0].message.metadata.highBit, 11);
        assert.equal(fake.list[0].message.metadata.hasVoiLut, false); assert.equal(fake.list[0].message.metadata.voiLut, undefined);
        assert.equal(stacks[0].frames[0].bitsStored, 12); assert.equal(attribute(stacks[0].getAttributes(0), '(0028,0101)'), '12');
        assert.equal(await stacks[0].getFrame(0), frame);
        const decoder = new NativeDecoder();
        try {
            await assert.rejects(decoder.decode(generated.frames[0], { ...generated.metadata, voiLut: { pending: true } }), /do not match/);
            const message = fake.list.at(-1).message;
            assert.equal(message.metadata.hasVoiLut, true); assert.equal(message.metadata.voiLut, undefined);
        } finally { decoder.dispose(); }
    } finally { stacks.forEach(stack => stack.dispose()); globalThis.Worker = previous; }
    assert.ok(fake.list.every(worker => worker.terminated));
});

test('the worker boundary rejects incomplete or unrelated effective-precision overrides', async () => {
    const generated = await createJpegAlignmentFixture(options), previous = globalThis.Worker, list = [];
    globalThis.Worker = class { constructor() { list.push(this); } postMessage(message) { this.message = message; } terminate() { this.terminated = true; } };
    try {
        for (const [metadata, response] of [[generated.metadata, { bitsStored: 16 }], [generated.metadata, { bitsStored: 12, highBit: 11 }],
            [{ ...generated.metadata, bitsStored: 16, highBit: 15 }, { bitsStored: 16, highBit: 15 }],
            [{ ...generated.metadata, voiLut: {} }, { bitsStored: 16, highBit: 15 }]]) {
            const decoder = new NativeDecoder();
            try {
                const pending = decoder.decode(generated.frames[0], metadata), worker = list.at(-1);
                worker.onmessage({ data: { id: worker.message.id, samples: new Uint16Array(values), range: { min: 0, max: 65535 }, ...response } });
                await assert.rejects(pending, /inconsistent precision/); assert.equal(worker.terminated, true);
            } finally { decoder.dispose(); }
        }
    } finally { globalThis.Worker = previous; }
});

test('reconstruction rejects source12-bit versus decoded16-bit profile differences before copying a volume slice', async () => {
    const files = [];
    for (let index = 0; index < 2; index++) {
        const generated = await createJpegAlignmentFixture({ ...options, sopClass: '1.2.840.10008.5.1.4.1.1.2', modality: 'CT',
            sopUid: `2.25.9401.1.${index + 1}`, seriesUid: '2.25.9401.1', position: [0, 0, index * 2],
            extraAttributes: { '0020000D': ['UI', '2.25.9401'], '00200052': ['UI', '2.25.9402'] } });
        files.push(new File([generated.bytes], 'generated-volume-precision'));
    }
    const stacks = await loadFiles(files);
    try {
        assert.equal(stacks.length, 1); assert.equal(stacks[0].frames.length, 2);
        const frame = await stacks[0].getFrame(0);
        assert.equal(frame.bitsStored, 16); assert.notEqual(frameGeometry(frame).pixelSignature, frameGeometry(stacks[0].frames[0]).pixelSignature);
        await assert.rejects(Volume.fromSeries(stacks[0]), /differs from its descriptor/);
        assert.deepEqual([...frame.samples], values); assert.equal(stacks[0].frames[0].bitsStored, 12);
    } finally { stacks.forEach(stack => stack.dispose()); }
});
