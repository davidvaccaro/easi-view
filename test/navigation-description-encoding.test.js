import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocalMedia } from '../src/catalog/DicomDirectory.js';
import LocalCatalog from '../src/catalog/LocalCatalog.js';
import { indexLocalFile } from '../src/catalog/metadata.js';
import { setLocalRelativePath } from '../src/catalog/local-paths.js';
import { createDicomFixture } from '../src/data/synthetic.js';
import { createDicomdirFixture } from './dicomdir-fixtures.js';

const encoder = new TextEncoder();
const STUDY_UID = '2.25.732.1', SERIES_UID = `${STUDY_UID}.1`, SOP_UID = `${SERIES_UID}.1`;
const PATIENT_NAME = 'SYNTHETIC^ENCODING', PATIENT_ID = 'ENCODING-PATIENT', ISSUER = 'ENCODING-ISSUER';
const DESCRIPTION_TAGS = ['00081030', '0008103E'];
const privateText = /SYNTHETIC|ENCODING-PATIENT|ENCODING-ISSUER|OMIT_THIS_LABEL|2\.25\.732/u;

function rawText(value) {
    const bytes = value instanceof Uint8Array ? value : encoder.encode(value);
    return bytes.length % 2 ? new Uint8Array([...bytes, 32]) : bytes;
}
function invalidDescription() { return rawText(new Uint8Array([...encoder.encode('OMIT_THIS_LABEL '), 0xb0])); }
function latinText(value) { return rawText(new Uint8Array(Array.from(value, character => character.charCodeAt(0)))); }
function localFile(bytes, path) {
    const file = new File([bytes], path.split('/').at(-1), { type: 'application/dicom' });
    setLocalRelativePath(file, path);
    return file;
}
function records({ patientAttributes = {}, studyAttributes = {}, seriesAttributes = {}, leafAttributes = {} } = {}) {
    return [{ type: 'PATIENT', patientName: PATIENT_NAME, patientId: PATIENT_ID,
        attributes: { '00100021': ['LO', ISSUER], ...patientAttributes },
        children: [{ type: 'STUDY', studyUid: STUDY_UID, studyDate: '20261019', studyTime: '110000',
            studyDescription: 'Synthetic study', attributes: studyAttributes,
            children: [{ type: 'SERIES', seriesUid: SERIES_UID, modality: 'MR',
                attributes: { '0008103E': ['LO', 'Synthetic series'], ...seriesAttributes },
                children: [{ type: 'IMAGE', fileId: ['IMAGES', 'IM000001'], sopUid: SOP_UID, attributes: leafAttributes }] }] }] }];
}
async function directoryResult(options = {}, { readImages = false } = {}) {
    const bytes = createDicomdirFixture(records(options)), original = bytes.slice();
    const directory = localFile(bytes, 'SYNTHETIC_DISC/DICOMDIR');
    const imageBytes = new Uint8Array([1, 2]), image = localFile(imageBytes, 'SYNTHETIC_DISC/IMAGES/IM000001');
    if (!readImages) Object.defineProperty(image, 'stream', { value: () => { throw new Error('Directory resolution must not read image data.'); } });
    const result = await resolveLocalMedia([directory, image]);
    assert.deepEqual(bytes, original, 'The generated source buffer remains unchanged.');
    assert.deepEqual(new Uint8Array(await directory.arrayBuffer()), original, 'The local DICOMDIR File remains unchanged.');
    assert.deepEqual(new Uint8Array(await image.arrayBuffer()), imageBytes, 'Referenced local files remain unchanged.');
    return { ...result, image };
}
async function rejectsDirectory(options, pattern = /text|character set|encoding|navigation|size/iu) {
    const bytes = createDicomdirFixture(records(options)), original = bytes.slice();
    await assert.rejects(resolveLocalMedia([localFile(bytes, 'SYNTHETIC_DISC/DICOMDIR'),
        localFile(new Uint8Array([1, 2]), 'SYNTHETIC_DISC/IMAGES/IM000001')]),
    error => error.code === 'dicomdir-invalid' && pattern.test(error.message));
    assert.deepEqual(bytes, original);
}
function imageFixture(extraAttributes = {}) {
    return createDicomFixture({ modality: 'MR', sopUid: SOP_UID, seriesUid: SERIES_UID,
        extraAttributes: { '00100010': ['PN', PATIENT_NAME], '00100020': ['LO', PATIENT_ID],
            '00100021': ['LO', ISSUER], '0020000D': ['UI', STUDY_UID], '00080020': ['DA', '20261019'],
            '00081030': ['LO', 'Synthetic study'], '0008103E': ['LO', 'Synthetic series'], ...extraAttributes } });
}
function assertOmissionWarnings(warnings) {
    assert.match(warnings.join(' '), /description/iu);
    assert.match(warnings.join(' '), /omitted/iu);
    assert.doesNotMatch(JSON.stringify(warnings), privateText, 'Warnings contain no source values, identities, filenames or UIDs.');
}

test('malformed optional DICOMDIR study and series labels are omitted without reading or changing source files', async () => {
    const result = await directoryResult({ studyAttributes: { '00081030': ['LO', invalidDescription()] },
        seriesAttributes: { '0008103E': ['LO', invalidDescription()] } });
    assert.deepEqual(result.files, [result.image]);
    assert.equal(result.report.resolved, 1);
    assert.equal(result.report.invalid, 0);
    const reference = result.references.get(result.image);
    assert.equal(reference.studyDescription, '');
    assert.equal(reference.seriesDescription, '');
    assert.equal(reference.patientName, PATIENT_NAME);
    assert.equal(reference.patientId, PATIENT_ID);
    assert.equal(reference.issuerOfPatientId, ISSUER);
    assert.equal(reference.studyUid, STUDY_UID);
    assert.equal(reference.seriesUid, SERIES_UID);
    assert.equal(reference.sopUid, SOP_UID);
    assertOmissionWarnings(result.report.warnings);
});

test('valid UTF-8 and declared Latin-1 descriptions retain their accents', async () => {
    for (const [charset, description] of [['ISO_IR 192', rawText('SYNTHETIC café')], ['ISO_IR 100', latinText('SYNTHETIC café')]]) {
        const attributes = { '00080005': ['CS', charset] };
        const result = await directoryResult({ studyAttributes: { ...attributes, '00081030': ['LO', description] },
            seriesAttributes: { ...attributes, '0008103E': ['LO', description] } });
        const reference = result.references.get(result.image);
        assert.equal(reference.studyDescription, 'SYNTHETIC café');
        assert.equal(reference.seriesDescription, 'SYNTHETIC café');
        assert.deepEqual(result.report.warnings, []);
    }
});

test('a UTF-8 study record overrides a linked Latin-1 patient record without changing patient identity', async () => {
    const result = await directoryResult({ patientAttributes: { '00080005': ['CS', 'ISO_IR 100'],
        '00100010': ['PN', latinText('SYNTHETIC^André')] },
    studyAttributes: { '00080005': ['CS', 'ISO_IR 192'], '00081030': ['LO', rawText('SYNTHETIC café')] } });
    const reference = result.references.get(result.image);
    assert.equal(reference.patientName, 'SYNTHETIC^André');
    assert.equal(reference.studyDescription, 'SYNTHETIC café');
    assert.deepEqual(result.report.warnings, []);
});

test('undeclared child record encoding never inherits Latin-1 through DICOMDIR links', async () => {
    const result = await directoryResult({ patientAttributes: { '00080005': ['CS', 'ISO_IR 100'],
        '00100010': ['PN', latinText('SYNTHETIC^André')] },
    seriesAttributes: { '0008103E': ['LO', invalidDescription()] } });
    const reference = result.references.get(result.image);
    assert.equal(reference.patientName, 'SYNTHETIC^André');
    assert.equal(reference.studyDescription, 'Synthetic study');
    assert.equal(reference.seriesDescription, '');
    assertOmissionWarnings(result.report.warnings);
});

test('an unsupported declared DICOMDIR charset remains an error even for an optional description', async () => {
    await rejectsDirectory({ seriesAttributes: { '00080005': ['CS', 'ISO 2022 IR 87'], '0008103E': ['LO', invalidDescription()] } }, /unsupported.*character set/iu);
});

for (const [tag, vr] of [['00100010', 'PN'], ['00100020', 'LO'], ['00100021', 'LO']]) {
    test(`invalid DICOMDIR patient identity text ${tag} is never repaired or omitted`, async () => {
        await rejectsDirectory({ patientAttributes: { [tag]: [vr, invalidDescription()] } }, /invalid text encoding/iu);
    });
}

test('invalid encoded DICOMDIR UIDs and File IDs remain errors', async () => {
    await rejectsDirectory({ studyAttributes: { '0020000D': ['UI', invalidDescription()] } }, /invalid text encoding/iu);
    await rejectsDirectory({ leafAttributes: { '00041511': ['UI', invalidDescription()] } }, /invalid text encoding/iu);
    await rejectsDirectory({ leafAttributes: { '00041500': ['CS', invalidDescription()] } }, /invalid text encoding/iu);
});

for (const [tag, location] of [['00081030', 'studyAttributes'], ['0008103E', 'seriesAttributes']]) {
    test(`DICOMDIR ${tag} controls and text/byte limits remain fatal`, async () => {
        await rejectsDirectory({ [location]: { [tag]: ['LO', rawText('SYNTHETIC\u0001LABEL')] } }, /invalid.*navigation text/iu);
        await rejectsDirectory({ [location]: { [tag]: ['LO', 'A'.repeat(514)] } }, /excessive.*navigation text/iu);
        await rejectsDirectory({ [location]: { [tag]: ['LO', 'A'.repeat(2050)] } }, /size limit/iu);
    });
}

test('metadata indexing omits only malformed optional descriptions and preserves the original image bytes', async () => {
    const bytes = imageFixture(Object.fromEntries(DESCRIPTION_TAGS.map(tag => [tag, ['LO', invalidDescription()]]))), original = bytes.slice();
    const file = new File([bytes], 'SYNTHETIC_IMAGE');
    const metadata = await indexLocalFile(file);
    assert.equal(metadata.studyDescription, '');
    assert.equal(metadata.seriesDescription, '');
    assert.equal(metadata.patientName, PATIENT_NAME);
    assert.equal(metadata.patientId, PATIENT_ID);
    assert.equal(metadata.issuerOfPatientId, ISSUER);
    assert.equal(metadata.studyUid, STUDY_UID);
    assert.equal(metadata.seriesUid, SERIES_UID);
    assert.equal(metadata.sopUid, SOP_UID);
    assert.equal(metadata.indexStatus, 'metadata-only');
    assert.equal(metadata.availability, 'unverified');
    assertOmissionWarnings(metadata.warnings);
    assert.deepEqual(bytes, original);
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), original);
});

test('metadata indexing preserves supported non-ASCII descriptions rather than omitting them', async () => {
    for (const [charset, description] of [['ISO_IR 192', rawText('SYNTHETIC café')], ['ISO_IR 100', latinText('SYNTHETIC café')]]) {
        const metadata = await indexLocalFile(new File([imageFixture({ '00080005': ['CS', charset],
            '00081030': ['LO', description], '0008103E': ['LO', description] })], 'SYNTHETIC_IMAGE'));
        assert.equal(metadata.studyDescription, 'SYNTHETIC café');
        assert.equal(metadata.seriesDescription, 'SYNTHETIC café');
        assert.deepEqual(metadata.warnings, []);
    }
});

test('unsupported declared metadata charsets and malformed identity bytes remain indexing failures', async () => {
    await assert.rejects(indexLocalFile(new File([imageFixture({ '00080005': ['CS', 'ISO 2022 IR 87'],
        '0008103E': ['LO', invalidDescription()] })], 'SYNTHETIC_IMAGE')),
    error => error.code === 'character-set' && /does not support/iu.test(error.message));
    for (const [tag, vr] of [['00100010', 'PN'], ['00100020', 'LO'], ['00100021', 'LO'], ['0020000D', 'UI']]) {
        await assert.rejects(indexLocalFile(new File([imageFixture({ [tag]: [vr, invalidDescription()] })], 'SYNTHETIC_IMAGE')),
        error => error.code === 'character-set' && /invalid text encoding/iu.test(error.message));
    }
});

test('metadata optional descriptions retain existing control handling and enforce size limits', async () => {
    const controls = await indexLocalFile(new File([imageFixture({ '00081030': ['LO', rawText('A\u0001B')],
        '0008103E': ['LO', rawText('C\u0001D')] })], 'SYNTHETIC_IMAGE'));
    assert.equal(controls.studyDescription, 'A B');
    assert.equal(controls.seriesDescription, 'C D');
    for (const tag of DESCRIPTION_TAGS) for (const length of [514, 2050]) {
        await assert.rejects(indexLocalFile(new File([imageFixture({ [tag]: ['LO', 'A'.repeat(length)] })], 'SYNTHETIC_IMAGE')),
        error => error.code === 'metadata-limit');
    }
});

test('catalog admission succeeds with omitted optional labels and reports no patient text in warnings or progress', async () => {
    const attributes = { '00081030': ['LO', invalidDescription()], '0008103E': ['LO', invalidDescription()] };
    const directoryBytes = createDicomdirFixture(records({ studyAttributes: { '00081030': attributes['00081030'] },
        seriesAttributes: { '0008103E': attributes['0008103E'] } }));
    const bytes = imageFixture(attributes), original = bytes.slice();
    const image = localFile(bytes, 'SYNTHETIC_DISC/IMAGES/IM000001');
    const media = await resolveLocalMedia([localFile(directoryBytes, 'SYNTHETIC_DISC/DICOMDIR'), image]);
    const catalog = new LocalCatalog(), progress = [];
    const result = await catalog.addFiles(media.files, { references: media.references, onProgress: event => progress.push(event) });
    assert.equal(result.added, 1);
    assert.equal(result.failed, 0);
    assert.deepEqual(result.failures, []);
    assert.equal(catalog.getState().patients, 1);
    assert.equal(catalog.getState().studies, 1);
    assert.equal(catalog.getState().series, 1);
    assert.equal(catalog.getState().instances, 1);
    const patient = catalog.getPatients()[0], study = patient.studies[0], series = study.series[0];
    assert.equal(patient.patientName, PATIENT_NAME);
    assert.equal(patient.patientId, PATIENT_ID);
    const warnings = [...media.report.warnings, ...patient.warnings, ...study.warnings, ...series.warnings];
    assertOmissionWarnings(warnings);
    assert.doesNotMatch(JSON.stringify(progress), privateText);
    assert.deepEqual(new Uint8Array(await image.arrayBuffer()), original);
    catalog.dispose();
});
