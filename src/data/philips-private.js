import { Tag } from '@xinonix/easi-js';
import { getAttributeVR } from './attributes.js';

export const PHILIPS_PRIVATE_CT_SYNTAX = '1.3.46.670589.33.1.4.1';
export const PHILIPS_PRIVATE_PIXEL_PROFILE = 'philips-pmsct-rle1-native16le-v1';
const CT_SOP = '1.2.840.10008.5.1.4.1.1.2';
const PAYLOAD_TAG = '07A1100A';
const LIMIT = 64 * 1024 * 1024;
const attributeVr = (set,id) => getAttributeVR(set?.find?.(Tag.find(id)));
const invalid = message => { throw new Error('Invalid Philips PMSCT_RLE1 data: ' + message + '.'); };
const unsupported = () => { throw new Error('Philips private CT requires the verified ELSCINT1 PMSCT_RLE1 unsigned12-in16 MONOCHROME2 profile.'); };

function value(set, id) {
    const raw = set?.find?.(Tag.find(id))?.value;
    if (Array.isArray(raw)) { if (raw.length !== 1) unsupported(); return raw[0]; }
    return raw;
}
function string(set, id) { const raw = value(set,id); return typeof raw === 'string' ? raw.trim() : null; }
function integer(set, id, fallback = null) {
    const attr=set?.find?.(Tag.find(id));
    if (attr) {
        const expected=id==='00280008'?'IS':'US';
        if (getAttributeVR(attr)!==expected) unsupported();
        const bytes=attr.access?.();
        if (expected==='US' && ArrayBuffer.isView(bytes) && bytes.byteLength!==2) unsupported();
    }
    const raw = value(set,id);
    if (raw == null || raw === '') return fallback;
    if (typeof raw !== 'number' && (typeof raw !== 'string' || !/^\+?\d+$/.test(raw.trim()))) unsupported();
    const result = Number(raw);
    if (!Number.isSafeInteger(result) || result < 0) unsupported();
    return result;
}

function dimensions(profile, maximum = LIMIT) {
    if (!profile || profile.transferSyntax !== PHILIPS_PRIVATE_CT_SYNTAX || profile.sopClass !== CT_SOP
        || profile.privateCreator !== 'ELSCINT1' || profile.compression !== 'PMSCT_RLE1' || profile.modality !== 'CT'
        || profile.pixelDecodingProfile !== PHILIPS_PRIVATE_PIXEL_PROFILE || profile.payloadTag !== PAYLOAD_TAG
        || profile.photometric !== 'MONOCHROME2' || profile.samplesPerPixel !== 1 || profile.bitsAllocated !== 16
        || profile.bitsStored !== 12 || profile.highBit !== 11 || profile.pixelRepresentation !== 0 || profile.frameCount !== 1
        || !Number.isSafeInteger(profile.rows) || profile.rows < 1 || profile.rows > 8192
        || !Number.isSafeInteger(profile.columns) || profile.columns < 1 || profile.columns > 8192) unsupported();
    const samples = profile.rows * profile.columns, bytes = samples * 2;
    if (!Number.isSafeInteger(samples) || samples > 16 * 1024 * 1024 || !Number.isSafeInteger(bytes)
        || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > LIMIT || bytes > maximum) invalid('decoded frame exceeds its byte or dimension limit');
    return { samples, bytes };
}

/** Recognize this private format, without replacing source attributes or inventing Pixel Data. */
export function resolvePhilipsPrivateProfile(set, { transferSyntax, sopClass, metadataOnly=false } = {}) {
    if (transferSyntax !== PHILIPS_PRIVATE_CT_SYNTAX) return null;
    const profile = {
        transferSyntax, sopClass: sopClass ?? string(set,'00080016'), modality:string(set,'00080060'), privateCreator: string(set,'07A10010'),
        compression: string(set,'07A11011'), photometric: string(set,'00280004'),
        rows: integer(set,'00280010'), columns: integer(set,'00280011'), frameCount: integer(set,'00280008',1),
        samplesPerPixel: integer(set,'00280002'), bitsAllocated: integer(set,'00280100'), bitsStored: integer(set,'00280101'),
        highBit: integer(set,'00280102'), pixelRepresentation: integer(set,'00280103'),
        payloadTag: PAYLOAD_TAG, pixelDecodingProfile: PHILIPS_PRIVATE_PIXEL_PROFILE
    };
    dimensions(profile);
    if (string(set,'00080016') !== CT_SOP || set?.find?.(Tag.find('7FE00010'))
        || attributeVr(set,'07A10010') !== 'LO' || attributeVr(set,'07A11011') !== 'CS') unsupported();
    const payload = set?.find?.(Tag.find(PAYLOAD_TAG));
    const vr = getAttributeVR(payload);
    if (metadataOnly && (!payload || !Number.isSafeInteger(payload.valueLength) || payload.valueLength<2)) {
        throw new Error('Philips private CT requires the complete original instance and its private OB payload.');
    }
    if (payload?.isComplete === false) invalid('private OB payload is incomplete');
    if (!payload || vr !== 'OB' || !Number.isSafeInteger(payload.valueLength) || payload.valueLength < 2
        || payload.valueLength > LIMIT || payload.valueLength % 2 !== 0) invalid('private OB payload length or representation is invalid');
    // Vendor CT-private-ELE defines dataset headers as explicit-VR little-endian.
    // Unknown-syntax heuristics alone never authorize this private pixel profile.
    for (const id of ['00080016','00080060','07A10010','07A11011',PAYLOAD_TAG,'00280004',
        '00280010','00280011','00280008','00280002','00280100','00280101','00280102','00280103']) {
        const attribute=set?.find?.(Tag.find(id));
        if (attribute && (attribute.transferSyntax?.IsExplicit !== true || attribute.transferSyntax?.IsLittleEndian !== true)) {
            throw new Error('Philips private CT requires Explicit VR Little Endian dataset encoding.');
        }
    }
    profile.encodedLength = payload.valueLength;
    return Object.freeze(profile);
}

/**
 * Independent bounded byte-state decoder for the documented PMSCT_RLE1 grammar.
 * No expanded intermediate buffer is retained. RLE spans may cross image rows;
 * this private format is not the row-packed DICOM RLE transfer syntax.
 */
export function decodePhilipsRle1(encoded, profile, { signal, maxBytes = LIMIT } = {}) {
    const { samples, bytes } = dimensions(profile,maxBytes);
    if (signal != null && (!(signal instanceof AbortSignal))) throw new TypeError('Use an AbortSignal for Philips decoding.');
    const abort = () => { if (signal?.aborted) throw new DOMException('Philips decode canceled.','AbortError'); };
    abort();
    if (!(encoded instanceof Uint8Array) || encoded.byteLength < 2 || encoded.byteLength > LIMIT || encoded.byteLength % 2 !== 0
        || !Number.isSafeInteger(profile.encodedLength) || profile.encodedLength !== encoded.byteLength) invalid('encoded byte count does not match the private OB attribute');
    const output = new Uint8Array(bytes);
    let offset = 0, repeats = 0, repeatedByte = 0, written = 0, previous = 0;
    const next = () => {
        if (repeats) { repeats--; return repeatedByte; }
        if (offset >= encoded.length) invalid('truncated delta or absolute sample');
        const token = encoded[offset++];
        if (token !== 0xa5) return token;
        if (offset + 2 > encoded.length) invalid('truncated run escape');
        repeats = encoded[offset++] + 1;
        repeatedByte = encoded[offset++];
        repeats--;
        return repeatedByte;
    };
    while (written < samples) {
        if ((written & 4095) === 0) abort();
        const token = next();
        // The predictor is an unsigned16 word; signed byte deltas wrap modulo2^16.
        // Stored-bit masking remains the ordinary native decoder's responsibility.
        const current = token === 0x5a ? next() | next() << 8 : (previous + (token < 128 ? token : token - 256)) & 0xffff;
        output[written*2] = current & 0xff;
        output[written*2+1] = current >>> 8;
        previous = current; written++;
    }
    abort();
    // PS3.5§6.2 permits only one null OB pad for an odd-length encoded stream.
    // A partially consumed RLE packet cannot be mistaken for that padding.
    if (repeats !== 0) invalid('run expands beyond the declared image');
    const remaining = encoded.length - offset;
    if (!(remaining === 0 || remaining === 1 && offset % 2 === 1 && encoded[offset] === 0)) invalid('trailing bytes remain after the declared image');
    return output;
}
