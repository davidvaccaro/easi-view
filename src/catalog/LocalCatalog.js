import { catalogError, checkCatalogAbort, indexLocalFile, validCatalogUid } from './metadata.js';
import { aggregateWorkflow } from './workflow.js';

export const MAX_CATALOG_FILES = 30000;
export const MAX_CATALOG_BYTES = 64 * 1024 * 1024;
const encoder = new TextEncoder();
const IDENTITY_WARNING = 'Patient identity is scoped to this import. Confirm an association before combining outside imports.';
const CONFLICT_WARNING = 'Patient identifiers match but demographics conflict or are ambiguous. These records remain separate.';
const UID_WARNING = 'A UID is reused by different local files. Copies are unverified and conflicting instances remain separately selectable.';
const ASSOCIATION_WARNING = 'These original patient records were associated explicitly for this viewer session. DICOM metadata is unchanged.';
const ALLOWED_FAILURES = new Set(['metadata-limit', 'scan-limit', 'character-set', 'invalid-input', 'not-dicom', 'directory-mismatch']);

function verifyMediaReference(metadata, reference) {
    if (!reference) return;
    for (const key of ['patientId', 'issuerOfPatientId', 'patientBirthDate', 'studyUid', 'seriesUid', 'sopUid', 'sopClassUid', 'transferSyntaxUid']) {
        if (reference[key] && reference[key] !== metadata[key]) throw catalogError('directory-mismatch', 'A referenced image does not match its DICOMDIR identity or encoding. It was not added.');
    }
    const name = value => String(value || '').replaceAll('^', ' ').replace(/\s+/gu, ' ').trim();
    if (reference.patientName && name(reference.patientName) !== name(metadata.patientName)) throw catalogError('directory-mismatch', 'A referenced image does not match its DICOMDIR patient identity. It was not added.');
}

function sameDemographics(a, b) {
    return ['patientName', 'patientBirthDate'].every(key => !a[key] || !b[key] || a[key] === b[key]);
}
function identityKey(metadata, batchId, recordId) {
    if (metadata.patientId && metadata.issuerOfPatientId) return JSON.stringify(['issuer', metadata.issuerOfPatientId, metadata.patientId]);
    if (metadata.patientId) return JSON.stringify(['batch', batchId, metadata.patientId]);
    return JSON.stringify(['study', batchId, validCatalogUid(metadata.studyUid) ? metadata.studyUid : recordId]);
}
function uidKey(value, fallback) { return validCatalogUid(value) ? value : fallback; }
function unique(values) { return [...new Set(values)]; }
function clone(value) { return structuredClone(value); }
function sortStudies(a, b) {
    return b.studyDate.localeCompare(a.studyDate) || b.studyTime.localeCompare(a.studyTime) || a.id.localeCompare(b.id);
}
function sortSeries(a, b) {
    return (a.seriesNumber ?? Infinity) - (b.seriesNumber ?? Infinity) || a.description.localeCompare(b.description) || a.id.localeCompare(b.id);
}
function freezeTree(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freezeTree); Object.freeze(value); }
    return value;
}

/** Session-only index. File references are private; pixels are parsed only when
 * the host deliberately requests getSeriesFiles() and opens that selection. */
export class LocalCatalog {
    #records = [];
    #files = new WeakMap();
    #associations = new Map();
    #view = { patients: [], counts: { patients: 0, studies: 0, series: 0, instances: 0, frames: 0, batches: 0, metadataBytes: 0 } };
    #series = new Map();
    #groups = new Map();
    #sequence = 0;
    #generation = 0;
    #busy = false;
    #disposed = false;
    #activeAbort = null;
    #maxFiles;
    #maxMetadataBytes;

    constructor({ maxFiles = MAX_CATALOG_FILES, maxMetadataBytes = MAX_CATALOG_BYTES } = {}) {
        if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_CATALOG_FILES ||
            !Number.isSafeInteger(maxMetadataBytes) || maxMetadataBytes < 1 || maxMetadataBytes > MAX_CATALOG_BYTES) {
            throw new TypeError('Use bounded local catalog limits.');
        }
        this.#maxFiles = maxFiles;
        this.#maxMetadataBytes = maxMetadataBytes;
    }

    #id(kind) { return `local-${kind}-${++this.#sequence}`; }
    #check() { if (this.#disposed) throw catalogError('disposed', 'The local catalog has been disposed.'); }

    /** Index one additive batch atomically. No filenames/metadata enter progress. */
    async addFiles(files, { signal, onProgress, references } = {}) {
        this.#check();
        checkCatalogAbort(signal);
        if (this.#busy) throw catalogError('busy', 'Another local import is still indexing.');
        const inputs = [];
        for (const file of files ?? []) {
            if (inputs.length >= this.#maxFiles) throw catalogError('file-limit', 'The local collection exceeds its file-count limit.');
            inputs.push(file);
        }
        if (!inputs.length) throw catalogError('empty-input', 'Choose one or more DICOM files.');
        if (onProgress != null && typeof onProgress !== 'function') throw new TypeError('Use a progress callback.');
        if (references != null && !(references instanceof Map)) throw new TypeError('Use resolved local media references.');
        const lifetime = new AbortController();
        this.#activeAbort = lifetime;
        signal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
        const batchId = this.#id('batch'), generation = this.#generation;
        const pending = [], selected = [], failures = [], seen = new WeakMap();
        let duplicates = 0, metadataBytes = this.#view.counts.metadataBytes;
        this.#busy = true;
        const report = phase => onProgress?.(Object.freeze({ phase, completed: pending.length + failures.length + duplicates,
            total: inputs.length, indexed: pending.length, failed: failures.length, duplicates }));
        try {
            report('indexing');
            for (let index = 0; index < inputs.length; index++) {
                checkCatalogAbort(signal);
                if (this.#generation !== generation) throw new DOMException('Local indexing was canceled.', 'AbortError');
                const file = inputs[index];
                const known = file && (typeof file === 'object' || typeof file === 'function') ? this.#files.get(file) || seen.get(file) : null;
                if (!known && this.#records.length + pending.length >= this.#maxFiles) throw catalogError('file-limit', 'The local collection exceeds its file-count limit.');
                try {
                    if (known) {
                        verifyMediaReference(known.metadata, references?.get(file)); duplicates++; selected.push(known);
                    } else {
                        const metadata = await indexLocalFile(file, { signal });
                        verifyMediaReference(metadata, references?.get(file));
                        const bytes = encoder.encode(JSON.stringify(metadata)).byteLength;
                        if (metadataBytes + bytes > this.#maxMetadataBytes) throw catalogError('catalog-limit', 'The local collection exceeds its metadata memory limit.');
                        metadataBytes += bytes;
                        const record = { id: this.#id('instance'), file, metadata, bytes, batchId, patientGroupId: null, studyId: null, seriesId: null };
                        pending.push(record); selected.push(record); seen.set(file, record);
                    }
                } catch (error) {
                    checkCatalogAbort(signal);
                    if (error?.name === 'AbortError' || error?.code === 'catalog-limit') throw error;
                    const code = ALLOWED_FAILURES.has(error?.code) ? error.code : 'index-error';
                    failures.push({ index, code, message: code === 'index-error' ? 'DICOM navigation metadata could not be indexed.' : error.message });
                }
                report('indexing');
                // Yield even for tiny files so cancellation and UI remain responsive.
                if ((index + 1) % 32 === 0) await new Promise(resolve => setTimeout(resolve, 0));
            }
            checkCatalogAbort(signal);
            if (this.#generation !== generation) throw new DOMException('Local indexing was canceled.', 'AbortError');
            const records = [...this.#records.map(record => ({ ...record })), ...pending];
            const built = this.#build(records, this.#associations);
            // Completion callbacks run before commit; a callback may cancel.
            report('complete');
            checkCatalogAbort(signal);
            if (this.#generation !== generation) throw new DOMException('Local indexing was canceled.', 'AbortError');
            this.#records = records;
            this.#install(built);
            this.#files = new WeakMap(records.map(record => [record.file, record]));
            const choices = new Map();
            for (const record of selected) {
                const patientId = this.#resolve(record.patientGroupId, this.#associations);
                const choice = choices.get(patientId) ?? { patientId, studyIds: new Set(), seriesIds: new Set() };
                choice.studyIds.add(record.studyId); choice.seriesIds.add(record.seriesId); choices.set(patientId, choice);
            }
            return freezeTree({ batchId, added: pending.length, duplicates, failed: failures.length,
                patientIds: [...choices.keys()], selection: [...choices.values()].map(choice => ({ patientId: choice.patientId,
                    studyIds: [...choice.studyIds], seriesIds: [...choice.seriesIds] })),
                failures, counts: this.getState() });
        } finally { this.#busy = false; this.#activeAbort = null; }
    }

    #resolve(id, associations) {
        const visited = new Set();
        while (associations.has(id)) {
            if (visited.has(id)) throw catalogError('association-cycle', 'Invalid local patient association.');
            visited.add(id); id = associations.get(id);
        }
        return id;
    }

    #build(records, associations) {
        const groups = new Map(), byIdentity = new Map();
        for (const record of records) {
            const metadata = record.metadata, key = identityKey(metadata, record.batchId, record.id);
            const candidates = byIdentity.get(key) ?? [];
            let group = record.patientGroupId ? groups.get(record.patientGroupId) : null;
            if (!group && !record.patientGroupId) {
                const compatible = candidates.filter(candidate => sameDemographics(candidate.metadata, metadata));
                if (compatible.length === 1) group = compatible[0];
            }
            if (!group) {
                const id = record.patientGroupId ?? this.#id('patient');
                group = { id, key, metadata: { ...metadata }, records: [], warnings: [], candidates };
                groups.set(id, group); candidates.push(group); byIdentity.set(key, candidates);
            }
            for (const field of ['patientName', 'patientBirthDate']) if (!group.metadata[field]) group.metadata[field] = metadata[field];
            record.patientGroupId = group.id;
            group.records.push(record);
        }
        for (const candidates of byIdentity.values()) {
            if (candidates.length > 1) for (const group of candidates) group.warnings.push(CONFLICT_WARNING);
        }
        const patients = new Map(), series = new Map(), studyOwners = new Map(), seriesOwners = new Map();
        for (const group of groups.values()) {
            const targetId = this.#resolve(group.id, associations), target = groups.get(targetId);
            if (!target) throw catalogError('patient-not-found', 'Choose an indexed local patient.');
            let patient = patients.get(targetId);
            if (!patient) {
                const metadata = target.metadata;
                const identityStatus = associations.has(group.id) || [...associations.values()].includes(targetId) ? 'confirmed-association' :
                    metadata.patientId && metadata.issuerOfPatientId ? 'issuer-qualified' : metadata.patientId ? 'batch-scoped' : 'study-scoped';
                patient = { id: targetId, patientName: metadata.patientName, patientId: metadata.patientId,
                    issuerOfPatientId: metadata.issuerOfPatientId, patientBirthDate: metadata.patientBirthDate,
                    identityStatus, warnings: [], originalIdentities: [], studies: [], studyMap: new Map() };
                patients.set(targetId, patient);
            }
            patient.warnings.push(...group.warnings);
            if (patient.identityStatus === 'confirmed-association') patient.warnings.push(ASSOCIATION_WARNING);
            else if (patient.identityStatus !== 'issuer-qualified') patient.warnings.push(IDENTITY_WARNING);
            patient.originalIdentities.push({ patientName: group.metadata.patientName, patientId: group.metadata.patientId,
                issuerOfPatientId: group.metadata.issuerOfPatientId, patientBirthDate: group.metadata.patientBirthDate });
            for (const record of group.records) {
                const metadata = record.metadata;
                // Even an explicit patient association does not merge originally
                // independent same-UID studies. Their original provenance stays.
                let studyKey = JSON.stringify([group.id, uidKey(metadata.studyUid, record.id)]);
                let study = patient.studyMap.get(studyKey);
                const dateConflict = study && study.studyDate && metadata.studyDate && study.studyDate !== metadata.studyDate;
                if (dateConflict) {
                    study.warnings.push('This Study UID has conflicting examination dates; the dates remain separately selectable.');
                    studyKey = JSON.stringify([group.id, uidKey(metadata.studyUid, record.id), metadata.studyDate]);
                    study = patient.studyMap.get(studyKey);
                }
                if (!study) {
                    study = { id: record.studyId ?? this.#id('study'), studyUid: metadata.studyUid, studyDate: metadata.studyDate,
                        studyTime: metadata.studyTime, description: metadata.studyDescription, modalities: [], institutionName: metadata.institutionName,
                        instanceCount: 0, frameCount: 0,
                        warnings: dateConflict ? ['This Study UID has conflicting examination dates; the dates remain separately selectable.'] : [],
                        series: [], seriesMap: new Map(), variantCounts: new Map() };
                    patient.studyMap.set(studyKey, study); patient.studies.push(study);
                }
                if (!study.studyDate) study.studyDate = metadata.studyDate;
                if (!study.studyTime) study.studyTime = metadata.studyTime;
                record.studyId = study.id;
                const baseKey = JSON.stringify([uidKey(metadata.seriesUid, record.id), metadata.modality]);
                let entry = study.seriesMap.get(baseKey);
                const conflict = entry && validCatalogUid(metadata.sopUid) && entry.sopUids.has(metadata.sopUid);
                if (conflict) { entry.warnings.push(UID_WARNING); entry.status = 'uid-conflict'; entry = null; }
                if (!entry) {
                    const variant = (study.variantCounts.get(baseKey) ?? 0) + 1;
                    study.variantCounts.set(baseKey, variant);
                    entry = { id: record.seriesId ?? this.#id('series'), seriesUid: metadata.seriesUid, studyUid: metadata.studyUid,
                        studyId: study.id, patientIdOpaque: patient.id, description: metadata.seriesDescription, modality: metadata.modality,
                        patientKey: patient.id, seriesNumber: metadata.seriesNumber, instanceCount: 0, frameCount: 0,
                        variant,
                        status: conflict ? 'uid-conflict' : 'indexed',
                        indexStatus: 'metadata-only', availability: 'unverified', warnings: conflict ? [UID_WARNING] : [],
                        instances: [], records: [], sopUids: new Set() };
                    // Subsequent legitimate instances join the first variant;
                    // repeated SOP UIDs remain individually selectable variants.
                    if (!study.seriesMap.has(baseKey)) study.seriesMap.set(baseKey, entry);
                    study.series.push(entry); series.set(entry.id, entry);
                }
                record.seriesId = entry.id;
                entry.records.push(record);
                if (validCatalogUid(metadata.sopUid)) entry.sopUids.add(metadata.sopUid);
                entry.instances.push({ id: record.id, sopUid: metadata.sopUid, sopClassUid: metadata.sopClassUid,
                    instanceNumber: metadata.instanceNumber, frameCount: metadata.frameCount, indexStatus: 'metadata-only', availability: 'unverified' });
                entry.instanceCount++; entry.frameCount += metadata.frameCount ?? 0; entry.warnings.push(...metadata.warnings);
                study.instanceCount++; study.frameCount += metadata.frameCount ?? 0; study.modalities.push(metadata.modality);
                if (validCatalogUid(metadata.studyUid)) {
                    const owners = studyOwners.get(metadata.studyUid) ?? new Set(); owners.add(group.id); studyOwners.set(metadata.studyUid, owners);
                }
                if (validCatalogUid(metadata.seriesUid)) {
                    const owners = seriesOwners.get(metadata.seriesUid) ?? new Set(); owners.add(studyKey); seriesOwners.set(metadata.seriesUid, owners);
                }
            }
        }
        for (const patient of patients.values()) {
            patient.warnings = unique(patient.warnings);
            for (const study of patient.studies) {
                if ((studyOwners.get(study.studyUid)?.size ?? 0) > 1) study.warnings.push('This Study UID is reused by separate patient records; the studies remain separate.');
                study.modalities = unique(study.modalities.filter(Boolean)); study.warnings = unique(study.warnings);
                study.series.sort(sortSeries); delete study.seriesMap; delete study.variantCounts;
                const modalitiesByUid = new Map();
                for (const entry of study.series) {
                    if (!validCatalogUid(entry.seriesUid)) continue;
                    const modalities = modalitiesByUid.get(entry.seriesUid) ?? new Set();
                    modalities.add(entry.modality); modalitiesByUid.set(entry.seriesUid, modalities);
                }
                for (const entry of study.series) {
                    if ((seriesOwners.get(entry.seriesUid)?.size ?? 0) > 1) entry.warnings.push('This Series UID is reused by separate study records; the series remain separate.');
                    if ((modalitiesByUid.get(entry.seriesUid)?.size ?? 0) > 1) entry.warnings.push('This Series UID has conflicting modalities; the modalities remain separately selectable.');
                    entry.warnings = unique(entry.warnings);
                    entry.revision = entry.instanceCount;
                    entry.workflow = aggregateWorkflow(entry.records.map(record => record.metadata.workflow));
                }
            }
            patient.studies.sort(sortStudies); delete patient.studyMap;
        }
        const publicPatients = [...patients.values()].map(patient => ({ ...patient, studies: patient.studies.map(study => ({ ...study,
            series: study.series.map(({ records: retained, sopUids, ...entry }) => entry) })) }));
        const counts = { patients: publicPatients.length, studies: publicPatients.reduce((n, patient) => n + patient.studies.length, 0),
            series: series.size, instances: records.length, frames: records.reduce((n, record) => n + (record.metadata.frameCount ?? 0), 0),
            batches: new Set(records.map(record => record.batchId)).size, metadataBytes: records.reduce((n, record) => n + record.bytes, 0) };
        return { groups, series, view: freezeTree({ patients: publicPatients, counts }) };
    }

    #install({ groups, series, view }) { this.#groups = groups; this.#series = series; this.#view = view; }

    getState() { return Object.freeze({ ...this.#view.counts }); }
    getView() { this.#check(); return this.#view; }
    getPatients({ query = '' } = {}) {
        this.#check();
        const needle = String(query).trim().slice(0, 512).toLocaleLowerCase();
        return this.#view.patients.filter(patient => !needle || [patient.patientName, patient.patientId, patient.issuerOfPatientId,
            patient.patientBirthDate, ...patient.studies.flatMap(study => [study.description, study.studyDate])]
            .some(value => value.toLocaleLowerCase().includes(needle)));
    }
    getPatient(id) { this.#check(); return this.#view.patients.find(patient => patient.id === id) ?? null; }
    getSeries(id) {
        this.#check();
        const entry = this.#series.get(id);
        if (!entry) return null;
        const { records, sopUids, ...metadata } = entry;
        return freezeTree(clone(metadata));
    }
    getSeriesFiles(id) {
        this.#check();
        const entry = this.#series.get(id);
        if (!entry) throw catalogError('series-not-found', 'Choose an indexed local series.');
        return entry.records.map(record => record.file);
    }

    /** Explicit session association; source identity and metadata are untouched. */
    confirmAssociation(fromPatientId, toPatientId, { confirmed = false } = {}) {
        this.#check();
        if (!confirmed) throw catalogError('confirmation-required', 'Confirm that these local records belong to the same patient.');
        if (this.#busy) throw catalogError('busy', 'Wait for local indexing to finish.');
        if (fromPatientId === toPatientId || !this.getPatient(fromPatientId) || !this.getPatient(toPatientId)) {
            throw catalogError('patient-not-found', 'Choose two different indexed local patients.');
        }
        const associations = new Map(this.#associations); associations.set(fromPatientId, toPatientId);
        const records = this.#records.map(record => ({ ...record }));
        const built = this.#build(records, associations);
        this.#associations = associations; this.#records = records; this.#install(built);
        return this.getPatient(toPatientId);
    }

    /** Closing a local patient releases all its original file references and
     * explicitly associated records. Other patient identifiers remain stable. */
    removePatient(patientId) {
        this.#check();
        if (this.#busy) throw catalogError('busy', 'Wait for local indexing to finish.');
        if (!this.getPatient(patientId)) return false;
        const removed = new Set(this.#records.filter(record => this.#resolve(record.patientGroupId, this.#associations) === patientId)
            .map(record => record.patientGroupId));
        const records = this.#records.filter(record => !removed.has(record.patientGroupId)).map(record => ({ ...record }));
        const associations = new Map([...this.#associations].filter(([from, to]) => !removed.has(from) && !removed.has(to)));
        const built = this.#build(records, associations);
        this.#records = records; this.#associations = associations;
        this.#files = new WeakMap(records.map(record => [record.file, record]));
        this.#install(built); return true;
    }

    clear() {
        this.#check(); this.#generation++; this.#activeAbort?.abort();
        this.#records = []; this.#files = new WeakMap(); this.#associations = new Map();
        this.#install(this.#build([], this.#associations));
    }
    dispose() { if (!this.#disposed) { this.clear(); this.#disposed = true; } }
}

export default LocalCatalog;
