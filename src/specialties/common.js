import EASI from '@xinonix/easi-js';
import { readDerivedInstance } from '../derived/easi-adapter.js';
import { attribute, numbers, scalar, text, integer, uid, validateStructure } from '../derived/common.js';

export { attribute, numbers, scalar, text, integer, uid };
export const MAX_SPECIALTY_BYTES = 64 * 1024 * 1024;
export const MAX_SPECIALTY_FRAMES = 4096;
export const MAX_SPECIALTY_METADATA_BYTES = 8 * 1024 * 1024;
export const fail = reason => { throw new Error(`Unsupported specialty profile: ${reason}.`); };
export const checkSignal = signal => { if (signal?.aborted) throw new DOMException('Specialty processing was canceled.', 'AbortError'); };
export const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));
export function dataSet(input) { const set = input?.dataSet ?? input; validateStructure(set); return set; }
export function values(set, id, { required = true, maximum = 16 } = {}) {
    const raw = attribute(set, id)?.value;
    if (raw == null) { if (required) fail('required text values are missing'); return []; }
    const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split('\\') : [raw];
    if (!values.length || values.length > maximum || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 64 || /[\u0000-\u001F\\]/u.test(value.trim()))) fail('text values are invalid');
    return values.map(value => value.trim());
}
export function pointer(set, id = '00280009') {
    const attr = attribute(set, id);
    if (!attr) return null;
    if ((attr.vr?.ID ?? attr.tag?.VR?.ID) !== 'AT') fail('one valid Frame Increment Pointer is required');
    const raw = attr.value;
    if (ArrayBuffer.isView(raw)) {
        if (raw.byteLength !== 4) fail('one Frame Increment Pointer is required');
        const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength), little = attr.transferSyntax?.IsLittleEndian !== false;
        return view.getUint16(0, little).toString(16).padStart(4, '0').toUpperCase() + view.getUint16(2, little).toString(16).padStart(4, '0').toUpperCase();
    }
    const list = Array.isArray(raw) ? raw : [raw];
    if (list.length !== 1 || typeof list[0] !== 'string' || !/^[\dA-F]{8}$/iu.test(list[0])) fail('one valid Frame Increment Pointer is required');
    return list[0].toUpperCase();
}
export function nativeSyntax(instance) {
    const syntax = attribute(instance?.dataSet, '7FE00010')?.transferSyntax?.ID ?? text(instance?.metaSet, '00020010', { required: false }) ?? '1.2.840.10008.1.2';
    if (!['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2'].includes(syntax)) fail('only the three native transfer syntaxes are supported by this processor');
    return { syntax, littleEndian: syntax !== '1.2.840.10008.1.2.2' };
}
export function nativePixelBytes(set, expected) {
    const attr = attribute(set, '7FE00010'), bytes = attr?.access?.();
    if (!attr || !['OB', 'OW'].includes(attr.vr?.ID ?? attr.tag?.VR?.ID) || attr.isMaterialized === false ||
        attr.items?.length || attr.fragments?.length || !(bytes instanceof Uint8Array) || bytes.byteLength !== expected + expected % 2) fail('a complete bounded native Pixel Data value is required');
    return bytes;
}
/** Pixel cells cross OW boundaries least-significant word first, even in BE. */
export function unsignedPixelReader(set, bytes, bitsAllocated, littleEndian) {
    const pixel = attribute(set, '7FE00010');
    // EASI's dictionary uses OB for the ambiguous Pixel Data tag in implicit
    // datasets. The implicit native transfer syntax defines its actual VR OW.
    const vr = pixel.transferSyntax?.ID === '1.2.840.10008.1.2' ? 'OW' : pixel.vr?.ID ?? pixel.tag?.VR?.ID;
    if (bitsAllocated > 8 && vr !== 'OW') fail('multi-byte native pixels require OW');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bitsAllocated === 8) return index => bytes[!littleEndian && vr === 'OW' ? index ^ 1 : index];
    if (bitsAllocated === 16) return index => view.getUint16(index * 2, littleEndian);
    if (bitsAllocated === 32) return index => view.getUint16(index * 4, littleEndian) + view.getUint16(index * 4 + 2, littleEndian) * 65536;
    fail('native pixel allocation is unsupported');
}
export function boundedOutput(count, bytesPerPixel, maxBytes = MAX_SPECIALTY_BYTES) {
    integer(maxBytes, 1, MAX_SPECIALTY_BYTES);
    if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(count * bytesPerPixel) || count * bytesPerPixel > maxBytes) fail('output exceeds its byte budget');
}
export const frozenArray = value => Object.freeze([...value]);

/** Local binary processor reader. Does not call the main viewer's image allowlist. */
export function readSpecialtyInstance(input, options) { return readDerivedInstance(input, options); }

/** Explicit local DICOM JSON metadata only; InlineBinary is rejected before EASI. */
export async function readSpecialtyMetadata(input, { signal, maxBytes = MAX_SPECIALTY_METADATA_BYTES } = {}) {
    integer(maxBytes, 1, MAX_SPECIALTY_METADATA_BYTES); checkSignal(signal);
    let json;
    if (typeof input === 'string') {
        if (input.length > maxBytes) fail('metadata exceeds its byte budget');
        json = JSON.parse(input);
    } else json = input;
    if (!json || typeof json !== 'object') fail('one local DICOM JSON object is required');
    let nodes = 0, estimate = 0;
    const visit = (value, depth) => {
        if (depth > 24 || ++nodes > 65536) fail('metadata structure exceeds its budget');
        if (value !== null && !['object', 'string', 'number', 'boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) fail('metadata must contain only finite JSON values');
        if (typeof value === 'string') estimate += value.length;
        else if (!value || typeof value !== 'object') estimate += 24;
        if (estimate > maxBytes) fail('metadata exceeds its byte budget');
        if (!value || typeof value !== 'object') return;
        if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail('metadata must use ordinary JSON objects');
        if (Object.hasOwn(value, 'InlineBinary')) fail('inline binary data is not supported by the metadata-only reader');
        // Walk without creating an entries array for an adversarially large list.
        for (const key in value) if (Object.hasOwn(value, key)) { estimate += key.length + 4; visit(value[key], depth + 1); }
    };
    visit(json, 0); checkSignal(signal);
    const encoded = new TextEncoder().encode(JSON.stringify(json));
    if (encoded.byteLength > maxBytes) fail('metadata exceeds its byte budget');
    const product = await EASI.pipelineBuilder().fromByteStream().ofDicomMetadata().toInstances().build().process({ source: encoded });
    checkSignal(signal); if (product.count !== 1) fail('exactly one metadata instance is required');
    const instance = product.first(); dataSet(instance); return instance;
}
