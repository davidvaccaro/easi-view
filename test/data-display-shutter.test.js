import test from 'node:test';
import assert from 'node:assert/strict';
import { createDicomFixture } from '../src/data/synthetic.js';
import { loadFiles } from '../src/data/sources.js';
import { CLASSIC_RF_SOP_CLASS } from '../src/data/xa-profile.js';
import { validateCircularShutter, circularShutterOccludes } from '../src/data/display-shutter.js';
import { renderScalarToRgba, probe } from '../src/render/DisplayMath.js';
import { roiStatistics } from '../src/annotations/index.js';
import { DicomWebClient } from '../src/data/DicomWebClient.js';
import { normalizeCircularShutter } from '../src/data/display-shutter.js';

const circle = { shape: 'CIRCULAR', row: 2, column: 4, radius: 1, presentationValue: 13107, presentationValueDeclared: true };
function source(options = {}) {
    return new File([createDicomFixture({ sopClass: CLASSIC_RF_SOP_CLASS, modality: 'RF', rows: 5, columns: 5,
        bitsAllocated: 8, bitsStored: 8, values: Array(25).fill(255), ...options, extraAttributes: {
            '00281040': ['CS', 'DISP'], '00181600': ['CS', 'CIRCULAR'], '00181610': ['IS', [2, 4]], '00181612': ['IS', 1],
            '00181622': ['US', 13107], ...options.extraAttributes
        } })], 'generated-circular-shutter.dcm', { type: 'application/dicom' });
}

for (const transferSyntax of ['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']) test(`circular shutter uses one-based row/column order and preserves every original frame sample (${transferSyntax})`, async () => {
    const file = source({ transferSyntax, frames: 2, values: [...Array(25).fill(255), ...Array(25).fill(0)] });
    const original = new Uint8Array(await file.arrayBuffer());
    const sources = await loadFiles([file]);
    try {
        for (const index of [0, 1]) {
            const frame = await sources[0].getFrame(index);
            assert.deepEqual(frame.displayShutter, circle);
            const reference = Array(25).fill(51);
            // Independent reference: center(row2,col4) and four radius1 boundary pixels.
            for (const visible of [3, 7, 8, 9, 13]) reference[visible] = index === 0 ? 255 : 0;
            assert.deepEqual([...renderScalarToRgba(frame, { center: 128, width: 256 })].filter((_, i) => i % 4 === 0), reference);
            assert.deepEqual([...frame.samples], Array(25).fill(index === 0 ? 255 : 0));
            assert.equal(probe(frame, 0.5, 0.5).stored, index === 0 ? 255 : 0);
        }
    } finally { sources.forEach(item => item.dispose()); }
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), original);
});

test('shutter P-values apply after polarity, VOI/user inversion and pixel padding; probe/ROI retain all original stored values', () => {
    for (const presentationValue of [0, 13107, 32768, 65535]) for (const photometric of ['MONOCHROME1', 'MONOCHROME2']) {
        const frame = { rows: 5, columns: 5, photometric, samplesPerPixel: 1, samples: new Uint16Array(25).fill(255),
            slope: 1, intercept: 0, window: { center: 128, width: 256 }, unit: '', pixelSpacing: [1, 1],
            padding: { value: 255, limit: 255 }, displayShutter: { ...circle, presentationValue } };
        for (const invert of [false, true]) {
            const rgba = renderScalarToRgba(frame, { ...frame.window, invert });
            assert.equal(rgba[0], Math.round(presentationValue * 255 / 65535));
            assert.equal(rgba[8 * 4], 0); // Visible padding retains the renderer's black padding behavior.
        }
        const unpadded = { ...frame, padding: null };
        const stats = roiStatistics('rectangle', [{ x: 0, y: 0 }, { x: 5, y: 5 }], unpadded);
        assert.equal(stats.pixelCount, 25); assert.equal(stats.stored.mean, 255); assert.equal(stats.stored.min, 255);
        assert.equal(probe(unpadded, 0.5, 0.5).stored, 255);
        assert.equal(circularShutterOccludes(circle, 1, 4), false); // On the circular boundary.
        assert.equal(circularShutterOccludes(circle, 1, 3), true);
    }
});

for (const [label, extraAttributes] of [
    ['multiple shapes', { '00181600': ['CS', ['CIRCULAR', 'RECTANGULAR']] }], ['duplicate circular shapes', { '00181600': ['CS', ['CIRCULAR', 'CIRCULAR']] }],
    ['polygonal shape', { '00181600': ['CS', 'POLYGONAL'] }], ['bitmap shape', { '00181600': ['CS', 'BITMAP'] }],
    ['missing shape', { '00181600': null }], ['missing center', { '00181610': null }], ['missing radius', { '00181612': null }],
    ['wrong center VR', { '00181610': ['DS', [2, 4]] }], ['wrong radius VR', { '00181612': ['CS', '1'] }],
    ['wrong P-value VR', { '00181622': ['SS', 1] }], ['multiple radii', { '00181612': ['IS', [1, 2]] }],
    ['multiple P-values', { '00181622': ['US', Uint8Array.of(1, 0, 2, 0)] }],
    ['zero radius', { '00181612': ['IS', 0] }], ['negative radius', { '00181612': ['IS', -1] }], ['excessive radius', { '00181612': ['IS', 8193] }],
    ['fractional center', { '00181610': ['IS', [2.5, 4]] }], ['zero-based center', { '00181610': ['IS', [0, 4]] }],
    ['center outside rows', { '00181610': ['IS', [6, 4]] }], ['center outside columns', { '00181610': ['IS', [2, 6]] }],
    ['polygon vertices', { '00181620': ['IS', [1, 1, 2, 2, 3, 1]] }], ['rectangular edges', { '00181602': ['IS', 1] }],
    ['overlay shutter', { '00181623': ['US', 0x6000] }], ['CIELab replacement', { '00181624': ['US', Uint8Array.of(1, 0, 2, 0, 3, 0)] }],
    ['anisotropic physical spacing', { '00280030': ['DS', [2, 1]] }],
    ['anisotropic raster aspect', { '00280030': null, '00280034': ['IS', [2, 1]] }],
    ['unusable declared pixel aspect', { '00280030': ['DS', ['bad', 'bad']] }]
]) test(`circular display-shutter profile explicitly rejects ${label}`, async () => {
    await assert.rejects(loadFiles([source({ extraAttributes })]), /display-shutter profile/);
});

test('display boundary rejects mutated shutter shape, unsafe values, color and unbounded dimensions', () => {
    const frame = { rows: 5, columns: 5, photometric: 'MONOCHROME2' };
    for (const displayShutter of [{ ...circle, radius: Infinity }, { ...circle, row: 1.5 }, { ...circle, presentationValue: 65536 },
        { ...circle, presentationValueDeclared: 'true' }, { ...circle, shape: 'BITMAP' }, { ...circle, extra: 'unused' },
        { ...circle, column: -1 }]) assert.throws(() => validateCircularShutter({ ...frame, displayShutter }), /display-shutter profile/);
    for (const changes of [{ photometric: 'RGB' }, { rows: 8193 }, { pixelAspectRatio: [1, 2] }]) {
        assert.throws(() => validateCircularShutter({ ...frame, ...changes, displayShutter: circle }), /display-shutter profile/);
    }
});

test('DICOM JSON shutter metadata retains declared VR/VM through the real archive client', async () => {
    const metadata = { '00080016': { vr: 'UI', Value: [CLASSIC_RF_SOP_CLASS] },
        '00080018': { vr: 'UI', Value: ['2.25.907.1.1'] }, '0020000D': { vr: 'UI', Value: ['2.25.907'] },
        '0020000E': { vr: 'UI', Value: ['2.25.907.1'] }, '00181600': { vr: 'CS', Value: ['CIRCULAR'] },
        '00181610': { vr: 'IS', Value: [2, 4] }, '00181612': { vr: 'IS', Value: [1] }, '00181622': { vr: 'US', Value: [13107] } };
    const previousFetch = globalThis.fetch;
    try {
        for (const changes of [{}, { '00181600': { vr: 'LO', Value: ['CIRCULAR'] } },
            { '00181610': { vr: 'DS', Value: [2, 4] } }, { '00181622': { vr: 'SS', Value: [1] } },
            { '00181622': { vr: 'US', Value: [1, 2] } }]) {
            globalThis.fetch = async () => new Response(JSON.stringify([{ ...metadata, ...changes }]), { headers: { 'content-type': 'application/dicom+json' } });
            const [instance] = await new DicomWebClient({ baseUrl: 'https://synthetic.invalid/dicom-web' }).getSeriesMetadata('2.25.907', '2.25.907.1');
            const action = () => normalizeCircularShutter(instance.dataSet, { rows: 5, columns: 5, photometric: 'MONOCHROME2' });
            if (!Object.keys(changes).length) assert.deepEqual(action(), circle);
            else assert.throws(action, /display-shutter profile/);
        }
    } finally { globalThis.fetch = previousFetch; }
});
