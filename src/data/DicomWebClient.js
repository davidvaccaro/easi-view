import EASI, { Tag } from '@xinonix/easi-js';
import { abortError, checkAbort } from '../runtime/native-decoder.js';
import { beginMeasure } from '../runtime/performance.js';
import { readNativeFrame } from './bulk-frame.js';
import { registerAttributeMetadata } from './attributes.js';

export const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const METADATA_ACCEPT = 'application/dicom+json';
const INSTANCE_ACCEPT = 'multipart/related; type="application/dicom"; transfer-syntax=*, application/dicom; transfer-syntax=*';
const NATIVE_INSTANCE_ACCEPT = 'multipart/related; type="application/dicom"; transfer-syntax=1.2.840.10008.1.2.1, application/dicom; transfer-syntax=1.2.840.10008.1.2.1';
const VRS = new Set('AE AS AT CS DA DS DT FD FL IS LO LT OB OD OF OL OV OW PN SH SL SQ SS ST SV TM UC UI UL UN UR US UT UV'.split(' '));
const NUMERIC_VRS = new Set('DS FD FL IS SL SS SV UL US UV'.split(' '));
const FORBIDDEN_HEADERS = new Set(['accept', 'accept-charset', 'accept-encoding', 'access-control-request-headers',
    'access-control-request-method', 'connection', 'content-length', 'cookie', 'cookie2', 'date', 'dnt', 'expect',
    'host', 'keep-alive', 'origin', 'permissions-policy', 'referer', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'via']);
const STUDY_FIELDS = '00080020,00080050,00080061,00081030,00100010,00100020,00100021,00100030,0020000D,00201206,00201208';
const SERIES_FIELDS = '00080060,0008103E,0020000D,0020000E,00200011,00201209';
const METADATA_LIMIT_MESSAGE = 'The archive metadata exceeds the 8 MiB limit. Narrow the search or choose a smaller series.';
const INLINE_PIXELS_MESSAGE = 'The archive metadata included inline Pixel Data. Use a metadata endpoint without bulk pixels.';

function plainObject(value) {
    return value != null && typeof value === 'object' &&
        (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function optionsObject(value, keys, label) {
    if (!plainObject(value) || Object.keys(value).some(key => !keys.includes(key))) {
        throw new Error(`Use supported ${label} options in a plain object.`);
    }
}

export function validateDicomUid(value) {
    if (typeof value !== 'string' || value.length > 64 || !/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*$/.test(value)) {
        throw new Error('Use a valid numeric DICOM UID of at most 64 characters.');
    }
    return value;
}

function baseUrl(value) {
    let url;
    try { url = new URL(value); } catch { throw new Error('Use an absolute HTTP or HTTPS DICOMweb base URL.'); }
    if (typeof value !== 'string' || !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.search || url.hash || value.includes('?') || value.includes('#')) {
        throw new Error('Use an HTTP or HTTPS DICOMweb base URL without credentials, a query, or a fragment.');
    }
    return url.href.replace(/\/+$/, '');
}

function requestHeaders(value, accept) {
    if (!plainObject(value)) throw new Error('DICOMweb headers must be a plain object.');
    const headers = new Headers();
    for (const [name, content] of Object.entries(value)) {
        const lower = name.toLowerCase();
        if (FORBIDDEN_HEADERS.has(lower) || lower.startsWith('proxy-') || lower.startsWith('sec-') ||
            typeof content !== 'string' || /[\r\n]/.test(content)) {
            throw new Error('Use supported DICOMweb request headers with string values. Accept is managed by the viewer.');
        }
        try { headers.set(name, content); } catch { throw new Error('A DICOMweb request header is invalid.'); }
    }
    headers.set('Accept', accept);
    return headers;
}

/** Stop waiting immediately when the host cancels, even if its auth supplier is still pending. */
function abortable(operation, signal) {
    checkAbort(signal);
    if (!signal) return Promise.resolve(operation);
    return new Promise((resolve, reject) => {
        const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(abortError()); };
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(operation).then(value => {
            signal.removeEventListener('abort', onAbort);
            if (signal.aborted) reject(abortError()); else resolve(value);
        }, error => { signal.removeEventListener('abort', onAbort); reject(error); });
        if (signal.aborted) onAbort();
    });
}

function readOptions(options, paged = false, instance = false) {
    optionsObject(options, paged ? ['signal', 'offset', 'limit'] : instance ? ['signal', 'native'] : ['signal'], 'DICOMweb request');
    if (instance && Object.hasOwn(options, 'native') && typeof options.native !== 'boolean') {
        throw new Error('Use a boolean for native DICOM instance retrieval.');
    }
    if (options.signal != null && (typeof options.signal.addEventListener !== 'function' || typeof options.signal.aborted !== 'boolean')) {
        throw new Error('Use an AbortSignal for DICOMweb cancellation.');
    }
    if (paged && (!Number.isSafeInteger(options.offset) || options.offset < 0 ||
        !Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100)) {
        throw new Error('Use a nonnegative offset and a page limit from 1 to 100.');
    }
    checkAbort(options.signal);
    return options;
}

function schemaError() { return new Error('The archive returned invalid DICOM JSON metadata.'); }

/** Validate metadata shape separately from EASI's permissive adapter; never echo attribute values. */
function validateDataSet(set, depth = 0) {
    if (!plainObject(set) || depth > 32) throw schemaError();
    for (const [tag, attribute] of Object.entries(set)) {
        if (!/^[0-9A-F]{8}$/.test(tag) || !plainObject(attribute) || !VRS.has(attribute.vr) ||
            Object.keys(attribute).some(key => !['vr', 'Value', 'BulkDataURI', 'InlineBinary'].includes(key))) throw schemaError();
        if (['00080016', '00080018', '0020000D', '0020000E'].includes(tag) && attribute.vr !== 'UI') throw schemaError();
        const encodings = ['Value', 'BulkDataURI', 'InlineBinary'].filter(key => Object.hasOwn(attribute, key));
        if (encodings.length > 1) throw schemaError();
        if (['7FE00008', '7FE00009', '7FE00010'].includes(tag) && encodings[0] === 'InlineBinary') {
            throw new Error(INLINE_PIXELS_MESSAGE);
        }
        if (encodings[0] !== 'Value') {
            if (encodings.length && typeof attribute[encodings[0]] !== 'string') throw schemaError();
            continue;
        }
        if (!Array.isArray(attribute.Value)) throw schemaError();
        for (const item of attribute.Value) {
            if (item === null) continue; // DICOM JSON represents an empty value component as null.
            if (attribute.vr === 'SQ') { validateDataSet(item, depth + 1); continue; }
            if (attribute.vr === 'PN') {
                if (!plainObject(item) || Object.entries(item).some(([key, value]) =>
                    !['Alphabetic', 'Ideographic', 'Phonetic'].includes(key) || typeof value !== 'string')) throw schemaError();
            } else if (NUMERIC_VRS.has(attribute.vr)) {
                if (!((typeof item === 'number' && Number.isFinite(item)) || typeof item === 'string')) throw schemaError();
            } else if (typeof item !== 'string') throw schemaError();
        }
    }
}

/** Metadata alone is bounded and normalized before EASI; pixel responses remain streamed. */
async function readMetadata(stream, signal, statistics) {
    const reader = stream.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const text = [];
    let byteCount = 0;
    let exhausted = false;
    const onAbort = () => { void reader.cancel(abortError()).catch(() => {}); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        checkAbort(signal);
        while (true) {
            const chunk = await abortable(reader.read(), signal);
            checkAbort(signal);
            if (chunk.done) { exhausted = true; text.push(decoder.decode()); break; }
            if (!(chunk.value instanceof Uint8Array)) throw schemaError();
            byteCount += chunk.value.byteLength;
            statistics.bytes = byteCount;
            if (byteCount > MAX_METADATA_BYTES) throw new Error(METADATA_LIMIT_MESSAGE);
            text.push(decoder.decode(chunk.value, { stream: true }));
        }
        let json;
        try { json = JSON.parse(text.join('')); } catch { throw schemaError(); }
        text.length = 0;
        if (!Array.isArray(json) || json.length > 10000) throw schemaError();
        json.forEach(set => validateDataSet(set));
        return json;
    } finally {
        signal?.removeEventListener('abort', onAbort);
        if (!exhausted) { try { await reader.cancel(); } catch { /* Preserve the original failure. */ } }
        try { reader.releaseLock(); } catch { /* The canceled read finishes releasing its reader. */ }
    }
}

function orderedDataSet(set) {
    return Object.fromEntries(Object.entries(set).map(([tag, attribute]) => {
        // EASI 1.0.0 expects vr before Value. JSON object order has no meaning in DICOMweb.
        const ordered = { vr: attribute.vr };
        for (const key of ['Value', 'BulkDataURI', 'InlineBinary']) {
            if (!Object.hasOwn(attribute, key)) continue;
            ordered[key] = key === 'Value' && attribute.vr === 'SQ'
                ? attribute.Value.map(item => item === null ? null : orderedDataSet(item)) : attribute[key];
        }
        return [tag, ordered];
    }));
}

function metadataChunks(bytes, signal) {
    let offset = 0;
    return new ReadableStream({
        pull(controller) {
            if (signal?.aborted) { controller.error(abortError()); return; }
            if (offset === bytes.byteLength) { controller.close(); return; }
            const end = Math.min(offset + 64 * 1024, bytes.byteLength);
            controller.enqueue(bytes.subarray(offset, end));
            offset = end;
        }
    }, { highWaterMark: 0 });
}

function attribute(instance, tag) { return instance.dataSet?.find(Tag.find(tag)); }
function values(instance, tag) {
    const value = attribute(instance, tag)?.value;
    return value == null ? [] : Array.isArray(value) ? value : [value];
}
function scalar(instance, tag, fallback = '') {
    const raw = values(instance, tag);
    if (raw.length > 1) throw schemaError();
    return raw[0] ?? fallback;
}
function string(instance, tag) {
    const result = scalar(instance, tag);
    if (typeof result !== 'string') throw schemaError();
    return result;
}
function uid(instance, tag) {
    if (attribute(instance, tag)?.tag.VR.ID !== 'UI') throw schemaError();
    try { return validateDicomUid(string(instance, tag)); } catch { throw schemaError(); }
}
function integer(instance, tag, minimum) {
    const raw = scalar(instance, tag, null);
    if (raw === null || raw === '') return null;
    if (typeof raw === 'string' && !/^[+-]?\d+$/.test(raw.trim())) throw schemaError();
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < minimum) throw schemaError();
    return parsed;
}
function count(instance, tag) { return integer(instance, tag, 0); }
function patientName(instance) {
    const raw = scalar(instance, '00100010', null);
    // EASI represents a zero-length PN attribute as an empty scalar string.
    if (raw === null || raw === '') return '';
    if (!plainObject(raw)) throw schemaError();
    const name = raw.Alphabetic || raw.Ideographic || raw.Phonetic || '';
    if (typeof name !== 'string') throw schemaError();
    return name.split('^').filter(Boolean).join(' ');
}

function page(items, response, offset, limit) {
    // Do not expose a server-provided Warning string: it can include endpoints or patient values.
    const partial = /(?:^|,)\s*299(?:\s|$)/.test(response.headers.get('warning') ?? '');
    const hasMore = items.length >= limit || partial;
    return { items, hasMore, nextOffset: hasMore ? offset + (items.length || limit) : null,
        warnings: partial ? ['The archive limited these results. Continue paging or narrow the search.'] : [] };
}

async function measured(onMeasure, phase, signal, operation, details = {}) {
    let finish = () => {};
    try { finish = beginMeasure(onMeasure, phase, { signal }); }
    catch { /* Optional instrumentation cannot replace normal request validation. */ }
    let status = 'success';
    try { return await operation(); }
    catch (error) { status = error?.name === 'AbortError' ? 'canceled' : 'error'; throw error; }
    finally {
        try { finish(status, { source: 'archive', ...details }); }
        catch { /* Preserve the request result if an optional observation fails. */ }
    }
}

/** Explicit, in-memory QIDO/WADO client; the host owns credentials and archive selection. */
export class DicomWebClient {
    constructor(options, internalOptions = {}) {
        optionsObject(options, ['baseUrl', 'headers', 'credentials', 'retrievalMode'], 'DICOMweb connection');
        this.baseUrl = baseUrl(options.baseUrl);
        this.headers = options.headers ?? {};
        if (typeof this.headers !== 'function') requestHeaders(this.headers, METADATA_ACCEPT);
        this.credentials = options.credentials ?? 'omit';
        if (!['omit', 'same-origin', 'include'].includes(this.credentials)) throw new Error('Use omit, same-origin, or include for DICOMweb credentials.');
        this.retrievalMode = options.retrievalMode ?? 'instance';
        if (!['instance', 'frame'].includes(this.retrievalMode)) throw new Error('Choose instance or frame for DICOMweb retrievalMode.');
        // Internal observation is separate from the strict host archive configuration.
        this._onMeasure = typeof internalOptions?.onMeasure === 'function' ? internalOptions.onMeasure : null;
    }

    async request(path, { signal, accept = METADATA_ACCEPT, query } = {}) {
        checkAbort(signal);
        const url = new URL(`${this.baseUrl}/${path}`);
        if (query) url.search = query.toString();
        let supplied;
        try {
            supplied = typeof this.headers === 'function' ? await abortable(this.headers({ url: url.href, signal }), signal) : this.headers;
        } catch {
            checkAbort(signal);
            throw new Error('The host could not provide DICOMweb request headers.');
        }
        checkAbort(signal);
        const headers = requestHeaders(supplied, accept);
        let response;
        try {
            const pending = fetch(url, { method: 'GET', signal, headers, credentials: this.credentials, redirect: 'error' });
            // A custom fetch shim can ignore AbortSignal; do not retain its late response body.
            void pending.then(value => { if (signal?.aborted) void value.body?.cancel().catch(() => {}); }, () => {});
            response = await abortable(pending, signal);
        } catch {
            checkAbort(signal);
            throw new Error('The DICOMweb request failed. Check the endpoint, HTTPS, authentication, and browser CORS settings.');
        }
        if (signal?.aborted) { await response.body?.cancel().catch(() => {}); checkAbort(signal); }
        if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            throw Object.assign(new Error(`The DICOMweb archive returned HTTP ${response.status}.`), { status: response.status });
        }
        return response;
    }

    async metadata(path, options) {
        const response = await this.request(path, options);
        if (response.status === 204) { await response.body?.cancel().catch(() => {}); return { instances: [], response }; }
        const media = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
        if (!['application/dicom+json', 'application/json'].includes(media)) {
            await response.body?.cancel().catch(() => {});
            throw new Error('The archive must return application/dicom+json metadata.');
        }
        const declared = Number(response.headers.get('content-length'));
        if (declared > MAX_METADATA_BYTES) {
            await response.body?.cancel().catch(() => {});
            throw new Error(METADATA_LIMIT_MESSAGE);
        }
        if (!response.body) throw new Error('The archive returned no readable metadata body.');
        let source;
        try {
            const readDetails = { bytes: 0 };
            // This interval includes UTF-8 decoding, JSON syntax and schema validation.
            // Count consumed fetch-body bytes, which may already be decompressed by fetch.
            const json = await measured(this._onMeasure, 'metadata-read', options.signal,
                () => readMetadata(response.body, options.signal, readDetails), readDetails);
            checkAbort(options.signal);
            const parseDetails = { bytes: 0 };
            // Bounded canonicalization/encoding and EASI parsing occur after the read interval.
            const instances = await measured(this._onMeasure, 'metadata-parse', options.signal, async () => {
                const normalized = new TextEncoder().encode(JSON.stringify(json.map(orderedDataSet)));
                parseDetails.bytes = normalized.byteLength;
                if (normalized.byteLength > MAX_METADATA_BYTES) throw new Error(METADATA_LIMIT_MESSAGE);
                source = metadataChunks(normalized, options.signal);
                const result = await EASI.pipelineBuilder().fromPartStream().ofDicomMetadata().toInstances().build()
                    .process({ source, sourceOptions: { contentType: 'application/dicom+json' } });
                checkAbort(options.signal);
                const output = result.toArray();
                if (json.length !== output.length) throw schemaError();
                output.forEach((instance, index) => registerAttributeMetadata(instance, json[index]));
                return output;
            }, parseDetails);
            return { instances, response };
        } catch (error) {
            if (source && !source.locked) { try { await source.cancel(); } catch {} }
            checkAbort(options.signal);
            if (error?.message === METADATA_LIMIT_MESSAGE || error?.message === INLINE_PIXELS_MESSAGE) throw error;
            throw schemaError();
        }
    }

    async searchStudies(filters = {}, options = {}) {
        return measured(this._onMeasure, 'study-query', options?.signal, async () => {
            optionsObject(filters, ['patientId', 'patientName', 'patientBirthDate', 'birthDate', 'issuerOfPatientId', 'studyDate', 'accessionNumber', 'modality', 'studyUid'], 'study search');
            if (filters.birthDate != null && filters.patientBirthDate != null && filters.birthDate !== filters.patientBirthDate) {
                throw new Error('Use one patient birth date for study search.');
            }
            optionsObject(options, ['signal', 'offset', 'limit'], 'DICOMweb request');
            const settings = readOptions({ offset: 0, limit: 25, ...options }, true);
            const query = new URLSearchParams({ offset: String(settings.offset), limit: String(settings.limit), includefield: STUDY_FIELDS });
            const names = { patientId: 'PatientID', patientName: 'PatientName', patientBirthDate: 'PatientBirthDate', birthDate: 'PatientBirthDate',
                issuerOfPatientId: 'IssuerOfPatientID', studyDate: 'StudyDate',
                accessionNumber: 'AccessionNumber', modality: 'ModalitiesInStudy', studyUid: 'StudyInstanceUID' };
            for (const [key, value] of Object.entries(filters)) {
                if (typeof value !== 'string' || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Use short text values for study search filters.');
                if (value.trim() === '') continue;
                if (key === 'studyUid') validateDicomUid(value);
                query.set(names[key], value);
            }
            const { instances, response } = await this.metadata('studies', { signal: settings.signal, query });
            const items = instances.map(instance => {
                const modalities = values(instance, '00080061').filter(value => value != null && value !== '');
                if (!modalities.every(value => typeof value === 'string')) throw schemaError();
                const optionalIdentity = {};
                // Preserve the original public result shape for archives omitting these fields.
                // Patient-first source adapters request them and never infer missing identifiers.
                if (attribute(instance, '00100021')) optionalIdentity.issuerOfPatientId = string(instance, '00100021');
                if (attribute(instance, '00100030')) optionalIdentity.patientBirthDate = string(instance, '00100030');
                return { studyUid: uid(instance, '0020000D'), patientName: patientName(instance),
                    patientId: string(instance, '00100020'), studyDate: string(instance, '00080020'),
                    description: string(instance, '00081030'), accessionNumber: string(instance, '00080050'),
                    modalities, seriesCount: count(instance, '00201206'), instanceCount: count(instance, '00201208'), ...optionalIdentity };
            });
            return page(items, response, settings.offset, settings.limit);
        });
    }

    async listSeries(studyUid, options = {}) {
        return measured(this._onMeasure, 'series-query', options?.signal, async () => {
            validateDicomUid(studyUid);
            optionsObject(options, ['signal', 'offset', 'limit'], 'DICOMweb request');
            const settings = readOptions({ offset: 0, limit: 50, ...options }, true);
            const query = new URLSearchParams({ offset: String(settings.offset), limit: String(settings.limit), includefield: SERIES_FIELDS });
            const { instances, response } = await this.metadata(`studies/${studyUid}/series`, { signal: settings.signal, query });
            const items = instances.map(instance => {
                const parent = attribute(instance, '0020000D') ? uid(instance, '0020000D') : studyUid;
                if (parent !== studyUid) throw new Error('The archive returned series metadata for a different study.');
                return { studyUid, seriesUid: uid(instance, '0020000E'), modality: string(instance, '00080060'),
                    description: string(instance, '0008103E'), seriesNumber: integer(instance, '00200011', -Number.MAX_SAFE_INTEGER),
                    instanceCount: count(instance, '00201209') };
            });
            return page(items, response, settings.offset, settings.limit);
        });
    }

    async getSeriesMetadata(studyUid, seriesUid, options = {}) {
        return measured(this._onMeasure, 'series-metadata', options?.signal, async () => {
            validateDicomUid(studyUid);
            validateDicomUid(seriesUid);
            const settings = readOptions(options);
            const { instances } = await this.metadata(`studies/${studyUid}/series/${seriesUid}/metadata`, { signal: settings.signal });
            const seen = new Set();
            for (const instance of instances) {
                if (uid(instance, '0020000D') !== studyUid || uid(instance, '0020000E') !== seriesUid) {
                    throw new Error('The archive returned instance metadata for a different study or series.');
                }
                const sop = uid(instance, '00080018');
                if (seen.has(sop)) throw new Error('The archive returned duplicate SOP Instance UIDs.');
                seen.add(sop);
            }
            return instances;
        });
    }

    async retrieveInstance(studyUid, seriesUid, sopUid, options = {}) {
        return measured(this._onMeasure, 'instance-headers', options?.signal, async () => {
            [studyUid, seriesUid, sopUid].forEach(validateDicomUid);
            const settings = readOptions(options, false, true);
            const response = await this.request(`studies/${studyUid}/series/${seriesUid}/instances/${sopUid}`,
                { signal: settings.signal, accept: settings.native === true ? NATIVE_INSTANCE_ACCEPT : INSTANCE_ACCEPT });
            const contentType = response.headers.get('content-type') ?? '';
            const media = contentType.split(';')[0].trim().toLowerCase();
            const multipartDicom = media === 'multipart/related' &&
                /;\s*type\s*=\s*(?:"application\/dicom"|application\/dicom)(?:\s*;|$)/i.test(contentType) &&
                /;\s*boundary\s*=\s*(?:"[^"]+"|[^;\s]+)(?:\s*;|$)/i.test(contentType);
            if (!response.body || !(media === 'application/dicom' || multipartDicom)) {
                await response.body?.cancel().catch(() => {});
                throw new Error('The archive must return a readable application/dicom or multipart/related DICOM instance.');
            }
            return response; // This measurement ends before the source session streams or decodes pixels.
        });
    }

    async retrieveNativeFrame(studyUid, seriesUid, sopUid, frameNumber, expectedBytes, options = {}) {
        return measured(this._onMeasure, 'frame-retrieve', options?.signal, async () => {
            [studyUid, seriesUid, sopUid].forEach(validateDicomUid);
            const settings = readOptions(options);
            if (!Number.isInteger(frameNumber) || frameNumber < 1 || frameNumber > 4096) {
                throw new Error('Use a one-based original DICOM frame number from 1 to 4096.');
            }
            const path = `studies/${studyUid}/series/${seriesUid}/instances/${sopUid}/frames/${frameNumber}`;
            const response = await this.request(path, { signal: settings.signal,
                accept: 'multipart/related; type="application/octet-stream"; transfer-syntax=1.2.840.10008.1.2.1' });
            return readNativeFrame(response, { signal: settings.signal, expectedBytes,
                expectedUrl: `${this.baseUrl}/${path}` });
        });
    }
}

export default DicomWebClient;
