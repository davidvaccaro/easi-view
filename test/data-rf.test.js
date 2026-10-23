import test from 'node:test';
import assert from 'node:assert/strict';
import { createDicomFixture } from '../src/data/synthetic.js';
import { loadFiles } from '../src/data/sources.js';
import { CLASSIC_RF_SOP_CLASS, CLASSIC_XA_SOP_CLASS } from '../src/data/xa-profile.js';
import { nativePlaybackAvailable, nativePlaybackInterval } from '../src/data/frame-timing.js';
import { probe, renderScalarToRgba } from '../src/render/DisplayMath.js';

function pointer(id, littleEndian = true) {
    const bytes = new Uint8Array(4), view = new DataView(bytes.buffer);
    view.setUint16(0, parseInt(id.slice(0, 4), 16), littleEndian); view.setUint16(2, parseInt(id.slice(4), 16), littleEndian);
    return bytes;
}
function rfFile(options = {}) {
    const bytes = createDicomFixture({ sopClass: CLASSIC_RF_SOP_CLASS, modality: 'RF', bitsAllocated: 8, bitsStored: 8,
        values: [0, 17, 129, 255], ...options, extraAttributes: {
            '00080008': ['CS', ['ORIGINAL', 'PRIMARY', 'SINGLE PLANE']], '00281040': ['CS', 'DISP'],
            '00281054': null, '00280030': null, '00200032': null, '00200037': null,
            ...options.extraAttributes
        } });
    return new File([bytes], 'generated-rf.dcm', { type: 'application/dicom' });
}
async function inspect(options, action) {
    const sources = await loadFiles([rfFile(options)]);
    try { await action(sources[0]); } finally { sources.forEach(source => source.dispose()); }
}

for (const transferSyntax of ['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']) {
    for (const bitsStored of [8, 10, 12, 16]) test(`classic RF preserves scalar pixels and uncalibrated detector geometry (${transferSyntax}, ${bitsStored} bits)`, async () => {
        const values = [0, 17, 2 ** (bitsStored - 1), 2 ** bitsStored - 1];
        await inspect({ transferSyntax, bitsAllocated: bitsStored === 8 ? 8 : 16, bitsStored, values }, async source => {
            const frame = await source.getFrame(0);
            assert.deepEqual([...frame.samples], values); assert.equal(frame.modality, 'RF'); assert.equal(frame.unit, '');
            assert.equal(frame.pixelSpacing, null); assert.equal(frame.position, null); assert.equal(frame.orientation, null);
            assert.equal(frame.frameTime, null); assert.equal(frame.timingMode, 'none');
            assert.equal(probe(frame, 1.5, 1.5).stored, values[3]);
        });
    });
    for (const sopClass of [CLASSIC_RF_SOP_CLASS, CLASSIC_XA_SOP_CLASS]) test(`classic XA/RF follows the validated selected variable clock (${sopClass}, ${transferSyntax})`, async () => {
        const littleEndian = transferSyntax !== '1.2.840.10008.1.2.2';
        await inspect({ transferSyntax, sopClass, modality: sopClass === CLASSIC_RF_SOP_CLASS ? 'RF' : 'XA', frames: 4,
            values: Array.from({ length: 16 }, (_, index) => index), extraAttributes: {
                '00280009': ['AT', pointer('00181065', littleEndian)], '00181065': ['DS', [0, 33, 55, 12]],
                '00181063': ['DS', 'malformed-unused-clock']
            } }, async source => {
                assert.equal(nativePlaybackAvailable(source.frames), true);
                assert.deepEqual(source.frames.map(frame => frame.acquisitionOffsetMs), [0, 33, 88, 100]);
                assert.deepEqual(source.frames.map((_, index) => nativePlaybackInterval(source.frames, index)), [33, 55, 12, null]);
                const frame = await source.getFrame(2);
                assert.equal(frame.frameTime, null); assert.equal(frame.timingMode, 'vector'); assert.equal(frame.acquisitionOffsetMs, 88);
                assert.deepEqual([...frame.samples], [8, 9, 10, 11]); assert.deepEqual(frame.timingWarnings, []);
            });
    });
}

test('classic RF circular shutters use one-based row/column positions, leave stored values intact and default unspecified neutralization to black', async () => {
    const values = Array(25).fill(255);
    await inspect({ rows: 5, columns: 5, values, extraAttributes: {
        '00181600': ['CS', 'CIRCULAR'], '00181610': ['IS', [3, 3]], '00181612': ['IS', 1]
    } }, async source => {
        const frame = await source.getFrame(0);
        assert.deepEqual(frame.displayShutter, { shape: 'CIRCULAR', row: 3, column: 3, radius: 1, presentationValue: 0, presentationValueDeclared: false });
        assert.deepEqual([...frame.samples], values);
        const grays = [...renderScalarToRgba(frame, { center: 128, width: 256 })].filter((_, index) => index % 4 === 0);
        assert.deepEqual(grays, [0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0]);
        assert.equal(probe(frame, 0.5, 0.5).stored, 255); assert.equal(probe(frame, 0.5, 0.5).rescaled, 255);
    });
});

for (const [label, options, expected] of [
    ['signed samples', { signed: true }, /Classic RF requires unsigned/], ['MONOCHROME1', { photometric: 'MONOCHROME1' }, /Classic RF requires unsigned/],
    ['shifted high bit', { bitsAllocated: 16, bitsStored: 12, highBit: 14 }, /High Bit/], ['nonidentity rescale', { slope: 2 }, /nonidentity/],
    ['quantitative units', { extraAttributes: { '00281054': ['LO', 'HU'] } }, /quantitative rescale units/],
    ['LOG without verified intensity mapping', { extraAttributes: { '00281040': ['CS', 'LOG'] } }, /LOG images/],
    ['subtracted viewing', { extraAttributes: { '00281090': ['CS', 'SUB'] } }, /mask subtraction/],
    ['unknown modality', { modality: 'XA' }, /modality RF/],
    ['missing cine clock', { frames: 2, values: Array(8).fill(1), extraAttributes: { '00181063': null, '00280009': null } }, /Frame Increment Pointer/],
    ['invalid vector', { frames: 2, values: Array(8).fill(1), extraAttributes: { '00181063': null, '00280009': ['AT', pointer('00181065')], '00181065': ['DS', [1, 33]] } }, /Frame Time Vector/],
    ['missing selected vector', { frames: 2, values: Array(8).fill(1), extraAttributes: { '00280009': ['AT', pointer('00181065')] } }, /frame timing/],
    ['additional spatial frame dimension', { extraAttributes: { '0028000A': ['AT', pointer('00181520')] } }, /dedicated geometry profile/]
]) test(`classic RF explicitly rejects ${label}`, async () => assert.rejects(loadFiles([rfFile(options)]), expected));

test('classic RF active AVG_SUB mask remains explicitly unsupported even when the circular shutter and clock are valid', async () => {
    // One explicit-length item with one CS Mask Operation; no original data.
    const item = Uint8Array.of(0xFE, 0xFF, 0x00, 0xE0, 16, 0, 0, 0,
        0x28, 0, 0x01, 0x61, 0x43, 0x53, 8, 0, ...new TextEncoder().encode('AVG_SUB '));
    await assert.rejects(loadFiles([rfFile({ extraAttributes: { '00286100': ['SQ', item],
        '00181600': ['CS', 'CIRCULAR'], '00181610': ['IS', [1, 1]], '00181612': ['IS', 1] } })]), /Classic RF mask subtraction is not supported/);
});
