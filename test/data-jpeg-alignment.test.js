import test from 'node:test';
import assert from 'node:assert/strict';
import EASI from '@xinonix/easi-js';
import { createCompressedDicom, createEncapsulatedDicom, encapsulatePixelData } from './compressed-fixtures.js';
import { createJpegAlignmentFixture, oddJpegFrame, withJpegAlignmentByte } from './jpeg-alignment-fixtures.js';
import { JPEG_ALIGNMENT_WARNING, indexEncapsulatedFrames } from '../src/data/encapsulated.js';
import { loadFiles } from '../src/data/sources.js';
import { loadArchiveSeries } from '../src/data/archive-source.js';
import { decodeFrame } from '../src/data/compressed.js';

const first = Array.from({ length: 64 }, (_, index) => index * 17 + 31);
const second = Array.from({ length: 64 }, (_, index) => 4000 - index * 29);
const options = { rows: 8, columns: 8, bitsAllocated: 16, frameSamples: [first, second] };

for (const [label, configuration] of [['BOT', { bot: true }], ['empty BOT', { bot: false }],
    ['fragmented BOT', { bot: true, fragmentsPerFrame: 3 }], ['fragmented empty BOT', { bot: false, fragmentsPerFrame: 3 }],
    ['EOT', { extendedOffsets: true }]]) {
    test(`real generated JPEG Lossless SV1 ${label} decodes exact stored samples with a single unusual alignment byte`, async () => {
        const generated = await createJpegAlignmentFixture({ ...options, ...configuration }, 0x31), before = generated.bytes.slice();
        assert.equal(generated.paddingOffsets.length, 2); assert.ok(generated.frames.every(frame => frame.length % 2 === 1));
        const stacks = await loadFiles([new File([generated.bytes], 'generated-odd-jpeg')]);
        try {
            assert.equal(stacks.length, 1); assert.equal(stacks[0].frames.length, 2);
            for (const index of [1, 0]) {
                const frame = await stacks[0].getFrame(index);
                assert.deepEqual([...frame.samples], generated.expectedSamples[index]);
                assert.equal(frame.transferSyntax, '1.2.840.10008.1.2.4.70');
                assert.deepEqual(frame.encodingWarnings, [JPEG_ALIGNMENT_WARNING]);
                assert.equal(await stacks[0].getFrame(index), frame);
            }
            const record = [...stacks[0]._records.values()][0];
            assert.deepEqual(record.encapsulated.encodingWarnings, [JPEG_ALIGNMENT_WARNING]);
            assert.deepEqual(record.common.encodingWarnings, [JPEG_ALIGNMENT_WARNING]);
            for (let index = 0; index < 2; index++) assert.deepEqual(record.encapsulated.getFrame(index), generated.frames[index]);
            assert.deepEqual(generated.bytes, before);
        } finally { stacks.forEach(stack => stack.dispose()); }
        assert.equal(stacks[0].sourceBytes, 0); assert.equal(stacks[0].cacheBytes, 0);
    });
}

test('ordinary NULL and legacy FF JPEG alignment remain quiet and retain identical generated pixels', async () => {
    for (const padding of [0, 255]) {
        const generated = await createJpegAlignmentFixture(options, padding);
        const stacks = await loadFiles([new File([generated.bytes], 'generated-quiet-alignment')]);
        try {
            for (const index of [0, 1]) {
                const frame = await stacks[0].getFrame(index);
                assert.deepEqual([...frame.samples], generated.expectedSamples[index]);
                assert.deepEqual(frame.encodingWarnings ?? [], []);
            }
        } finally { stacks.forEach(stack => stack.dispose()); }
    }
});

for (const codec of ['jpeg', 'jpeg-extended', 'jpeg-ls', 'jpeg-ls-near']) {
    test(`the verified ${codec} path retains the source alignment notice rather than replacing it with codec header warnings`, async () => {
        const expected = Array(64).fill(129), generated = await createJpegAlignmentFixture({ codec, rows: 8, columns: 8,
            bitsAllocated: 8, bitsStored: 8, frameSamples: [expected] }, 254);
        const stacks = await loadFiles([new File([generated.bytes], 'generated-compressed-alignment')]);
        try {
            const frame = await stacks[0].getFrame(0);
            assert.ok([...frame.samples].every((sample, index) => Math.abs(sample - expected[index]) <= (codec === 'jpeg-ls-near' ? 2 : codec === 'jpeg' ? 1 : 0)));
            assert.deepEqual(frame.encodingWarnings, [JPEG_ALIGNMENT_WARNING]);
        } finally { stacks.forEach(stack => stack.dispose()); }
    });
}

test('independent source and legacy sequential-header notices both survive the WASM result without duplicate warnings', async () => {
    const expected = Array(64).fill(1024), generated = await createCompressedDicom({ codec: 'jpeg-extended', rows: 8, columns: 8,
        frameSamples: [expected] }), frame = oddJpegFrame(generated.frames[0]);
    const scan = frame.findIndex((value, index) => value === 255 && frame[index + 1] === 218);
    frame[scan + 8] = 0;
    const legacyWarning = 'Legacy JPEG sequential scan uses Se=0; the complete 64-coefficient scan was validated before decoding.';
    const decoded = await decodeFrame(frame, { ...generated.metadata, encodingWarnings: [JPEG_ALIGNMENT_WARNING, JPEG_ALIGNMENT_WARNING] });
    assert.deepEqual([...decoded.samples], expected); assert.deepEqual(decoded.encodingWarnings, [JPEG_ALIGNMENT_WARNING, legacyWarning]);
    const canonical = createEncapsulatedDicom([frame], { ...generated.metadata,
        extraAttributes: { '00280002': ['US', 1], '00281054': null } });
    const { bytes } = withJpegAlignmentByte(canonical, 127), stacks = await loadFiles([new File([bytes], 'generated-double-compatibility')]);
    try {
        const parsed = await stacks[0].getFrame(0);
        assert.deepEqual([...parsed.samples], expected); assert.deepEqual(parsed.encodingWarnings, [JPEG_ALIGNMENT_WARNING, legacyWarning]);
    } finally { stacks.forEach(stack => stack.dispose()); }
});

test('DICOMweb retains an original JPEG alignment notice and exact samples without requesting native fallback', async () => {
    const studyUid = '2.25.9201', seriesUid = '2.25.9201.1', sopUid = '2.25.9201.1.1';
    const generated = await createJpegAlignmentFixture({ ...options, studyUid, seriesUid, sopUid,
        extraAttributes: { '0020000D': ['UI', studyUid] } }, 128);
    const instances = (await EASI.pipelineBuilder().fromByteStream().ofDicomData().toInstances().build().process({ source: generated.canonicalBytes })).toArray();
    const calls = [], client = { async getSeriesMetadata() { calls.push('metadata'); return instances; },
        async retrieveInstance(study, series, sop, settings) {
            assert.deepEqual([study, series, sop], [studyUid, seriesUid, sopUid]); calls.push(settings);
            return new Response(generated.bytes, { headers: { 'content-type': 'application/dicom' } });
        } };
    const stacks = await loadArchiveSeries(client, studyUid, seriesUid);
    try {
        assert.deepEqual(calls, ['metadata']);
        for (const index of [1, 0]) {
            const frame = await stacks[0].getFrame(index);
            assert.deepEqual([...frame.samples], generated.expectedSamples[index]); assert.deepEqual(frame.encodingWarnings, [JPEG_ALIGNMENT_WARNING]);
        }
        assert.equal(calls.length, 2); assert.equal(calls[1].native, undefined);
    } finally { stacks.forEach(stack => stack.dispose()); }
    assert.equal(stacks[0].sourceBytes, 0); assert.equal(stacks[0].cacheBytes, 0);
});

test('the decode worker receives and returns a copied source alignment notice with exact lossless pixels', async () => {
    const generated = await createJpegAlignmentFixture(options), previous = globalThis.Worker, workers = [];
    class GeneratedWorker {
        constructor() { workers.push(this); }
        postMessage(message) { this.message = message; queueMicrotask(async () => {
            try { this.onmessage({ data: { id: message.id, ...await decodeFrame(new Uint8Array(message.bytes), message.metadata) } }); }
            catch (error) { this.onmessage({ data: { id: message.id, error: error.message } }); }
        }); }
        terminate() { this.terminated = true; }
    }
    globalThis.Worker = GeneratedWorker; let stacks = [];
    try {
        stacks = await loadFiles([new File([generated.bytes], 'generated-worker-alignment')]);
        for (const index of [1, 0]) {
            const frame = await stacks[0].getFrame(index);
            assert.deepEqual([...frame.samples], generated.expectedSamples[index]); assert.deepEqual(frame.encodingWarnings, [JPEG_ALIGNMENT_WARNING]);
            assert.deepEqual(workers[0].message.metadata.encodingWarnings, [JPEG_ALIGNMENT_WARNING]);
            assert.notEqual(workers[0].message.metadata.encodingWarnings, stacks[0].frames[index].encodingWarnings);
        }
    } finally { stacks.forEach(stack => stack.dispose()); globalThis.Worker = previous; }
    assert.equal(workers[0].terminated, true);
});

test('JPEG 2000 still rejects arbitrary nonzero alignment rather than inheriting JPEG compatibility', async () => {
    const generated = await createCompressedDicom({ codec: 'jpeg2000', rows: 8, columns: 8, frameSamples: [first] });
    let frame = generated.frames[0];
    if (frame.length % 2 === 0) {
        const comment = Uint8Array.of(255, 100, 0, 5, 0, 1, 42), odd = new Uint8Array(frame.length + comment.length);
        odd.set(frame.subarray(0, 2)); odd.set(comment, 2); odd.set(frame.subarray(2), 2 + comment.length); frame = odd;
    }
    const padded = new Uint8Array(frame.length + 1); padded.set(frame); padded[frame.length] = 17;
    for (const tables of [{}, { extendedOffsets: [0], extendedLengths: [frame.length] }]) {
        assert.throws(() => indexEncapsulatedFrames(encapsulatePixelData([padded], { bot: false }), {
            frameCount: 1, syntax: generated.metadata.transferSyntax, ...tables }), /EOC|padding/);
    }
});
