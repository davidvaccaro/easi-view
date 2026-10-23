import EASI, { DicomSelection, Tag } from '@xinonix/easi-js';
import { workflowFromMetadata, workflowTechnicalMetadata } from './workflow.js';

export const MAX_INDEX_BYTES = 2 * 1024 * 1024;
export const MAX_METADATA_VALUE_BYTES = 2048;
export const MAX_METADATA_CHARS = 512;
export const NAVIGATION_DESCRIPTION_WARNING = 'An optional study or series description has invalid text encoding and was omitted from navigation. Original DICOM attributes are unchanged.';
const FIELDS = Object.freeze({
    '00020010': 'transferSyntaxUid',
    '00080008': 'imageType', '00080016': 'sopClassUid', '00080018': 'sopUid', '00080020': 'studyDate',
    '00080030': 'studyTime', '00080060': 'modality', '00080080': 'institutionName',
    '00081030': 'studyDescription', '0008103E': 'seriesDescription',
    '00100010': 'patientName', '00100020': 'patientId', '00100021': 'issuerOfPatientId',
    '00100030': 'patientBirthDate', '00180010': 'contrastBolusAgent', '00180015': 'bodyPartExamined',
    '00180050': 'sliceThickness', '00181210': 'convolutionKernel',
    '00181040': 'contrastBolusRoute', '00181042': 'contrastBolusStartTime', '00181043': 'contrastBolusStopTime',
    '00200037': 'imageOrientation', '0020000D': 'studyUid', '0020000E': 'seriesUid',
    '00200011': 'seriesNumber', '00200013': 'instanceNumber', '00280008': 'frameCount'
});
const OPTIONAL_WORKFLOW = new Set(['00080008', '00180010', '00180015', '00180050', '00181210', '0018937C', '00181040', '00181042', '00181043', '00200037']);
const WANTED = new Set(['00080005', '0018937C', ...Object.keys(FIELDS)]);

export function catalogError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

export function checkCatalogAbort(signal) {
    if (signal?.aborted) throw new DOMException('Local indexing was canceled.', 'AbortError');
}

/** Scalar navigation metadata only. The pipeline stops before Rows/Pixel Data.
 * This is an index, not validation of a complete DICOM object or its pixels. */
class CatalogSelection extends DicomSelection {
    constructor() {
        super();
        for (const id of WANTED) this.addTag(Tag.find(id));
        // EASI's selection boundary compares group and element independently.
        // All selected scalars precede (0028,0008); Rows and pixel values follow.
        this.maximumTag = Tag.find('00280008');
    }

    matchAttribute(context, attribute) {
        if (WANTED.has(attribute.tag.ID) && attribute.valueLength > MAX_METADATA_VALUE_BYTES) {
            throw catalogError('metadata-limit', 'A navigation attribute exceeds the metadata value limit.');
        }
        return super.matchAttribute(context, attribute);
    }
}

function text(attribute, charset, warnings) {
    if (!attribute) return '';
    const data = attribute.data;
    if (!(data instanceof Uint8Array)) return '';
    const vr = attribute.vr?.ID ?? attribute.tag?.VR?.ID;
    const encodedText = ['LO', 'LT', 'PN', 'SH', 'ST', 'UC', 'UT'].includes(vr);
    const encoding = !encodedText || !charset || charset === 'ISO_IR 6' || charset === 'ISO_IR 192'
        ? 'utf-8' : charset === 'ISO_IR 100' ? 'iso-8859-1' : null;
    if (!encoding) throw catalogError('character-set', 'This local index does not support the declared text character set.');
    let value;
    try { value = new TextDecoder(encoding, { fatal: true }).decode(data).replace(/\0+$/gu, '').trim(); }
    catch {
        // Optional display labels cannot establish patient or image identity.
        // Omit malformed labels rather than guessing a different character set.
        if (warnings && (['00081030', '0008103E'].includes(attribute.tag.ID) || OPTIONAL_WORKFLOW.has(attribute.tag.ID))) {
            const warning = OPTIONAL_WORKFLOW.has(attribute.tag.ID) ? 'An optional workflow attribute has invalid text encoding and was omitted from navigation.' : NAVIGATION_DESCRIPTION_WARNING;
            if (!warnings.includes(warning)) warnings.push(warning);
            return '';
        }
        throw catalogError('character-set', 'Navigation metadata contains invalid text encoding.');
    }
    if (value.length > MAX_METADATA_CHARS) throw catalogError('metadata-limit', 'A navigation attribute exceeds the text limit.');
    return value.replace(/[\u0000-\u001f\u007f]/gu, ' ');
}

export function validCatalogUid(value) {
    return typeof value === 'string' && value.length <= 64 && /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))+$/u.test(value);
}

function validDate(value) {
    if (!/^\d{8}$/u.test(value)) return false;
    const year = Number(value.slice(0, 4)), month = Number(value.slice(4, 6)), day = Number(value.slice(6));
    if (year < 1 || month < 1 || month > 12 || day < 1) return false;
    return day <= new Date(Date.UTC(year === 1 ? 2001 : year, month, 0)).getUTCDate();
}

function normalize(set) {
    if (!set?.attributes?.length) throw catalogError('not-dicom', 'No DICOM navigation metadata was found.');
    const charset = text(set.find(Tag.find('00080005')), '');
    const metadata = { warnings: [] };
    for (const [id, name] of Object.entries(FIELDS)) metadata[name] = text(set.find(Tag.find(id)), charset, metadata.warnings);
    Object.assign(metadata, workflowTechnicalMetadata(id => set.find(Tag.find(id)), { littleEndian: metadata.transferSyntaxUid !== '1.2.840.10008.1.2.2' }));
    if (!metadata.sopClassUid && !metadata.studyUid && !metadata.patientId && !metadata.patientName) {
        throw catalogError('not-dicom', 'No DICOM navigation metadata was found.');
    }
    for (const name of ['sopClassUid', 'sopUid', 'studyUid', 'seriesUid']) {
        if (!validCatalogUid(metadata[name])) metadata.warnings.push(`The ${name.replace(/Uid$/u, ' UID')} is missing or invalid; local identity is unverified.`);
    }
    for (const name of ['studyDate', 'patientBirthDate']) {
        if (metadata[name] && !validDate(metadata[name])) {
            metadata[name] = '';
            metadata.warnings.push('A declared date is invalid; its date is shown as unknown.');
        }
    }
    if (metadata.studyTime && !/^\d{2}(?:\d{2}(?:\d{2}(?:\.\d{1,6})?)?)?$/u.test(metadata.studyTime)) metadata.studyTime = '';
    const count = Number(metadata.frameCount || 1);
    if (!Number.isSafeInteger(count) || count < 1 || count > 100000000) {
        metadata.frameCount = null;
        metadata.warnings.push('The declared frame count is invalid; image availability is unverified.');
    } else metadata.frameCount = count;
    for (const name of ['seriesNumber', 'instanceNumber']) {
        metadata[name] = /^[+-]?\d+$/u.test(metadata[name]) && Number.isSafeInteger(Number(metadata[name])) ? Number(metadata[name]) : null;
    }
    metadata.workflow = workflowFromMetadata(metadata);
    metadata.indexStatus = 'metadata-only';
    metadata.availability = 'unverified';
    return Object.freeze({ ...metadata, warnings: Object.freeze(metadata.warnings) });
}

function boundedStream(file, signal) {
    const reader = file.stream().getReader();
    let consumed = 0, closed = false;
    const release = () => { signal?.removeEventListener('abort', abort); try { reader.releaseLock(); } catch {} };
    const cancel = async reason => { if (!closed) { closed = true; try { await reader.cancel(reason); } catch {} release(); } };
    let controller;
    const abort = () => { controller?.error(new DOMException('Local indexing was canceled.', 'AbortError')); void cancel(); };
    return new ReadableStream({
        start(value) { controller = value; signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort(); },
        async pull() {
            try {
                checkCatalogAbort(signal);
                const chunk = await reader.read();
                if (closed) return;
                if (chunk.done) { closed = true; release(); controller.close(); return; }
                if (!(chunk.value instanceof Uint8Array)) throw catalogError('invalid-input', 'Choose browser File or Blob inputs.');
                consumed += chunk.value.byteLength;
                if (consumed > MAX_INDEX_BYTES) throw catalogError('scan-limit', 'Navigation metadata exceeds the 2 MiB per-file scan limit.');
                controller.enqueue(chunk.value);
            } catch (error) {
                if (!closed) controller.error(error);
                await cancel(error);
            }
        },
        cancel
    }, { highWaterMark: 0 });
}

/** Metadata indexing never invokes the viewer's pixel loader or a decoder. */
export async function indexLocalFile(file, { signal } = {}) {
    checkCatalogAbort(signal);
    if (!file || typeof file.stream !== 'function' || !Number.isSafeInteger(file.size) || file.size < 1) {
        throw catalogError('invalid-input', 'Choose nonempty browser File or Blob inputs.');
    }
    const source = { size: file.size, type: 'application/dicom', stream: () => boundedStream(file, signal) };
    const pipeline = EASI.pipelineBuilder().fromFileStream().ofDicomData({ includePart10Header: true })
        .withBulkDataPolicy({ mode: 'auto', hardSafetyCap: MAX_METADATA_VALUE_BYTES + 1, knownLengthThreshold: 1 })
        .toSelection(new CatalogSelection()).build();
    const result = await pipeline.process({ source, sourceOptions: { contentType: 'application/dicom' } });
    checkCatalogAbort(signal);
    return normalize(result.single());
}
