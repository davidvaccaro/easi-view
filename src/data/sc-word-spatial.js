import { Tag } from '@xinonix/easi-js';
import { getAttributeVR } from './attributes.js';

export const SC_WORD_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.7.3';
const NATIVE = new Set(['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']);
const MACROS = new Map([['00289110', new Set(['00280030', '00180050', '00180088'])],
    ['00209113', new Set(['00200032'])], ['00209116', new Set(['00200037'])]]);
function fail() { throw new Error('Multi-frame grayscale word SC spatial functional groups require the verified native unsigned16 MONOCHROME2 spatial-only profile.'); }
function attr(set, id) { return set?.find?.(Tag.find(id)); }
function pixelScalar(set, id, expected) {
    const value = attr(set, id);
    if (!value || getAttributeVR(value) !== 'US') fail();
    const bytes = value.transferSyntax?.ID === '0' ? null : value.access?.();
    if (bytes?.byteLength) {
        if (bytes.byteLength !== 2 || new DataView(bytes.buffer, bytes.byteOffset, 2)
            .getUint16(0, value.transferSyntax?.IsLittleEndian ?? true) !== expected) fail();
    } else {
        const values = Array.isArray(value.value) ? value.value : [value.value];
        if (values.length !== 1 || values[0] !== expected) fail();
    }
}
function items(set, id, count) {
    const value = attr(set, id);
    if (!value || getAttributeVR(value) !== 'SQ' || !Array.isArray(value.items) || value.items.length !== count ||
        value.items.some(item => !Array.isArray(item?.attributes) || typeof item.find !== 'function')) fail();
    return value.items;
}
function values(set, id, count, required = true) {
    const value = attr(set, id);
    if (!value && !required) return null;
    if (!value || getAttributeVR(value) !== 'DS') fail();
    const raw = value.value, parts = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split('\\') : [raw];
    if (parts.length !== count || parts.some(part => typeof part !== 'number' && (typeof part !== 'string' ||
        !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(part.trim())))) fail();
    const result = parts.map(Number);
    if (result.some(number => !Number.isFinite(number) || Math.abs(number) > 1e9)) fail();
    return result;
}
function validate(set) {
    if (new Set(set.attributes.map(value => value.tag.ID)).size !== set.attributes.length) fail();
    for (const value of set.attributes) {
        const fields = MACROS.get(value.tag.ID);
        if (!fields) fail();
        const macro = items(set, value.tag.ID, 1)[0];
        if (new Set(macro.attributes.map(value => value.tag.ID)).size !== macro.attributes.length ||
            macro.attributes.some(value => !fields.has(value.tag.ID))) fail();
    }
}

/** PS3.3 A.8.4.5 spatial SC macros; source SOP class and presentation remain intact.
 * Navigation is 2D only: no dimension organization or acquisition partition is inferred.
 */
export function resolveScWordSpatialFrames(instance, common, { frameCount, frameTiming } = {}) {
    const set = instance.dataSet;
    if (!Array.isArray(set?.attributes) || new Set(set.attributes.map(value => value.tag.ID)).size !== set.attributes.length) fail();
    if (set?.value(Tag.find('00080016')) !== SC_WORD_SOP_CLASS || !NATIVE.has(common.transferSyntax) ||
        common.samplesPerPixel !== 1 || common.photometric !== 'MONOCHROME2' || common.signed !== false ||
        common.bitsAllocated !== 16 || common.bitsStored !== 16 || common.highBit !== 15 ||
        !Number.isSafeInteger(frameCount) || frameCount < 1 || frameCount > 4096 ||
        ['00209221', '00209222', '00209161', '00209228'].some(id => attr(set, id))) fail();
    for (const [id, expected] of [['00280010', common.rows], ['00280011', common.columns], ['00280002', 1],
        ['00280100', 16], ['00280101', 16], ['00280102', 15], ['00280103', 0]]) pixelScalar(set, id, expected);
    if (attr(set, '00280006')) pixelScalar(set, '00280006', common.planarConfiguration);
    const count = attr(set, '00280008'), photo = attr(set, '00280004');
    const rawCount = count?.value, photoValue = photo?.value;
    const countValue = Array.isArray(rawCount) && rawCount.length === 1 ? rawCount[0] : rawCount;
    if (getAttributeVR(count) !== 'IS' || !(typeof countValue === 'string' && /^\+?\d+$/.test(countValue.trim()) ||
        typeof countValue === 'number' && Number.isSafeInteger(countValue)) || Number(countValue) !== frameCount ||
        getAttributeVR(photo) !== 'CS' || photoValue !== 'MONOCHROME2' || frameTiming?.some(frame => frame.timingMode !== 'none')) fail();
    const shared = items(set, '52009229', 1)[0], frames = items(set, '52009230', frameCount);
    validate(shared); frames.forEach(validate);
    return frames.map((frame, frameIndex) => {
        const macro = id => {
            if (attr(shared, id) && attr(frame, id)) fail();
            return items(attr(shared, id) ? shared : frame, id, 1)[0];
        };
        const measures = macro('00289110'), position = values(macro('00209113'), '00200032', 3);
        const orientation = values(macro('00209116'), '00200037', 6), pixelSpacing = values(measures, '00280030', 2);
        const a = orientation.slice(0, 3), b = orientation.slice(3);
        if (pixelSpacing.some(value => value <= 0 || value > 10000) || Math.abs(Math.hypot(...a) - 1) > 0.001 ||
            Math.abs(Math.hypot(...b) - 1) > 0.001 || Math.abs(a.reduce((sum, value, index) => sum + value * b[index], 0)) > 0.001) fail();
        const thickness = values(measures, '00180050', 1, false)?.[0] ?? null;
        const spacing = values(measures, '00180088', 1, false)?.[0] ?? null;
        if (thickness != null && thickness <= 0 || spacing != null && spacing <= 0) fail();
        return { frameIndex, overrides: { ...frameTiming?.[frameIndex], position, orientation, pixelSpacing, sliceThickness: thickness, spacingBetweenSlices: spacing },
            dimensions: { frameOfReferenceUid: common.frameOfReferenceUid, concatenationUid: null,
                logicalFrameIndex: frameIndex, indices: [], echoNumbers: [], spatialEligible: false } };
    });
}
