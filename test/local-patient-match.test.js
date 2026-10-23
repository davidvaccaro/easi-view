import test from 'node:test';
import assert from 'node:assert/strict';
import { canReviewLocalPatients, possibleLocalPatientMatch } from '../src/ui/local-patient-match.js';

const local = (id, changes = {}) => ({ id, kind: 'local', sourceId: 'device', patientId: '00123', patientName: 'MÜLLER^JANE', patientBirthDate: '19800229', issuerOfPatientId: '', ...changes });

test('possible local patient matches require all three complete identity fields and only suggest review', () => {
    const left = local('a'), right = local('b'), before = structuredClone([left, right]);
    assert.equal(possibleLocalPatientMatch(left, right), true);
    assert.deepEqual([left, right], before);
    for (const changes of [{ patientId: '' }, { patientName: '' }, { patientBirthDate: '' }, { patientBirthDate: '198002' },
        { patientBirthDate: '19800230' }, { patientBirthDate: '00000229' }, { patientBirthDate: '1980-02-29' },
        { patientId: '123' }, { patientId: '00123a' }, { patientId: '00123A' }, { patientName: 'MÜLLER^Jane' },
        { patientName: 'MÜLLER^JANE^ANN' }, { patientName: 'MÜLLER^^JANE' }]) assert.equal(possibleLocalPatientMatch(left, local('b', changes)), false, JSON.stringify(changes));
    assert.equal(possibleLocalPatientMatch(local('a', { patientId: 'abc' }), local('b', { patientId: 'ABC' })), false);
});

test('full person names allow NFC and component padding without dropping differing components or representations', () => {
    assert.equal(possibleLocalPatientMatch(local('a'), local('b', { patientName: ' MU\u0308LLER ^ JANE ^^ ', patientId: ' 00123 ', patientBirthDate: '19800229 ' })), true);
    assert.equal(possibleLocalPatientMatch(local('a'), local('b', { patientName: 'MÜLLER^JANE=OTHER^NAME' })), false);
    assert.equal(possibleLocalPatientMatch(local('a', { patientName: '^^^' }), local('b', { patientName: '^^^' })), false);
});

test('suggestions exclude issuer conflict, remote/test records, foreign sources and the same record', () => {
    assert.equal(possibleLocalPatientMatch(local('a', { issuerOfPatientId: 'A' }), local('b', { issuerOfPatientId: 'B' })), false);
    assert.equal(possibleLocalPatientMatch(local('a', { issuerOfPatientId: 'A' }), local('b')), true);
    for (const changes of [{ kind: 'remote' }, { kind: 'test' }, { synthetic: true }, { sourceId: 'other' },
        { sourceId: '' }, { source: { kind: 'remote', id: 'device' } }, { provenance: { kind: 'remote', sourceId: 'device' } }]) {
        assert.equal(possibleLocalPatientMatch(local('a'), local('b', changes)), false);
        assert.equal(canReviewLocalPatients(local('a'), local('b', changes)), false);
    }
    assert.equal(possibleLocalPatientMatch(local('a'), local('a')), false);
    assert.equal(canReviewLocalPatients(local('a'), local('b', { patientId: 'different', patientBirthDate: '' })), true);
});
