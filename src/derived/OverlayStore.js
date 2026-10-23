import { createImageReference, normalizeImageReference, assertAnnotationFrame, compatibleImageReferences } from '../annotations/model.js';
import { orientation } from '../volume/geometry.js';
import { MAX_DERIVED_BYTES, MAX_DERIVED_RECORDS, integer, uid, assertGrid, fail, checkSignal } from './common.js';

export const OVERLAY_SCHEMA = 'easi-view.overlays';
export const MAX_OVERLAYS_PER_IMAGE = 64;
const ALLOWED = ['id', 'image', 'kind', 'values', 'maximum', 'fractionalType', 'segment', 'geometry', 'source', 'opacity', 'color'];
function fields(value, allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('unsupported overlay fields');
}
function code(value) {
    fields(value, ['value', 'scheme', 'meaning', 'version']);
    for (const key of ['value', 'scheme', 'meaning']) if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > (key === 'meaning' ? 64 : 16) || /[\u0000-\u001F\\]/u.test(value[key])) fail('invalid segment code');
    if (value.version != null && (typeof value.version !== 'string' || !value.version || value.version.length > 16 || /[\u0000-\u001F\\]/u.test(value.version))) fail('invalid segment code version');
    return structuredClone(value);
}
function segment(value) {
    fields(value, ['number', 'label', 'algorithmType', 'algorithmName', 'category', 'type', 'recommendedCielab']);
    integer(value.number, 1, 65535);
    if (typeof value.label !== 'string' || !value.label.trim() || value.label.length > 64 || /[\u0000-\u001F\\]/u.test(value.label) ||
        !['MANUAL', 'AUTOMATIC', 'SEMIAUTOMATIC'].includes(value.algorithmType) ||
        value.algorithmType !== 'MANUAL' && (typeof value.algorithmName !== 'string' || !value.algorithmName.trim() || value.algorithmName.length > 64)) fail('invalid segment description');
    if (value.algorithmName != null && (typeof value.algorithmName !== 'string' || !value.algorithmName.trim() || value.algorithmName.length > 64 || /[\u0000-\u001F\\]/u.test(value.algorithmName))) fail('invalid algorithm name');
    if (value.recommendedCielab != null && (!Array.isArray(value.recommendedCielab) || value.recommendedCielab.length !== 3 ||
        value.recommendedCielab.some(component => !Number.isInteger(component) || component < 0 || component > 65535))) fail('invalid segment color recommendation');
    return { ...structuredClone(value), category: code(value.category), type: code(value.type) };
}
function normalize(input) {
    fields(input, ALLOWED);
    if (typeof input.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(input.id)) fail('overlay id is invalid');
    const image = normalizeImageReference(input.image), count = image.rows * image.columns;
    if (!['binary', 'fractional', 'probability'].includes(input.kind) || !(Array.isArray(input.values) || input.values instanceof Uint8Array || input.values instanceof Float32Array) || input.values.length !== count) fail('overlay sample layout is invalid');
    const maximum = input.kind === 'fractional' ? integer(input.maximum, 1, 255) : 1;
    if (input.maximum != null && input.maximum !== maximum || input.kind === 'fractional' && !['PROBABILITY', 'OCCUPANCY'].includes(input.fractionalType) ||
        input.kind === 'probability' && input.fractionalType != null && input.fractionalType !== 'PROBABILITY' || input.kind === 'binary' && input.fractionalType != null) fail('overlay fractional semantics are invalid');
    for (const value of input.values) if (!Number.isFinite(value) || value < 0 || value > maximum || input.kind !== 'probability' && !Number.isInteger(value)) fail('overlay samples exceed their declared semantics');
    const opacity = input.opacity ?? 0.5, color = input.color ?? [0, 200, 160], source = input.source ?? 'ai';
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1 || !Array.isArray(color) || color.length !== 3 || color.some(value => !Number.isInteger(value) || value < 0 || value > 255) || !['ai', 'seg'].includes(source)) fail('overlay style or source is invalid');
    const result = { id: input.id, image, kind: input.kind, maximum, fractionalType: input.kind === 'binary' ? null : input.kind === 'probability' ? 'PROBABILITY' : input.fractionalType,
        values: input.kind === 'probability' ? Float32Array.from(input.values) : Uint8Array.from(input.values), opacity, color: [...color], source };
    if (input.segment != null) result.segment = segment(input.segment);
    if (input.geometry != null) {
        fields(input.geometry, ['rows', 'columns', 'frameOfReferenceUid', 'position', 'orientation', 'pixelSpacing']);
        const g = input.geometry; uid(g.frameOfReferenceUid);
        if (g.rows !== image.rows || g.columns !== image.columns || image.frameOfReferenceUid !== g.frameOfReferenceUid ||
            !Array.isArray(g.position) || g.position.length !== 3 || !Array.isArray(g.orientation) || g.orientation.length !== 6 ||
            !Array.isArray(g.pixelSpacing) || g.pixelSpacing.length !== 2 || [...g.position, ...g.orientation, ...g.pixelSpacing].some(value => !Number.isFinite(value))) fail('overlay geometry is invalid');
        if (g.pixelSpacing.some(value => value <= 0)) fail('overlay physical spacing is invalid'); orientation(g.orientation);
        result.geometry = structuredClone(g);
    }
    if (source === 'seg' && (!result.geometry || !result.segment)) fail('SEG overlay requires exact grid geometry and a segment description');
    return result;
}
function payload(items) {
    return { schema: OVERLAY_SCHEMA, version: 1, coordinateSystem: 'image-grid', frameNumberBase: 1,
        overlays: [...items.values()].map(item => { const { values, ...metadata } = item; return { ...structuredClone(metadata), values: [...values] }; }) };
}
function copy(item) { return structuredClone(item); }
function bytes(items) { return [...items.values()].reduce((sum, item) => sum + item.values.byteLength + new TextEncoder().encode(JSON.stringify({ ...item, values: undefined })).byteLength, 0); }
function checkJsonBudget(items, maxBytes) {
    integer(maxBytes, 1, MAX_DERIVED_BYTES);
    const expanded = [...items.values()].reduce((sum, item) => sum + item.values.length * (item.kind === 'probability' ? 24 : item.kind === 'binary' ? 2 : 4) +
        new TextEncoder().encode(JSON.stringify({ ...item, values: undefined })).byteLength + 32, 128);
    if (expanded > maxBytes) fail('JSON expansion exceeds export byte budget');
}
function sampleBytes(input) {
    const image = normalizeImageReference(input?.image), count = image.rows * image.columns;
    return count * (input.kind === 'probability' ? 4 : 1);
}

/** Explicit in-memory AI/SEG overlays; originals are never altered or uploaded. */
export class OverlayStore {
    constructor({ maxBytes = MAX_DERIVED_BYTES, maxRecords = MAX_DERIVED_RECORDS } = {}) {
        integer(maxBytes, 1, MAX_DERIVED_BYTES); integer(maxRecords, 1, MAX_DERIVED_RECORDS);
        this.maxBytes = maxBytes; this.maxRecords = maxRecords; this._items = new Map(); this._listeners = new Set(); this._revision = 0; this.disposed = false;
    }
    _active() { if (this.disposed) fail('overlay store is disposed'); }
    _commit(items) {
        if (items.size > this.maxRecords || bytes(items) > this.maxBytes) fail('overlay count or byte budget exceeded');
        const perImage = new Map();
        for (const item of items.values()) {
            const key = `${item.image.sopUid}/${item.image.frameNumber}`, previous = perImage.get(key), count = (previous?.count ?? 0) + 1;
            if (count > MAX_OVERLAYS_PER_IMAGE) fail('per-image overlay count exceeded');
            if (previous && !compatibleImageReferences(previous.image, item.image)) fail('overlays disagree about source image geometry');
            if (previous?.geometry && item.geometry && JSON.stringify(previous.geometry) !== JSON.stringify(item.geometry)) fail('overlays disagree about exact source grid geometry');
            perImage.set(key, { count, image: { ...previous?.image, ...item.image }, geometry: item.geometry ?? previous?.geometry });
        }
        this._items = items; ++this._revision;
        for (const listener of [...this._listeners]) { try { const result = listener({ count: items.size, bytes: bytes(items) }); if (result?.then) Promise.resolve(result).catch(() => {}); } catch {} }
    }
    add(input) {
        this._active(); if (sampleBytes(input) + bytes(this._items) > this.maxBytes) fail('overlay samples exceed byte budget'); const item = normalize(input);
        if (this._items.has(item.id)) fail('overlay id collision'); const next = new Map(this._items); next.set(item.id, item); this._commit(next); return copy(item);
    }
    updateStyle(id, style) {
        this._active(); fields(style, ['opacity', 'color']); const previous = this._items.get(id); if (!previous) fail('overlay id not found');
        const opacity = Object.hasOwn(style, 'opacity') ? style.opacity : previous.opacity, color = Object.hasOwn(style, 'color') ? style.color : previous.color;
        if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1 || !Array.isArray(color) || color.length !== 3 || color.some(value => !Number.isInteger(value) || value < 0 || value > 255)) fail('overlay style is invalid');
        const item = { ...previous, opacity, color: [...color] }, next = new Map(this._items); next.set(id, item); this._commit(next);
        return { id, opacity, color: [...color] }; // A style change never copies a potentially large mask.
    }
    remove(id) { this._active(); const next = new Map(this._items); if (!next.delete(id)) return false; this._commit(next); return true; }
    get(id) { this._active(); return this._items.has(id) ? copy(this._items.get(id)) : null; }
    list(image = null) {
        this._active(); const normalized = image == null ? null : normalizeImageReference(image);
        return [...this._items.values()].filter(item => !normalized || item.image.sopUid === normalized.sopUid && item.image.frameNumber === normalized.frameNumber).map(copy);
    }
    listDescriptors(image = null) {
        this._active(); const normalized = image == null ? null : normalizeImageReference(image);
        return [...this._items.values()].filter(item => !normalized || item.image.sopUid === normalized.sopUid && item.image.frameNumber === normalized.frameNumber)
            .map(({ values, ...metadata }) => structuredClone(metadata));
    }
    render(frame, options = {}) {
        this._active();
        const items = [...this._items.values()].filter(item => item.image.sopUid === frame.sopUid && item.image.frameNumber === frame.frameIndex + 1);
        return renderItems(items, frame, options, () => this._active());
    }
    export({ maxBytes = MAX_DERIVED_BYTES } = {}) { this._active(); checkJsonBudget(this._items, maxBytes); return payload(this._items); }
    exportJson({ maxBytes = MAX_DERIVED_BYTES } = {}) {
        this._active(); integer(maxBytes, 1, MAX_DERIVED_BYTES);
        // Conservative preflight bounds avoid constructing an unbounded numeric array/string.
        const text = JSON.stringify(this.export({ maxBytes })); if (new TextEncoder().encode(text).length > maxBytes) fail('JSON export exceeds byte budget'); return text;
    }
    import(input, { mode = 'merge' } = {}) {
        this._active(); if (!['merge', 'replace'].includes(mode)) fail('overlay import mode is invalid');
        if (typeof input === 'string') { if (input.length > MAX_DERIVED_BYTES || new TextEncoder().encode(input).length > MAX_DERIVED_BYTES) fail('JSON input exceeds byte budget'); input = JSON.parse(input); }
        fields(input, ['schema', 'version', 'coordinateSystem', 'frameNumberBase', 'overlays']);
        if (input.schema !== OVERLAY_SCHEMA || input.version !== 1 || input.coordinateSystem !== 'image-grid' || input.frameNumberBase !== 1 ||
            !Array.isArray(input.overlays) || input.overlays.length > this.maxRecords) fail('unsupported overlay schema');
        const next = mode === 'merge' ? new Map(this._items) : new Map();
        let allocation = 0;
        for (const raw of input.overlays) {
            if (!Array.isArray(raw?.values) && !(raw?.values instanceof Uint8Array || raw?.values instanceof Float32Array)) fail('overlay values must be explicit');
            allocation += raw.values.length * (raw.kind === 'probability' ? 4 : 1);
            if (allocation > this.maxBytes) fail('imported samples exceed byte budget');
            const item = normalize(raw); if (next.has(item.id)) fail('overlay id collision'); next.set(item.id, item);
        }
        this._commit(next); return input.overlays.length;
    }
    subscribe(listener) { this._active(); if (typeof listener !== 'function') fail('overlay observer must be a function'); this._listeners.add(listener); return () => this._listeners.delete(listener); }
    getRevision() { return this._revision; }
    getState() { this._active(); return { count: this._items.size, bytes: bytes(this._items), maxBytes: this.maxBytes, maxRecords: this.maxRecords }; }
    dispose() { if (this.disposed) return; ++this._revision; this._items.clear(); this._listeners.clear(); this.disposed = true; }
}

/** RGBA channels declare their alpha convention; masks never become source intensities. */
export async function renderOverlayRgba(overlays, frame, { alphaMode = 'straight', signal, maxBytes = MAX_DERIVED_BYTES } = {}) {
    if (!Array.isArray(overlays) || overlays.length > MAX_OVERLAYS_PER_IMAGE) fail('overlay rendering mode is invalid');
    checkSignal(signal); checkRenderBudget(overlays.length, frame, alphaMode, maxBytes);
    if (overlays.reduce((sum, item) => sum + sampleBytes(item), 0) > MAX_DERIVED_BYTES) fail('overlay input copies exceed byte budget');
    return renderItems(overlays.map(normalize), frame, { alphaMode, signal, maxBytes });
}
function checkRenderBudget(count, frame, alphaMode, maxBytes) {
    integer(maxBytes, 1, MAX_DERIVED_BYTES); createImageReference(frame);
    if (count > MAX_OVERLAYS_PER_IMAGE || !['straight', 'premultiplied'].includes(alphaMode)) fail('overlay rendering mode is invalid');
    const pixels = frame.rows * frame.columns;
    if (!Number.isSafeInteger(pixels) || pixels < 1 || pixels > 16 * 1024 * 1024 || pixels * 4 > maxBytes || pixels * count > 16 * 1024 * 1024) fail('overlay rendering budget exceeded');
    return pixels;
}
async function renderItems(items, frame, { alphaMode = 'straight', signal, maxBytes = MAX_DERIVED_BYTES } = {}, active = () => {}) {
    checkSignal(signal); const pixels = checkRenderBudget(items.length, frame, alphaMode, maxBytes);
    for (const item of items) {
        assertAnnotationFrame({ image: item.image }, frame);
        if (item.geometry) assertGrid(item.geometry, frame);
    }
    const rgba = new Uint8ClampedArray(pixels * 4);
    for (let start = 0; start < pixels; start += 16384) {
        checkSignal(signal); active();
        for (let pixel = start; pixel < Math.min(pixels, start + 16384); pixel++) {
            let r = 0, g = 0, b = 0, a = 0;
            for (const item of items) {
                const opacity = item.values[pixel] / item.maximum * item.opacity;
                r = item.color[0] / 255 * opacity + r * (1 - opacity); g = item.color[1] / 255 * opacity + g * (1 - opacity);
                b = item.color[2] / 255 * opacity + b * (1 - opacity); a = opacity + a * (1 - opacity);
            }
            const divisor = alphaMode === 'straight' && a ? a : 1;
            rgba[pixel * 4] = Math.round(r / divisor * 255); rgba[pixel * 4 + 1] = Math.round(g / divisor * 255);
            rgba[pixel * 4 + 2] = Math.round(b / divisor * 255); rgba[pixel * 4 + 3] = Math.round(a * 255);
        }
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    checkSignal(signal); active(); return { rows: frame.rows, columns: frame.columns, rgba, alphaMode, bytes: rgba.byteLength };
}
