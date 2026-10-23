import { createImageReference } from '../annotations/model.js';
import { abortable, checkSignal } from '../derived/common.js';

export const MAX_OVERLAY_RENDER_BYTES = 32 * 1024 * 1024;
const canceled = () => new DOMException('Overlay rendering was canceled.', 'AbortError');
function limit(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_OVERLAY_RENDER_BYTES) throw new RangeError('Overlay rendering budget is invalid.');
    return value;
}
function releaseBitmap(entry) { entry.bitmap?.close?.(); if (entry.bitmap && !entry.bitmap.close) { entry.bitmap.width = 0; entry.bitmap.height = 0; } entry.bitmap = null; }

/** Shared nominal RGBA accounting, including visible/rollback leases and staging. */
export class OverlayRenderCache {
    constructor(store, { maxBytes = MAX_OVERLAY_RENDER_BYTES, document = globalThis.document } = {}) {
        if (!store?.render || !store?.subscribe || !store?.getRevision || !document?.createElement) throw new TypeError('An overlay store and canvas document are required.');
        this.store = store; this.document = document; this.maxBytes = limit(maxBytes);
        this.revision = store.getRevision(); this.epoch = 0; this.disposed = false; this.entries = new Map(); this.displays = new Map();
        this.unsubscribe = store.subscribe(() => this._syncRevision());
    }
    _syncRevision() {
        const revision = this.store.getRevision();
        if (revision !== this.revision) {
            this.revision = revision; ++this.epoch;
            for (const entry of [...this.entries.values()]) {
                if (entry.pending) entry.controller.abort();
                else if (!entry.users) this._remove(entry);
            }
        }
        return this.revision;
    }
    getEpoch() { this._syncRevision(); return this.epoch; }
    _active() { if (this.disposed) throw new Error('Overlay render cache is disposed.'); }
    _bytes() { return [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0) + [...this.displays.values()].reduce((sum, bytes) => sum + bytes, 0); }
    _remove(entry) { if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key); releaseBitmap(entry); entry.bytes = 0; }
    _reserve(bytes, replacing = 0) {
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maxBytes) throw new RangeError('Overlay rendering exceeds its byte budget.');
        for (const entry of [...this.entries.values()]) {
            if (this._bytes() - replacing + bytes <= this.maxBytes) break;
            if (!entry.users && !entry.pending) this._remove(entry);
        }
        if (this._bytes() - replacing + bytes > this.maxBytes) throw new RangeError('Overlay rendering exceeds its shared byte budget.');
    }
    setDisplayBytes(owner, bytes) { this._active(); this._reserve(bytes, this.displays.get(owner) ?? 0); this.displays.set(owner, bytes); }
    releaseDisplay(owner) { this.displays.delete(owner); }
    _release(entry) {
        if (entry.users > 0) --entry.users;
        if (!entry.users && entry.pending) entry.controller.abort();
        if (!entry.users && !entry.pending && (this.disposed || entry.revision !== this.revision || entry.epoch !== this.epoch)) this._remove(entry);
    }
    async acquire(frame, { signal } = {}) {
        this._active(); this._syncRevision(); checkSignal(signal);
        const image = createImageReference(frame), descriptors = this.store.listDescriptors(image);
        if (!descriptors.some(item => item.opacity > 0)) return null;
        const pixels = image.rows * image.columns, size = pixels * 4;
        if (!Number.isSafeInteger(size) || pixels > 16 * 1024 * 1024) throw new RangeError('Overlay image dimensions are unsupported.');
        const key = `${this.epoch}/${JSON.stringify(image)}`;
        let entry = this.entries.get(key);
        if (!entry) {
            // A pending typed RGBA and its canvas bitmap coexist during putImageData.
            this._reserve(size * 2);
            entry = { key, revision: this.revision, epoch: this.epoch, users: 0, bytes: size * 2, pending: true, bitmap: null, controller: new AbortController() };
            this.entries.set(key, entry);
            const owned = entry;
            entry.promise = (async () => {
                const result = await this.store.render(frame, { alphaMode: 'straight', signal: owned.controller.signal, maxBytes: size });
                checkSignal(owned.controller.signal); this._active(); this._syncRevision();
                if (owned.revision !== this.revision || owned.epoch !== this.epoch) throw canceled();
                if (result.alphaMode !== 'straight' || result.rows !== image.rows || result.columns !== image.columns || result.rgba.byteLength !== size) throw new Error('Overlay rendering returned an inconsistent RGBA layout.');
                const bitmap = this.document.createElement('canvas');
                bitmap.height = 0;
                bitmap.width = image.columns; bitmap.height = image.rows;
                owned.bitmap = bitmap;
                const context = bitmap.getContext('2d'); if (!context) throw new Error('A Canvas2D overlay renderer is required.');
                const ImageDataClass = this.document.defaultView?.ImageData ?? globalThis.ImageData;
                let data;
                if (ImageDataClass) data = new ImageDataClass(result.rgba, image.columns, image.rows);
                else throw new Error('An owned ImageData implementation is required.');
                context.putImageData(data, 0, 0);
                checkSignal(owned.controller.signal); this._active(); this._syncRevision();
                owned.bytes = size; owned.pending = false;
                return { bitmap, rows: image.rows, columns: image.columns, bytes: size };
            })().catch(error => { owned.pending = false; this._remove(owned); throw error; });
            entry.promise.catch(() => {});
        } else { this.entries.delete(key); this.entries.set(key, entry); }
        ++entry.users;
        try {
            const value = await abortable(() => entry.promise, signal); this._active(); this._syncRevision(); checkSignal(signal);
            if (entry.revision !== this.revision || entry.epoch !== this.epoch || !entry.bitmap) throw canceled();
            let released = false;
            return { ...value, revision: entry.revision, epoch: entry.epoch, release: () => { if (!released) { released = true; this._release(entry); } } };
        } catch (error) { this._release(entry); throw error; }
    }
    getState() {
        return { disposed: this.disposed, bytes: this._bytes(), maxBytes: this.maxBytes,
            cachedCount: [...this.entries.values()].filter(entry => !entry.pending).length,
            pendingCount: [...this.entries.values()].filter(entry => entry.pending).length,
            displayCount: this.displays.size, revision: this.revision };
    }
    clear() {
        this._active(); this._syncRevision(); ++this.epoch;
        for (const entry of [...this.entries.values()]) { entry.controller.abort(); if (!entry.users && !entry.pending) this._remove(entry); }
    }
    dispose() {
        if (this.disposed) return; this.disposed = true; this.unsubscribe();
        const pending = [...this.entries.values()].filter(entry => entry.pending).map(entry => entry.promise);
        this.cleanupDone = Promise.allSettled(pending).then(() => {});
        for (const entry of [...this.entries.values()]) { entry.controller.abort(); if (!entry.pending) this._remove(entry); }
        this.displays.clear();
    }
    whenDisposed() {
        if (!this.disposed) throw new Error('Dispose the overlay render cache before awaiting cleanup.');
        return this.cleanupDone;
    }
}

/** A separate mask canvas follows the same image-edge transform as the viewport. */
export class DerivedOverlayLayer {
    constructor(imageCanvas, viewport, cache) {
        if (!imageCanvas?.ownerDocument?.createElement || !viewport?.imageToScreen || !(cache instanceof OverlayRenderCache)) throw new TypeError('An image canvas, viewport and shared overlay cache are required.');
        this.imageCanvas = imageCanvas; this.viewport = viewport; this.cache = cache; this.disposed = false;
        this.canvas = imageCanvas.ownerDocument.createElement('canvas'); this.canvas.height = 0; this.canvas.width = 0; this.canvas.className = 'derived-overlay-canvas';
        this.canvas.setAttribute('aria-hidden', 'true'); this.canvas.style?.setProperty('pointer-events', 'none');
        imageCanvas.after(this.canvas); this.context = this.canvas.getContext('2d');
        if (!this.context) { this.canvas.remove(); throw new Error('A Canvas2D overlay renderer is required.'); }
        this.canvas.width = 0; this.canvas.height = 0;
        this.lease = null; this.frame = null; this.generation = 0; this.controller = null;
    }
    _active() { if (this.disposed) throw new Error('Derived overlay layer is disposed.'); }
    _dimensions() {
        const width = this.imageCanvas.width, height = this.imageCanvas.height;
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw new RangeError('Overlay display dimensions are invalid.');
        return { width, height, bytes: width * height * 4 };
    }
    _resize() {
        const { width, height, bytes } = this._dimensions();
        this.cache.setDisplayBytes(this, bytes); // Validate the shared cap before canvas allocation.
        if (this.canvas.width !== width || this.canvas.height !== height) {
            // Zero one axis so crossing aspect ratios cannot allocate an oversized intermediate bitmap.
            this.canvas.height = 0; this.canvas.width = width; this.canvas.height = height;
        }
    }
    _matches(frame) {
        try {
            if (!frame || !this.viewport.frame) return false;
            this.cache.getEpoch();
            if (this.lease && (this.lease.revision !== this.cache.revision || this.lease.epoch !== this.cache.epoch)) return false;
            const expected = createImageReference(frame), actual = createImageReference(this.viewport.frame);
            return ['sopUid', 'frameNumber', 'rows', 'columns', 'seriesUid', 'frameOfReferenceUid', 'geometryFingerprint'].every(key => expected[key] === actual[key]);
        } catch { return false; }
    }
    _draw(lease) {
        const context = this.context;
        if (!lease) { this._resize(); context.setTransform(1,0,0,1,0,0);context.clearRect(0,0,this.canvas.width,this.canvas.height);return; }
        const origin = this.viewport.imageToScreen(0, 0), x = this.viewport.imageToScreen(1, 0), y = this.viewport.imageToScreen(0, 1);
        if (![origin, x, y].every(point => point && Number.isFinite(point.x) && Number.isFinite(point.y))) throw new Error('Overlay image transform is invalid.');
        const rectangle = this.imageCanvas.getBoundingClientRect(), dimensions = this._dimensions(), ratioX = dimensions.width / rectangle.width, ratioY = dimensions.height / rectangle.height;
        if (![ratioX, ratioY].every(value => Number.isFinite(value) && value > 0)) throw new Error('Overlay display scale is invalid.');
        this._resize();context.setTransform(1,0,0,1,0,0);context.clearRect(0,0,this.canvas.width,this.canvas.height);
        context.setTransform((x.x - origin.x) * ratioX, (x.y - origin.y) * ratioY, (y.x - origin.x) * ratioX, (y.y - origin.y) * ratioY, origin.x * ratioX, origin.y * ratioY);
        context.imageSmoothingEnabled = false; context.drawImage(lease.bitmap, 0, 0);
        context.setTransform(1, 0, 0, 1, 0, 0);
    }
    async render(frame, { signal } = {}) {
        this._active(); checkSignal(signal);
        if (!frame) { this.clear(); return; }
        if (!this.cache.store.listDescriptors(createImageReference(frame)).some(item => item.opacity > 0)) { this.clear();this.frame=frame;return; }
        const token = ++this.generation; this.controller?.abort(); const controller = new AbortController(); this.controller = controller;
        const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
        let candidate = null;
        try {
            // Reserve both the existing display and its prospective size before mask work.
            const dimensions = this._dimensions();this.cache.setDisplayBytes(this,Math.max(dimensions.bytes,this.canvas.width*this.canvas.height*4));
            this.canvas.hidden = !this._matches(this.frame);candidate = await this.cache.acquire(frame, { signal: controller.signal });
            this._active(); checkSignal(controller.signal); if (token !== this.generation) throw canceled();
            this.cache.getEpoch();if(candidate && (candidate.revision!==this.cache.revision||candidate.epoch!==this.cache.epoch))throw canceled();
            try { this._draw(candidate); } catch (error) { this._draw(this.lease); throw error; }
            const previous = this.lease; this.lease = candidate; candidate = null; this.frame = frame; this.canvas.hidden = false;previous?.release();
        } finally {
            candidate?.release(); if(token===this.generation&&!this.disposed&&!this.cache.disposed){this.cache.setDisplayBytes(this,this.canvas.width*this.canvas.height*4);this.canvas.hidden=!this._matches(this.frame);} signal?.removeEventListener('abort', abort); if (this.controller === controller) this.controller = null;
        }
    }
    resize() {
        this._active();
        // An unmasked image needs no transparent full-viewport bitmap. Leave a
        // pending candidate and its admitted reservation owned by render().
        if (!this.lease) { this.canvas.hidden = true; return; }
        this.canvas.hidden = !this._matches(this.frame); if (!this.canvas.hidden) this._draw(this.lease);
    }
    clear() {
        if (this.disposed) return; ++this.generation; this.controller?.abort(); this.controller = null; this.lease?.release(); this.lease = null; this.frame = null;
        this.context.setTransform(1, 0, 0, 1, 0, 0); this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.canvas.width = 0; this.canvas.height = 0;this.canvas.hidden=true; this.cache.releaseDisplay(this);
    }
    getState() { return { disposed: this.disposed, visible: Boolean(this.lease)&&!this.canvas.hidden, pending: Boolean(this.controller), bytes: this.disposed ? 0 : this.canvas.width * this.canvas.height * 4 }; }
    dispose() { if (this.disposed) return; this.clear(); this.disposed = true; this.canvas.remove(); }
}
