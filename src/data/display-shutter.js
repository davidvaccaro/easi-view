import { Tag } from '@xinonix/easi-js';
import { getAttributeVR } from './attributes.js';

const CIRCULAR_TAGS = ['00181600', '00181610', '00181612', '00181622'];
const OTHER_TAGS = ['00181602', '00181604', '00181606', '00181608', '00181620', '00181623', '00181624', '00189472'];
const FIELDS = ['shape', 'row', 'column', 'radius', 'presentationValue', 'presentationValueDeclared'];
function unsupported() { throw new Error('This display-shutter profile supports one CIRCULAR monochrome shutter with bounded in-image integer center, radius and square pixels only.'); }
function values(set, id, vr) {
    const attr = set.find(Tag.find(id));
    if (!attr) return [];
    if (getAttributeVR(attr) !== vr) unsupported();
    // EASI's scalar US getter returns the first word. Inspect native bytes to
    // enforce VM before reading an optional Shutter Presentation Value.
    const bytes = vr === 'US' && attr.transferSyntax?.ID !== '0' ? attr.access?.() : null;
    if (bytes?.byteLength) {
        if (bytes.byteLength % 2 || bytes.byteLength > 32) unsupported();
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), result = [];
        for (let offset = 0; offset < bytes.byteLength; offset += 2) result.push(view.getUint16(offset, attr.transferSyntax?.IsLittleEndian ?? true));
        return result;
    }
    const raw = attr.value;
    if (raw == null || raw === '') return [];
    return Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split('\\').map(value => value.trim()) : [raw];
}
function integers(set, id, vr, count) {
    const list = values(set, id, vr);
    if (list.length !== count || list.some(value => typeof value !== 'number' && (typeof value !== 'string' || !/^[+-]?\d+$/u.test(value)))) unsupported();
    const result = list.map(Number);
    if (result.some(value => !Number.isSafeInteger(value))) unsupported();
    return result;
}

/** DICOM C.7.6.11: one-based raster coordinates and an independent final P-value. */
export function normalizeCircularShutter(set, metadata) {
    if (![...CIRCULAR_TAGS, ...OTHER_TAGS].some(id => set.has(Tag.find(id)))) return null;
    if (OTHER_TAGS.some(id => set.has(Tag.find(id)))) unsupported();
    const shape = values(set, '00181600', 'CS');
    if (shape.length !== 1 || shape[0] !== 'CIRCULAR') unsupported();
    const [row, column] = integers(set, '00181610', 'IS', 2);
    const [radius] = integers(set, '00181612', 'IS', 1);
    const declared = values(set, '00181622', 'US');
    const presentationValue = declared.length ? integers(set, '00181622', 'US', 1)[0] : 0;
    const shutter = Object.freeze({ shape: 'CIRCULAR', row, column, radius, presentationValue, presentationValueDeclared: declared.length > 0 });
    validateCircularShutter(metadata, shutter);
    // Do not replace an invalid declared pixel aspect with an assumed circle.
    if (!metadata.pixelSpacing && !metadata.pixelAspectRatio && ['00280030', '00280034'].some(id => set.has(Tag.find(id)))) unsupported();
    return shutter;
}

/** The bounded square-raster profile has exact CPU/GLSL integer boundary tests. */
export function validateCircularShutter(frame, shutter = frame.displayShutter) {
    if (shutter == null) return null;
    const aspect = frame.pixelSpacing ?? frame.pixelAspectRatio ?? [1, 1];
    if (!shutter || typeof shutter !== 'object' || Array.isArray(shutter) ||
        Object.keys(shutter).length !== FIELDS.length || FIELDS.some(field => !Object.hasOwn(shutter, field)) ||
        shutter.shape !== 'CIRCULAR' || !['MONOCHROME1', 'MONOCHROME2'].includes(frame.photometric) ||
        !Number.isInteger(frame.rows) || !Number.isInteger(frame.columns) || frame.rows < 1 || frame.columns < 1 || frame.rows > 8192 || frame.columns > 8192 ||
        !Number.isInteger(shutter.row) || shutter.row < 1 || shutter.row > frame.rows ||
        !Number.isInteger(shutter.column) || shutter.column < 1 || shutter.column > frame.columns ||
        !Number.isInteger(shutter.radius) || shutter.radius < 1 || shutter.radius > 8192 ||
        !Number.isInteger(shutter.presentationValue) || shutter.presentationValue < 0 || shutter.presentationValue > 65535 ||
        typeof shutter.presentationValueDeclared !== 'boolean' ||
        !Array.isArray(aspect) || aspect.length !== 2 || !aspect.every(value => Number.isFinite(value) && value > 0) || aspect[0] !== aspect[1]) unsupported();
    return shutter;
}

export function circularShutterOccludes(shutter, row, column) {
    const y = row - shutter.row, x = column - shutter.column;
    return x * x + y * y > shutter.radius * shutter.radius;
}
