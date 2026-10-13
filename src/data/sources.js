import EASI, { Tag } from '@xinonix/easi-js';
import { makeDemoFiles } from './synthetic.js';
import { defaultWindow } from './native.js';
import { FrameCache } from '../runtime/frame-cache.js';
import { NativeDecoder, abortError, checkAbort } from '../runtime/native-decoder.js';

export { makeDemoFiles } from './synthetic.js';
export const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_FRAME_PIXELS = 16 * 1024 * 1024;
const NATIVE_SYNTAXES = new Set(['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']);
const IMAGE_CLASSES = new Set([
    '1.2.840.10008.5.1.4.1.1.1', '1.2.840.10008.5.1.4.1.1.1.1', '1.2.840.10008.5.1.4.1.1.1.1.1',
    '1.2.840.10008.5.1.4.1.1.2', '1.2.840.10008.5.1.4.1.1.4', '1.2.840.10008.5.1.4.1.1.6.1',
    '1.2.840.10008.5.1.4.1.1.3.1', '1.2.840.10008.5.1.4.1.1.7',
    '1.2.840.10008.5.1.4.1.1.7.2', '1.2.840.10008.5.1.4.1.1.7.3'
]);

function value(set, id, fallback = null) {
    return set?.value(Tag.find(id), fallback) ?? fallback;
}

function numbers(raw) {
    if (raw == null || raw === '') return [];
    if (typeof raw === 'number') return [raw];
    if (typeof raw !== 'string') throw new Error('The DICOM numeric metadata has an unsupported encoding.');
    const result = raw.split('\\').map(Number);
    if (!result.every(Number.isFinite)) throw new Error('The DICOM numeric metadata contains invalid values.');
    return result;
}

function number(set, id, fallback) {
    return numbers(value(set, id))[0] ?? fallback;
}

function vector(set, id, count) {
    const result = numbers(value(set, id));
    if (!result.length) return null;
    if (result.length !== count) throw new Error('The DICOM image geometry is incomplete.');
    return result;
}

function has(set, id) { return set?.has(Tag.find(id)) === true; }

function integer(set, id, fallback, min, max) {
    const result = number(set, id, fallback);
    if (!Number.isInteger(result) || result < min || result > max) throw new Error('Invalid native image dimensions or pixel metadata.');
    return result;
}

/** Normalize a completed EASI instance without producing display-ready RGBA pixels. */
export function normalizeInstance(instance) {
    const set = instance.dataSet;
    if (!set) throw new Error('The source does not contain a DICOM image dataset.');
    // EASI's dataset target attaches its resolved transfer syntax to attributes.
    const pixelAttribute = set.find(Tag.find('7FE00010'));
    const syntax = String(value(instance.metaSet, '00020010', pixelAttribute?.transferSyntax?.ID ?? ''));
    if (!NATIVE_SYNTAXES.has(syntax)) {
        throw new Error('This alpha supports native uncompressed DICOM pixels. Compressed transfer syntaxes are a later milestone.');
    }
    const sopClass = String(value(set, '00080016', ''));
    if (!IMAGE_CLASSES.has(sopClass)) throw new Error('This DICOM object type is outside the native 2D image profile supported by this alpha.');
    if (has(set, '52009229') || has(set, '52009230')) {
        throw new Error('Enhanced shared/per-frame functional groups need a dedicated geometry implementation and are not supported by this alpha.');
    }
    if (has(set, '00283000') || has(set, '00283010') || has(set, '00409096')) {
        throw new Error('Modality LUT, VOI LUT, and real-world value mappings are not supported by this alpha.');
    }
    const presentationShape = String(value(set, '20500020', ''));
    if (has(set, '20500010') || !['', 'IDENTITY'].includes(presentationShape) ||
        (presentationShape === 'IDENTITY' && value(set, '00280004') === 'MONOCHROME1')) {
        throw new Error('Presentation LUT transforms are not supported by this alpha.');
    }
    const rows = integer(set, '00280010', 0, 1, 8192);
    const columns = integer(set, '00280011', 0, 1, 8192);
    if (rows * columns > MAX_FRAME_PIXELS) throw new Error('The frame exceeds the 16-megapixel alpha limit.');
    const samplesPerPixel = integer(set, '00280002', 0, 1, 4);
    const photometric = String(value(set, '00280004', ''));
    if (samplesPerPixel !== 1 || !['MONOCHROME1', 'MONOCHROME2'].includes(photometric)) {
        throw new Error('This alpha displays native MONOCHROME1 and MONOCHROME2 images; color images need a separate rendering profile.');
    }
    const bitsAllocated = integer(set, '00280100', 0, 8, 16);
    const bitsStored = integer(set, '00280101', 0, 1, bitsAllocated);
    const highBit = integer(set, '00280102', -1, bitsStored - 1, bitsAllocated - 1);
    if (![8, 16].includes(bitsAllocated)) throw new Error('This alpha supports 8-bit and 16-bit native pixels.');
    const signed = integer(set, '00280103', -1, 0, 1) === 1;
    const frameCount = integer(set, '00280008', 1, 1, 4096);
    const slope = number(set, '00281053', 1);
    const intercept = number(set, '00281052', 0);
    if (!Number.isFinite(slope) || slope === 0 || !Number.isFinite(intercept)) throw new Error('Invalid pixel rescale transform.');
    const voiFunction = String(value(set, '00281056', 'LINEAR'));
    if (!['LINEAR', 'LINEAR_EXACT'].includes(voiFunction)) throw new Error('This alpha supports LINEAR and LINEAR_EXACT VOI window functions.');
    const center = number(set, '00281050', null);
    const width = number(set, '00281051', null);
    if ((center == null) !== (width == null) || (width != null && (width < (voiFunction === 'LINEAR' ? 1 : Number.MIN_VALUE)))) {
        throw new Error('The supplied DICOM window center/width is invalid.');
    }
    const pixelSpacing = vector(set, '00280030', 2);
    if (pixelSpacing?.some(v => v <= 0)) throw new Error('Invalid pixel spacing.');
    const pixelAspectRatio = vector(set, '00280034', 2);
    if (pixelAspectRatio?.some(v => !Number.isInteger(v) || v <= 0)) throw new Error('Invalid pixel aspect ratio.');
    if (!pixelSpacing && pixelAspectRatio && pixelAspectRatio[0] !== pixelAspectRatio[1]) {
        throw new Error('Non-square pixel aspect ratios without patient pixel spacing need a separate display-aspect implementation.');
    }
    const orientation = vector(set, '00200037', 6);
    const position = vector(set, '00200032', 3);
    if (orientation) {
        const a = orientation.slice(0, 3);
        const b = orientation.slice(3);
        if (Math.abs(Math.hypot(...a) - 1) > 0.001 || Math.abs(Math.hypot(...b) - 1) > 0.001 ||
            Math.abs(a.reduce((sum, v, i) => sum + v * b[i], 0)) > 0.001) throw new Error('Invalid image orientation direction cosines.');
    }
    const littleEndian = syntax !== '1.2.840.10008.1.2.2';
    const paddingAttribute = set.find(Tag.find('00280120'));
    if (!paddingAttribute && has(set, '00280121')) throw new Error('Pixel Padding Range Limit requires a Pixel Padding Value.');
    let padding = null;
    if (paddingAttribute) {
        const readPadding = attr => {
            const bytes = attr.access();
            if (bytes.byteLength !== 2) throw new Error('Invalid pixel padding metadata.');
            const view = new DataView(bytes.buffer, bytes.byteOffset, 2);
            return signed ? view.getInt16(0, littleEndian) : view.getUint16(0, littleEndian);
        };
        const paddingValue = readPadding(paddingAttribute);
        padding = { value: paddingValue, limit: has(set, '00280121') ? readPadding(set.find(Tag.find('00280121'))) : paddingValue };
    }
    if (has(set, '00181065')) throw new Error('Variable frame-time vectors are not supported by the initial cine implementation.');
    const frameTime = number(set, '00181063', 50);
    if (frameTime <= 0) throw new Error('Invalid multiframe timing metadata.');
    const pixels = set.find(Tag.find('7FE00010'));
    if (!pixels || pixels.valueLength === 0xFFFFFFFF || !pixels.isComplete) throw new Error('Native Pixel Data is missing, incomplete, or exceeds the materialization limit.');
    const expectedBytes = rows * columns * bitsAllocated / 8 * frameCount;
    const encoded = pixels.access();
    if (expectedBytes > MAX_SOURCE_BYTES || encoded.byteLength < expectedBytes || encoded.byteLength > expectedBytes + (expectedBytes % 2)) {
        throw new Error('The native Pixel Data length does not match its frame count and dimensions.');
    }
    const uid = String(value(set, '00080018', ''));
    const seriesUid = String(value(set, '0020000E', ''));
    if (!uid || !seriesUid) throw new Error('The DICOM image is missing a SOP or Series Instance UID.');
    const modality = String(value(set, '00080060', 'OT'));
    const rescaleType = String(value(set, '00281054', ''));
    const imageType = String(value(set, '00080008', '')).split('\\');
    const conventionalCt = modality === 'CT' && sopClass === '1.2.840.10008.5.1.4.1.1.2' &&
        imageType[0] === 'ORIGINAL' && imageType[2] === 'AXIAL' && !has(set, '00189361');
    const common = {
        rows, columns, bitsAllocated, bitsStored, highBit, signed, littleEndian, slope, intercept,
        photometric, pixelSpacing, orientation, position, padding, voiFunction, frameTime,
        window: center == null ? null : { center, width },
        unit: rescaleType === 'HU' || (!rescaleType && conventionalCt) ? 'HU' : ''
    };
    const bytes = encoded.slice(0, expectedBytes);
    // The emitted instance has been consumed; release EASI's growable pixel backing store.
    pixels.clear();
    return {
        uid, seriesUid, modality, description: String(value(set, '0008103E', `${modality} series`)),
        instanceNumber: number(set, '00200013', 0), frameCount, bytes, common
    };
}

function geometryKey(metadata) {
    return [metadata.rows, metadata.columns, metadata.pixelSpacing?.join(',') ?? '',
        metadata.orientation?.map(v => v.toFixed(4)).join(',') ?? '', metadata.position ? 'positioned' : 'unpositioned'].join('|');
}

function projection(frame) {
    if (!frame.orientation || !frame.position) return null;
    const [a, b, c, d, e, f] = frame.orientation;
    const normal = [b * f - c * e, c * d - a * f, a * e - b * d];
    return normal.reduce((sum, value, i) => sum + value * frame.position[i], 0);
}

export function sortFrames(frames) {
    const geometric = frames.every(frame => projection(frame) != null);
    frames.sort((a, b) => {
        if (geometric) {
            const difference = projection(a) - projection(b);
            if (Math.abs(difference) > 0.00001) return difference;
        }
        return a.instanceNumber - b.instanceNumber || a.frameIndex - b.frameIndex || a.id.localeCompare(b.id);
    });
    return frames;
}

export class Series {
    constructor(record, session) {
        this.id = `${record.seriesUid}|${geometryKey(record.common)}`;
        this.description = record.description;
        this.modality = record.modality;
        this.sourceBytes = 0;
        this.frames = [];
        this.disposed = false;
        this._abortController = new AbortController();
        this._session = session;
        this._records = new Map();
    }

    append(record) {
        if (this._records.has(record.uid)) return;
        this._records.set(record.uid, record);
        this.sourceBytes += record.bytes.byteLength;
        for (let i = 0; i < record.frameCount; i++) {
            this.frames.push({ ...record.common, id: `${this.id}/${record.uid}/${i}`, instanceNumber: record.instanceNumber, frameIndex: i, _record: record });
        }
        sortFrames(this.frames);
    }

    async getFrame(index, { signal } = {}) {
        checkAbort(signal);
        if (this.disposed) throw new Error('This series has been disposed.');
        const descriptor = this.frames[index];
        if (!descriptor) throw new Error('Select an available frame.');
        const cached = this._session.cache.get(descriptor.id);
        if (cached) return cached;
        const record = descriptor._record;
        const frameBytes = descriptor.rows * descriptor.columns * descriptor.bitsAllocated / 8;
        const start = descriptor.frameIndex * frameBytes;
        const { _record, ...metadata } = descriptor;
        const controller = new AbortController();
        const abort = () => controller.abort();
        const lifetime = this._abortController.signal;
        signal?.addEventListener('abort', abort, { once: true });
        lifetime.addEventListener('abort', abort, { once: true });
        let decoded;
        try {
            checkAbort(signal);
            checkAbort(lifetime);
            decoded = await this._session.decoder.decode(record.bytes.subarray(start, start + frameBytes), metadata, { signal: controller.signal });
        } finally {
            signal?.removeEventListener('abort', abort);
            lifetime.removeEventListener('abort', abort);
        }
        checkAbort(signal);
        if (this.disposed) throw abortError();
        const frame = { ...metadata, ...decoded, window: descriptor.window ?? defaultWindow(decoded.range, descriptor.voiFunction) };
        this._session.cache.set(frame.id, frame);
        return frame;
    }

    get cacheBytes() { return this._session.cache.bytes; }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this._abortController.abort();
        for (const frame of this.frames) this._session.cache.delete(frame.id);
        for (const record of this._records.values()) record.bytes = new Uint8Array(0);
        this._records.clear();
        this.frames = [];
        this.sourceBytes = 0;
        this._session.release(this);
    }
}

class SourceSession {
    constructor(options) {
        this.options = options;
        this.cache = new FrameCache();
        this.decoder = new NativeDecoder();
        this.series = new Map();
        this.seen = new WeakSet();
        this.loaded = 0;
        this.total = null;
        this.instances = 0;
    }

    report(phase, message) {
        this.options.onProgress?.({ phase, loaded: this.loaded, total: this.total, message,
            instances: this.instances, frames: [...this.series.values()].reduce((sum, series) => sum + series.frames.length, 0) });
    }

    async accept(result) {
        checkAbort(this.options.signal);
        for (const instance of Array.isArray(result) ? result : [result]) {
            if (!instance?.dataSet || this.seen.has(instance)) continue;
            this.seen.add(instance);
            const record = normalizeInstance(instance);
            const key = `${record.seriesUid}|${geometryKey(record.common)}`;
            let series = this.series.get(key);
            if (!series) { series = new Series(record, this); this.series.set(key, series); }
            series.append(record);
            this.instances++;
            this.report('parsing', `${this.instances} image instance${this.instances === 1 ? '' : 's'} parsed with EASI JS`);
            await this.options.onSeries?.([...this.series.values()]);
        }
    }

    release(series) {
        this.series.delete(series.id);
        if (this.series.size === 0) { this.cache.clear(); this.decoder.dispose(); }
    }

    dispose() {
        for (const series of [...this.series.values()]) series.dispose();
        this.cache.clear();
        this.decoder.dispose();
        this.options = {};
    }
}

/** Apply an aggregate byte limit and propagate abort to the underlying reader. */
function boundedStream(stream, session) {
    const reader = stream.getReader();
    const signal = session.options.signal;
    let closed = false;
    let released = false;
    let controller;
    const release = () => {
        if (released) return;
        released = true;
        signal?.removeEventListener('abort', onAbort);
        try { reader.releaseLock(); } catch { /* A pending read completes after cancellation. */ }
    };
    const cancel = async reason => { try { await reader.cancel(reason); } finally { release(); } };
    const onAbort = () => {
        if (closed) return;
        closed = true;
        controller.error(abortError());
        void cancel(abortError()).catch(() => {});
    };
    return new ReadableStream({
        start(value) {
            controller = value;
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) onAbort();
        },
        async pull() {
            try {
                checkAbort(signal);
                const chunk = await reader.read();
                if (closed) return;
                if (chunk.done) { closed = true; release(); controller.close(); return; }
                session.loaded += chunk.value.byteLength;
                if (session.loaded > MAX_SOURCE_BYTES) throw new Error('The input exceeds the 256 MiB source limit. Load a smaller series.');
                session.report('reading', 'Streaming DICOM bytes into EASI JS');
                controller.enqueue(chunk.value);
            } catch (error) {
                if (!closed) { closed = true; controller.error(error); }
                await cancel(error);
            }
        },
        async cancel(reason) { closed = true; await cancel(reason); }
    }, { highWaterMark: 0 });
}

function pipeline(sourceType) {
    let builder = EASI.pipelineBuilder();
    builder = sourceType === 'file' ? builder.fromFileStream() : builder.fromPartStream();
    return builder.ofDicomData().withBulkDataPolicy({ mode: 'materialize', hardSafetyCap: MAX_SOURCE_BYTES + 1 }).toInstances().build();
}

function finalize(session) {
    if (!session.series.size) throw new Error('No supported DICOM image instances were found.');
    session.report('ready', 'Ready · native scalar pixels decoded on demand');
    session.options = {};
    return [...session.series.values()];
}

export async function loadFiles(files, options = {}) {
    const inputs = Array.from(files ?? []);
    checkAbort(options.signal);
    if (!inputs.length) throw new Error('Choose one or more DICOM files.');
    if (inputs.some(file => typeof file?.stream !== 'function' || !Number.isSafeInteger(file.size))) throw new Error('Choose browser File or Blob inputs.');
    const session = new SourceSession(options);
    session.total = inputs.reduce((sum, file) => sum + file.size, 0);
    if (session.total > MAX_SOURCE_BYTES) { session.dispose(); throw new Error('The selected files exceed the 256 MiB source limit. Load a smaller series.'); }
    try {
        for (const file of inputs) {
            checkAbort(options.signal);
            const source = { size: file.size, type: 'application/dicom', stream: () => boundedStream(file.stream(), session) };
            await pipeline('file').process({ source, sourceOptions: { contentType: 'application/dicom', onEmit: result => session.accept(result) } });
        }
        checkAbort(options.signal);
        return finalize(session);
    } catch (error) {
        session.dispose();
        throw error;
    }
}

export async function loadUrl(rawUrl, options = {}) {
    checkAbort(options.signal);
    let url;
    try { url = new URL(rawUrl); } catch { throw new Error('Enter an absolute HTTP or HTTPS DICOMweb retrieval URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP or HTTPS retrieval URL without embedded credentials.');
    const session = new SourceSession(options);
    try {
        session.report('reading', 'Connecting to the DICOMweb retrieval endpoint');
        let response;
        try {
            response = await fetch(url, { signal: options.signal, credentials: 'omit', headers: { Accept: 'multipart/related; type="application/dicom", application/dicom' } });
        } catch (error) {
            checkAbort(options.signal);
            throw new Error('The retrieval request failed. Check HTTPS, the endpoint, and its browser CORS configuration.');
        }
        if (!response.ok) { await response.body?.cancel(); throw new Error(`The retrieval endpoint returned HTTP ${response.status}.`); }
        if (!response.body) throw new Error('The endpoint returned no readable response body.');
        const contentType = response.headers.get('content-type') ?? '';
        if (!/^application\/dicom(?:\s*;|$)/i.test(contentType) && !/^multipart\/related(?:\s*;|$)/i.test(contentType)) {
            await response.body.cancel();
            throw new Error('Use a DICOMweb RetrieveInstance/Series/Study URL returning application/dicom or multipart/related; JSON metadata and rendered JPEG endpoints are not image inputs.');
        }
        const total = Number(response.headers.get('content-length'));
        session.total = total > 0 && Number.isSafeInteger(total) ? total : null;
        if (session.total > MAX_SOURCE_BYTES) { await response.body.cancel(); throw new Error('The response exceeds the 256 MiB source limit. Retrieve a smaller series.'); }
        const source = boundedStream(response.body, session);
        try {
            await pipeline('part').process({ source, sourceOptions: { contentType, contentLength: session.total, onEmit: result => session.accept(result) } });
        } catch (error) {
            if (!source.locked) { try { await source.cancel(); } catch {} }
            throw error;
        }
        checkAbort(options.signal);
        return finalize(session);
    } catch (error) {
        session.dispose();
        throw error;
    }
}

export async function loadDemo(kind = 'ct', options = {}) {
    checkAbort(options.signal);
    return loadFiles(makeDemoFiles(kind), options);
}
