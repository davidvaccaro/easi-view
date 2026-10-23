import { Tag } from '@xinonix/easi-js';
import { getAttributeVR } from './attributes.js';

const NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
const CODE = /^[A-Z0-9_ ]{1,16}$/u;
const FIELDS = ['temporalPositionIndex', 'effectiveEchoTime', 'echoNumbers', 'acquisitionNumber', 'imageType',
    'complexImageComponent', 'acquisitionContrast', 'diffusionBValue', 'diffusionDirection'];
export const CLASSIC_PET_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.128';
export const PET_DIMENSION_FIELDS = Object.freeze(['petSeriesType', 'petFrameReferenceTime', 'petTriggerTime', 'petLowRrValue', 'petHighRrValue',
    'petUnits', 'petDecayCorrection', 'petCorrectedImage', 'petCountsSource', 'petNumberOfSlices', 'petNumberOfTimeSlices',
    'petNumberOfTimeSlots', 'petNumberOfRrIntervals', 'petTimeSliceIndex', 'petTimeSlotIndex', 'petRrIntervalIndex', 'petSuvType']);
const PET_UNITS = new Set(['CNTS', 'NONE', 'CM2', 'CM2ML', 'PCNT', 'CPS', 'BQML', 'MGMINML', 'UMOLMINML', 'MLMING',
    'MLG', '1CM', 'UMOLML', 'PROPCNTS', 'PROPCPS', 'MLMINML', 'MLML', 'GML', 'STDDEV']);
const PET_CORRECTIONS = new Set(['DECY', 'ATTN', 'SCAT', 'DTIM', 'MOTN', 'PMOT', 'CLN', 'RAN', 'RADL', 'DCAL', 'NORM']);
const PET_SUV_TYPES = new Set(['BSA', 'BW', 'LBM', 'LBMJAMES128', 'LBMJANMA', 'IBW']);
const invalid = () => { throw new Error('Invalid classic image dimension scope.'); };
function attribute(set, id) { return set?.find?.(Tag.find(id)); }
function numeric(set, id, littleEndian) {
    const attr = attribute(set, id); if (!attr) return [];
    const vr = attr.vr?.ID ?? attr.tag?.VR?.ID, bytes = attr.access?.();
    if (vr === 'FD' && bytes?.byteLength) {
        if (bytes.byteLength % 8 || bytes.byteLength > 8 * 16) invalid();
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), result = [];
        for (let offset = 0; offset < bytes.byteLength; offset += 8) result.push(view.getFloat64(offset, attr.transferSyntax?.IsLittleEndian ?? littleEndian));
        if (!result.every(Number.isFinite)) invalid(); return result;
    }
    const raw = attr.value;
    if (raw == null || raw === '' || ArrayBuffer.isView(raw) && raw.byteLength === 0) return [];
    const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split('\\') : [raw];
    if (values.every(value => value == null || typeof value === 'string' && value.trim() === '')) return [];
    if (values.length > 16 || values.some(value => typeof value !== 'number' && (typeof value !== 'string' || !NUMERIC.test(value.trim())))) invalid();
    const result = values.map(Number); if (!result.every(Number.isFinite)) invalid(); return result;
}
function scalar(set, id, littleEndian, { integer = false, min = 0 } = {}) {
    const values = numeric(set, id, littleEndian);
    if (!values.length) return null;
    if (values.length !== 1 || values[0] < min || integer && (!Number.isSafeInteger(values[0]) || values[0] > 0xFFFFFFFF)) invalid();
    return values[0];
}
function codes(set, id, maximum = 16) {
    const raw = attribute(set, id)?.value;
    if (raw == null || raw === '') return [];
    const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split('\\') : [raw];
    if (values.every(value => value == null || typeof value === 'string' && value.trim() === '')) return [];
    if (values.length > maximum || values.some(value => typeof value !== 'string' || !CODE.test(value.trim()))) invalid();
    return values.map(value => value.trim());
}
function code(set, id) { return codes(set, id, 1)[0] ?? null; }
function petCodes(set, id, maximum = 16, vr = 'CS') {
    const attr = attribute(set, id);
    if (attr && getAttributeVR(attr) !== vr) invalid();
    return codes(set, id, maximum);
}
function petCode(set, id, vr = 'CS') { return petCodes(set, id, 1, vr)[0] ?? null; }
function petScalar(set, id, vr, littleEndian, options = {}) {
    const attr = attribute(set, id);
    if (attr && getAttributeVR(attr) !== vr) invalid();
    if (vr === 'US' && attr && attr.transferSyntax?.ID !== '0') {
        const bytes = attr.access?.();
        if (!bytes?.byteLength) return null;
        if (bytes.byteLength !== 2) invalid();
        const result = new DataView(bytes.buffer, bytes.byteOffset, 2).getUint16(0, attr.transferSyntax?.IsLittleEndian ?? littleEndian);
        if (result < (options.min ?? 0)) invalid();
        return result;
    }
    return scalar(set, id, littleEndian, options);
}

/** Units describe the source's rescaled values; this never computes or infers SUV. */
export function classicPetUnit(set) {
    const unit = petCode(set, '00541001');
    if (!PET_UNITS.has(unit)) throw new Error('Classic PET requires explicit supported Units (0054,1001); SUV is not inferred.');
    const rescaleType = petCode(set, '00281054', 'LO');
    if (rescaleType != null && rescaleType !== unit) throw new Error('Classic PET rescale units conflict with Units (0054,1001).');
    return unit;
}

function petDimensions(set, littleEndian) {
    const seriesType = petCodes(set, '00541000', 2);
    if (seriesType.length !== 2 || !['STATIC', 'WHOLE BODY', 'DYNAMIC', 'GATED'].includes(seriesType[0]) ||
        !['IMAGE', 'REPROJECTION'].includes(seriesType[1])) invalid();
    const dimensions = { petSeriesType: seriesType, petUnits: classicPetUnit(set),
        petFrameReferenceTime: petScalar(set, '00541300', 'DS', littleEndian),
        petTriggerTime: petScalar(set, '00181060', 'DS', littleEndian), petLowRrValue: petScalar(set, '00181081', 'IS', littleEndian),
        petHighRrValue: petScalar(set, '00181082', 'IS', littleEndian), petCountsSource: petCode(set, '00541002'),
        petDecayCorrection: petCode(set, '00541102'), petCorrectedImage: petCodes(set, '00280051'), petSuvType: petCode(set, '00541006'),
        petNumberOfSlices: petScalar(set, '00540081', 'US', littleEndian, { integer: true, min: 1 }),
        petNumberOfTimeSlices: petScalar(set, '00540101', 'US', littleEndian, { integer: true, min: 1 }),
        petNumberOfTimeSlots: petScalar(set, '00540071', 'US', littleEndian, { integer: true, min: 1 }),
        petNumberOfRrIntervals: petScalar(set, '00540061', 'US', littleEndian, { integer: true, min: 1 }),
        petTimeSliceIndex: null, petTimeSlotIndex: null, petRrIntervalIndex: null };
    const imageIndex = petScalar(set, '00541330', 'US', littleEndian, { integer: true, min: 1 });
    const slices = dimensions.petNumberOfSlices;
    if (dimensions.petFrameReferenceTime == null || slices == null || imageIndex == null ||
        !['EMISSION', 'TRANSMISSION'].includes(dimensions.petCountsSource) || !['NONE', 'START', 'ADMIN'].includes(dimensions.petDecayCorrection)) invalid();
    let imageCount = slices;
    if (seriesType[0] === 'DYNAMIC') {
        if (dimensions.petNumberOfTimeSlices == null) invalid();
        imageCount *= dimensions.petNumberOfTimeSlices;
        dimensions.petTimeSliceIndex = Math.floor((imageIndex - 1) / slices) + 1;
    } else if (seriesType[0] === 'GATED') {
        if (dimensions.petNumberOfTimeSlots == null || dimensions.petNumberOfRrIntervals == null || dimensions.petTriggerTime == null) invalid();
        imageCount *= dimensions.petNumberOfTimeSlots * dimensions.petNumberOfRrIntervals;
        dimensions.petTimeSlotIndex = Math.floor((imageIndex - 1) / slices) % dimensions.petNumberOfTimeSlots + 1;
        dimensions.petRrIntervalIndex = Math.floor((imageIndex - 1) / (slices * dimensions.petNumberOfTimeSlots)) + 1;
        const frameTime = petScalar(set, '00181063', 'DS', littleEndian);
        if (frameTime == null || frameTime <= 0) invalid();
        const beatRejection = petCode(set, '00181080');
        if (beatRejection != null && !['Y', 'N'].includes(beatRejection) ||
            beatRejection === 'Y' && (dimensions.petLowRrValue == null || dimensions.petHighRrValue == null)) invalid();
    }
    if (!Number.isSafeInteger(imageCount) || imageIndex > imageCount ||
        dimensions.petLowRrValue != null && dimensions.petHighRrValue != null && dimensions.petLowRrValue > dimensions.petHighRrValue) invalid();
    return dimensions;
}

/** Reject partial or unbounded PET family objects at spatial/linking boundaries. */
export function validatedPetDimensionValues(dimensions) {
    if (Object.keys(dimensions).some(field => field.startsWith('pet') && !PET_DIMENSION_FIELDS.includes(field))) invalid();
    if (!PET_DIMENSION_FIELDS.some(field => Object.hasOwn(dimensions, field))) return null;
    if (Object.keys(dimensions).some(field => ![...FIELDS, ...PET_DIMENSION_FIELDS, 'semanticScope', 'spatialEligible', 'invalid',
        'frameType', 'declaredSpacingBetweenSlices'].includes(field))) invalid();
    if (!PET_DIMENSION_FIELDS.every(field => Object.hasOwn(dimensions, field))) invalid();
    const d = dimensions, type = d.petSeriesType;
    if (!Array.isArray(type) || type.length !== 2 || !['STATIC', 'WHOLE BODY', 'DYNAMIC', 'GATED'].includes(type[0]) ||
        !['IMAGE', 'REPROJECTION'].includes(type[1]) || !PET_UNITS.has(d.petUnits) ||
        !['EMISSION', 'TRANSMISSION'].includes(d.petCountsSource) || !['NONE', 'START', 'ADMIN'].includes(d.petDecayCorrection) ||
        !Array.isArray(d.petCorrectedImage) || d.petCorrectedImage.length > 16 || d.petCorrectedImage.some(code => !PET_CORRECTIONS.has(code)) ||
        d.petSuvType != null && !PET_SUV_TYPES.has(d.petSuvType)) invalid();
    for (const field of ['petFrameReferenceTime', 'petTriggerTime', 'petLowRrValue', 'petHighRrValue']) {
        if (d[field] !== null && (!Number.isFinite(d[field]) || d[field] < 0 || d[field] > Number.MAX_SAFE_INTEGER)) invalid();
    }
    for (const field of ['petNumberOfSlices', 'petNumberOfTimeSlices', 'petNumberOfTimeSlots', 'petNumberOfRrIntervals', 'petTimeSliceIndex', 'petTimeSlotIndex', 'petRrIntervalIndex']) {
        if (d[field] !== null && (!Number.isSafeInteger(d[field]) || d[field] < 1 || d[field] > 0xFFFFFFFF)) invalid();
    }
    if (d.petFrameReferenceTime == null || d.petNumberOfSlices == null ||
        type[0] === 'DYNAMIC' && (d.petNumberOfTimeSlices == null || d.petTimeSliceIndex == null || d.petTimeSliceIndex > d.petNumberOfTimeSlices) ||
        type[0] === 'GATED' && (d.petTriggerTime == null || d.petNumberOfTimeSlots == null || d.petNumberOfRrIntervals == null ||
            d.petTimeSlotIndex == null || d.petTimeSlotIndex > d.petNumberOfTimeSlots || d.petRrIntervalIndex == null || d.petRrIntervalIndex > d.petNumberOfRrIntervals) ||
        d.petLowRrValue != null && d.petHighRrValue != null && d.petLowRrValue > d.petHighRrValue) invalid();
    const count = d.petNumberOfSlices * (type[0] === 'DYNAMIC' ? d.petNumberOfTimeSlices :
        type[0] === 'GATED' ? d.petNumberOfTimeSlots * d.petNumberOfRrIntervals : 1);
    if (!Number.isSafeInteger(count)) invalid();
    return PET_DIMENSION_FIELDS.map(field => Array.isArray(d[field]) ? [...d[field]] : d[field]);
}

/** Optional classic acquisition scope; malformed metadata permits only 2D viewing. */
export function resolveClassicDimensions(set, { modality = '', littleEndian = true, sopClass = '' } = {}) {
    const dimensions = { semanticScope: 'same-series-only', spatialEligible: true, invalid: false,
        temporalPositionIndex: null, effectiveEchoTime: null, echoNumbers: [], acquisitionNumber: null,
        imageType: [], frameType: [], complexImageComponent: null, acquisitionContrast: null,
        diffusionBValue: null, diffusionDirection: null, declaredSpacingBetweenSlices: null };
    try {
        dimensions.temporalPositionIndex = scalar(set, '00200100', littleEndian, { integer: true, min: 1 });
        dimensions.effectiveEchoTime = scalar(set, '00180081', littleEndian);
        dimensions.echoNumbers = numeric(set, '00180086', littleEndian);
        if (dimensions.echoNumbers.some(value => !Number.isSafeInteger(value) || value < 1 || value > 0xFFFFFFFF)) invalid();
        dimensions.acquisitionNumber = scalar(set, '00200012', littleEndian, { integer: true });
        dimensions.imageType = codes(set, '00080008'); dimensions.frameType = [...dimensions.imageType];
        dimensions.complexImageComponent = code(set, '00089208');
        if (!dimensions.complexImageComponent && modality === 'MR') dimensions.complexImageComponent =
            { M: 'MAGNITUDE', P: 'PHASE', R: 'REAL', I: 'IMAGINARY' }[dimensions.imageType[2]] ?? null;
        dimensions.acquisitionContrast = code(set, '00089209');
        dimensions.diffusionBValue = scalar(set, '00189087', littleEndian);
        const diffusion = numeric(set, '00189089', littleEndian);
        if (diffusion.length) {
            if (diffusion.length !== 3 || Math.abs(Math.hypot(...diffusion) - 1) > 0.001 && !(dimensions.diffusionBValue === 0 && diffusion.every(value => value === 0))) invalid();
            dimensions.diffusionDirection = diffusion;
        }
        dimensions.declaredSpacingBetweenSlices = scalar(set, '00180088', littleEndian);
        if (sopClass === CLASSIC_PET_SOP_CLASS) {
            Object.assign(dimensions, petDimensions(set, littleEndian));
            validatedPetDimensionValues(dimensions);
            // Reprojection planes are projections, never a tomographic volume.
            if (dimensions.petSeriesType[1] !== 'IMAGE') dimensions.spatialEligible = false;
        }
        if (FIELDS.some(field => Array.isArray(dimensions[field]) ? dimensions[field].length : dimensions[field] != null)) dimensions.semanticScope = 'classic-exposed-dimensions';
    } catch {
        dimensions.invalid = true; dimensions.spatialEligible = false; dimensions.semanticScope = 'invalid-classic-dimensions';
    }
    return dimensions;
}

/** No instance ordinal or position enters this nonspatial acquisition partition. */
export function classicDimensionKey(dimensions, instanceUid = '') {
    if (!dimensions || dimensions.invalid || dimensions.spatialEligible === false) return `ineligible:${instanceUid}`;
    const values = FIELDS.map(field => dimensions[field] ?? null), petValues = validatedPetDimensionValues(dimensions);
    return JSON.stringify(petValues ? [...values, petValues] : values);
}

/** Sequential PET slice timing may vary within one static/whole-body 2D browsing stack. */
export function classicNavigationKey(dimensions, instanceUid = '') {
    if (!dimensions || dimensions.invalid || dimensions.spatialEligible === false) return `ineligible:${instanceUid}`;
    const values = FIELDS.map(field => dimensions[field] ?? null), petValues = validatedPetDimensionValues(dimensions);
    if (petValues && ['STATIC', 'WHOLE BODY'].includes(dimensions.petSeriesType[0]) && dimensions.petSeriesType[1] === 'IMAGE') {
        // These are copied key values. Per-frame dimensions remain intact for
        // quantitative, linking and reconstruction validation.
        petValues[PET_DIMENSION_FIELDS.indexOf('petFrameReferenceTime')] = null;
    }
    return JSON.stringify(petValues ? [...values, petValues] : values);
}

/** Compare every scope value supplied by metadata; absent QIDO fields remain unknown. */
export function validateClassicDimensions(actual, expected) {
    if (!expected) return;
    for (const field of [...FIELDS, ...PET_DIMENSION_FIELDS, 'declaredSpacingBetweenSlices']) {
        const value = expected[field];
        if (value == null || Array.isArray(value) && !value.length) continue;
        if (JSON.stringify(actual?.[field]) !== JSON.stringify(value)) throw new Error('The retrieved DICOM acquisition dimensions do not match its archive metadata.');
    }
}
