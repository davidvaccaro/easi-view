import { DicomWebClient, validateDicomUid } from '../data/DicomWebClient.js';
import { DimseGatewayClient } from '../data/DimseGatewayClient.js';
import { checkAbort } from '../runtime/native-decoder.js';

export const SOURCE_SEARCH_FIELDS = Object.freeze(['patientId', 'patientName', 'patientBirthDate', 'issuerOfPatientId',
    'accessionNumber', 'studyDate', 'modality']);
export const DEFAULT_SOURCE_SEARCH_FIELDS = Object.freeze(['patientId', 'patientName', 'accessionNumber', 'studyDate', 'modality']);
const MAX_SOURCES = 32;
export const MAX_SOURCE_HISTORY_BYTES = 64 * 1024 * 1024;
export const MAX_SOURCE_HISTORY_STUDIES = 30000;
const HISTORY_LIMIT_MESSAGE = 'The repository search history reached its session limit. Start a new viewer session to clear it.';
const encoder = new TextEncoder();
const IDENTITY_WARNING = 'Patient identity is scoped to this repository. Records from other repositories are not automatically combined.';
const LIMITED_IDENTITY_WARNING = 'An exact patient identifier is unavailable. Only studies discovered for this candidate can be selected.';
const CONFLICT_WARNING = 'Patient identifiers match but demographics conflict. These candidates remain separate.';

function plain(value) {
    return value != null && typeof value === 'object' &&
        (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function dataProperties(value, keys) {
    return plain(value) && Reflect.ownKeys(value).every(key => typeof key === 'string' && (!keys || keys.includes(key)) &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}
function text(value, maximum = 256) {
    return typeof value === 'string' && value.length <= maximum && !/[\x00-\x1f\x7f]/u.test(value);
}
function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
}
function exact(value) { return text(value) && !!value.trim() && !/[*?\\]/u.test(value); }
function identity(study) {
    return { patientId: study.patientId || '', patientName: study.patientName || '',
        issuerOfPatientId: study.issuerOfPatientId || '', patientBirthDate: study.patientBirthDate || study.birthDate || '' };
}
function copyStudy(study) { return { ...study, modalities: [...(study.modalities ?? [])] }; }
function signature(study) {
    const value = identity(study);
    return JSON.stringify([value.patientId, value.issuerOfPatientId, value.patientName, value.patientBirthDate,
        exact(value.patientId) ? '' : study.studyUid]);
}
function samePatient(actual, expected) {
    const value = identity(actual);
    return value.patientId === expected.patientId && value.issuerOfPatientId === expected.issuerOfPatientId &&
        ['patientName', 'patientBirthDate'].every(key => !expected[key] || expected[key] === value[key]);
}

/** Configured source names are public; URLs, auth suppliers and header values remain private.
 * Registration performs validation only. It neither searches nor connects to a repository.
 * Every source owns an independent stable client and candidate namespace. */
export class SourceRegistry {
    #entries = new Map();
    #candidates = new Map();
    #sequence = 0;
    #internal;
    #disposed = false;
    #lifetime = new AbortController();
    #historyBytes = 0;
    #historyStudies = 0;
    #historyLimits;

    constructor(sources = [], internalOptions = {}) {
        if (!Array.isArray(sources) || sources.length > MAX_SOURCES) throw new TypeError('Configure at most 32 remote sources.');
        this.#internal = internalOptions;
        this.#historyLimits = internalOptions?.historyLimits ?? { bytes: MAX_SOURCE_HISTORY_BYTES, studies: MAX_SOURCE_HISTORY_STUDIES };
        if (!dataProperties(this.#historyLimits, ['bytes', 'studies']) || !Number.isSafeInteger(this.#historyLimits.bytes) ||
            this.#historyLimits.bytes < 1 || this.#historyLimits.bytes > MAX_SOURCE_HISTORY_BYTES ||
            !Number.isSafeInteger(this.#historyLimits.studies) || this.#historyLimits.studies < 1 || this.#historyLimits.studies > MAX_SOURCE_HISTORY_STUDIES) {
            throw new TypeError('Use bounded internal repository search-history limits.');
        }
        this.#historyLimits = { ...this.#historyLimits };
        for (const source of sources) this.add(source);
    }

    #check() { if (this.#disposed) throw new Error('The source registry has been disposed.'); }

    /** Host-only source registration; no connection or patient request is made. */
    add(source) {
        this.#check();
        if (this.#entries.size >= MAX_SOURCES || !dataProperties(source,
            ['id', 'name', 'type', 'baseUrl', 'headers', 'credentials', 'retrievalMode', 'searchFields']) ||
            typeof source.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u.test(source.id) ||
            !text(source.name, 100) || !source.name.trim() || !['dicomweb', 'dimse'].includes(source.type)) {
            throw new TypeError('Configure a source with a unique ID, a short display name, a supported type, and an HTTP gateway URL.');
        }
        if (this.#entries.has(source.id)) throw new TypeError('Remote source IDs must be unique.');
        const searchFields = source.searchFields ?? DEFAULT_SOURCE_SEARCH_FIELDS;
        if (!Array.isArray(searchFields) || !searchFields.length || searchFields.some(key => !SOURCE_SEARCH_FIELDS.includes(key)) ||
            new Set(searchFields).size !== searchFields.length || !searchFields.includes('patientId')) {
            throw new TypeError('Use supported source search fields, including patientId, without duplicates.');
        }
        const options = { baseUrl: source.baseUrl };
        if (source.headers != null && typeof source.headers !== 'function' && !dataProperties(source.headers)) {
            throw new TypeError('Use plain request header values or a host header supplier.');
        }
        for (const key of ['headers', 'credentials', 'retrievalMode']) if (source[key] !== undefined) {
            options[key] = key === 'headers' && plain(source[key]) ? Object.freeze({ ...source[key] }) : source[key];
        }
        const Client = source.type === 'dimse' ? DimseGatewayClient : DicomWebClient;
        // Constructors validate without invoking fetch or an auth callback.
        new Client(options);
        const descriptor = freeze({ id: source.id, name: source.name.trim(), type: source.type,
            capabilities: { searchFields: [...searchFields], patientSearch: true, studySelection: true,
                retrievalMode: options.retrievalMode ?? 'instance', requiresGateway: source.type === 'dimse' } });
        this.#entries.set(source.id, { descriptor, options, Client, client: null, patients: new Map(), signatures: new Map() });
        return descriptor;
    }

    list() { this.#check(); return [...this.#entries.values()].map(entry => entry.descriptor); }

    register(source) { return this.add(source); }

    getState() {
        return Object.freeze({ sources: this.#entries.size, clients: [...this.#entries.values()].filter(entry => entry.client).length,
            patientCandidates: this.#candidates.size, disposed: this.#disposed });
    }

    #entry(id) {
        this.#check();
        const entry = this.#entries.get(id);
        if (!entry) throw new Error('Choose a configured remote source.');
        return entry;
    }

    getSource(id) { return this.#entry(id).descriptor; }

    getClient(id) {
        const entry = this.#entry(id);
        return entry.client ??= new entry.Client(entry.options, this.#internal);
    }

    #filters(entry, filters) {
        if (!dataProperties(filters, entry.descriptor.capabilities.searchFields)) {
            throw new Error('This repository does not support one or more selected patient search fields.');
        }
        if (Object.values(filters).some(value => !text(value))) throw new Error('Use short text values for patient search.');
        if (!Object.entries(filters).some(([key, value]) => key !== 'issuerOfPatientId' && value.replace(/[*?\s\\-]/gu, '').length)) {
            throw new Error('Enter patient criteria before searching this repository.');
        }
        // Patient discovery accepts an ordinary family-name prefix. Keep
        // explicit DICOM matching expressions intact; selected-patient queries
        // below still use exact identifiers and verify returned demographics.
        const name = filters.patientName?.trim();
        return name && name.length < 256 && !/[*?^=\\]/u.test(name)
            ? { ...filters, patientName: `${name}*` } : filters;
    }

    #options(options) {
        if (!dataProperties(options, ['signal', 'offset', 'limit']) ||
            options.signal != null && (typeof options.signal.addEventListener !== 'function' || typeof options.signal.aborted !== 'boolean')) {
            throw new Error('Use supported paging options and an AbortSignal for patient requests.');
        }
        checkAbort(options.signal);
        return { ...options, signal: options.signal ? AbortSignal.any([options.signal, this.#lifetime.signal]) : this.#lifetime.signal };
    }

    #rememberStudy(record, study) {
        const saved = copyStudy(study), bytes = encoder.encode(JSON.stringify(saved)).byteLength;
        const previous = record.studyBytes.get(study.studyUid) ?? 0;
        if (this.#historyBytes - previous + bytes > this.#historyLimits.bytes ||
            !previous && this.#historyStudies >= this.#historyLimits.studies) throw new Error(HISTORY_LIMIT_MESSAGE);
        this.#historyBytes += bytes - previous;
        if (!previous) ++this.#historyStudies;
        record.studyBytes.set(study.studyUid, bytes); record.studies.set(study.studyUid, saved);
    }

    async searchPatients(sourceId, filters, options = {}) {
        const entry = this.#entry(sourceId);
        const supported = this.#filters(entry, filters);
        options = this.#options(options);
        const result = await this.getClient(sourceId).searchStudies(supported, options);
        checkAbort(options.signal);
        const patients = new Map();
        for (const study of result.items) {
            const key = signature(study);
            let record = entry.signatures.get(key);
            if (!record) {
                const bytes = encoder.encode(key).byteLength;
                if (this.#candidates.size >= 10000 || this.#historyBytes + bytes > this.#historyLimits.bytes) throw new Error(HISTORY_LIMIT_MESSAGE);
                record = { id: `remote-patient-${++this.#sequence}`, sourceId, ...identity(study), studies: new Map(), studyBytes: new Map() };
                this.#historyBytes += bytes;
                entry.signatures.set(key, record); entry.patients.set(record.id, record); this.#candidates.set(record.id, record);
            }
            this.#rememberStudy(record, study); patients.set(record.id, record);
        }
        const items = [...patients.values()].map(record => {
            const conflict = [...entry.patients.values()].some(other => other.id !== record.id && record.patientId &&
                other.patientId === record.patientId && other.issuerOfPatientId === record.issuerOfPatientId &&
                ['patientName', 'patientBirthDate'].some(key => other[key] && record[key] && other[key] !== record[key]));
            const restricted = !exact(record.patientId);
            return freeze({ id: record.id, sourceId, patientId: record.patientId, patientName: record.patientName,
                issuerOfPatientId: record.issuerOfPatientId, patientBirthDate: record.patientBirthDate, birthDate: record.patientBirthDate,
                identityStatus: restricted ? 'study-scoped' : conflict ? 'demographics-conflict' : 'source-qualified',
                studies: [...record.studies.values()].map(copyStudy),
                warnings: [IDENTITY_WARNING, ...(restricted ? [LIMITED_IDENTITY_WARNING] : []), ...(conflict ? [CONFLICT_WARNING] : [])] });
        });
        return { ...result, items };
    }

    /** Start a fresh exact patient study query; initial modality/date/accession filters never follow the selection. */
    async listPatientStudies(sourceId, patient, options = {}) {
        const entry = this.#entry(sourceId);
        const record = entry.patients.get(typeof patient === 'string' ? patient : patient?.id);
        if (!record) throw new Error('Choose a patient returned by this repository search.');
        options = this.#options(options);
        checkAbort(options.signal);
        if (!exact(record.patientId)) {
            // A missing or wildcard-containing ID cannot safely select every study of a person.
            // Return only the study-scoped evidence already obtained, without another broad query.
            const offset = options.offset ?? 0, limit = options.limit ?? 25;
            if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
                Object.keys(options).some(key => !['signal', 'offset', 'limit'].includes(key))) throw new Error('Use bounded patient study paging options.');
            const studies = [...record.studies.values()];
            const hasMore = offset + limit < studies.length;
            return { items: studies.slice(offset, offset + limit).map(copyStudy), hasMore,
                nextOffset: hasMore ? offset + limit : null, warnings: [LIMITED_IDENTITY_WARNING] };
        }
        const filters = { patientId: record.patientId };
        // Verify the returned issuer below even when optional issuer matching is unsupported.
        if (record.issuerOfPatientId && entry.descriptor.capabilities.searchFields.includes('issuerOfPatientId')) {
            filters.issuerOfPatientId = record.issuerOfPatientId;
        }
        const result = await this.getClient(sourceId).searchStudies(filters, options);
        checkAbort(options.signal);
        const matched = result.items.filter(study => samePatient(study, record));
        const excluded = matched.length !== result.items.length;
        // Excluding an identity mismatch must not hide pagination of the raw server result page.
        for (const study of matched) this.#rememberStudy(record, study);
        return { ...result, items: matched, warnings: [...result.warnings, ...(excluded ?
            ['Some returned studies had a different or unverified patient identity and were excluded.'] : [])] };
    }

    /** Close a reading session without losing configured repositories or auth suppliers. */
    clearSearchHistory() {
        this.#check(); this.#lifetime.abort(); this.#lifetime = new AbortController();
        this.#candidates.clear(); this.#historyBytes = 0; this.#historyStudies = 0;
        for (const entry of this.#entries.values()) { entry.patients.clear(); entry.signatures.clear(); }
    }

    dispose() {
        this.#lifetime.abort();
        this.#entries.clear(); this.#candidates.clear(); this.#historyBytes = 0; this.#historyStudies = 0; this.#disposed = true;
    }
}

export default SourceRegistry;
