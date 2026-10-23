import test from 'node:test';
import assert from 'node:assert/strict';
import EASI, { Tag } from '@xinonix/easi-js';
import { indexEncapsulatedFrames, RLE_TRANSFER_SYNTAX, MAX_ENCAPSULATED_BYTES, JPEG_ALIGNMENT_WARNING } from '../src/data/encapsulated.js';
import { createCompressedDicom, createEncapsulatedDicom } from './compressed-fixtures.js';

const JPEG = '1.2.840.10008.1.2.4.50';
function concat(parts) {
    const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
}
function item(payload) {
    const length = payload.length + payload.length % 2;
    const result = new Uint8Array(8 + length);
    const view = new DataView(result.buffer);
    view.setUint16(0, 0xFFFE, true); view.setUint16(2, 0xE000, true); view.setUint32(4, length, true);
    result.set(payload, 8);
    return result;
}
function encapsulate(fragments, offsets = []) {
    const bot = new Uint8Array(offsets.length * 4);
    const view = new DataView(bot.buffer);
    offsets.forEach((offset, index) => view.setUint32(index * 4, offset, true));
    return concat([item(bot), ...fragments.map(item)]);
}
function table64(values) {
    const result = new Uint8Array(values.length * 8);
    const view = new DataView(result.buffer);
    values.forEach((value, index) => view.setBigUint64(index * 8, BigInt(value), true));
    return result;
}
function jpeg(extraEntropy = []) {
    // Marker-boundary fixture only; the image codec separately validates frame/image contents.
    return new Uint8Array([0xFF, 0xD8, 0xFF, 0xE1, 0, 8, 0xFF, 0xD8, 0xFF, 0xD9, 0xAA, 0xBB,
        0xFF, 0xDA, 0, 2, 10, 0xFF, 0, 0xD9, 20, 0xFF, 0xD0, 30, ...extraEntropy, 0xFF, 0xD9]);
}

test('BOT offsets refer to fragment Item tags and reassemble only the selected fragmented JPEG', () => {
    const first = jpeg(), second = jpeg([40, 41]);
    const pieces = [first.subarray(0, 6), first.subarray(6, 18), first.subarray(18), second];
    const index = indexEncapsulatedFrames(encapsulate(pieces, [0, 50]), { frameCount: 2, syntax: JPEG });
    try {
        assert.equal(index.frames.length, 2); assert.equal(index.frames[0].fragments.length, 3);
        assert.deepEqual([...index.getFrame(0)], [...first]);
        assert.deepEqual([...index.getFrame(1)], [...second]);
        assert.equal(index.getFrame(1), index.frames[1].fragments[0]);
        assert.throws(() => index.getFrame(2), /available/);
    } finally { index.dispose(); }
});

test('empty BOT JPEG boundaries ignore marker-like bytes in APP payloads, stuffing and restart markers', () => {
    const first = jpeg(), second = jpeg([40, 41]);
    const index = indexEncapsulatedFrames(encapsulate([
        first.subarray(0, 6), first.subarray(6, 18), first.subarray(18), second
    ]), { frameCount: 2, syntax: JPEG });
    try {
        assert.deepEqual([...index.getFrame(0)], [...first]); assert.deepEqual([...index.getFrame(1)], [...second]);
    } finally { index.dispose(); }
});

test('a terminal JPEG EOI may span fragments and only its final DICOM zero padding is removed', () => {
    const frame = new Uint8Array([0xFF, 0xD8, 0xFF, 0xDA, 0, 2, 17, 0xFF, 0xD9]);
    const index = indexEncapsulatedFrames(encapsulate([frame.subarray(0, 8), frame.subarray(8)]), { frameCount: 1, syntax: JPEG });
    try { assert.deepEqual([...index.getFrame(0)], [...frame]); assert.equal(index.frames[0].byteLength, 9); }
    finally { index.dispose(); }
});

test('one FF encapsulation pad after JPEG EOI is trimmed across fragmented, BOT and EOT frames', () => {
    const frame = new Uint8Array([0xFF, 0xD8, 0xFF, 0xDA, 0, 2, 17, 0xFF, 0xD9]);
    const padded = concat([frame, new Uint8Array([0xFF])]);
    for (const [raw, options] of [
        [encapsulate([padded]), {}],
        [encapsulate([padded], [0]), {}],
        [encapsulate([frame.subarray(0, 8), padded.subarray(8)]), {}],
        [encapsulate([padded]), { extendedOffsets: [0], extendedLengths: [frame.length] }]
    ]) {
        const index = indexEncapsulatedFrames(raw, { frameCount: 1, syntax: JPEG, ...options });
        try { assert.deepEqual(index.getFrame(0), frame); assert.equal(index.frames[0].byteLength, frame.length); assert.deepEqual(index.encodingWarnings, []); }
        finally { index.dispose(); }
    }
});

test('every single JPEG alignment byte trims only the decoder view and unusual values produce one generic source notice', () => {
    const frame = new Uint8Array([0xFF, 0xD8, 0xFF, 0xDA, 0, 2, 17, 0xFF, 0xD9]);
    for (let padding = 0; padding < 256; padding++) {
        const padded = concat([frame, Uint8Array.of(padding)]);
        for (const [raw, options] of [
            [encapsulate([padded]), {}], [encapsulate([padded], [0]), {}],
            [encapsulate([padded.subarray(0, 8), padded.subarray(8)]), {}],
            [encapsulate([padded.subarray(0, 8), padded.subarray(8)], [0]), {}],
            [encapsulate([padded]), { extendedOffsets: [0], extendedLengths: [frame.length] }],
            [encapsulate([padded]), { extendedOffsets: table64([0]), extendedLengths: table64([frame.length]) }]
        ]) {
            const before = raw.slice(), index = indexEncapsulatedFrames(raw, { frameCount: 1, syntax: JPEG, ...options });
            try {
                assert.deepEqual(index.getFrame(0), frame); assert.equal(index.frames[0].byteLength, frame.length);
                assert.deepEqual(index.encodingWarnings, padding === 0 || padding === 255 ? [] : [JPEG_ALIGNMENT_WARNING]);
                assert.deepEqual(index.bytes, before); assert.deepEqual(raw, before);
            } finally { index.dispose(); }
        }
    }
});

test('multiple JPEG frames deduplicate the source compatibility notice without changing BOT boundaries or encoded lengths', () => {
    const frame = new Uint8Array([0xFF, 0xD8, 0xFF, 0xDA, 0, 2, 17, 0xFF, 0xD9]);
    const frames = [concat([frame, Uint8Array.of(17)]), concat([frame, Uint8Array.of(128)])];
    for (const [raw, options] of [[encapsulate(frames), {}], [encapsulate(frames, [0, 18]), {}],
        [encapsulate(frames), { extendedOffsets: [0, 18], extendedLengths: [9, 9] }]]) {
        const index = indexEncapsulatedFrames(raw, { frameCount: 2, syntax: JPEG, ...options });
        try { assert.deepEqual(index.encodingWarnings, [JPEG_ALIGNMENT_WARNING]); for (let indexFrame = 0; indexFrame < 2; indexFrame++) assert.deepEqual(index.getFrame(indexFrame), frame); }
        finally { index.dispose(); }
    }
});

test('JPEG padding cannot conceal extra frames, multiple bytes or excess suffix data', () => {
    const frame = new Uint8Array([0xFF, 0xD8, 0xFF, 0xDA, 0, 2, 17, 0xFF, 0xD9]);
    for (const suffix of [[0x01, 0x02], [0xFF, 0xFF, 0xFF], [0, 0, 0], [0xFF, 0xD8, 0], [...frame]]) {
        assert.throws(() => indexEncapsulatedFrames(encapsulate([concat([frame, new Uint8Array(suffix)])]),
            { frameCount: 1, syntax: JPEG }), /extra data/);
    }
    assert.throws(() => indexEncapsulatedFrames(encapsulate([new Uint8Array([1, 2, 3, 0xFF])]),
        { frameCount: 1, syntax: RLE_TRANSFER_SYNTAX, extendedOffsets: [0], extendedLengths: [3] }), /padding/);
    const even = jpeg(); assert.equal(even.length % 2, 0);
    assert.throws(() => indexEncapsulatedFrames(encapsulate([concat([even, Uint8Array.of(17)])]), { frameCount: 1, syntax: JPEG }), /extra data/);
    const padded = concat([frame, Uint8Array.of(17)]);
    assert.throws(() => indexEncapsulatedFrames(encapsulate([padded]), { frameCount: 1, syntax: JPEG,
        extendedOffsets: [0], extendedLengths: [padded.length] }), /disagree/);
    assert.throws(() => indexEncapsulatedFrames(encapsulate([padded.subarray(0, 8), padded.subarray(8)]), { frameCount: 1, syntax: JPEG,
        extendedOffsets: [0], extendedLengths: [frame.length] }), /one fragment/);
});

test('RLE with empty BOT uses exactly one fragment per frame and never scans opaque payload tags', () => {
    const payload = new Uint8Array([0xFE, 0xFF, 0, 0xE0, 0xFE, 0xFF, 0xDD, 0xE0]);
    const index = indexEncapsulatedFrames(encapsulate([payload, new Uint8Array([1, 2])]), { frameCount: 2, syntax: RLE_TRANSFER_SYNTAX });
    try { assert.deepEqual([...index.getFrame(0)], [...payload]); assert.deepEqual([...index.getFrame(1)], [1, 2]); }
    finally { index.dispose(); }
    assert.throws(() => indexEncapsulatedFrames(encapsulate([payload, payload]), { frameCount: 1, syntax: RLE_TRANSFER_SYNTAX }), /one fragment/);
    assert.throws(() => indexEncapsulatedFrames(encapsulate([payload, payload], [0]), { frameCount: 1, syntax: RLE_TRANSFER_SYNTAX }), /ambiguous/);
});

test('Extended Offset Tables validate 64-bit little-endian offsets, single fragments and lengths excluding padding', () => {
    const first = jpeg([40]), second = jpeg();
    const index = indexEncapsulatedFrames(encapsulate([first, second]), {
        frameCount: 2, syntax: JPEG, extendedOffsets: table64([0, 8 + first.length + first.length % 2]),
        extendedLengths: table64([first.length, second.length])
    });
    try { assert.deepEqual([...index.getFrame(0)], [...first]); assert.deepEqual([...index.getFrame(1)], [...second]); }
    finally { index.dispose(); }
});

for (const [label, raw, options, expected] of [
    ['missing BOT', new Uint8Array(), { frameCount: 1, syntax: JPEG }, /budget/],
    ['truncated Item header', new Uint8Array([0xFE, 0xFF]), { frameCount: 1, syntax: JPEG }, /header/],
    ['BOT without fragments', encapsulate([]), { frameCount: 1, syntax: JPEG }, /fragments are missing/],
    ['BOT count mismatch', encapsulate([jpeg()], [0, 10]), { frameCount: 1, syntax: JPEG }, /BOT count/],
    ['BOT value-start offset', encapsulate([jpeg()], [8]), { frameCount: 1, syntax: JPEG }, /fragment Item tags/],
    ['BOT duplicate offsets', encapsulate([jpeg(), jpeg()], [0, 0]), { frameCount: 2, syntax: JPEG }, /increasing/],
    ['BOT offsets outside the input', encapsulate([jpeg(), jpeg()], [0, 10000]), { frameCount: 2, syntax: JPEG }, /Item tags/],
    ['two JPEG frames in one fragment', encapsulate([concat([jpeg(), jpeg()])]), { frameCount: 2, syntax: JPEG }, /extra data/],
    ['unindexed extra JPEG frame', encapsulate([jpeg(), jpeg()]), { frameCount: 1, syntax: JPEG }, /more frames/],
    ['missing JPEG frame', encapsulate([jpeg()]), { frameCount: 2, syntax: JPEG }, /Number of Frames/],
    ['JPEG frame without EOI', encapsulate([jpeg().subarray(0, 24)]), { frameCount: 1, syntax: JPEG }, /incomplete/],
    ['BOT joining two complete JPEG frames', encapsulate([jpeg(), jpeg()], [0]), { frameCount: 1, syntax: JPEG }, /disagree/],
    ['unpaired EOT', encapsulate([jpeg()]), { frameCount: 1, syntax: JPEG, extendedOffsets: [0] }, /paired tables/],
    ['nonempty BOT with EOT', encapsulate([jpeg()], [0]), { frameCount: 1, syntax: JPEG, extendedOffsets: [0], extendedLengths: [26] }, /empty BOT/],
    ['EOT count mismatch', encapsulate([jpeg()]), { frameCount: 1, syntax: JPEG, extendedOffsets: [], extendedLengths: [26] }, /count/],
    ['EOT unsafe integer', encapsulate([jpeg()]), { frameCount: 1, syntax: JPEG, extendedOffsets: table64([2n ** 60n]), extendedLengths: [26] }, /unsafe/],
    ['EOT offset inside a fragment', encapsulate([jpeg()]), { frameCount: 1, syntax: JPEG, extendedOffsets: [8], extendedLengths: [26] }, /entry/],
    ['EOT length disagrees with codestream', encapsulate([jpeg()]), { frameCount: 1, syntax: JPEG, extendedOffsets: [0], extendedLengths: [25] }, /disagree/],
    ['fragment cap', encapsulate([jpeg(), jpeg()]), { frameCount: 2, syntax: JPEG, maxFragments: 1 }, /fragment count/],
    ['byte cap', encapsulate([jpeg()]), { frameCount: 1, syntax: JPEG, maxBytes: 1 }, /budget/],
    ['unsupported index syntax', encapsulate([jpeg()]), { frameCount: 1, syntax: '1.2.840.10008.1.2.4.201' }, /no supported frame indexer/]
]) {
    test(`malformed encapsulated data rejects clearly: ${label}`, () => assert.throws(() => indexEncapsulatedFrames(raw, options), expected));
}

test('Item lengths and sequence delimiters are validated before frame indexing', () => {
    const raw = encapsulate([jpeg()]);
    const badLength = raw.slice(); new DataView(badLength.buffer).setUint32(12, 0xFFFFFFFF, true);
    assert.throws(() => indexEncapsulatedFrames(badLength, { frameCount: 1, syntax: JPEG }), /explicit length/);
    const oddLength = raw.slice(); new DataView(oddLength.buffer).setUint32(12, 25, true);
    assert.throws(() => indexEncapsulatedFrames(oddLength, { frameCount: 1, syntax: JPEG }), /fragment length/);
    const delimiter = new Uint8Array([0xFE, 0xFF, 0xDD, 0xE0, 0, 0, 0, 0]);
    const valid = indexEncapsulatedFrames(concat([raw, delimiter]), { frameCount: 1, syntax: JPEG }); valid.dispose();
    delimiter[4] = 1;
    assert.throws(() => indexEncapsulatedFrames(concat([raw, delimiter]), { frameCount: 1, syntax: JPEG }), /delimiter/);
    assert.throws(() => indexEncapsulatedFrames(raw, { frameCount: 4097, syntax: JPEG }), /frame count/);
    assert.equal(MAX_ENCAPSULATED_BYTES, 256 * 1024 * 1024);
});

test('the index owns exact bytes, views reference only that allocation and disposal clears ownership', () => {
    const raw = encapsulate([jpeg()]);
    const index = indexEncapsulatedFrames(raw, { frameCount: 1, syntax: JPEG });
    const indexed = index.getFrame(0);
    assert.notEqual(index.bytes.buffer, raw.buffer); assert.equal(indexed.buffer, index.bytes.buffer);
    raw.fill(0); assert.equal(index.getFrame(0)[0], 0xFF);
    index.dispose(); assert.equal(index.bytes.byteLength, 0); assert.equal(index.frames.length, 0);
    assert.throws(() => index.getFrame(0), /disposed/); index.dispose();
});

test('actual EASI parsing emits complete undefined-length raw Items without the sequence delimiter', async () => {
    const frame = jpeg();
    const result = await EASI.pipelineBuilder().fromByteStream().ofDicomData()
        .withBulkDataPolicy({ mode: 'materialize', hardSafetyCap: MAX_ENCAPSULATED_BYTES }).toInstances().build().process({
        source: createEncapsulatedDicom([frame], { transferSyntax: JPEG, rows: 2, columns: 2,
            bitsAllocated: 8, bitsStored: 8, highBit: 7, photometric: 'MONOCHROME2', samplesPerPixel: 1 })
    });
    const pixels = result.first().dataSet.find(Tag.PixelData);
    assert.equal(pixels.valueLength, 0xFFFFFFFF); assert.equal(pixels.isComplete, true);
    const index = indexEncapsulatedFrames(pixels, { frameCount: 1, syntax: JPEG });
    pixels.clear();
    try { assert.deepEqual([...index.getFrame(0)], [...frame]); }
    finally { index.dispose(); }
});

test('JPEG-LS entropy bit stuffing accepts bytes below 0x80 after FF without inventing a frame boundary', () => {
    const frame = Uint8Array.of(0xFF, 0xD8, 0xFF, 0xF7, 0, 2, 0xFF, 0xDA, 0, 2,
        10, 0xFF, 0x40, 0xFF, 0x7F, 17, 0xFF, 0xD9);
    for (const syntax of ['1.2.840.10008.1.2.4.80', '1.2.840.10008.1.2.4.81']) {
        const index = indexEncapsulatedFrames(encapsulate([frame, frame]), { frameCount: 2, syntax });
        try { assert.deepEqual([...index.getFrame(0)], [...frame]); assert.deepEqual([...index.getFrame(1)], [...frame]); }
        finally { index.dispose(); }
    }
    assert.throws(() => indexEncapsulatedFrames(encapsulate([frame]), { frameCount: 1, syntax: JPEG }), /unexpected marker/);
});

test('JPEG 2000 permits indexed fragmented frames and unambiguous empty-BOT one-fragment frames', () => {
    const frame = Uint8Array.of(0xFF, 0x4F, 0xFF, 0x64, 0, 6, 0xFF, 0xD9, 0xFF, 0x4F,
        0xFF, 0x90, 0, 10, 0, 0, 0, 0, 0, 20, 0, 1, 0xFF, 0x93, 17, 18, 0xFF, 0xD9, 0xFF, 0x4F, 0xFF, 0xD9);
    for (const syntax of ['1.2.840.10008.1.2.4.90', '1.2.840.10008.1.2.4.91']) {
        const empty = indexEncapsulatedFrames(encapsulate([frame, frame]), { frameCount: 2, syntax });
        try { assert.deepEqual([...empty.getFrame(1)], [...frame]); } finally { empty.dispose(); }
        const indexed = indexEncapsulatedFrames(encapsulate([frame.subarray(0, 4), frame.subarray(4), frame], [0, 48]), { frameCount: 2, syntax });
        try { assert.equal(indexed.frames[0].fragments.length, 2); assert.deepEqual([...indexed.getFrame(0)], [...frame]); }
        finally { indexed.dispose(); }
        assert.throws(() => indexEncapsulatedFrames(encapsulate([frame.subarray(0, 4), frame.subarray(4)]), { frameCount: 1, syntax }), /one fragment/);
        assert.throws(() => indexEncapsulatedFrames(encapsulate([Uint8Array.of(0xFF, 0xD8, 0xFF, 0xD9)]), { frameCount: 1, syntax }), /SOC/);
        assert.throws(() => indexEncapsulatedFrames(encapsulate([frame.subarray(0, 8)]), { frameCount: 1, syntax }), /marker length exceeds its boundary/);
        assert.throws(() => indexEncapsulatedFrames(encapsulate([frame, frame], [0]), { frameCount: 1, syntax }), /EOC occurs before/);
        assert.throws(() => indexEncapsulatedFrames(encapsulate([concat([frame, frame])]), { frameCount: 1, syntax }), /EOC occurs before/);
        const unbounded = frame.slice(); unbounded.fill(0, 16, 20);
        assert.throws(() => indexEncapsulatedFrames(encapsulate([unbounded]), { frameCount: 1, syntax }), /packet data/);
    }
});

test('JPEG 2000 final Psot zero respects stuffed packet bytes, SOP payload lengths and EPH markers', () => {
    const syntax = '1.2.840.10008.1.2.4.90';
    const prefix = Uint8Array.of(0xFF, 0x4F, 0xFF, 0x64, 0, 6, 0xFF, 0xD9, 0xFF, 0x4F,
        0xFF, 0x90, 0, 10, 0, 0, 0, 0, 0, 0, 0, 1, 0xFF, 0x93);
    const packets = Uint8Array.of(17, 0xFF, 0x7F, 0xFF, 0x8F, 0xFF, 0x91, 0, 4, 0xFF, 0xD9,
        18, 0xFF, 0x92, 19);
    const frame = concat([prefix, packets, Uint8Array.of(0xFF, 0xD9)]);
    const index = indexEncapsulatedFrames(encapsulate([frame.subarray(0, 30), frame.subarray(30)], [0]), { frameCount: 1, syntax });
    try { assert.deepEqual([...index.getFrame(0)], [...frame]); } finally { index.dispose(); }
    for (const marker of [0x90, 0x93, 0xD9, 0xFF]) {
        assert.throws(() => indexEncapsulatedFrames(encapsulate([concat([prefix, Uint8Array.of(0xFF, marker), packets,
            Uint8Array.of(0xFF, 0xD9)])]), { frameCount: 1, syntax }), /packet data/);
    }
    const malformedSop = packets.slice(); malformedSop[8] = 3;
    assert.throws(() => indexEncapsulatedFrames(encapsulate([concat([prefix, malformedSop, Uint8Array.of(0xFF, 0xD9)])]),
        { frameCount: 1, syntax }), /SOP length/);
    assert.throws(() => indexEncapsulatedFrames(encapsulate([concat([frame, frame])]), { frameCount: 1, syntax }), /packet data/);
});

test('real synthetic JPEG 2000 permits a final Psot zero without changing compressed frame bytes', async () => {
    const generated = await createCompressedDicom({ codec: 'jpeg2000', rows: 8, columns: 8,
        frameSamples: [Array.from({ length: 64 }, (_, index) => index)] });
    const frame = generated.frames[0].slice();
    const view = new DataView(frame.buffer);
    let marker = 2;
    while (frame[marker + 1] !== 0x90) marker += 2 + view.getUint16(marker + 2);
    assert.equal(frame[marker], 0xFF);
    view.setUint32(marker + 6, 0);
    const index = indexEncapsulatedFrames(encapsulate([frame]), { frameCount: 1, syntax: generated.metadata.transferSyntax });
    try { assert.deepEqual([...index.getFrame(0)], [...frame]); } finally { index.dispose(); }
});

test('real synthetic JPEG 2000 BOT, empty BOT and EOT frames retain exact generated codestreams', async () => {
    for (const configuration of [{ bot: true, fragmentsPerFrame: 2 }, { bot: false, fragmentsPerFrame: 1 },
        { extendedOffsets: true, fragmentsPerFrame: 1 }]) {
        const generated = await createCompressedDicom({ codec: 'jpeg2000', rows: 8, columns: 8,
            frameSamples: [Array.from({ length: 64 }, (_, index) => index), Array.from({ length: 64 }, (_, index) => index + 100)],
            ...configuration });
        const result = await EASI.pipelineBuilder().fromByteStream().ofDicomData()
            .withBulkDataPolicy({ mode: 'materialize', hardSafetyCap: MAX_ENCAPSULATED_BYTES }).toInstances().build()
            .process({ source: generated.bytes });
        const dataset = result.first().dataSet;
        const index = indexEncapsulatedFrames(dataset.find(Tag.PixelData), { frameCount: 2, syntax: generated.metadata.transferSyntax,
            extendedOffsets: dataset.find(Tag.ExtendedOffsetTable), extendedLengths: dataset.find(Tag.ExtendedOffsetTableLengths) });
        try {
            assert.deepEqual([...index.getFrame(0)], [...generated.frames[0]]);
            assert.deepEqual([...index.getFrame(1)], [...generated.frames[1]]);
        } finally { index.dispose(); }
    }
});
