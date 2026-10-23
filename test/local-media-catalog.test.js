import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalCatalog } from '../src/catalog/LocalCatalog.js';
import { SessionCatalog } from '../src/catalog/SessionCatalog.js';
import { resolveLocalMedia } from '../src/catalog/DicomDirectory.js';
import { indexLocalFile } from '../src/catalog/metadata.js';
import { createDicomdirMedia, mediaFixtureFiles, MEDIA_TRANSFER_SYNTAX } from './dicomdir-fixtures.js';

test('resolved media populates complete patient studies and series from verified image metadata, excluding the unreferenced decoy', async () => {
    const fixture = createDicomdirMedia(), media = await resolveLocalMedia(mediaFixtureFiles(fixture));
    const catalog = new LocalCatalog(), result = await catalog.addFiles(media.files, { references: media.references });
    assert.equal(result.added, 4); assert.equal(result.failed, 0);
    const patient = catalog.getView().patients[0];
    assert.equal(patient.studies.length, 2); assert.equal(patient.studies[0].series.length, 2);
    assert.equal(catalog.getState().series, 3); assert.equal(catalog.getState().instances, 4);
    assert.doesNotMatch(JSON.stringify(catalog.getView()), /Unreferenced decoy|Do not import/);
    assert.equal((await indexLocalFile(media.files[0])).transferSyntaxUid, MEDIA_TRANSFER_SYNTAX);
});

test('a stale SOP reference is a visible per-file failure and never overrides actual image identity', async () => {
    const media = await resolveLocalMedia(mediaFixtureFiles(createDicomdirMedia({ uidMismatch: true })));
    const catalog = new LocalCatalog(), result = await catalog.addFiles(media.files, { references: media.references });
    assert.equal(result.added, 3); assert.equal(result.failed, 1);
    assert.equal(result.failures[0].code, 'directory-mismatch');
    assert.doesNotMatch(JSON.stringify(catalog.getView()), /2\.25\.997\.999\.1/);
});

test('patient and hierarchy mismatches cannot silently attach a referenced file to the directory identity', async () => {
    const media = await resolveLocalMedia(mediaFixtureFiles(createDicomdirMedia()));
    for (const [field, value] of [['patientId', 'OTHER'], ['issuerOfPatientId', 'OTHER'], ['patientBirthDate', '19850101'],
        ['patientName', 'SYNTHETIC^OTHER'], ['studyUid', '2.25.9981'], ['seriesUid', '2.25.9982'],
        ['sopUid', '2.25.9983'], ['sopClassUid', '2.25.9984'], ['transferSyntaxUid', '1.2.840.10008.1.2']]) {
        const references = new Map(media.references), first = media.files[0];
        references.set(first, { ...references.get(first), [field]: value });
        const catalog = new LocalCatalog(), result = await catalog.addFiles(media.files, { references });
        assert.equal(result.added, 3, field); assert.equal(result.failed, 1, field);
        assert.equal(result.failures[0].code, 'directory-mismatch', field);
    }
});

test('cached exact-File duplicates are checked against new media assertions before being reported as duplicates', async () => {
    const media = await resolveLocalMedia(mediaFixtureFiles(createDicomdirMedia()));
    const catalog = new LocalCatalog(); await catalog.addFiles(media.files, { references: media.references });
    const references = new Map(media.references), first = media.files[0];
    references.set(first, { ...references.get(first), sopUid: '2.25.9983' });
    const result = await catalog.addFiles(media.files, { references });
    assert.equal(result.added, 0); assert.equal(result.duplicates, 3); assert.equal(result.failed, 1);
    assert.equal(catalog.getState().instances, 4);
});

test('conservative person-name separator normalization permits equivalent directory and image names', async () => {
    const media = await resolveLocalMedia(mediaFixtureFiles(createDicomdirMedia()));
    const references = new Map([...media.references].map(([file, expected]) => [file, { ...expected, patientName: ' SYNTHETIC ALPHA ' }]));
    const result = await new LocalCatalog().addFiles(media.files, { references });
    assert.equal(result.added, 4); assert.equal(result.failed, 0);
});

test('reselecting the same DICOMDIR media after closing the patient admits one fresh workspace without historical copies', async () => {
    const fixture = createDicomdirMedia(), local = new LocalCatalog(), session = new SessionCatalog();
    const select = async () => {
        // Every native folder picker creates new File wrappers, even for the
        // same physical files. These generated fixtures exercise that boundary.
        const media = await resolveLocalMedia(mediaFixtureFiles(fixture));
        const result = await local.addFiles(media.files, { references: media.references });
        const admissions = result.selection.map(choice => session.admitLocal(local.getView(), choice));
        return { result, admissions };
    };
    const first = await select(), previous = session.getPatient(first.admissions[0].patientId);
    assert.equal(session.getView().counts.patients, 1); assert.equal(previous.studies.length, 2);
    const localId = previous.provenance.patientId;
    assert.equal(local.removePatient(localId), true); assert.equal(session.removePatient(previous.id), true);
    assert.equal(local.getState().metadataBytes, 0);
    const repeated = await select(), reopened = session.getPatient(repeated.admissions[0].patientId);
    assert.equal(local.getState().patients, 1); assert.equal(session.getView().counts.patients, 1);
    assert.equal(local.getState().instances, 4); assert.equal(session.getView().counts.instances, 4);
    assert.notEqual(reopened.id, previous.id); assert.notEqual(reopened.provenance.patientId, localId);
    assert.equal(reopened.studies.length, 2); assert.equal(reopened.patientName, previous.patientName);
    assert.equal(reopened.studies.flatMap(study => study.series).every(series => series.instancesLoaded), true);
});
