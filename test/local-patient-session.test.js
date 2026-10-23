import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalPatientSession, LocalAnnotationSessions } from '../src/integration/LocalPatientSession.js';
import { AnnotationStore } from '../src/annotations/AnnotationStore.js';
import { MAX_LOCAL_WORKING_STACKS } from '../src/integration/LocalWorkingSet.js';

function view() {
    return { patients: [
        { id: 'patient-a', patientName: 'SYNTHETIC^ONE', patientId: 'SYNTHETIC-ID', studies: [
            { id: 'study-new', studyDate: '20261016', series: [{ id: 'series-new-lung' }, { id: 'series-new-soft' }] },
            { id: 'study-old', studyDate: '20260101', series: [{ id: 'series-old-lung' }, { id: 'series-old-soft' }] },
            { id: 'study-same-day', studyDate: '20261016', series: [{ id: 'series-same-day' }] }
        ] },
        { id: 'patient-b', patientName: 'SYNTHETIC^TWO', studies: [
            { id: 'study-foreign', studyDate: '20261016', series: [{ id: 'series-foreign' }] }
        ] }
    ] };
}
function session() { const value = new LocalPatientSession(); value.update(view()); return value; }
function measurement(id, sopUid = '1.2.3.1') {
    return { id, tool: 'length', image: { sopUid, frameNumber: 1, rows: 100, columns: 100 },
        points: [{ x: 10, y: 15 }, { x: 25, y: 35 }] };
}

test('planning an examination leaves the active viewing session unchanged until commit', () => {
    const value = session();
    value.commit(value.planSeries('series-new-lung'));
    const before = value.getState(), plan = value.planStudy('study-old', { seriesId: 'series-old-soft' });
    assert.deepEqual(value.getState(), before);
    assert.equal(plan.selections[0].seriesId, 'series-old-soft');
    value.commit(plan);
    assert.equal(value.getState().currentStudyId, 'study-old');
    assert.equal(value.getState().comparisonStudyId, null);
});

test('choosing a patient clears examination roles without selecting arbitrary images', () => {
    const value = session();
    value.commit(value.planComparison('study-new', 'study-old'));
    const plan = value.planPatient('patient-b');
    assert.deepEqual(plan.selections, []);
    value.commit(plan);
    assert.deepEqual(value.getState(), { activePatientId: 'patient-b', currentStudyId: null, comparisonStudyId: null });
});

test('comparison roles follow explicit selection rather than date sorting', () => {
    const value = session(), plan = value.planComparison('study-old', 'study-new');
    assert.equal(plan.currentStudyId, 'study-old');
    assert.equal(plan.comparisonStudyId, 'study-new');
    assert.deepEqual(plan.selections.map(selection => selection.role), ['current', 'comparison']);
    assert.deepEqual(plan.selections.map(selection => selection.studyId), ['study-old', 'study-new']);
});

test('separate studies on the same calendar date can be compared', () => {
    const value = session();
    const plan = value.planComparison('study-new', 'study-same-day');
    value.commit(plan);
    assert.equal(value.getState().comparisonStudyId, 'study-same-day');
});

test('comparison can select specific series and independent stack variants', () => {
    const plan = session().planComparison('study-new', 'study-old', { currentSeriesId: 'series-new-soft',
        comparisonSeriesId: 'series-old-soft', currentStackIndex: 2, comparisonStackIndex: 3 });
    assert.deepEqual(plan.selections.map(selection => [selection.seriesId, selection.stackIndex]),
        [['series-new-soft', 2], ['series-old-soft', 3]]);
});

test('foreign patient comparisons and duplicate examination selection are refused', () => {
    const value = session();
    assert.throws(() => value.planComparison('study-new', 'study-foreign'), /same local patient/);
    assert.throws(() => value.planComparison('study-new', 'study-new'), /distinct studies/);
    assert.deepEqual(value.getState(), { activePatientId: null, currentStudyId: null, comparisonStudyId: null });
});

test('series identifiers must belong to the chosen study on either side', () => {
    const value = session();
    assert.throws(() => value.planStudy('study-new', { seriesId: 'series-old-lung' }), /belonging/);
    assert.throws(() => value.planComparison('study-new', 'study-old', { currentSeriesId: 'series-old-lung' }), /belonging/);
    assert.throws(() => value.planComparison('study-new', 'study-old', { comparisonSeriesId: 'series-foreign' }), /belonging/);
});

test('unknown patient, study and series references never create implicit records', () => {
    const value = session();
    assert.throws(() => value.planPatient('unknown'), /indexed local patient/);
    assert.throws(() => value.planStudy('unknown'), /indexed local study/);
    assert.throws(() => value.planSeries('unknown'), /indexed local series/);
    assert.throws(() => value.planComparison('study-new', 'unknown'), /indexed local study/);
});

test('selection options reject unrecognized behavior and invalid stack indices', () => {
    const value = session();
    for (const stackIndex of [-1, 0.5, MAX_LOCAL_WORKING_STACKS, NaN, Infinity, '1', null]) {
        assert.throws(() => value.planSeries('series-new-lung', { stackIndex }), /stack/);
    }
    for (const options of [null, [], new Date(), { upload: true }, Object.create({ stackIndex: 0 })]) {
        assert.throws(() => value.planSeries('series-new-lung', options), /options/);
    }
    assert.throws(() => value.planStudy('study-new', { comparisonSeriesId: 'series-old-lung' }), /options/);
    assert.throws(() => value.planComparison('study-new', 'study-old', { autoRegister: true }), /options/);
});

test('local series and comparison plans accept high logical stack indices through1023 without changing study ownership', () => {
    const value = session();
    for (const stackIndex of [128, 418, 1000, MAX_LOCAL_WORKING_STACKS - 1]) {
        const plan = value.planSeries('series-new-lung', { stackIndex });
        assert.equal(plan.selections[0].stackIndex, stackIndex); value.commit(plan);
        assert.equal(value.getState().activePatientId, 'patient-a'); assert.equal(value.getState().currentStudyId, 'study-new');
    }
    const comparison = value.planComparison('study-new', 'study-old', { currentStackIndex: 418, comparisonStackIndex: 282 });
    value.commit(comparison); assert.deepEqual(comparison.selections.map(selection => selection.stackIndex), [418, 282]);
    const before = value.getState(); comparison.selections[1].stackIndex = MAX_LOCAL_WORKING_STACKS;
    assert.throws(() => value.commit(comparison), /stack/); assert.deepEqual(value.getState(), before);
});

test('session state holds opaque selection references and excludes identifying metadata', () => {
    const value = session(); value.commit(value.planComparison('study-new', 'study-old'));
    assert.doesNotMatch(JSON.stringify(value.getState()), /SYNTHETIC|patientName|issuer|birthDate/iu);
    value.clear();
    assert.equal(value.getState().activePatientId, null);
});

test('additive catalog updates preserve selection and removal of the active patient clears it', () => {
    const value = session(); value.commit(value.planComparison('study-new', 'study-old'));
    const before = value.getState(), expanded = view();
    expanded.patients[0].studies.push({ id: 'another-study', series: [{ id: 'another-series' }] });
    value.update(expanded);
    assert.deepEqual(value.getState(), before);
    value.update({ patients: [expanded.patients[1]] });
    assert.equal(value.getState().activePatientId, null);
    assert.equal(value.getState().currentStudyId, null);
    assert.equal(value.getState().comparisonStudyId, null);
});

test('stale plans cannot commit after their selected patient has disappeared', () => {
    const value = session(), plan = value.planSeries('series-new-lung');
    value.update({ patients: [] });
    assert.throws(() => value.commit(plan), /patient|available/);
    assert.equal(value.getState().activePatientId, null);
});

test('removing a selected study clears dangling comparison roles even when its patient remains', () => {
    const value = session(); value.commit(value.planComparison('study-new', 'study-old'));
    const changed = view(); changed.patients[0].studies = changed.patients[0].studies.filter(study => study.id !== 'study-old');
    value.update(changed);
    assert.equal(value.getState().activePatientId, 'patient-a');
    assert.equal(value.getState().currentStudyId, 'study-new');
    assert.equal(value.getState().comparisonStudyId, null);
    changed.patients[0].studies = [];
    value.update(changed);
    assert.equal(value.getState().activePatientId, 'patient-a');
    assert.equal(value.getState().currentStudyId, null);
});

test('a selected series disappearing invalidates a prepared plan before role commit', () => {
    const value = session(), plan = value.planSeries('series-new-lung');
    const changed = view(); changed.patients[0].studies[0].series = [{ id: 'replacement-series' }];
    value.update(changed);
    assert.throws(() => value.commit(plan), /indexed local series/);
    assert.equal(value.getState().activePatientId, null);
});

test('commit rejects a forged cross-patient study reference without mutating active roles', () => {
    const value = session(); value.commit(value.planSeries('series-new-lung'));
    const before = value.getState(), plan = value.planComparison('study-new', 'study-old');
    plan.comparisonStudyId = 'study-foreign';
    assert.throws(() => value.commit(plan), /patient|study|selection|belong|plan/);
    assert.deepEqual(value.getState(), before);
});

test('commit rejects a forged foreign series reference even when study roles look valid', () => {
    const value = session(), plan = value.planComparison('study-new', 'study-old');
    plan.selections[1].seriesId = 'series-foreign';
    assert.throws(() => value.commit(plan), /patient|study|series|selection|belong|plan/);
    assert.equal(value.getState().activePatientId, null);
});

test('patient annotation switching restores only that patient’s measurement document', () => {
    const store = new AnnotationStore(), sessions = new LocalAnnotationSessions();
    sessions.prepare('patient-a', store)();
    store.add(measurement('a-distance'));
    sessions.prepare('patient-b', store)();
    assert.equal(store.list().length, 0);
    store.add(measurement('b-distance', '1.2.3.2'));
    sessions.prepare('patient-a', store)();
    assert.deepEqual(store.list().map(annotation => annotation.id), ['a-distance']);
    sessions.prepare('patient-b', store)();
    assert.deepEqual(store.list().map(annotation => annotation.id), ['b-distance']);
    store.dispose();
});

test('undo and redo history cannot bring another patient’s measurements into the active store', () => {
    const store = new AnnotationStore(), sessions = new LocalAnnotationSessions();
    sessions.prepare('patient-a', store)(); store.add(measurement('a-distance'));
    assert.equal(store.canUndo, true);
    sessions.prepare('patient-b', store)();
    assert.equal(store.canUndo, false); assert.equal(store.canRedo, false);
    assert.equal(store.undo(), false);
    store.add(measurement('b-distance', '1.2.3.2')); store.undo();
    assert.equal(store.list().length, 0); assert.equal(store.canRedo, true);
    sessions.prepare('patient-a', store)();
    assert.equal(store.canUndo, false); assert.equal(store.canRedo, false);
    assert.deepEqual(store.list().map(annotation => annotation.id), ['a-distance']);
    assert.equal(store.redo(), false);
    store.dispose();
});

test('changing studies within the same patient preserves measurements and their undo history', () => {
    const store = new AnnotationStore(), sessions = new LocalAnnotationSessions();
    sessions.prepare('patient-a', store)(); store.add(measurement('a-distance'));
    const before = store.export(), history = store.getState();
    sessions.prepare('patient-a', store)();
    assert.deepEqual(store.export(), before);
    assert.equal(store.getState().historyCount, history.historyCount);
    assert.equal(store.getState().historyBytes, history.historyBytes);
    store.undo(); assert.equal(store.list().length, 0);
    store.dispose();
});

test('preparing an uncommitted patient switch leaves annotations and undo untouched', () => {
    const store = new AnnotationStore(), sessions = new LocalAnnotationSessions();
    sessions.prepare('patient-a', store)(); store.add(measurement('a-distance'));
    const before = store.export(), state = store.getState();
    const commit = sessions.prepare('patient-b', store);
    assert.equal(typeof commit, 'function');
    assert.deepEqual(store.export(), before); assert.deepEqual(store.getState(), state);
    assert.equal(sessions.active, 'patient-a');
    store.dispose();
});

test('measurement-session budget failure preserves current document and undo history', () => {
    const store = new AnnotationStore(), sessions = new LocalAnnotationSessions({ maxBytes: 1024 });
    sessions.prepare('patient-a', store)();
    for (let i = 0; i < 8; i++) store.add(measurement(`a-distance-${i}`, `1.2.3.${i + 1}`));
    const before = store.export(), state = store.getState();
    assert.throws(() => sessions.prepare('patient-b', store), /budget is full/);
    assert.deepEqual(store.export(), before); assert.deepEqual(store.getState(), state);
    assert.equal(sessions.active, 'patient-a');
    store.dispose();
});

test('measurement budget applies across retained patient documents rather than each patient independently', () => {
    const store = new AnnotationStore(), sessions = new LocalAnnotationSessions({ maxBytes: 1024 });
    sessions.prepare('patient-a', store)();
    for (let i = 0; i < 3; i++) store.add(measurement(`a-${i}`, `1.2.3.${i + 1}`));
    sessions.prepare('patient-b', store)();
    for (let i = 0; i < 3; i++) store.add(measurement(`b-${i}`, `1.2.4.${i + 1}`));
    const before = store.export();
    assert.throws(() => sessions.prepare('patient-c', store), /budget is full/);
    assert.deepEqual(store.export(), before);
    assert.equal(sessions.active, 'patient-b');
    store.dispose();
});

test('session restoration preserves the host annotation-store history configuration', () => {
    const store = new AnnotationStore({ historyLimit: 9 }), sessions = new LocalAnnotationSessions();
    sessions.prepare('patient-a', store)(); store.add(measurement('a-distance'));
    sessions.prepare('patient-b', store)(); sessions.prepare('patient-a', store)();
    assert.equal(store.historyLimit, 9); assert.equal(store.canUndo, false);
    store.add(measurement('a-distance-2', '1.2.3.2'));
    assert.equal(store.canUndo, true);
    store.dispose();
});

test('cleared annotation sessions cannot restore old patient documents', () => {
    const store = new AnnotationStore(), sessions = new LocalAnnotationSessions();
    sessions.prepare('patient-a', store)(); store.add(measurement('a-distance'));
    sessions.prepare('patient-b', store)(); sessions.clear();
    assert.equal(sessions.active, null);
    sessions.prepare('patient-a', store)();
    assert.equal(store.list().length, 0);
    store.dispose();
});

test('annotation-session budget options enforce a finite bounded store', () => {
    for (const maxBytes of [0, 1023, 8 * 1024 * 1024 + 1, Infinity, 1024.5, '1024']) {
        assert.throws(() => new LocalAnnotationSessions({ maxBytes }), /bounded/);
    }
});

test('external annotation documents are never cached or restored through the local session cache', () => {
    const store = new AnnotationStore(), sessions = new LocalAnnotationSessions();
    store.add(measurement('external-before', '1.2.9.1'));
    sessions.prepare('patient-a', store)();
    assert.equal(store.list().length, 0);
    store.add(measurement('local-a', '1.2.3.1'));
    sessions.prepare(null, store)();
    assert.equal(store.list().length, 0);
    assert.equal(sessions.documents.has(null), false);
    store.add(measurement('external-after', '1.2.9.2'));
    sessions.prepare('patient-a', store)();
    assert.deepEqual(store.list().map(annotation => annotation.id), ['local-a']);
    sessions.prepare(null, store)();
    assert.equal(store.list().length, 0);
    assert.equal(sessions.documents.has(null), false);
    assert.equal(store.canUndo, false);
    assert.equal(store.canRedo, false);
    store.dispose();
});
