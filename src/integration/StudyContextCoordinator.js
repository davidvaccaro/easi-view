import { plain, uid, canceled } from '../enterprise/contracts.js';
import { normalizeStudyContext, selectContextFrame } from './study-context.js';
import { isColorFrame } from '../render/DisplayMath.js';

export const MAX_CONTEXT_STACKS = 128;
export const MAX_CONTEXT_FRAMES = 10000;
export const MAX_CONTEXT_SERIES_PAGE = 25;
export const MAX_CONTEXT_SERIES_ATTEMPTS = 5;
const fail = reason => { throw new Error(`Viewing context could not be prepared: ${reason}.`); };
const liveClient = client => client !== null && typeof client === 'object';
function abortSignal(value) { if (value != null && !(value instanceof AbortSignal)) throw new TypeError('Use an AbortSignal for viewing context preparation.'); }

/**
 * Prepare exact archive references without changing panes. The injected frame
 * broker must lease/admit every returned frame, including rendered rollback
 * frames. The injected commit checks isCurrent before each async UI step and
 * calls accept at its last synchronous guarded point before old-source disposal.
 */
export class StudyContextCoordinator {
    #generation = 0; #operation = null; #disposed = false; #transferred = new WeakSet(); #leases = new Map();
    constructor(options) {
        plain(options, ['getClient', 'getSeries', 'loadSeries', 'listSeries', 'getFrame', 'commit', 'releaseSeries']);
        for (const key of ['getClient', 'getSeries', 'loadSeries', 'listSeries', 'getFrame', 'commit', 'releaseSeries']) if (typeof options[key] !== 'function') throw new TypeError('Provide all viewing context source/commit callbacks.');
        Object.assign(this, options);
    }
    #check(operation) {
        if (operation.failure) throw operation.failure;
        if (this.#disposed || operation.generation !== this.#generation || operation.signal.aborted) throw canceled();
        let current; try { current = this.getClient(); } catch { current = null; }
        if (current !== operation.client) {
            operation.failure = new Error('Viewing context could not be prepared: the configured archive client changed.');
            operation.controller.abort(); throw operation.failure;
        }
    }
    #current(operation) { try { this.#check(operation); return true; } catch { return false; } }
    #release(series) {
        try { Promise.resolve(this.releaseSeries(series)).catch(() => {}); } catch { /* Attempt every owned release even if a host release rejects. */ }
    }
    #claim(series, operation) {
        if (operation.borrowed.has(series) || this.#transferred.has(series)) return;
        operation.owned.add(series);
        if (!this.#leases.has(series)) this.#leases.set(series, new Set()); this.#leases.get(series).add(operation);
    }
    #drop(operation) {
        for (const series of operation.owned) {
            const leases = this.#leases.get(series); leases?.delete(operation);
            if (leases?.size) continue;
            this.#leases.delete(series);
            if (!this.#transferred.has(series) && !operation.released.has(series)) { operation.released.add(series); this.#release(series); }
        }
        operation.owned.clear();
    }
    #lateRelease(value, operation) {
        if (!Array.isArray(value)) return;
        for (const series of new Set(value)) {
            if (!series || typeof series !== 'object' || operation.borrowed.has(series) || this.#transferred.has(series) || this.#leases.get(series)?.size || operation.released.has(series)) continue;
            operation.released.add(series); this.#release(series);
        }
    }
    #await(operation, callback, { ownsSources = false, label = 'archive operation', awaitCleanup = false } = {}) {
        this.#check(operation);
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (callback, value) => { if (settled) return; settled = true; operation.signal.removeEventListener('abort', abort); callback(value); };
            const abort = () => finish(reject, operation.failure ?? canceled());
            // A pane commit owns an asynchronous rollback. Cancel its signal
            // immediately, but keep its sources alive until that cleanup exits.
            if (!awaitCleanup) operation.signal.addEventListener('abort', abort, { once: true });
            Promise.resolve().then(() => { this.#check(operation); return callback(); }).then(value => {
                if (settled) { if (ownsSources) this.#lateRelease(value, operation); return; }
                if (ownsSources && Array.isArray(value)) for (const series of value) if (series && typeof series === 'object') this.#claim(series, operation);
                try { if (!awaitCleanup || !operation.accepted) this.#check(operation); finish(resolve, value); }
                catch (error) { finish(reject, error); }
            }, error => {
                if (settled) return;
                if (!awaitCleanup || !operation.accepted) {
                    try { this.#check(operation); } catch (reason) { finish(reject, reason); return; }
                }
                if (error?.name === 'AbortError') finish(reject, error);
                else { const failure = new Error(`Viewing context could not be prepared: ${label} failed.`); failure.code = label === 'series metadata load' ? 'CONTEXT_LOAD_FAILED' : 'CONTEXT_CALLBACK_FAILED'; finish(reject, failure); }
            });
            if (operation.signal.aborted && !awaitCleanup) abort();
        });
    }
    #validateStack(series, operation, expected = null) {
        if (!series || typeof series !== 'object' || series.disposed === true || series._session?.client !== operation.client ||
            !Array.isArray(series.frames) || !series.frames.length || series.frames.length > MAX_CONTEXT_FRAMES) fail('archive metadata source ownership or frame count is invalid');
        uid(series.studyUid); uid(series.seriesUid);
        if (expected && (series.studyUid !== expected.studyUid || series.seriesUid !== expected.seriesUid)) fail('loaded metadata differs from its exact Study and Series');
        for (const frame of series.frames) {
            if (!frame || typeof frame !== 'object' || !Number.isInteger(frame.frameIndex) || frame.frameIndex < 0 || frame.frameIndex > 4095 ||
                frame.studyUid != null && frame.studyUid !== series.studyUid || frame.seriesUid != null && frame.seriesUid !== series.seriesUid) fail('source frame identity or original index is invalid');
            uid(frame.sopUid);
        }
    }
    #admit(stacks, operation, expected = null) {
        if (!Array.isArray(stacks) || stacks.length > MAX_CONTEXT_STACKS || new Set(stacks).size !== stacks.length) fail('metadata stack list is invalid or duplicated');
        for (const series of stacks) this.#validateStack(series, operation, expected);
        const next = new Set([...operation.stacks, ...stacks]);
        if (next.size > MAX_CONTEXT_STACKS || [...next].reduce((count, series) => count + series.frames.length, 0) > MAX_CONTEXT_FRAMES) fail('combined metadata exceeds128 stacks or10000 frames');
        operation.stacks = next;
    }
    #load(operation, studyUid, seriesUid) {
        const key = `${studyUid}/${seriesUid}`;
        if (!operation.loads.has(key)) operation.loads.set(key, this.#await(operation,
            () => this.loadSeries(operation.client, studyUid, seriesUid, { signal: operation.signal }), { ownsSources: true, label: 'series metadata load' }).then(stacks => {
                this.#admit(stacks, operation, { studyUid, seriesUid }); operation.fresh.set(key, new Set(stacks)); return stacks;
            }));
        return operation.loads.get(key);
    }
    #trySelect(operation, view) {
        const candidates = this.#selectionStacks(operation).filter(stack => stack.studyUid === view.reference.studyUid && (!view.reference.seriesUid || stack.seriesUid === view.reference.seriesUid));
        if (!candidates.length) return null;
        // A cached complete target can be used without a metadata request. An
        // absent target may still exist in a fresh full-series metadata response.
        if (view.originalFrameNumber != null) {
            const matches = candidates.flatMap(series => series.frames.flatMap((frame, index) => frame.sopUid === view.reference.sopUid && frame.frameIndex + 1 === view.originalFrameNumber ? [{ series, index }] : []));
            if (matches.length > 1) fail('original image/frame is ambiguous across stacks');
            return matches[0] ?? null;
        }
        const matches = candidates.filter(series => series.frames[view.frameIndex] && (!view.reference.sopUid || series.frames[view.frameIndex].sopUid === view.reference.sopUid));
        if (!matches.length) return null;
        return selectContextFrame(candidates, view);
    }
    #selectionStacks(operation) {
        return [...operation.stacks].filter(stack => {
            const fresh = operation.fresh.get(`${stack.studyUid}/${stack.seriesUid}`); return fresh == null || fresh.has(stack);
        });
    }
    async #studyCandidates(operation, studyUid) {
        if (!operation.pages.has(studyUid)) operation.pages.set(studyUid, this.#await(operation,
            () => this.listSeries(operation.client, studyUid, { signal: operation.signal, limit: MAX_CONTEXT_SERIES_PAGE }), { label: 'bounded study series query' }).then(page => {
                const items = Array.isArray(page) ? page : page?.items;
                if (!Array.isArray(items) || items.length > MAX_CONTEXT_SERIES_PAGE || !Array.isArray(page) && (page.hasMore != null && typeof page.hasMore !== 'boolean')) fail('bounded series page is invalid');
                const seen = new Set();
                return items.map(item => {
                    if (!item || typeof item !== 'object' || item.studyUid !== studyUid) fail('series page contains a foreign Study');
                    uid(item.seriesUid); if (seen.has(item.seriesUid)) fail('series page contains duplicate Series'); seen.add(item.seriesUid);
                    return item.seriesUid;
                });
            }));
        return operation.pages.get(studyUid);
    }
    async #resolve(operation, view) {
        let selected = this.#trySelect(operation, view); if (selected) return selected;
        const { studyUid, seriesUid } = view.reference;
        if (seriesUid) { await this.#load(operation, studyUid, seriesUid); this.#check(operation); return selectContextFrame(this.#selectionStacks(operation), view); }
        const candidates = await this.#studyCandidates(operation, studyUid); this.#check(operation);
        for (const series of candidates.slice(0, MAX_CONTEXT_SERIES_ATTEMPTS)) {
            this.#check(operation);
            let loaded;
            try { loaded = await this.#load(operation, studyUid, series); }
            catch (error) {
                this.#check(operation);
                // Unsupported series loaders reject before returning owned
                // stacks. Structural/identity/admission failures are fatal.
                if (error.code !== 'CONTEXT_LOAD_FAILED') throw error;
                continue;
            }
            if (!loaded.length) continue;
            selected = this.#trySelect(operation, view); if (selected) return selected;
        }
        fail('no compatible navigation frame within the first5 series attempts');
    }
    #validateFrame(frame, selected, view) {
        const descriptor = selected.series.frames[selected.index];
        if (!frame || frame.sopUid !== descriptor.sopUid || frame.frameIndex !== descriptor.frameIndex ||
            frame.studyUid != null && frame.studyUid !== selected.series.studyUid || frame.seriesUid != null && frame.seriesUid !== selected.series.seriesUid ||
            ['rows', 'columns', 'photometric', 'samplesPerPixel'].some(key => descriptor[key] != null && frame[key] !== descriptor[key])) fail('decoded image identity or profile differs from its source descriptor');
        if (!(frame.samples instanceof Uint8Array || frame.samples instanceof Uint16Array || frame.samples instanceof Int16Array) ||
            !Number.isSafeInteger(frame.rows) || !Number.isSafeInteger(frame.columns) || frame.rows < 1 || frame.columns < 1 || frame.rows > 8192 || frame.columns > 8192 ||
            !['MONOCHROME1', 'MONOCHROME2', 'RGB', 'PALETTE COLOR'].includes(frame.photometric) || frame.rows * frame.columns > 16 * 1024 * 1024 ||
            frame.samples.length !== frame.rows * frame.columns * (frame.photometric === 'RGB' ? 3 : 1)) fail('decoded frame dimensions or stored sample layout are invalid');
        if (view.window && isColorFrame(frame)) fail('a color context cannot request a grayscale window');
    }
    async apply(input, options) {
        if (this.#disposed) throw new Error('The viewing context coordinator is disposed.');
        plain(options, ['archiveKey', 'scope', 'signal']); abortSignal(options.signal); if (options.signal?.aborted) throw canceled();
        const context = normalizeStudyContext(input, options); let client, existing;
        try { client = this.getClient(); existing = this.getSeries(); } catch { fail('configured source callbacks are unavailable'); }
        if (!liveClient(client)) fail('configure an archive before restoring its viewing context');
        if (!Array.isArray(existing) || existing.some(series => !series || typeof series !== 'object') || new Set(existing).size !== existing.length) fail('available source list is invalid');
        this.cancel(); const controller = new AbortController(), operation = { generation: ++this.#generation, controller,
            signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal, client, failure: null, accepted: false,
            borrowed: new Set(existing), owned: new Set(), released: new Set(), stacks: new Set(), loads: new Map(), fresh: new Map(), pages: new Map(), decoded: new Map() };
        this.#operation = operation;
        try {
            this.#admit(existing.filter(series => !series.disposed && series._session?.client === client), operation);
            for (const view of context.viewports) { this.#check(operation); await this.#resolve(operation, view); }
            const assignments = [];
            for (const view of context.viewports) {
                this.#check(operation); const selected = selectContextFrame(this.#selectionStacks(operation), view); this.#check(operation);
                if (!operation.decoded.has(selected.series)) operation.decoded.set(selected.series, new Map());
                const cached = operation.decoded.get(selected.series);
                if (!cached.has(selected.index)) cached.set(selected.index, await this.#await(operation,
                    () => this.getFrame(selected.series, selected.index, { signal: operation.signal }), { label: 'selected frame decode/admission' }));
                const frame = cached.get(selected.index); this.#validateFrame(frame, selected, view); this.#check(operation);
                assignments.push({ slot: view.slot, view, series: selected.series, index: selected.index, frame });
            }
            const newSeries = [...operation.owned];
            const accept = () => {
                this.#check(operation); if (operation.accepted) return;
                // The host calls this at its last synchronous guarded commit
                // point, before disposing rollback sources. A later cancel
                // cannot revoke this already transferred source ownership.
                operation.accepted = true;
                for (const series of operation.owned) {
                    this.#transferred.add(series); this.#leases.get(series)?.delete(operation);
                    if (!this.#leases.get(series)?.size) this.#leases.delete(series);
                }
                operation.owned.clear();
            };
            await this.#await(operation, () => this.commit({ context, assignments, newSeries, client, signal: operation.signal,
                isCurrent: () => this.#current(operation), accept }), { label: 'transactional pane commit', awaitCleanup: true });
            // Generic hosts that do not manage irreversible pane commit steps
            // retain automatic acceptance, while still current, at settlement.
            if (!operation.accepted) accept();
            return context;
        } catch (error) { this.#drop(operation); throw error; }
        finally { operation.decoded.clear(); if (this.#operation === operation) this.#operation = null; }
    }
    cancel() { ++this.#generation; this.#operation?.controller.abort(); this.#operation = null; }
    dispose() { if (this.#disposed) return; this.cancel(); this.#disposed = true; }
}
