import { normalizeImageReference } from '../annotations/model.js';
import { normalizeVoi } from '../data/presentation-math.js';
import { polyline, axisAlignedEllipse } from './graphics.js';
import { uid, integer, fail, MAX_DERIVED_RECORDS } from './common.js';

export const DERIVED_RESULT_SCHEMA = 'easi-view.derived-results';
export const MAX_RESULT_BYTES = 1024 * 1024;
function fields(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail('unknown result fields');
}
function id(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(value)) fail('result identifier is invalid'); return value; }
function code(input) {
    fields(input, ['value', 'scheme', 'meaning', 'version']);
    for (const key of ['value', 'scheme', 'meaning']) if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > (key === 'meaning' ? 64 : 16) || /[\u0000-\u001F\\]/u.test(input[key])) fail('result code is invalid');
    if (input.version != null && (typeof input.version !== 'string' || !input.version.trim() || input.version.length > 16 || /[\u0000-\u001F\\]/u.test(input.version))) fail('result code version is invalid');
    return structuredClone(input);
}
function coordinates(points) {
    if (!Array.isArray(points) || points.length > 129) fail('result graphic count is invalid');
    for (const point of points) fields(point, ['x', 'y']);
    return points.flatMap(point => [point.x, point.y]);
}
function graphic(input, image, gsps = false) {
    fields(input, gsps ? ['id', 'layer', 'type', 'points', 'closed', 'controlPoints', 'filled'] : ['type', 'points', 'closed']);
    const normalized = input.type === 'POLYLINE' ? polyline(coordinates(input.points), image) : gsps && input.type === 'ELLIPSE' ?
        axisAlignedEllipse(coordinates(input.points), image) : fail('unsupported result graphic');
    if (input.closed !== normalized.closed || JSON.stringify(input.controlPoints) !== JSON.stringify(normalized.controlPoints) || gsps && input.filled !== false) fail('result graphic semantics differ');
    if (gsps) {
        if (typeof input.layer !== 'string' || !/^[A-Z0-9_ ]{1,16}$/u.test(input.layer)) fail('result layer is invalid');
        return { id: id(input.id), layer: input.layer, ...normalized, filled: false };
    }
    return normalized;
}
function document(input) {
    if (input?.profile === 'by-value-num-scoord-sr-v1') {
        fields(input, ['profile', 'sopUid', 'documentConcept', 'measurements']);
        if (!Array.isArray(input.measurements) || input.measurements.length < 1 || input.measurements.length > MAX_DERIVED_RECORDS) fail('measurement count is invalid');
        const measurements = input.measurements.map(item => {
            fields(item, ['id', 'concept', 'value', 'unit', 'image', 'graphic']);
            if (!Number.isFinite(item.value)) fail('result measurement is not finite');
            const image = normalizeImageReference(item.image), unit = code(item.unit);
            if (unit.scheme !== 'UCUM' || !['mm', 'cm', 'mm2', 'cm2', 'deg', '1', '%'].includes(unit.value)) fail('unsupported result measurement unit');
            return { id: id(item.id), concept: code(item.concept), value: item.value, unit, image, graphic: graphic(item.graphic, image) };
        });
        if (new Set(measurements.map(item => item.id)).size !== measurements.length) fail('duplicate measurement identifiers');
        return { profile: input.profile, sopUid: uid(input.sopUid), documentConcept: code(input.documentConcept), measurements };
    }
    if (input?.profile !== 'single-frame-pixel-gsps-v1') fail('unsupported result profile');
    fields(input, ['profile', 'sopUid', 'image', 'layers', 'graphics', 'window', 'presentationShape', 'presentationInvert', 'displayedArea']);
    const image = normalizeImageReference(input.image);
    if (!Array.isArray(input.layers) || input.layers.length < 1 || input.layers.length > 256 || !Array.isArray(input.graphics) || input.graphics.length > MAX_DERIVED_RECORDS) fail('result graphic/layer count is invalid');
    const layers = input.layers.map(layer => {
        fields(layer, ['name', 'order', 'grayValue']);
        if (typeof layer.name !== 'string' || !/^[A-Z0-9_ ]{1,16}$/u.test(layer.name)) fail('result graphic layer is invalid');
        return { name: layer.name, order: integer(layer.order, 0, 0xFFFFFFFF), grayValue: integer(layer.grayValue, 0, 65535) };
    });
    if (new Set(layers.map(layer => layer.name)).size !== layers.length) fail('duplicate graphic layers');
    const graphics = input.graphics.map(item => graphic(item, image, true));
    if (new Set(graphics.map(item => item.id)).size !== graphics.length || graphics.some(item => !layers.some(layer => layer.name === item.layer))) fail('result graphic identifiers/layers conflict');
    fields(input.window, ['center', 'width', 'voiFunction']);
    const window = normalizeVoi(input.window.center, input.window.width, input.window.voiFunction);
    if (!['IDENTITY', 'INVERSE'].includes(input.presentationShape) || input.presentationInvert !== (input.presentationShape === 'INVERSE')) fail('result presentation polarity is invalid');
    fields(input.displayedArea, ['topLeft', 'bottomRight', 'mode']);
    if (JSON.stringify(input.displayedArea.topLeft) !== '[1,1]' || JSON.stringify(input.displayedArea.bottomRight) !== JSON.stringify([image.columns, image.rows]) || input.displayedArea.mode !== 'SCALE TO FIT') fail('unsupported result displayed area');
    return { profile: input.profile, sopUid: uid(input.sopUid), image, layers, graphics, window, presentationShape: input.presentationShape,
        presentationInvert: input.presentationInvert, displayedArea: structuredClone(input.displayedArea) };
}
function normalize(input) {
    fields(input, ['schema', 'version', 'coordinateSystem', 'frameNumberBase', 'documents']);
    if (input.schema !== DERIVED_RESULT_SCHEMA || input.version !== 1 || input.coordinateSystem !== 'image-edge' || input.frameNumberBase !== 1 ||
        !Array.isArray(input.documents) || input.documents.length > 32 || input.documents.reduce((sum, value) => sum + (value?.measurements?.length ?? value?.graphics?.length ?? 0), 0) > MAX_DERIVED_RECORDS) fail('unsupported derived result schema or count');
    const documents = input.documents.map(document);
    if (new Set(documents.map(value => value.sopUid)).size !== documents.length) fail('duplicate result documents');
    return { schema: DERIVED_RESULT_SCHEMA, version: 1, coordinateSystem: 'image-edge', frameNumberBase: 1, documents };
}

/** Explicit restricted-result JSON; never presented as DICOM SR/GSPS export. */
export function exportDerivedResults(documents, { maxBytes = MAX_RESULT_BYTES } = {}) {
    integer(maxBytes, 1, MAX_RESULT_BYTES);
    const result = normalize({ schema: DERIVED_RESULT_SCHEMA, version: 1, coordinateSystem: 'image-edge', frameNumberBase: 1, documents });
    const text = JSON.stringify(result);
    if (text.length > maxBytes || new TextEncoder().encode(text).length > maxBytes) fail('result JSON exceeds byte budget');
    return text;
}
export function importDerivedResults(input, { maxBytes = MAX_RESULT_BYTES } = {}) {
    integer(maxBytes, 1, MAX_RESULT_BYTES);
    if (typeof input === 'string') {
        if (input.length > maxBytes || new TextEncoder().encode(input).length > maxBytes) fail('result JSON exceeds byte budget');
        input = JSON.parse(input);
    }
    const result = normalize(input), text = JSON.stringify(result);
    if (text.length > maxBytes || new TextEncoder().encode(text).length > maxBytes) fail('result JSON exceeds byte budget');
    return result;
}
