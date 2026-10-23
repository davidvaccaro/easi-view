import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionCatalog } from '../src/catalog/SessionCatalog.js';

const series = (id, changes = {}) => ({ id, seriesUid: `2.25.${id.length}`, description: `Series ${id}`, modality: 'CT', instanceCount: 20, frameCount: 20, ...changes });
const study = (id, changes = {}) => ({ id, studyUid: `2.25.${id.length}`, studyDate: '20261019', description: id, instanceCount: 20, frameCount: 20, series: [series(`${id}-series`)], ...changes });
const patient = (id, changes = {}) => ({ id, patientId: 'MRN-1', patientName: 'SYNTHETIC^ONE', issuerOfPatientId: 'TEST', patientBirthDate: '19800101', studies: [study('a'), study('b')], ...changes });

test('admission retains only selected studies, opaque IDs and metadata provenance without file objects', () => {
    const catalog = new SessionCatalog(), source = patient('patient-local'), privateFile = new File(['private'], 'private.dcm');
    source.studies[0].series[0].files = [privateFile]; source.studies[0].series[0].headers = { Authorization: 'private' };
    const admission = catalog.admitLocal({ patients: [source] }, { patientId: source.id, studyIds: ['a'] });
    const view = catalog.getView(), selected = view.patients[0];
    assert.equal(view.counts.studies, 1); assert.equal(selected.studies[0].description, 'a');
    assert.notEqual(selected.id, source.id); assert.notEqual(selected.studies[0].id, 'a');
    assert.equal(view.activePatientId, admission.patientId); assert.equal(admission.addedStudies, 1);
    const item = catalog.getSeries(admission.seriesIds[0]);
    assert.equal(item.patientId, selected.id); assert.equal(item.source.kind, 'local');
    assert.deepEqual(item.provenance, { kind: 'local', sourceId: 'local', patientId: 'patient-local', studyId: 'a', seriesId: 'a-series' });
    assert.equal(JSON.stringify(view).includes('private'), false); assert.equal(Object.isFrozen(item), true);
    assert.throws(() => { selected.studies.push({}); }, TypeError);
});

test('invalid local selection and malformed later descriptor cannot partially admit earlier studies', () => {
    const catalog = new SessionCatalog(), source = patient('p');
    assert.throws(() => catalog.admitLocal({ patients: [source] }, { patientId: 'p', studyIds: ['a', 'foreign'] }), /belonging/);
    assert.equal(catalog.getView().counts.patients, 0);
    source.studies[1].series[0].description = 'a'.repeat(4097);
    assert.throws(() => catalog.admitLocal({ patients: [source] }, { patientId: 'p', studyIds: ['a', 'b'] }), /text limit/);
    assert.equal(catalog.getView().counts.studies, 0);
});

test('repeated local admissions merge by exact source catalog records while keeping independent identities separate', () => {
    const catalog = new SessionCatalog(), view = { patients: [patient('a'), patient('b')] };
    const first = catalog.admitLocal(view, { patientId: 'a', studyIds: ['a'] });
    const second = catalog.admitLocal(view, { patientId: 'a', studyIds: ['a', 'b'] });
    assert.equal(first.patientId, second.patientId); assert.equal(second.addedStudies, 1); assert.equal(catalog.getView().counts.series, 2);
    catalog.admitLocal(view, { patientId: 'b', studyIds: ['a'] });
    catalog.admitLocal(view, { sourceId: 'another-device', patientId: 'a', studyIds: ['a'] });
    assert.equal(catalog.getView().counts.patients, 3);
    assert.equal(catalog.getView().activePatientId, first.patientId);
});

test('remote identities and UIDs deduplicate within source and issuer, never across repositories or issuers', () => {
    const catalog = new SessionCatalog(), source = patient('query-row'), studies = [study('a', { studyUid: '2.25.1', series: [series('s', { seriesUid: '2.25.2' })] })];
    const first = catalog.admitRemote('pacs-a', source, studies, { sourceLabel: 'Research PACS' });
    const repeated = catalog.admitRemote('pacs-a', { ...source, id: 'different-query-row' }, studies);
    assert.equal(first.patientId, repeated.patientId); assert.deepEqual(first.studyIds, repeated.studyIds); assert.equal(repeated.addedStudies, 0);
    catalog.admitRemote('pacs-b', source, studies);
    catalog.admitRemote('pacs-a', { ...source, issuerOfPatientId: 'OTHER' }, studies);
    assert.equal(catalog.getView().counts.patients, 3); assert.equal(catalog.getView().counts.studies, 3);
});

test('remote admission validates every owner, UID and demographic before mutating existing session', () => {
    const catalog = new SessionCatalog(), source = patient('p');
    const admission = catalog.admitRemote('pacs', source, [study('a', { studyUid: '2.25.1', series: [] })]);
    const before = catalog.getView();
    for (const changes of [{ patientId: 'FOREIGN' }, { issuerOfPatientId: 'FOREIGN' }, { patientName: 'DIFFERENT' }, { studyUid: 'invalid' }]) {
        assert.throws(() => catalog.admitRemote('pacs', source, [study('a', { studyUid: '2.25.2', series: [] }), study('b', { studyUid: '2.25.3', series: [], ...changes })]));
        assert.equal(catalog.getView(), before);
    }
    assert.throws(() => catalog.admitRemote('pacs', { ...source, patientBirthDate: '20000101' }, [study('b', { studyUid: '2.25.4', series: [] })]), /Conflicting patient/);
    assert.equal(catalog.getView(), before); assert.equal(catalog.getStudy(admission.studyIds[0]).series.length, 0);
});

test('restricted or conflicting remote candidates remain separate even when their advertised patient identifier matches', () => {
    const catalog = new SessionCatalog(), source = patient('candidate-a', { patientId: 'UNKNOWN*', identityStatus: 'study-scoped' });
    const a = catalog.admitRemote('pacs', source, [study('a', { studyUid: '2.25.1', series: [] })]);
    const b = catalog.admitRemote('pacs', { ...source, id: 'candidate-b' }, [study('b', { studyUid: '2.25.2', series: [] })]);
    assert.notEqual(a.patientId, b.patientId); assert.equal(catalog.getView().counts.patients, 2);
    const before = catalog.getView();
    assert.throws(() => catalog.admitRemote('pacs', source, [study('foreign', { studyUid: '2.25.3', sourceId: 'another-pacs', series: [] })]), /selected repository/);
    assert.equal(catalog.getView(), before);
});

test('lazy remote series update is atomic, source scoped and allows metadata-only empty studies', () => {
    const catalog = new SessionCatalog(), admission = catalog.admitRemote('pacs', patient('p'), [study('a', { studyUid: '2.25.1', series: undefined })]);
    const studyId = admission.studyIds[0]; assert.equal(catalog.getStudy(studyId).seriesLoaded, false);
    const loaded = catalog.setStudySeries(studyId, [series('s', { seriesUid: '2.25.2', studyUid: '2.25.1' })]);
    assert.equal(loaded.seriesLoaded, true); assert.equal(loaded.series[0].provenance.studyUid, '2.25.1');
    const before = catalog.getView();
    assert.throws(() => catalog.setStudySeries(studyId, [series('s2', { seriesUid: '2.25.3' }), series('wrong', { seriesUid: '2.25.4', studyUid: '2.25.9' })]), /belonging/);
    assert.equal(catalog.getView(), before);
    catalog.updateSeries(loaded.series[0].id, { status: 'loaded', frameCount: 25, headers: { Authorization: 'secret' } });
    assert.equal(catalog.getSeries(loaded.series[0].id).status, 'loaded'); assert.equal(catalog.getSeries(loaded.series[0].id).headers, undefined);
    assert.equal(catalog.setStudySeries(studyId, []).series.length, 1);
});

test('synthetic examples form a separate workspace, cannot join a real patient and preserve stable example references', () => {
    const catalog = new SessionCatalog(), local = catalog.admitLocal({ patients: [patient('p', { patientId: 'SYNTHETIC', issuerOfPatientId: 'EASI VIEW' })] }, { patientId: 'p', studyIds: ['a'] });
    const synthetic = catalog.admitTest({ id: 'us', label: 'US cine', modality: 'US', frameCount: 120, instanceCount: 1 });
    const again = catalog.admitTest('us'), ct = catalog.admitTest('ct');
    assert.notEqual(synthetic.patientId, local.patientId); assert.equal(again.patientId, synthetic.patientId); assert.equal(ct.patientId, synthetic.patientId);
    assert.equal(catalog.getPatient(synthetic.patientId).synthetic, true); assert.equal(catalog.getPatient(synthetic.patientId).studies.length, 2);
    assert.equal(catalog.getSeries(synthetic.seriesIds[0]).frameCount, 120); assert.equal(catalog.getStudy(synthetic.studyIds[0]).description, 'US cine');
    assert.equal(catalog.getSeries(synthetic.seriesIds[0]).provenance.demoId, 'us'); assert.equal(catalog.getView().activePatientId, local.patientId);
});

test('study dates sort newest first, selecting and removing patients changes only admission metadata', () => {
    const catalog = new SessionCatalog(), p = patient('p', { studies: [study('old', { studyDate: '20240101' }), study('undated', { studyDate: '' }), study('new', { studyDate: '20261019' })] });
    const local = catalog.admitLocal({ patients: [p] }, { patientId: 'p', studyIds: ['old', 'undated', 'new'] }), demo = catalog.admitTest('ct');
    assert.deepEqual(catalog.getPatient(local.patientId).studies.map(item => item.description), ['new', 'old', 'undated']);
    catalog.selectPatient(demo.patientId); assert.equal(catalog.getView().activePatientId, demo.patientId);
    assert.throws(() => catalog.selectPatient('unknown'), /viewing session/);
    assert.equal(catalog.removePatient(demo.patientId), true); assert.equal(catalog.getView().activePatientId, local.patientId);
    assert.equal(catalog.getView().counts.studies, 3); assert.equal(p.studies.length, 3);
    catalog.clear(); assert.equal(catalog.getView().counts.patients, 0); catalog.dispose(); catalog.dispose(); assert.throws(() => catalog.getView(), /disposed/);
});

test('loaded synthetic series update their study totals while unknown remote counts remain unknown', () => {
    const catalog = new SessionCatalog(), synthetic = catalog.admitTest('ct');
    assert.equal(catalog.getStudy(synthetic.studyIds[0]).frameCount, null);
    catalog.updateSeries(synthetic.seriesIds[0], { instanceCount: 16, frameCount: 16 });
    assert.equal(catalog.getStudy(synthetic.studyIds[0]).frameCount, 16); assert.equal(catalog.getStudy(synthetic.studyIds[0]).instanceCount, 16);
    assert.equal(catalog.getView().counts.frames, 16);
    const remote = catalog.admitRemote('pacs', patient('p'), [{ studyUid: '2.25.998', instanceCount: null, seriesCount: null }]);
    const remoteStudy = catalog.getStudy(remote.studyIds[0]); assert.equal(remoteStudy.instanceCount, null); assert.equal(remoteStudy.seriesCount, null);
    catalog.setStudySeries(remoteStudy.id, [{ seriesUid: '2.25.998.1' }, { seriesUid: '2.25.998.2' }]);
    const first = catalog.getStudy(remoteStudy.id).series[0]; catalog.updateSeries(first.id, { frameCount: 20, instanceCount: 20 });
    assert.equal(catalog.getStudy(remoteStudy.id).instanceCount, null); assert.equal(catalog.getStudy(remoteStudy.id).frameCount, null);
    assert.equal(catalog.getStudy(remoteStudy.id).seriesCount, 2);
});

test('local instance navigation exposes only bounded metadata with stable opaque instance identifiers', () => {
    const catalog = new SessionCatalog(), source = patient('local');
    source.studies[0].series[0].instances = [{ id: 'local-instance-1', sopUid: '2.25.991', sopClassUid: '1.2.840.10008.5.1.4.1.1.2',
        instanceNumber: 4, frameCount: 8, filename: 'private.dcm', file: new File(['private'], 'private.dcm'), headers: { Authorization: 'private' },
        stackIndex: 0, frameIndex: 0 }];
    const admission = catalog.admitLocal({ patients: [source] }, { patientId: 'local', studyIds: ['a'] });
    const series = catalog.getSeries(admission.seriesIds[0]);
    assert.equal(series.instancesLoaded, true);
    assert.equal(series.instances[0].id, 'local-instance-1'); assert.equal(series.instances[0].sopUid, '2.25.991');
    assert.equal(series.instances[0].instanceNumber, 4); assert.equal(series.instances[0].frameCount, 8);
    assert.equal(series.instances[0].stackIndex, 0); assert.equal(series.instances[0].frameIndex, 0);
    assert.doesNotMatch(JSON.stringify(series), /private/);
    assert.equal(Object.isFrozen(series.instances[0]), true);
    const repeated = catalog.admitLocal({ patients: [source] }, { patientId: 'local', studyIds: ['a'] });
    assert.deepEqual(catalog.getSeries(repeated.seriesIds[0]).instances, series.instances);
});

test('lazy remote instance enumeration validates source ownership and UIDs atomically and preserves IDs across relisting', () => {
    const catalog = new SessionCatalog(), admission = catalog.admitRemote('pacs', patient('p'), [study('a', {
        studyUid: '2.25.1', series: [series('s', { seriesUid: '2.25.2' })] })]);
    const id = admission.seriesIds[0]; assert.equal(catalog.getSeries(id).instancesLoaded, false);
    const descriptors = [{ sourceId: 'pacs', studyUid: '2.25.1', seriesUid: '2.25.2', sopUid: '2.25.3', instanceNumber: 2, frameCount: 50,
        filename: 'private', headers: { Authorization: 'private' } }, { sopInstanceUid: '2.25.4', instanceNumber: 3, frameCount: 1 }];
    const first = catalog.setSeriesInstances(id, descriptors), before = catalog.getView();
    assert.equal(first.instancesLoaded, true); assert.doesNotMatch(JSON.stringify(first), /private/);
    assert.notEqual(first.instances[0].id, first.instances[0].sopUid);
    for (const changes of [{ sourceId: 'other' }, { studyUid: '2.25.8' }, { seriesUid: '2.25.8' }, { sopUid: 'invalid' }, { sopClassUid: 'invalid' }]) {
        assert.throws(() => catalog.setSeriesInstances(id, [descriptors[1], { ...descriptors[0], ...changes }]));
        assert.equal(catalog.getView(), before);
    }
    assert.throws(() => catalog.setSeriesInstances(id, [descriptors[0], descriptors[0]]), /distinct/);
    assert.equal(catalog.getView(), before);
    const relisted = catalog.setSeriesInstances(id, [...descriptors].reverse());
    assert.equal(relisted.instances[1].id, first.instances[0].id);
    catalog.setStudySeries(admission.studyIds[0], [series('s', { seriesUid: '2.25.2' })]);
    assert.equal(catalog.getSeries(id).instancesLoaded, true);
    assert.deepEqual(catalog.getSeries(id).instances, relisted.instances);
    catalog.setSeriesInstances(id, []); assert.equal(catalog.getSeries(id).instancesLoaded, true); assert.equal(catalog.getSeries(id).instances.length, 0);
});

test('instance lists respect limits and metadata-only synthetic instance identities', () => {
    const catalog = new SessionCatalog(), admission = catalog.admitTest('us'), id = admission.seriesIds[0];
    const first = catalog.setSeriesInstances(id, [{ id: 'demo-instance-1', instanceNumber: 1, frameCount: 120 }]);
    assert.equal(first.instancesLoaded, true); assert.equal(first.instances[0].frameCount, 120);
    const before = catalog.getView();
    assert.throws(() => catalog.setSeriesInstances(id, Array(30001).fill({ id: 'x' })), /30,000/);
    assert.throws(() => catalog.setSeriesInstances(id, [{ id: 'x' }, { id: 'x' }]), /distinct/);
    assert.throws(() => catalog.setSeriesInstances(id, [{ id: 'x', status: 'x'.repeat(4097) }]), /text limit/);
    assert.equal(catalog.getView(), before);
});
