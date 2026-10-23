import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageReference } from '../src/annotations/model.js';
import { matchesPresentation, displayFrame } from '../src/integration/presentation.js';
import { renderScalarToRgba, probe } from '../src/render/DisplayMath.js';
import { sourceFrame } from './derived-fixtures.js';

function presentation(frame, changes = {}) { return { image: createImageReference(frame), window: { center: 20, width: 20, voiFunction: 'LINEAR_EXACT' }, presentationShape: 'IDENTITY', presentationInvert: false, ...changes }; }

test('GSPS display clones only presentation metadata and preserves original samples, transforms, geometry and quantitative probes', () => {
    const frame = { ...sourceFrame(), samples: new Uint16Array([10, 20, 30]), slope: 2, intercept: -10, window: { center: 5, width: 10 }, voiFunction: 'LINEAR', voiMode: 'lut', voiLut: { count: 1, firstMapped: 0, bits: 8, entries: new Uint16Array([1]) } };
    const original = { window: { ...frame.window }, values: [...frame.samples], voiLut: frame.voiLut }, selected = displayFrame(frame, presentation(frame));
    assert.notEqual(selected, frame); assert.equal(selected.samples, frame.samples); assert.equal(selected.position, frame.position); assert.equal(selected.orientation, frame.orientation);
    assert.equal(selected.slope, 2); assert.equal(selected.intercept, -10); assert.equal(selected.voiLut, null); assert.equal(selected.voiMode, 'window'); assert.equal(selected.voiFunction, 'LINEAR_EXACT');
    assert.deepEqual(frame.window, original.window); assert.equal(frame.voiLut, original.voiLut); assert.deepEqual([...frame.samples], original.values);
    assert.deepEqual(probe(selected, 0, 0), probe(frame, 0, 0));
    assert.deepEqual([...renderScalarToRgba(selected).subarray(0, 12)], [0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
});

test('declared GSPS polarity is absolute for MONOCHROME1/2 and does not double-apply intrinsic image inversion', () => {
    for (const photometric of ['MONOCHROME1', 'MONOCHROME2']) {
        const frame = { ...sourceFrame(), photometric, presentationInvert: photometric === 'MONOCHROME1' };
        const identity = displayFrame(frame, presentation(frame)), inverse = displayFrame(frame, presentation(frame, { presentationShape: 'INVERSE', presentationInvert: true }));
        assert.equal(renderScalarToRgba(identity)[0], 0); assert.equal(renderScalarToRgba(inverse)[0], 255);
        assert.equal(frame.presentationInvert, photometric === 'MONOCHROME1');
    }
});

test('wrong SOP/frame/grid/Series/FoR/fingerprint, including missing optional scope, leaves the original display unchanged', () => {
    const frame = sourceFrame(), selected = presentation(frame);
    for (const key of ['sopUid', 'frameNumber', 'rows', 'columns', 'seriesUid', 'frameOfReferenceUid', 'geometryFingerprint']) {
        const changed = structuredClone(selected);
        changed.image[key] = ['frameNumber', 'rows', 'columns'].includes(key) ? changed.image[key] + 1 : key === 'geometryFingerprint' ? 'g1-ffffffff' : '2.25.999';
        assert.equal(matchesPresentation(frame, changed), false); assert.equal(displayFrame(frame, changed), frame);
    }
    for (const key of ['seriesUid', 'frameOfReferenceUid', 'geometryFingerprint']) { const absent = structuredClone(selected); delete absent.image[key]; assert.equal(displayFrame(frame, absent), frame); }
    const unknown = { ...frame }; delete unknown.frameOfReferenceUid; assert.equal(displayFrame(unknown, selected), unknown);
    assert.equal(displayFrame(frame, null), frame); assert.equal(displayFrame(frame, { measurements: [] }), frame);
});

test('matching but unsupported/invalid presentation fails before altering original window or samples', () => {
    const frame = sourceFrame(), original = [...frame.samples];
    for (const changes of [{ window: { center: 1, width: 0 } }, { window: { center: NaN, width: 1 } }, { window: { center: 1, width: 2, voiFunction: 'unknown' } },
        { presentationInvert: 1 }, { presentationShape: 'INVERSE', presentationInvert: false }]) assert.throws(() => displayFrame(frame, presentation(frame, changes)));
    const color = { ...frame, photometric: 'RGB' }; assert.throws(() => displayFrame(color, presentation(color)), /grayscale/);
    const lut = { ...frame, modalityLut: {} }; assert.throws(() => displayFrame(lut, presentation(lut)), /grayscale/);
    assert.deepEqual([...frame.samples], original);
});

test('SIGMOID presentation window uses the declared modality VOI without changing stored sample precision', () => {
    const frame = { ...sourceFrame(), samples: new Uint16Array([10, 20, 30]) }, selected = displayFrame(frame, presentation(frame, { window: { center: 20, width: 4, voiFunction: 'SIGMOID' } }));
    assert.equal(selected.voiFunction, 'SIGMOID'); assert.equal(renderScalarToRgba(selected)[4], 128); assert.equal(selected.samples, frame.samples);
});
