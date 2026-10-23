import test from 'node:test';
import assert from 'node:assert/strict';
import EASI, { Tag } from '@xinonix/easi-js';
import { createDicomFixture } from '../src/data/synthetic.js';
import { normalizePresentation, evaluateModality, storedToDisplay, normalizeVoi, paletteToRgb,
    MAX_LUT_ENTRIES, MAX_PALETTE_PIXELS } from '../src/data/presentation.js';

const textEncoder = new TextEncoder();
function concat(parts) {
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let position = 0;
    for (const part of parts) { bytes.set(part, position); position += part.length; }
    return bytes;
}
function words(values, littleEndian = true) {
    const bytes = new Uint8Array(values.length * 2);
    const view = new DataView(bytes.buffer);
    values.forEach((value, index) => view.setUint16(index * 2, value & 65535, littleEndian));
    return bytes;
}
function element(id, vr, bytes, littleEndian = true) {
    if (typeof bytes === 'string') bytes = textEncoder.encode(bytes);
    if (bytes.length % 2) bytes = concat([bytes, Uint8Array.of(32)]);
    const long = ['SQ', 'OW'].includes(vr);
    const header = new Uint8Array(long ? 12 : 8);
    const view = new DataView(header.buffer);
    view.setUint16(0, parseInt(id.slice(0, 4), 16), littleEndian);
    view.setUint16(2, parseInt(id.slice(4), 16), littleEndian);
    header.set(textEncoder.encode(vr), 4);
    if (long) view.setUint32(8, bytes.length, littleEndian);
    else view.setUint16(6, bytes.length, littleEndian);
    return concat([header, bytes]);
}
function item(attributes, littleEndian = true) {
    const data = concat(attributes);
    const header = new Uint8Array(8);
    const view = new DataView(header.buffer);
    view.setUint16(0, 0xFFFE, littleEndian); view.setUint16(2, 0xE000, littleEndian);
    view.setUint32(4, data.length, littleEndian);
    return concat([header, data]);
}
function lutItem({ entries = [0, 128, 255], descriptor = [entries.length, 0, 8], signed = false,
    littleEndian = true, dataVr = 'US', rawData = null, modality = false } = {}) {
    return item([
        element('00283002', signed ? 'SS' : 'US', words(descriptor, littleEndian), littleEndian),
        element('00283003', 'LO', 'Independent synthetic LUT', littleEndian),
        ...(modality ? [element('00283004', 'LO', 'HU', littleEndian)] : []),
        element('00283006', dataVr, rawData ?? words(entries, littleEndian), littleEndian)
    ], littleEndian);
}
function jsonElement(vr, ...Value) { return { vr, Value }; }
function jsonLut({ entries = [0, 128, 255], descriptor = [entries.length, 0, 8], signed = false,
    modality = false, data = null } = {}) {
    return {
        '00283002': jsonElement(signed ? 'SS' : 'US', ...descriptor),
        '00283003': jsonElement('LO', 'Independent synthetic LUT'),
        ...(modality ? { '00283004': jsonElement('LO', 'HU') } : {}),
        '00283006': data ?? jsonElement('US', ...entries)
    };
}
async function parseJson(attributes = {}) {
    const result = await EASI.pipelineBuilder().fromByteStream().ofDicomMetadata().toInstances().build().process({
        source: textEncoder.encode(JSON.stringify([{ '00280004': jsonElement('CS', 'MONOCHROME2'),
            '00280101': jsonElement('US', 16), '00280103': jsonElement('US', 0), ...attributes }]))
    });
    return result.first().dataSet;
}
async function parseBinary(attributes = {}, options = {}) {
    const bytes = createDicomFixture({ ...options, extraAttributes: { '00281052': null, '00281053': null,
        '00281054': null, ...attributes } });
    const result = await EASI.pipelineBuilder().fromByteStream().ofDicomData()
        .withBulkDataPolicy({ mode: 'materialize', hardSafetyCap: 1024 * 1024 }).toInstances().build().process({ source: bytes });
    return result.first().dataSet;
}

test('JSON modality LUT preserves signed stored samples and returns independent unsigned modality values', async () => {
    const set = await parseJson({ '00280103': jsonElement('US', 1),
        '00283000': jsonElement('SQ', jsonLut({ entries: [0, 900, 1200, 65535], descriptor: [4, -2, 16], signed: true, modality: true })) });
    const presentation = normalizePresentation(set, { signed: true });
    assert.equal(presentation.modalityLut.count, 4); assert.equal(presentation.modalityLut.firstMapped, -2);
    assert.equal(presentation.unit, 'HU');
    const samples = Int16Array.of(-100, -2, -1, 0, 1, 100);
    assert.deepEqual([...samples].map(stored => evaluateModality(stored, presentation)), [0, 0, 900, 1200, 65535, 65535]);
    assert.deepEqual([...samples], [-100, -2, -1, 0, 1, 100]);
});

for (const littleEndian of [true, false]) {
    test(`binary SQ signed descriptors and 16-bit LUT data use ${littleEndian ? 'little' : 'big'} endian byte order`, async () => {
        const set = await parseBinary({ '00283000': ['SQ', lutItem({ entries: [0, 30000, 65535], descriptor: [3, -1, 16],
            signed: true, modality: true, littleEndian, dataVr: 'OW' })] },
        { signed: true, transferSyntax: littleEndian ? '1.2.840.10008.1.2.1' : '1.2.840.10008.1.2.2' });
        const presentation = normalizePresentation(set, { signed: true, littleEndian });
        assert.deepEqual([...presentation.modalityLut.entries], [0, 30000, 65535]);
        assert.equal(presentation.modalityLut.firstMapped, -1);
        set.find(Tag.ModalityLUTSequence).items[0].find(Tag.LUTData).clear();
        assert.equal(evaluateModality(0, presentation), 30000);
    });

    test(`8-bit OW packed and zero-padded 16-bit LUT entries normalize identically (${littleEndian ? 'LE' : 'BE'})`, async () => {
        const packed = littleEndian ? Uint8Array.of(10, 128, 255, 0) : Uint8Array.of(128, 10, 0, 255);
        for (const [dataVr, rawData] of [['OW', packed], ['OW', words([10, 128, 255], littleEndian)], ['US', words([10, 128, 255], littleEndian)]]) {
            const set = await parseBinary({ '00283010': ['SQ', lutItem({ entries: [10, 128, 255], dataVr, rawData, littleEndian })] },
                { transferSyntax: littleEndian ? '1.2.840.10008.1.2.1' : '1.2.840.10008.1.2.2' });
            assert.deepEqual([...normalizePresentation(set, { littleEndian }).voiLut.entries], [10, 128, 255]);
        }
    });
}

test('zero descriptor count represents all 65,536 LUT entries without signed first/third words', async () => {
    const values = Array.from({ length: MAX_LUT_ENTRIES }, (_, index) => index);
    const set = await parseJson({ '00283010': jsonElement('SQ', jsonLut({ entries: values, descriptor: [0, 0, 16] })) });
    const presentation = normalizePresentation(set);
    assert.equal(presentation.voiLut.count, 65536); assert.equal(presentation.voiLut.entries.length, 65536);
    assert.equal(storedToDisplay(0, presentation), 0); assert.equal(storedToDisplay(65535, presentation), 1);
});

test('binary SS descriptors interpret a large first word as unsigned and only the second word as signed', async () => {
    const values = Array.from({ length: 32768 }, (_, index) => index);
    const set = await parseBinary({ '00283010': ['SQ', lutItem({ entries: values, descriptor: [32768, -32768, 16], signed: true, dataVr: 'OW' })] }, { signed: true });
    const presentation = normalizePresentation(set, { signed: true });
    assert.equal(presentation.voiLut.count, 32768); assert.equal(presentation.voiLut.firstMapped, -32768);
    assert.equal(presentation.voiLut.entries[32767], 32767);
});

test('VOI applies only the first alternative and normalizes against declared output precision', async () => {
    const set = await parseJson({ '00283010': jsonElement('SQ', jsonLut({ entries: [64, 128, 192] }), jsonLut({ entries: [255, 0, 0] })),
        '00281050': jsonElement('DS', 1, 20), '00281051': jsonElement('DS', 3, 10) });
    const presentation = normalizePresentation(set);
    assert.equal(presentation.voiMode, 'lut');
    assert.equal(storedToDisplay(-50, presentation), 64 / 255);
    assert.equal(storedToDisplay(1, presentation), 128 / 255);
    assert.equal(storedToDisplay(50, presentation), 192 / 255);
    assert.equal(storedToDisplay(1, presentation, { voiMode: 'window' }), 0.75);
    assert.deepEqual(presentation.window, { center: 1, width: 3 });
});

test('signed VOI input follows negative modality rescale output rather than unsigned pixel representation', async () => {
    const set = await parseJson({ '00281052': jsonElement('DS', -2), '00281053': jsonElement('DS', 1),
        '00283010': jsonElement('SQ', jsonLut({ entries: [0, 128, 255], descriptor: [3, -2, 8], signed: true })) });
    const presentation = normalizePresentation(set, { signed: false, bitsStored: 16 });
    assert.equal(storedToDisplay(0, presentation), 0); assert.equal(storedToDisplay(1, presentation), 128 / 255);
});

test('modality LUT output feeds an unsigned VOI LUT without applying rescale twice', async () => {
    const set = await parseJson({ '00280103': jsonElement('US', 1),
        '00283000': jsonElement('SQ', jsonLut({ entries: [0, 1, 2], descriptor: [3, -1, 8], signed: true, modality: true })),
        '00283010': jsonElement('SQ', jsonLut({ entries: [0, 128, 255] })) });
    const presentation = normalizePresentation(set, { signed: true });
    assert.equal(storedToDisplay(-1, presentation), 0); assert.equal(storedToDisplay(0, presentation), 128 / 255);
    assert.equal(storedToDisplay(1, presentation), 1);
});

test('LINEAR, LINEAR_EXACT and SIGMOID use independent numeric reference points and strict widths', () => {
    const presentation = { window: { center: 0, width: 100 }, voiFunction: 'LINEAR', slope: 1, intercept: 0, presentationInvert: false };
    assert.equal(storedToDisplay(-50, presentation), 0); assert.equal(storedToDisplay(49, presentation), 1);
    assert.equal(storedToDisplay(-0.5, presentation), 0.5);
    presentation.voiFunction = 'LINEAR_EXACT';
    assert.equal(storedToDisplay(-50, presentation), 0); assert.equal(storedToDisplay(50, presentation), 1);
    assert.equal(storedToDisplay(0, presentation), 0.5);
    presentation.voiFunction = 'SIGMOID';
    assert.equal(storedToDisplay(0, presentation), 0.5);
    assert.ok(Math.abs(storedToDisplay(25, presentation) - 0.7310585786300049) < 1e-15);
    assert.equal(storedToDisplay(-1e300, presentation), 0); assert.equal(storedToDisplay(1e300, presentation), 1);
    assert.deepEqual(normalizeVoi(0, 0.25, 'SIGMOID'), { center: 0, width: 0.25, voiFunction: 'SIGMOID' });
    for (const fn of ['LINEAR', 'LINEAR_EXACT', 'SIGMOID', 'UNSUPPORTED']) {
        assert.throws(() => normalizeVoi(0, 0, fn), /window values/);
        assert.throws(() => normalizeVoi(NaN, 1, fn), /window values/);
    }
    assert.throws(() => normalizeVoi(0, 0.5, 'LINEAR'), /window values/);
});

test('image shape and MONOCHROME1 supply one final inversion, with a reversible user override', async () => {
    for (const shape of [null, 'INVERSE']) {
        const set = await parseJson({ '00280004': jsonElement('CS', 'MONOCHROME1'), '00281050': jsonElement('DS', 128),
            '00281051': jsonElement('DS', 256), ...(shape ? { '20500020': jsonElement('CS', shape) } : {}) });
        const presentation = normalizePresentation(set);
        assert.equal(presentation.presentationInvert, true);
        assert.equal(storedToDisplay(0, presentation), 1); assert.equal(storedToDisplay(255, presentation), 0);
        assert.equal(storedToDisplay(0, presentation, { invert: true }), 0);
    }
    const set = await parseJson({ '20500020': jsonElement('CS', 'IDENTITY') });
    assert.equal(normalizePresentation(set).presentationInvert, false);
});

async function paletteSet({ bits = 8, firstMapped = 0, signed = false, channels = [[0, 255, 128], [255, 0, 64], [64, 128, 255]], extra = {} } = {}) {
    const attrs = { '00280004': jsonElement('CS', 'PALETTE COLOR'), '00280103': jsonElement('US', signed ? 1 : 0) };
    for (let index = 0; index < 3; index++) {
        attrs[`0028110${index + 1}`] = jsonElement(signed ? 'SS' : 'US', channels[index].length, firstMapped, bits);
        attrs[`0028120${index + 1}`] = { vr: 'OW', InlineBinary: Buffer.from(words(channels[index])).toString('base64') };
    }
    return parseJson({ ...attrs, ...extra });
}

test('direct 8-bit palette produces display RGB while retaining original signed indices and clamped endpoints', async () => {
    const set = await paletteSet({ firstMapped: -1, signed: true });
    const palette = normalizePresentation(set, { signed: true }).palette;
    const indices = Int16Array.of(-100, -1, 0, 1, 100);
    assert.deepEqual([...paletteToRgb(indices, palette)], [0, 255, 64, 0, 255, 64, 255, 0, 128, 128, 64, 255, 128, 64, 255]);
    assert.deepEqual([...indices], [-100, -1, 0, 1, 100]);
});

test('16-bit palette display uses the full declared intensity range without rescaling an observed subset', async () => {
    const set = await paletteSet({ bits: 16, channels: [[0, 65535, 32768], [65535, 0, 257], [257, 32768, 65535]] });
    const presentation = normalizePresentation(set);
    assert.deepEqual([...paletteToRgb(Uint16Array.of(0, 1, 2), presentation.palette)], [0, 255, 1, 255, 0, 128, 128, 1, 255]);
    assert.equal(presentation.window, null);
});

test('external metadata-only LUT descriptors remain pending and never turn into identity tables', async () => {
    const data = { vr: 'OW', BulkDataURI: 'https://archive.example.test/table' };
    const set = await parseJson({ '00283010': jsonElement('SQ', jsonLut({ data })) });
    const presentation = normalizePresentation(set, { metadataOnly: true });
    assert.equal(presentation.voiLut.entries, null); assert.equal(presentation.voiLut.pending, true);
    assert.equal(JSON.stringify(presentation).includes('archive.example'), false);
    assert.throws(() => storedToDisplay(1, presentation), /unavailable/);
    assert.throws(() => normalizePresentation(set), /numeric data/);
});

test('external metadata-only palette channels stay unresolved and cannot produce guessed colors', async () => {
    const set = await paletteSet({ extra: {
        '00281201': { vr: 'OW', BulkDataURI: 'https://archive.example.test/red' },
        '00281202': { vr: 'OW', BulkDataURI: 'https://archive.example.test/green' },
        '00281203': { vr: 'OW', BulkDataURI: 'https://archive.example.test/blue' }
    } });
    const palette = normalizePresentation(set, { metadataOnly: true }).palette;
    assert.equal(palette.pending, true); assert.equal(palette.red, null);
    assert.throws(() => paletteToRgb(Uint16Array.of(0), palette), /unavailable/);
    assert.equal(JSON.stringify(palette).includes('archive.example'), false);
});

test('palette conversion bounds output before allocation and modality results remain finite', async () => {
    const palette = normalizePresentation(await paletteSet()).palette;
    assert.throws(() => paletteToRgb(new Uint8Array(MAX_PALETTE_PIXELS + 1), palette), /unavailable/);
    assert.throws(() => evaluateModality(65535, { slope: Number.MAX_VALUE }), /not finite/);
    assert.throws(() => evaluateModality(1, { slope: 0 }), /rescale/);
    const set = await parseJson({ '00281052': jsonElement('DS', 0), '00281053': jsonElement('DS', Number.MAX_VALUE) });
    assert.throws(() => normalizePresentation(set), /not finite/);
});

test('a per-instance LUT cache reuses shared complete tables across varying frame presentation tuples', async () => {
    const set = await parseJson({ '00283010': jsonElement('SQ', jsonLut({ entries: [0, 128, 255] })) });
    const lutCache = new WeakMap();
    const first = normalizePresentation(set, { lutCache, slope: 1, intercept: 0 });
    for (let frame = 1; frame <= 4096; frame++) {
        const next = normalizePresentation(set, { lutCache, slope: 1 + frame, intercept: 0 });
        assert.equal(next.voiLut, first.voiLut);
        assert.equal(next.voiLut.entries, first.voiLut.entries);
        assert.equal(next.slope, 1 + frame);
    }
    assert.equal(Object.isFrozen(first.voiLut), true);
    const separate = normalizePresentation(set, { lutCache: new WeakMap() });
    assert.notEqual(separate.voiLut.entries, first.voiLut.entries);
    assert.throws(() => normalizePresentation(set, { lutCache: {} }), /Map or WeakMap/);
});

test('cache variants retain signedness, byte-order and pending-metadata validation', async () => {
    const set = await parseBinary({ '00283010': ['SQ', lutItem({ signed: true, descriptor: [3, -1, 8] })] }, { signed: true });
    const lutCache = new Map();
    const first = normalizePresentation(set, { lutCache, signed: true, littleEndian: true });
    assert.equal(normalizePresentation(set, { lutCache, signed: true, littleEndian: true }).voiLut, first.voiLut);
    assert.throws(() => normalizePresentation(set, { lutCache, signed: false }), /descriptor VR/);
    assert.throws(() => normalizePresentation(set, { lutCache, signed: true, littleEndian: false }), /precision/);
    const pending = await parseJson({ '00283010': jsonElement('SQ', jsonLut({ data: { vr: 'OW', BulkDataURI: 'https://archive.example.test/lut' } })) });
    assert.equal(normalizePresentation(pending, { lutCache, metadataOnly: true }).voiLut.pending, true);
    assert.throws(() => normalizePresentation(pending, { lutCache, metadataOnly: false }), /numeric data/);
});

test('palette channel arrays reuse the same immutable metadata attributes without cloning per frame', async () => {
    const set = await paletteSet({ bits: 16, channels: [[0, 65535, 32768], [65535, 0, 257], [257, 32768, 65535]] });
    const lutCache = new WeakMap();
    const first = normalizePresentation(set, { lutCache });
    const second = normalizePresentation(set, { lutCache });
    assert.equal(second.palette.red, first.palette.red); assert.equal(second.palette.green, first.palette.green);
    assert.equal(second.palette.blue, first.palette.blue);
});

for (const [label, attrs, expected] of [
    ['rescale and modality LUT conflict', { '00281052': jsonElement('DS', 0), '00281053': jsonElement('DS', 1), '00283000': jsonElement('SQ', jsonLut({ modality: true })) }, /cannot both/],
    ['missing rescale intercept', { '00281053': jsonElement('DS', 1) }, /both slope and intercept/],
    ['multiple modality items', { '00283000': jsonElement('SQ', jsonLut({ modality: true }), jsonLut({ modality: true })) }, /selected item/],
    ['empty VOI sequence', { '00283010': jsonElement('SQ') }, /selected item/],
    ['missing LUT descriptor', { '00283010': jsonElement('SQ', { '00283006': jsonElement('US', 0, 128, 255) }) }, /descriptor is missing/],
    ['invalid precision', { '00283010': jsonElement('SQ', jsonLut({ descriptor: [3, 0, 12] })) }, /precision/],
    ['short LUT data', { '00283010': jsonElement('SQ', jsonLut({ descriptor: [4, 0, 8] })) }, /does not match/],
    ['8-bit numeric entry overflow', { '00283010': jsonElement('SQ', jsonLut({ entries: [0, 256, 1] })) }, /does not match/],
    ['negative unsigned first mapped', { '00283010': jsonElement('SQ', jsonLut({ descriptor: [3, -1, 8] })) }, /range/],
    ['fractional rescale with VOI LUT', { '00281052': jsonElement('DS', 0), '00281053': jsonElement('DS', 0.5), '00283010': jsonElement('SQ', jsonLut()) }, /quantization profile/],
    ['real-world value mapping', { '00409096': jsonElement('SQ', {}) }, /real-world/],
    ['presentation sequence', { '20500010': jsonElement('SQ', jsonLut()) }, /Presentation LUT Sequence/],
    ['contradictory MONOCHROME1 shape', { '00280004': jsonElement('CS', 'MONOCHROME1'), '20500020': jsonElement('CS', 'IDENTITY') }, /conflicts/],
    ['contradictory MONOCHROME2 inverse', { '20500020': jsonElement('CS', 'INVERSE') }, /conflicts/],
    ['invalid VOI function', { '00281056': jsonElement('CS', 'LOG') }, /Function/],
    ['window multiplicity mismatch', { '00281050': jsonElement('DS', 1, 2), '00281051': jsonElement('DS', 2) }, /multiplicities/],
    ['SIGMOID zero width', { '00281056': jsonElement('CS', 'SIGMOID'), '00281050': jsonElement('DS', 0), '00281051': jsonElement('DS', 0) }, /window values/]
]) {
    test(`unsupported or malformed presentation rejects explicitly: ${label}`, async () => {
        const set = await parseJson(attrs);
        assert.throws(() => normalizePresentation(set), expected);
    });
}

test('binary 8-in-16 high-byte values and nonzero packed padding reject without guessing byte alignment', async () => {
    for (const [rawData, expected] of [[words([0, 0x8000, 255]), /high bits/], [Uint8Array.of(0, 128, 255, 1), /padding/]]) {
        const set = await parseBinary({ '00283010': ['SQ', lutItem({ dataVr: 'OW', rawData })] });
        assert.throws(() => normalizePresentation(set), expected);
    }
});

test('binary explicit descriptor signedness conflicts are rejected instead of reinterpreting a US value', async () => {
    const set = await parseBinary({ '00283010': ['SQ', lutItem({ signed: false })] }, { signed: true });
    assert.throws(() => normalizePresentation(set, { signed: true }), /descriptor VR/);
});

test('palette mismatches, alpha/segmented profiles and scalar transforms fail explicitly', async () => {
    for (const extra of [
        { '00281102': jsonElement('US', 3, 1, 8) },
        { '00281221': { vr: 'OW', InlineBinary: 'AAAAAA==' } },
        { '00281104': jsonElement('US', 3, 0, 8) },
        { '00281050': jsonElement('DS', 1), '00281051': jsonElement('DS', 3) },
        { '00281052': jsonElement('DS', 0), '00281053': jsonElement('DS', 2) }
    ]) {
        const set = await paletteSet({ extra });
        assert.throws(() => normalizePresentation(set), /palette|Palette/);
    }
});
