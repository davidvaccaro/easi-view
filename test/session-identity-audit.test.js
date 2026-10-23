import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionCatalog } from '../src/catalog/SessionCatalog.js';

for (const [status, patientId] of [['study-scoped', ''], ['demographics-conflict', 'SYNTHETIC-1']]) {
    test(`lazy series admission retains the original ${status} candidate workspace`, () => {
        const catalog = new SessionCatalog();
        const admission = catalog.admitRemote('synthetic', { id: 'remote-candidate-original', patientId,
            patientName: 'SYNTHETIC PATIENT', issuerOfPatientId: 'SYNTHETIC', patientBirthDate: '20000101', identityStatus: status },
        [{ studyUid: '2.25.9981', patientId, patientName: 'SYNTHETIC PATIENT', issuerOfPatientId: 'SYNTHETIC', patientBirthDate: '20000101' }]);
        const original = admission.studyIds[0];
        const updated = catalog.setStudySeries(original, [{ studyUid: '2.25.9981', seriesUid: '2.25.9981.1', description: 'Synthetic series', modality: 'CT' }]);
        assert.equal(catalog.getView().counts.patients, 1);
        assert.equal(catalog.getView().counts.studies, 1);
        assert.equal(updated.id, original);
        assert.equal(updated.series.length, 1);
        assert.equal(updated.seriesLoaded, true);
        assert.equal(updated.series[0].patientIdOpaque, admission.patientId);
    });
}
