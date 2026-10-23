import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalOpenSelection } from '../src/catalog/LocalOpenSelection.js';
import { createDicomdirMedia, mediaFixtureFiles } from './dicomdir-fixtures.js';
import { createLocalLibraryFixtures, fixtureFile } from './local-library-fixtures.js';

test('Open Images scans exactly the chosen folder contents without following DICOMDIR', async () => {
    const selection = new LocalOpenSelection(), media = createDicomdirMedia();
    const preview = await selection.preview(mediaFixtureFiles(media), { intent: 'images' });
    assert.equal(preview.counts.instances, 5);
    assert.ok(preview.patients.flatMap(patient => patient.studies).some(study => study.description === 'Unreferenced decoy'));
    assert.ok(preview.warnings.some(message => /DICOMDIR/.test(message)));
    selection.dispose();
});

test('Open Study follows only indexed media and resolves only explicitly checked studies', async () => {
    const selection = new LocalOpenSelection(), media = createDicomdirMedia({ multiPatient: true });
    const preview = await selection.preview(mediaFixtureFiles(media), { intent: 'study' });
    assert.equal(preview.counts.instances, 5); assert.equal(preview.patients.length, 2);
    const patient = preview.patients.find(item => item.patientId === 'MEDIA_ALPHA');
    const study = patient.studies.find(item => item.description === 'Media baseline');
    const chosen = selection.resolve(preview, { patientId: patient.id, studyIds: [study.id] });
    assert.equal(chosen.files.length, 1); assert.equal(chosen.media.mode, 'dicomdir');
    assert.equal(chosen.references.size, 5);
    assert.throws(() => selection.resolve(preview, { patientId: preview.patients.find(item => item.id !== patient.id).id, studyIds: [study.id] }), /belong/);
    selection.dispose();
});

test('a folder without DICOMDIR offers the explicit image scanning path', async () => {
    const selection = new LocalOpenSelection(), fixture = createLocalLibraryFixtures()[0];
    await assert.rejects(selection.preview([fixtureFile(fixture)], { intent: 'study' }), /No DICOMDIR.*Open Images/);
    const preview = await selection.preview([fixtureFile(fixture)]);
    assert.equal(preview.counts.instances, 1); selection.dispose();
});

test('Open Images does not inspect a sibling file outside the granted selection', async () => {
    const selection = new LocalOpenSelection(), fixtures = createLocalLibraryFixtures();
    const selected = fixtureFile(fixtures[0]), sibling = fixtureFile(fixtures[1]);
    Object.defineProperty(sibling, 'stream', { value() { throw new Error('An unselected sibling was read.'); } });
    const preview = await selection.preview([selected]);
    const patient = preview.patients[0], study = patient.studies[0];
    assert.deepEqual(selection.resolve(preview, { patientId: patient.id, studyIds: [study.id] }).files, [selected]);
    selection.dispose();
});

test('preview cancellation and replacement invalidate private file reference tokens', async () => {
    const selection = new LocalOpenSelection(), files = createLocalLibraryFixtures().slice(0, 2).map(fixtureFile);
    const first = await selection.preview(files.slice(0, 1));
    const second = await selection.preview(files.slice(1));
    assert.throws(() => selection.resolve(first, {}), /expired/);
    selection.clear(); assert.throws(() => selection.resolve(second, {}), /expired/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(selection.preview(files, { signal: controller.signal }), { name: 'AbortError' });
    selection.dispose(); await assert.rejects(selection.preview(files), /disposed/);
});

test('Images can select studies across patients without merging their identities', async () => {
    const selection = new LocalOpenSelection(), fixtures = createLocalLibraryFixtures();
    const preview = await selection.preview([fixtureFile(fixtures[0]), fixtureFile(fixtures.find(item => item.key === 'other-patient'))]);
    assert.equal(preview.patients.length, 2);
    const chosen = selection.resolve(preview, { selection: preview.patients.map(patient => ({ patientId: patient.id, studyIds: patient.studies.map(study => study.id) })) });
    assert.equal(chosen.files.length, 2);
    assert.throws(() => selection.resolve(preview, { selection: [] }), /at least/);
    const patient = preview.patients[0];
    assert.throws(() => selection.resolve(preview, { patientId: patient.id, studyIds: [patient.studies[0].id, patient.studies[0].id] }), /once/);
    selection.dispose();
});

test('excluding subfolders skips nested files while retaining images in the selected root', async () => {
    const selection = new LocalOpenSelection(), fixtures = createLocalLibraryFixtures();
    const files = fixtures.slice(0, 2).map(fixtureFile);
    Object.defineProperty(files[0], 'webkitRelativePath', { value: 'ROOT/IMAGE1' });
    Object.defineProperty(files[1], 'webkitRelativePath', { value: 'ROOT/SUB/IMAGE2' });
    const preview = await selection.preview(files, { includeSubfolders: false });
    assert.equal(preview.counts.instances, 1); selection.dispose();
});
