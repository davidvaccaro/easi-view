import EASI from '@xinonix/easi-js';
import { normalizeCine, nextCineFrame, createXaSubtraction, DoseGrid, normalizeBreastImage, createBreastLayout, createSlideIndex,
    readSpecialtyInstance, readSpecialtyMetadata, XA_SOP_CLASS, RT_DOSE_SOP_CLASS, WSI_SOP_CLASS, MAMMOGRAPHY_SOP_CLASSES,
    MAX_SPECIALTY_BYTES, MAX_SPECIALTY_METADATA_BYTES } from '../specialties/index.js';
import { attribute, scalar, text, numbers, checkSignal, fail, yieldTask } from '../specialties/common.js';
import { one, abortable } from '../derived/common.js';

const SCRATCH = 256 * 1024;
const MAX_REPORT_BYTES = 1024 * 1024;
const DEFAULT_WINDOW = Object.freeze({ xa: { center: 0, width: 512 }, dose: { center: 25, width: 50 }, relative: { center: 0.5, width: 1 } });
const CINE_CLASSES = new Set(['1.2.840.10008.5.1.4.1.1.3.1', XA_SOP_CLASS, '1.2.840.10008.5.1.4.1.1.12.2',
    '1.2.840.10008.5.1.4.1.1.7.1', '1.2.840.10008.5.1.4.1.1.7.2', '1.2.840.10008.5.1.4.1.1.7.3', '1.2.840.10008.5.1.4.1.1.7.4']);
const canceled = () => new DOMException('Specialty workspace operation was canceled.', 'AbortError');
function observe(callback, state) { try { Promise.resolve(callback?.(state)).catch(() => {}); } catch {} }
function plain(value, keys) {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
        Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) throw new TypeError('Use supported specialty workspace options.');
}
function signal(value) { if (value != null && !(value instanceof AbortSignal)) throw new TypeError('Use an AbortSignal for specialty processing.'); }
function boundedSize(value, maximum) { if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail('local input exceeds its supported byte budget'); }
function jsonBytes(value) { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
function sanitized(error) {
    if (error?.name === 'AbortError') return error;
    if (typeof error?.message === 'string' && /^(?:Unsupported (?:specialty profile|derived object|reconstruction):|Use supported specialty|Specialty workspace|Canvas2D)/u.test(error.message)) return error;
    return new Error('Specialty workspace could not read this local object or its supported metadata.');
}

/** Explicit scalar display transfer; no observed-range normalization. */
export function specialtyWindow(value) {
    plain(value, ['center', 'width']);
    if (!Number.isFinite(value.center) || Math.abs(value.center) > 1e12 || !Number.isFinite(value.width) || value.width < 1e-12 || value.width > 1e12) fail('display window must be finite, positive and bounded');
    return Object.freeze({ center: value.center, width: value.width });
}
export async function specialtyValuesToRgba(values, rows, columns, window, { signal: abortSignal, maxBytes = MAX_SPECIALTY_BYTES } = {}) {
    checkSignal(abortSignal); const display = specialtyWindow(window), count = rows * columns;
    if (!(values instanceof Float64Array) || !Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1 || count !== values.length ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 0 || count * 4 > maxBytes) fail('scalar display exceeds its buffer budget or has invalid dimensions');
    const rgba = new Uint8ClampedArray(count * 4);
    for (let start = 0; start < count; start += 65536) {
        checkSignal(abortSignal);
        for (let index = start; index < Math.min(count, start + 65536); index++) {
            const value = values[index];
            if (!Number.isFinite(value)) fail('derived scalar display contains nonfinite values');
            const gray = Math.round(Math.max(0, Math.min(1, (value - display.center) / display.width + 0.5)) * 255);
            rgba[index * 4] = rgba[index * 4 + 1] = rgba[index * 4 + 2] = gray; rgba[index * 4 + 3] = 255;
        }
        if (start + 65536 < count) await yieldTask();
    }
    checkSignal(abortSignal); return rgba;
}
/** object-fit:contain image content, including anisotropic display aspect. */
export function specialtyCanvasPoint(rect, dimensions, clientX, clientY) {
    const { columns, rows, pixelAspect = 1 } = dimensions ?? {};
    if (![rect?.left, rect?.top, rect?.width, rect?.height, columns, rows, pixelAspect, clientX, clientY].every(Number.isFinite) ||
        rect.width <= 0 || rect.height <= 0 || rows < 1 || columns < 1 || pixelAspect <= 0) return null;
    const aspect = columns * pixelAspect / rows;
    const width = Math.min(rect.width, rect.height * aspect), height = width / aspect;
    const left = rect.left + (rect.width - width) / 2, top = rect.top + (rect.height - height) / 2;
    if (clientX < left || clientY < top || clientX >= left + width || clientY >= top + height) return null;
    return { column: Math.floor((clientX - left) / width * columns), row: Math.floor((clientY - top) / height * rows) };
}

function configuration(previous, patch) {
    plain(patch, ['window', 'manualRateFps', 'manualFrameTimeMs', 'slideRegion', 'slidePoint']);
    const next = { ...previous, ...patch };
    if (patch.manualRateFps != null) next.manualFrameTimeMs = null;
    if (patch.manualFrameTimeMs != null) next.manualRateFps = null;
    if (patch.manualRateFps != null && patch.manualFrameTimeMs != null) fail('choose one manual timing override');
    if (next.window != null) next.window = specialtyWindow(next.window);
    if (next.manualRateFps != null && (!Number.isFinite(next.manualRateFps) || next.manualRateFps <= 0 || next.manualRateFps > 1000) ||
        next.manualFrameTimeMs != null && (!Number.isFinite(next.manualFrameTimeMs) || next.manualFrameTimeMs <= 0 || next.manualFrameTimeMs > 60000)) fail('manual cine timing is invalid');
    if (next.slideRegion != null) { plain(next.slideRegion, ['column', 'row', 'width', 'height']); next.slideRegion = { ...next.slideRegion }; }
    if (next.slidePoint != null) { plain(next.slidePoint, ['xMm', 'yMm', 'zUm']); next.slidePoint = { ...next.slidePoint }; }
    return next;
}

/** Local native metadata pass: Pixel Data is streamed and deliberately discarded. */
async function readNativeMetadata(file, abortSignal, maximum) {
    checkSignal(abortSignal); let underlying = null, offset = 0, sliceEnd = 0, loaded = 0, closed = false, controller;
    const releaseReader = () => { try { underlying?.releaseLock(); } catch {} underlying = null; };
    const cleanup = () => { abortSignal.removeEventListener('abort', abort); releaseReader(); };
    const abort = () => { if (closed) return; closed = true; controller?.error(canceled()); Promise.resolve(underlying?.cancel()).catch(() => {}).finally(cleanup); };
    const source = new ReadableStream({
        start(value) { controller = value; abortSignal.addEventListener('abort', abort, { once: true }); if (abortSignal.aborted) abort(); },
        async pull(value) {
            try {
                while (!closed) {
                    checkSignal(abortSignal);
                    if (!underlying) {
                        if (offset >= file.size) { closed = true; cleanup(); value.close(); return; }
                        sliceEnd = Math.min(file.size, offset + 64 * 1024);
                        underlying = file.slice(offset, sliceEnd).stream().getReader();
                    }
                    const chunk = await underlying.read(); if (closed) return;
                    if (chunk.done) { releaseReader(); offset = sliceEnd; continue; }
                    if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength > 64 * 1024 || (loaded += chunk.value.byteLength) > maximum) fail('local stream exceeds its byte or chunk budget');
                    value.enqueue(chunk.value); return;
                }
            } catch (error) { if (!closed) { closed = true; value.error(error); } await underlying?.cancel().catch(() => {}); cleanup(); }
        }, async cancel() { closed = true; await underlying?.cancel().catch(() => {}); cleanup(); }
    });
    const reader = EASI.pipelineBuilder().fromPartStream().ofDicomData().withBulkDataPolicy({ mode: 'auto', knownLengthThreshold: 0, hardSafetyCap: MAX_SPECIALTY_METADATA_BYTES }).toInstances().build();
    const handler = reader.parser.handler; let metadataBytes = 0, items = 0;
    const count = (attribute, sequence) => {
        checkSignal(abortSignal); metadataBytes += 128;
        if (!sequence && !['7FE00010', '7FE00008', '7FE00009'].includes(attribute.tag?.ID)) {
            if (!Number.isSafeInteger(attribute.valueLength) || attribute.valueLength < 0 || attribute.valueLength === 0xFFFFFFFF) fail('undefined metadata values are unsupported');
            metadataBytes += attribute.valueLength;
        }
        if (metadataBytes > MAX_SPECIALTY_METADATA_BYTES) fail('materialized metadata exceeds8MiB');
    };
    for (const [method, sequence] of [['onStartAttribute', false], ['onStartSequence', true]]) {
        const original = handler[method].bind(handler); handler[method] = (context, attr) => { count(attr, sequence); return original(context, attr); };
    }
    const item = handler.onStartItem.bind(handler); handler.onStartItem = context => { if (++items > 32768 || (metadataBytes += 64) > MAX_SPECIALTY_METADATA_BYTES) fail('metadata item budget exceeded'); return item(context); };
    try {
        const result = await reader.process({ source, sourceOptions: { contentType: 'application/dicom' } }); checkSignal(abortSignal);
        if (result.count !== 1) fail('one native metadata instance is required'); return { instance: result.first(), metadataBytes };
    } catch (error) { checkSignal(abortSignal); throw error; }
    finally { if (!closed) { closed = true; await underlying?.cancel().catch(() => {}); } cleanup(); }
}
function releaseInstance(instance) { if (!instance) return; attribute(instance.dataSet, '7FE00010')?.clear(); instance.dataSet = null; instance.metaSet = null; }

/** Owned research dialog. No integration with main image sources or transport. */
export class SpecialtyWorkspace {
    #model = null; #output = null; #options = null; #desired = null; #queue = Promise.resolve(); #running = null; #generation = 0;
    #pendingBytes = 0; #frameIndex = 0; #disposed = false; #error = false; #playing = false; #timer = null; #playGeneration = 0;
    #focus = null; #inert = new Map(); #controls = {}; #listeners = []; #canvas; #context; #reported = new WeakSet();
    constructor(root, { onChange, onError } = {}) {
        if (!root?.ownerDocument || onChange != null && typeof onChange !== 'function' || onError != null && typeof onError !== 'function') throw new TypeError('Provide a specialty root and optional observer callbacks.');
        this.root = root; this.onChange = onChange; this.onError = onError;
        this.element = this.#build(); root.append(this.element);
    }
    #ensure() { if (this.#disposed) throw new Error('Specialty workspace is disposed.'); }
    #canvasBytes() { return this.#canvas.width * this.#canvas.height * 4; }
    #retained() { return (this.#model?.bytes ?? 0) + (this.#output?.bytes ?? 0) + this.#canvasBytes(); }
    #reserve(bytes, current) {
        if (!Number.isSafeInteger(bytes) || bytes < 0 || this.#retained() + bytes > MAX_SPECIALTY_BYTES) fail('combined specialty buffers and rollback exceed64MiB');
        current.assert(); this.#pendingBytes = bytes; this.#notify(); current.assert();
    }
    getState() {
        const model = this.#model;
        return { open: !this.element.hidden && !this.#disposed, ready: Boolean(model) && !this.#disposed, busy: Boolean(this.#running) && !this.element.hidden && !this.#disposed,
            playing: this.#playing, disposed: this.#disposed, error: this.#error, profile: model?.kind ?? null, sourceCount: model?.sourceRefs.length ?? 0,
            frameIndex: model ? this.#frameIndex : null, frameCount: model?.frameCount ?? 0, dimensions: model?.rows ? [model.columns, model.rows] : null,
            modelBytes: model?.bytes ?? 0, outputBytes: this.#output?.bytes ?? 0, canvasBytes: this.#canvasBytes(), pendingBytes: this.#pendingBytes,
            bytes: this.#retained() + this.#pendingBytes, budget: MAX_SPECIALTY_BYTES, hasCine: Boolean(model?.cine),
            timing: model?.cine?.timing ?? null, tileQueryCount: model?.tiles?.length ?? 0, readyLayoutSlots: model?.layout?.slots.filter(slot => slot.status === 'ready').length ?? 0,
            ambiguousLayoutSlots: model?.layout?.slots.filter(slot => slot.status === 'ambiguous').length ?? 0 };
    }
    #notify() {
        const state = this.getState(); this.element.setAttribute('aria-busy', String(state.busy));
        this.#controls.status.textContent = state.busy ? 'Processing local specialty data…' : state.ready ? `${state.profile} · local research profile · original images unchanged` : 'Open explicit local DICOM files or DICOM JSON metadata.';
        this.#controls.frame.disabled = !state.ready || state.busy || state.frameCount < 2;
        this.#controls.play.disabled = !state.hasCine || state.busy;
        this.#controls.play.textContent = state.playing ? 'Pause cine' : 'Play cine';
        this.#controls.manualRate.disabled = !state.ready || state.busy || !this.#model?.cineSet;
        for (const input of [this.#controls.center, this.#controls.width]) input.disabled = !['xa', 'dose'].includes(state.profile) || state.busy;
        observe(this.onChange, state);
    }
    #report(error) {
        if (error?.name === 'AbortError' || error && typeof error === 'object' && this.#reported.has(error)) return;
        if (error && typeof error === 'object') this.#reported.add(error);
        this.#error = true; this.#controls.error.textContent = error?.message ?? 'Specialty workspace operation failed.'; this.#controls.error.hidden = false; observe(this.onError, error);
    }
    #show() {
        if (this.element.hidden) {
            this.#focus = this.root.getRootNode?.().activeElement ?? this.root.ownerDocument.activeElement;
            for (const child of this.root.children) if (child !== this.element) { this.#inert.set(child, Boolean(child.inert)); child.inert = true; }
        }
        this.element.hidden = false; this.#controls.close.focus?.();
    }
    #enqueue(callback, externalSignal) {
        signal(externalSignal); checkSignal(externalSignal); this.#ensure(); const id = ++this.#generation; this.#running?.abort();
        const controller = new AbortController(), combined = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
        this.#running = controller; this.#error = false; this.#controls.error.hidden = true; this.#notify();
        const assert = () => { checkSignal(combined); if (id !== this.#generation || this.#disposed || this.element.hidden) throw canceled(); };
        const pending = this.#queue.catch(() => {}).then(async () => {
            try { assert(); await callback({ signal: combined, assert }); assert(); }
            catch (failure) { const error = sanitized(failure); if (id === this.#generation && !this.#disposed && !this.element.hidden) { this.#desired = this.#options; this.#sync(); this.#report(error); } throw error; }
            finally { this.#pendingBytes = 0; if (id === this.#generation) { this.#running = null; this.#notify(); } }
        });
        this.#queue = pending.catch(() => {}); return pending.then(() => this.getState());
    }
    async #metadata(file, current, extraBytes = 0) {
        this.#reserve(extraBytes + Math.min(file.size * 3 + SCRATCH, MAX_SPECIALTY_METADATA_BYTES * 3 + SCRATCH), current);
        const prefix = new Uint8Array(await abortable(() => file.slice(0, 256).arrayBuffer(), current.signal)); current.assert();
        const isJson = /^\s*[\[{]/u.test(new TextDecoder().decode(prefix));
        if (isJson) {
            boundedSize(file.size, MAX_SPECIALTY_METADATA_BYTES); this.#reserve(extraBytes + file.size * 3 + SCRATCH, current);
            const instance = await readSpecialtyMetadata(await abortable(() => file.text(), current.signal), { signal: current.signal }); current.assert();
            return { instance, metadataBytes: file.size * 2 };
        }
        const result = await readNativeMetadata(file, current.signal, MAX_SPECIALTY_BYTES); current.assert(); return result;
    }
    async #modelFor(files, current) {
        const sourceRefs = [], breast = []; let descriptor = null, metadataInstance = null, numeric = null;
        try {
            for (const file of files) {
                const parsed = await this.#metadata(file, current, jsonBytes(breast) * 4); metadataInstance = parsed.instance;
                const set = metadataInstance.dataSet, sopClass = text(set, '00080016');
                const ref = { sopUid: text(set, '00080018'), studyUid: text(set, '0020000D'), seriesUid: text(set, '0020000E') }; sourceRefs.push(ref);
                if (MAMMOGRAPHY_SOP_CLASSES.includes(sopClass)) { breast.push(normalizeBreastImage(metadataInstance)); releaseInstance(metadataInstance); metadataInstance = null; continue; }
                if (files.length !== 1) fail('open one specialty object or a set of breast images');
                if (sopClass === WSI_SOP_CLASS) {
                    const slide = createSlideIndex(metadataInstance), region = { column: 0, row: 0, width: slide.metadata.tileColumns, height: slide.metadata.tileRows };
                    descriptor = { kind: 'slide', slide, sourceRefs, frameCount: slide.metadata.frameCount, rows: null, columns: null, tiles: slide.tilesInRegion(region), region,
                        bytes: jsonBytes(slide.metadata) * 4, cine: null, numeric: null };
                } else if (sopClass === RT_DOSE_SOP_CLASS || sopClass === XA_SOP_CLASS && text(one(set, '00286100', { required: false }), '00286101', { required: false }) === 'AVG_SUB') {
                    const rows = scalar(set, '00280010'), columns = scalar(set, '00280011'), count = scalar(set, '00280008', { required: false }) ?? 1, pixels = rows * columns;
                    const nativeBytes = pixels * count * (sopClass === RT_DOSE_SOP_CLASS ? scalar(set, '00280100') / 8 : 2), modelBytes = nativeBytes + (sopClass === XA_SOP_CLASS ? pixels * 8 : 0);
                    const cine = sopClass === XA_SOP_CLASS ? this.#cineOptional(set) : null;
                    const cineSet = sopClass === XA_SOP_CLASS ? this.#cineMetadata(set) : null;
                    const spacing = numbers(set, '00280030', { required: false, maximum: 2 });
                    const pixelAspect = spacing.length === 2 && spacing.every(value => value > 0) ? spacing[1] / spacing[0] : 1;
                    const scratchMetadata = jsonBytes({ cineSet, sourceRefs }) * 4;
                    if (!Number.isSafeInteger(modelBytes) || modelBytes < 1) fail('numeric specialty dimensions are invalid');
                    releaseInstance(metadataInstance); metadataInstance = null;
                    // Raw input is held during the processor's copy. Include a
                    // selected Float64/RGBA/canvas/ImageData replacement too.
                    this.#reserve(file.size * 3 + modelBytes + scratchMetadata + pixels * 22 + SCRATCH, current);
                    const raw = await readSpecialtyInstance(file, { signal: current.signal });
                    try {
                        current.assert(); numeric = sopClass === RT_DOSE_SOP_CLASS ? await DoseGrid.fromInstance(raw, { signal: current.signal, maxBytes: MAX_SPECIALTY_BYTES - this.#retained() - file.size * 3 - scratchMetadata - pixels * 12 - SCRATCH })
                            : await createXaSubtraction(raw, { signal: current.signal, maxBytes: MAX_SPECIALTY_BYTES - this.#retained() - file.size * 3 - scratchMetadata - pixels * 12 - SCRATCH });
                        current.assert();
                    } finally { releaseInstance(raw); }
                    descriptor = { kind: sopClass === RT_DOSE_SOP_CLASS ? 'dose' : 'xa', sourceRefs, rows, columns, frameCount: count, numeric, cine, cineSet, pixelAspect,
                        bytes: numeric.bytes + scratchMetadata, units: sopClass === RT_DOSE_SOP_CLASS ? numeric.geometry.units : 'stored-intensity difference' };
                    numeric = null;
                } else if (CINE_CLASSES.has(sopClass)) {
                    const cine = normalizeCine(set), cineSet = this.#cineMetadata(set);
                    descriptor = { kind: 'cine', sourceRefs, frameCount: cine.frameCount, rows: null, columns: null, cine, cineSet, numeric: null,
                        bytes: jsonBytes({ cine, cineSet, sourceRefs }) * 4 };
                } else fail('this SOP Class has no supported specialty workspace profile');
                releaseInstance(metadataInstance); metadataInstance = null;
            }
            if (breast.length) {
                const layout = createBreastLayout(breast); descriptor = { kind: 'breast', sourceRefs, layout, frameCount: 1, rows: null, columns: null, numeric: null, cine: null, bytes: jsonBytes(layout) * 4 };
            }
            if (!descriptor) fail('a supported explicit specialty object is required'); current.assert(); return descriptor;
        } catch (error) { numeric?.dispose(); descriptor?.numeric?.dispose(); throw error; }
        finally { releaseInstance(metadataInstance); }
    }
    #cineMetadata(set) {
        // Tiny EASI dataset snapshot of timing fields only; no patient metadata
        // or Pixel Data survives the local parse stage.
        const ids = ['00280008', '00280009', '00181063', '00181065', '00181066', '00181244', '00082142', '00082143', '00082144'];
        return { attributes: ids.map(id => attribute(set, id)).filter(Boolean), find(tag) { return this.attributes.find(attr => attr.tag?.ID === tag.ID); } };
    }
    #cineOptional(set) { try { return normalizeCine(set); } catch { return null; } }
    #first(model) { return model.kind === 'xa' ? model.numeric.metadata.applicableRanges[0] : model.cine ? model.cine.startFrameIndex : 0; }
    async #derive(model, frameIndex, options, current, replacing = false) {
        if (!['xa', 'dose'].includes(model.kind)) return null;
        if (model.kind === 'xa' && !model.numeric.metadata.applicableRanges.some((start, index, ranges) => index % 2 === 0 && frameIndex >= start && frameIndex <= ranges[index + 1])) {
            this.#reserve(replacing ? model.bytes : 0, current); return null;
        }
        const pixels = model.rows * model.columns, extra = (replacing ? model.bytes : 0) + pixels * 22 + SCRATCH;
        this.#reserve(extra, current);
        const output = model.kind === 'xa' ? await model.numeric.subtract(frameIndex, { signal: current.signal }) : await model.numeric.frameValues(frameIndex, { signal: current.signal });
        current.assert(); output.rgba = await specialtyValuesToRgba(output.values, model.rows, model.columns, options.window, { signal: current.signal, maxBytes: pixels * 4 });
        output.bytes += output.rgba.byteLength;
        if (model.kind === 'xa') { output.originalStored = model.numeric.storedFrame(frameIndex); output.bytes += output.originalStored.byteLength; }
        current.assert(); return output;
    }
    #paint(output, model, transferReservation = false) {
        const oldBytes = this.#canvasBytes(), newBytes = (output?.columns ?? 0) * (output?.rows ?? 0) * 4;
        if (this.#canvas.width !== (output?.columns ?? 0) || this.#canvas.height !== (output?.rows ?? 0)) this.#canvas.height = 0;
        // Transfer admitted canvas growth from pending reservation to the real
        // backing before allocating it. Operational totals stay within64MiB
        // even if a host reads getState during a dimension setter/upload.
        if (transferReservation) this.#pendingBytes = Math.max(0, this.#pendingBytes - Math.max(0, newBytes - oldBytes));
        this.#canvas.width = output?.columns ?? 0; this.#canvas.height = output?.rows ?? 0;
        if (!output) return;
        const Image = this.root.ownerDocument.defaultView?.ImageData ?? globalThis.ImageData;
        let image; if (Image) image = new Image(output.rgba, output.columns, output.rows);
        else { image = this.#context.createImageData(output.columns, output.rows); image.data.set(output.rgba); }
        this.#context.putImageData(image, 0, 0);
        const aspect = String(model.columns * (model.pixelAspect ?? (model.kind === 'dose' ? model.numeric.geometry.pixelSpacing[1] / model.numeric.geometry.pixelSpacing[0] : 1)) / model.rows);
        this.#canvas.style.aspectRatio = aspect;
        this.#canvas.style.setProperty?.('--specialty-aspect', aspect);
    }
    #commit(model, output, options, frameIndex, current) {
        current.assert(); const previous = this.#model;
        try { this.#paint(output, model, true); }
        catch { try { this.#paint(this.#output, previous); } catch {} throw new Error('Canvas2D could not commit the specialty display.'); }
        this.#model = model; this.#output = output; this.#options = options; this.#desired = options; this.#frameIndex = frameIndex; this.#pendingBytes = 0;
        this.#controls.probe.textContent = '';
        if (previous?.numeric && previous.numeric !== model.numeric) previous.numeric.dispose(); this.#sync(); this.#describe(); this.#notify();
    }
    openFiles(files, options = {}) {
        this.#ensure(); plain(options, ['signal']); signal(options.signal); checkSignal(options.signal);
        if (!Array.isArray(files) || !files.length || files.length > 256 || files.some(file => !(file instanceof Blob))) throw new TypeError('Choose up to256 explicit local Blob/File inputs.');
        for (const file of files) boundedSize(file.size, MAX_SPECIALTY_BYTES);
        this.pause(); this.#show(); const localFiles = [...files];
        return this.#enqueue(async current => {
            let model;
            try {
                model = await this.#modelFor(localFiles, current); current.assert();
                const options = configuration({}, { window: model.kind === 'xa' ? DEFAULT_WINDOW.xa : model.kind === 'dose' ? model.units === 'GY' ? DEFAULT_WINDOW.dose : DEFAULT_WINDOW.relative : null });
                const frameIndex = this.#first(model), output = await this.#derive(model, frameIndex, options, current, true);
                if (!output) this.#reserve(model.bytes, current);
                this.#commit(model, output, options, frameIndex, current); model = null;
            } finally { model?.numeric?.dispose(); }
        }, options.signal);
    }
    configure(patch = {}) {
        this.#ensure(); if (!this.#model) fail('open a specialty object before configuration');
        const selected = configuration(this.#desired ?? this.#options, patch);
        if (Object.hasOwn(patch, 'window') && !['xa', 'dose'].includes(this.#model.kind)) fail('scalar windows require an XA or dose preview');
        if (['xa', 'dose'].includes(this.#model.kind) && !selected.window) fail('choose an explicit quantitative display window');
        this.pause(); this.#desired = selected;
        return this.#enqueue(async current => {
            const model = this.#model, cine = model.cineSet && (model.cine || selected.manualRateFps != null || selected.manualFrameTimeMs != null) ? normalizeCine(model.cineSet, selected) : model.cine;
            if ((patch.manualRateFps != null || patch.manualFrameTimeMs != null) && !model.cineSet) fail('this profile has no cine timing');
            if (model.slide && selected.slideRegion) this.#reserve(1024 * 1024, current);
            const tiles = model.slide && selected.slideRegion ? model.slide.tilesInRegion(selected.slideRegion) : model.tiles;
            const slidePixel = model.slide && selected.slidePoint ? model.slide.slideToPixel(selected.slidePoint) : model.slidePixel;
            if ((selected.slideRegion || selected.slidePoint) && !model.slide) fail('slide coordinates require the whole-slide index profile');
            const updated = { ...model, cine, tiles, slidePixel, region: selected.slideRegion ?? model.region };
            if (model.slide) updated.bytes = jsonBytes({ metadata: model.slide.metadata, tiles, slidePixel }) * 4;
            const output = await this.#derive(updated, this.#frameIndex, selected, current);
            if (!output) this.#reserve(updated.numeric ? 0 : updated.bytes, current);
            this.#commit(updated, output, selected, this.#frameIndex, current);
        });
    }
    setFrame(index) {
        this.#ensure(); if (!this.#model || !Number.isSafeInteger(index) || index < 0 || index >= this.#model.frameCount) fail('choose a valid original frame index');
        this.pause(); return this.#setFrame(index);
    }
    #setFrame(index) {
        this.#ensure(); const model = this.#model;
        if (!model || !Number.isSafeInteger(index) || index < 0 || index >= model.frameCount) fail('choose a valid original frame index');
        return this.#enqueue(async current => {
            const output = await this.#derive(model, index, this.#options, current); this.#commit(model, output, this.#options, index, current);
        });
    }
    play() {
        this.#ensure(); const model = this.#model; if (!model?.cine) fail('this object has no supported cine plan'); if (this.#running) fail('wait for the current specialty operation');
        this.pause(); this.#playing = true; const generation = ++this.#playGeneration;
        let position = model.cine.sequence.indexOf(this.#frameIndex); if (position < 0) position = 0;
        const advance = async () => {
            if (!this.#playing || generation !== this.#playGeneration || this.#disposed || this.element.hidden) return;
            try {
                const step = nextCineFrame(this.#model.cine, position); await this.#setFrame(step.frameIndex);
                if (!this.#playing || generation !== this.#playGeneration) return;
                position = step.nextSequenceIndex;
                if (step.durationMs === 0) { this.pause(); return; }
                this.#timer = setTimeout(advance, Math.max(1, step.durationMs));
            } catch (error) { if (generation === this.#playGeneration) { this.pause(); this.#report(sanitized(error)); } }
        };
        this.#notify(); void advance(); return this.getState();
    }
    pause() { const playing = this.#playing; this.#playing = false; this.#playGeneration++; if (playing) this.#running?.abort(); if (this.#timer != null) clearTimeout(this.#timer); this.#timer = null; if (!this.#disposed) this.#notify(); }
    probe(column, row) {
        const model = this.#model;
        if (!model || !this.#output || !Number.isInteger(column) || !Number.isInteger(row) || column < 0 || row < 0 || column >= model.columns || row >= model.rows) return null;
        const index = row * model.columns + column;
        if (model.kind === 'dose') return { kind: 'dose', column, row, frameIndex: this.#frameIndex, stored: model.numeric.storedAt(column, row, this.#frameIndex),
            value: this.#output.values[index], units: model.units, patientLpsMm: model.numeric.gridToPatient({ column, row, frameIndex: this.#frameIndex }) };
        // One selected original plane is admitted with the output. Probes do
        // not allocate a complete frame copy on every pointer event.
        const stored = this.#output.originalStored[index];
        return { kind: 'xa-subtraction', column, row, frameIndex: this.#frameIndex, stored, value: this.#output.values[index], units: model.units,
            relationship: model.numeric.metadata.relationship, relationshipSign: model.numeric.metadata.relationshipSign };
    }
    exportReport() {
        this.#ensure(); if (!this.#model) fail('open a specialty object before exporting a report');
        const model = this.#model;
        const report = { schema: 'easi-view.specialty-report', version: 1, profile: model.kind, researchOnly: true,
            readProvenance: 'explicit-local-file-EASI-JS-1.0.0', sourceReferences: model.sourceRefs.map(ref => ({ ...ref })), originalFrameIndex: this.#frameIndex,
            units: model.units ?? null, display: this.#options?.window ? { window: { ...this.#options.window }, voiFunction: 'LINEAR_EXACT', provenance: 'explicit-research-preset-or-manual' } : null,
            processing: model.kind === 'dose' ? { scaling: model.numeric.geometry.scaling, doseType: 'PHYSICAL', units: model.units, originalPlaneOffsetMm: model.numeric.geometry.offsetsMm[this.#frameIndex] } :
                model.kind === 'xa' ? { operation: 'contrast-average-minus-mask-average', maskOriginalFrameIndices: [...model.numeric.metadata.maskFrameIndices],
                    contrastFrameAveraging: model.numeric.metadata.contrastFrameAveraging, shift: [0, 0], relationship: model.numeric.metadata.relationship, relationshipSign: model.numeric.metadata.relationshipSign } : null,
            cine: model.cine ? { timing: model.cine.timing, startFrameIndex: model.cine.startFrameIndex, stopFrameIndex: model.cine.stopFrameIndex,
                sequencing: model.cine.sequencing, sequence: [...model.cine.sequence], durationsMs: [...model.cine.durationsMs], closurePolicy: model.cine.closurePolicy, physiologicalPhase: null } : null,
            breastLayout: model.layout ?? null, slideIndex: model.slide ? { metadata: model.slide.metadata, selectedRegion: model.region, tiles: model.tiles, pointPixel: model.slidePixel ?? null, preview: 'index-only' } : null };
        const result = JSON.stringify(report, null, 2); if (new TextEncoder().encode(result).byteLength > MAX_REPORT_BYTES) fail('report exceeds1MiB'); return result;
    }
    close() {
        this.pause(); ++this.#generation; this.#running?.abort(); this.element.hidden = true;
        const closingController = this.#running;
        for (const [child, inert] of this.#inert) child.inert = inert; this.#inert.clear(); this.#focus?.focus?.(); this.#focus = null;
        const done = this.#queue.catch(() => {}).then(() => {
            this.#model?.numeric?.dispose(); this.#model = null; this.#output = null; this.#options = this.#desired = null; this.#pendingBytes = 0;
            // A new open can already own the next queued operation. Its local
            // stream has not started yet; retain its cancellation controller.
            if (this.#running === closingController) this.#running = null;
            this.#canvas.width = this.#canvas.height = 0; this.#controls.description.textContent = ''; this.#controls.probe.textContent = ''; this.#controls.details.textContent = ''; this.#error = false; this.#notify();
        });
        this.#queue = done; return done.then(() => this.getState());
    }
    async dispose() {
        if (this.#disposed) return; await this.close(); this.#disposed = true;
        for (const [element, type, listener] of this.#listeners) element.removeEventListener?.(type, listener); this.#listeners = [];
        this.element.remove(); this.onChange = this.onError = null; this.root = null;
    }
    #sync() {
        const model = this.#model;
        this.#controls.frame.min = '0'; this.#controls.frame.max = String(Math.max(0, (model?.frameCount ?? 1) - 1)); this.#controls.frame.value = String(this.#frameIndex);
        this.#controls.center.value = String(this.#options?.window?.center ?? 0); this.#controls.width.value = String(this.#options?.window?.width ?? 1);
    }
    #describe() {
        const model = this.#model; let description = '';
        if (model.kind === 'xa') description = this.#output ? `AVG_SUB · contrast average minus mask average · ${model.units} · zero shift only. Window is an explicit research display transfer.` : 'Cine timeline frame outside the declared AVG_SUB range · no subtraction preview is available for this frame.';
        if (model.kind === 'dose') description = `PHYSICAL ${model.units} · original native${model.numeric.geometry.bitsAllocated} values × Dose Grid Scaling · nonuniform offsets retained · no plan, DVH or inferred registration.`;
        if (model.kind === 'cine') description = `Cine plan only · original frame ${this.#frameIndex + 1}/${model.frameCount} · ${model.cine.sequencing} · ${model.cine.timing} · no pixel or ECG preview.`;
        if (model.kind === 'breast') description = model.layout.slots.map(slot => `${slot.key}: ${slot.status}${slot.status === 'ambiguous' ? ` (${slot.candidates.length} candidates)` : ''}`).join(' · ') + ' · source orientation unchanged; no automatic flips.';
        if (model.kind === 'slide') description = `WSI index only · ${model.slide.metadata.tileGridColumns}×${model.slide.metadata.tileGridRows} tiles · ${model.tiles.length} selected tile references · column-first order · X/Y mm, Z µm. No tile pixels are loaded.`;
        this.#controls.description.textContent = description; this.#canvas.hidden = !this.#output;
        this.#controls.slide.hidden = model.kind !== 'slide'; this.#controls.manualRate.disabled = !model.cineSet;
        if (model.kind === 'slide') this.#controls.details.textContent = `Selected original tile frame ${this.#frameIndex + 1}: column ${model.slide.tileDescriptor(this.#frameIndex).column}, row ${model.slide.tileDescriptor(this.#frameIndex).row}\n` + model.tiles.map(tile => `Frame ${tile.frameNumber}: column ${tile.column}, row ${tile.row}, valid ${tile.columns}×${tile.rows}`).join('\n') +
            (model.slidePixel ? `\nSlide point → center-index column ${model.slidePixel.column}, row ${model.slidePixel.row}` : '');
        else if (model.kind === 'breast') this.#controls.details.textContent = model.layout.slots.map(slot => `${slot.key}: ${slot.status}; ${slot.candidates.map(ref => `SOP ${ref.sopUid}, frame ${ref.originalFrameIndex + 1}`).join('; ') || 'no candidate'}`).join('\n');
        else if (model.cine) this.#controls.details.textContent = `Trim: original frames ${model.cine.startFrameIndex + 1}–${model.cine.stopFrameIndex + 1}; ${model.cine.sequencing}; ${model.cine.timing}; no inferred physiological phase.`;
        else this.#controls.details.textContent = '';
    }
    #build() {
        const document = this.root.ownerDocument;
        const node = (tag, className = '', value = '') => { const result = document.createElement(tag); result.className = className; result.textContent = value; return result; };
        const listen = (element, type, callback) => { element.addEventListener(type, callback); this.#listeners.push([element, type, callback]); };
        const invoke = callback => { try { Promise.resolve(callback()).catch(error => this.#report(sanitized(error))); } catch (error) { this.#report(sanitized(error)); } };
        const dialog = node('section', 'specialty-workspace'); dialog.hidden = true; dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', 'Specialty research workspace');
        const header = node('header', 'specialty-header'), title = node('h2', '', 'Specialty research workspace'), close = node('button', '', 'Close'); close.type = 'button';
        header.append(title, close); dialog.append(header); this.#controls.close = close; listen(close, 'click', () => invoke(() => this.close()));
        dialog.append(node('p', 'specialty-note', 'LOCAL RESEARCH · explicit supported profiles · no uploads · original images unchanged'));
        const status = node('p', 'specialty-status'), error = node('p', 'specialty-error'), description = node('p', 'specialty-description'), controls = node('div', 'specialty-controls');
        error.hidden = true; error.setAttribute('role', 'alert'); dialog.append(status, error, description); Object.assign(this.#controls, { status, error, description });
        const input = node('input'); input.type = 'file'; input.multiple = true;
        const fileLabel = node('label', '', 'Open local specialty files'); fileLabel.append(input); controls.append(fileLabel);
        listen(input, 'change', () => { const files = [...(input.files ?? [])]; input.value = ''; if (files.length) invoke(() => this.openFiles(files)); });
        const field = (label, key, value, type = 'number') => { const labelNode = node('label', 'specialty-field', label), control = node('input'); control.type = type; control.value = String(value); control.step = 'any'; labelNode.append(control); controls.append(labelNode); this.#controls[key] = control; return control; };
        const frame = field('Original frame index (zero-based)', 'frame', 0, 'range'); frame.step = '1'; listen(frame, 'change', () => invoke(() => this.setFrame(Number(frame.value))));
        const play = node('button', '', 'Play cine'); play.type = 'button'; controls.append(play); this.#controls.play = play; listen(play, 'click', () => invoke(() => this.#playing ? this.pause() : this.play()));
        const center = field('Explicit display center', 'center', 0), width = field('Explicit display width', 'width', 512);
        for (const control of [center, width]) listen(control, 'change', () => invoke(() => this.configure({ window: { center: Number(center.value), width: Number(width.value) } })));
        const rate = field('Manual playback rate (fps)', 'manualRate', 25); listen(rate, 'change', () => invoke(() => this.configure({ manualRateFps: Number(rate.value) })));
        dialog.append(controls);
        // The element itself has the physically calibrated display ratio. Its
        // bitmap must fill that element; contain would reapply the intrinsic
        // columns/rows ratio and introduce incorrect anisotropic letterboxing.
        const canvas = node('canvas', 'specialty-canvas'); canvas.width = canvas.height = 0; canvas.style.objectFit = 'fill'; canvas.style.objectPosition = 'center'; canvas.setAttribute('aria-label', 'Quantitative specialty preview');
        const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas2D is required for the specialty workspace.'); this.#canvas = canvas; this.#context = context;
        const display = node('div', 'specialty-display'); display.append(canvas);
        const probe = node('output', 'specialty-probe'), details = node('pre', 'specialty-details'); this.#controls.probe = probe; this.#controls.details = details; dialog.append(display, probe, details);
        listen(canvas, 'pointermove', event => {
            const model = this.#model; if (!model?.rows) return;
            const point = specialtyCanvasPoint(canvas.getBoundingClientRect(), { columns: model.columns, rows: model.rows, pixelAspect: model.pixelAspect ?? 1 }, event.clientX, event.clientY);
            const result = point ? this.probe(point.column, point.row) : null;
            probe.textContent = result ? `Original frame ${result.frameIndex + 1} · stored ${result.stored} · ${result.value} ${result.units}${result.patientLpsMm ? ` · LPS [${result.patientLpsMm.map(value => value.toFixed(3)).join(', ')}] mm` : ''}` : '';
        });
        const slide = node('div', 'specialty-slide-controls'); this.#controls.slide = slide;
        const region = node('textarea'); region.rows = 3; region.value = '{"column":0,"row":0,"width":256,"height":256}'; region.setAttribute('aria-label', 'Visible tile region in pixel edges');
        const point = node('textarea'); point.rows = 2; point.placeholder = '{"xMm":10,"yMm":20,"zUm":300}'; point.setAttribute('aria-label', 'Slide coordinate point with explicit units');
        const apply = node('button', '', 'Explore tile region / coordinates'); apply.type = 'button'; slide.append(node('p', '', 'Metadata index only · bounded tile references'), region, point, apply); dialog.append(slide);
        listen(apply, 'click', () => invoke(() => this.configure({ slideRegion: JSON.parse(region.value), ...(point.value.trim() ? { slidePoint: JSON.parse(point.value) } : {}) })));
        listen(dialog, 'keydown', event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); invoke(() => this.close()); }
            if (event.key === 'Tab') {
                const visible = element => { let current = element; while (current && current !== dialog) { if (current.hidden) return false; current = current.parentNode; } return true; };
                const items = [...dialog.querySelectorAll('button,input,textarea')].filter(element => !element.disabled && visible(element));
                const active = this.root.getRootNode?.().activeElement ?? document.activeElement;
                if (event.shiftKey && active === items[0]) { event.preventDefault(); items.at(-1)?.focus?.(); }
                else if (!event.shiftKey && active === items.at(-1)) { event.preventDefault(); items[0]?.focus?.(); }
            }
        });
        return dialog;
    }
}
