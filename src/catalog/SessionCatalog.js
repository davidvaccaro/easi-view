import { normalizeWorkflow } from './workflow.js';

const MAX_TEXT = 4096;
const MAX_PATIENTS = 5000, MAX_STUDIES = 30000, MAX_SERIES = 60000;
const MAX_INSTANCE_ITEMS = 30000;
const MAX_ORIGINAL_IDENTITIES = 30000;
const text = (value, fallback = '') => {
    if (value == null) return fallback;
    if (!['string', 'number'].includes(typeof value)) throw new TypeError('Use text navigation metadata.');
    const result = String(value).replace(/[\u0000-\u001f\u007f]/gu, ' ').trim();
    if (result.length > MAX_TEXT) throw new RangeError('Navigation metadata exceeds its text limit.');
    return result || fallback;
};
const key = value => {
    const result = text(value);
    if (!result) throw new TypeError('Choose an identified source or catalog record.');
    return result;
};
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const knownCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const ordinal = value => value !== '' && value != null && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const uid = value => {
    const result = text(value);
    if (!result || result.length > 64 || !/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))+$/u.test(result)) throw new TypeError('Remote navigation requires valid DICOM UIDs.');
    return result;
};
const warnings = value => Array.isArray(value) ? [...new Set(value.map(item => text(item)).filter(Boolean))].slice(0, 100) : [];
const freeze = value => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
};
const originalIdentity = patient => ({
    patientName: text(patient.patientName ?? patient.name), patientId: text(patient.patientId ?? patient.patientID),
    issuerOfPatientId: text(patient.issuerOfPatientId ?? patient.issuer), patientBirthDate: text(patient.patientBirthDate ?? patient.birthDate)
});
const originalIdentities = identities => {
    if (!Array.isArray(identities) || identities.length > MAX_ORIGINAL_IDENTITIES) throw new RangeError('Retain at most 30,000 original local patient identities.');
    return identities.map(originalIdentity);
};
const demographic = patient => ({
    ...originalIdentity(patient), identityStatus: text(patient.identityStatus, 'source-scoped'), warnings: warnings(patient.warnings),
    ...(patient.originalIdentities != null ? { originalIdentities: originalIdentities(patient.originalIdentities) } : {})
});
const studyFields = study => ({
    studyUid: text(study.studyUid ?? study.studyInstanceUid), studyDate: text(study.studyDate), studyTime: text(study.studyTime),
    description: text(study.description ?? study.studyDescription), accessionNumber: text(study.accessionNumber),
    institutionName: text(study.institutionName), modalities: Array.isArray(study.modalities) ? [...new Set(study.modalities.map(item => text(item)).filter(Boolean))] : [],
    instanceCount: knownCount(study.instanceCount ?? study.numberOfStudyRelatedInstances), frameCount: knownCount(study.frameCount),
    seriesCount: knownCount(study.seriesCount ?? study.numberOfStudyRelatedSeries), warnings: warnings(study.warnings),
    status: text(study.status, 'available'), seriesLoaded: Array.isArray(study.series)
});
const instanceFields = instance => {
    if (!instance || typeof instance !== 'object' || Array.isArray(instance)) throw new TypeError('Use instance navigation metadata.');
    const item = { id: key(instance.id), sopUid: text(instance.sopUid ?? instance.sopInstanceUid),
        sopClassUid: text(instance.sopClassUid), instanceNumber: ordinal(instance.instanceNumber), frameCount: knownCount(instance.frameCount),
        status: text(instance.status, 'available'), indexStatus: text(instance.indexStatus, 'metadata-only'), availability: text(instance.availability, 'unverified') };
    for (const field of ['stackIndex', 'frameIndex']) if (knownCount(instance[field]) != null) item[field] = instance[field];
    return item;
};
const instanceList = instances => {
    if (!Array.isArray(instances) || instances.length > MAX_INSTANCE_ITEMS) throw new RangeError('Choose at most 30,000 instance navigation records.');
    const result = instances.map(instanceFields), ids = new Set(result.map(item => item.id));
    if (ids.size !== result.length) throw new TypeError('Instance navigation records must have distinct identifiers.');
    return result;
};
const seriesFields = series => ({
    seriesUid: text(series.seriesUid ?? series.seriesInstanceUid), description: text(series.description ?? series.seriesDescription),
    modality: text(series.modality), seriesNumber: Number.isFinite(Number(series.seriesNumber)) && series.seriesNumber !== '' && series.seriesNumber != null ? Number(series.seriesNumber) : null,
    instanceCount: knownCount(series.instanceCount ?? series.numberOfSeriesRelatedInstances), frameCount: knownCount(series.frameCount),
    revision: count(series.revision), status: text(series.status, 'available'), availability: text(series.availability, 'available'),
    workflow: normalizeWorkflow(series.workflow), warnings: warnings(series.warnings), variant: count(series.variant) || 1,
    instances: instanceList(series.instances ?? []), instancesLoaded: series.instancesLoaded === true || (Array.isArray(series.instances) && series.instancesLoaded !== false),
    stackGroups: Array.isArray(series.stackGroups) ? series.stackGroups.map(group => ({ id: key(group.id), label: text(group.label ?? group.description), frameCount: count(group.frameCount) })) : []
});
const sameDemographics = (a, b) => ['patientName', 'patientBirthDate'].every(field => !a[field] || !b[field] || a[field] === b[field]);

/** Metadata-only admission list for the viewing session. Local preview catalogs,
 * remote searches, retained files and resident pixel buffers remain independent. */
export class SessionCatalog {
    #patients = new Map(); #patientKeys = new Map(); #studyKeys = new Map(); #seriesKeys = new Map();
    #activePatientId = null; #sequence = 0; #view; #disposed = false;

    constructor() { this.#snapshot(); }
    #check() { if (this.#disposed) throw new Error('The viewing session has been disposed.'); }
    #id(type) { return `session-${type}-${++this.#sequence}`; }
    #snapshot() {
        const patients = [...this.#patients.values()].map(patient => ({ ...patient, studies: patient.studies.map(study => ({ ...study,
            series: study.series.map(series => ({ ...series })) })).sort((a, b) => b.studyDate.localeCompare(a.studyDate) || b.studyTime.localeCompare(a.studyTime) || a.id.localeCompare(b.id)) }));
        const studies = patients.flatMap(patient => patient.studies), series = studies.flatMap(study => study.series);
        this.#view = freeze({ patients, activePatientId: this.#activePatientId,
            counts: { patients: patients.length, studies: studies.length, series: series.length,
                instances: studies.reduce((total, study) => total + study.instanceCount, 0), frames: studies.reduce((total, study) => total + study.frameCount, 0) } });
    }
    #commit(plan) {
        // All validation, metadata normalization and limits precede any mutation.
        const existingId = this.#patientKeys.get(plan.patientKey), previous = existingId ? this.#patients.get(existingId) : null;
        if (previous && !sameDemographics(previous, plan.patient)) throw new TypeError('Conflicting patient demographics remain separate. Review the source identity before adding studies.');
        const newStudies = plan.studies.filter(study => !this.#studyKeys.has(study.key));
        const nextSeries = plan.studies.flatMap(study => study.series).filter(series => !this.#seriesKeys.has(series.key));
        const retainedSeries = this.#view.patients.flatMap(patient => patient.studies).flatMap(study => study.series);
        const retainedById = new Map(retainedSeries.map(series => [series.id, series]));
        const retainedInstances = retainedSeries.reduce((total, series) => total + series.instances.length, 0);
        const changedInstances = plan.studies.flatMap(study => study.series).reduce((total, descriptor) => {
            if (!descriptor.metadata.instancesLoaded) return total;
            const known = retainedById.get(this.#seriesKeys.get(descriptor.key));
            return total + descriptor.metadata.instances.length - (known?.instances.length ?? 0);
        }, 0);
        if (this.#patients.size + Number(!previous) > MAX_PATIENTS || this.#studyKeys.size + newStudies.length > MAX_STUDIES || this.#seriesKeys.size + nextSeries.length > MAX_SERIES) {
            throw new RangeError('The session metadata limit has been reached. Close a patient workspace before adding more.');
        }
        if (retainedInstances + changedInstances > MAX_INSTANCE_ITEMS) throw new RangeError('The session instance navigation limit has been reached. Close a patient workspace before adding more.');
        const source = { kind: plan.kind, id: plan.sourceId, label: plan.sourceLabel, protocol: plan.patientProvenance.protocol ?? null };
        const patient = previous ?? { ...plan.patient, id: this.#id('patient'), sourceId: plan.sourceId, sourceLabel: plan.sourceLabel,
            kind: plan.kind, source, synthetic: plan.kind === 'test', provenance: plan.patientProvenance, studies: [] };
        if (!previous) { this.#patients.set(patient.id, patient); this.#patientKeys.set(plan.patientKey, patient.id); }
        const result = { patientId: patient.id, studyIds: [], seriesIds: [], addedStudies: newStudies.length };
        for (const item of plan.studies) {
            const knownId = this.#studyKeys.get(item.key);
            let study = patient.studies.find(entry => entry.id === knownId);
            if (knownId && !study) throw new Error('A study cannot be shared between patient workspaces.');
            if (!study) {
                study = { ...item.metadata, id: this.#id('study'), patientIdOpaque: patient.id, sourceId: plan.sourceId,
                    sourceLabel: plan.sourceLabel, kind: plan.kind, source, provenance: item.provenance, series: [] };
                patient.studies.push(study); this.#studyKeys.set(item.key, study.id);
            } else {
                Object.assign(study, item.metadata, { seriesLoaded: study.seriesLoaded || item.metadata.seriesLoaded });
            }
            result.studyIds.push(study.id);
            for (const descriptor of item.series) {
                const knownSeriesId = this.#seriesKeys.get(descriptor.key);
                let series = study.series.find(entry => entry.id === knownSeriesId);
                if (!series) {
                    series = { ...descriptor.metadata, id: this.#id('series'), patientIdOpaque: patient.id, patientId: patient.id, studyId: study.id,
                        sourceId: plan.sourceId, sourceLabel: plan.sourceLabel, kind: plan.kind, source, provenance: descriptor.provenance };
                    study.series.push(series); this.#seriesKeys.set(descriptor.key, series.id);
                } else {
                    const status = series.status, instances = series.instances, instancesLoaded = series.instancesLoaded;
                    Object.assign(series, descriptor.metadata);
                    if (instancesLoaded && !descriptor.metadata.instancesLoaded) { series.instances = instances; series.instancesLoaded = true; }
                    if (['loaded', 'loading'].includes(status)) series.status = status;
                }
                result.seriesIds.push(series.id);
            }
            if (study.seriesLoaded || study.series.length || study.seriesCount != null) study.seriesCount = Math.max(study.seriesCount ?? 0, study.series.length);
        }
        if (!this.#activePatientId) this.#activePatientId = patient.id;
        this.#snapshot(); return freeze(result);
    }
    admitLocal(view, { sourceId = 'local', sourceLabel = 'On this device', patientId, studyIds } = {}) {
        this.#check(); sourceId = key(sourceId); sourceLabel = text(sourceLabel, 'On this device'); patientId = key(patientId);
        const patient = view?.patients?.find(item => item.id === patientId);
        if (!patient || !Array.isArray(studyIds) || !studyIds.length) throw new TypeError('Choose a local patient and at least one study.');
        const selectedIds = [...new Set(studyIds.map(key))], selected = selectedIds.map(id => patient.studies?.find(study => study.id === id));
        if (selected.some(study => !study)) throw new TypeError('Choose studies belonging to the selected patient.');
        const patientKey = JSON.stringify(['local', sourceId, patientId]);
        return this.#commit({ patientKey, patient: demographic(patient), sourceId, sourceLabel, kind: 'local',
            patientProvenance: { kind: 'local', sourceId, patientId },
            studies: selected.map(study => {
                const studyId = key(study.id), studyKey = JSON.stringify([patientKey, studyId]);
                return { key: studyKey, metadata: studyFields(study), provenance: { kind: 'local', sourceId, patientId, studyId },
                    series: (study.series ?? []).map(series => {
                        const seriesId = key(series.id);
                        return { key: JSON.stringify([studyKey, seriesId]), metadata: { ...seriesFields(series), instancesLoaded: true },
                            provenance: { kind: 'local', sourceId, patientId, studyId, seriesId } };
                    }) };
            }) });
    }
    admitRemote(sourceId, patient, studies, { sourceLabel = 'Remote archive', protocol = 'dicomweb' } = {}) {
        this.#check(); sourceId = key(sourceId); sourceLabel = text(sourceLabel, 'Remote archive'); protocol = text(protocol, 'dicomweb');
        if (!patient || !Array.isArray(studies) || !studies.length) throw new TypeError('Choose a remote patient and at least one study.');
        const identity = demographic(patient), fallback = text(patient.identityKey ?? patient.provenance?.candidateId ?? patient.id);
        if (!identity.patientId && !fallback) throw new TypeError('Choose a patient identified by the selected archive.');
        // Neither names nor identifiers from another source form an automatic association.
        const restricted = ['study-scoped', 'demographics-conflict', 'unverified'].includes(identity.identityStatus) || /[*?\\]/u.test(identity.patientId);
        if (restricted && !fallback) throw new TypeError('Choose the source-scoped patient candidate returned by this archive.');
        const patientKey = JSON.stringify(['remote', sourceId, identity.issuerOfPatientId, restricted ? ['candidate', fallback] : identity.patientId || fallback]);
        const seen = new Set();
        const descriptors = studies.map(study => {
            if (study.sourceId && study.sourceId !== sourceId) throw new TypeError('Choose studies from the selected repository.');
            const studyUid = uid(study.studyUid ?? study.studyInstanceUid), studyKey = JSON.stringify([patientKey, studyUid]);
            if (seen.has(studyKey)) throw new TypeError('Choose each remote study only once.'); seen.add(studyKey);
            const owner = demographic(study);
            if ((owner.patientId && owner.patientId !== identity.patientId) || (owner.issuerOfPatientId && owner.issuerOfPatientId !== identity.issuerOfPatientId) || !sameDemographics(identity, owner)) {
                throw new TypeError('A selected study does not match the selected patient identity.');
            }
            const provenance = { kind: 'remote', sourceId, protocol, studyUid };
            const seriesUids = new Set();
            return { key: studyKey, metadata: { ...studyFields(study), studyUid }, provenance,
                series: (study.series ?? []).map(series => {
                    if (series.sourceId && series.sourceId !== sourceId) throw new TypeError('Choose series from the selected repository.');
                    const seriesUid = uid(series.seriesUid ?? series.seriesInstanceUid);
                    if (seriesUids.has(seriesUid)) throw new TypeError('Remote series must have distinct UIDs.'); seriesUids.add(seriesUid);
                    if (series.studyUid && series.studyUid !== studyUid) throw new TypeError('Choose series belonging to the selected study.');
                    const seriesKey = JSON.stringify([studyKey, seriesUid]), known = this.getSeries(this.#seriesKeys.get(seriesKey));
                    const instances = Array.isArray(series.instances) ? this.#remoteInstances(series.instances, { sourceId, studyUid, seriesUid }, known?.instances) : undefined;
                    return { key: seriesKey, metadata: { ...seriesFields({ ...series, ...(instances ? { instances } : {}) }), seriesUid },
                        provenance: { ...provenance, seriesUid } };
                }) };
        });
        return this.#commit({ patientKey, patient: identity, sourceId, sourceLabel, kind: 'remote',
            patientProvenance: { kind: 'remote', sourceId, protocol, candidateId: fallback }, studies: descriptors });
    }
    admitTest(demo) {
        this.#check(); if (!demo) throw new TypeError('Choose a synthetic example.');
        const demoId = key(typeof demo === 'string' ? demo : demo.id ?? demo.kind), item = typeof demo === 'string' ? {} : demo;
        const patientKey = JSON.stringify(['synthetic-tests']), studyKey = JSON.stringify([patientKey, demoId]);
        const known = this.getStudy(this.#studyKeys.get(studyKey));
        const description = text(item.description ?? item.name ?? item.label, known?.description || `${demoId.toUpperCase()} example`);
        const studyMetadata = { ...known, ...item, description }, seriesMetadata = { ...known?.series[0], ...item, description };
        return this.#commit({ patientKey, patient: { patientName: 'Synthetic test workspace', patientId: 'SYNTHETIC', issuerOfPatientId: 'EASI VIEW', patientBirthDate: '', identityStatus: 'synthetic', warnings: [] },
            sourceId: 'synthetic', sourceLabel: 'Synthetic examples', kind: 'test', patientProvenance: { kind: 'test', sourceId: 'synthetic' },
            studies: [{ key: studyKey, metadata: { ...studyFields(studyMetadata), modalities: [text(seriesMetadata.modality, demoId.toUpperCase())], seriesLoaded: true, seriesCount: 1 },
                provenance: { kind: 'test', sourceId: 'synthetic', demoId }, series: [{ key: studyKey,
                    metadata: { ...seriesFields(seriesMetadata), modality: text(seriesMetadata.modality, demoId.toUpperCase()) },
                    provenance: { kind: 'test', sourceId: 'synthetic', demoId } }] }] });
    }
    getView() { this.#check(); return this.#view; }
    getPatient(id) { this.#check(); return this.#view.patients.find(patient => patient.id === id) ?? null; }
    getStudy(id) { this.#check(); return this.#view.patients.flatMap(patient => patient.studies).find(study => study.id === id) ?? null; }
    getSeries(id) { this.#check(); return this.#view.patients.flatMap(patient => patient.studies).flatMap(study => study.series).find(series => series.id === id) ?? null; }
    selectPatient(id) {
        this.#check(); if (!this.#patients.has(id)) throw new TypeError('Choose a patient in the viewing session.');
        this.#activePatientId = id; this.#snapshot(); return this.getPatient(id);
    }
    setStudySeries(studyId, descriptors) {
        this.#check(); const study = this.getStudy(studyId);
        if (!study || study.kind !== 'remote' || !Array.isArray(descriptors)) throw new TypeError('Choose a remote study and its series list.');
        const patient = this.getPatient(study.patientIdOpaque);
        if (!descriptors.length) {
            const retained = this.#patients.get(patient.id).studies.find(item => item.id === studyId); retained.seriesLoaded = true; this.#snapshot(); return this.getStudy(studyId);
        }
        this.admitRemote(study.sourceId, patient, [{ ...study, series: descriptors }], { sourceLabel: study.sourceLabel, protocol: study.provenance.protocol });
        return this.getStudy(studyId);
    }
    #remoteInstances(descriptors, owner, previous = []) {
        if (!Array.isArray(descriptors) || descriptors.length > MAX_INSTANCE_ITEMS) throw new RangeError('Choose at most 30,000 instance navigation records.');
        const known = new Map(previous.map(instance => [instance.sopUid, instance.id])), seen = new Set();
        const validated = descriptors.map(descriptor => {
            if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) throw new TypeError('Use instance navigation metadata.');
            if (descriptor.sourceId && descriptor.sourceId !== owner.sourceId) throw new TypeError('Choose instances from the selected repository.');
            const studyUid = descriptor.studyUid ?? descriptor.studyInstanceUid, seriesUid = descriptor.seriesUid ?? descriptor.seriesInstanceUid;
            if ((studyUid && studyUid !== owner.studyUid) || (seriesUid && seriesUid !== owner.seriesUid)) throw new TypeError('Choose instances belonging to the selected series.');
            const sopUid = uid(descriptor.sopUid ?? descriptor.sopInstanceUid), sopClassUid = descriptor.sopClassUid ? uid(descriptor.sopClassUid) : '';
            if (seen.has(sopUid)) throw new TypeError('Remote instances must have distinct SOP Instance UIDs.'); seen.add(sopUid);
            return { ...descriptor, id: known.get(sopUid) ?? this.#id('instance'), sopUid, sopClassUid };
        });
        return instanceList(validated);
    }
    /** Explicit instance enumeration retains metadata only. Remote ownership and
     * UIDs are validated before replacing an existing list; no pixels are read. */
    setSeriesInstances(seriesId, descriptors) {
        this.#check(); const known = this.getSeries(seriesId);
        if (!known) throw new TypeError('Choose a series in the viewing session.');
        const instances = known.kind === 'remote' ? this.#remoteInstances(descriptors, {
            sourceId: known.sourceId, studyUid: known.provenance.studyUid, seriesUid: known.provenance.seriesUid
        }, known.instances) : instanceList(descriptors);
        const total = this.#view.patients.flatMap(patient => patient.studies).flatMap(study => study.series)
            .reduce((sum, series) => sum + (series.id === seriesId ? instances.length : series.instances.length), 0);
        if (total > MAX_INSTANCE_ITEMS) throw new RangeError('The session instance navigation limit has been reached. Close a patient workspace before adding more.');
        const study = this.#patients.get(known.patientIdOpaque).studies.find(item => item.id === known.studyId), series = study.series.find(item => item.id === seriesId);
        series.instances = instances; series.instancesLoaded = true;
        this.#snapshot(); return this.getSeries(seriesId);
    }
    updateSeries(seriesId, patch = {}) {
        this.#check(); const known = this.getSeries(seriesId); if (!known) throw new TypeError('Choose a series in the viewing session.');
        const changes = {};
        for (const field of ['status', 'availability']) if (patch[field] != null) changes[field] = text(patch[field]);
        for (const field of ['instanceCount', 'frameCount', 'revision']) if (patch[field] != null) changes[field] = count(patch[field]);
        if (patch.warnings != null) changes.warnings = warnings(patch.warnings);
        if (patch.workflow != null) changes.workflow = normalizeWorkflow(patch.workflow);
        if (patch.stackGroups != null) changes.stackGroups = seriesFields({ stackGroups: patch.stackGroups }).stackGroups;
        const study = this.#patients.get(known.patientIdOpaque).studies.find(item => item.id === known.studyId), series = study.series.find(item => item.id === seriesId);
        Object.assign(series, changes);
        if (study.seriesLoaded) {
            study.seriesCount = study.series.length;
            for (const field of ['instanceCount', 'frameCount']) if (study.series.every(item => knownCount(item[field]) != null)) {
                study[field] = study.series.reduce((total, item) => total + item[field], 0);
            }
        }
        this.#snapshot(); return this.getSeries(seriesId);
    }
    /** Prepare a confirmed association without changing the catalog. Existing
     * admitted studies retain their IDs, source provenance and UID boundaries;
     * unselected studies in the private local index are never admitted here. */
    prepareLocalAssociation(fromId, toId, options = {}) {
        this.#check();
        if (!options || Object.getPrototypeOf(options) !== Object.prototype || Reflect.ownKeys(options).some(field => field !== 'confirmed') || options.confirmed !== true) {
            throw new TypeError('Explicitly confirm the local patient association.');
        }
        const from = this.#patients.get(fromId), to = this.#patients.get(toId);
        if (!from || !to || fromId === toId || from.kind !== 'local' || to.kind !== 'local' || from.sourceId !== to.sourceId) {
            throw new TypeError('Choose two local patient records from the same source.');
        }
        const patientKey = JSON.stringify(['local', to.sourceId, key(to.provenance.patientId)]);
        const studies = [...to.studies, ...from.studies].map(study => ({ ...study, patientIdOpaque: toId,
            series: study.series.map(series => ({ ...series, patientId: toId, patientIdOpaque: toId })) }));
        const studyIds = new Set(studies.map(study => study.id)), seriesIds = new Set(studies.flatMap(study => study.series.map(series => series.id)));
        const studyKeys = new Map([...this.#studyKeys].filter(([, id]) => !studyIds.has(id)));
        const seriesKeys = new Map([...this.#seriesKeys].filter(([, id]) => !seriesIds.has(id)));
        for (const study of studies) {
            const studyKey = JSON.stringify([patientKey, key(study.provenance.studyId)]);
            if (studyKeys.has(studyKey)) throw new TypeError('Independent local study records must retain separate identifiers.');
            studyKeys.set(studyKey, study.id);
            for (const series of study.series) {
                const seriesKey = JSON.stringify([studyKey, key(series.provenance.seriesId)]);
                if (seriesKeys.has(seriesKey)) throw new TypeError('Independent local series records must retain separate identifiers.');
                seriesKeys.set(seriesKey, series.id);
            }
        }
        const targetIdentities = to.originalIdentities ?? [to], sourceIdentities = from.originalIdentities ?? [from];
        if (targetIdentities.length + sourceIdentities.length > MAX_ORIGINAL_IDENTITIES) throw new RangeError('Retain at most 30,000 original local patient identities.');
        const patient = { ...to, identityStatus: 'confirmed-association',
            warnings: warnings([...to.warnings, ...from.warnings, 'These original patient records were associated explicitly for this viewer session. DICOM metadata is unchanged.']),
            originalIdentities: originalIdentities([...targetIdentities, ...sourceIdentities]), studies };
        const patientKeys = new Map([...this.#patientKeys].filter(([, id]) => id !== fromId));
        patientKeys.set(patientKey, toId);
        const patients = new Map(this.#patients); patients.delete(fromId); patients.set(toId, patient);
        const before = this.#view, result = freeze({ patientId: toId, fromPatientId: fromId, studyIds: [...studyIds], seriesIds: [...seriesIds] });
        let committed = false;
        return () => {
            this.#check();
            if (committed || this.#view !== before) throw new Error('The patient association was superseded. Review the current records again.');
            committed = true;
            this.#patients = patients; this.#patientKeys = patientKeys; this.#studyKeys = studyKeys; this.#seriesKeys = seriesKeys;
            if (this.#activePatientId === fromId) this.#activePatientId = toId;
            this.#snapshot(); return result;
        };
    }
    associateLocalPatients(fromId, toId, options = {}) { return this.prepareLocalAssociation(fromId, toId, options)(); }
    removePatient(patientId) {
        this.#check(); if (!this.#patients.has(patientId)) return false;
        const patient = this.#patients.get(patientId), studyIds = new Set(patient.studies.map(study => study.id)), seriesIds = new Set(patient.studies.flatMap(study => study.series.map(series => series.id)));
        this.#patients.delete(patientId);
        for (const [entry, value] of this.#patientKeys) if (value === patientId) this.#patientKeys.delete(entry);
        for (const [entry, value] of this.#studyKeys) if (studyIds.has(value)) this.#studyKeys.delete(entry);
        for (const [entry, value] of this.#seriesKeys) if (seriesIds.has(value)) this.#seriesKeys.delete(entry);
        if (this.#activePatientId === patientId) this.#activePatientId = this.#patients.keys().next().value ?? null;
        this.#snapshot(); return true;
    }
    clear() { this.#check(); this.#patients.clear(); this.#patientKeys.clear(); this.#studyKeys.clear(); this.#seriesKeys.clear(); this.#activePatientId = null; this.#snapshot(); }
    dispose() { if (!this.#disposed) { this.clear(); this.#disposed = true; } }
}
