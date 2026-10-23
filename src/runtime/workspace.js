import { FrameCache } from './frame-cache.js';
import { EncodedInstanceCache, ScopedEncodedCache, DEFAULT_ENCODED_CACHE_BYTES } from './encoded-cache.js';
import { NativeDecoder } from './native-decoder.js';
import { ScopedDecoder } from './scoped-decoder.js';
import { validatedPetDimensionValues } from '../data/classic-dimensions.js';

const LAYOUTS = new Set([1, 2, 4]);
const cancellation = () => new DOMException('The viewport request was canceled.', 'AbortError');
const check = signal => { if (signal?.aborted) throw cancellation(); };
function isolate(callback, ...args) {
    try { const result = callback?.(...args); if (result?.then) Promise.resolve(result).catch(() => {}); } catch {}
}
function buffers(frame) {
    return new Set([frame?.samples, frame?.modalityLut?.entries, frame?.voiLut?.entries,
        frame?.palette?.red, frame?.palette?.green, frame?.palette?.blue].filter(ArrayBuffer.isView).map(value => value.buffer));
}
function bufferBytes(values) { return [...values].reduce((sum, value) => sum + value.byteLength, 0); }

// Source sessions keep their existing cache API, while clear() is confined to
// this session's scope. A source teardown cannot clear another viewport's data.
class ScopedCache {
    constructor(cache, prefix) { this.cache = cache; this.prefix = prefix; this.keys = new Set(); }
    key(key) { return `${this.prefix}|${key}`; }
    get(key) { return this.cache.get(this.key(key)); }
    set(key, frame) { this.keys.add(key); return this.cache.set(this.key(key), frame); }
    delete(key) { this.keys.delete(key); this.cache.delete(this.key(key)); }
    clear() { for (const key of this.keys) this.cache.delete(this.key(key)); this.keys.clear(); }
    get budget() { return this.cache.budget; }
    get bytes() {
        const seen = new Set();
        let total = 0;
        for (const [key, entry] of this.cache.entries) for (const buffer of entry.buffers) {
            if (!seen.has(buffer)) { seen.add(buffer); if (key.startsWith(`${this.prefix}|`)) total += buffer.byteLength; }
        }
        return total;
    }
}

export class SourceLease {
    constructor(workspace, series, owned) {
        this.workspace = workspace; this.series = series; this.owned = owned;
        this.references = 1; this.registered = true; this.released = false;
    }
    retain() { this.workspace.ensureActive(); if (this.released) throw new Error('This source lease has been released.'); this.references++; return this; }
    release() {
        if (this.released) return;
        if (--this.references > 0) return;
        this.released = true;
        this.workspace._releaseLease(this);
    }
}

const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
const subtract = (a, b) => a.map((value, index) => value - b[index]);
function geometry(frame) {
    const uid = frame?.frameOfReferenceUid ?? frame?.dimensions?.frameOfReferenceUid;
    const o = frame?.orientation, p = frame?.position, spacing = frame?.pixelSpacing;
    if (typeof uid !== 'string' || uid.length > 64 || !/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))+$/u.test(uid) || !Array.isArray(o) || o.length !== 6 || !o.every(Number.isFinite) ||
        !Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite) || !Array.isArray(spacing) || spacing.length !== 2 ||
        !spacing.every(value => Number.isFinite(value) && value > 0)) return null;
    const row = o.slice(0, 3), column = o.slice(3);
    if (Math.abs(Math.hypot(...row) - 1) > 0.001 || Math.abs(Math.hypot(...column) - 1) > 0.001 || Math.abs(dot(row, column)) > 0.001) return null;
    const cross = [row[1] * column[2] - row[2] * column[1], row[2] * column[0] - row[0] * column[2], row[0] * column[1] - row[1] * column[0]];
    const normal = cross.map(value => value / Math.hypot(...cross));
    return { uid, row, column, normal, position: p, spacing };
}
function family(frame) {
    const d = frame?.dimensions ?? frame?.classicDimensions ?? frame?.syncDimensions ?? {};
    if (d.invalid || d.spatialEligible === false || d.indices?.some(index => !index.known || !index.resolved)) return null;
    let petValues;
    try { petValues = validatedPetDimensionValues(d); } catch { return null; }
    if (petValues && (frame.modality !== 'PT' || frame.unit !== d.petUnits || d.petSeriesType[1] !== 'IMAGE')) return null;
    return JSON.stringify([d.semanticScope === 'same-series-only' ? frame.seriesUid ?? null : null, d.imageType ?? d.frameType ?? null, d.acquisitionNumber ?? null, d.temporalPositionIndex ?? null, d.temporalPositionTimeOffset ?? null,
        d.effectiveEchoTime ?? null, d.echoNumbers ?? d.echoNumber ?? null, d.diffusionBValue ?? null,
        d.diffusionDirection ?? null, d.complexImageComponent ?? null, d.acquisitionContrast ?? null,
        d.indices?.filter(index => !index.spatial && !['00209056'].includes(index.indexPointer))
            .map(index => [index.organizationUid, index.indexPointer, index.ordinal]) ?? [], ...(petValues ? [petValues] : [])]);
}
function compatibleGeometry(first, second) {
    const a = geometry(first), b = geometry(second);
    if (!a || !b) return { matched: false, reason: 'missing-patient-geometry' };
    if (a.uid !== b.uid) return { matched: false, reason: 'frame-of-reference-mismatch' };
    if (Math.abs(dot(a.normal, b.normal)) < 0.9999) return { matched: false, reason: 'nonparallel-planes' };
    if (family(first) == null || family(first) !== family(second)) return { matched: false, reason: 'temporal-or-echo-family-mismatch' };
    return { matched: true, a, b };
}

export function frameWorldCenter(frame) {
    const g = geometry(frame);
    if (!g || !Number.isInteger(frame.columns) || !Number.isInteger(frame.rows)) return null;
    return g.position.map((value, index) => value + g.row[index] * (frame.columns - 1) / 2 * g.spacing[1] + g.column[index] * (frame.rows - 1) / 2 * g.spacing[0]);
}

/** Nearest unique patient plane, within an explicit millimetre tolerance. */
export function nearestSyncedSlice(frame, candidates, toleranceMm = 1) {
    if (!Number.isFinite(toleranceMm) || toleranceMm < 0) throw new Error('Invalid slice synchronization tolerance.');
    const point = frameWorldCenter(frame);
    if (!point) return { matched: false, reason: 'missing-patient-geometry' };
    let best = null, tied = false, reason = 'no-compatible-slice';
    candidates.forEach((candidate, index) => {
        const pair = compatibleGeometry(frame, candidate);
        if (!pair.matched) { reason = pair.reason; return; }
        const distanceMm = Math.abs(dot(subtract(point, pair.b.position), pair.b.normal));
        if (distanceMm > toleranceMm) { reason = 'outside-slice-tolerance'; return; }
        if (!best || distanceMm < best.distanceMm - 0.000001) { best = { matched: true, index, distanceMm }; tied = false; }
        else if (Math.abs(distanceMm - best.distanceMm) <= 0.000001) tied = true;
    });
    return tied ? { matched: false, reason: 'ambiguous-nearest-slice' } : best ?? { matched: false, reason };
}

function sameTable(first, second) {
    if (!first || !second) return first === second;
    return !first.pending && !second.pending && ['count', 'firstMapped', 'bits'].every(key => first[key] === second[key]) &&
        first.entries?.length === second.entries?.length && first.entries?.every((value, index) => value === second.entries[index]);
}
export function compatibleWindow(first, second) {
    if (!['MONOCHROME1', 'MONOCHROME2'].includes(first?.photometric) || !['MONOCHROME1', 'MONOCHROME2'].includes(second?.photometric)) return false;
    if (!first.modality || first.modality !== second.modality) return false;
    const sameSeries = typeof first.seriesUid === 'string' && first.seriesUid === second.seriesUid && /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))+$/u.test(first.seriesUid);
    if (!(first.unit?.trim() && second.unit?.trim()) && !sameSeries) return false;
    return family(first) != null && family(first) === family(second) && (first.unit ?? '') === (second.unit ?? '') &&
        (first.slope ?? 1) === (second.slope ?? 1) && (first.intercept ?? 0) === (second.intercept ?? 0) &&
        (first.voiFunction ?? 'LINEAR') === (second.voiFunction ?? 'LINEAR') &&
        Boolean(first.presentationInvert) === Boolean(second.presentationInvert) && sameTable(first.modalityLut, second.modalityLut) && sameTable(first.voiLut, second.voiLut);
}

export function patientCamera(frame, target, camera, toleranceMm = 1) {
    const pair = compatibleGeometry(frame, target);
    if (!pair.matched) return pair;
    if (!camera || !Array.isArray(camera.center) || camera.center.length !== 3 || !camera.center.every(Number.isFinite) ||
        !Number.isFinite(camera.pixelsPerMm) || camera.pixelsPerMm <= 0) throw new Error('Invalid patient-coordinate camera.');
    const delta = subtract(camera.center, pair.b.position), distance = dot(delta, pair.b.normal);
    if (Math.abs(distance) > toleranceMm) return { matched: false, reason: 'outside-slice-tolerance' };
    const column = dot(delta, pair.b.row) / pair.b.spacing[1], row = dot(delta, pair.b.column) / pair.b.spacing[0];
    if (column < -0.5 || column > target.columns - 0.5 || row < -0.5 || row > target.rows - 0.5) return { matched: false, reason: 'outside-field-of-view' };
    return { matched: true, camera: { center: camera.center.map((value, index) => value - pair.b.normal[index] * distance), pixelsPerMm: camera.pixelsPerMm } };
}

export class ViewportSession {
    constructor(workspace, index) {
        this.workspace = workspace; this.index = index; this.lease = null; this.series = null;
        this.frameIndex = null; this.frame = null; this.controller = null; this.generation = 0;
        this.window = null; this.camera = null; this.disposed = false;
    }
    async assignSeries(source, seriesId, { index = 0, signal, onMeasure, onFrame } = {}) {
        this.workspace.ensureActive();
        const lease = this.workspace.registerSource(source);
        const series = lease.series.find(series => series.id === seriesId);
        if (!series || series.disposed) throw new Error('Select an available workspace series.');
        if (!Number.isInteger(index) || index < 0 || index >= series.frames.length) throw new Error('Select an available workspace frame.');
        check(signal);
        this.cancel();
        if (this.lease !== lease) { lease.retain(); this.lease?.release(); this.lease = lease; }
        this.series = series; this.frame = null; this.frameIndex = null; this.window = null; this.camera = null;
        this.workspace.emit('assignmentchange', { slot: this.index, seriesId });
        return this.requestFrame(index, { signal, onMeasure, onFrame });
    }
    cancel() { this.generation++; this.controller?.abort(); this.controller = null; }
    async requestFrame(index, { signal, onMeasure, onFrame } = {}) {
        this.workspace.ensureActive();
        if (this.disposed || !this.series || !Number.isInteger(index) || index < 0 || index >= this.series.frames.length) throw new Error('Select an available workspace frame.');
        check(signal);
        this.cancel();
        const generation = this.generation, series = this.series, controller = new AbortController();
        this.controller = controller;
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        try {
            const frame = await this.workspace.request(series, index, controller.signal, onMeasure);
            check(controller.signal);
            if (this.disposed || this.workspace.disposed || generation !== this.generation || series !== this.series) throw cancellation();
            this.workspace.admitFrame(this, frame);
            // A renderer can validate and submit this frame synchronously before
            // the model publishes it. Cancellation cannot interleave the commit.
            if (onFrame) {
                try { onFrame(frame); }
                catch (error) {
                    for (const [key, entry] of [...this.workspace.cache.entries]) if (entry.frame === frame && frame !== this.frame) this.workspace.cache.delete(key);
                    throw error;
                }
            }
            this.frame = frame; this.frameIndex = index;
            this.workspace.emit('framechange', { slot: this.index, index, frame });
            return frame;
        } catch (error) {
            if (error.name !== 'AbortError' && !this.disposed && generation === this.generation) this.workspace.emit('error', { slot: this.index, message: 'The workspace frame could not be displayed.' });
            throw error;
        } finally {
            signal?.removeEventListener('abort', abort);
            if (this.controller === controller) this.controller = null;
        }
    }
    clear() { this.cancel(); this.lease?.release(); this.lease = null; this.series = null; this.frame = null; this.frameIndex = null; this.window = null; this.camera = null; }
    dispose() { if (this.disposed) return; this.clear(); this.disposed = true; }
}

/** Independent state/ownership layer; renderers and application chrome stay outside. */
export class WorkspaceModel {
    constructor({ layout = 1, cacheBudget = 64 * 1024 * 1024, encodedCacheBudget = DEFAULT_ENCODED_CACHE_BYTES, onEvent } = {}) {
        if (!LAYOUTS.has(layout)) throw new Error('Workspace layout must have 1, 2 or 4 viewports.');
        this.encodedCache = new EncodedInstanceCache(encodedCacheBudget);
        this.encodedScopes = new Map();
        this.decoder = new NativeDecoder(); this.decoderScopes = new Map();
        this.cache = new FrameCache(cacheBudget); this.onEvent = onEvent; this.activeSlot = 0; this.disposed = false;
        this.slots = Array.from({ length: layout }, (_, index) => new ViewportSession(this, index));
        this.sources = new Map(); this.leases = new Set(); this.seriesOwners = new Map(); this.scopes = new Map();
        this.queue = []; this.activeRequest = null; this.nextScope = 1; this.heldFrames = [];
        this.prefetchController = null; this.prefetchGeneration = 0;
    }
    ensureActive() { if (this.disposed) throw new Error('This workspace has been disposed.'); }
    emit(type, detail) { if (!this.disposed || type === 'dispose') isolate(this.onEvent, type, detail); }
    setLayout(layout) {
        this.ensureActive(); if (!LAYOUTS.has(layout)) throw new Error('Workspace layout must have 1, 2 or 4 viewports.');
        this.cancelPrefetch();
        while (this.slots.length > layout) this.slots.pop().dispose();
        while (this.slots.length < layout) this.slots.push(new ViewportSession(this, this.slots.length));
        this.activeSlot = Math.min(this.activeSlot, layout - 1); this.emit('layoutchange', { layout, activeSlot: this.activeSlot });
    }
    setActiveSlot(index) {
        this.ensureActive(); if (!Number.isInteger(index) || !this.slots[index]) throw new Error('Select an available viewport.');
        this.activeSlot = index; this.emit('activechange', { slot: index });
    }
    registerSource(source, { owned = true } = {}) {
        this.ensureActive();
        if (source instanceof SourceLease) { if (source.workspace !== this || source.released) throw new Error('Invalid source lease.'); return source; }
        if (this.sources.has(source)) return this.sources.get(source);
        const series = Array.isArray(source) ? source : source?.series;
        if (!Array.isArray(series) || !series.length || series.some(value => !value || typeof value.getFrame !== 'function' || !Array.isArray(value.frames) || value.disposed) || typeof owned !== 'boolean') throw new Error('A workspace source must contain available series.');
        if (series.some(value => value._session?.decoder instanceof ScopedDecoder && value._session.decoder.decoder !== this.decoder)) throw new Error('This decoder session already belongs to another workspace.');
        if (series.some(value => value._session?.decoder && !(value._session.decoder instanceof ScopedDecoder) && (value._session.decoder.active || value._session.decoder.queue?.length))) throw new Error('Finish the active source decode before assigning it to a workspace.');
        if (series.some(value => value._session?.encoded instanceof ScopedEncodedCache && value._session.encoded.cache !== this.encodedCache)) throw new Error('This archive session already belongs to another workspace.');
        if (series.some(value => value._session?.cache instanceof ScopedCache && value._session.cache.cache !== this.cache)) throw new Error('This source session already belongs to another workspace.');
        const lease = new SourceLease(this, [...new Set(series)], owned);
        this.sources.set(source, lease); this.leases.add(lease);
        for (const value of lease.series) {
            if (!this.seriesOwners.has(value)) this.seriesOwners.set(value, { leases: new Set(), dispose: false });
            this.seriesOwners.get(value).leases.add(lease);
            const session = value._session;
            if (session?.decoder && !this.decoderScopes.has(session)) {
                session.decoder.dispose();
                const facade = new ScopedDecoder(this.decoder); session.decoder = facade; this.decoderScopes.set(session, facade);
            }
            if (session?.encoded && !this.encodedScopes.has(session)) {
                const original = session.encoded, facade = new ScopedEncodedCache(this.encodedCache, `archive-${this.nextScope++}`);
                // Transfer ownership before any eviction; clear() would destroy indexes.
                const records = original.takeEntries();
                session.encoded = facade; this.encodedScopes.set(session, facade);
                for (const [key, record] of records) facade.set(key, record);
            }
            if (session?.cache && !this.scopes.has(session)) {
                const original = session.cache, facade = new ScopedCache(this.cache, `source-${this.nextScope++}`);
                for (const [key, entry] of original.entries ?? []) facade.set(key, entry.frame ?? entry);
                original.clear(); session.cache = facade; this.scopes.set(session, facade);
            }
        }
        return lease;
    }
    releaseSource(source) {
        const lease = source instanceof SourceLease ? source : this.sources.get(source);
        if (!lease || !lease.registered) return;
        this.cancelPrefetch();
        lease.registered = false;
        for (const [key, value] of this.sources) if (value === lease) this.sources.delete(key);
        lease.release();
    }
    _releaseLease(lease) {
        this.leases.delete(lease);
        for (const [key, value] of this.sources) if (value === lease) this.sources.delete(key);
        for (const series of lease.series) {
            const entry = this.seriesOwners.get(series);
            if (!entry) continue;
            entry.leases.delete(lease); entry.dispose ||= lease.owned;
            if (!entry.leases.size) {
                this.seriesOwners.delete(series);
                if (entry.dispose) series.dispose?.();
                const session = series._session;
                if (session && ![...this.seriesOwners.keys()].some(other => other._session === session)) {
                    this.decoderScopes.get(session)?.dispose(); this.decoderScopes.delete(session);
                    if (!session.disposed && session.series?.size && session.decoder instanceof ScopedDecoder) session.decoder = new NativeDecoder();
                    this.scopes.get(session)?.clear(); this.scopes.delete(session);
                    this.encodedScopes.get(session)?.clear(); this.encodedScopes.delete(session);
                    if (!session.disposed && session.encoded instanceof ScopedEncodedCache) session.encoded = new EncodedInstanceCache(this.encodedCache.budget);
                    // A borrowed source stays usable, with an empty independent cache.
                    if (!session.disposed && session.cache instanceof ScopedCache) session.cache = new FrameCache(this.cache.budget);
                }
            }
        }
    }
    assignSeries(source, seriesId, { slot = this.activeSlot, index = 0 } = {}) {
        this.ensureActive(); if (!this.slots[slot]) return Promise.reject(new Error('Select an available viewport.'));
        return this.slots[slot].assignSeries(source, seriesId, { index });
    }
    request(series, index, signal, onMeasure, priority = 'foreground') {
        if (priority === 'foreground') this.cancelPrefetch();
        return new Promise((resolve, reject) => {
            const job = { series, index, signal, onMeasure, resolve, reject, priority };
            job.abort = () => {
                const queued = this.queue.indexOf(job);
                if (queued >= 0) { this.queue.splice(queued, 1); signal.removeEventListener('abort', job.abort); reject(cancellation()); }
                else if (this.activeRequest === job) reject(cancellation());
            };
            signal.addEventListener('abort', job.abort, { once: true });
            if (priority === 'foreground') {
                const background = this.queue.findIndex(value => value.priority === 'background');
                if (background < 0) this.queue.push(job); else this.queue.splice(background, 0, job);
            } else this.queue.push(job);
            this.pump();
        });
    }
    cancelPrefetch() { this.prefetchGeneration++; this.prefetchController?.abort(); this.prefetchController = null; }

    /** Explicit, delayed, at-most-two adjacent decodes; never assigns a viewport. */
    async prefetchNeighbors(slot = this.activeSlot, { neighbors = 2, delayMs = 150, signal, onMeasure } = {}) {
        this.ensureActive();
        if (!this.slots[slot]?.frame || ![1, 2].includes(neighbors) || !Number.isFinite(delayMs) || delayMs < 0 || delayMs > 10000 ||
            signal != null && !(signal instanceof AbortSignal) || onMeasure != null && typeof onMeasure !== 'function') {
            throw new TypeError('Prefetch requires a displayed pane, one or two neighbors, and a delay from 0 to 10000 ms.');
        }
        check(signal); this.cancelPrefetch();
        const controller = new AbortController(), generation = this.prefetchGeneration;
        this.prefetchController = controller;
        const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
        const selected = this.slots[slot], series = selected.series, frame = selected.frame;
        const indices = [selected.frameIndex + 1, selected.frameIndex - 1].filter(index => index >= 0 && index < series.frames.length).slice(0, neighbors);
        const result = { requested: indices.length, completed: 0, canceled: false };
        try {
            await new Promise(resolve => {
                let timer;
                const finish = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', finish); resolve(); };
                controller.signal.addEventListener('abort', finish, { once: true });
                timer = setTimeout(finish, delayMs);
                if (controller.signal.aborted) finish();
            });
            check(controller.signal);
            for (const index of indices) {
                if (this.disposed || generation !== this.prefetchGeneration || selected.series !== series || selected.frame !== frame || series.disposed) throw cancellation();
                // Explicit null avoids a source's default foreground observer.
                const decoded = await this.request(series, index, controller.signal, onMeasure ?? null, 'background');
                check(controller.signal);
                if (this.disposed || generation !== this.prefetchGeneration) throw cancellation();
                this.admitFrame(null, decoded); result.completed++;
            }
            return result;
        } catch (error) {
            if (error.name !== 'AbortError') throw new Error('The adjacent frame could not be prefetched within this workspace profile or budget.');
            result.canceled = true; return result;
        } finally {
            signal?.removeEventListener('abort', abort);
            if (this.prefetchController === controller) this.prefetchController = null;
        }
    }
    pump() {
        if (this.disposed || this.activeRequest || !this.queue.length) return;
        const job = this.queue.shift(); this.activeRequest = job;
        Promise.resolve().then(() => { check(job.signal); return job.series.getFrame(job.index, { signal: job.signal, onMeasure: job.onMeasure }); })
            .then(frame => { check(job.signal); job.resolve(frame); }, job.reject).catch(job.reject)
            .finally(() => { job.signal.removeEventListener('abort', job.abort); this.activeRequest = null; this.pump(); });
    }
    admitFrame(slot, frame) {
        const held = new Set(buffers(frame));
        for (const other of this.slots) if (other !== slot) for (const buffer of buffers(other.frame)) held.add(buffer);
        for (const previous of this.heldFrames) for (const buffer of buffers(previous)) held.add(buffer);
        if (bufferBytes(held) > this.cache.budget) {
            for (const [key, entry] of this.cache.entries) if (entry.frame === frame) this.cache.delete(key);
            throw new Error('The displayed workspace frames exceed the decoded byte budget.');
        }
        // Evict cached, undisplayed buffers until the aggregate retained set fits.
        const retained = () => new Set([...held, ...this.cache.buffers.keys()]);
        for (const [key, entry] of [...this.cache.entries]) {
            if (bufferBytes(retained()) <= this.cache.budget) break;
            if (![...entry.buffers].every(buffer => held.has(buffer))) this.cache.delete(key);
        }
    }
    async synchronize(slot = this.activeSlot, { slice = false, window = false, camera = false, toleranceMm = 1, signal, onFrame } = {}) {
        this.ensureActive(); const source = this.slots[slot];
        if (!source?.frame) throw new Error('Display a source viewport before synchronizing.');
        check(signal);
        const frame = source.frame, generation = source.generation;
        const results = [];
        for (const target of this.slots) {
            check(signal);
            if (source.generation !== generation || source.frame !== frame) throw cancellation();
            if (target === source || !target.series) continue;
            const result = { slot: target.index, matched: true };
            if (slice) {
                const nearest = nearestSyncedSlice(frame, target.series.frames, toleranceMm);
                if (!nearest.matched) { results.push({ ...result, ...nearest }); continue; }
                await target.requestFrame(nearest.index, { signal, onFrame: onFrame ? frame => onFrame(target.index, frame, nearest.index) : undefined }); result.index = nearest.index;
                check(signal);
                if (source.generation !== generation || source.frame !== frame) throw cancellation();
            }
            if (window) {
                if (!compatibleWindow(frame, target.frame)) { results.push({ ...result, matched: false, reason: 'presentation-semantics-mismatch' }); continue; }
                target.window = source.window ? { ...source.window } : frame.window ? { ...frame.window } : null;
                result.window = target.window;
            }
            if (camera) {
                if (!source.camera) { results.push({ ...result, matched: false, reason: 'missing-patient-geometry' }); continue; }
                const match = patientCamera(frame, target.frame, source.camera, toleranceMm);
                if (!match.matched) { results.push({ ...result, ...match }); continue; }
                target.camera = match.camera; result.camera = match.camera;
            }
            results.push(result);
        }
        this.emit('syncresult', { slot, results }); return results;
    }
    snapshot() {
        return { disposed: this.disposed, layout: this.slots.length, activeSlot: this.activeSlot, workerCount: this.decoder.worker ? 1 : 0,
            slots: this.slots.map(slot => ({ slot: slot.index, seriesId: slot.series?.id ?? null, frameIndex: slot.frameIndex,
                busy: slot.controller != null, window: slot.window ? { ...slot.window } : null, camera: slot.camera ? structuredClone(slot.camera) : null })),
            encodedCacheBytes: this.encodedCache.bytes, encodedCacheBudget: this.encodedCache.budget,
            decodedBytes: bufferBytes(new Set([...this.cache.buffers.keys(), ...this.slots.flatMap(slot => [...buffers(slot.frame)]), ...this.heldFrames.flatMap(frame => [...buffers(frame)])])), cacheBudget: this.cache.budget };
    }
    dispose() {
        if (this.disposed) return;
        this.cancelPrefetch();
        this.disposed = true; this.decoder.dispose();
        for (const slot of this.slots) slot.dispose();
        for (const lease of [...this.leases]) { lease.registered = false; lease.references = 1; lease.release(); }
        for (const job of this.queue) { job.signal.removeEventListener('abort', job.abort); job.reject(cancellation()); }
        this.queue = []; this.heldFrames = []; this.cache.clear(); this.encodedCache.clear(); this.emit('dispose', { disposed: true }); this.onEvent = null;
    }
}
