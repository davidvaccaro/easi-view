import { Volume, validateVolumeGeometry, reslice, raycast, createFusion, renderFusion, validateRigidRegistration, MAX_VOLUME_BYTES } from '../volume/index.js';
import { checkSignal, reconstructionError } from '../volume/geometry.js';
import { MAX_RECONSTRUCTION_SAMPLES } from '../volume/reslice.js';
import { createPatientPlane, raySamplingPlan, derivedWindow, derivedToRgba, displayTransfer, probeDerived, derivedCanvasPoint, MAX_WORKSPACE_DERIVED_BYTES } from '../render/ReconstructionMath.js';

function observe(callback, value) { try { Promise.resolve(callback?.(value)).catch(() => {}); } catch {} }
function plain(value, keys) {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
        Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) throw new TypeError('Use supported reconstruction options.');
}
function signal(value) { if (value != null && !(value instanceof AbortSignal)) throw new TypeError('Use an AbortSignal for reconstruction.'); }
const canceled = () => new DOMException('Reconstruction was canceled.', 'AbortError');
const DEFAULTS = Object.freeze({ maximumSize: 192, axialPosition: 0.5, coronalPosition: 0.5, sagittalPosition: 0.5, obliquePosition: 0.5,
    yawDeg: 0, pitchDeg: 0, projection: 'slice', thicknessMm: 0, fourth: 'oblique', rayMode: 'composite', opacity: 0.12, color: 'grayscale', invert: false, fusionAlpha: 0.5, fusionMode: 'alpha' });
const CONFIG_KEYS = [...Object.keys(DEFAULTS), 'window', 'overlayWindow'];
function configuration(current, patch) {
    plain(patch, CONFIG_KEYS); const next = { ...current, ...patch };
    if (!Number.isInteger(next.maximumSize) || next.maximumSize < 2 || next.maximumSize > 256 ||
        ['axialPosition', 'coronalPosition', 'sagittalPosition', 'obliquePosition'].some(key => !Number.isFinite(next[key]) || next[key] < 0 || next[key] > 1) ||
        !Number.isFinite(next.yawDeg) || Math.abs(next.yawDeg) > 180 || !Number.isFinite(next.pitchDeg) || Math.abs(next.pitchDeg) > 90 ||
        !['slice', 'mip', 'minip', 'mean'].includes(next.projection) || !Number.isFinite(next.thicknessMm) || next.thicknessMm < 0 || next.thicknessMm > 10000 ||
        !['oblique', '3d', 'fusion'].includes(next.fourth) || !['composite', 'mip', 'minip', 'mean'].includes(next.rayMode) ||
        !['grayscale', 'warm'].includes(next.color) || typeof next.invert !== 'boolean' || !Number.isFinite(next.opacity) || next.opacity < 0 || next.opacity > 1 ||
        next.fusionAlpha != null && (!Number.isFinite(next.fusionAlpha) || next.fusionAlpha < 0 || next.fusionAlpha > 1) ||
        next.fusionMode != null && !['alpha', 'checkerboard'].includes(next.fusionMode)) throw reconstructionError('view settings exceed their supported bounds');
    if (next.window) next.window = derivedWindow(next.window);
    if (next.overlayWindow) next.overlayWindow = derivedWindow(next.overlayWindow);
    return next;
}

/** Owned, explicit reconstruction UI. Source acquisition stays with the host's shared frame broker. */
export class ReconstructionWorkspace {
    #base = null; #overlay = null; #outputs = []; #options = null; #desiredOptions = null; #registration = null;
    #queue = Promise.resolve(); #running = null; #operationId = 0; #reservation = null; #disposed = false;
    #budget = MAX_VOLUME_BYTES; #seriesIndex = null; #overlayIndex = null; #presentationInvert = false; #overlayInvert = false;
    #progress = null; #error = false; #focus = null; #controls = {}; #panels = []; #reported = new WeakSet(); #inert = new Map(); #customResolution = null;

    constructor(root, { getSeries, getFrame, getSeriesCount, onChange, onError } = {}) {
        if (!root?.ownerDocument || typeof getSeries !== 'function' || typeof getFrame !== 'function' || typeof getSeriesCount !== 'function' ||
            onChange != null && typeof onChange !== 'function' || onError != null && typeof onError !== 'function') throw new TypeError('Configure a reconstruction root and shared source/frame callbacks.');
        this.root = root; this.getSeries = getSeries; this.getFrame = getFrame; this.getSeriesCount = getSeriesCount; this.onChange = onChange; this.onError = onError;
        this.element = this.#build(); root.append(this.element);
    }
    #ensure() { if (this.#disposed) throw new Error('This reconstruction workspace has been disposed.'); }
    #selected(index) {
        const count = this.getSeriesCount();
        if (!Number.isSafeInteger(count) || count < 0 || count > 10000 || !Number.isInteger(index) || index < 0 || index >= count) throw reconstructionError('select an available series');
        let selected; try { selected = this.getSeries(index); } catch { throw reconstructionError('the selected source is unavailable'); }
        if (!selected || !Array.isArray(selected.frames)) throw reconstructionError('the selected series has no frame descriptors');
        return selected;
    }
    #volumeBytes() { return (this.#base?.bytes ?? 0) + (this.#overlay?.bytes ?? 0); }
    #outputBytes() { return this.#outputs.reduce((sum, image) => sum + image.bytes, 0); }
    #canvasBytes() { return this.#panels.reduce((sum, panel) => sum + panel.canvas.width * panel.canvas.height * 4, 0); }
    getState() {
        const geometry = this.#base?.geometry;
        return { open: !this.element.hidden && !this.#disposed, ready: Boolean(this.#base) && !this.#disposed, busy: Boolean(this.#running) && !this.element.hidden && !this.#disposed,
            disposed: this.#disposed, error: this.#error, dimensions: geometry ? [geometry.columns, geometry.rows, geometry.depth] : null,
            volumeCount: Number(Boolean(this.#base)) + Number(Boolean(this.#overlay)), volumeBytes: this.#volumeBytes() + (this.#reservation?.volumeBytes ?? 0),
            pendingVolumeBytes: this.#reservation?.volumeBytes ?? 0, volumeBudget: this.#budget,
            derivedBytes: this.#outputBytes() + this.#canvasBytes() + (this.#reservation?.derivedBytes ?? 0),
            retainedDerivedBytes: this.#outputBytes(), pendingDerivedBytes: this.#reservation?.derivedBytes ?? 0, canvasBytes: this.#canvasBytes(), derivedBudget: MAX_WORKSPACE_DERIVED_BYTES,
            viewCount: this.#outputs.length, fourth: this.#options?.fourth ?? null, projection: this.#options?.projection ?? null,
            maximumSize: this.#options?.maximumSize ?? null, progress: this.#progress ? { ...this.#progress } : null };
    }
    #notify() {
        const state = this.getState(); this.#controls.status.textContent = state.busy ? this.#progress ? `Loading ${this.#progress.completed} of ${this.#progress.total} frames…` : 'Computing derived views…' : state.ready ? 'Derived views · original images unchanged' : 'Choose a spatial series to reconstruct';
        this.element.setAttribute('aria-busy', String(state.busy));
        for (const control of this.#controls.editable) control.disabled = !state.ready || state.busy;
        observe(this.onChange, state);
    }
    #report(error) {
        if (error?.name === 'AbortError' || error && typeof error === 'object' && this.#reported.has(error)) return;
        if (error && typeof error === 'object') this.#reported.add(error);
        this.#error = true; this.#controls.error.textContent = error?.message ?? 'Reconstruction could not complete.'; this.#controls.error.hidden = false; observe(this.onError, error);
    }
    #enqueue(callback, externalSignal) {
        signal(externalSignal); checkSignal(externalSignal); const id = ++this.#operationId; this.#running?.abort();
        const controller = new AbortController(), combined = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
        this.#running = controller; this.#error = false; this.#controls.error.hidden = true; this.#notify();
        const assert = () => { checkSignal(combined); if (id !== this.#operationId || this.#disposed || this.element.hidden) throw canceled(); };
        const pending = this.#queue.catch(() => {}).then(async () => {
            const reservation = { volumeBytes: 0, derivedBytes: 0 }; this.#reservation = reservation;
            try { assert(); const result = await callback({ signal: combined, assert, reservation }); assert(); return result; }
            catch (error) { if (id === this.#operationId && !this.#disposed && !this.element.hidden) { this.#desiredOptions = this.#options; this.#syncControls(); this.#report(error); } throw error; }
            finally { if (this.#reservation === reservation) this.#reservation = null; if (id === this.#operationId) { this.#running = null; this.#progress = null; this.#notify(); } }
        });
        this.#queue = pending.catch(() => {}); return pending.then(() => this.getState());
    }
    async #load(series, maxBytes, current) {
        const plan = validateVolumeGeometry(series.frames, { maxBytes }); current.reservation.volumeBytes = plan.bytes; this.#notify(); current.assert();
        let window = null, presentationInvert = false, presentationSeen = false;
        const volume = await Volume.fromSeries(series, { signal: current.signal, maxBytes,
            getFrame: async (index, options) => {
                let frame;
                try { frame = await this.getFrame(series, index, options); } catch (error) { if (error?.name === 'AbortError') throw error; throw reconstructionError('source frame retrieval failed'); }
                current.assert(); if (!presentationSeen) { presentationInvert = frame.presentationInvert ?? frame.photometric === 'MONOCHROME1'; presentationSeen = true; }
                if (!window && frame.window) window = derivedWindow(frame.window, frame.voiFunction);
                return frame;
            },
            onProgress: event => { if (current.signal.aborted) return; this.#progress = { completed: event.completed, total: event.total }; this.#notify(); } });
        try { current.assert(); return { volume, window, presentationInvert }; } catch (error) { volume.dispose(); throw error; }
    }
    #plan(base, selected) {
        const planes = ['axial', 'coronal', 'sagittal', 'oblique'].map(view => createPatientPlane(base.geometry, {
            view, position: selected[`${view}Position`], yawDeg: selected.yawDeg, pitchDeg: selected.pitchDeg, maximumSize: selected.maximumSize }));
        const outputBytes = planes.reduce((sum, plane, index) => sum + plane.rows * plane.columns * (index === 3 && selected.fourth === 'fusion' ? 22 : index === 3 && selected.fourth === '3d' ? 4 : 13), 0);
        const newCanvasBytes = planes.reduce((sum, plane) => sum + plane.rows * plane.columns * 4, 0);
        const scratch = Math.max(...planes.map(plane => plane.rows * plane.columns * 4));
        // Include visible rollback buffers, the replacement canvases, and one ImageData scratch copy.
        const reservationBytes = outputBytes + Math.max(0, newCanvasBytes - this.#canvasBytes()) + scratch;
        if (this.#outputBytes() + this.#canvasBytes() + reservationBytes > MAX_WORKSPACE_DERIVED_BYTES) throw reconstructionError('visible and replacement derived buffers exceed8MiB; choose a lower resolution');
        return { planes, outputBytes, reservationBytes };
    }
    async #render(base, overlay, selected, presentationInvert, overlayInvert, registration, current) {
        if (!selected.window) throw reconstructionError('choose an explicit modality window');
        if (selected.fourth === 'fusion' && (!overlay || !selected.overlayWindow || !registration)) throw reconstructionError('fusion requires a second volume and explicit registration');
        const plan = this.#plan(base, selected); current.reservation.derivedBytes = plan.reservationBytes; this.#progress = null; this.#notify(); current.assert();
        const images = []; let fusion;
        try {
            if (selected.fourth === 'fusion') fusion = createFusion(base, overlay, { registration });
            for (let index = 0; index < 4; index++) {
                current.assert(); const plane = plan.planes[index]; let image;
                if (index === 3 && selected.fourth === '3d') {
                    const rays = raySamplingPlan(base.geometry, plane);
                    image = await raycast(base, rays.plane, { ...rays, signal: current.signal, mode: selected.rayMode,
                        transferFunction: displayTransfer(selected.window, { color: selected.color, opacity: selected.rayMode === 'composite' ? selected.opacity : 1,
                            rampOpacity: selected.rayMode === 'composite', invert: selected.invert, presentationInvert }) });
                } else if (index === 3 && selected.fourth === 'fusion') {
                    image = await renderFusion(fusion, plane, { signal: current.signal, mode: selected.fusionMode ?? 'alpha', alpha: selected.fusionAlpha ?? 0.5,
                        baseTransferFunction: displayTransfer(selected.window, { invert: selected.invert, presentationInvert }),
                        overlayTransferFunction: displayTransfer(selected.overlayWindow, { color: 'warm', presentationInvert: overlayInvert }) });
                } else {
                    const nativeStep = Math.min(...[base.geometry.basisX, base.geometry.basisY, base.geometry.basisZ].map(axis => Math.hypot(...axis)));
                    const thickness = selected.projection === 'slice' ? 0 : selected.thicknessMm;
                    const samples = thickness === 0 ? 1 : Math.min(1024, Math.floor(MAX_RECONSTRUCTION_SAMPLES / (plane.rows * plane.columns)), Math.max(2, Math.ceil(thickness / nativeStep) + 1));
                    image = await reslice(base, plane, { signal: current.signal, projection: selected.projection, thicknessMm: thickness, samples });
                    image.rgba = await derivedToRgba(image, selected.window, { signal: current.signal, invert: selected.invert, presentationInvert }); image.bytes += image.rgba.byteLength;
                }
                images.push(image); current.assert();
            }
            return images;
        } finally { fusion?.dispose(); }
    }
    #paint(images) {
        for (let index = 0; index < images.length; index++) {
            const image = images[index], panel = this.#panels[index];
            if (panel.canvas.width !== image.columns || panel.canvas.height !== image.rows) {
                // Avoid a wide-new × tall-old transient allocation when aspect changes.
                panel.canvas.height = 0; panel.canvas.width = image.columns; panel.canvas.height = image.rows;
            }
            const Image = this.root.ownerDocument.defaultView?.ImageData ?? globalThis.ImageData;
            let data;
            if (Image) data = new Image(image.rgba, image.columns, image.rows);
            else { data = panel.context.createImageData(image.columns, image.rows); data.data.set(image.rgba); }
            panel.context.putImageData(data, 0, 0);
        }
    }
    #commit(images, selected, current) {
        current.assert();
        try { this.#paint(images); } catch {
            try { if (this.#outputs.length) this.#paint(this.#outputs); else for (const panel of this.#panels) { panel.canvas.width = 0; panel.canvas.height = 0; } } catch {}
            throw reconstructionError('Canvas2D rejected the derived display');
        }
        this.#outputs = images; this.#options = selected; this.#desiredOptions = selected; current.reservation.derivedBytes = 0;
        this.#panels[3].title.textContent = selected.fourth === '3d' ? 'Parallel3D · derived color' : selected.fourth === 'fusion' ? 'Registered fusion · separate modalities' : 'Oblique · patient plane';
        this.#syncControls(); this.#controls.probe.textContent = 'Move over a derived view to inspect modality values.';
    }
    open(options = {}) {
        this.#ensure(); plain(options, ['seriesIndex', 'maxBytes', 'signal', 'window']); signal(options.signal); checkSignal(options.signal);
        const { seriesIndex, maxBytes = MAX_VOLUME_BYTES } = options;
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_VOLUME_BYTES) throw reconstructionError('combined volume budget must be at most128MiB');
        const series = this.#selected(seriesIndex), remaining = maxBytes - this.#volumeBytes(); validateVolumeGeometry(series.frames, { maxBytes: remaining });
        const suppliedWindow = options.window ? derivedWindow(options.window, series.frames[0]?.voiFunction) : null;
        if (this.element.hidden) {
            this.#focus = this.root.getRootNode?.().activeElement ?? this.root.ownerDocument.activeElement;
            for (const child of this.root.children) if (child !== this.element) { this.#inert.set(child, Boolean(child.inert)); child.inert = true; }
        }
        this.element.hidden = false;
        this.#controls.close.focus?.();
        return this.#enqueue(async current => {
            let loaded;
            try {
                loaded = await this.#load(series, remaining, current);
                const selected = configuration({ ...DEFAULTS, window: suppliedWindow ?? loaded.window }, {});
                const images = await this.#render(loaded.volume, null, selected, loaded.presentationInvert, false, null, current);
                current.assert(); this.#commit(images, selected, current);
                const previous = [this.#base, this.#overlay]; this.#base = loaded.volume; this.#presentationInvert = loaded.presentationInvert; loaded = null; this.#overlay = null; this.#registration = null;
                this.#seriesIndex = seriesIndex; this.#overlayIndex = null; this.#budget = maxBytes; current.reservation.volumeBytes = 0;
                for (const volume of previous) volume?.dispose(); this.#refreshSeries(); this.#notify(); return this.getState();
            } finally { loaded?.volume.dispose(); }
        }, options.signal);
    }
    configure(patch = {}) {
        this.#ensure(); if (!this.#base) throw reconstructionError('open a validated spatial series first');
        const selected = configuration(this.#desiredOptions ?? this.#options, patch); this.#desiredOptions = selected;
        return this.#enqueue(async current => {
            const images = await this.#render(this.#base, this.#overlay, selected, this.#presentationInvert, this.#overlayInvert, this.#registration, current);
            this.#commit(images, selected, current); this.#notify(); return this.getState();
        });
    }
    setFusion(options = {}) {
        this.#ensure(); plain(options, ['seriesIndex', 'registration', 'alpha', 'mode', 'window', 'signal']); signal(options.signal);
        if (!this.#base) throw reconstructionError('open a base volume before fusion');
        const series = this.#selected(options.seriesIndex), remaining = this.#budget - this.#volumeBytes();
        const plan = validateVolumeGeometry(series.frames, { maxBytes: remaining });
        const matrix = validateRigidRegistration(options.registration, this.#base.geometry.frameOfReferenceUid, plan.frameOfReferenceUid);
        const registration = { matrix, fromFrameOfReferenceUid: this.#base.geometry.frameOfReferenceUid, toFrameOfReferenceUid: plan.frameOfReferenceUid };
        const supplied = options.window ? derivedWindow(options.window, series.frames[0]?.voiFunction) : null;
        const selected = configuration(this.#options, { fourth: 'fusion', fusionAlpha: options.alpha ?? 0.5, fusionMode: options.mode ?? 'alpha' });
        return this.#enqueue(async current => {
            let loaded;
            try {
                loaded = await this.#load(series, remaining, current); const next = configuration(selected, { overlayWindow: supplied ?? loaded.window });
                const images = await this.#render(this.#base, loaded.volume, next, this.#presentationInvert, loaded.presentationInvert, registration, current);
                this.#commit(images, next, current); const previous = this.#overlay; this.#overlay = loaded.volume; this.#overlayInvert = loaded.presentationInvert; loaded = null;
                this.#registration = registration; this.#overlayIndex = options.seriesIndex; current.reservation.volumeBytes = 0; previous?.dispose(); this.#notify(); return this.getState();
            } finally { loaded?.volume.dispose(); }
        }, options.signal);
    }
    probe(viewIndex, column, row) { this.#ensure(); if (this.#running || this.element.hidden || !Number.isInteger(viewIndex) || viewIndex < 0 || viewIndex >= 4) return null; return probeDerived(this.#outputs[viewIndex], column, row); }
    close() {
        ++this.#operationId; this.#running?.abort(); this.#running = null; this.#progress = null;
        this.#base?.dispose(); this.#overlay?.dispose(); this.#base = null; this.#overlay = null; this.#registration = null; this.#outputs = []; this.#options = null; this.#desiredOptions = null; this.#seriesIndex = null; this.#overlayIndex = null;
        this.element.hidden = true; for (const panel of this.#panels) { panel.canvas.width = 0; panel.canvas.height = 0; }
        this.#controls.references.textContent = ''; this.#controls.probe.textContent = ''; this.#controls.registration.value = '';
        for (const [child, prior] of this.#inert) child.inert = prior; this.#inert.clear();
        this.#focus?.focus?.(); this.#focus = null; this.#notify();
        return this.#queue.then(() => { this.#notify(); return this.getState(); });
    }
    dispose() {
        if (this.#disposed) return this.#queue.then(() => this.getState());
        const done = this.close(); this.#disposed = true; this.element.remove(); this.onChange = null; this.onError = null; this.getSeries = null; this.getFrame = null; this.getSeriesCount = null;
        return done.then(() => this.getState());
    }

    #build() {
        const document = this.root.ownerDocument;
        const node = (tag, className, text) => { const item = document.createElement(tag); if (className) item.className = className; if (text != null) item.textContent = text; return item; };
        const modal = node('section', 'reconstruction-workspace'); modal.hidden = true; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', 'Derived reconstruction workspace');
        const header = node('header', 'reconstruction-header'), title = node('h2', '', 'Reconstruct in patient space'), close = node('button', 'reconstruction-close', 'Close'); close.type = 'button'; close.addEventListener('click', () => this.close());
        header.append(title, close); modal.append(header); this.#controls.close = close;
        const status = node('p', 'reconstruction-status'), error = node('p', 'reconstruction-error'), probe = node('output', 'reconstruction-probe'); error.hidden = true; error.setAttribute('role', 'alert');
        this.#controls.status = status; this.#controls.error = error; this.#controls.probe = probe;
        modal.append(node('p', 'reconstruction-note', 'DERIVED · LPS patient coordinates · explicit volume allocation · research alpha'), status, error);
        const controls = node('div', 'reconstruction-controls'), editable = [];
        const invoke = action => { try { Promise.resolve(action()).catch(failure => this.#report(failure)); } catch (failure) { this.#report(failure); } };
        const field = (label, input, key) => { const wrapper = node('label', 'reconstruction-field'), caption = node('span', '', label); wrapper.append(caption, input); controls.append(wrapper); this.#controls[key] = input; editable.push(input); return input; };
        const number = (label, key, value, minimum, maximum, step = 'any', type = 'number') => {
            const input = node('input'); input.type = type; input.min = String(minimum); input.max = String(maximum); input.step = String(step); input.value = String(value);
            field(label, input, key); input.addEventListener('change', () => invoke(() => this.configure({ [key]: Number(input.value) }))); return input;
        };
        const select = (label, key, choices) => {
            const input = node('select'); for (const [value, title] of choices) { const option = node('option', '', title); option.value = value; input.append(option); }
            field(label, input, key); input.addEventListener('change', () => invoke(() => this.configure({ [key]: key === 'maximumSize' ? Number(input.value) : input.value }))); return input;
        };
        select('Fourth view', 'fourth', [['oblique', 'Oblique plane'], ['3d', 'Parallel3D'], ['fusion', 'Registered fusion']]);
        select('Slab projection', 'projection', [['slice', 'Slice'], ['mip', 'MIP'], ['minip', 'minIP'], ['mean', 'Mean']]);
        number('Slab thickness (mm)', 'thicknessMm', 0, 0, 10000);
        for (const [key, label] of [['axialPosition', 'Axial position'], ['coronalPosition', 'Coronal position'], ['sagittalPosition', 'Sagittal position'], ['obliquePosition', 'Oblique position']]) number(`${label} (fraction)`, key, 0.5, 0, 1, 0.001, 'range');
        number('Oblique yaw (degrees)', 'yawDeg', 0, -180, 180, 1, 'range'); number('Oblique pitch (degrees)', 'pitchDeg', 0, -90, 90, 1, 'range');
        select('Output resolution', 'maximumSize', [['128', '128 pixels'], ['192', '192 pixels'], ['256', '256 pixels']]);
        select('3D projection', 'rayMode', [['composite', 'Color/opacity composite'], ['mip', 'MIP'], ['minip', 'minIP'], ['mean', 'Mean']]);
        select('3D color transfer', 'color', [['grayscale', 'Continuous grayscale'], ['warm', 'Continuous warm']]); number('Opacity per sample', 'opacity', 0.12, 0, 1, 0.01, 'range');
        select('Fusion display', 'fusionMode', [['alpha', 'Alpha blend'], ['checkerboard', 'Checkerboard']]); number('Overlay alpha', 'fusionAlpha', 0.5, 0, 1, 0.01, 'range');
        const invert = node('input'); invert.type = 'checkbox'; field('Invert derived grayscale', invert, 'invert'); invert.addEventListener('change', () => invoke(() => this.configure({ invert: invert.checked })));
        const windowInput = (label, key) => { const input = node('input'); input.type = 'number'; input.step = 'any'; field(label, input, key); input.addEventListener('change', () => invoke(() => this.configure({ window: { center: Number(this.#controls.center.value), width: Number(this.#controls.width.value), voiFunction: this.#controls.voiFunction.value } }))); };
        windowInput('Modality window center', 'center'); windowInput('Modality window width', 'width');
        const voi = node('select'); for (const value of ['LINEAR', 'LINEAR_EXACT', 'SIGMOID']) { const option = node('option', '', value); option.value = value; voi.append(option); }
        field('VOI function', voi, 'voiFunction'); voi.addEventListener('change', () => invoke(() => this.configure({ window: { ...this.#options.window, voiFunction: voi.value } })));
        modal.append(controls); this.#controls.editable = editable;
        const grid = node('div', 'reconstruction-grid');
        for (const title of ['Axial · L/P', 'Coronal · L/I', 'Sagittal · P/I', 'Oblique · patient plane']) {
            const panel = node('figure', 'reconstruction-panel'), caption = node('figcaption', '', title), canvas = node('canvas', 'reconstruction-canvas'); canvas.width = 0; canvas.height = 0;
            canvas.style.objectFit = 'contain'; canvas.style.objectPosition = 'center';
            canvas.setAttribute('aria-label', `${title} derived view`); panel.append(caption, canvas); grid.append(panel);
            const context = canvas.getContext('2d'); if (!context) throw reconstructionError('Canvas2D is unavailable');
            const index = this.#panels.length; this.#panels.push({ canvas, context, title: caption });
            canvas.addEventListener('pointermove', event => {
                const point = derivedCanvasPoint(canvas.getBoundingClientRect(), { columns: canvas.width, rows: canvas.height }, event.clientX, event.clientY);
                const result = point ? this.probe(index, point.column, point.row) : null;
                if (!result) return;
                if (result.kind === 'parallel-ray-color') probe.textContent = `DERIVED · parallel-ray${result.mode === 'composite' ? ' composite' : ` ${result.mode}`} RGB ${result.rgba.slice(0, 3).join(', ')} · no single-voxel value`;
                else if (result.kind === 'derived-fusion') probe.textContent = `DERIVED · base ${result.base ?? 'padding/outside'} ${result.baseUnit} · overlay ${result.overlay ?? 'padding/outside'} ${result.overlayUnit} · LPS [${result.patient.map(value => value.toFixed(2)).join(', ')}] mm`;
                else probe.textContent = `DERIVED · ${result.projection} ${result.value ?? 'padding/outside'} ${result.unit} · LPS [${result.patient.map(value => value.toFixed(2)).join(', ')}] mm`;
            });
        }
        modal.append(grid, probe);
        const fusion = node('details', 'reconstruction-fusion'), summary = node('summary', '', 'Explicit registered fusion'), series = node('select'), registration = node('textarea');
        registration.rows = 4; registration.placeholder = 'Explicit row-major base-patient → overlay-patient rigid matrix JSON';
        const references = node('p', 'reconstruction-registration-references'), apply = node('button', '', 'Load registered overlay'); apply.type = 'button';
        const seriesLabel = node('label', '', 'Overlay series'), registrationLabel = node('label', '', 'Registration JSON'); seriesLabel.append(series); registrationLabel.append(registration);
        fusion.append(summary, seriesLabel, references, registrationLabel, apply); modal.append(fusion);
        this.#controls.fusionSeries = series; this.#controls.references = references; this.#controls.registration = registration; editable.push(series, registration, apply);
        series.addEventListener('change', () => this.#referenceLabels());
        apply.addEventListener('click', () => invoke(() => { let value; try { value = JSON.parse(registration.value); } catch { throw reconstructionError('enter valid explicit registration JSON'); } return this.setFusion({ seriesIndex: Number(series.value), registration: value, alpha: 0.5, mode: 'alpha' }); }));
        modal.addEventListener('keydown', event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(); }
            if (event.key === 'Tab') {
                const items = [...modal.querySelectorAll('button,input,select,textarea,summary')].filter(item => !item.disabled && !item.hidden && (item.tagName === 'SUMMARY' || !item.closest?.('details:not([open])'))), first = items[0], last = items.at(-1);
                const active = this.root.getRootNode?.().activeElement ?? document.activeElement;
                if (event.shiftKey && active === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && active === last) { event.preventDefault(); first?.focus(); }
            }
        });
        return modal;
    }
    #syncControls() {
        if (!this.#options) return;
        if (![128, 192, 256].includes(this.#options.maximumSize)) {
            if (!this.#customResolution) { this.#customResolution = this.root.ownerDocument.createElement('option'); this.#controls.maximumSize.append(this.#customResolution); }
            this.#customResolution.value = String(this.#options.maximumSize); this.#customResolution.textContent = `${this.#options.maximumSize} pixels (custom)`;
        } else { this.#customResolution?.remove(); this.#customResolution = null; }
        for (const key of Object.keys(DEFAULTS)) if (this.#controls[key]) this.#controls[key].value = String(this.#options[key]);
        this.#controls.invert.checked = this.#options.invert;
        this.#controls.center.value = String(this.#options.window.center); this.#controls.width.value = String(this.#options.window.width); this.#controls.voiFunction.value = this.#options.window.voiFunction;
    }
    #refreshSeries() {
        const select = this.#controls.fusionSeries; select.replaceChildren(); const count = this.getSeriesCount();
        for (let index = 0; index < count; index++) {
            const series = this.getSeries(index), option = this.root.ownerDocument.createElement('option'); option.value = String(index);
            option.textContent = `Series ${index + 1} · ${series?.frames?.[0]?.modality ?? 'unknown modality'} · ${series?.frames?.length ?? 0} frames`; select.append(option);
        }
        select.value = String(this.#overlayIndex ?? this.#seriesIndex); this.#referenceLabels();
    }
    #referenceLabels() {
        const index = Number(this.#controls.fusionSeries.value); let overlay;
        try { overlay = this.#selected(index); } catch { overlay = null; }
        this.#controls.references.textContent = `Base Frame of Reference: ${this.#base?.geometry.frameOfReferenceUid ?? 'unavailable'} · Overlay Frame of Reference: ${overlay?.frames?.[0]?.frameOfReferenceUid ?? 'unavailable'}. Supply an explicit registration; alignment is never inferred.`;
    }
}
