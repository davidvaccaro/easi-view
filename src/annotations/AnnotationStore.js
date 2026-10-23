import { annotationError, exactKeys } from './geometry.js';
import { normalizeAnnotation, normalizeImageReference, compatibleImageReferences, imageKey, annotationId } from './model.js';

export const ANNOTATION_SCHEMA = 'easi-view.annotations';
export const ANNOTATION_VERSION = 1;
export const MAX_ANNOTATION_BYTES = 1024 * 1024;
export const MAX_ANNOTATIONS = 1000;
export const MAX_ANNOTATIONS_PER_IMAGE = 200;
export const MAX_ANNOTATION_HISTORY = 128;
export const MAX_ANNOTATION_HISTORY_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const copy = value => structuredClone(value);
function payload(annotations) {
    return { schema: ANNOTATION_SCHEMA, version: ANNOTATION_VERSION, coordinateSystem: 'image-edge', frameNumberBase: 1, annotations };
}
function byteLength(value) { return encoder.encode(JSON.stringify(value)).byteLength; }
function freeze(annotation) {
    Object.freeze(annotation.image);
    for (const point of annotation.points) Object.freeze(point);
    Object.freeze(annotation.points);
    return Object.freeze(annotation);
}
function integer(value, minimum, maximum) { return Number.isSafeInteger(value) && value >= minimum && value <= maximum; }

/** In-memory durable model. Persistence/export are explicit host actions. */
export class AnnotationStore {
    constructor({ maxBytes = MAX_ANNOTATION_BYTES, maxAnnotations = MAX_ANNOTATIONS,
        maxPerImage = MAX_ANNOTATIONS_PER_IMAGE, historyLimit = 64, historyBytes = MAX_ANNOTATION_HISTORY_BYTES, idFactory } = {}) {
        if (!integer(maxBytes, 1, MAX_ANNOTATION_BYTES) || !integer(maxAnnotations, 1, MAX_ANNOTATIONS) ||
            !integer(maxPerImage, 1, MAX_ANNOTATIONS_PER_IMAGE) || !integer(historyLimit, 0, MAX_ANNOTATION_HISTORY) ||
            !integer(historyBytes, 0, MAX_ANNOTATION_HISTORY_BYTES) || idFactory != null && typeof idFactory !== 'function') {
            throw annotationError('store limits or id factory are invalid');
        }
        this.maxBytes = maxBytes; this.maxAnnotations = maxAnnotations; this.maxPerImage = maxPerImage;
        this.historyLimit = historyLimit; this.historyBudget = historyBytes;
        this._items = new Map(); this._undo = []; this._redo = []; this._historyBytes = 0;
        this._listeners = new Set(); this._disposed = false; this._nextId = 1;
        this._idFactory = idFactory ?? (() => globalThis.crypto?.randomUUID?.() ?? `annotation-${this._nextId++}`);
        this.bytes = byteLength(payload([]));
        if (this.bytes > maxBytes) throw annotationError('byte budget cannot hold the schema');
    }

    _assertActive() { if (this._disposed) throw annotationError('store is disposed'); }
    _validate(items) {
        if (items.size > this.maxAnnotations) throw annotationError('annotation count limit exceeded');
        const images = new Map();
        for (const annotation of items.values()) {
            const key = imageKey(annotation.image), group = images.get(key);
            if (!group) images.set(key, { reference: annotation.image, count: 1 });
            else {
                if (!compatibleImageReferences(group.reference, annotation.image)) throw annotationError('annotations disagree about image geometry or identity');
                if (++group.count > this.maxPerImage) throw annotationError('per-image annotation limit exceeded');
                // Preserve optional fields for comparison with later records,
                // so an unspecified reference cannot hide conflicting values.
                group.reference = { ...group.reference, ...annotation.image };
            }
        }
        const bytes = byteLength(payload([...items.values()]));
        if (bytes > this.maxBytes) throw annotationError('annotation byte limit exceeded');
        return bytes;
    }
    _emit(type, id) {
        const event = Object.freeze({ type, count: this._items.size, ...(id ? { id } : {}) });
        for (const listener of [...this._listeners]) {
            try { const result = listener(event); if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {}); }
            catch { /* Optional host observers cannot change a committed edit. */ }
        }
    }
    _commit(items, type, id) {
        const bytes = this._validate(items), before = [...this._items.values()], after = [...items.values()];
        const cost = byteLength(payload(before)) + bytes;
        for (const entry of this._redo) this._historyBytes -= entry.bytes;
        this._redo = [];
        if (this.historyLimit && cost <= this.historyBudget) {
            this._undo.push({ before, after, bytes: cost }); this._historyBytes += cost;
        } else {
            this._undo = []; this._historyBytes = 0;
        }
        while (this._undo.length > this.historyLimit || this._historyBytes > this.historyBudget) this._historyBytes -= this._undo.shift().bytes;
        this._items = items; this.bytes = bytes;
        this._emit(type, id);
    }

    add(input) {
        this._assertActive();
        exactKeys(input, ['id', 'tool', 'image', 'points']);
        const annotation = freeze(normalizeAnnotation({ ...input, id: input.id ?? this._idFactory() }));
        if (this._items.has(annotation.id)) throw annotationError('annotation id collision');
        const next = new Map(this._items); next.set(annotation.id, annotation);
        this._commit(next, 'add', annotation.id);
        return copy(annotation);
    }
    update(id, changes) {
        this._assertActive(); annotationId(id); exactKeys(changes, ['points']);
        const previous = this._items.get(id);
        if (!previous) throw annotationError('annotation id was not found');
        if (!Object.hasOwn(changes, 'points')) throw annotationError('an edit must supply points');
        const annotation = freeze(normalizeAnnotation({ ...previous, points: changes.points }));
        const next = new Map(this._items); next.set(id, annotation);
        this._commit(next, 'update', id);
        return copy(annotation);
    }
    remove(id) {
        this._assertActive(); annotationId(id);
        const previous = this._items.get(id);
        if (!previous) throw annotationError('annotation id was not found');
        const next = new Map(this._items); next.delete(id);
        this._commit(next, 'remove', id);
        return copy(previous);
    }
    clear() {
        this._assertActive();
        if (!this._items.size) return false;
        this._commit(new Map(), 'clear'); return true;
    }
    get(id) { this._assertActive(); return this._items.has(id) ? copy(this._items.get(id)) : null; }
    list(image = null) {
        this._assertActive();
        const reference = image == null ? null : normalizeImageReference(image);
        return [...this._items.values()].filter(annotation => !reference || compatibleImageReferences(reference, annotation.image)).map(copy);
    }
    get canUndo() { return !this._disposed && this._undo.length > 0; }
    get canRedo() { return !this._disposed && this._redo.length > 0; }
    undo() {
        this._assertActive();
        const entry = this._undo.pop(); if (!entry) return false;
        this._redo.push(entry); this._items = new Map(entry.before.map(annotation => [annotation.id, annotation]));
        this.bytes = byteLength(payload(entry.before)); this._emit('undo'); return true;
    }
    redo() {
        this._assertActive();
        const entry = this._redo.pop(); if (!entry) return false;
        this._undo.push(entry); this._items = new Map(entry.after.map(annotation => [annotation.id, annotation]));
        this.bytes = byteLength(payload(entry.after)); this._emit('redo'); return true;
    }
    clearHistory() { this._assertActive(); this._undo = []; this._redo = []; this._historyBytes = 0; }

    export() { this._assertActive(); return copy(payload([...this._items.values()])); }
    exportJson() { this._assertActive(); return JSON.stringify(payload([...this._items.values()])); }
    toJSON() { return this.export(); }
    import(input, options = {}) {
        this._assertActive(); exactKeys(options, ['mode']);
        const mode = options.mode ?? 'merge';
        if (!['merge', 'replace'].includes(mode)) throw annotationError('import mode must be merge or replace');
        let document = input;
        if (typeof input === 'string') {
            if (input.length > this.maxBytes || encoder.encode(input).byteLength > this.maxBytes) throw annotationError('import byte limit exceeded');
            try { document = JSON.parse(input); } catch { throw annotationError('import is not valid JSON'); }
        }
        exactKeys(document, ['schema', 'version', 'coordinateSystem', 'frameNumberBase', 'annotations']);
        if (document.schema !== ANNOTATION_SCHEMA || document.version !== ANNOTATION_VERSION || document.coordinateSystem !== 'image-edge' ||
            document.frameNumberBase !== 1 || !Array.isArray(document.annotations) || document.annotations.length > this.maxAnnotations) {
            throw annotationError('unsupported annotation schema or annotation count');
        }
        const next = mode === 'merge' ? new Map(this._items) : new Map();
        let importedBytes = byteLength(payload([]));
        for (const inputAnnotation of document.annotations) {
            const annotation = freeze(normalizeAnnotation(inputAnnotation));
            importedBytes += byteLength(annotation) + 1;
            if (importedBytes > this.maxBytes) throw annotationError('import byte limit exceeded');
            if (next.has(annotation.id)) throw annotationError('annotation id collision');
            next.set(annotation.id, annotation);
        }
        this._commit(next, 'import'); return document.annotations.length;
    }

    subscribe(listener) {
        this._assertActive(); if (typeof listener !== 'function') throw annotationError('listener must be a function');
        this._listeners.add(listener); return () => this._listeners.delete(listener);
    }
    getState() {
        this._assertActive();
        return { count: this._items.size, bytes: this.bytes, maxBytes: this.maxBytes, maxAnnotations: this.maxAnnotations,
            maxPerImage: this.maxPerImage, canUndo: this.canUndo, canRedo: this.canRedo,
            historyCount: this._undo.length + this._redo.length, historyBytes: this._historyBytes, historyBudget: this.historyBudget };
    }
    dispose() {
        if (this._disposed) return;
        this._items.clear(); this._undo = []; this._redo = []; this._listeners.clear();
        this._historyBytes = 0; this.bytes = 0; this._idFactory = null; this._disposed = true;
    }
}
