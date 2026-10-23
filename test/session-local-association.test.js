import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalCatalog } from '../src/catalog/LocalCatalog.js';
import { SessionCatalog } from '../src/catalog/SessionCatalog.js';
import { createDicomFixture } from '../src/data/synthetic.js';

function image(number, { study = number, modality = 'CT', issuer = '', name = 'SYNTHETIC^ONE', patientId = 'SYNTHETIC-MRN' } = {}) {
    return new File([createDicomFixture({ sopUid: `2.25.${number}`, seriesUid: `2.25.${study}.1`, values: [10, 20, 30, 40],
        extraAttributes: { '00100010': ['PN', name], '00100020': ['LO', patientId], '00100021': issuer ? ['LO', issuer] : null,
            '00100030': ['DA', '19800101'], '0020000D': ['UI', `2.25.${study}.2`], '00080060': ['CS', modality] } })], 'IMAGE');
}
async function collection() {
    const local = new LocalCatalog(), session = new SessionCatalog();
    const targetFiles = [image(101, { modality: 'MR' })], sourceFiles = [image(201), image(202), image(203)];
    const targetImport = await local.addFiles(targetFiles), sourceImport = await local.addFiles(sourceFiles);
    const targetLocal = local.getPatient(targetImport.patientIds[0]), sourceLocal = local.getPatient(sourceImport.patientIds[0]);
    const target = session.admitLocal(local.getView(), { patientId: targetLocal.id, studyIds: targetLocal.studies.map(study => study.id) });
    const source = session.admitLocal(local.getView(), { patientId: sourceLocal.id, studyIds: sourceLocal.studies.slice(0, 2).map(study => study.id) });
    return { local, session, targetLocal, sourceLocal, target, source, targetFiles, sourceFiles };
}
function combine(fixture) {
    const { local, session, source, target, sourceLocal, targetLocal } = fixture;
    const commit = session.prepareLocalAssociation(source.patientId, target.patientId, { confirmed: true });
    local.confirmAssociation(sourceLocal.id, targetLocal.id, { confirmed: true });
    return commit();
}
const identifiers = catalog => catalog.getView().patients.flatMap(patient => patient.studies.map(study => ({ id: study.id,
    series: study.series.map(series => ({ id: series.id, instances: series.instances.map(instance => instance.id) })) }))).sort((a, b) => a.id.localeCompare(b.id));

test('confirmed local association keeps admitted study, series, instance IDs and original provenance without admitting unchecked studies', async () => {
    const f = await collection(), before = identifiers(f.session), original = f.session.getPatient(f.source.patientId);
    assert.equal(f.local.getState().studies, 4); assert.equal(f.session.getView().counts.studies, 3);
    const combined = combine(f), patient = f.session.getPatient(f.target.patientId);
    assert.equal(combined.patientId, f.target.patientId); assert.equal(f.session.getPatient(f.source.patientId), null);
    assert.deepEqual(f.session.getView().counts, { patients: 1, studies: 3, series: 3, instances: 3, frames: 3 });
    assert.deepEqual(identifiers(f.session), before);
    assert.equal(patient.identityStatus, 'confirmed-association'); assert.equal(patient.originalIdentities.length, 2);
    assert.equal(patient.provenance.patientId, f.targetLocal.id);
    for (const study of original.studies) {
        const retained = f.session.getStudy(study.id);
        assert.equal(retained.patientIdOpaque, patient.id); assert.deepEqual(retained.provenance, study.provenance);
        assert.equal(retained.sourceId, study.sourceId);
        for (const series of study.series) {
            const moved = f.session.getSeries(series.id);
            assert.equal(moved.patientId, patient.id); assert.equal(moved.patientIdOpaque, patient.id);
            assert.deepEqual(moved.provenance, series.provenance); assert.deepEqual(moved.instances, series.instances);
            assert.equal(f.local.getSeriesFiles(moved.provenance.seriesId).length, 1);
        }
    }
    const hidden = f.sourceLocal.studies.at(-1);
    assert.ok(!patient.studies.some(study => study.provenance.studyId === hidden.id));
    assert.equal(f.local.getPatient(f.targetLocal.id).studies.length, 4);
    assert.equal(Object.isFrozen(patient.originalIdentities), true);
});

test('selected re-admission after an association reuses moved keys, then admits only a newly selected study', async () => {
    const f = await collection(); combine(f);
    const before = identifiers(f.session), moved = f.session.getStudy(f.source.studyIds[0]);
    const refreshed = f.session.admitLocal(f.local.getView(), { patientId: f.targetLocal.id, studyIds: [moved.provenance.studyId] });
    assert.equal(refreshed.patientId, f.target.patientId); assert.equal(refreshed.addedStudies, 0);
    assert.deepEqual(refreshed.studyIds, [moved.id]); assert.deepEqual(identifiers(f.session), before);
    const fresh = await f.local.addFiles([image(301, { issuer: 'SYNTHETIC-ISSUER' })]);
    // Explicitly associate this third original identity before admitting its selection.
    f.local.confirmAssociation(fresh.patientIds[0], f.targetLocal.id, { confirmed: true });
    const added = f.session.admitLocal(f.local.getView(), { patientId: f.targetLocal.id, studyIds: fresh.selection[0].studyIds });
    assert.equal(added.patientId, f.target.patientId); assert.equal(added.addedStudies, 1);
    assert.equal(f.session.getView().counts.studies, 4);
    for (const item of before) assert.deepEqual(identifiers(f.session).find(candidate => candidate.id === item.id), item);
    assert.ok(!f.session.getPatient(f.target.patientId).studies.some(study => study.provenance.studyId === f.sourceLocal.studies.at(-1).id));
});

test('invalid or unconfirmed local associations do not partially mutate ownership', async () => {
    const f = await collection(), before = f.session.getView();
    for (const options of [{}, { confirmed: false }, { confirmed: true, extra: true }, null]) {
        assert.throws(() => f.session.associateLocalPatients(f.source.patientId, f.target.patientId, options), /confirm/i);
        assert.equal(f.session.getView(), before);
    }
    assert.throws(() => f.session.associateLocalPatients(f.target.patientId, f.target.patientId, { confirmed: true }), /two local/i);
    assert.throws(() => f.session.associateLocalPatients('missing', f.target.patientId, { confirmed: true }), /two local/i);
    const foreign = f.session.admitLocal(f.local.getView(), { sourceId: 'different-local-source', patientId: f.sourceLocal.id, studyIds: [f.sourceLocal.studies[0].id] });
    const foreignBefore = f.session.getView();
    assert.throws(() => f.session.associateLocalPatients(foreign.patientId, f.target.patientId, { confirmed: true }), /same source/i);
    assert.equal(f.session.getView(), foreignBefore);
    const synthetic = f.session.admitTest('ct'), syntheticBefore = f.session.getView();
    assert.throws(() => f.session.associateLocalPatients(synthetic.patientId, f.target.patientId, { confirmed: true }), /two local/i);
    assert.equal(f.session.getView(), syntheticBefore);
});

test('prepared associations are side-effect-free, one-shot and rejected after intervening catalog changes', async () => {
    const f = await collection(), before = f.session.getView();
    const stale = f.session.prepareLocalAssociation(f.source.patientId, f.target.patientId, { confirmed: true });
    assert.equal(f.session.getView(), before);
    f.session.selectPatient(f.source.patientId); const changed = f.session.getView();
    assert.throws(stale, /superseded/); assert.equal(f.session.getView(), changed);
    const commit = f.session.prepareLocalAssociation(f.source.patientId, f.target.patientId, { confirmed: true });
    commit(); const completed = f.session.getView();
    assert.throws(commit, /superseded/); assert.equal(f.session.getView(), completed);
    assert.equal(completed.activePatientId, f.target.patientId);
});

test('same-UID original study records stay independently selectable after explicit association', async () => {
    const local = new LocalCatalog(), session = new SessionCatalog();
    const imports = [await local.addFiles([image(101, { study: 900 })]), await local.addFiles([image(102, { study: 900 })])];
    const admissions = imports.map(result => session.admitLocal(local.getView(), result.selection[0]));
    const before = identifiers(session), patientIds = admissions.map(item => item.patientId);
    session.associateLocalPatients(patientIds[1], patientIds[0], { confirmed: true });
    assert.deepEqual(identifiers(session), before); assert.equal(session.getView().counts.studies, 2);
    const studies = session.getPatient(patientIds[0]).studies;
    assert.equal(studies[0].studyUid, studies[1].studyUid); assert.notEqual(studies[0].id, studies[1].id);
    assert.notEqual(studies[0].provenance.patientId, studies[1].provenance.patientId);
});

test('transitive confirmed associations retain stable keys and closing releases all original local groups', async () => {
    const f = await collection(); combine(f);
    const thirdImport = await f.local.addFiles([image(401)]), thirdLocal = f.local.getPatient(thirdImport.patientIds[0]);
    const third = f.session.admitLocal(f.local.getView(), thirdImport.selection[0]), before = identifiers(f.session);
    const commit = f.session.prepareLocalAssociation(third.patientId, f.target.patientId, { confirmed: true });
    f.local.confirmAssociation(thirdLocal.id, f.targetLocal.id, { confirmed: true }); commit();
    const combined = f.session.getPatient(f.target.patientId);
    assert.equal(combined.originalIdentities.length, 3); assert.deepEqual(identifiers(f.session), before);
    const seriesIds = f.local.getPatient(f.targetLocal.id).studies.flatMap(study => study.series.map(series => series.id));
    f.session.removePatient(f.target.patientId); assert.equal(f.local.removePatient(f.targetLocal.id), true);
    assert.equal(f.local.getState().instances, 0); assert.equal(f.session.getView().counts.patients, 0);
    for (const id of seriesIds) assert.throws(() => f.local.getSeriesFiles(id), /Choose an indexed/);
    const reopened = await f.local.addFiles([image(101, { modality: 'MR' })]);
    const readmitted = f.session.admitLocal(f.local.getView(), reopened.selection[0]);
    assert.notEqual(readmitted.patientId, f.target.patientId); assert.equal(f.session.getView().counts.studies, 1);
});

test('original identities retain only bounded navigation fields rather than private source objects', async () => {
    const f = await collection(), view = structuredClone(f.local.getView()), identity = view.patients[0].originalIdentities[0];
    identity.headers = { Authorization: 'secret' }; identity.file = new File(['private'], 'private');
    const session = new SessionCatalog(); session.admitLocal(view, { patientId: view.patients[0].id, studyIds: view.patients[0].studies.map(study => study.id) });
    assert.equal(JSON.stringify(session.getView()).includes('secret'), false);
    assert.deepEqual(Object.keys(session.getView().patients[0].originalIdentities[0]), ['patientName', 'patientId', 'issuerOfPatientId', 'patientBirthDate']);
    identity.patientName = 'x'.repeat(4097); const before = session.getView();
    assert.throws(() => session.admitLocal(view, { patientId: view.patients[0].id, studyIds: view.patients[0].studies.map(study => study.id) }), /text limit/);
    assert.equal(session.getView(), before);
});

test('original identity count limits reject oversized admission and association before changing the catalog', async () => {
    const f = await collection(), view = structuredClone(f.local.getView()), session = new SessionCatalog();
    view.patients[0].originalIdentities = Array.from({ length: 30001 }, () => ({}));
    assert.throws(() => session.admitLocal(view, { patientId: view.patients[0].id, studyIds: [view.patients[0].studies[0].id] }), /30,000 original/);
    assert.equal(session.getView().counts.patients, 0);
    const admitted = view.patients.map(patient => {
        patient.originalIdentities = Array.from({ length: 15001 }, () => ({}));
        return session.admitLocal(view, { patientId: patient.id, studyIds: [patient.studies[0].id] });
    });
    const before = session.getView();
    assert.throws(() => session.prepareLocalAssociation(admitted[1].patientId, admitted[0].patientId, { confirmed: true }), /30,000 original/);
    assert.equal(session.getView(), before); assert.equal(before.counts.patients, 2);
});
