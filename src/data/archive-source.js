import { defaultWindow, nativeFrameByteLength } from './native.js';
import { loadResponse, normalizeInstance, sortFrames, recordFrameGroups } from './sources.js';
import { validateClassicDimensions } from './classic-dimensions.js';
import { FrameCache } from '../runtime/frame-cache.js';
import { NativeDecoder, abortError, checkAbort } from '../runtime/native-decoder.js';
import { beginMeasure } from '../runtime/performance.js';
import { encodedFrame } from './compressed.js';
import { PIXEL_ENCODING_ERROR_CODE } from './encapsulated.js';
import { EncodedInstanceCache, releaseEncoded } from '../runtime/encoded-cache.js';
import { createAttributeSnapshot, limitAttributeSnapshot, MAX_ATTRIBUTE_BYTES, MAX_SESSION_ATTRIBUTE_BYTES } from './attributes.js';
import { Tag } from '@xinonix/easi-js';
export { EncodedInstanceCache } from '../runtime/encoded-cache.js';

export const ARCHIVE_DECODED_CACHE_BYTES = 64 * 1024 * 1024;
export const ARCHIVE_ENCODED_CACHE_BYTES = 64 * 1024 * 1024;
export const MAX_ARCHIVE_FRAMES = 10000;

const PATIENT_FIELDS = Object.freeze({ patientId: '00100020', issuerOfPatientId: '00100021', patientName: '00100010', patientBirthDate: '00100030' });
const IDENTITY_LIMIT = 4096;
const identityError = () => new Error('The archive image patient identity does not match the selected patient.');

function normalizedIdentityText(value, personName = false) {
    if (typeof value !== 'string' || value.length > IDENTITY_LIMIT || /[\u0000-\u001f\u007f]/u.test(value)) throw identityError();
    let result = value.trim().normalize('NFC');
    if (personName) result = (result.split('=').find(component => component.trim()) ?? '').replaceAll('^', ' ').replace(/\s+/gu, ' ').trim();
    return result;
}

export function expectedIdentity(value) {
    if (value === undefined) return null;
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
        Reflect.ownKeys(value).some(field => !Object.hasOwn(PATIENT_FIELDS, field))) {
        throw new TypeError('Use only patientId, issuerOfPatientId, patientName and patientBirthDate for archive identity verification.');
    }
    return Object.freeze(Object.fromEntries(Object.keys(PATIENT_FIELDS).map(field => [field, normalizedIdentityText(value[field] ?? '', field === 'patientName')])));
}

function identityAttribute(instance, id, personName = false) {
    const attribute = instance?.dataSet?.find(Tag.find(id));
    if (!attribute) return '';
    // The EASI JSON adapter retains Value overrides; native DA.value parses a
    // date, so read bounded original text rather than coercing a parsed object.
    let raw = Object.getOwnPropertyDescriptor(attribute, '_value')?.value;
    if (raw !== undefined && raw !== null) {
        if (Array.isArray(raw)) { if (raw.length > 1) throw identityError(); raw = raw[0] ?? ''; }
        if (personName && raw && typeof raw === 'object') {
            if (Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw identityError();
            raw = raw.Alphabetic || raw.Ideographic || raw.Phonetic || '';
        }
        return normalizedIdentityText(raw, personName);
    }
    if (!(attribute.data instanceof Uint8Array) || attribute.data.byteLength > IDENTITY_LIMIT) throw identityError();
    let encoding = 'utf-8';
    if (['00100010', '00100020', '00100021'].includes(id)) {
        const charsetAttribute = instance.dataSet.find(Tag.find('00080005'));
        const charsetRaw = Object.getOwnPropertyDescriptor(charsetAttribute ?? {}, '_value')?.value;
        let charset;
        if (charsetRaw != null) {
            const scalar = Array.isArray(charsetRaw) && charsetRaw.length <= 1 ? charsetRaw[0] ?? '' : charsetRaw;
            if (typeof scalar !== 'string' || scalar.length > 128) throw identityError(); charset = scalar.trim();
        } else {
            if (charsetAttribute?.data?.byteLength > 128) throw identityError();
            charset = charsetAttribute?.data instanceof Uint8Array ? new TextDecoder().decode(charsetAttribute.data).replace(/\0+$/gu, '').trim() : '';
        }
        if (charset === 'ISO_IR 100') encoding = 'iso-8859-1';
        else if (charset && !['ISO_IR 6', 'ISO_IR 192'].includes(charset)) throw identityError();
    }
    try { return normalizedIdentityText(new TextDecoder(encoding, { fatal: true }).decode(attribute.data).replace(/\0+$/gu, ''), personName); }
    catch { throw identityError(); }
}

export function instanceIdentity(instance) {
    return Object.freeze(Object.fromEntries(Object.entries(PATIENT_FIELDS).map(([field, id]) => [field, identityAttribute(instance, id, field === 'patientName')])));
}

export function verifyPatient(actual, expected) {
    for (const field of Object.keys(PATIENT_FIELDS)) if (expected[field] && actual[field] !== expected[field]) throw identityError();
}

function sameGeometry(first, second) {
    if (first == null || second == null) return first === second;
    return first.length === second.length && first.every((value, index) => Math.abs(value - second[index]) <= 0.000001);
}

function validatePresentation(actual, expected) {
    for (const property of ['modalityLut', 'voiLut', 'palette']) {
        const first = actual[property], second = expected[property];
        if (first == null || second == null) {
            if (first !== second) throw new Error('The retrieved DICOM presentation tables do not match its archive metadata.');
            continue;
        }
        if (['count', 'firstMapped', 'bits'].some(key => first[key] !== second[key]) || first.pending) {
            throw new Error('The retrieved DICOM presentation table descriptor does not match its archive metadata.');
        }
        for (const key of property === 'palette' ? ['red', 'green', 'blue'] : ['entries']) {
            // An explicit metadata BulkDataURI is pending, never an identity
            // transform. Actual pixels must supply the complete matching table.
            if (second[key] == null && second.pending) continue;
            if (!(first[key] instanceof Uint16Array) || !(second[key] instanceof Uint16Array) ||
                first[key].length !== second[key].length || first[key].some((value, index) => value !== second[key][index])) {
                throw new Error('The retrieved DICOM presentation table entries do not match its archive metadata.');
            }
        }
    }
    if (actual.presentationInvert !== expected.presentationInvert) throw new Error('The retrieved DICOM presentation polarity does not match its archive metadata.');
}

function validateRetrieved(actual, expected) {
    for (const property of ['studyUid', 'seriesUid', 'uid', 'sopClass', 'frameCount']) {
        if (actual[property] !== expected[property]) throw new Error('The retrieved DICOM instance identity or frame count does not match its archive metadata.');
    }
    for (const property of ['rows', 'columns', 'bitsAllocated', 'bitsStored', 'highBit', 'signed', 'photometric', 'samplesPerPixel', 'frameOfReferenceUid']) {
        if (actual.common[property] !== expected.common[property]) throw new Error('The retrieved DICOM pixel dimensions or format do not match its archive metadata.');
    }
    for (const property of ['pixelSpacing', 'pixelAspectRatio', 'orientation', 'position']) {
        if (!sameGeometry(actual.common[property], expected.common[property])) throw new Error('The retrieved DICOM image geometry does not match its archive metadata.');
    }
    validatePresentation(actual.common, expected.common);
    validateClassicDimensions(actual.common.classicDimensions, expected.common.classicDimensions);
    if (expected.frameTiming?.some(frame => frame.timingMode !== 'none') && JSON.stringify(actual.frameTiming) !== JSON.stringify(expected.frameTiming)) {
        throw new Error('The retrieved DICOM frame timing does not match its archive metadata.');
    }
    if (Boolean(actual.enhancedFrames) !== Boolean(expected.enhancedFrames)) throw new Error('The retrieved DICOM functional groups do not match its archive metadata.');
    if (actual.enhancedFrames) for (let index = 0; index < actual.frameCount; index++) {
        const first = actual.enhancedFrames[index], second = expected.enhancedFrames[index];
        if (first.frameIndex !== second.frameIndex || JSON.stringify(first.dimensions) !== JSON.stringify(second.dimensions)) {
            throw new Error('The retrieved DICOM frame dimensions do not match its archive metadata.');
        }
        for (const property of ['pixelSpacing', 'orientation', 'position']) if (!sameGeometry(first.overrides[property], second.overrides[property])) {
            throw new Error('The retrieved DICOM per-frame geometry does not match its archive metadata.');
        }
        for (const property of ['slope', 'intercept', 'unit', 'frameTime', 'voiFunction', 'sliceThickness', 'spacingBetweenSlices']) {
            if (first.overrides[property] !== second.overrides[property]) throw new Error('The retrieved DICOM per-frame transforms do not match its archive metadata.');
        }
        if (JSON.stringify(first.overrides.windowAlternatives ?? []) !== JSON.stringify(second.overrides.windowAlternatives ?? [])) {
            throw new Error('The retrieved DICOM per-frame VOI does not match its archive metadata.');
        }
        validatePresentation(first.overrides, second.overrides);
    }
}

class ArchiveSession {
    constructor(client, options) {
        this.client = client;
        this.onProgress = options.onProgress;
        this.onMeasure = options.onMeasure;
        this.measure = typeof this.onMeasure === 'function' ? event => this.onMeasure?.({ ...event, source: 'archive' }) : undefined;
        this.cache = new FrameCache(ARCHIVE_DECODED_CACHE_BYTES);
        this.encoded = new EncodedInstanceCache();
        this.decoder = new NativeDecoder();
        this.series = new Set();
        this.keyOwners = new Map();
        this.metadataRecords = new Map();
        this.attributeBytes = 0;
        this.active = null;
        this.disposed = false;
    }

    report(phase, message, details = {}) {
        this.onProgress?.({ phase, message, loaded: 0, total: null, instances: 0,
            frames: [...this.series].reduce((sum, stack) => sum + stack.frames.length, 0), ...details });
    }

    measureDetails() {
        return { source: 'archive', encodedCacheBytes: this.encoded.bytes, decodedCacheBytes: this.cache.bytes };
    }

    adoptAttributes(expected, snapshot) {
        const previous = expected.attributes?.bytes ?? 0;
        const admitted = limitAttributeSnapshot(snapshot, Math.min(MAX_ATTRIBUTE_BYTES, MAX_SESSION_ATTRIBUTE_BYTES - this.attributeBytes + previous));
        this.attributeBytes += (admitted?.bytes ?? 0) - previous;
        expected.attributes = admitted;
    }

    begin(series, signal) {
        checkAbort(signal);
        this.active?.controller.abort();
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        const operation = { series, controller, finish: () => {
            signal?.removeEventListener('abort', abort);
            if (this.active === operation) this.active = null;
        } };
        this.active = operation;
        return operation;
    }

    async retrieve(expected, signal, onMeasure) {
        const key = `${expected.studyUid}/${expected.seriesUid}/${expected.uid}`;
        const cached = this.encoded.get(key);
        if (cached) return { record: cached, encodedCacheHit: true };
        this.report('reading', 'Retrieving the requested DICOM instance');
        // Retry only a classified original pixel encoding/index failure. The
        // complete instance identity and geometry are checked before indexing.
        for (let attempt = 0; attempt < 2; attempt++) {
            checkAbort(signal);
            let response, sources, instances = 0;
            try {
                response = await this.client.retrieveInstance(expected.studyUid, expected.seriesUid, expected.uid,
                    { signal, ...(attempt === 1 ? { native: true } : {}) });
                sources = await loadResponse(response, { signal,
                    onInstance: instance => {
                        if (++instances > 1) throw new Error('RetrieveInstance must return exactly one DICOM image instance.');
                        if (expected._patientIdentity) verifyPatient(instanceIdentity(instance), expected._patientIdentity);
                        validateRetrieved(normalizeInstance(instance, { metadataOnly: true }), expected);
                    },
                    onMeasure: typeof onMeasure === 'function' ? event => onMeasure({ ...event, ...this.measureDetails() }) : undefined,
                    onProgress: progress => {
                        if (progress.instances > 1) throw new Error('RetrieveInstance must return exactly one DICOM image instance.');
                        this.onProgress?.(progress);
                    } });
                checkAbort(signal);
                const records = [...new Set(sources.flatMap(stack => [...stack._records.values()]))];
                if (records.length !== 1) throw new Error('RetrieveInstance must return exactly one DICOM image instance.');
                validateRetrieved(records[0], expected);
                const owned = { ...records[0] };
                this.adoptAttributes(expected, owned.attributes);
                owned.attributes = null;
                // Transfer one shared index before temporary groups release it.
                records[0].encapsulated = null;
                this.encoded.set(key, owned);
                return { record: owned, encodedCacheHit: false, ephemeral: !this.encoded.entries.has(key) };
            } catch (error) {
                checkAbort(signal);
                if (attempt !== 0 || error?.code !== PIXEL_ENCODING_ERROR_CODE || this.disposed) throw error;
                this.report('reading', 'Original pixel encoding requires native DICOM retrieval');
            } finally {
                sources?.forEach(stack => stack.dispose());
                if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
            }
        }
    }

    release(series) {
        if (this.active?.series === series) this.active.controller.abort();
        this.series.delete(series);
        for (const descriptor of series.frames) this.cache.delete(descriptor.id);
        for (const key of series._keys) {
            const owners = this.keyOwners.get(key);
            owners?.delete(series);
            if (!owners?.size) {
                this.keyOwners.delete(key); this.encoded.delete(key);
                const record = this.metadataRecords.get(key);
                this.attributeBytes -= record?.attributes?.bytes ?? 0;
                if (record) record.attributes = null;
                this.metadataRecords.delete(key);
            }
        }
        if (!this.series.size) this.dispose();
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.active?.controller.abort();
        this.cache.clear();
        this.encoded.clear();
        this.keyOwners.clear();
        for (const record of this.metadataRecords.values()) record.attributes = null;
        this.metadataRecords.clear(); this.attributeBytes = 0;
        this.decoder.dispose();
        this.client = null;
        this.onProgress = null;
        this.onMeasure = null;
    }
}

export class ArchiveSeries {
    constructor(record, session, group = recordFrameGroups(record)[0]) {
        this.id = `${record.studyUid}/${record.seriesUid}|${group.key}`;
        this.studyUid = record.studyUid;
        this.seriesUid = record.seriesUid;
        this.sourceType = 'archive';
        this.modality = record.modality;
        this.description = record.description;
        this.frames = [];
        this.disposed = false;
        this._session = session;
        this._keys = new Set();
        session.series.add(this);
    }

    append(record, group = recordFrameGroups(record)[0]) {
        const key = `${record.studyUid}/${record.seriesUid}/${record.uid}`;
        this._keys.add(key);
        if (!this._session.keyOwners.has(key)) {
            this._session.keyOwners.set(key, new Set()); this._session.metadataRecords.set(key, record);
            this._session.attributeBytes += record.attributes?.bytes ?? 0;
        }
        this._session.keyOwners.get(key).add(this);
        for (const frame of group.frames) {
            this.frames.push({ ...record.common, ...frame.overrides, dimensions: frame.dimensions,
                id: `${this.id}/${record.uid}/${frame.frameIndex}`,
                instanceNumber: record.instanceNumber, frameIndex: frame.frameIndex, sopUid: record.uid, _metadata: record });
        }
    }

    getAttributes(index) {
        if (this.disposed) throw new Error('This series has been disposed.');
        const descriptor = this.frames[index];
        if (!Number.isInteger(index) || !descriptor) throw new Error('Select an available frame.');
        return descriptor._metadata.attributes ?? null;
    }

    async getFrame(index, { signal, onMeasure = this._session.onMeasure } = {}) {
        checkAbort(signal);
        if (this.disposed) throw new Error('This series has been disposed.');
        const descriptor = this.frames[index];
        if (!descriptor) throw new Error('Select an available frame.');
        const operation = this._session.begin(this, signal);
        const requestSignal = operation.controller.signal;
        const frameMeasurement = beginMeasure(onMeasure, 'frame', { signal: requestSignal });
        let ephemeralRecord;
        try {
            const cached = this._session.cache.get(descriptor.id);
            if (cached) {
                frameMeasurement('success', { ...this._session.measureDetails(), decodedBytes: cached.samples.byteLength,
                    decodedCacheHit: true, encodedCacheHit: false });
                return cached;
            }
            let metadata, input, encodedCacheHit = false;
            if (this._session.client.retrievalMode === 'frame') {
                // Native frame resources omit the DICOM header. Use only a complete
                // scalar/palette metadata profile and bind Content-Location to the
                // requested SOP/original frame. Never infer a color-space change.
                if (!['MONOCHROME1', 'MONOCHROME2', 'PALETTE COLOR'].includes(descriptor.photometric) ||
                    ['modalityLut', 'voiLut', 'palette'].some(key => descriptor[key]?.pending)) {
                    throw new Error('Native frame retrieval requires complete scalar or direct-palette metadata. Use instance retrieval for this series.');
                }
                metadata = { ...descriptor, transferSyntax: '1.2.840.10008.1.2.1', littleEndian: true,
                    encodedPhotometric: descriptor.photometric };
                delete metadata._metadata;
                const expected = descriptor._metadata;
                input = await this._session.client.retrieveNativeFrame(expected.studyUid, expected.seriesUid, expected.uid,
                    descriptor.frameIndex + 1, nativeFrameByteLength(metadata), { signal: requestSignal });
            } else {
                const retrieved = await this._session.retrieve(descriptor._metadata, requestSignal, onMeasure);
                const { record, ephemeral } = retrieved;
                encodedCacheHit = retrieved.encodedCacheHit;
                if (ephemeral) ephemeralRecord = record;
                checkAbort(requestSignal);
                const resolved = record.enhancedFrames?.[descriptor.frameIndex];
                metadata = { ...record.common, ...record.frameTiming?.[descriptor.frameIndex], ...resolved?.overrides, dimensions: resolved?.dimensions ?? null,
                    id: descriptor.id, instanceNumber: record.instanceNumber,
                    frameIndex: descriptor.frameIndex, sopUid: record.uid };
                input = encodedFrame(record, metadata.frameIndex);
            }
            checkAbort(requestSignal);
            const frameBytes = input.byteLength;
            const decodeMeasurement = beginMeasure(onMeasure, 'decode', { signal: requestSignal });
            let decoded;
            try {
                decoded = await this._session.decoder.decode(input, metadata, { signal: requestSignal });
                checkAbort(requestSignal);
                decodeMeasurement('success', { ...this._session.measureDetails(), bytes: frameBytes, decodedBytes: decoded.samples.byteLength });
            } catch (error) {
                decodeMeasurement(error.name === 'AbortError' ? 'canceled' : 'error');
                throw error;
            }
            checkAbort(requestSignal);
            if (this.disposed) throw abortError();
            const frame = { ...metadata, ...decoded, window: ['RGB', 'PALETTE COLOR'].includes(metadata.photometric) ? null : metadata.window ?? defaultWindow(decoded.range, metadata.voiFunction) };
            this._session.cache.set(frame.id, frame);
            this._session.report('ready', 'Requested frame ready · other instances remain unfetched');
            frameMeasurement('success', { ...this._session.measureDetails(), bytes: frameBytes, decodedBytes: frame.samples.byteLength,
                decodedCacheHit: false, encodedCacheHit });
            return frame;
        } catch (error) {
            frameMeasurement(error.name === 'AbortError' ? 'canceled' : 'error');
            throw error;
        } finally { if (ephemeralRecord) releaseEncoded(ephemeralRecord); operation.finish(); }
    }

    get cacheBytes() { return this._session.cache.bytes; }
    get sourceBytes() {
        if (this.disposed) return 0;
        let bytes = 0;
        for (const key of this._keys) if (this._session.keyOwners.get(key)?.values().next().value === this) {
            bytes += this._session.encoded.entries.get(key)?.bytes.byteLength ?? 0;
        }
        return bytes;
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this._session.release(this);
        this.frames = [];
        this._keys.clear();
    }
}

/** Build navigable stacks from EASI metadata; native bytes arrive only on getFrame. */
export async function loadArchiveSeries(client, studyUid, seriesUid, options = {}) {
    checkAbort(options.signal);
    const expectedPatient = expectedIdentity(options.expectedPatient);
    const session = new ArchiveSession(client, options);
    let metadataMeasurement;
    try {
        session.report('metadata', 'Reading series metadata with EASI JS');
        const instances = await client.getSeriesMetadata(studyUid, seriesUid, { signal: options.signal });
        checkAbort(options.signal);
        metadataMeasurement = beginMeasure(session.measure, 'metadata-index', { signal: options.signal });
        if (!Array.isArray(instances) || !instances.length) throw new Error('The archive returned no image metadata for this series.');
        if (instances.length > MAX_ARCHIVE_FRAMES) throw new Error('This archive series exceeds the 10,000-frame metadata limit.');
        const groups = new Map();
        const seen = new Set();
        let frameCount = 0;
        for (const instance of instances) {
            const patientIdentity = expectedPatient ? instanceIdentity(instance) : null;
            if (expectedPatient) verifyPatient(patientIdentity, expectedPatient);
            const record = normalizeInstance(instance, { metadataOnly: true });
            if (patientIdentity) record._patientIdentity = patientIdentity;
            record.attributes = createAttributeSnapshot(instance, { maxBytes: Math.min(MAX_ATTRIBUTE_BYTES, MAX_SESSION_ATTRIBUTE_BYTES - session.attributeBytes) });
            if (record.studyUid !== studyUid || record.seriesUid !== seriesUid) throw new Error('The archive metadata does not match the requested Study and Series Instance UIDs.');
            if (seen.has(record.uid)) throw new Error('The archive metadata contains a duplicate SOP Instance UID.');
            seen.add(record.uid);
            frameCount += record.frameCount;
            if (frameCount > MAX_ARCHIVE_FRAMES) throw new Error('This archive series exceeds the 10,000-frame metadata limit.');
            for (const group of recordFrameGroups(record)) {
                let stack = groups.get(group.key);
                if (!stack) { stack = new ArchiveSeries(record, session, group); groups.set(group.key, stack); }
                stack.append(record, group);
            }
        }
        const result = [...groups.values()];
        for (const stack of result) sortFrames(stack.frames);
        if (options.initialInstanceUid) result.sort((a, b) =>
            Number(b.frames.some(frame => frame.sopUid === options.initialInstanceUid)) -
            Number(a.frames.some(frame => frame.sopUid === options.initialInstanceUid)));
        metadataMeasurement('success', session.measureDetails());
        session.report('metadata-ready', 'Series ready · pixels retrieved only for the selected frame', { instances: instances.length });
        await options.onSeries?.(result);
        checkAbort(options.signal);
        return result;
    } catch (error) {
        metadataMeasurement?.(error.name === 'AbortError' ? 'canceled' : 'error');
        for (const stack of [...session.series]) stack.dispose();
        session.dispose();
        throw error;
    }
}
