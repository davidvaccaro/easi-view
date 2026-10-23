import test from 'node:test';
import assert from 'node:assert/strict';
import EASI, { Tag } from '@xinonix/easi-js';
import { createDicomFixture } from '../src/data/synthetic.js';
import { loadFiles } from '../src/data/sources.js';
import { SC_WORD_SOP_CLASS, resolveScWordSpatialFrames } from '../src/data/sc-word-spatial.js';
import { DicomWebClient } from '../src/data/DicomWebClient.js';
import { frameGeometry } from '../src/volume/geometry.js';
function concatenate(parts) {
    const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return bytes;
}

// This independent recursive sequence writer is intentionally separate from
// the normalizer and from EASI's parser. All image pixels are generated.
function encodeElement(id, vr, value, { littleEndian = true, implicit = false } = {}) {
    let body;
    if (vr === 'SQ') body = encodeItems(value, { littleEndian, implicit });
    else if (['US', 'UL', 'FD', 'FL', 'AT'].includes(vr)) {
        const values = Array.isArray(value) ? value : [value];
        const width = { US: 2, UL: 4, FD: 8, FL: 4, AT: 4 }[vr];
        body = new Uint8Array(values.length * width);
        const view = new DataView(body.buffer);
        for (let index = 0; index < values.length; index++) {
            if (vr === 'AT') {
                view.setUint16(index * 4, parseInt(values[index].slice(0, 4), 16), littleEndian);
                view.setUint16(index * 4 + 2, parseInt(values[index].slice(4), 16), littleEndian);
            } else view[{ US: 'setUint16', UL: 'setUint32', FD: 'setFloat64', FL: 'setFloat32' }[vr]](index * width, values[index], littleEndian);
        }
    } else {
        body = new TextEncoder().encode(Array.isArray(value) ? value.join('\\') : String(value));
        if (body.length % 2) body = concatenate([body, Uint8Array.of(vr === 'UI' ? 0 : 32)]);
    }
    const long = !implicit && vr === 'SQ';
    const header = new Uint8Array(long ? 12 : 8);
    const view = new DataView(header.buffer);
    view.setUint16(0, parseInt(id.slice(0, 4), 16), littleEndian);
    view.setUint16(2, parseInt(id.slice(4), 16), littleEndian);
    if (implicit) view.setUint32(4, body.length, littleEndian);
    else {
        header.set(new TextEncoder().encode(vr), 4);
        if (long) view.setUint32(8, body.length, littleEndian);
        else view.setUint16(6, body.length, littleEndian);
    }
    return concatenate([header, body]);
}

function encodeItems(items, options = {}) {
    return concatenate(items.map(item => {
        const contents = concatenate(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
            .map(([id, [vr, value]]) => encodeElement(id, vr, value, options)));
        const header = new Uint8Array(8);
        const view = new DataView(header.buffer);
        view.setUint16(0, 0xFFFE, options.littleEndian ?? true);
        view.setUint16(2, 0xE000, options.littleEndian ?? true);
        view.setUint32(4, contents.length, options.littleEndian ?? true);
        return concatenate([header, contents]);
    }));
}


const sq = value => ['SQ', encodeItems([value])];
function generated({ sharedExtra = {}, perFrame, extraAttributes = {}, ...options } = {}) {
    const encoding = { littleEndian: options.transferSyntax !== '1.2.840.10008.1.2.2', implicit: options.transferSyntax === '1.2.840.10008.1.2' };
    const shared = { '00289110': ['SQ', [{ '00280030': ['DS', [0.5, 0.75]], '00180050': ['DS', 2] }]],
        '00209116': ['SQ', [{ '00200037': ['DS', [1, 0, 0, 0, 1, 0]] }]], ...sharedExtra };
    const positions = perFrame ?? [4, 0, 2].map(z => ({ '00209113': ['SQ', [{ '00200032': ['DS', [10, 20, z]] }]] }));
    return new File([createDicomFixture({ sopClass: SC_WORD_SOP_CLASS, modality: 'OT', bitsStored: 16, highBit: 15,
        frames: 3, rows: 2, columns: 2, values: Array.from({ length: 12 }, (_, index) => index),
        slope: 2, intercept: 10, ...options, extraAttributes: { '00200052': ['UI', '2.25.987654'], '00280009': null, '00181063': null,
            '52009229': ['SQ', encodeItems([shared], encoding)], '52009230': ['SQ', encodeItems(positions, encoding)], ...extraAttributes }
    })], 'generated-sc.dcm');
}

test('SC spatial macros retain independent patient planes, source frames, source SOP, top-level transforms, and 2D-only scope', async () => {
    let sourceClass;
    const sources = await loadFiles([generated()], { onInstance: instance => { sourceClass = instance.dataSet.value(Tag.find('00080016')); } });
    try {
        assert.equal(sourceClass, SC_WORD_SOP_CLASS); assert.equal(sources.length, 1);
        assert.deepEqual(sources[0].frames.map(frame => frame.frameIndex), [1, 2, 0]);
        for (let index = 0; index < 3; index++) {
            const frame = await sources[0].getFrame(index), original = [1, 2, 0][index];
            assert.deepEqual(frame.position, [10, 20, [4, 0, 2][original]]);
            assert.deepEqual(frame.orientation, [1, 0, 0, 0, 1, 0]); assert.deepEqual(frame.pixelSpacing, [0.5, 0.75]);
            assert.deepEqual([...frame.samples], [0, 1, 2, 3].map(value => original * 4 + value));
            assert.equal(frame.slope, 2); assert.equal(frame.intercept, 10); assert.equal(frame.timingMode, 'none');
            assert.equal(frame.dimensions.spatialEligible, false); assert.throws(() => frameGeometry(frame), /ineligible/);
        }
    } finally { sources.forEach(source => source.dispose()); }
});

for (const [name, options] of [
    ['unknown functional-group macro', { sharedExtra: { '00289145': ['SQ', [{ '00281053': ['DS', 1] }]] } }],
    ['missing required companion macro', { sharedExtra: { '00209116': ['SQ', []] } }],
    ['wrong geometry VR', { sharedExtra: { '00289110': ['SQ', [{ '00280030': ['LO', '0.5\\0.75'] }]] } }],
    ['unknown geometry attribute', { sharedExtra: { '00289110': ['SQ', [{ '00280030': ['DS', [1, 1]], '00281053': ['DS', 2] }]] } }],
    ['nonorthogonal plane', { sharedExtra: { '00209116': ['SQ', [{ '00200037': ['DS', [1, 0, 0, 1, 0, 0]] }]] } }],
    ['negative spacing', { sharedExtra: { '00289110': ['SQ', [{ '00280030': ['DS', [-1, 1]] }]] } }],
    ['per-frame count mismatch', { perFrame: [{ '00209113': ['SQ', [{ '00200032': ['DS', [0, 0, 0]] }]] }] }],
    ['shared/per-frame duplicate', { sharedExtra: { '00209113': ['SQ', [{ '00200032': ['DS', [0, 0, 0]] }]] } }],
    ['unresolved dimension organization', { extraAttributes: { '00209221': ['SQ', encodeItems([])] } }],
    ['multi-VM BitsStored', { extraAttributes: { '00280101': ['US', [16, 8]] } }],
    ['wrong BitsStored VR', { extraAttributes: { '00280101': ['DS', '16'] } }],
    ['multi-VM Rows', { extraAttributes: { '00280010': ['US', [2, 3]] } }],
    ['signed pixels', { signed: true }], ['partial stored word', { bitsStored: 12, highBit: 11 }],
    ['MONOCHROME1', { photometric: 'MONOCHROME1' }]
]) test(`SC spatial-only profile rejects ${name}`, async () => assert.rejects(loadFiles([generated(options)]), /SC spatial functional groups|Invalid native image dimensions or pixel metadata/));

for (const transferSyntax of ['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']) {
    test(`SC spatial-only native syntax retains frame samples and source geometry (${transferSyntax})`, async () => {
        const sources = await loadFiles([generated({ transferSyntax })]);
        try {
            const frame = await sources[0].getFrame(0);
            assert.equal(frame.transferSyntax, transferSyntax); assert.deepEqual([...frame.samples], [4, 5, 6, 7]);
            assert.deepEqual(frame.position, [10, 20, 0]); assert.deepEqual(frame.pixelSpacing, [0.5, 0.75]);
        } finally { sources.forEach(source => source.dispose()); }
    });
}

for (const [name, extraAttributes] of [
    ['US multiplicity', { '00280101': ['US', [16, 8]] }],
    ['wrong declared VR', { '00280101': ['DS', '16'] }]
]) test(`SC resolver independently rejects malformed pixel ${name}`, async () => {
    const bytes = new Uint8Array(await generated({ extraAttributes }).arrayBuffer());
    const instance = (await EASI.pipelineBuilder().fromByteStream().ofDicomData().toInstances().build().process({ source: bytes })).first();
    assert.throws(() => resolveScWordSpatialFrames(instance, { transferSyntax: '1.2.840.10008.1.2.1', rows: 2, columns: 2,
        samplesPerPixel: 1, photometric: 'MONOCHROME2', signed: false, bitsAllocated: 16, bitsStored: 16, highBit: 15 }, { frameCount: 3 }),
    /SC spatial functional groups/);
});
test('SC resolver rejects duplicate top-level functional-group sequences', async () => {
    const bytes = new Uint8Array(await generated().arrayBuffer());
    const repeated = encodeElement('52009229', 'SQ', [{ '00289110': ['SQ', [{ '00280030': ['DS', [1, 1]] }]] }]);
    await assert.rejects(loadFiles([new File([bytes, repeated], 'generated-duplicate.dcm')]), /SC spatial functional groups/);
});

test('SC metadata from the real DICOMweb JSON adapter accepts numeric IS and logical scalar US values', async () => {
    const input = {};
    const put = (id, vr, value) => { input[id] = { vr, Value: [value] }; };
    for (const [id, value] of [['00080016', SC_WORD_SOP_CLASS], ['00080018', '2.25.888.1.1'], ['0020000D', '2.25.888'], ['0020000E', '2.25.888.1']]) put(id, 'UI', value);
    for (const [id, value] of [['00280010', 2], ['00280011', 2], ['00280002', 1], ['00280100', 16], ['00280101', 16], ['00280102', 15], ['00280103', 0]]) put(id, 'US', value);
    put('00280008', 'IS', 3); put('00280004', 'CS', 'MONOCHROME2');
    input['52009229'] = { vr: 'SQ', Value: [{
        '00289110': { vr: 'SQ', Value: [{ '00280030': { vr: 'DS', Value: [0.5, 0.75] } }] },
        '00209116': { vr: 'SQ', Value: [{ '00200037': { vr: 'DS', Value: [1, 0, 0, 0, 1, 0] } }] }
    }] };
    input['52009230'] = { vr: 'SQ', Value: [4, 0, 2].map(z => ({ '00209113': { vr: 'SQ', Value: [{ '00200032': { vr: 'DS', Value: [10, 20, z] } }] } })) };
    const previous = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify([input]), { headers: { 'content-type': 'application/dicom+json' } });
    try {
        const [instance] = await new DicomWebClient({ baseUrl: 'https://generated.invalid/dicom-web' }).getSeriesMetadata('2.25.888', '2.25.888.1');
        const frames = resolveScWordSpatialFrames(instance, { transferSyntax: '1.2.840.10008.1.2.1', rows: 2, columns: 2,
            samplesPerPixel: 1, photometric: 'MONOCHROME2', signed: false, bitsAllocated: 16, bitsStored: 16, highBit: 15 }, { frameCount: 3 });
        assert.deepEqual(frames.map(frame => frame.overrides.position), [[10, 20, 4], [10, 20, 0], [10, 20, 2]]);
        assert.deepEqual(frames[0].overrides.pixelSpacing, [0.5, 0.75]);
    } finally { globalThis.fetch = previous; }
});
test('SC spatial-only profile rejects recorded cine rather than reordering its acquisition clock', async () => {
    await assert.rejects(loadFiles([generated({ extraAttributes: { '00181063': ['DS', 33],
        '00280009': ['AT', Uint8Array.of(0x18, 0, 0x63, 0x10)] } })]), /SC spatial functional groups/);
});
