import { createImageReference, normalizeAnnotation, assertAnnotationFrame } from '../annotations/model.js';
import { ANNOTATION_TOOLS, MAX_POLYGON_POINTS, measureGeometry } from '../annotations/geometry.js';

const SVG = 'http://www.w3.org/2000/svg';
const HANDLE_RADIUS = 8;
const EDGE_RADIUS = 6;
const EPSILON = 1e-9;
const toolName = tool => tool === 'distance' ? 'length' : tool;
const ownTool = tool => tool === 'select' || ANNOTATION_TOOLS.includes(tool);
const samePoint = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < EPSILON;
const sameImage = (a, b) => a.sopUid === b.sopUid && a.frameNumber === b.frameNumber &&
    a.rows === b.rows && a.columns === b.columns &&
    ['seriesUid', 'frameOfReferenceUid', 'geometryFingerprint'].every(key => a[key] === b[key]);

function observe(callback, value) {
    try {
        const result = callback?.(value);
        if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
    } catch { /* Host observers cannot turn a valid gesture into a failed edit. */ }
}

function segmentDistance(point, first, second) {
    const dx = second.x - first.x, dy = second.y - first.y;
    const square = dx * dx + dy * dy;
    const fraction = square ? Math.max(0, Math.min(1, ((point.x - first.x) * dx + (point.y - first.y) * dy) / square)) : 0;
    return Math.hypot(point.x - first.x - fraction * dx, point.y - first.y - fraction * dy);
}

function outline(tool, points) {
    if (points.length < 2 || !['rectangle', 'ellipse'].includes(tool)) return points;
    const [a, b] = points;
    if (tool === 'rectangle') return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2;
    return Array.from({ length: 64 }, (_, index) => {
        const angle = index * 2 * Math.PI / 64;
        return { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry };
    });
}

function contains(annotation, point) {
    const points = annotation.points;
    if (annotation.tool === 'rectangle' || annotation.tool === 'ellipse') {
        const [a, b] = points, left = Math.min(a.x, b.x), top = Math.min(a.y, b.y);
        const width = Math.abs(b.x - a.x), height = Math.abs(b.y - a.y);
        if (annotation.tool === 'rectangle') return point.x >= left && point.x <= left + width && point.y >= top && point.y <= top + height;
        return ((point.x - left - width / 2) / (width / 2)) ** 2 + ((point.y - top - height / 2) / (height / 2)) ** 2 <= 1;
    }
    if (annotation.tool !== 'polygon') return false;
    let inside = false;
    for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
        const a = points[index], b = points[previous];
        if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
}

/** Pointer interaction over a host-owned viewport, SVG layer and durable store. */
export class AnnotationController {
    constructor({ canvas, layer, viewport, getFrame, getTool, store, onChange, onError }) {
        if (!canvas?.addEventListener || !canvas.ownerDocument?.createElementNS || !layer?.append ||
            !viewport?.screenToImage || !viewport?.imageToScreen || typeof getFrame !== 'function' || typeof getTool !== 'function' ||
            !store?.subscribe || !store?.list || !store?.get || !store?.getState || !store?.add || !store?.update || !store?.remove ||
            onChange != null && typeof onChange !== 'function' || onError != null && typeof onError !== 'function') {
            throw new TypeError('AnnotationController requires a canvas, SVG layer, viewport, frame/tool callbacks and annotation store.');
        }
        this.canvas = canvas; this.layer = layer; this.viewport = viewport; this.store = store;
        this._getFrame = getFrame; this._getTool = getTool; this._onChange = onChange; this._onError = onError;
        this._selectedId = null; this._draft = null; this._pointer = null; this._group = null; this._disposed = false; this._committing = false;
        this._geometryCache = new Map(); this._geometryFrame = null;
        this._lifetime = new AbortController();
        const handlers = {
            pointerdown: event => this._down(event), pointermove: event => this._move(event), pointerup: event => this._up(event),
            pointercancel: event => this._cancelPointer(event), lostpointercapture: event => this._cancelPointer(event),
            dblclick: event => this._doubleClick(event), keydown: event => this._key(event)
        };
        for (const [name, handler] of Object.entries(handlers)) canvas.addEventListener(name, handler, { capture: true, signal: this._lifetime.signal });
        this._unsubscribe = store.subscribe(() => {
            this._geometryCache.clear();
            if (this._disposed || this._committing) return;
            if (this._selectedId && !store.get(this._selectedId)) this._selectedId = null;
            // Undo/import/removal during a gesture must not overwrite a newer model.
            if (this._draft?.original) this._resetGesture();
            this.render(); this._notify();
        });
        this.render();
    }

    _error(error) { observe(this._onError, error); }
    _notify() { if (!this._disposed) observe(this._onChange, { count: this.store.getState().count, selectedId: this._selectedId }); }
    _intercept(event) { event.preventDefault(); event.stopImmediatePropagation(); }
    _tool() { return toolName(this._getTool()); }
    _context(report = false) {
        const frame = this._getFrame();
        if (!frame) return null;
        try { return { frame, image: createImageReference(frame) }; }
        catch (error) { if (report) this._error(error); return null; }
    }
    _point(event, image) {
        const point = this.viewport.screenToImage(event.clientX, event.clientY);
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
        return { x: Math.max(0, Math.min(image.columns, point.x)), y: Math.max(0, Math.min(image.rows, point.y)) };
    }
    _screen(point) { return this.viewport.imageToScreen(point.x, point.y); }
    _current(context = this._context()) {
        if (!context) return [];
        return this.store.list(context.image).filter(annotation => {
            try { assertAnnotationFrame(annotation, context.frame); return true; } catch { return false; }
        });
    }
    _capture(event) {
        this.canvas.focus?.({ preventScroll: true });
        try { this.canvas.setPointerCapture?.(event.pointerId); } catch { /* A canceled browser pointer may already be gone. */ }
    }
    _release() {
        const pointer = this._pointer;
        this._pointer = null;
        if (pointer) {
            try { if (this.canvas.hasPointerCapture?.(pointer.id)) this.canvas.releasePointerCapture(pointer.id); } catch { /* Already released. */ }
        }
    }
    _resetGesture() { this._release(); this._draft = null; }
    _validGesture(context = this._context()) {
        if (!this._draft) return true;
        if (!context || !sameImage(this._draft.image, context.image) || this._tool() !== (this._draft.original ? 'select' : this._draft.tool)) {
            this._resetGesture(); return false;
        }
        return true;
    }

    _hit(event, point, annotations) {
        const rectangle = this.canvas.getBoundingClientRect();
        const screenPoint = { x: event.clientX - rectangle.left, y: event.clientY - rectangle.top };
        const selected = annotations.find(annotation => annotation.id === this._selectedId);
        if (selected) {
            for (let index = 0; index < selected.points.length; index++) {
                const screen = this._screen(selected.points[index]);
                if (screen && Math.hypot(screen.x - screenPoint.x, screen.y - screenPoint.y) <= HANDLE_RADIUS) return { annotation: selected, handle: index };
            }
        }
        for (let index = annotations.length - 1; index >= 0; index--) {
            const annotation = annotations[index], shape = outline(annotation.tool, annotation.points);
            const screens = shape.map(value => this._screen(value));
            if (screens.some(value => !value)) continue;
            const closed = ['rectangle', 'ellipse', 'polygon'].includes(annotation.tool);
            const edges = closed ? screens.length : screens.length - 1;
            for (let edge = 0; edge < edges; edge++) {
                if (segmentDistance(screenPoint, screens[edge], screens[(edge + 1) % screens.length]) <= EDGE_RADIUS) return { annotation, handle: null };
            }
            if (contains(annotation, point)) return { annotation, handle: null };
        }
        return null;
    }

    _down(event) {
        if (this._disposed || event.button !== 0 || event.isPrimary === false) return;
        const tool = this._tool();
        if (!ownTool(tool)) return;
        this._intercept(event);
        if (this._pointer) return;
        const context = this._context(true);
        if (!context) return;
        this._validGesture(context);
        const point = this._point(event, context.image);
        if (!point) return;
        if (tool === 'select') {
            const hit = this._hit(event, point, this._current(context));
            this._selectedId = hit?.annotation.id ?? null;
            if (hit) {
                this._draft = { tool: hit.annotation.tool, image: context.image, points: hit.annotation.points,
                    original: hit.annotation, handle: hit.handle, start: point };
            }
            this._notify();
        } else {
            if (!this._draft) this._draft = { tool, image: context.image, points: [] };
            if (['length', 'rectangle', 'ellipse'].includes(tool)) this._draft.points = [point, point];
            this._draft.hover = point;
        }
        this._pointer = { id: event.pointerId, start: point, image: context.image };
        this._capture(event); this.render();
    }

    _move(event) {
        if (this._disposed || !this._draft || event.isPrimary === false || this._pointer && event.pointerId !== this._pointer.id ||
            !this._pointer && (event.buttons ?? 0) !== 0) return;
        this._intercept(event);
        const context = this._context();
        if (!this._validGesture(context)) { this.render(); return; }
        const point = this._point(event, context.image);
        if (!point) return;
        if (this._draft.original) {
            const { original, handle, start } = this._draft;
            this._draft.points = original.points.map((previous, index) => handle == null ?
                { x: previous.x + point.x - start.x, y: previous.y + point.y - start.y } : index === handle ? point : previous);
        } else if (['length', 'rectangle', 'ellipse'].includes(this._draft.tool)) this._draft.points[1] = point;
        else this._draft.hover = point;
        this.render();
    }

    _commit() {
        const draft = this._draft, context = this._context();
        if (!draft || !this._validGesture(context)) { this.render(); return false; }
        // Release first: synchronous store subscriptions and lostcapture cannot
        // mistake a completed gesture for an unfinished one.
        this._resetGesture();
        this._committing = true;
        this._geometryCache.clear();
        try {
            let annotation;
            if (draft.original) {
                const current = this.store.get(draft.original.id);
                if (!current || JSON.stringify(current) !== JSON.stringify(draft.original)) throw new Error('The selected annotation changed during this gesture.');
                const next = normalizeAnnotation({ ...draft.original, points: draft.points });
                const changed = next.points.some((point, index) => !samePoint(point, current.points[index]));
                annotation = changed ? this.store.update(next.id, { points: next.points }) : current;
            } else annotation = this.store.add({ tool: draft.tool, image: draft.image, points: draft.points });
            this._committing = false;
            this._selectedId = annotation.id;
            this.render(); this._notify(); return true;
        } catch (error) { this._error(error); this.render(); return false; }
        finally { this._committing = false; }
    }

    _up(event) {
        if (this._disposed || !this._pointer || event.pointerId !== this._pointer.id) return;
        this._intercept(event);
        const context = this._context();
        if (!this._validGesture(context)) { this.render(); return; }
        const draft = this._draft;
        if (!draft) { this._release(); return; }
        const point = this._point(event, context.image);
        if (!point) { this.cancelDraft(); return; }
        if (draft.original || ['length', 'rectangle', 'ellipse'].includes(draft.tool)) {
            this._move(event); this._commit(); return;
        }
        this._release();
        if (draft.tool === 'polygon' && draft.points.length >= 3 && samePoint(point, draft.points[0])) { this._commit(); return; }
        if (!draft.points.length || !samePoint(point, draft.points[draft.points.length - 1])) {
            if (draft.points.length >= MAX_POLYGON_POINTS) { this._error(new RangeError('The polygon point limit has been reached.')); this.render(); return; }
            draft.points.push(point);
        }
        draft.hover = point;
        if (draft.tool === 'angle' && draft.points.length === 3) this._commit();
        else this.render();
    }

    _cancelPointer(event) {
        if (this._disposed || !this._pointer || event.pointerId !== this._pointer.id) return;
        this._intercept(event); this.cancelDraft();
    }
    _doubleClick(event) {
        if (this._disposed || !ownTool(this._tool())) return;
        this._intercept(event);
        if (this._draft?.tool === 'polygon') this._commit();
    }
    _key(event) {
        if (this._disposed) return;
        if (event.key === 'Escape' && this._draft) { this._intercept(event); this.cancelDraft(); }
        else if (event.key === 'Enter' && this._draft?.tool === 'polygon') { this._intercept(event); this._commit(); }
    }

    _node(name, attributes, text) {
        const node = this.canvas.ownerDocument.createElementNS(SVG, name);
        for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
        if (text != null) node.textContent = text;
        this._group.append(node);
        return node;
    }
    _draw(annotation, frame, { draft = false, selected = false } = {}) {
        const screens = outline(annotation.tool, annotation.points).map(point => this._screen(point));
        if (!screens.length || screens.some(point => !point)) return;
        const closed = ['rectangle', 'ellipse', 'polygon'].includes(annotation.tool);
        this._node(closed && annotation.points.length >= 2 ? 'polygon' : 'polyline', {
            points: screens.map(point => `${point.x},${point.y}`).join(' '), fill: 'none',
            class: `measurement-line${selected ? ' annotation-selected' : ''}${draft ? ' annotation-draft' : ''}`,
            ...(draft ? { 'stroke-dasharray': '5 4', opacity: 0.8 } : {})
        });
        let geometry;
        try {
            if (!draft && this._geometryCache.has(annotation.id)) geometry = this._geometryCache.get(annotation.id);
            else {
                geometry = measureGeometry(annotation.tool, annotation.points, frame);
                if (!draft) this._geometryCache.set(annotation.id, geometry);
            }
        } catch { /* Incomplete/invalid drafts still have an outline. */ }
        if (geometry) {
            const unit = geometry.unit === 'deg' ? '°' : geometry.unit === 'mm2' ? 'mm²' : geometry.unit === 'px2' ? 'px²' : geometry.unit;
            const label = `${geometry.value.toFixed(2)}${unit === '°' ? '' : ' '}${unit}${geometry.calibrated || unit === '°' ? '' : ' · uncalibrated'}`;
            const bounds = this.canvas.getBoundingClientRect();
            const width = Math.min(Math.max(1, bounds.width - 12), 280, Math.max(90, label.length * 6.8 + 20));
            const center = screens.reduce((sum, point) => ({ x: sum.x + point.x / screens.length, y: sum.y + point.y / screens.length }), { x: 0, y: 0 });
            const x = Math.max(width / 2 + 6, Math.min(bounds.width - width / 2 - 6, center.x));
            const y = Math.max(20, Math.min(bounds.height - 15, center.y - 15));
            this._node('rect', { x: x - width / 2, y: y - 16, width, height: 25, rx: 5, class: 'measurement-label-bg' });
            this._node('text', { x, y, class: 'measurement-label', 'text-anchor': 'middle' }, label);
        }
        if (selected || draft) for (const point of annotation.points) {
            const screen = this._screen(point);
            if (screen) this._node('circle', { cx: screen.x, cy: screen.y, r: selected ? 5 : 3.5,
                class: selected ? 'measurement-endpoint annotation-handle' : 'measurement-endpoint' });
        }
    }

    /** Host calls this after clearing/redrawing its shared SVG overlay. */
    render() {
        if (this._disposed) return;
        if (this._group?.parentNode !== this.layer) {
            this._group = this.canvas.ownerDocument.createElementNS(SVG, 'g');
            this._group.setAttribute('class', 'persistent-annotations');
            this._group.setAttribute('pointer-events', 'none');
            this.layer.append(this._group);
        }
        this._group.replaceChildren();
        const context = this._context();
        if (context?.frame !== this._geometryFrame) {
            this._geometryFrame = context?.frame ?? null; this._geometryCache.clear();
        }
        this._validGesture(context);
        const annotations = this._current(context);
        if (this._selectedId && !annotations.some(annotation => annotation.id === this._selectedId)) {
            this._selectedId = null; this._notify();
        }
        if (!context) return;
        for (const annotation of annotations) {
            if (this._draft?.original?.id === annotation.id) continue;
            this._draw(annotation, context.frame, { selected: annotation.id === this._selectedId });
        }
        if (this._draft) {
            let points = this._draft.points;
            if (!this._draft.original && ['angle', 'polygon'].includes(this._draft.tool) && this._draft.hover &&
                (!points.length || !samePoint(points[points.length - 1], this._draft.hover))) points = [...points, this._draft.hover];
            this._draw({ tool: this._draft.tool, points }, context.frame, { draft: true, selected: !!this._draft.original });
        }
    }
    cancelDraft() {
        if (this._disposed) return;
        this._resetGesture(); this.render();
    }
    getSelected() {
        if (this._disposed) return null;
        const context = this._context();
        return this._current(context).find(annotation => annotation.id === this._selectedId) ?? null;
    }
    select(id) {
        if (this._disposed) throw new Error('This annotation controller has been disposed.');
        const selected = id == null ? null : this._current().find(annotation => annotation.id === id);
        if (id != null && !selected) throw new RangeError('Select an annotation belonging to the displayed image and original frame.');
        this._resetGesture(); this._selectedId = selected?.id ?? null; this.render(); this._notify();
        return this.getSelected();
    }
    deleteSelected() {
        if (this._disposed) return false;
        const selected = this.getSelected();
        if (!selected) return false;
        this._resetGesture(); this._selectedId = null;
        this.store.remove(selected.id); return true;
    }
    dispose() {
        if (this._disposed) return;
        this._disposed = true; this._lifetime.abort(); this._unsubscribe?.();
        this._resetGesture(); this._group?.remove(); this._group = null; this._selectedId = null;
        this._getFrame = null; this._getTool = null; this._onChange = null; this._onError = null;
        this.canvas = null; this.layer = null; this.viewport = null; this.store = null;
        this._geometryCache.clear(); this._geometryFrame = null;
    }
}
