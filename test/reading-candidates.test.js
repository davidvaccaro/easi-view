import test from 'node:test';
import assert from 'node:assert/strict';
import { describeReadingSeries } from '../src/protocols/candidates.js';

const base = { frameIndex: 0, rows: 4, columns: 6, modality: 'CT', photometric: 'MONOCHROME2', unit: 'HU',
    frameOfReferenceUid: '2.25.33', position: [0, 0, 0], orientation: [1, 0, 0, 0, 1, 0], pixelSpacing: [2, 3],
    classicDimensions: { spatialEligible: true, invalid: false, effectiveEchoTime: 12, temporalPositionIndex: 1 } };
const series = frames => ({ description: 'Synthetic stack', modality: 'CT', frames });

test('reading candidates expose normalized matching fields and preserve each acquisition stack without decoding or identity fields', () => {
    const input = series([{ ...base, sopUid: '2.25.1', studyUid: '2.25.2', patientName: 'SYNTHETIC-PRIVATE', samples: { get byteLength() { throw new Error('No pixels'); } } }, { ...base, frameIndex: 1, position: [0, 0, 2] }]);
    input.getAttributes = input.getFrame = () => { throw new Error('Metadata matching must not access display snapshots or decode.'); };
    const actual = describeReadingSeries(input, 3, 'current');
    assert.equal(actual.index, 3); assert.equal(actual.frameCount, 2); assert.equal(actual.geometryKnown, true); assert.equal(actual.unit, 'HU');
    assert.equal(actual.effectiveEchoTime, 12); assert.equal(actual.temporalPositionIndex, 1); assert.ok(Object.isFrozen(actual));
    assert.ok(!/sopUid|studyUid|patientName|samples|SYNTHETIC-PRIVATE|2\.25\./u.test(JSON.stringify(actual)));
    const second = describeReadingSeries(series([{ ...base, dimensions: { effectiveEchoTime: 40, temporalPositionIndex: 2 } }]), 4, 'prior');
    assert.equal(second.index, 4); assert.equal(second.effectiveEchoTime, 40); assert.equal(second.temporalPositionIndex, 2);
});

test('varied or absent metadata remains unknown and invalid optional dimensions cannot establish geometry eligibility', () => {
    const varied = describeReadingSeries(series([{ ...base }, { ...base, frameIndex: 1, unit: 'TEST', rows: 5, classicDimensions: { effectiveEchoTime: 40, invalid: true } }]), 0);
    assert.equal(varied.unit, null); assert.equal(varied.rows, null); assert.equal(varied.effectiveEchoTime, null); assert.equal(varied.dimensionsValid, false);
    assert.equal(describeReadingSeries(series([{ ...base, frameOfReferenceUid: null }]), 0).geometryKnown, false);
    assert.equal(describeReadingSeries(series([{ ...base, orientation: [2, 0, 0, 0, 1, 0] }]), 0).geometryKnown, false);
    assert.equal(describeReadingSeries(series([{ ...base, frameOfReferenceUid: 'invalid' }]), 0).geometryKnown, false);
    assert.equal(describeReadingSeries(series([{ ...base, photometric: 'RGB' }]), 0).unit, null);
    assert.equal(describeReadingSeries({ ...series([{ ...base }]), description: 'x'.repeat(257) }, 0).description, null);
    const text = describeReadingSeries({ ...series([{ ...base, unit: 'HU\n', classicDimensions: { acquisitionContrast: 'x'.repeat(65) } }]), description: 'Synthetic\nlabel' }, 0);
    assert.equal(text.description, null); assert.equal(text.unit, null); assert.equal(text.acquisitionContrast, null);
    for (const input of [null, series([]), { ...series([base]), disposed: true }]) assert.throws(() => describeReadingSeries(input, 0));
});
