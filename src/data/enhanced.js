import { Tag } from '@xinonix/easi-js';
import { resolveFrameTiming } from './frame-timing.js';
import { getAttributeVR } from './attributes.js';

export const ENHANCED_SOP_CLASSES = new Set([
    '1.2.840.10008.5.1.4.1.1.2.1', '1.2.840.10008.5.1.4.1.1.2.2',
    '1.2.840.10008.5.1.4.1.1.4.1', '1.2.840.10008.5.1.4.1.1.4.4'
]);
const NATIVE_SYNTAXES = new Set(['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']);
const EMPTY_PROJECTION_WARNING = 'Limited 2D viewing: enhanced dimension organization is empty. Showing sampled CT projection frames in original encoded order; spatial linking and reconstruction are unavailable.';
const MACRO = {
    measures: '00289110', position: '00209113', orientation: '00209116',
    rescale: '00289145', voi: '00289132', content: '00209111', echo: '00189114',
    mrType: '00189226', ctType: '00189329', diffusion: '00189117', temporal: '00209310'
};
const SPATIAL_POINTERS = new Map([['00209057', MACRO.content], ['00200032', MACRO.position]]);
const KNOWN_POINTERS = new Map([...SPATIAL_POINTERS, ['00209056', MACRO.content],
    ['00209128', MACRO.content], ['00189082', MACRO.echo], ['00180086', null],
    ['00200037', MACRO.orientation], ['00189087', MACRO.diffusion], ['0020930D', MACRO.temporal]]);

function fail(message = 'Invalid enhanced DICOM functional-group metadata.') { throw new Error(message); }
function attribute(set, id) { return set?.find?.(Tag.find(id)); }
function raw(set, id) { return attribute(set, id)?.value ?? null; }

function sequence(set, id, { required = false, single = false, max = 4096 } = {}) {
    const attr = attribute(set, id);
    if (!attr) { if (required) fail('The enhanced DICOM image is missing required functional groups.'); return null; }
    if (!Array.isArray(attr.items) || attr.items.length > max || single && attr.items.length !== 1 ||
        attr.items.some(item => !item || typeof item.find !== 'function' || !Array.isArray(item.attributes))) fail();
    return attr.items;
}

function numeric(set, id, littleEndian = true) {
    const attr = attribute(set, id);
    if (!attr) return [];
    const value = attr.value;
    const vr = attr.vr?.ID ?? attr.tag.VR?.ID;
    const binary = { US: [2, 'getUint16'], SS: [2, 'getInt16'], UL: [4, 'getUint32'],
        SL: [4, 'getInt32'], FL: [4, 'getFloat32'], FD: [8, 'getFloat64'] }[vr];
    const bytes = attr.access?.();
    if (binary && bytes?.byteLength) {
        if (bytes.byteLength % binary[0]) fail();
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const endian = attr.transferSyntax?.IsLittleEndian ?? littleEndian;
        const values = [];
        for (let offset = 0; offset < bytes.byteLength; offset += binary[0]) values.push(view[binary[1]](offset, endian));
        if (!values.every(Number.isFinite)) fail();
        return values;
    }
    if (binary && attr._value == null && !bytes?.byteLength) return [];
    if (value == null || typeof value === 'string' && value.trim() === '' || ArrayBuffer.isView(value) && !value.byteLength) return [];
    const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split('\\') : [value];
    if (values.every(item => item == null || typeof item === 'string' && item.trim() === '')) return [];
    if (values.some(item => typeof item !== 'number' && (typeof item !== 'string' ||
        !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(item.trim())))) fail();
    const result = values.map(Number);
    if (!result.every(Number.isFinite)) fail();
    return result;
}

function scalar(set, id, littleEndian, { required = false, min = -Infinity, max = Infinity, integer = false } = {}) {
    const values = numeric(set, id, littleEndian);
    if (!values.length && !required) return null;
    if (values.length !== 1 || values[0] < min || values[0] > max || integer && !Number.isSafeInteger(values[0])) fail();
    return values[0];
}

function text(set, id, { required = false, max = 256 } = {}) {
    const attr = attribute(set, id);
    const encoded = attr?.tag.VR?.ID === 'DT' ? attr.access?.() : null;
    let value = encoded?.byteLength ? new TextDecoder().decode(encoded).replace(/\0/g, '').trim() : attr?.value ?? null;
    if (Array.isArray(value)) { if (value.length > 1) fail(); value = value[0]; }
    if (value == null || value === '') { if (required) fail(); return null; }
    if (typeof value !== 'string' || value.length > max || value.includes('\\')) fail();
    const result = value.trim();
    if (!result && required) fail();
    return result || null;
}

function dateTime(set, id) {
    const value = text(set, id, { max: 26 });
    if (value != null && !/^(?:\d{4}|\d{6}|\d{8}|\d{10}|\d{12}|\d{14}(?:\.\d{1,6})?)(?:[+-]\d{4})?$/.test(value)) fail();
    return value;
}

function uid(set, id, required = false) {
    const value = text(set, id, { required, max: 64 });
    if (value != null && !/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))+$/u.test(value)) fail('Invalid enhanced DICOM spatial or dimension identifier.');
    return value;
}

function vector(set, id, count, littleEndian, validate = () => true) {
    const values = numeric(set, id, littleEndian);
    if (!values.length) return null;
    if (values.length !== count || !validate(values)) fail('Invalid enhanced DICOM patient geometry.');
    return values;
}

function orientation(values) {
    const a = values.slice(0, 3), b = values.slice(3);
    return Math.abs(Math.hypot(...a) - 1) <= 0.001 && Math.abs(Math.hypot(...b) - 1) <= 0.001 &&
        Math.abs(a.reduce((sum, component, index) => sum + component * b[index], 0)) <= 0.001;
}

function tagPointer(set, id, littleEndian, required = false) {
    const attr = attribute(set, id);
    if (!attr) { if (required) fail(); return null; }
    const value = attr.value;
    if (value instanceof Uint8Array) {
        if (value.byteLength !== 4) fail();
        const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
        return Tag.identifier(view.getUint16(0, attr.transferSyntax?.IsLittleEndian ?? littleEndian),
            view.getUint16(2, attr.transferSyntax?.IsLittleEndian ?? littleEndian));
    }
    const values = Array.isArray(value) ? value : [value];
    if (values.length !== 1 || typeof values[0] !== 'string' || !/^[0-9a-fA-F]{8}$/.test(values[0])) fail();
    return values[0].toUpperCase();
}

function dimensions(set, littleEndian, { allowEmpty = false } = {}) {
    const definitions = sequence(set, '00209222', { max: 32 });
    const organizations = sequence(set, '00209221', { max: 32 });
    if (allowEmpty && definitions?.length === 0 && organizations?.length === 0) return [];
    const knownOrganizations = new Set((organizations ?? []).map(item => uid(item, '00209164', true)));
    if (organizations && (!organizations.length || knownOrganizations.size !== organizations.length)) fail();
    if (!definitions) return [];
    if (!definitions.length || !knownOrganizations.size) fail('Enhanced DICOM dimensions require a dimension organization.');
    const seen = new Set();
    return definitions.map(item => {
        const organizationUid = uid(item, '00209164', true);
        const indexPointer = tagPointer(item, '00209165', littleEndian, true);
        const functionalGroupPointer = tagPointer(item, '00209167', littleEndian);
        if (!knownOrganizations.has(organizationUid) || ['00209111', '00209157'].includes(indexPointer)) fail();
        const signature = `${organizationUid}|${indexPointer}|${functionalGroupPointer ?? ''}`;
        if (seen.has(signature)) fail();
        seen.add(signature);
        const known = KNOWN_POINTERS.has(indexPointer) && KNOWN_POINTERS.get(indexPointer) === functionalGroupPointer;
        return { organizationUid, indexPointer, functionalGroupPointer,
            label: text(item, '00209421'), spatial: known && SPATIAL_POINTERS.has(indexPointer), known };
    });
}

function rejectPresentation(set, depth = 0, budget = { count: 0 }, allowLuts = false, container = null) {
    if (!set) return;
    if (depth > 12 || ++budget.count > 65536) fail('Enhanced DICOM functional groups exceed the supported structural limit.');
    if (['00409096', '20500010'].some(id => attribute(set, id)) ||
        attribute(set, '00283000') && (!allowLuts || container !== MACRO.rescale) ||
        attribute(set, '00283010') && (!allowLuts || container !== MACRO.voi)) {
        fail('Enhanced DICOM LUT and real-world value transformations require a dedicated presentation implementation.');
    }
    if (!Array.isArray(set.attributes) || new Set(set.attributes.map(attr => attr.tag.ID)).size !== set.attributes.length) fail();
    for (const attr of set.attributes) if (Array.isArray(attr.items)) {
        for (const item of attr.items) rejectPresentation(item, depth + 1, budget, allowLuts, attr.tag.ID);
    }
}

function privateCreator(attr) {
    const group = parseInt(attr.tag.ID.slice(0, 4), 16);
    const element = parseInt(attr.tag.ID.slice(4), 16);
    return group >= 0x0009 && group < 0xFFFF && group % 2 === 1 && element >= 0x0010 && element <= 0x00FF;
}

function validateContainer(set) {
    for (const attr of set.attributes) {
        const vr = getAttributeVR(attr);
        if (privateCreator(attr)) {
            // PS3.5 7.8: each item declares its own private blocks. Creator LO
            // declarations are not functional-group macros or patient geometry.
            if (vr !== 'LO') fail();
            const value = text(set, attr.tag.ID, { required: true, max: 64 });
            if (!/^[\x20-\x7E]+$/.test(value)) fail();
        } else if (vr !== 'SQ' || !Array.isArray(attr.items)) fail();
    }
}

function macro(shared, frame, id) {
    const sharedItems = sequence(shared, id, { single: true });
    const frameItems = sequence(frame, id, { single: true });
    if (sharedItems && frameItems) fail('A functional-group macro cannot occur in both shared and per-frame groups.');
    return (frameItems ?? sharedItems)?.[0] ?? null;
}

function windowMetadata(set, littleEndian) {
    if (!set) return { window: null, voiFunction: 'LINEAR' };
    const voiFunction = text(set, '00281056') ?? 'LINEAR';
    if (!['LINEAR', 'LINEAR_EXACT'].includes(voiFunction)) fail('Enhanced DICOM VOI requires a supported window function.');
    const centers = numeric(set, '00281050', littleEndian), widths = numeric(set, '00281051', littleEndian);
    if (centers.length !== widths.length || widths.some(width => width < (voiFunction === 'LINEAR' ? 1 : Number.MIN_VALUE))) fail();
    return { window: centers.length ? { center: centers[0], width: widths[0] } : null, voiFunction,
        windowAlternatives: centers.map((center, index) => ({ center, width: widths[index] })) };
}

function frameType(set) {
    const value = raw(set, '00089007');
    if (value == null || value === '') return [];
    const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split('\\') : [];
    if (!values.length || values.some(item => typeof item !== 'string' || !item.trim() || item.length > 64)) fail();
    return values.map(item => item.trim());
}

// A bounded compatibility profile for older sampled CT projection objects.
// Empty dimension sequences do not establish a dimension organization or a
// volume. Their native raster frames remain useful in encoded order only.
function emptyProjectionProfile(set, common, perFrame, metadataOnly) {
    const ids = ['00209221', '00209222'];
    const empty = ids.every(id => {
        const attr = attribute(set, id);
        return getAttributeVR(attr) === 'SQ' && Array.isArray(attr.items) && attr.items.length === 0 &&
            set.attributes.filter(value => value.tag.ID === id).length === 1;
    });
    if (!empty) return false;
    if (text(set, '00080016') !== '1.2.840.10008.5.1.4.1.1.2.1' || text(set, '00080060') !== 'CT' ||
        !metadataOnly && !NATIVE_SYNTAXES.has(common.transferSyntax) ||
        getAttributeVR(attribute(set, '52009229')) !== 'SQ' || getAttributeVR(attribute(set, '52009230')) !== 'SQ' ||
        common.samplesPerPixel !== 1 || !['MONOCHROME1', 'MONOCHROME2'].includes(common.photometric) ||
        !perFrame || attribute(set, '00209311') || attribute(set, '00209161') || attribute(set, '00209228')) fail();
    return true;
}

function validateProjectionFrame({ measures, planePosition, planeOrientation, rescale, voi, type,
    position, imageOrientation, pixelSpacing, presentation, dimensionIndexValues }) {
    const required = [[measures, '00280030', 'DS'], [planePosition, '00200032', 'DS'],
        [planeOrientation, '00200037', 'DS'], [rescale, '00281053', 'DS'], [rescale, '00281052', 'DS'],
        [rescale, '00281054', 'LO'], [voi, '00281050', 'DS'], [voi, '00281051', 'DS'],
        [type, '00089007', 'CS'], [type, '00089206', 'CS'], [type, '00089207', 'CS']];
    const kind = frameType(type);
    if (required.some(([set, id, vr]) => getAttributeVR(attribute(set, id)) !== vr) ||
        !position || !imageOrientation || !pixelSpacing || !presentation.window || dimensionIndexValues.length ||
        kind.length !== 4 || kind[0] !== 'DERIVED' || kind[1] !== 'PRIMARY' || kind[3] !== 'MAXIMUM' ||
        text(type, '00089206') !== 'SAMPLED' || text(type, '00089207') !== 'MAX_IP' ||
        attribute(rescale, '00283000') || attribute(voi, '00283010')) fail();
}

/** Resolve shared/per-frame macros without extrapolating patient geometry. */
export function resolveEnhancedFrames(instance, common = {}, { presentationNormalizer, metadataOnly = false } = {}) {
    const set = instance?.dataSet ?? instance;
    if (!set || !ENHANCED_SOP_CLASSES.has(text(set, '00080016', { required: true, max: 64 }))) {
        fail('This enhanced DICOM image object is outside the supported CT/MR profile.');
    }
    const littleEndian = common.littleEndian ?? true;
    const count = scalar(set, '00280008', littleEndian, { required: true, min: 1, integer: true });
    if (count > 4096) fail('Enhanced DICOM frame count exceeds the supported limit.');
    const shared = sequence(set, '52009229', { required: true, single: true })[0];
    const perFrame = sequence(set, '52009230');
    if (perFrame && perFrame.length !== count) fail('Enhanced DICOM per-frame functional-group count must equal Number of Frames.');
    validateContainer(shared);
    for (const frame of perFrame ?? []) validateContainer(frame);
    if (attribute(shared, MACRO.content)) fail('Enhanced DICOM Frame Content must be per-frame.');
    // Even unknown macros cannot be duplicated across the two containers.
    const sharedTags = new Set(shared.attributes.filter(attr => !privateCreator(attr)).map(attr => attr.tag.ID));
    for (const frame of perFrame ?? []) if (frame.attributes.some(attr => !privateCreator(attr) && sharedTags.has(attr.tag.ID))) {
        fail('A functional-group macro cannot occur in both shared and per-frame groups.');
    }
    const structuralBudget = { count: 0 };
    const allowLuts = typeof presentationNormalizer === 'function';
    rejectPresentation(shared, 0, structuralBudget, allowLuts);
    for (const frame of perFrame ?? []) rejectPresentation(frame, 0, structuralBudget, allowLuts);
    const limitedProjection = emptyProjectionProfile(set, common, perFrame, metadataOnly);
    const definitions = dimensions(set, littleEndian, { allowEmpty: limitedProjection });
    const frameOfReferenceUid = uid(set, '00200052');
    const concatenationUid = uid(set, '00209161');
    const concatenationOffset = scalar(set, '00209228', littleEndian, { required: concatenationUid != null, min: 0, max: 0xFFFFFFFF, integer: true }) ?? 0;
    if (!concatenationUid && attribute(set, '00209228')) fail();
    const timing = resolveFrameTiming(set, count, { littleEndian });
    const frameTime = timing.frameTime;
    const knownValues = new Map();
    const presentationCache = new Map();
    const lutCache = new WeakMap();
    const frames = [];
    for (let frameIndex = 0; frameIndex < count; frameIndex++) {
        const frame = perFrame?.[frameIndex];
        const measures = macro(shared, frame, MACRO.measures);
        const planePosition = macro(shared, frame, MACRO.position);
        const planeOrientation = macro(shared, frame, MACRO.orientation);
        const rescale = macro(shared, frame, MACRO.rescale);
        const voi = macro(shared, frame, MACRO.voi);
        const content = macro(shared, frame, MACRO.content);
        const echo = macro(shared, frame, MACRO.echo);
        const type = macro(shared, frame, MACRO.mrType) ?? macro(shared, frame, MACRO.ctType);
        const diffusion = macro(shared, frame, MACRO.diffusion);
        const temporal = macro(shared, frame, MACRO.temporal);
        const position = vector(planePosition, '00200032', 3, littleEndian);
        const imageOrientation = vector(planeOrientation, '00200037', 6, littleEndian, orientation);
        const pixelSpacing = vector(measures, '00280030', 2, littleEndian, values => values.every(value => value > 0));
        const modalityLut = allowLuts && attribute(rescale, '00283000');
        const slope = rescale && !modalityLut ? scalar(rescale, '00281053', littleEndian, { required: true }) : 1;
        const intercept = rescale && !modalityLut ? scalar(rescale, '00281052', littleEndian, { required: true }) : 0;
        if (slope === 0) fail('Enhanced DICOM rescale slope must be nonzero.');
        const rescaleType = text(rescale, '00281054');
        const dimensionIndexValues = numeric(content, '00209157', littleEndian);
        if (dimensionIndexValues.length !== definitions.length || dimensionIndexValues.some(value => !Number.isSafeInteger(value) || value < 1 || value > 0xFFFFFFFF)) {
            fail('Enhanced DICOM dimension indices must match the dimension definitions.');
        }
        const indexed = definitions.map((definition, index) => {
            let scope = frame;
            if (definition.functionalGroupPointer) scope = macro(shared, frame, definition.functionalGroupPointer);
            else if (!attribute(scope, definition.indexPointer)) scope = shared;
            if (!definition.functionalGroupPointer && !attribute(scope, definition.indexPointer)) scope = set;
            const value = raw(scope, definition.indexPointer);
            const resolved = value != null && !(typeof value === 'string' && value === '') && !(Array.isArray(value) && value.length === 0);
            // Native UL/FD/AT arrays are read in full, rather than EASI's first
            // scalar getter, when comparing nominal values for an ordinal.
            let comparable = value;
            if (attribute(scope, definition.indexPointer)?.tag.VR?.ID === 'SQ') comparable = null;
            else if (['UL', 'US', 'FD', 'FL', 'DS', 'IS'].includes(attribute(scope, definition.indexPointer)?.tag.VR?.ID)) {
                comparable = numeric(scope, definition.indexPointer, littleEndian);
            }
            if (definition.known && resolved) {
                const key = `${definition.organizationUid}|${definition.indexPointer}|${dimensionIndexValues[index]}`;
                const normalized = JSON.stringify(comparable);
                if (knownValues.has(key) && knownValues.get(key) !== normalized) fail('Enhanced DICOM ordinal values describe inconsistent frame dimensions.');
                knownValues.set(key, normalized);
            }
            return { ...definition, ordinal: dimensionIndexValues[index], resolved };
        });
        const stackId = text(content, '00209056', { max: 16 });
        const inStackPositionNumber = scalar(content, '00209057', littleEndian, { required: stackId != null, min: 1, max: 0xFFFFFFFF, integer: true });
        const echoNumbers = numeric(set, '00180086', littleEndian);
        if (echoNumbers.some(value => !Number.isSafeInteger(value) || value < 1)) fail();
        const frameDimensions = {
            frameOfReferenceUid, concatenationUid, logicalFrameIndex: concatenationOffset + frameIndex,
            stackId, inStackPositionNumber, temporalPositionIndex: scalar(content, '00209128', littleEndian, { min: 1, max: 0xFFFFFFFF, integer: true }),
            temporalPositionTimeOffset: scalar(temporal, '0020930D', littleEndian),
            dimensionIndexValues, indices: indexed, effectiveEchoTime: scalar(echo, '00189082', littleEndian, { min: 0 }),
            echoNumber: echoNumbers.length === 1 ? echoNumbers[0] : null, echoNumbers,
            diffusionBValue: scalar(diffusion, '00189087', littleEndian, { min: 0 }),
            diffusionDirection: vector(diffusion, '00189089', 3, littleEndian),
            frameType: frameType(type), volumetricProperties: text(type, '00089206'),
            complexImageComponent: text(type, '00089208'), acquisitionContrast: text(type, '00089209'),
            frameAcquisitionNumber: scalar(content, '00209156', littleEndian, { min: 0, integer: true }),
            frameAcquisitionDuration: scalar(content, '00189220', littleEndian, { min: 0 }),
            frameReferenceDateTime: dateTime(content, '00189151'), frameAcquisitionDateTime: dateTime(content, '00189074')
        };
        let presentation = windowMetadata(allowLuts ? null : voi, littleEndian);
        if (allowLuts) {
            if (!presentationCache.has(rescale)) presentationCache.set(rescale, new Map());
            const cache = presentationCache.get(rescale);
            presentation = cache.get(voi);
            if (!presentation) {
                const presentationSet = { find: tag => attribute(rescale, tag.ID) ?? attribute(voi, tag.ID) ??
                    (['20500020', '20500010'].includes(tag.ID) ? attribute(set, tag.ID) : undefined) };
                presentation = presentationNormalizer(presentationSet, { signed: common.signed ?? false, littleEndian,
                    photometric: common.photometric ?? 'MONOCHROME2', bitsStored: common.bitsStored ?? 16,
                    slope, intercept, metadataOnly, lutCache });
                const centers = numeric(voi, '00281050', littleEndian), widths = numeric(voi, '00281051', littleEndian);
                presentation.windowAlternatives = centers.map((center, index) => ({ center, width: widths[index] }));
                if (presentation.unit === 'US') presentation.unit = '';
                cache.set(voi, presentation);
            }
        }
        if (limitedProjection) {
            if (macro(shared, frame, MACRO.mrType) || !sequence(frame, MACRO.content, { required: true, single: true })) fail();
            validateProjectionFrame({ measures, planePosition, planeOrientation, rescale, voi, type,
                position, imageOrientation, pixelSpacing, presentation, dimensionIndexValues });
            frameDimensions.spatialEligible = false;
            frameDimensions.semanticScope = 'encoded-2d-projection';
        }
        const overrides = {
            position, orientation: imageOrientation, pixelSpacing,
            sliceThickness: scalar(measures, '00180050', littleEndian, { min: 0 }),
            spacingBetweenSlices: scalar(measures, '00180088', littleEndian, { min: 0 }),
            slope, intercept, unit: rescaleType === 'HU' ? 'HU' : '', frameTime,
            timingMode: timing.frames[frameIndex].timingMode, acquisitionOffsetMs: timing.frames[frameIndex].acquisitionOffsetMs,
            nextIntervalMs: timing.frames[frameIndex].nextIntervalMs,
            ...presentation, ...(limitedProjection ? { geometryWarnings: [...(common.geometryWarnings ?? []), EMPTY_PROJECTION_WARNING] } : {})
        };
        frames.push({ frameIndex, overrides, dimensions: frameDimensions });
    }
    return frames;
}

function projection(frame) {
    const { orientation: o, position: p } = frame.overrides;
    if (!o || !p) return null;
    return p[0] * (o[1] * o[5] - o[2] * o[4]) + p[1] * (o[2] * o[3] - o[0] * o[5]) + p[2] * (o[0] * o[4] - o[1] * o[3]);
}

/** Partition nonspatial indices first; never turn time/echo into slice order. */
export function partitionEnhancedFrames(frames) {
    const groups = new Map();
    for (const frame of frames) {
        const d = frame.dimensions;
        const key = JSON.stringify([d.frameOfReferenceUid, d.concatenationUid,
            d.indices.map(index => [index.organizationUid, index.indexPointer, index.functionalGroupPointer, index.spatial ? null : index.ordinal]),
            d.stackId, d.temporalPositionIndex, d.temporalPositionTimeOffset, d.effectiveEchoTime, d.echoNumbers, d.diffusionBValue,
            d.diffusionDirection, d.frameType, d.complexImageComponent, d.acquisitionContrast]);
        if (!groups.has(key)) groups.set(key, { key, frames: [], spatialEligible: false });
        groups.get(key).frames.push(frame);
    }
    for (const group of groups.values()) {
        const first = group.frames[0];
        const reference = first.overrides;
        const positioned = group.frames.every(frame => frame.dimensions.spatialEligible !== false && projection(frame) != null && frame.overrides.pixelSpacing &&
            frame.dimensions.frameOfReferenceUid && frame.dimensions.indices.every(index => index.known && index.resolved) &&
            frame.dimensions.echoNumbers.length <= 1 &&
            !['DISTORTED', 'SAMPLED', 'MIXED'].includes(frame.dimensions.volumetricProperties) &&
            frame.overrides.orientation.every((component, index) => Math.abs(component - reference.orientation[index]) <= 0.00001) &&
            frame.overrides.pixelSpacing.every((component, index) => Math.abs(component - reference.pixelSpacing[index]) <= 0.00001));
        // Presentation sorting is confined to a partition with consistent planes.
        // A unique projection is necessary but insufficient for a regular volume.
        if (positioned) group.frames.sort((a, b) => projection(a) - projection(b) || a.frameIndex - b.frameIndex);
        const positions = positioned ? group.frames.map(projection) : [];
        const gaps = positions.slice(1).map((position, index) => position - positions[index]);
        group.spatialEligible = positions.length > 1 && gaps.every(gap => gap > 0.00001 && Math.abs(gap - gaps[0]) <= Math.max(0.00001, gaps[0] * 0.001));
    }
    return [...groups.values()];
}
