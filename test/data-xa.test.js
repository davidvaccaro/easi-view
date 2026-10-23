import test from 'node:test';
import assert from 'node:assert/strict';
import EASI, { Tag } from '@xinonix/easi-js';
import { createDicomFixture } from '../src/data/synthetic.js';
import { loadFiles, normalizeInstance } from '../src/data/sources.js';
import { renderScalarToRgba } from '../src/render/DisplayMath.js';
import { CLASSIC_XA_SOP_CLASS } from '../src/data/xa-profile.js';

function concatenate(parts) {
    const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
}

// Independent explicit-length sequence/item writer. The mask operation is a CS element, not pixels.
function maskItems(operations, littleEndian = true, { includeUnusedZeroFrame = false, implicit = false } = {}) {
    return concatenate(operations.map(operation => {
        const parts = [];
        if (operation !== null) {
            const raw = new TextEncoder().encode(operation);
            const value = raw.length % 2 ? concatenate([raw, Uint8Array.of(32)]) : raw;
            const header = new Uint8Array(8);
            const view = new DataView(header.buffer);
            view.setUint16(0, 0x0028, littleEndian); view.setUint16(2, 0x6101, littleEndian);
            if (implicit) view.setUint32(4, value.length, littleEndian);
            else { header.set(new TextEncoder().encode('CS'), 4); view.setUint16(6, value.length, littleEndian); }
            parts.push(header, value);
        }
        if (includeUnusedZeroFrame) {
            const element = new Uint8Array(10);
            const view = new DataView(element.buffer);
            view.setUint16(0, 0x0028, littleEndian); view.setUint16(2, 0x6110, littleEndian);
            if (implicit) view.setUint32(4, 2, littleEndian);
            else { element.set(new TextEncoder().encode('US'), 4); view.setUint16(6, 2, littleEndian); }
            view.setUint16(8, 0, littleEndian);
            parts.push(element);
        }
        const content = concatenate(parts);
        const header = new Uint8Array(8);
        const view = new DataView(header.buffer);
        view.setUint16(0, 0xFFFE, littleEndian); view.setUint16(2, 0xE000, littleEndian);
        view.setUint32(4, content.length, littleEndian);
        return concatenate([header, content]);
    }));
}

function xaFile(options = {}) {
    const littleEndian = options.transferSyntax !== '1.2.840.10008.1.2.2';
    const bytes = createDicomFixture({ sopClass: CLASSIC_XA_SOP_CLASS, modality: 'XA', bitsAllocated: 8,
        bitsStored: 8, values: [0, 17, 129, 255], ...options,
        extraAttributes: { '00080008': ['CS', ['ORIGINAL', 'PRIMARY', 'SINGLE PLANE']], '00281040': ['CS', 'LIN'],
            '00281054': null, '00281090': ['CS', 'NAT'],
            ...(options.maskOperations ? { '00286100': ['SQ', maskItems(options.maskOperations, littleEndian,
                { includeUnusedZeroFrame: options.unusedZeroMaskFrame, implicit: options.transferSyntax === '1.2.840.10008.1.2' })] } : {}),
            ...options.extraAttributes } });
    return new File([bytes], 'generated-native-xa.dcm', { type: 'application/dicom' });
}

async function inspect(options, action) {
    const sources = await loadFiles([xaFile(options)]);
    try { await action(sources[0]); } finally { sources.forEach(series => series.dispose()); }
}

for (const transferSyntax of ['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']) {
    for (const bitsStored of [8, 12]) {
        test(`classic XA preserves unsigned native samples, fixed timing and NONE mask (${transferSyntax}, ${bitsStored} bits)`, async () => {
            const first = bitsStored === 8 ? [0, 17, 129, 255] : [0, 17, 2047, 4095];
            const second = bitsStored === 8 ? [255, 129, 17, 0] : [4095, 2047, 17, 0];
            await inspect({ transferSyntax, bitsAllocated: bitsStored === 8 ? 8 : 16, bitsStored,
                frames: 2, frameTime: 33, values: [...first, ...second], maskOperations: ['NONE'], unusedZeroMaskFrame: true }, async series => {
                assert.equal(series.frames.length, 2);
                assert.equal(series.cacheBytes, 0);
                const frame = await series.getFrame(1);
                assert.deepEqual([...frame.samples], second);
                assert.equal(frame.signed, false);
                assert.equal(frame.photometric, 'MONOCHROME2');
                assert.equal(frame.frameTime, 33);
                assert.equal(frame.unit, '');
                assert.deepEqual([...(await series.getFrame(0)).samples], first);
                assert.equal(await series.getFrame(1), frame);
                assert.equal(series.cacheBytes, 2 * 4 * 2); // The scalar decoder retains unsigned 16-bit samples.
            });
        });
    }
}

test('a 96-frame native XA run decodes only selected frames and supports cache eviction and reuse', async () => {
    const values = Array.from({ length: 96 }, (_, frame) => [frame, frame + 1, frame + 2, 255]).flat();
    await inspect({ frames: 96, frameTime: 33, values, maskOperations: ['NONE'], unusedZeroMaskFrame: true }, async series => {
        assert.equal(series.frames.length, 96);
        assert.equal(series.cacheBytes, 0);
        assert.equal(series.sourceBytes, 96 * 4);
        assert.deepEqual([...(await series.getFrame(95)).samples], [95, 96, 97, 255]);
        assert.equal(series.cacheBytes, 8);
        series._session.cache.clear();
        series._session.cache.budget = 8;
        await series.getFrame(0);
        await series.getFrame(1);
        assert.equal(series.cacheBytes, 8);
        assert.deepEqual([...(await series.getFrame(95)).samples], [95, 96, 97, 255]);
        assert.equal(series.cacheBytes, 8);
    });
});

test('a classic XA single frame accepts declared Frame Time zero without manufacturing a cine rate', async () => {
    await inspect({ extraAttributes: { '00181063': ['DS', 0], '00280009': ['AT', Uint8Array.of(0x18, 0, 0x63, 0x10)] } }, async series => {
        assert.equal(series.frames.length, 1);
        assert.equal((await series.getFrame(0)).frameTime, 0);
    });
    await inspect({}, async series => assert.equal((await series.getFrame(0)).frameTime, null));
});

test('LIN, DISP and intensity relationship sign do not apply a hidden pixel transform or inversion', async () => {
    for (const relationship of ['LIN', 'DISP']) {
        for (const sign of [-1, 1]) {
            await inspect({ extraAttributes: { '00281040': ['CS', relationship], '00281041': ['SS', sign],
                '00281050': ['DS', 128], '00281051': ['DS', 256] } }, async series => {
                const frame = await series.getFrame(0);
                assert.deepEqual([...frame.samples], [0, 17, 129, 255]);
                const rgba = renderScalarToRgba(frame);
                assert.deepEqual([rgba[0], rgba[4], rgba[8], rgba[12]], [0, 17, 129, 255]);
            });
        }
    }
});

test('classic XA tolerates missing/empty mask sequences or only NONE operations', async () => {
    for (const options of [{}, { extraAttributes: { '00286100': ['SQ', new Uint8Array()] } }, { maskOperations: ['NONE', 'NONE'] }]) {
        await inspect(options, async series => assert.deepEqual([...(await series.getFrame(0)).samples], [0, 17, 129, 255]));
    }
});

test('EASI JSON metadata AT strings and arrays enforce the same XA timing profile as native AT words', async () => {
    const metadata = {
        '00080016': { vr: 'UI', Value: [CLASSIC_XA_SOP_CLASS] }, '00080018': { vr: 'UI', Value: ['2.25.400.1.1'] },
        '00080060': { vr: 'CS', Value: ['XA'] }, '0020000D': { vr: 'UI', Value: ['2.25.400'] },
        '0020000E': { vr: 'UI', Value: ['2.25.400.1'] }, '00280002': { vr: 'US', Value: [1] },
        '00280004': { vr: 'CS', Value: ['MONOCHROME2'] }, '00280008': { vr: 'IS', Value: [2] },
        '00280009': { vr: 'AT', Value: ['00181063'] }, '00181063': { vr: 'DS', Value: [33] },
        '00280010': { vr: 'US', Value: [2] }, '00280011': { vr: 'US', Value: [2] },
        '00280100': { vr: 'US', Value: [8] }, '00280101': { vr: 'US', Value: [8] },
        '00280102': { vr: 'US', Value: [7] }, '00280103': { vr: 'US', Value: [0] },
        '00281040': { vr: 'CS', Value: ['LIN'] }, '00281090': { vr: 'CS', Value: ['NAT'] },
        '00286100': { vr: 'SQ', Value: [{ '00286101': { vr: 'CS', Value: ['NONE'] }, '00286110': { vr: 'US', Value: [0] } }] }
    };
    for (const pointer of [['00181063'], ['00181063', '00181065']]) {
        const input = { ...metadata, '00280009': { vr: 'AT', Value: pointer } };
        const result = await EASI.pipelineBuilder().fromByteStream().ofDicomMetadata().toInstances().build()
            .process({ source: new TextEncoder().encode(JSON.stringify([input])) });
        if (pointer.length === 1) {
            const record = normalizeInstance(result.first(), { metadataOnly: true });
            assert.equal(record.common.frameTime, 33);
            assert.equal(record.bytes, null);
        } else assert.throws(() => normalizeInstance(result.first(), { metadataOnly: true }), /Frame Increment Pointer/);
    }
});

for (const [label, options, expected] of [
    ['signed native samples', { signed: true }, /Classic XA requires unsigned/],
    ['MONOCHROME1', { photometric: 'MONOCHROME1' }, /Classic XA requires unsigned/],
    ['unsupported bit depth', { bitsStored: 7 }, /Bits Stored 8, 10, 12 or 16/],
    ['shifted high bit', { bitsAllocated: 16, bitsStored: 12, highBit: 14 }, /High Bit equal/],
    ['nonidentity rescale', { slope: 2 }, /nonidentity modality rescale/],
    ['quantitative units', { extraAttributes: { '00281054': ['LO', 'HU'] } }, /quantitative rescale units/],
    ['LOG relationship without its LUT', { extraAttributes: { '00281040': ['CS', 'LOG'] } }, /LOG images need/],
    ['missing relationship', { extraAttributes: { '00281040': null } }, /Pixel Intensity Relationship/],
    ['active average mask', { maskOperations: ['AVG_SUB'] }, /mask subtraction is not supported/],
    ['active TID mask', { maskOperations: ['TID'] }, /mask subtraction is not supported/],
    ['active reversed TID mask', { maskOperations: ['REV_TID'] }, /mask subtraction is not supported/],
    ['unknown mask', { maskOperations: ['UNKNOWN'] }, /Mask operations must be NONE/],
    ['missing mask operation', { maskOperations: [null] }, /Mask operations must be NONE/],
    ['mixed NONE and active mask', { maskOperations: ['NONE', 'AVG_SUB'] }, /Mask operations must be NONE/],
    ['subtraction recommendation', { extraAttributes: { '00281090': ['CS', 'SUB'] } }, /mask subtraction is not supported/],
    ['incomplete display shutter', { extraAttributes: { '00181600': ['CS', 'CIRCULAR'] } }, /display-shutter profile/],
    ['enhanced XA', { sopClass: '1.2.840.10008.5.1.4.1.1.12.1.1' }, /object type/],
    ['enhanced XRF', { sopClass: '1.2.840.10008.5.1.4.1.1.13.1.2' }, /object type/],
    ['missing cine pointer', { frames: 2, values: [0, 1, 2, 3, 4, 5, 6, 7], extraAttributes: { '00280009': null } }, /Frame Increment Pointer/],
    ['different cine pointer', { frames: 2, values: [0, 1, 2, 3, 4, 5, 6, 7], extraAttributes: { '00280009': ['AT', Uint8Array.of(0x20, 0, 0x13, 0)] } }, /Frame Increment Pointer/],
    ['missing cine timing', { frames: 2, values: [0, 1, 2, 3, 4, 5, 6, 7], extraAttributes: { '00181063': null } }, /declared positive Frame Time/],
    ['zero cine timing', { frames: 2, frameTime: 0, values: [0, 1, 2, 3, 4, 5, 6, 7] }, /zero is valid only for a single frame/],
    ['negative cine timing', { frames: 2, frameTime: -1, values: [0, 1, 2, 3, 4, 5, 6, 7] }, /positive Frame Time/],
    ['multiple Frame Time values', { frames: 2, frameTime: [33, 66], values: [0, 1, 2, 3, 4, 5, 6, 7] }, /one fixed timing value/],
    ['invalid selected variable frame times', { frames: 2, values: [0, 1, 2, 3, 4, 5, 6, 7],
        extraAttributes: { '00181063': null, '00181065': ['DS', [10, 33]], '00280009': ['AT', Uint8Array.of(0x18, 0, 0x65, 0x10)] } }, /Frame Time Vector/],
    ['VOI LUT', { extraAttributes: { '00283010': ['SQ', new Uint8Array()] } }, /LUT sequence/],
    ['modality LUT', { extraAttributes: { '00283000': ['SQ', new Uint8Array()] } }, /LUT sequence/]
]) {
    test(`classic XA outside the native display profile rejects explicitly: ${label}`, async () => {
        await assert.rejects(loadFiles([xaFile(options)]), expected);
    });
}
