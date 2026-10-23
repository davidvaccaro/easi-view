import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOptions } from '../src/integration/options.js';

test('host source registration validates and detaches settings without requesting credentials', () => {
    let credentialsRequested = 0;
    const headers = () => { ++credentialsRequested; return { Authorization: 'test-only' }; };
    const source = { id: 'pacs', name: 'Main archive', type: 'dicomweb', baseUrl: 'https://pacs.example/dicom-web/', headers,
        searchFields: ['patientId', 'patientName', 'patientBirthDate'] };
    const input = { sources: [source], opening: { tests: false, sourceEditing: false, localImages: false } };
    const result = normalizeOptions(input);
    assert.equal(credentialsRequested, 0); assert.equal(result.sources[0].headers, headers);
    source.searchFields.push('studyDate'); source.name = 'Changed'; input.opening.tests = true;
    assert.deepEqual(result.sources[0].searchFields, ['patientId', 'patientName', 'patientBirthDate']);
    assert.equal(result.sources[0].name, 'Main archive'); assert.equal(result.opening.tests, false);
});

test('invalid source descriptors fail before mounting or making a connection', () => {
    for (const sources of [null, {}, [{ id: 'same', name: 'A', type: 'dicomweb', baseUrl: 'https://pacs.example' },
        { id: 'same', name: 'B', type: 'dicomweb', baseUrl: 'https://pacs.example' }],
        [{ id: 'pacs', name: 'A', type: 'dimse', baseUrl: 'dicom://localhost:4242' }]]) {
        assert.throws(() => normalizeOptions({ sources }));
    }
});

test('opening policies reject unknown controls and incompatible synthetic initialization', () => {
    assert.throws(() => normalizeOptions({ opening: { upload: true } }), /unknown/);
    assert.throws(() => normalizeOptions({ opening: { tests: 'false' } }), /boolean/);
    assert.throws(() => normalizeOptions({ opening: { tests: false }, initialDemo: 'ct' }), /synthetic/);
    assert.equal(normalizeOptions({ ui: { demos: false }, initialDemo: 'ct' }).initialDemo, 'ct');
});

test('invalid accessor configuration does not execute host getters', () => {
    let accessed = false;
    const opening = Object.defineProperty({}, 'tests', { enumerable: true, get() { accessed = true; return true; } });
    assert.throws(() => normalizeOptions({ opening }), /data property/);
    assert.equal(accessed, false);
});
