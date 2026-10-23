import { MAX_LOCAL_WORKING_STACKS } from './LocalWorkingSet.js';

const fail = message => { throw new Error(message); };
const plain = (value, keys) => {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some(key => !keys.includes(key))) throw new TypeError('Use supported local-library selection options.');
};

/** Navigation roles contain opaque catalog references, never a patient identifier. */
export class LocalPatientSession {
    constructor() { this.view = { patients: [] }; this.clear(); }
    update(view) {
        this.view = view;
        if (this.patientId && !this.patient(this.patientId)) this.clear();
        if (this.patientId) {
            const studies = this.patient(this.patientId).studies;
            if (!studies.some(study => study.id === this.currentStudyId)) { this.currentStudyId = null; this.comparisonStudyId = null; }
            if (!studies.some(study => study.id === this.comparisonStudyId)) this.comparisonStudyId = null;
        }
    }
    patient(id) { return this.view.patients.find(patient => patient.id === id) ?? null; }
    study(id) {
        for (const patient of this.view.patients) {
            const study = patient.studies.find(study => study.id === id);
            if (study) return { patient, study };
        }
        return fail('Choose an indexed local study.');
    }
    series(id) {
        for (const patient of this.view.patients) for (const study of patient.studies) {
            const series = study.series.find(series => series.id === id);
            if (series) return { patient, study, series };
        }
        return fail('Choose an indexed local series.');
    }
    planPatient(id) {
        if (!this.patient(id)) return fail('Choose an indexed local patient.');
        return { patientId: id, currentStudyId: null, comparisonStudyId: null, selections: [] };
    }
    planSeries(id, options = {}) {
        plain(options, ['stackIndex']);
        const { patient, study, series } = this.series(id);
        return { patientId: patient.id, currentStudyId: study.id, comparisonStudyId: null,
            selections: [{ patientId: patient.id, studyId: study.id, seriesId: series.id, stackIndex: this.stackIndex(options.stackIndex), role: 'current' }] };
    }
    planStudy(id, options = {}) {
        plain(options, ['seriesId', 'stackIndex']);
        const { study } = this.study(id), series = study.series.find(series => series.id === options.seriesId) ?? (!options.seriesId ? study.series[0] : null);
        if (!series) return fail('Choose a series belonging to the selected local study.');
        return this.planSeries(series.id, { stackIndex: options.stackIndex });
    }
    planComparison(currentId, comparisonId, options = {}) {
        plain(options, ['currentSeriesId', 'comparisonSeriesId', 'currentStackIndex', 'comparisonStackIndex']);
        const current = this.study(currentId), comparison = this.study(comparisonId);
        if (currentId === comparisonId || current.patient.id !== comparison.patient.id) return fail('Choose two distinct studies associated with the same local patient.');
        const choose = (entry, requested) => entry.study.series.find(series => series.id === requested) ?? (!requested ? entry.study.series[0] : null);
        const a = choose(current, options.currentSeriesId), b = choose(comparison, options.comparisonSeriesId);
        if (!a || !b) return fail('Choose a series belonging to each selected local study.');
        return { patientId: current.patient.id, currentStudyId: currentId, comparisonStudyId: comparisonId,
            selections: [{ patientId: current.patient.id, studyId: currentId, seriesId: a.id, stackIndex: this.stackIndex(options.currentStackIndex), role: 'current' },
                { patientId: current.patient.id, studyId: comparisonId, seriesId: b.id, stackIndex: this.stackIndex(options.comparisonStackIndex), role: 'comparison' }] };
    }
    stackIndex(index = 0) {
        if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_LOCAL_WORKING_STACKS) throw new RangeError('Choose an available local series stack.');
        return index;
    }
    commit(plan) {
        if (!this.patient(plan.patientId)) return fail('The selected local patient is no longer available.');
        if (!Array.isArray(plan.selections) || ![0, 1, 2].includes(plan.selections.length)) return fail('Use one selected study or a two-study local comparison.');
        for (const selected of plan.selections) {
            const resolved = this.series(selected.seriesId);
            if (resolved.patient.id !== plan.patientId || resolved.study.id !== selected.studyId || selected.patientId !== plan.patientId) return fail('The selected local records no longer belong to this patient session.');
            this.stackIndex(selected.stackIndex);
        }
        if (plan.selections.length && (plan.selections[0].studyId !== plan.currentStudyId || plan.selections[0].role !== 'current') ||
            plan.selections.length === 2 && (plan.selections[1].studyId !== plan.comparisonStudyId || plan.selections[1].role !== 'comparison' || plan.currentStudyId === plan.comparisonStudyId) ||
            plan.selections.length < 2 && plan.comparisonStudyId != null || !plan.selections.length && plan.currentStudyId != null) return fail('Use explicit current and comparison study roles.');
        this.patientId = plan.patientId; this.currentStudyId = plan.currentStudyId; this.comparisonStudyId = plan.comparisonStudyId;
    }
    clear() { this.patientId = null; this.currentStudyId = null; this.comparisonStudyId = null; }
    getState() { return { activePatientId: this.patientId, currentStudyId: this.currentStudyId, comparisonStudyId: this.comparisonStudyId }; }
}

/** Bounded session-only measurement documents; inactive patients never enter the active undo/export store. */
export class LocalAnnotationSessions {
    constructor({ maxBytes = 8 * 1024 * 1024 } = {}) {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 8 * 1024 * 1024) throw new TypeError('Use a bounded local measurement-session budget.');
        this.maxBytes = maxBytes; this.documents = new Map(); this.active = null;
    }
    prepare(key, store) {
        if (key === this.active) return () => {};
        const before = store.export(), bytes = new TextEncoder().encode(JSON.stringify(before)).byteLength;
        const retained = new Map(this.documents);
        if (this.active != null && before.annotations.length) retained.set(this.active, { document: before, bytes }); else retained.delete(this.active);
        const target = key != null ? retained.get(key)?.document ?? { ...before, annotations: [] } : { ...before, annotations: [] };
        if ([...retained.values()].reduce((sum, item) => sum + item.bytes, 0) > this.maxBytes) return fail('The local measurement-session budget is full. Export and clear unused measurements before changing patients.');
        return () => {
            const historyLimit = store.historyLimit;
            store.clearHistory(); store.historyLimit = 0;
            try { store.import(target, { mode: 'replace' }); }
            finally { store.historyLimit = historyLimit; store.clearHistory(); }
            this.documents = retained; this.active = key;
        };
    }
    clear() { this.documents.clear(); this.active = null; }
}

