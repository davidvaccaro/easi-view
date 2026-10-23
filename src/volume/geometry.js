export const MAX_VOLUME_BYTES = 128 * 1024 * 1024;
export const MAX_VOLUME_FRAMES = 4096;
export const VOLUME_BYTES_PER_VOXEL = 11; // Stored16 + modality64 + validity8.
const TOLERANCE = 0.0001;
const UID = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))+$/u;
import { PET_DIMENSION_FIELDS, validatedPetDimensionValues } from '../data/classic-dimensions.js';
export function reconstructionError(reason) { return new Error(`Unsupported reconstruction: ${reason}.`); }
export function checkSignal(signal) { if (signal?.aborted) throw new DOMException('Reconstruction was canceled.', 'AbortError'); }
export function vector(value, length = 3) {
    if (!Array.isArray(value) || value.length !== length || value.some(component => !Number.isFinite(component) || Math.abs(component) > 1e9)) {
        throw reconstructionError('finite, bounded patient geometry is required');
    }
    return [...value];
}
export const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
export const subtract = (a, b) => a.map((value, index) => value - b[index]);
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export function direction(value) {
    const result = vector(value);
    if (Math.abs(Math.hypot(...result) - 1) > TOLERANCE) throw reconstructionError('direction cosines must be unit vectors');
    return result;
}
export function orientation(value) {
    const result = vector(value, 6), x = direction(result.slice(0, 3)), y = direction(result.slice(3));
    if (Math.abs(dot(x, y)) > TOLERANCE) throw reconstructionError('image orientation must be orthonormal');
    return { x, y, normal: cross(x, y).map(value => value / Math.hypot(...cross(x, y))) };
}
function uid(value) {
    if (typeof value !== 'string' || value.length > 64 || !UID.test(value)) throw reconstructionError('valid Series and Frame of Reference UIDs are required');
    return value;
}
function integer(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }
function finiteScope(value, arrayAllowed = true) {
    if (value == null) return null;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.length <= 64) return value;
    if (arrayAllowed && Array.isArray(value) && value.length <= 16) return value.map(component => finiteScope(component, false));
    throw reconstructionError('nonspatial dimensions are invalid');
}
const SCOPE_FIELDS = ['stackId', 'temporalPositionIndex', 'temporalPositionTimeOffset', 'effectiveEchoTime', 'echoNumber', 'echoNumbers',
    'acquisitionNumber', 'diffusionBValue', 'diffusionDirection', 'complexImageComponent', 'acquisitionContrast', 'frameType', 'imageType'];
const ENHANCED_FIELDS = ['frameOfReferenceUid', 'concatenationUid', 'logicalFrameIndex', 'inStackPositionNumber', 'dimensionIndexValues', 'indices',
    'volumetricProperties', 'frameAcquisitionNumber', 'frameAcquisitionDuration', 'frameReferenceDateTime', 'frameAcquisitionDateTime'];
const EXTRA_FIELDS = ['invalid', 'spatialEligible', 'declaredSpacingBetweenSlices', 'semanticScope'];

function family(frame) {
    const scope = frame.dimensions ?? frame.classicDimensions ?? frame.dimensionScope ?? frame.syncDimensions;
    if (scope == null) return { key: JSON.stringify([SCOPE_FIELDS.map(() => null), []]), values: SCOPE_FIELDS.map(() => null), indices: [], semanticScope: 'same-series-only' };
    if (typeof scope !== 'object' || Array.isArray(scope) || scope.invalid || scope.spatialEligible === false ||
        Object.keys(scope).some(key => ![...SCOPE_FIELDS, ...ENHANCED_FIELDS, ...EXTRA_FIELDS, ...PET_DIMENSION_FIELDS].includes(key))) {
        throw reconstructionError('nonspatial dimension scope is unknown or ineligible');
    }
    if (scope.volumetricProperties != null && scope.volumetricProperties !== 'VOLUME') throw reconstructionError('volumetric geometry is ineligible');
    if (scope.semanticScope != null && !['same-series-only', 'classic-exposed-dimensions', 'enhanced-verified-dimensions'].includes(scope.semanticScope)) {
        throw reconstructionError('nonspatial semantic scope is invalid');
    }
    if (scope.frameOfReferenceUid != null && scope.frameOfReferenceUid !== frame.frameOfReferenceUid) throw reconstructionError('dimension Frame of Reference conflicts with the frame');
    if (scope.echoNumbers != null && (!Array.isArray(scope.echoNumbers) || scope.echoNumbers.length > 1 || scope.echoNumbers.some(value => !integer(value, 1, 0xFFFFFFFF)))) {
        throw reconstructionError('one validated echo family is required');
    }
    for (const field of ['temporalPositionIndex', 'echoNumber']) {
        if (scope[field] != null && !integer(scope[field], 1, 0xFFFFFFFF)) throw reconstructionError('temporal or echo index is invalid');
    }
    for (const field of ['effectiveEchoTime', 'diffusionBValue']) {
        if (scope[field] != null && (!Number.isFinite(scope[field]) || scope[field] < 0)) throw reconstructionError('echo or diffusion scope is invalid');
    }
    if (scope.acquisitionNumber != null && !integer(scope.acquisitionNumber, 0, 0xFFFFFFFF)) throw reconstructionError('acquisition scope is invalid');
    const indices = scope.indices ?? [];
    if (!Array.isArray(indices) || indices.length > 32 || indices.some(index => index?.known !== true || index.resolved !== true || typeof index.spatial !== 'boolean')) {
        throw reconstructionError('unknown or unresolved dimension indices');
    }
    const resolved = indices.filter(index => !index.spatial).map(index => {
        if (!integer(index.ordinal, 1, 0xFFFFFFFF) || typeof index.indexPointer !== 'string' || !/^[0-9A-F]{8}$/u.test(index.indexPointer)) {
            throw reconstructionError('nonspatial dimension index is invalid');
        }
        return [uid(index.organizationUid), index.indexPointer, finiteScope(index.functionalGroupPointer), index.ordinal];
    });
    let petValues;
    try { petValues = validatedPetDimensionValues(scope); }
    catch { throw reconstructionError('PET temporal, gating or calibration scope is invalid'); }
    if (petValues && (frame.modality !== 'PT' || frame.unit !== scope.petUnits || scope.petSeriesType[1] !== 'IMAGE')) {
        throw reconstructionError('PET units or tomographic image scope conflicts with the frame');
    }
    const values = [...SCOPE_FIELDS.map(field => finiteScope(scope[field])), ...(petValues ? [petValues] : [])];
    return { key: JSON.stringify([values, resolved]), values, indices: resolved,
        semanticScope: frame.dimensions ? 'enhanced-verified-dimensions' : scope.semanticScope ?? 'classic-exposed-dimensions' };
}

/** Missing classic archive scope fields may be enriched; supplied values never change. */
export function compatibleFrameScope(expected, actual) {
    if (expected.semanticScope === 'enhanced-verified-dimensions') return expected.key === actual.key && actual.semanticScope === expected.semanticScope;
    return expected.values.every((value, index) => value == null || Array.isArray(value) && value.length === 0 ||
        JSON.stringify(value) === JSON.stringify(actual.values[index])) &&
        (!expected.indices.length || JSON.stringify(expected.indices) === JSON.stringify(actual.indices));
}

export function frameGeometry(frame) {
    if (!frame || !integer(frame.rows, 1, 8192) || !integer(frame.columns, 1, 8192) || frame.rows * frame.columns > 16 * 1024 * 1024 ||
        frame.samplesPerPixel !== 1 || !['MONOCHROME1', 'MONOCHROME2'].includes(frame.photometric) ||
        ![8, 16].includes(frame.bitsAllocated) || !integer(frame.bitsStored, 1, frame.bitsAllocated) ||
        !integer(frame.highBit, frame.bitsStored - 1, frame.bitsAllocated - 1) || typeof frame.signed !== 'boolean') {
        throw reconstructionError('a consistent scalar monochrome stored-pixel profile is required');
    }
    const frameOfReferenceUid = uid(frame.frameOfReferenceUid), seriesUid = uid(frame.seriesUid), sopUid = uid(frame.sopUid);
    if (!integer(frame.frameIndex, 0, 4095)) throw reconstructionError('an original frame index is required');
    if (typeof frame.modality !== 'string' || !/^[A-Z0-9_]{1,16}$/u.test(frame.modality) ||
        typeof frame.unit !== 'string' || frame.unit.length > 64) throw reconstructionError('explicit modality and units are required');
    const spacing = vector(frame.pixelSpacing, 2);
    if (spacing.some(value => value <= 0 || value > 10000)) throw reconstructionError('positive physical Pixel Spacing is required');
    const basis = orientation(frame.orientation), position = vector(frame.position);
    const scope = family(frame), declaredSpacing = frame.spacingBetweenSlices ?? frame.declaredSpacingBetweenSlices ?? frame.classicDimensions?.declaredSpacingBetweenSlices ??
        frame.dimensionScope?.declaredSpacingBetweenSlices ?? frame.syncDimensions?.declaredSpacingBetweenSlices ?? null;
    if (declaredSpacing != null && (!Number.isFinite(declaredSpacing) || declaredSpacing <= 0 || declaredSpacing > 10000)) {
        throw reconstructionError('declared slice spacing is invalid');
    }
    const pixelSignature = JSON.stringify([frame.rows, frame.columns, frameOfReferenceUid, seriesUid, frame.modality, frame.unit,
        frame.photometric, frame.bitsAllocated, frame.bitsStored, frame.highBit, frame.signed]);
    const signature = JSON.stringify([pixelSignature, scope.semanticScope, scope.key]);
    return { ...basis, position, spacing, frameOfReferenceUid, seriesUid, sopUid, frameIndex: frame.frameIndex, modality: frame.modality, unit: frame.unit,
        scope, declaredSpacing, signature, pixelSignature };
}

function inverseBasis(x, y, z) {
    const determinant = dot(x, cross(y, z));
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) throw reconstructionError('volume affine is singular');
    return [...cross(y, z), ...cross(z, x), ...cross(x, y)].map(value => value / determinant);
}
function frozen(values) { return Object.freeze([...values]); }

/** Validate supplied lattice; never use SliceThickness or SliceLocation as position. */
export function validateVolumeGeometry(frames, { maxBytes = MAX_VOLUME_BYTES } = {}) {
    if (!Array.isArray(frames) || frames.length < 2 || frames.length > MAX_VOLUME_FRAMES || !integer(maxBytes, 1, MAX_VOLUME_BYTES)) {
        throw reconstructionError('two or more frames and a bounded volume budget are required');
    }
    const first = frames[0], reference = frameGeometry(first);
    const voxelCount = first.rows * first.columns * frames.length, bytes = voxelCount * VOLUME_BYTES_PER_VOXEL;
    if (!Number.isSafeInteger(bytes) || bytes > maxBytes) throw reconstructionError('the stored, modality and mask volume exceeds its byte budget');
    const identifiers = new Set();
    const entries = frames.map((frame, index) => {
        const g = frameGeometry(frame);
        const identity = `${g.sopUid}/${g.frameIndex}`;
        if (identifiers.has(identity)) throw reconstructionError('duplicate original source frame');
        identifiers.add(identity);
        if (g.signature !== reference.signature) throw reconstructionError('Series, Frame of Reference, scalar profile, units or nonspatial family differs');
        if (g.x.some((value, axis) => Math.abs(value - reference.x[axis]) > 0.00001) ||
            g.y.some((value, axis) => Math.abs(value - reference.y[axis]) > 0.00001) ||
            g.spacing.some((value, axis) => Math.abs(value - reference.spacing[axis]) > Math.max(0.00001, value * 0.00001))) {
            throw reconstructionError('in-plane orientation or Pixel Spacing differs');
        }
        return { index, geometry: g, projection: dot(g.position, reference.normal) };
    }).sort((a, b) => a.projection - b.projection);
    const origin = entries[0].geometry.position, z = subtract(entries[1].geometry.position, origin);
    const distance = dot(z, reference.normal);
    if (distance <= TOLERANCE || Math.hypot(...z) > 10000) throw reconstructionError('duplicate, degenerate or unbounded slice positions');
    const toleranceMm = Math.max(TOLERANCE, distance * 0.001);
    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index], expected = origin.map((value, axis) => value + index * z[axis]);
        if (Math.hypot(...subtract(entry.geometry.position, expected)) > toleranceMm) throw reconstructionError('irregular slice spacing, a gap or changing gantry shear');
        if (entry.geometry.declaredSpacing != null && Math.abs(entry.geometry.declaredSpacing - distance) > toleranceMm) {
            throw reconstructionError('supplied planes disagree with declared slice spacing');
        }
    }
    const x = reference.x.map(value => value * reference.spacing[1]), y = reference.y.map(value => value * reference.spacing[0]);
    const inverse = inverseBasis(x, y, z);
    const inPlane = z.map((value, axis) => value - reference.normal[axis] * distance);
    return Object.freeze({ rows: first.rows, columns: first.columns, depth: frames.length, voxelCount, bytes, signed: first.signed,
        bitsStored: first.bitsStored, origin: frozen(origin), basisX: frozen(x), basisY: frozen(y), basisZ: frozen(z), inverse: frozen(inverse),
        normal: frozen(reference.normal), sliceDistanceMm: distance, sheared: Math.hypot(...inPlane) > toleranceMm,
        sourceIndices: frozen(entries.map(entry => entry.index)), frameOfReferenceUid: reference.frameOfReferenceUid,
        seriesUid: reference.seriesUid, modality: reference.modality, unit: reference.unit, semanticScope: reference.scope.semanticScope });
}

/** Voxel indices are center-based: [0,0,0] is the first transmitted voxel center. */
export function voxelToPatient(geometry, voxel) {
    const p = vector(voxel);
    const result = geometry.origin.map((value, axis) => value + geometry.basisX[axis] * p[0] + geometry.basisY[axis] * p[1] + geometry.basisZ[axis] * p[2]);
    if (!result.every(Number.isFinite)) throw reconstructionError('patient coordinate exceeds numeric range');
    return result;
}
export function patientToVoxel(geometry, patient) {
    const p = subtract(vector(patient), geometry.origin), m = geometry.inverse;
    const result = [m[0] * p[0] + m[1] * p[1] + m[2] * p[2], m[3] * p[0] + m[4] * p[1] + m[5] * p[2], m[6] * p[0] + m[7] * p[1] + m[8] * p[2]];
    if (!result.every(Number.isFinite)) throw reconstructionError('voxel coordinate exceeds numeric range');
    return result;
}
