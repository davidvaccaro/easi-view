import test from 'node:test';
import assert from 'node:assert/strict';
import EASI from '@xinonix/easi-js';
import { DicomWebClient } from '../src/data/DicomWebClient.js';
import { instanceNavigation } from '../src/data/instance-navigation.js';

const studyUid = '2.25.8851', seriesUid = '2.25.8851.1', sopClassUid = '1.2.840.10008.5.1.4.1.1.2';
const patient = { patientName: 'SYNTHETIC PATIENT', patientId: 'SYNTHETIC-1', issuerOfPatientId: 'SYNTHETIC-ISSUER', patientBirthDate: '19800102' };
const scope = { patient, sourceId: 'synthetic-pacs', studyUid, seriesUid };
const attr = (vr, ...Value) => ({ vr, Value });
const metadata = (overrides = {}) => ({
    '00080016': attr('UI', sopClassUid), '00080018': attr('UI', `${seriesUid}.1`),
    '0020000D': attr('UI', studyUid), '0020000E': attr('UI', seriesUid),
    '00100010': attr('PN', { Alphabetic: ' SYNTHETIC^PATIENT^^^ ' }), '00100020': attr('LO', patient.patientId),
    '00100021': attr('LO', patient.issuerOfPatientId), '00100030': attr('DA', patient.patientBirthDate),
    '00200013': attr('IS', 1), '00280008': attr('IS', 120),
    '7FE00010': { vr: 'OW', BulkDataURI: 'https://must-never-fetch.invalid/private-pixels' }, ...overrides
});
async function parse(items) {
    const result = await EASI.pipelineBuilder().fromByteStream().ofDicomMetadata().toInstances().build()
        .process({ source: new TextEncoder().encode(JSON.stringify(items)) });
    return result.toArray();
}

test('remote instance navigation consumes actual EASI metadata with one metadata request and no pixel fetch', async () => {
    const original = globalThis.fetch, requests = [];
    globalThis.fetch = async url => {
        requests.push(String(url));
        assert.equal(new URL(url).pathname, `/dicom-web/studies/${studyUid}/series/${seriesUid}/metadata`);
        return new Response(JSON.stringify([metadata()]), { headers: { 'content-type': 'application/dicom+json' } });
    };
    try {
        const client = new DicomWebClient({ baseUrl: 'https://archive.invalid/dicom-web' });
        const instances = await client.getSeriesMetadata(studyUid, seriesUid);
        const list = instanceNavigation(instances, { ...scope, patient: { ...patient, id: 'session-patient-1', studies: [], headers: { Authorization: 'private' } } });
        assert.deepEqual(list, [{ sourceId: scope.sourceId, studyUid, seriesUid, sopUid: `${seriesUid}.1`, sopClassUid, instanceNumber: 1, frameCount: 120 }]);
        assert.equal(requests.length, 1); assert.doesNotMatch(JSON.stringify(list), /private|patientName|patientId|BulkDataURI/);
    } finally { globalThis.fetch = original; }
});

for (const [field, tag, vr] of [['patientId', '00100020', 'LO'], ['issuerOfPatientId', '00100021', 'LO'],
    ['patientName', '00100010', 'PN'], ['patientBirthDate', '00100030', 'DA']]) {
    test(`instance navigation rejects missing or conflicting selected ${field} before publishing any list`, async () => {
        for (const replacement of [attr(vr, vr === 'PN' ? { Alphabetic: 'OTHER^PATIENT' } : 'OTHER'), { vr }]) {
            const instances = await parse([metadata(), metadata({ '00080018': attr('UI', `${seriesUid}.2`), [tag]: replacement })]);
            assert.throws(() => instanceNavigation(instances, scope), /patient identity does not match/);
        }
    });
}

test('metadata instance navigation validates parents and UIDs and never requires a supported render profile', async () => {
    for (const changes of [{ '0020000D': attr('UI', '2.25.9') }, { '0020000E': attr('UI', '2.25.9') },
        { '00080018': attr('UI', 'invalid') }, { '00080016': attr('UI', 'invalid') }]) {
        const instances = await parse([metadata(changes)]);
        assert.throws(() => instanceNavigation(instances, scope));
    }
    const duplicates = await parse([metadata(), metadata()]);
    assert.throws(() => instanceNavigation(duplicates, scope), /duplicate SOP/);
    const document = await parse([metadata({ '00080016': attr('UI', '1.2.840.10008.5.1.4.1.1.88.33'), '00280008': { vr: 'IS' } })]);
    assert.equal(instanceNavigation(document, scope)[0].sopClassUid, '1.2.840.10008.5.1.4.1.1.88.33');
    assert.equal(instanceNavigation(document, scope)[0].frameCount, 1);
});

test('instance numbers sort predictably without turning multi-frame instances into separate records', async () => {
    const instances = await parse([metadata({ '00200013': attr('IS', 5) }), metadata({ '00080018': attr('UI', `${seriesUid}.2`), '00200013': attr('IS', 2), '00280008': attr('IS', 1) })]);
    const list = instanceNavigation(instances, scope);
    assert.deepEqual(list.map(item => item.instanceNumber), [2, 5]);
    assert.deepEqual(list.map(item => item.frameCount), [1, 120]);
    for (const changes of [{ '00200013': attr('IS', '1.5') }, { '00280008': attr('IS', 0) }, { '00280008': attr('IS', -1) }, { '00200013': attr('IS', 1, 2) }]) {
        const malformed = await parse([metadata(changes)]);
        assert.throws(() => instanceNavigation(malformed, scope), /invalid instance navigation/);
    }
});

test('instance navigation rejects unbounded lists and malformed repository or selected-patient scope', async () => {
    const instances = await parse([metadata()]);
    assert.throws(() => instanceNavigation(Array(30001).fill(instances[0]), scope), /30,000/);
    for (const sourceId of ['', 'x'.repeat(4097), 'bad\nsource']) assert.throws(() => instanceNavigation(instances, { ...scope, sourceId }), /identified repository/);
    for (const selected of [null, [], { patientId: 42 }, { patientName: 'x'.repeat(4097) }]) assert.throws(() => instanceNavigation(instances, { ...scope, patient: selected }));
    assert.deepEqual(instanceNavigation([], scope), []);
});
