import test from 'node:test';
import assert from 'node:assert/strict';
import { measureGeometry, roiStatistics, measureAnnotation, createImageReference, imageToPatient, patientToImage,
    geometryFingerprint, validateShape, moveAnnotationHandle, translateAnnotation, annotationHandles } from '../src/annotations/index.js';

const pixels = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const frame = changes => ({ rows: 3, columns: 3, samples: Uint16Array.from(pixels), photometric: 'MONOCHROME2',
    slope: 1, intercept: 0, unit: 'HU', pixelSpacing: [2, 3], orientation: [1, 0, 0, 0, 1, 0], position: [10, 20, 30],
    sopUid: '2.25.7001.1', seriesUid: '2.25.7001', frameOfReferenceUid: '2.25.7000', frameIndex: 0, ...changes });
const points = (...xy) => xy.map(([x, y]) => ({ x, y }));
const near = (actual, expected, tolerance = 1e-12) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);

test('anisotropic length uses column spacing for x and row spacing for y', () => {
    const measured = measureGeometry('length', points([0, 0], [3, 3]), frame());
    near(measured.value, Math.sqrt(117)); assert.equal(measured.unit, 'mm'); assert.equal(measured.calibrated, true);
    const uncalibrated = measureGeometry('length', points([0, 0], [3, 3]), frame({ pixelSpacing: null, pixelAspectRatio: [2, 3] }));
    near(uncalibrated.value, Math.sqrt(18)); assert.equal(uncalibrated.unit, 'px'); assert.equal(uncalibrated.calibrated, false);
});

test('angle measurement applies anisotropic geometry instead of the displayed pixel-grid angle', () => {
    const vertices = points([1, 0], [0, 0], [1, 1]);
    near(measureGeometry('angle', vertices, frame()).value, Math.atan2(2, 3) * 180 / Math.PI);
    near(measureGeometry('angle', vertices, frame({ pixelSpacing: null })).value, 45);
    near(measureGeometry('angle', points([0, 1], [1, 1], [2, 1]), frame()).value, 180);
});

test('rectangle statistics stream original samples1..9 with independent area and population references', () => {
    const vertices = points([0, 0], [3, 3]), source = frame();
    const geometry = measureGeometry('rectangle', vertices, source), statistics = roiStatistics('rectangle', vertices, source);
    assert.equal(geometry.value, 54); assert.equal(geometry.pixelArea, 9); assert.equal(geometry.unit, 'mm2');
    assert.equal(statistics.pixelCount, 9); assert.equal(statistics.sampledArea, 54); assert.equal(statistics.stored.mean, 5);
    near(statistics.stored.stdDev, Math.sqrt(20 / 3)); assert.equal(statistics.stored.min, 1); assert.equal(statistics.stored.max, 9);
    assert.deepEqual(statistics.modality, statistics.stored); assert.equal(statistics.varianceDefinition, 'population');
    assert.deepEqual([...source.samples], pixels);
});

test('ellipse center inclusion measures five cross pixels independently of its analytic geometric area', () => {
    const vertices = points([0.5, 0.5], [2.5, 2.5]), source = frame();
    const geometry = measureGeometry('ellipse', vertices, source), statistics = roiStatistics('ellipse', vertices, source);
    near(geometry.value, 6 * Math.PI); assert.equal(statistics.pixelCount, 5); assert.equal(statistics.sampledArea, 30);
    assert.equal(statistics.stored.mean, 5); near(statistics.stored.stdDev, Math.sqrt(20 / 5));
    assert.equal(statistics.stored.min, 2); assert.equal(statistics.stored.max, 8);
});

test('closed polygon scanlines include exact boundary centers without duplicate samples', () => {
    const source = frame();
    const square = points([0.5, 0.5], [2.5, 0.5], [2.5, 2.5], [0.5, 2.5]);
    const statistics = roiStatistics('polygon', square, source);
    assert.equal(statistics.pixelCount, 9); assert.equal(statistics.stored.mean, 5);
    assert.equal(measureGeometry('polygon', square, source).value, 24);
    const triangle = points([0.5, 0.5], [2.5, 0.5], [0.5, 2.5]);
    const measured = roiStatistics('polygon', triangle, source);
    assert.equal(measured.pixelCount, 6); near(measured.stored.mean, 22 / 6);
    near(measured.stored.stdDev, Math.sqrt((1 + 4 + 9 + 16 + 25 + 49) / 6 - (22 / 6) ** 2));
    assert.equal(measureGeometry('polygon', triangle, source).value, 12);
});

test('concave polygon inclusion follows independently selected pixels in either winding', () => {
    const source = frame();
    const vertices = points([0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3]);
    for (const polygon of [vertices, [...vertices].reverse()]) {
        const stats = roiStatistics('polygon', polygon, source);
        // L shape contains values1,2,3,4,7.
        assert.equal(stats.pixelCount, 5); near(stats.stored.mean, 17 / 5);
        assert.equal(stats.stored.min, 1); assert.equal(stats.stored.max, 7);
        assert.equal(measureGeometry('polygon', polygon, source).value, 30);
    }
});

test('signed padding exclusion precedes rescale and never changes original stored values', () => {
    const source = frame({ samples: Int16Array.of(-4, -3, -2, -1, 0, 1, 2, 3, 4), slope: -2, intercept: 10,
        padding: { value: -4, limit: -3 } });
    const stats = roiStatistics('rectangle', points([0, 0], [3, 3]), source);
    assert.equal(stats.sampledPixelCount, 9); assert.equal(stats.excludedPadding, 2); assert.equal(stats.pixelCount, 7);
    assert.equal(stats.stored.mean, 1); assert.equal(stats.stored.min, -2); assert.equal(stats.stored.max, 4);
    assert.equal(stats.modality.mean, 8); assert.equal(stats.modality.min, 2); assert.equal(stats.modality.max, 14);
    near(stats.modality.stdDev, 4); assert.equal(stats.sampledArea, 42);
    assert.deepEqual([...source.samples], [-4, -3, -2, -1, 0, 1, 2, 3, 4]);
});

test('modality LUT statistics preserve stored samples and ignore VOI/window/inversion presentation', () => {
    const source = frame({ rows: 1, columns: 3, samples: Int16Array.of(-1, 0, 1), padding: null,
        modalityLut: { count: 3, firstMapped: -1, bits: 16, entries: Uint16Array.of(10, 20, 80) },
        voiLut: { count: 1, firstMapped: 0, bits: 8, entries: Uint16Array.of(255) }, presentationInvert: true, window: { center: -100, width: 1 } });
    const stats = roiStatistics('rectangle', points([0, 0], [3, 1]), source);
    assert.equal(stats.stored.mean, 0); near(stats.stored.stdDev, Math.sqrt(2 / 3));
    near(stats.modality.mean, 110 / 3); near(stats.modality.stdDev, Math.sqrt(8600 / 9));
    assert.equal(stats.modality.min, 10); assert.equal(stats.modality.max, 80);
});

test('empty subpixel and all-padding ROIs return explicit null statistics rather than NaN', () => {
    const empty = roiStatistics('rectangle', points([0, 0], [0.1, 0.1]), frame());
    assert.equal(empty.status, 'empty'); assert.equal(empty.pixelCount, 0);
    assert.deepEqual(empty.stored, { count: 0, mean: null, stdDev: null, min: null, max: null });
    const padded = roiStatistics('rectangle', points([0, 0], [3, 3]), frame({ padding: { value: 1, limit: 9 } }));
    assert.equal(padded.pixelCount, 0); assert.equal(padded.excludedPadding, 9); assert.equal(padded.modality.mean, null);
});

test('uncalibrated ROI areas use px2 and RGB/palette intensity statistics remain explicitly unavailable', () => {
    const rgb = frame({ samples: Uint8Array.from(Array.from({ length: 9 }, () => [10, 20, 30]).flat()), photometric: 'RGB', pixelSpacing: null });
    const stats = roiStatistics('rectangle', points([0, 0], [3, 3]), rgb);
    assert.equal(stats.status, 'color-intensity-unavailable'); assert.equal(stats.representation, 'RGB');
    assert.equal(stats.pixelCount, 9); assert.equal(stats.stored, null); assert.equal(stats.modality, null); assert.equal(stats.areaUnit, 'px2');
    const palette = roiStatistics('ellipse', points([0.5, 0.5], [2.5, 2.5]), frame({ photometric: 'PALETTE COLOR' }));
    assert.equal(palette.representation, 'palette'); assert.equal(palette.stored, null); assert.equal(palette.pixelCount, 5);
});

test('a measured annotation stays scoped to its SOP and original frame despite stack order changes', () => {
    const source = frame({ frameIndex: 7 }), image = createImageReference(source);
    assert.equal(image.frameNumber, 8);
    const annotation = { id: 'a1', tool: 'rectangle', image, points: points([0, 0], [3, 3]) };
    assert.equal(measureAnnotation(annotation, source).statistics.pixelCount, 9);
    assert.equal(measureAnnotation(annotation, source, { statistics: false }).statistics, null);
    for (const change of [{ sopUid: '2.25.9001' }, { frameIndex: 8 }, { pixelSpacing: [1, 1] }, { frameOfReferenceUid: undefined }]) {
        assert.throws(() => measureAnnotation(annotation, frame({ frameIndex: 7, ...change })), /does not belong/);
    }
});

test('patient/image coordinate round trips use the first pixel center and correct spacing axes', () => {
    const source = frame();
    assert.deepEqual(imageToPatient({ x: 0.5, y: 0.5 }, source), [10, 20, 30]);
    assert.deepEqual(imageToPatient({ x: 1.5, y: 1.5 }, source), [13, 22, 30]);
    const back = patientToImage([13, 22, 30], source);
    assert.deepEqual(back, { x: 1.5, y: 1.5, distanceMm: 0 });
    assert.equal(patientToImage([13, 22, 30.1], source), null);
    assert.equal(imageToPatient({ x: 1, y: 1 }, frame({ orientation: null })), null);
    const rotated = frame({ orientation: [0, 1, 0, -1, 0, 0] });
    assert.deepEqual(imageToPatient({ x: 1.5, y: 1.5 }, rotated), [8, 23, 30]);
    const rounded = frame({ orientation: [0.707107, 0.707107, 0, -0.707107, 0.707107, 0] });
    const point = { x: 2.1, y: 1.2 }, reconstructed = patientToImage(imageToPatient(point, rounded), rounded);
    near(reconstructed.x, point.x); near(reconstructed.y, point.y);
});

test('geometry fingerprints are versioned numeric hints and handle edits keep original scope', () => {
    const source = frame(), image = createImageReference(source);
    assert.match(image.geometryFingerprint, /^g1-[0-9a-f]{8}$/);
    assert.equal(geometryFingerprint(source), geometryFingerprint(frame()));
    assert.notEqual(geometryFingerprint(source), geometryFingerprint(frame({ position: [10, 20, 31] })));
    const original = { id: 'a1', tool: 'length', image, points: points([0, 0], [1, 1]) };
    assert.deepEqual(annotationHandles(original), [{ index: 0, x: 0, y: 0 }, { index: 1, x: 1, y: 1 }]);
    assert.deepEqual(moveAnnotationHandle(original, 1, { x: 2, y: 2 }).points, points([0, 0], [2, 2]));
    assert.deepEqual(translateAnnotation(original, 1, 1).points, points([1, 1], [2, 2]));
    assert.deepEqual(original.points, points([0, 0], [1, 1]));
    assert.throws(() => translateAnnotation(original, -1, 0), /outside/);
    assert.throws(() => moveAnnotationHandle(original, 5, { x: 1, y: 1 }), /handle index/);
});

for (const [tool, vertices] of [
    ['length', points([1, 1], [1, 1])], ['rectangle', points([0, 0], [0, 2])], ['ellipse', points([0, 0], [2, 0])],
    ['angle', points([0, 0], [1, 1], [1, 1])], ['polygon', points([0, 0], [1, 1], [2, 2])],
    ['polygon', points([0, 0], [3, 3], [0, 3], [3, 0])],
    ['polygon', points([0, 0], [3, 0], [1, 0], [3, 3], [0, 3])],
    ['polygon', points([0, 0], [3, 0], [3, 3], [1.5, 0], [0, 3])]
]) test(`${tool} degenerate/intersecting shape rejects before sampling`, () => assert.throws(() => validateShape(tool, vertices, frame()), /Invalid annotation/));

test('invalid bounds, calibration, sample layouts, and numeric overflow fail explicitly', () => {
    assert.throws(() => validateShape('length', points([0, 0], [4, 1]), frame()), /outside/);
    assert.throws(() => validateShape('polygon', Array.from({ length: 129 }, (_, i) => ({ x: i / 129, y: 1 })), frame()), /point count/);
    assert.throws(() => measureGeometry('length', points([0, 0], [1, 1]), frame({ pixelSpacing: [-1, 1] })), /Pixel Spacing/);
    assert.throws(() => roiStatistics('rectangle', points([0, 0], [3, 3]), frame({ samples: new Uint16Array(2) })), /samples/);
    assert.throws(() => roiStatistics('length', points([0, 0], [1, 1]), frame()), /closed ROI/);
    assert.throws(() => roiStatistics('rectangle', points([0, 0], [3, 3]), frame({ slope: 1e200 })), /numeric range/);
    assert.throws(() => createImageReference(frame(), { sopUid: '2.25.1111' }), /conflicts/);
    assert.throws(() => createImageReference(frame({ frameIndex: undefined })), /frameIndex/);
});
