import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFiles } from '../src/data/sources.js';
import { createDicomFixture } from '../src/data/synthetic.js';
import { createCompressedDicom } from './compressed-fixtures.js';
import { AnnotationStore, createImageReference, normalizeImageReference, compatibleImageReferences, measureAnnotation } from '../src/annotations/index.js';
import { validateDicomUid } from '../src/data/DicomWebClient.js';
import { uid as interchangeUid } from '../src/derived/common.js';
import { uid as enterpriseUid } from '../src/enterprise/contracts.js';

// Generated identifiers and rasters only; no identifier from a local image.
const seriesUid = '2.25.000041', canonicalSeries = '2.25.41', sopUid = '2.25.910003';
const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9], reversed = [...samples].reverse();
const points = [{ x: 0.5, y: 0.5 }, { x: 2.5, y: 2.5 }];
const base = { sopUid, frameNumber: 1, rows: 3, columns: 3, seriesUid };
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} differs from ${expected}`);

for (const syntax of ['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2', 'rle']) {
    test(`synthetic ${syntax} parsing supports calibrated ellipse measurements and exact legacy Series roundtrips`, async () => {
        const options = { rows: 3, columns: 3, seriesUid, sopUid, photometric: 'MONOCHROME1', pixelSpacing: [2, 3], slope: 2, intercept: -10 };
        const bytes = syntax === 'rle' ? (await createCompressedDicom({ ...options, codec: 'rle', bitsAllocated: 16, frameSamples: [samples, reversed] })).bytes
            : createDicomFixture({ ...options, transferSyntax: syntax, frames: 2, values: [...samples, ...reversed] });
        const sources = await loadFiles([new File([bytes], 'synthetic-legacy-series.dcm', { type: 'application/dicom' })]);
        const store = new AnnotationStore(), imported = new AnnotationStore();
        try {
            assert.equal(sources.length, 1); assert.equal(sources[0].frames.length, 2);
            const frame = await sources[0].getFrame(1), image = createImageReference(frame);
            assert.equal(image.seriesUid, seriesUid); assert.equal(image.sopUid, sopUid); assert.equal(image.frameNumber, 2);
            assert.equal(Object.hasOwn(image, 'frameOfReferenceUid'), false); assert.equal(frame.seriesUid, seriesUid);
            assert.deepEqual([...frame.samples], reversed);
            const ellipse = store.add({ id: 'ellipse-1', tool: 'ellipse', image, points });
            const measured = measureAnnotation(ellipse, frame);
            // This ellipse contains the independent center values8,6,5,4,2.
            near(measured.geometry.value, 6 * Math.PI); assert.equal(measured.geometry.unit, 'mm2');
            assert.equal(measured.statistics.pixelCount, 5); assert.equal(measured.statistics.sampledArea, 30);
            assert.equal(measured.statistics.stored.mean, 5); assert.equal(measured.statistics.stored.stdDev, 2);
            assert.equal(measured.statistics.stored.min, 2); assert.equal(measured.statistics.stored.max, 8);
            near(measured.statistics.modality.mean, 0); near(measured.statistics.modality.stdDev, 4);
            assert.equal(measured.statistics.modality.min, -6); assert.equal(measured.statistics.modality.max, 6);
            const document = store.exportJson(); assert.equal(JSON.parse(document).annotations[0].image.seriesUid, seriesUid);
            assert.equal(store.undo(), true); assert.equal(store.list(image).length, 0);
            assert.equal(store.redo(), true); assert.equal(store.exportJson(), document);
            assert.equal(imported.import(document), 1); assert.equal(imported.exportJson(), document);
            assert.deepEqual(measureAnnotation(imported.get('ellipse-1'), frame), measured);
            assert.deepEqual([...frame.samples], reversed);
            assert.throws(() => measureAnnotation(ellipse, { ...frame, frameIndex: 0 }), /does not belong/);
        } finally { store.dispose(); imported.dispose(); sources.forEach(source => source.dispose()); }
    });
}

test('legacy Series spelling remains an exact identity discriminator without canonical aliases', () => {
    const frame = { ...base, frameIndex: 0, photometric: 'MONOCHROME2', samples: Uint16Array.from(samples), pixelSpacing: [2, 3] };
    const exact = createImageReference(frame), other = { ...exact, seriesUid: canonicalSeries }, store = new AnnotationStore();
    try {
        assert.equal(normalizeImageReference(exact).seriesUid, seriesUid); assert.equal(compatibleImageReferences(exact, other), false);
        const ellipse = store.add({ id: 'legacy', tool: 'ellipse', image: exact, points });
        assert.equal(store.list(other).length, 0);
        assert.throws(() => measureAnnotation(ellipse, { ...frame, seriesUid: canonicalSeries }), /does not belong/);
        assert.throws(() => store.add({ id: 'alias', tool: 'ellipse', image: other, points }), /disagree/);
        const before = store.exportJson();
        const conflict = JSON.parse(before); conflict.annotations[0].id = 'imported-alias'; conflict.annotations[0].image.seriesUid = canonicalSeries;
        assert.throws(() => store.import(conflict), /disagree/); assert.equal(store.exportJson(), before);
        assert.throws(() => createImageReference(frame, { seriesUid: canonicalSeries }), /conflicts/);
        assert.equal(createImageReference(frame, { seriesUid }).seriesUid, seriesUid);
    } finally { store.dispose(); }
});

test('optional Series references accept bounded exact ASCII numeric components and reject other spellings', () => {
    for (const allowed of [seriesUid, '0', '000', '01.002.0003', '0'.repeat(64)]) {
        assert.equal(normalizeImageReference({ ...base, seriesUid: allowed }).seriesUid, allowed);
    }
    for (const invalid of ['', '1'.repeat(65), '../1', 'https://example.invalid/1', '1.a', '1.+2', '1.-2', '.1', '1.', '1..2',
        '1\\2', '1,2', ' 1.02', '1.02 ', '1.02\n', '1.02\r', '1.02\r\n', '1.02\u2028', '1.02\u2029', '1.02\0', '1.\t02', '١.٢', null, 1.02, ['1.02']]) {
        assert.throws(() => normalizeImageReference({ ...base, seriesUid: invalid }), /Series Instance UID reference/);
    }
});

test('mandatory SOP, optional FoR, archive, enterprise and DICOM interchange UID rules stay strict', () => {
    for (const invalid of [seriesUid, '', '1'.repeat(65), 'source-name', '../1']) {
        assert.throws(() => normalizeImageReference({ ...base, sopUid: invalid }), /valid DICOM UID/);
        assert.throws(() => normalizeImageReference({ ...base, frameOfReferenceUid: invalid }), /valid DICOM UID/);
        assert.throws(() => validateDicomUid(invalid)); assert.throws(() => enterpriseUid(invalid)); assert.throws(() => interchangeUid(invalid));
    }
    assert.equal(normalizeImageReference({ ...base, frameOfReferenceUid: '2.25.7009' }).frameOfReferenceUid, '2.25.7009');
    const frame = { ...base, frameIndex: 0 };
    assert.throws(() => createImageReference(frame, { sopUid: '2.25.42' }), /conflicts/);
    assert.throws(() => createImageReference(frame, { frameNumber: 2 }), /conflicts/);
});
