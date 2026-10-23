import { Tag } from '@xinonix/easi-js';

import { MAX_LUT_ENTRIES, normalizeVoi } from './presentation-math.js';
export { MAX_LUT_ENTRIES, MAX_PALETTE_PIXELS, evaluateModality, normalizeVoi, storedToDisplay, paletteToRgb } from './presentation-math.js';
const VOI_FUNCTIONS = new Set(['LINEAR', 'LINEAR_EXACT', 'SIGMOID']);
const SCALAR = new Set(['MONOCHROME1', 'MONOCHROME2']);
const PALETTE_DESCRIPTORS = ['00281101', '00281102', '00281103'];
const PALETTE_DATA = ['00281201', '00281202', '00281203'];

function invalid(message) { throw new Error(`Unsupported or invalid DICOM presentation: ${message}.`); }
function attribute(set, id) { return set?.find(Tag.find(id)); }
function has(set, id) { return attribute(set, id) != null; }
function value(set, id, fallback = null) { return attribute(set, id)?.value ?? fallback; }
function text(set, id, fallback = '') {
    const raw = value(set, id, fallback);
    const values = Array.isArray(raw) ? raw : [raw];
    if (values.length !== 1 || typeof values[0] !== 'string') invalid('text metadata has an invalid value multiplicity');
    return values[0].trim();
}
function numbers(set, id) {
    const raw = value(set, id);
    if (raw == null || raw === '') return [];
    const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split('\\') : [raw];
    return values.map(item => {
        if (typeof item === 'string') {
            if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(item.trim())) invalid('numeric metadata is malformed');
            item = Number(item);
        }
        if (typeof item !== 'number' || !Number.isFinite(item)) invalid('numeric metadata is malformed');
        return item;
    });
}
function scalarNumber(set, id, fallback) {
    const list = numbers(set, id);
    if (list.length > 1) invalid('scalar metadata has multiple values');
    return list[0] ?? fallback;
}
function binary(attr) {
    const raw = attr?.access?.();
    if (raw?.byteLength) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    const decoded = attr?.value;
    if (ArrayBuffer.isView(decoded)) return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
    if (decoded instanceof ArrayBuffer) return new Uint8Array(decoded);
    return null;
}
function sequence(set, id, single = false) {
    const attr = attribute(set, id);
    if (!attr) return null;
    if (!Array.isArray(attr.items) || !attr.items.length || single && attr.items.length !== 1 ||
        typeof attr.items[0]?.find !== 'function') invalid('a LUT sequence has no valid selected item');
    return attr.items;
}

function cached(cache, owner, key, create) {
    if (!cache) return create();
    let variants = cache.get(owner);
    if (!variants) { variants = new Map(); cache.set(owner, variants); }
    if (!variants.has(key)) variants.set(key, create());
    return variants.get(key);
}

function descriptor(attr, { signed, littleEndian }, label) {
    if (!attr || attr.isComplete === false) invalid(`${label} descriptor is missing or incomplete`);
    const raw = binary(attr);
    let count, firstMapped, bits;
    if (raw) {
        if (raw.byteLength !== 6) invalid(`${label} descriptor must have exactly three words`);
        const explicitVr = attr.transferSyntax?.IsExplicit ? attr.vr?.ID : null;
        if (explicitVr != null && explicitVr !== (signed ? 'SS' : 'US')) invalid(`${label} descriptor VR conflicts with its input signedness`);
        const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        count = view.getUint16(0, littleEndian);
        firstMapped = signed ? view.getInt16(2, littleEndian) : view.getUint16(2, littleEndian);
        bits = view.getUint16(4, littleEndian);
    } else {
        // EASI's JSON adapter keeps already-decoded numeric Value arrays but
        // does not retain the declared VR on the materialized Attribute.
        const decoded = attr.value;
        if (!Array.isArray(decoded) || decoded.length !== 3) invalid(`${label} descriptor must have exactly three values`);
        [count, firstMapped, bits] = decoded;
    }
    if (![count, firstMapped, bits].every(Number.isSafeInteger) || count < 0 || count > 65535 ||
        firstMapped < (signed ? -32768 : 0) || firstMapped > (signed ? 32767 : 65535) || ![8, 16].includes(bits)) {
        invalid(`${label} descriptor has unsupported count, range or precision`);
    }
    return { count: count || MAX_LUT_ENTRIES, firstMapped, bits };
}

function entries(attr, desc, { littleEndian, metadataOnly }, label) {
    if (!attr || attr.isComplete === false) invalid(`${label} data is missing or incomplete`);
    const raw = binary(attr);
    if (!raw) {
        const decoded = attr.value;
        // A metadata-only external table stays pending. No URI is retained and
        // no evaluator is allowed to use this as an identity transformation.
        if (metadataOnly && attr.transferSyntax?.ID === '0' && typeof decoded === 'string' && /^https?:\/\//i.test(decoded)) return null;
        const values = Array.isArray(decoded) ? decoded : [decoded];
        if (values.length !== desc.count || values.some(item => !Number.isInteger(item) || item < 0 || item > 2 ** desc.bits - 1)) {
            invalid(`${label} numeric data does not match its descriptor`);
        }
        return Uint16Array.from(values);
    }
    const vr = attr.vr?.ID;
    if (vr != null && !['US', 'OW'].includes(vr)) invalid(`${label} data requires US or OW`);
    const packedLength = desc.count + desc.count % 2;
    const words = raw.byteLength === desc.count * 2;
    const packed = desc.bits === 8 && raw.byteLength === packedLength && vr !== 'US';
    if (!words && !packed) invalid(`${label} data length does not match its descriptor`);
    const result = new Uint16Array(desc.count);
    if (words) {
        const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        for (let index = 0; index < result.length; index++) {
            const entry = view.getUint16(index * 2, littleEndian);
            if (entry > 2 ** desc.bits - 1) invalid(`${label} 8-in-16 data has nonzero high bits`);
            result[index] = entry;
        }
    } else {
        // Packed 8-bit OW values retain word byte ordering, including final
        // odd-entry padding. Never guess high-byte storage or scale values.
        for (let index = 0; index < result.length; index++) result[index] = raw[littleEndian ? index : index ^ 1];
        if (desc.count % 2 && raw[littleEndian ? desc.count : desc.count ^ 1] !== 0) invalid(`${label} data has nonzero padding`);
    }
    return result;
}

function normalizeLut(item, options, label, modality = false) {
    const key = `${modality ? 'modality' : 'voi'}:${options.signed}:${options.littleEndian}:${options.metadataOnly}`;
    return cached(options.lutCache, item, key, () => {
        const desc = descriptor(attribute(item, '00283002'), options, label);
        const table = entries(attribute(item, '00283006'), desc, options, label);
        const unit = modality ? text(item, '00283004') : undefined;
        if (modality && !unit) invalid('Modality LUT Type is required');
        // Complete EASI items and owned entry arrays are immutable inputs for
        // this per-instance cache. Callers must not mutate table entries.
        return Object.freeze({ ...desc, entries: table, pending: table === null,
            explanation: text(item, '00283003'), ...(modality ? { unit } : {}) });
    });
}

/** Strict image presentation profile: first window/VOI option, one modality item, direct RGB palette. */
export function normalizePresentation(dataSet, options = {}) {
    if (typeof dataSet?.find !== 'function') invalid('an EASI dataset is required');
    const signed = options.signed ?? scalarNumber(dataSet, '00280103', 0) === 1;
    const littleEndian = options.littleEndian ?? true;
    const photometric = options.photometric ?? text(dataSet, '00280004', 'MONOCHROME2');
    if (options.lutCache !== undefined && !(options.lutCache instanceof Map || options.lutCache instanceof WeakMap)) {
        invalid('the internal LUT cache must be a Map or WeakMap');
    }
    if (typeof signed !== 'boolean' || typeof littleEndian !== 'boolean') invalid('pixel signedness or byte order is invalid');
    if (has(dataSet, '00409096')) invalid('real-world value mappings require a separate quantitative profile');
    if (has(dataSet, '20500010')) invalid('Presentation LUT Sequence requires a separate profile');
    const shape = text(dataSet, '20500020');
    if (!['', 'IDENTITY', 'INVERSE'].includes(shape) || shape === 'IDENTITY' && photometric === 'MONOCHROME1' ||
        shape === 'INVERSE' && photometric !== 'MONOCHROME1') invalid('Presentation LUT Shape conflicts with the image photometric interpretation');
    const presentationInvert = shape ? shape === 'INVERSE' : photometric === 'MONOCHROME1';
    const modalityItems = sequence(dataSet, '00283000', true);
    const voiItems = sequence(dataSet, '00283010');
    if (modalityItems && (has(dataSet, '00281052') || has(dataSet, '00281053'))) invalid('Modality LUT and rescale cannot both be present');
    const slope = options.slope ?? scalarNumber(dataSet, '00281053', 1);
    const intercept = options.intercept ?? scalarNumber(dataSet, '00281052', 0);
    if (!Number.isFinite(slope) || slope === 0 || !Number.isFinite(intercept)) invalid('rescale values are invalid');
    if (has(dataSet, '00281052') !== has(dataSet, '00281053')) invalid('rescale requires both slope and intercept');
    const lutOptions = { signed, littleEndian, metadataOnly: options.metadataOnly === true, lutCache: options.lutCache };
    const modalityLut = modalityItems ? normalizeLut(modalityItems[0], lutOptions, 'Modality LUT', true) : null;
    let voiSigned = signed;
    if (modalityLut) voiSigned = false;
    else if (has(dataSet, '00281053') || options.slope != null || options.intercept != null) {
        const bits = options.bitsStored ?? scalarNumber(dataSet, '00280101', 16);
        if (!Number.isInteger(bits) || bits < 1 || bits > 16) invalid('Bits Stored is required to determine the VOI input range');
        const first = signed ? -(2 ** (bits - 1)) : 0;
        const last = signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1;
        const firstValue = first * slope + intercept, lastValue = last * slope + intercept;
        if (!Number.isFinite(firstValue) || !Number.isFinite(lastValue)) invalid('the modality output range is not finite');
        voiSigned = Math.min(firstValue, lastValue) < 0 || text(dataSet, '00281054') === 'HU';
    }
    const voiLut = voiItems ? normalizeLut(voiItems[0], { ...lutOptions, signed: voiSigned }, 'VOI LUT') : null;
    if (voiLut && !modalityLut && (!Number.isInteger(slope) || !Number.isInteger(intercept))) {
        invalid('fractional modality rescale with a VOI LUT needs an explicit table-input quantization profile');
    }
    const voiFunction = text(dataSet, '00281056', 'LINEAR');
    if (!VOI_FUNCTIONS.has(voiFunction)) invalid('VOI LUT Function is not supported');
    const centers = numbers(dataSet, '00281050'), widths = numbers(dataSet, '00281051');
    if (centers.length !== widths.length) invalid('Window Center and Width multiplicities differ');
    for (let index = 0; index < centers.length; index++) normalizeVoi(centers[index], widths[index], voiFunction);
    const window = centers.length ? { center: centers[0], width: widths[0] } : null;
    const paletteTags = [...PALETTE_DESCRIPTORS, ...PALETTE_DATA];
    if (['00281104', '00281204', '00281224', '00281221', '00281222', '00281223', '0028140B',
        '00281111', '00281112', '00281113', '00281211', '00281212', '00281213', '00480120'].some(id => has(dataSet, id))) {
        invalid('alpha, segmented and enhanced palettes require a separate profile');
    }
    let palette = null;
    if (photometric === 'PALETTE COLOR') {
        if (modalityLut || voiLut || slope !== 1 || intercept !== 0 || centers.length || has(dataSet, '00281056')) {
            invalid('palette indices cannot use scalar modality or VOI transforms');
        }
        const descriptors = PALETTE_DESCRIPTORS.map(id => descriptor(attribute(dataSet, id), lutOptions, 'Palette Color LUT'));
        const desc = descriptors[0];
        if (descriptors.some(item => item.count !== desc.count || item.firstMapped !== desc.firstMapped || item.bits !== desc.bits)) invalid('RGB palette descriptors must match');
        const channels = PALETTE_DATA.map(id => {
            const attr = attribute(dataSet, id);
            if (!attr) invalid('Palette Color LUT data is missing');
            const key = `palette:${signed}:${littleEndian}:${lutOptions.metadataOnly}:${desc.count}:${desc.firstMapped}:${desc.bits}`;
            return cached(options.lutCache, attr, key, () => entries(attr, desc, lutOptions, 'Palette Color LUT'));
        });
        palette = { ...desc, red: channels[0], green: channels[1], blue: channels[2], pending: channels.some(channel => channel === null) };
    } else if (paletteTags.some(id => has(dataSet, id))) invalid('supplemental palettes require a separate profile');
    if (!SCALAR.has(photometric) && (modalityLut || voiLut)) invalid('color images cannot use scalar LUT transforms');
    return { modalityLut, voiLut, palette, presentationInvert, slope, intercept,
        window: SCALAR.has(photometric) ? window : null, voiFunction,
        unit: modalityLut?.unit ?? text(dataSet, '00281054'), voiMode: voiLut ? 'lut' : 'window' };
}

