import { OverlayStore, OVERLAY_SCHEMA, readDerivedInstance, importSeg, SEGMENTATION_SOP_CLASS,
    importSr, SUPPORTED_SR_CLASSES, importGsps, GSPS_SOP_CLASS, exportDerivedResults, importDerivedResults,
    DERIVED_RESULT_SCHEMA, MAX_RESULT_BYTES } from '../derived/index.js';
import { MAX_DERIVED_BYTES, checkSignal, text, assertGrid, abortable } from '../derived/common.js';
import { createImageReference, normalizeImageReference, assertAnnotationFrame } from '../annotations/model.js';

export const MAX_OVERLAY_STORE_BYTES = 32 * 1024 * 1024;
const SVG = 'http://www.w3.org/2000/svg';
const abortError = () => new DOMException('Derived-object processing was canceled.', 'AbortError');
function notify(callback, value) { try { const result = callback?.(value); if (result?.then) Promise.resolve(result).catch(() => {}); } catch {} }
function byteBudget(value, maximum) {
    let bytes = 0;
    function visit(item, depth) {
        if (depth > 12) throw new RangeError('Derived JSON nesting is unsupported.');
        if (item === null || typeof item === 'number' || typeof item === 'boolean') bytes += String(item).length;
        else if (typeof item === 'string') bytes += new TextEncoder().encode(JSON.stringify(item)).length;
        else if (Array.isArray(item)) { bytes += 2 + item.length; for (const child of item) visit(child, depth + 1); }
        else if (item && typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) {
            bytes += 2;
            for (const [key, child] of Object.entries(item)) { bytes += new TextEncoder().encode(JSON.stringify(key)).length + 2; visit(child, depth + 1); }
        } else throw new TypeError('Explicit derived JSON values are required.');
        if (bytes > maximum) throw new RangeError('Derived JSON exceeds its byte budget.');
    }
    visit(value, 0); return bytes;
}
function matches(image, frame) {
    assertAnnotationFrame({ image: normalizeImageReference(image) }, frame);
    const actual = createImageReference(frame);
    for (const key of ['seriesUid', 'frameOfReferenceUid', 'geometryFingerprint']) {
        if (image[key] !== actual[key]) throw new Error('Derived result requires the exact source grid and reference metadata.');
    }
}

/** Local, explicit derived-object actions. Reported values never become new ROI statistics. */
export class DerivedObjectPanel {
    constructor(root, { getFrame, resolveSource, onChange, onError, onApplyGsps } = {}) {
        if (typeof getFrame !== 'function' || typeof resolveSource !== 'function') throw new TypeError('Current-frame and loaded-source resolvers are required.');
        this.root = root; this.getFrame = getFrame; this.resolveSource = resolveSource;
        this.onChange = onChange; this.onError = onError; this.onApplyGsps = onApplyGsps;
        this.store = new OverlayStore({ maxBytes: MAX_OVERLAY_STORE_BYTES });
        this.documents = []; this.applied = new Set(); this.hiddenOpacity = new Map();
        this.revision = 0; this.disposed = false; this.controller = null; this.token = 0; this._busy = false;
        this.unsubscribe = this.store.subscribe(() => this._changed());
        this.lifetime = new AbortController(); this.listLifetime = new AbortController();
        try { this._mount(); } catch (error) { this.dispose(); throw error; }
    }
    _active() { if (this.disposed) throw new Error('Derived-object panel is disposed.'); }
    _changed() { ++this.revision; this._refresh(); notify(this.onChange, this.getState()); }
    _start(signal) {
        this._active(); checkSignal(signal);
        if (signal != null && !(signal instanceof AbortSignal)) throw new TypeError('Derived-object signal must be an AbortSignal.');
        this.controller?.abort(); const controller = new AbortController(), token = ++this.token;
        this.controller = controller; this._busy = true;
        const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
        this._refresh(); notify(this.onChange, this.getState());
        return { signal: controller.signal, check: () => { this._active(); checkSignal(controller.signal); if (token !== this.token) throw abortError(); },
            finish: () => { signal?.removeEventListener('abort', abort); if (this.controller === controller) { this.controller = null; this._busy = false; this._refresh(); notify(this.onChange, this.getState()); } } };
    }
    async _resolve(sopUid, frameNumber, options) {
        const raw = await abortable(() => this.resolveSource(sopUid, frameNumber, options), options?.signal); checkSignal(options?.signal);
        if (!raw) throw new Error('Referenced source frame is not loaded.');
        const frame = raw.frame ?? raw;
        const frameCount = frame.numberOfFrames ?? frame.frameCount ?? raw._record?.frameCount;
        return { ...frame, ...(frameCount == null ? {} : { frameCount }),
            ...(frame.sopClassUid ?? frame.sopClass ?? raw._record?.sopClass ? { sopClassUid: frame.sopClassUid ?? frame.sopClass ?? raw._record.sopClass } : {}) };
    }
    async _checkImages(images, signal) {
        for (const image of images) { checkSignal(signal); const frame = await this._resolve(image.sopUid, image.frameNumber, { signal }); matches(image, frame); }
    }
    async _checkDocuments(documents, signal) {
        for (const document of documents) {
            const images = document.image ? [document.image] : document.measurements.map(value => value.image);
            await this._checkImages(images, signal);
            if (document.image) {
                const frame = await this._resolve(document.image.sopUid, document.image.frameNumber, { signal });
                if (!['MONOCHROME1', 'MONOCHROME2'].includes(frame.photometric) || frame.modalityLut) throw new Error('Presentation state requires its exact compatible monochrome source.');
            }
        }
    }
    async _read(input, signal) {
        checkSignal(signal);
        if (typeof input === 'string') {
            if (input.length > MAX_OVERLAY_STORE_BYTES || new TextEncoder().encode(input).length > MAX_OVERLAY_STORE_BYTES) throw new RangeError('Derived JSON exceeds its byte budget.');
            return JSON.parse(input);
        }
        if (input && Object.getPrototypeOf(input) === Object.prototype) return input;
        if (typeof Blob !== 'undefined' && input instanceof Blob) {
            if (input.size > MAX_DERIVED_BYTES) throw new RangeError('Local derived object exceeds 64 MiB.');
            const prefix = await input.slice(0, 256).text(); checkSignal(signal);
            if (input.type.includes('json') || /\.json$/i.test(input.name ?? '') || prefix.trimStart().startsWith('{')) {
                if (input.size > MAX_OVERLAY_STORE_BYTES) throw new RangeError('Derived JSON exceeds its byte budget.');
                const result = JSON.parse(await input.text()); checkSignal(signal); return result;
            }
        } else if (!(input instanceof Uint8Array) && !(input instanceof ArrayBuffer)) throw new TypeError('Import local DICOM bytes, a file or explicit result JSON.');
        return readDerivedInstance(input, { signal, maxBytes: MAX_DERIVED_BYTES });
    }
    _commitDocuments(documents) {
        const normalized = importDerivedResults(exportDerivedResults(documents, { maxBytes: MAX_RESULT_BYTES })).documents;
        const previous = new Map(this.documents.map(document => [document.sopUid, JSON.stringify(document)]));
        this.applied = new Set([...this.applied].filter(uid => normalized.some(document => document.sopUid === uid && JSON.stringify(document) === previous.get(uid))));
        this.documents = normalized;
        this._changed();
    }
    async import(input, { signal } = {}) {
        const operation = this._start(signal);
        try {
            const parsed = await this._read(input, operation.signal); operation.check();
            if (parsed.schema === DERIVED_RESULT_SCHEMA) {
                byteBudget(parsed, MAX_RESULT_BYTES); const next = importDerivedResults(parsed).documents;
                await this._checkDocuments(next, operation.signal); operation.check();
                this._commitDocuments([...this.documents, ...next]);
            } else if (parsed.schema === OVERLAY_SCHEMA) {
                byteBudget(parsed, MAX_OVERLAY_STORE_BYTES);
                if (!Array.isArray(parsed.overlays) || parsed.overlays.length > 1000) throw new Error('Overlay document count is unsupported.');
                for (const item of parsed.overlays) {
                    const image = normalizeImageReference(item.image), frame = await this._resolve(image.sopUid, image.frameNumber, { signal: operation.signal });
                    matches(image, frame); if (item.geometry) assertGrid(item.geometry, frame);
                }
                operation.check(); this.store.import(parsed);
            } else {
                const sopClass = text(parsed.dataSet, '00080016'), options = { signal: operation.signal, resolveSource: (...args) => this._resolve(...args) };
                if (sopClass === SEGMENTATION_SOP_CLASS) {
                    const available = this.store.maxBytes - this.store.getState().bytes;
                    if (available < 1) throw new RangeError('Overlay mask store is full.');
                    const result = await importSeg(parsed, { ...options, maxBytes: available, consumePixelData: true }); operation.check();
                    this.store.import({ schema: OVERLAY_SCHEMA, version: 1, coordinateSystem: 'image-grid', frameNumberBase: 1, overlays: result.overlays });
                } else {
                    const document = SUPPORTED_SR_CLASSES.includes(sopClass) ? await importSr(parsed, options) : sopClass === GSPS_SOP_CLASS ? await importGsps(parsed, options) : null;
                    if (!document) throw new Error('This local file is outside the supported SEG, SR and GSPS profiles.');
                    await this._checkDocuments([document], operation.signal); operation.check(); this._commitDocuments([...this.documents, document]);
                }
            }
            operation.check(); operation.finish(); return this.getState();
        } finally { operation.finish(); }
    }
    addAiOverlay(input, frame = this.getFrame()) {
        this._active(); if (!frame) throw new Error('Open a source image before adding an AI overlay.');
        if (input?.source != null && input.source !== 'ai') throw new TypeError('AI overlays cannot impersonate SEG imports.');
        const image = createImageReference(frame); if (input.image) matches(input.image, frame);
        const item = this.store.add({ ...input, id: input.id ?? globalThis.crypto?.randomUUID?.() ?? `ai-${this.revision + 1}`, image, source: 'ai' });
        return { id: item.id };
    }
    removeOverlay(id) { this._active(); this.hiddenOpacity.delete(id); return this.store.remove(id); }
    updateStyle(id, style) {
        this._active();
        if (!style || typeof style !== 'object' || Object.keys(style).some(key => !['visible', 'opacity', 'color'].includes(key)) || style.visible != null && typeof style.visible !== 'boolean') throw new TypeError('Overlay style is invalid.');
        const previous = this.store.listDescriptors().find(value => value.id === id); if (!previous) throw new Error('Overlay was not found.');
        let opacity = style.opacity ?? previous.opacity;
        if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new TypeError('Overlay opacity is invalid.');
        if (style.visible === false) { this.hiddenOpacity.set(id, opacity || this.hiddenOpacity.get(id) || 0.5); opacity = 0; }
        if (style.visible === true && !opacity) opacity = this.hiddenOpacity.get(id) || 0.5;
        return this.store.updateStyle(id, { opacity, ...(style.color ? { color: style.color } : {}) });
    }
    exportOverlays() { this._active(); return this.store.export({ maxBytes: MAX_OVERLAY_STORE_BYTES }); }
    exportResults() { this._active(); return JSON.parse(exportDerivedResults(this.documents)); }
    async importResults(input, { signal, mode = 'merge' } = {}) {
        if (!['merge', 'replace'].includes(mode)) throw new TypeError('Derived-result import mode is invalid.');
        const operation = this._start(signal);
        try {
            if (typeof input !== 'string') byteBudget(input, MAX_RESULT_BYTES);
            const documents = importDerivedResults(input).documents; await this._checkDocuments(documents, operation.signal); operation.check();
            this._commitDocuments(mode === 'replace' ? documents : [...this.documents, ...documents]); operation.finish(); return this.getState();
        } finally { operation.finish(); }
    }
    async applyGsps(index) {
        this._active(); const document = this.documents[index], frame = this.getFrame();
        if (!document?.image || typeof this.onApplyGsps !== 'function' || !frame) throw new Error('An applicable presentation state and source image are required.');
        matches(document.image, frame);
        if (!['MONOCHROME1', 'MONOCHROME2'].includes(frame.photometric) || frame.modalityLut) throw new Error('Presentation state requires its exact compatible monochrome source.');
        const revision = this.revision; await this.onApplyGsps(structuredClone(document), frame); this._active();
        if (revision !== this.revision || !this.documents.includes(document)) throw abortError();
        this.applied.add(document.sopUid); this._changed(); return this.getState();
    }
    drawGraphics(frame, layer, viewport, { presentationSopUid } = {}) {
        this._active(); if (!layer?.ownerDocument?.createElementNS || !viewport?.imageToScreen) throw new TypeError('An SVG layer and image transform are required.');
        let group = layer.querySelector?.('[data-derived-graphics]'); if (!group) { group = layer.ownerDocument.createElementNS(SVG, 'g'); group.setAttribute('data-derived-graphics', ''); layer.append(group); }
        group.replaceChildren(); if (!frame) return 0; let count = 0;
        const draw = (image, graphic, color) => {
            try { matches(image, frame); } catch { return; }
            const points = graphic.points.map(point => viewport.imageToScreen(point.x, point.y));
            if (points.some(point => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))) throw new Error('Derived graphic transform is invalid.');
            let element;
            if (graphic.type === 'ELLIPSE') {
                // Image-space ellipse plus the complete affine matrix preserves rotation/flips.
                const [a, b] = graphic.controlPoints, origin = viewport.imageToScreen(0, 0), x = viewport.imageToScreen(1, 0), y = viewport.imageToScreen(0, 1);
                element = layer.ownerDocument.createElementNS(SVG, 'ellipse'); element.setAttribute('cx', String((a.x + b.x) / 2)); element.setAttribute('cy', String((a.y + b.y) / 2));
                element.setAttribute('rx', String((b.x - a.x) / 2)); element.setAttribute('ry', String((b.y - a.y) / 2));
                element.setAttribute('transform', `matrix(${x.x-origin.x} ${x.y-origin.y} ${y.x-origin.x} ${y.y-origin.y} ${origin.x} ${origin.y})`);
            } else {
                element = layer.ownerDocument.createElementNS(SVG, graphic.closed ? 'polygon' : 'polyline');
                element.setAttribute('points', points.map(point => `${point.x},${point.y}`).join(' '));
            }
            element.setAttribute('fill', 'none'); element.setAttribute('stroke', color); element.setAttribute('stroke-width', '1.5'); element.setAttribute('vector-effect', 'non-scaling-stroke');
            element.setAttribute('pointer-events', 'none'); group.append(element); ++count;
        };
        for (const document of this.documents) {
            if (document.measurements) for (const item of document.measurements) draw(item.image, item.graphic, '#f2bf66');
            else if (this.applied.has(document.sopUid) && (presentationSopUid === undefined || presentationSopUid === document.sopUid)) for (const graphic of [...document.graphics].sort((a, b) => document.layers.find(layer => layer.name === a.layer).order - document.layers.find(layer => layer.name === b.layer).order)) {
                const level = Math.round(document.layers.find(layer => layer.name === graphic.layer).grayValue / 65535 * 255); draw(document.image, graphic, `rgb(${level},${level},${level})`);
            }
        }
        return count;
    }
    getState() {
        const store = this.disposed ? { count: 0, bytes: 0 } : this.store.getState();
        return { disposed: this.disposed, busy: this._busy, revision: this.revision, overlayCount: store.count, overlayBytes: store.bytes,
            documentCount: this.documents.length, srCount: this.documents.filter(value => value.measurements).length, gspsCount: this.documents.filter(value => value.image).length,
            reportedMeasurementCount: this.documents.reduce((sum, value) => sum + (value.measurements?.length ?? 0), 0),
            graphicCount: this.documents.reduce((sum, value) => sum + (value.measurements?.length ?? value.graphics?.length ?? 0), 0), appliedPresentationCount: this.applied.size };
    }
    clear() {
        this._active(); ++this.token; this.controller?.abort(); this.controller = null; this._busy = false;
        this.documents = []; this.applied.clear(); this.hiddenOpacity.clear();
        this.store.import({ schema: OVERLAY_SCHEMA, version: 1, coordinateSystem: 'image-grid', frameNumberBase: 1, overlays: [] }, { mode: 'replace' });
    }
    _mount() {
        if (this.root == null) return;
        const document = this.root.ownerDocument;
        if (!document?.createElement || !this.root.querySelector) throw new TypeError('A viewer DOM root is required.');
        const element = (tag, className, label, id) => { const node = document.createElement(tag); if (className) node.className = className; if (label) node.textContent = label; if (id) node.id = id; return node; };
        this.section = element('section', 'inspector-section derived-section', null, 'derived-section');
        this.section.append(element('div', 'section-caption', 'DERIVED OBJECTS'));
        this.section.append(element('p', 'derived-note', 'Import local SEG masks, reported SR measurements, GSPS or overlay JSON. Source images must already be loaded.'));
        const actions = element('div', 'derived-actions');
        const button = (label, id, callback) => { const node = element('button', null, label, id); node.type = 'button'; node.addEventListener('click', () => Promise.resolve().then(callback).catch(error => this._error(error)), { signal: this.lifetime.signal }); return node; };
        this.input = element('input', null, null, 'derived-input'); this.input.type = 'file'; this.input.hidden = true;
        this.input.addEventListener('change', () => { const file = this.input.files?.[0]; this.input.value = ''; if (file) this.import(file).catch(error => this._error(error)); }, { signal: this.lifetime.signal });
        actions.append(button('Import derived object', 'derived-import', () => this.input.click()), button('Clear', 'derived-clear', () => this.clear()));
        this.message = element('p', 'derived-message', 'No derived objects imported.', 'derived-message'); this.message.setAttribute('role', 'status');
        this.error = element('p', 'derived-error', null, 'derived-error'); this.error.setAttribute('role', 'alert'); this.error.hidden = true;
        this.overlays = element('div', 'derived-overlay-list', null, 'derived-overlay-list'); this.results = element('div', 'derived-document-list', null, 'derived-document-list');
        const exports = element('div', 'derived-actions');
        this.exportMasks = button('Export overlay JSON', 'derived-export-overlays', () => this._download(this.exportOverlays(), 'easi-view-overlays.json'));
        this.exportDocuments = button('Export result JSON', 'derived-export-results', () => this._download(this.exportResults(), 'easi-view-derived-results.json'));
        exports.append(this.exportMasks, this.exportDocuments); this.section.append(actions, this.input, this.message, this.error, this.overlays, this.results, exports);
        (this.root.querySelector('#inspector-panel-objects') ?? this.root.querySelector('.inspector-scroll') ?? this.root).append(this.section); this._refresh();
    }
    _error(error) { if (error?.name === 'AbortError') return; if (this.error) { this.error.textContent = error.message || 'Unable to import this derived object.'; this.error.hidden = false; } notify(this.onError, error); }
    _download(value, filename) {
        const document = this.root.ownerDocument, url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: 'application/json' }));
        try { const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); } finally { setTimeout(() => URL.revokeObjectURL(url), 0); }
    }
    _refresh() {
        if (!this.section || this.disposed) return; this.listLifetime.abort(); this.listLifetime = new AbortController(); const document = this.section.ownerDocument, state = this.getState();
        this.message.textContent = this._busy ? 'Importing local derived object…' : `${state.overlayCount} masks · ${state.reportedMeasurementCount} reported measurements · ${state.gspsCount} presentation states`;
        this.exportMasks.disabled = !state.overlayCount; this.exportDocuments.disabled = !state.documentCount;
        this.overlays.replaceChildren(); this.results.replaceChildren();
        for (const item of this.store.listDescriptors()) {
            const row = document.createElement('div'); row.className = 'derived-overlay-row';
            const title = document.createElement('label'), visible = document.createElement('input'); visible.type = 'checkbox'; visible.checked = item.opacity > 0;
            visible.addEventListener('change', () => { try { this.updateStyle(item.id, { visible: visible.checked }); } catch (error) { this._error(error); } }, { signal: this.listLifetime.signal });
            title.append(visible, document.createTextNode(item.segment?.label ?? (item.kind === 'probability' ? 'AI probability map' : 'AI mask')));
            const opacity = document.createElement('input'); opacity.type = 'range'; opacity.min = '0'; opacity.max = '1'; opacity.step = '.05'; opacity.value = String(item.opacity); opacity.setAttribute('aria-label', 'Overlay opacity');
            opacity.addEventListener('change', () => { try { this.updateStyle(item.id, { opacity: Number(opacity.value) }); } catch (error) { this._error(error); } }, { signal: this.listLifetime.signal });
            const tint = document.createElement('input'); tint.type = 'color'; tint.value = '#' + item.color.map(value => value.toString(16).padStart(2, '0')).join(''); tint.setAttribute('aria-label', 'Overlay tint');
            tint.addEventListener('change', () => { try { this.updateStyle(item.id, { color: [1, 3, 5].map(index => parseInt(tint.value.slice(index, index + 2), 16)) }); } catch (error) { this._error(error); } }, { signal: this.listLifetime.signal });
            const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove'; remove.addEventListener('click', () => this.removeOverlay(item.id), { signal: this.listLifetime.signal });
            row.append(title, opacity, tint, remove); this.overlays.append(row);
        }
        this.documents.forEach((item, index) => {
            const row = document.createElement('div'); row.className = 'derived-document-row';
            const title = document.createElement('strong'); title.textContent = item.measurements ? 'Reported SR measurements' : 'Imported GSPS'; row.append(title);
            if (item.measurements) for (const measurement of item.measurements) {
                const value = document.createElement('p'); value.textContent = `Reported: ${measurement.value} ${measurement.unit.value} · ${measurement.concept.meaning}`; row.append(value);
            } else {
                const apply = document.createElement('button'); apply.type = 'button'; apply.textContent = 'Apply presentation'; apply.dataset.gspsIndex = String(index);
                apply.addEventListener('click', () => this.applyGsps(index).catch(error => this._error(error)), { signal: this.listLifetime.signal }); row.append(apply);
            }
            this.results.append(row);
        });
    }
    dispose() {
        if (this.disposed) return; ++this.token; this.controller?.abort(); this.controller = null; this._busy = false;
        this.lifetime.abort(); this.listLifetime.abort(); this.unsubscribe(); this.store.dispose(); this.documents = []; this.applied.clear(); this.hiddenOpacity.clear();
        this.section?.remove(); this.disposed = true;
    }
}
