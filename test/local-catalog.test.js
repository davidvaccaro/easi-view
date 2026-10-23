import test from 'node:test';
import assert from 'node:assert/strict';
import LocalCatalog, { MAX_CATALOG_FILES } from '../src/catalog/LocalCatalog.js';
import { indexLocalFile, MAX_INDEX_BYTES } from '../src/catalog/metadata.js';
import { createDicomFixture } from '../src/data/synthetic.js';

let next = 100;
function file({ patientId = 'PATIENT-1', issuer = 'SYNTHETIC-HOSPITAL', name = 'SYNTHETIC^ONE', birthDate = '19800101',
    studyUid = '1.2.3.100', seriesUid = '1.2.3.100.1', date = '20261016', frames = 1,
    sopUid = `1.2.3.${next++}`, filename = 'IM000001', extra = {}, ...options } = {}) {
    return new File([createDicomFixture({ sopUid, seriesUid, frames, values: Array(4 * frames).fill(10), ...options,
        extraAttributes: { '00100010': ['PN', name], '00100020': patientId ? ['LO', patientId] : null,
            '00100021': issuer ? ['LO', issuer] : null, '00100030': ['DA', birthDate],
            '00080020': ['DA', date], '00081030': ['LO', 'Synthetic chest study'], '0020000D': studyUid ? ['UI', studyUid] : null,
            '00200011': ['IS', '1'], ...extra } })], filename, { type: 'application/dicom' });
}

test('catalog indexes native file metadata through EASI without extension assumptions', async () => {
    for (const filename of ['IM000001', 'scan.ima', 'scan.dcm', 'image.jpeg']) {
        const metadata = await indexLocalFile(file({ filename }));
        assert.equal(metadata.patientName, 'SYNTHETIC^ONE');
        assert.equal(metadata.patientId, 'PATIENT-1');
        assert.equal(metadata.issuerOfPatientId, 'SYNTHETIC-HOSPITAL');
        assert.equal(metadata.patientBirthDate, '19800101');
        assert.equal(metadata.indexStatus, 'metadata-only');
        assert.equal(metadata.availability, 'unverified');
    }
});

test('two study dates remain in one issuer-qualified patient timeline across additive imports', async () => {
    const catalog = new LocalCatalog();
    const first = file({ studyUid: '1.2.3.1', seriesUid: '1.2.3.1.1', date: '20260101' });
    const second = file({ studyUid: '1.2.3.2', seriesUid: '1.2.3.2.1', date: '20261016', frames: 3 });
    const imported = await catalog.addFiles([first]);
    const patientId = imported.patientIds[0];
    await catalog.addFiles([second]);
    const patient = catalog.getPatient(patientId);
    assert.equal(catalog.getState().patients, 1);
    assert.deepEqual(patient.studies.map(study => study.studyDate), ['20261016', '20260101']);
    assert.equal(patient.studies[0].frameCount, 3);
    assert.equal(patient.studies[0].instanceCount, 1);
    assert.equal(patient.identityStatus, 'issuer-qualified');
    assert.deepEqual(catalog.getSeriesFiles(patient.studies[1].series[0].id), [first]);
    assert.equal(catalog.getSeries(patient.studies[0].series[0].id).patientIdOpaque, patientId);
    assert.equal(catalog.getSeries(patient.studies[0].series[0].id).studyId, patient.studies[0].id);
});

test('same verified series gains new instances across imports and keeps opaque IDs stable', async () => {
    const catalog = new LocalCatalog();
    await catalog.addFiles([file()]);
    const before = catalog.getPatients()[0], seriesId = before.studies[0].series[0].id;
    await catalog.addFiles([file({ frames: 2 })]);
    assert.equal(catalog.getPatients()[0].id, before.id);
    assert.equal(catalog.getSeries(seriesId).instanceCount, 2);
    assert.equal(catalog.getSeries(seriesId).frameCount, 3);
    assert.equal(catalog.getSeriesFiles(seriesId).length, 2);
});

test('matching names never merge different issuer or patient identifiers', async () => {
    const catalog = new LocalCatalog();
    await catalog.addFiles([file(), file({ issuer: 'OTHER-HOSPITAL' }), file({ patientId: 'PATIENT-2' })]);
    assert.equal(catalog.getState().patients, 3);
    assert.equal(catalog.getState().studies, 3);
    assert.equal(catalog.getState().series, 3);
    for (const patient of catalog.getPatients()) assert.match(patient.studies[0].warnings.join(' '), /Study UID is reused/);
});

test('conflicting name or birth date leaves same issuer-qualified patient identifier separate', async () => {
    const catalog = new LocalCatalog();
    await catalog.addFiles([file(), file({ name: 'SYNTHETIC^OTHER' }), file({ birthDate: '19900101' })]);
    assert.equal(catalog.getState().patients, 3);
    for (const patient of catalog.getPatients()) assert.match(patient.warnings.join(' '), /demographics conflict/);
});

test('missing demographics do not bridge two conflicting known patient records', async () => {
    const catalog = new LocalCatalog();
    await catalog.addFiles([file({ birthDate: '', name: 'SYNTHETIC^ONE' }), file({ birthDate: '', name: 'SYNTHETIC^TWO' }),
        file({ birthDate: '', name: '' })]);
    assert.equal(catalog.getState().patients, 3);
});

test('unqualified patient IDs group within a batch and remain separate across imports', async () => {
    const catalog = new LocalCatalog();
    await catalog.addFiles([file({ issuer: '' }), file({ issuer: '', studyUid: '1.2.3.200' })]);
    assert.equal(catalog.getState().patients, 1);
    assert.equal(catalog.getPatients()[0].identityStatus, 'batch-scoped');
    await catalog.addFiles([file({ issuer: '' })]);
    assert.equal(catalog.getState().patients, 2);
});

test('missing patient ID is scoped to study within an import rather than matched by name', async () => {
    const catalog = new LocalCatalog();
    await catalog.addFiles([file({ patientId: '' }), file({ patientId: '' }), file({ patientId: '', studyUid: '1.2.3.200' })]);
    assert.equal(catalog.getState().patients, 2);
    assert.equal(catalog.getPatients()[0].identityStatus, 'study-scoped');
    await catalog.addFiles([file({ patientId: '' })]);
    assert.equal(catalog.getState().patients, 3);
});

test('explicit patient association preserves metadata and original study boundaries', async () => {
    const catalog = new LocalCatalog();
    const firstFile = file({ issuer: '' }), secondFile = file({ issuer: '', name: 'SYNTHETIC^OUTSIDE' });
    await catalog.addFiles([firstFile]); await catalog.addFiles([secondFile]);
    const [target, source] = catalog.getPatients();
    assert.throws(() => catalog.confirmAssociation(source.id, target.id), /Confirm/);
    const combined = catalog.confirmAssociation(source.id, target.id, { confirmed: true });
    assert.equal(catalog.getState().patients, 1);
    assert.equal(combined.identityStatus, 'confirmed-association');
    assert.equal(combined.studies.length, 2);
    assert.equal(combined.originalIdentities.length, 2);
    assert.deepEqual(combined.originalIdentities.map(value => value.patientName), ['SYNTHETIC^ONE', 'SYNTHETIC^OUTSIDE']);
    assert.equal((await indexLocalFile(secondFile)).patientName, 'SYNTHETIC^OUTSIDE');
    assert.match(combined.warnings.join(' '), /DICOM metadata is unchanged/);
});

test('exact same File object reimport deduplicates; UID duplicates are not claimed to be byte copies', async () => {
    const catalog = new LocalCatalog(), input = file({ sopUid: '1.2.3.777' });
    const a = await catalog.addFiles([input, input]);
    assert.equal(a.added, 1); assert.equal(a.duplicates, 1);
    const originalSeriesId = catalog.getPatients()[0].studies[0].series[0].id;
    const b = await catalog.addFiles([input]);
    assert.equal(b.added, 0); assert.equal(b.duplicates, 1);
    const copy = new File([await input.arrayBuffer()], 'COPY');
    await catalog.addFiles([copy, file({ sopUid: '1.2.3.777', values: [11, 12, 13, 14] })]);
    assert.equal(catalog.getState().instances, 3);
    const variants = catalog.getPatients()[0].studies[0].series;
    assert.equal(variants.length, 3);
    for (const variant of variants) {
        assert.equal(variant.status, 'uid-conflict');
        assert.equal(catalog.getSeriesFiles(variant.id).length, 1);
    }
    await catalog.addFiles([file()]);
    assert.equal(catalog.getSeriesFiles(originalSeriesId).length, 2);
    for (const variant of variants.filter(value => value.id !== originalSeriesId)) assert.equal(catalog.getSeriesFiles(variant.id).length, 1);
});

test('selection reports contain only studies touched by this import, including exact File duplicates', async () => {
    const catalog = new LocalCatalog(), a = file(), b = file({ studyUid: '1.2.3.200', seriesUid: '1.2.3.200.1' });
    const first = await catalog.addFiles([a]), second = await catalog.addFiles([b]), repeated = await catalog.addFiles([a, a]);
    assert.equal(catalog.getState().studies, 2);
    assert.deepEqual(repeated.patientIds, first.patientIds);
    assert.deepEqual(repeated.selection, first.selection);
    assert.notDeepEqual(repeated.selection[0].studyIds, second.selection[0].studyIds);
    assert.equal(repeated.added, 0); assert.equal(repeated.duplicates, 2);
});

test('closing a patient forgets its files and metadata budget while retaining other patient record identities', async () => {
    const catalog = new LocalCatalog(), a = file({ issuer: '' }), b = file({ patientId: 'PATIENT-2', studyUid: '1.2.3.999', seriesUid: '1.2.3.999.1' });
    const first = await catalog.addFiles([a]), retained = await catalog.addFiles([b]);
    const other = catalog.getPatient(retained.patientIds[0]), before = catalog.getState().metadataBytes;
    assert.equal(catalog.removePatient(first.patientIds[0]), true);
    assert.equal(catalog.getPatient(first.patientIds[0]), null);
    assert.deepEqual(catalog.getPatient(other.id), other);
    assert.equal(catalog.getState().instances, 1); assert.equal(catalog.getState().batches, 1);
    assert.ok(catalog.getState().metadataBytes < before);
    const fresh = new File([await a.arrayBuffer()], a.name), reopened = await catalog.addFiles([fresh]);
    assert.equal(reopened.added, 1); assert.equal(reopened.duplicates, 0);
    assert.equal(catalog.getState().patients, 2);
    assert.notEqual(reopened.patientIds[0], first.patientIds[0]);
    assert.deepEqual(catalog.getPatient(other.id), other);
    assert.equal(catalog.removePatient('unknown'), false);
});

test('closing an explicitly associated patient removes every owned original group without dangling associations', async () => {
    const catalog = new LocalCatalog(), a = file({ issuer: '' }), b = file({ issuer: '' }), c = file({ patientId: 'PATIENT-2' });
    const first = await catalog.addFiles([a]), second = await catalog.addFiles([b]), third = await catalog.addFiles([c]);
    catalog.confirmAssociation(second.patientIds[0], first.patientIds[0], { confirmed: true });
    catalog.removePatient(first.patientIds[0]);
    assert.equal(catalog.getState().patients, 1); assert.equal(catalog.getState().instances, 1);
    assert.equal(catalog.getPatients()[0].id, third.patientIds[0]);
    const reopen = await catalog.addFiles([a, b]);
    assert.equal(reopen.added, 2); assert.equal(reopen.duplicates, 0);
    assert.equal(catalog.getPatient(reopen.patientIds[0]).identityStatus, 'batch-scoped');
});

test('missing and invalid UIDs remain cataloged with isolated local groups and warnings', async () => {
    const catalog = new LocalCatalog();
    await catalog.addFiles([file({ studyUid: '', seriesUid: '', sopUid: 'legacy-invalid' }),
        file({ studyUid: '', seriesUid: '', sopUid: '' })]);
    assert.equal(catalog.getState().instances, 2);
    assert.equal(catalog.getState().studies, 2);
    assert.equal(catalog.getState().series, 2);
    assert.match(catalog.getPatients()[0].studies[0].series[0].warnings.join(' '), /unverified/);
});

test('valid document metadata stays discoverable without implying image renderability', async () => {
    const catalog = new LocalCatalog();
    await catalog.addFiles([file({ sopClass: '1.2.840.10008.5.1.4.1.1.88.11', modality: 'SR', extra: { '7FE00010': null } })]);
    const entry = catalog.getPatients()[0].studies[0].series[0];
    assert.equal(entry.modality, 'SR');
    assert.equal(entry.availability, 'unverified');
    assert.equal(entry.instances[0].sopClassUid, '1.2.840.10008.5.1.4.1.1.88.11');
});

test('malformed files produce bounded per-file failures while valid entries commit', async () => {
    const catalog = new LocalCatalog(), events = [];
    const result = await catalog.addFiles([new File([new Uint8Array(3)], 'BAD'), file(), null], { onProgress: value => events.push(value) });
    assert.equal(result.added, 1); assert.equal(result.failed, 2);
    assert.deepEqual(result.failures.map(value => value.index), [0, 2]);
    assert.equal(result.failures[0].code, 'index-error');
    assert.equal(result.failures[1].code, 'invalid-input');
    assert.doesNotMatch(JSON.stringify(events), /SYNTHETIC|PATIENT|BAD|IM000001|1\.2\.3/u);
    assert.equal(events.at(-1).completed, 3);
});

test('abort during batch or completion callback rolls the whole batch back', async () => {
    for (const abortAtComplete of [false, true]) {
        const catalog = new LocalCatalog();
        await catalog.addFiles([file()]);
        const before = catalog.getView(), signal = new AbortController();
        await assert.rejects(catalog.addFiles([file(), file()], { signal: signal.signal, onProgress: progress => {
            if (abortAtComplete ? progress.phase === 'complete' : progress.completed === 1) signal.abort();
        } }), { name: 'AbortError' });
        assert.equal(catalog.getView(), before);
        assert.equal(catalog.getState().instances, 1);
    }
});

test('clearing or disposing during indexing cannot resurrect an import', async () => {
    for (const dispose of [false, true]) {
        const catalog = new LocalCatalog();
        await assert.rejects(catalog.addFiles([file()], { onProgress: progress => {
            if (progress.completed === 1) { if (dispose) catalog.dispose(); else catalog.clear(); }
        } }), { name: 'AbortError' });
        assert.equal(catalog.getState().instances, 0);
        if (dispose) assert.throws(() => catalog.getView(), /disposed/);
    }
});

test('catalog caps are bounded and an overflowing batch leaves prior entries intact', async () => {
    assert.throws(() => new LocalCatalog({ maxFiles: MAX_CATALOG_FILES + 1 }), /bounded/);
    const catalog = new LocalCatalog({ maxFiles: 2 });
    await catalog.addFiles([file()]);
    const before = catalog.getView();
    await assert.rejects(catalog.addFiles([file(), file()]), /file-count limit/);
    assert.equal(catalog.getView(), before);
    const small = new LocalCatalog({ maxMetadataBytes: 1 });
    await assert.rejects(small.addFiles([file()]), /metadata memory limit/);
    assert.equal(small.getState().instances, 0);
});

test('index stops before large pixels and cancels stream rather than materializing or decoding', async () => {
    const header = createDicomFixture({ rows: 4096, columns: 4096, rawPixelBytes: new Uint8Array(32 * 1024 * 1024) });
    let offset = 0, bytesRead = 0, canceled = 0;
    const input = { size: header.length, type: 'application/dicom',
        arrayBuffer() { throw new Error('Whole-file materialization is forbidden.'); },
        stream() { return new ReadableStream({ pull(controller) {
            if (offset >= header.length) { controller.close(); return; }
            const chunk = header.subarray(offset, offset + 1024); offset += chunk.length; bytesRead += chunk.length; controller.enqueue(chunk);
        }, cancel() { canceled++; } }, { highWaterMark: 0 }); } };
    const metadata = await indexLocalFile(input);
    assert.equal(metadata.patientName, 'SYNTHETIC^DEMO');
    assert.ok(bytesRead < 4096, `read ${bytesRead} bytes`);
    assert.ok(canceled > 0);
});

test('navigation attribute limits reject excessive retained text', async () => {
    const catalog = new LocalCatalog();
    const result = await catalog.addFiles([file({ name: 'A'.repeat(2200) }), file({ name: 'B'.repeat(513) })]);
    assert.equal(result.failed, 2);
    assert.deepEqual(result.failures.map(failure => failure.code), ['metadata-limit', 'metadata-limit']);
    assert.equal(catalog.getState().instances, 0);
});

test('unknown or invalid dates remain selectable and do not acquire invented dates', async () => {
    const catalog = new LocalCatalog();
    await catalog.addFiles([file({ date: '', birthDate: '' }), file({ date: '20260230', birthDate: '19801301', studyUid: '1.2.3.3' })]);
    const patient = catalog.getPatients()[0];
    assert.equal(patient.patientBirthDate, '');
    assert.deepEqual(patient.studies.map(study => study.studyDate), ['', '']);
});

test('catalog snapshots expose only navigation fields; general state contains counts only', async () => {
    const catalog = new LocalCatalog();
    await catalog.addFiles([file()]);
    assert.deepEqual(Object.keys(catalog.getState()).sort(), ['batches', 'frames', 'instances', 'metadataBytes', 'patients', 'series', 'studies']);
    assert.doesNotMatch(JSON.stringify(catalog.getState()), /SYNTHETIC|PATIENT|1\.2\.3/u);
    const view = catalog.getView();
    assert.ok(Object.isFrozen(view.patients[0].studies[0].series[0].instances));
    assert.doesNotMatch(JSON.stringify(view), /PixelData|arrayBuffer|"records"|"file"|"sopUids"/u);
    assert.equal(catalog.getPatients({ query: 'chest' }).length, 1);
    assert.equal(catalog.getPatients({ query: 'not present' }).length, 0);
});

test('indexing has a bounded byte scan for files with excessive pre-navigation data', async () => {
    const input = file({ extra: { '00091010': ['OB', new Uint8Array(MAX_INDEX_BYTES + 1024)] } });
    const catalog = new LocalCatalog();
    const result = await catalog.addFiles([input]);
    assert.equal(result.failed, 1);
    assert.equal(result.failures[0].code, 'scan-limit');
});

for (const transferSyntax of ['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']) {
    test(`index understands the core native transfer syntax ${transferSyntax}`, async () => {
        const metadata = await indexLocalFile(file({ transferSyntax, frames: 2 }));
        assert.equal(metadata.patientName, 'SYNTHETIC^ONE');
        assert.equal(metadata.studyUid, '1.2.3.100');
        assert.equal(metadata.frameCount, 2);
    });
}

test('abort interrupts a pending file stream and releases its reader', async () => {
    const controller = new AbortController();
    let canceled = 0, started;
    const waiting = new Promise(resolve => { started = resolve; });
    const stream = new ReadableStream({ pull() { started(); return new Promise(() => {}); }, cancel() { canceled++; } }, { highWaterMark: 0 });
    const catalog = new LocalCatalog();
    const pending = catalog.addFiles([{ size: 1024, stream: () => stream }], { signal: controller.signal });
    await waiting; controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(canceled, 1); assert.equal(stream.locked, false);
    assert.equal(catalog.getState().instances, 0);
});

test('a second import is refused while the first import is pending', async () => {
    const controller = new AbortController();
    let started;
    const waiting = new Promise(resolve => { started = resolve; });
    const stream = new ReadableStream({ pull() { started(); return new Promise(() => {}); } }, { highWaterMark: 0 });
    const catalog = new LocalCatalog();
    const pending = catalog.addFiles([{ size: 1024, stream: () => stream }], { signal: controller.signal });
    await waiting;
    await assert.rejects(catalog.addFiles([file()]), /Another local import/);
    controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
    assert.equal((await catalog.addFiles([file()])).added, 1);
});

test('callbacks cannot partially commit an import by throwing at completion', async () => {
    const catalog = new LocalCatalog();
    const input = file();
    await assert.rejects(catalog.addFiles([input], { onProgress(progress) {
        if (progress.phase === 'complete') throw new Error('host callback stopped');
    } }), /host callback/);
    assert.equal(catalog.getState().instances, 0);
    assert.equal((await catalog.addFiles([input])).added, 1);
});

test('an association persists across later imports without rewriting patient identifiers', async () => {
    const catalog = new LocalCatalog();
    await catalog.addFiles([file({ issuer: 'A' }), file({ issuer: 'B', patientId: 'OUTSIDE-1' })]);
    const [a, b] = catalog.getPatients();
    catalog.confirmAssociation(b.id, a.id, { confirmed: true });
    const result = await catalog.addFiles([file({ issuer: 'B', patientId: 'OUTSIDE-1', studyUid: '1.2.3.299' })]);
    assert.equal(catalog.getState().patients, 1);
    assert.deepEqual(result.patientIds, [a.id]);
    assert.equal(catalog.getPatient(a.id).patientId, 'PATIENT-1');
    assert.equal(catalog.getPatient(a.id).originalIdentities[1].patientId, 'OUTSIDE-1');
});

test('raw bulk/profile errors remain deferred until opening rather than presented as success', async () => {
    const metadata = await indexLocalFile(file({ extra: { '7FE00010': ['OW', new Uint8Array(0)] } }));
    assert.equal(metadata.indexStatus, 'metadata-only');
    assert.equal(metadata.availability, 'unverified');
});

test('text charset ISO_IR 100 is read explicitly and unsupported encodings stay isolated as failures', async () => {
    const latin = new TextEncoder().encode('SYNTHETIC^Andre');
    latin[latin.length - 1] = 0xe9;
    const metadata = await indexLocalFile(file({ extra: { '00080005': ['CS', 'ISO_IR 100'], '00100010': ['PN', latin] } }));
    assert.equal(metadata.patientName, 'SYNTHETIC^André');
    const catalog = new LocalCatalog();
    const result = await catalog.addFiles([file({ extra: { '00080005': ['CS', 'ISO 2022 IR 87'] } })]);
    assert.equal(result.failed, 1); assert.equal(result.failures[0].code, 'character-set');
});

test('a reused Study UID with conflicting dates remains separately selectable in the timeline', async () => {
    const catalog = new LocalCatalog();
    await catalog.addFiles([file({ date: '20260101' }), file({ date: '20261016' }), file({ date: '20261016' })]);
    const studies = catalog.getPatients()[0].studies;
    assert.deepEqual(studies.map(study => study.studyDate), ['20261016', '20260101']);
    assert.deepEqual(studies.map(study => study.instanceCount), [2, 1]);
    for (const study of studies) assert.match(study.warnings.join(' '), /conflicting examination dates/);
});

test('reused Series UIDs with distinct modalities stay in separate local series', async () => {
    const catalog = new LocalCatalog();
    await catalog.addFiles([file(), file({ modality: 'MR', sopClass: '1.2.840.10008.5.1.4.1.1.4' })]);
    const studies = catalog.getPatients()[0].studies;
    assert.equal(studies[0].series.length, 2);
    assert.deepEqual(studies[0].modalities, ['CT', 'MR']);
    for (const series of studies[0].series) {
        assert.equal(catalog.getSeriesFiles(series.id).length, 1);
        assert.match(series.warnings.join(' '), /conflicting modalities/);
    }
});

test('clear and dispose interrupt a blocked stream even without a host abort signal', async () => {
    for (const dispose of [false, true]) {
        let started, canceled = 0;
        const waiting = new Promise(resolve => { started = resolve; });
        const stream = new ReadableStream({ pull() { started(); return new Promise(() => {}); }, cancel() { canceled++; } }, { highWaterMark: 0 });
        const catalog = new LocalCatalog();
        const pending = catalog.addFiles([{ size: 1024, stream: () => stream }]);
        await waiting;
        if (dispose) catalog.dispose(); else catalog.clear();
        await assert.rejects(pending, { name: 'AbortError' });
        assert.equal(canceled, 1);
        assert.equal(stream.locked, false);
        assert.equal(catalog.getState().instances, 0);
    }
});
