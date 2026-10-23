import { Tag } from '@xinonix/easi-js';
import { createImageReference } from '../annotations/model.js';
import { orientation } from '../volume/geometry.js';

export const MAX_DERIVED_BYTES = 64 * 1024 * 1024;
export const MAX_DERIVED_RECORDS = 1000;
export const MAX_DERIVED_FRAMES = 4096;
export const DERIVED_SCHEMA_VERSION = 1;
export const fail = reason => { throw new Error(`Unsupported derived object: ${reason}.`); };
export function checkSignal(signal) { if (signal?.aborted) throw new DOMException('Derived-object processing was canceled.', 'AbortError'); }
export function integer(value, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) fail('integer or resource limit is invalid'); return value; }
export function uid(value) { if (typeof value !== 'string' || value.length > 64 || !/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))+$/u.test(value)) fail('a valid explicit DICOM UID is required'); return value; }
export function attribute(set, id) { return set?.find?.(Tag.find(id)); }
export function text(set, id, { required = true, maximum = 64 } = {}) {
    let value = attribute(set, id)?.value;
    if (Array.isArray(value)) { if (value.length !== 1) fail('single text value required'); value = value[0]; }
    if (value == null || value === '') { if (required) fail('required text attribute missing'); return null; }
    if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001F\\]/u.test(value.trim())) fail('text value is invalid');
    return value.trim();
}
export function numbers(set, id, { required = true, maximum = 256 } = {}) {
    const attr = attribute(set, id);
    if (!attr) { if (required) fail('required numeric attribute missing'); return []; }
    const vr = attr.vr?.ID ?? attr.tag?.VR?.ID, bytes = attr.access?.(), raw = attr.value;
    const widths = { US: 2, SS: 2, UL: 4, SL: 4, FL: 4, FD: 8 };
    let result;
    if (!Array.isArray(raw) && widths[vr] && bytes?.byteLength) {
        const width = widths[vr];
        if (bytes.byteLength % width || bytes.byteLength / width > maximum) fail('numeric attribute length is invalid');
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), methods = { US: 'getUint16', SS: 'getInt16', UL: 'getUint32', SL: 'getInt32', FL: 'getFloat32', FD: 'getFloat64' };
        result = Array.from({ length: bytes.byteLength / width }, (_, index) => view[methods[vr]](index * width, attr.transferSyntax?.IsLittleEndian !== false));
    } else {
        const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.trim().split('\\') : [raw];
        if (values.length > maximum || values.some(value => typeof value !== 'number' && (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value.trim())))) fail('numeric attribute values are invalid');
        result = values.map(Number);
    }
    if (!result.length || result.some(value => !Number.isFinite(value))) fail('numeric attribute values are invalid');
    return result;
}
export function scalar(set, id, options) { const values = numbers(set, id, options); if (!values.length) return null; if (values.length !== 1) fail('single numeric value required'); return values[0]; }
export function sequence(set, id, { required = true, minimum = 1, maximum = MAX_DERIVED_FRAMES } = {}) {
    const attr = attribute(set, id);
    if (!attr) { if (required) fail('required sequence missing'); return []; }
    if ((attr.vr?.ID ?? attr.tag?.VR?.ID) !== 'SQ' || !Array.isArray(attr.items) || attr.items.length < minimum || attr.items.length > maximum) fail('sequence cardinality is invalid');
    return attr.items;
}
export const one = (set, id, options = {}) => sequence(set, id, { ...options, maximum: 1 })[0] ?? null;
export function code(set) {
    const value = text(set, '00080100', { maximum: 16 }), scheme = text(set, '00080102', { maximum: 16 }), meaning = text(set, '00080104');
    const version = text(set, '00080103', { required: false, maximum: 16 });
    return { value, scheme, meaning, ...(version ? { version } : {}) };
}
export function validateStructure(set) {
    let nodes = 0, attributes = 0;
    const visit = (current, depth) => {
        if (depth > 12 || ++nodes > 32768 || !Array.isArray(current?.attributes) ||
            (attributes += current.attributes.length) > 65536 || new Set(current.attributes.map(attr => attr.tag?.ID)).size !== current.attributes.length) fail('dataset structure exceeds supported limits or contains duplicate tags');
        for (const attr of current.attributes) if (Array.isArray(attr.items)) for (const item of attr.items) visit(item, depth + 1);
    };
    visit(set, 0);
    const charset = text(set, '00080005', { required: false });
    if (charset != null && !['ISO_IR 6', 'ISO_IR 192'].includes(charset)) fail('only default ASCII or UTF-8 derived-object text is supported');
}
export function rejectTags(set, ids) { if (ids.some(id => attribute(set, id))) fail('unsupported template, transform or presentation attribute'); }
export function geometry(set, shared = null) {
    const macro = id => {
        const own = one(set, id, { required: false }), inherited = one(shared, id, { required: false });
        if (own && inherited) fail('functional group occurs both shared and per-frame');
        return own ?? inherited;
    };
    const positionSet = macro('00209113'), orientationSet = macro('00209116'), measures = macro('00289110');
    if (!positionSet || !orientationSet || !measures) fail('full per-frame patient geometry is required');
    const position = numbers(positionSet, '00200032'), imageOrientation = numbers(orientationSet, '00200037'), pixelSpacing = numbers(measures, '00280030');
    if (position.length !== 3 || pixelSpacing.length !== 2 || pixelSpacing.some(value => value <= 0)) fail('patient geometry is invalid');
    orientation(imageOrientation);
    return { position, orientation: imageOrientation, pixelSpacing };
}
export function reference(set) {
    const number = scalar(set, '00081160', { required: false });
    return { sopUid: uid(text(set, '00081155')), sopClassUid: uid(text(set, '00081150')),
        frameNumber: number == null ? null : integer(number, 1, MAX_DERIVED_FRAMES) };
}
export function abortable(request, signal) {
    checkSignal(signal);
    if (!signal) return Promise.resolve().then(request);
    return new Promise((resolve, reject) => {
        let settled = false;
        const done = (callback, value) => { if (settled) return; settled = true; signal.removeEventListener('abort', abort); callback(value); };
        const abort = () => done(reject, new DOMException('Derived-object processing was canceled.', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => { checkSignal(signal); return request(); }).then(value => done(resolve, value), error => done(reject, error));
        if (signal.aborted) abort();
    });
}
export async function resolveReference(ref, resolver, signal) {
    if (typeof resolver !== 'function') fail('an explicit source-frame resolver is required');
    const frame = await abortable(() => resolver(ref.sopUid, ref.frameNumber, { signal }), signal); checkSignal(signal);
    if (ref.frameNumber == null && (frame?.numberOfFrames ?? frame?.frameCount) !== 1) fail('a missing Referenced Frame Number requires verified single-frame source metadata');
    const frameNumber = ref.frameNumber ?? 1;
    if (frame?.sopUid !== ref.sopUid || frame.frameIndex !== frameNumber - 1 ||
        (frame.sopClassUid ?? frame.sopClass) != null && (frame.sopClassUid ?? frame.sopClass) !== ref.sopClassUid) fail('resolved SOP or original frame differs');
    return { frame, image: createImageReference(frame) };
}
export function assertGrid(overlay, frame) {
    if (frame.rows !== overlay.rows || frame.columns !== overlay.columns || frame.frameOfReferenceUid !== overlay.frameOfReferenceUid) fail('mask grid or Frame of Reference differs from the source');
    for (const key of ['position', 'orientation', 'pixelSpacing']) {
        if (!Array.isArray(frame[key]) || frame[key].length !== overlay[key].length || frame[key].some((value, index) => value !== overlay[key][index])) fail('mask geometry differs; transformed grid binding is unsupported');
    }
}
