const MAX_SERIES = 128, MAX_FRAMES = 10000;
const MAX_PLAN_BYTES = 1024 * 1024;
const scalarFields = ['sopUid', 'frameIndex', 'studyUid', 'seriesUid', 'frameOfReferenceUid', 'rows', 'columns',
    'photometric', 'samplesPerPixel', 'bitsAllocated', 'bitsStored', 'highBit', 'signed', 'modality',
    'slope', 'intercept', 'unit', 'voiFunction', 'voiMode', 'presentationInvert'];
const structuredFields = ['position', 'orientation', 'pixelSpacing', 'pixelAspectRatio', 'padding',
    'dimensions', 'classicDimensions', 'syncDimensions'];
const canceled = () => new DOMException('The reading protocol was canceled.', 'AbortError');
const fail = message => { const error = new Error(`Reading protocol could not be applied: ${message}.`); error.code = 'READING_PROTOCOL_FAILED'; throw error; };
const plain = (input, keys) => {
    if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
        Reflect.ownKeys(input).some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), 'value'))) {
        throw new TypeError('Use supported reading-protocol plain data properties.');
    }
};
const identifier = value => {
    if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(value)) throw new TypeError('Use bounded reading-protocol identifiers.');
    return value;
};
const integer = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const array = (value, maximum) => {
    if (!Array.isArray(value) || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1 ||
        Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, String(index)))
            .some(property => !property?.enumerable || !Object.hasOwn(property, 'value'))) throw new TypeError('Use bounded reading-protocol JSON arrays without accessors or extra fields.');
    return value;
};
const reasons = value => {
    array(value, 32);
    return Object.freeze(value.map(code => {
        if (typeof code !== 'string' || !/^[A-Za-z0-9_:-]{1,128}$/u.test(code)) throw new TypeError('Use bounded reading-protocol reason codes.');
        return code;
    }));
};
const freeze = value => { Object.values(value).forEach(child => { if (child && typeof child === 'object') freeze(child); }); return Object.freeze(value); };

/** Strict, detached planner output. It contains indices and rule codes, never a source or pixel object. */
function plan(input) {
    plain(input, ['version', 'protocolId', 'layout', 'links', 'status', 'selectors', 'slots']);
    array(input.selectors, 4); array(input.slots, 4);
    if (input.version !== 1 || ![1, 2, 4].includes(input.layout) || !['ready', 'unresolved'].includes(input.status) ||
        !Array.isArray(input.selectors) || !input.selectors.length || input.selectors.length > 4 ||
        !Array.isArray(input.slots) || input.slots.length !== input.layout) throw new TypeError('Use a bounded version1 reading-protocol plan.');
    plain(input.links, ['scroll', 'window', 'camera']);
    if (['scroll', 'window', 'camera'].some(key => typeof input.links[key] !== 'boolean')) throw new TypeError('Reading-protocol links must be explicit booleans.');
    const ids = new Set();
    const selectors = input.selectors.map(selector => {
        plain(selector, ['id', 'status', 'matchedIndex', 'candidates', 'reasonCodes', 'manual']);
        const id = identifier(selector.id);
        array(selector.candidates, MAX_SERIES);
        if (ids.has(id) || !['matched', 'missing', 'ambiguous', 'blocked'].includes(selector.status) || typeof selector.manual !== 'boolean' ||
            !Array.isArray(selector.candidates) || selector.candidates.length > MAX_SERIES ||
            (selector.status === 'matched' ? !integer(selector.matchedIndex, MAX_SERIES - 1) : selector.matchedIndex !== null)) throw new TypeError('Use unique, bounded reading-protocol selector results.');
        ids.add(id); const seen = new Set();
        const candidates = selector.candidates.map(candidate => {
            plain(candidate, ['index', 'eligible', 'score', 'reasonCodes']);
            if (!integer(candidate.index, MAX_SERIES - 1) || seen.has(candidate.index) || typeof candidate.eligible !== 'boolean' ||
                !integer(candidate.score, 1600)) throw new TypeError('Use bounded reading-protocol candidate results.');
            seen.add(candidate.index);
            return { index: candidate.index, eligible: candidate.eligible, score: candidate.score, reasonCodes: reasons(candidate.reasonCodes) };
        });
        if (selector.status === 'matched' && !candidates.some(candidate => candidate.index === selector.matchedIndex && candidate.eligible)) throw new TypeError('A matched selector needs its eligible candidate.');
        return { id, status: selector.status, matchedIndex: selector.matchedIndex, candidates, reasonCodes: reasons(selector.reasonCodes), manual: selector.manual };
    });
    const slots = new Set();
    const views = input.slots.map(slot => {
        plain(slot, ['id', 'selector', 'status', 'candidateIndex', 'frameIndex', 'window', 'windowUnit', 'reasonCodes']);
        if (!integer(slot.id, input.layout - 1) || slots.has(slot.id) || !ids.has(slot.selector) ||
            !['ready', 'missing', 'ambiguous', 'blocked', 'frame-unavailable'].includes(slot.status) ||
            slot.candidateIndex !== null && !integer(slot.candidateIndex, MAX_SERIES - 1) ||
            slot.frameIndex !== null && !integer(slot.frameIndex, MAX_FRAMES - 1)) throw new TypeError('Use unique reading-protocol pane selections.');
        slots.add(slot.id); let window = null;
        if (slot.window !== null) {
            plain(slot.window, ['center', 'width']);
            if (!Number.isFinite(slot.window.center) || !Number.isFinite(slot.window.width) || Math.abs(slot.window.center) > 1e12 || slot.window.width <= 0 || slot.window.width > 1e12) throw new TypeError('Use a finite positive reading-protocol window.');
            window = { center: slot.window.center, width: slot.window.width };
        }
        if (slot.windowUnit !== null && (typeof slot.windowUnit !== 'string' || slot.windowUnit.length > 64 || /[\x00-\x1f\x7f]/u.test(slot.windowUnit))) throw new TypeError('Use a bounded declared window unit.');
        const selected = selectors.find(selector => selector.id === slot.selector);
        if (slot.status === 'ready' && (selected.status !== 'matched' || slot.candidateIndex !== selected.matchedIndex || slot.frameIndex === null)) throw new TypeError('A ready pane must agree with its matched selector.');
        return { id: slot.id, selector: slot.selector, status: slot.status, candidateIndex: slot.candidateIndex, frameIndex: slot.frameIndex,
            window, windowUnit: slot.windowUnit, reasonCodes: reasons(slot.reasonCodes) };
    });
    const output = { version: 1, protocolId: identifier(input.protocolId), layout: input.layout, links: { ...input.links }, status: input.status, selectors, slots: views };
    if (new TextEncoder().encode(JSON.stringify(output)).byteLength > MAX_PLAN_BYTES) throw new TypeError('The reading-protocol plan exceeds1MiB.');
    return freeze(output);
}

function metadata(frame) {
    if (!frame || typeof frame !== 'object' || typeof frame.sopUid !== 'string' || frame.sopUid.length > 64 || !/^\d+(?:\.\d+)*$/u.test(frame.sopUid) || !integer(frame.frameIndex, 4095)) fail('original frame identity is unavailable');
    const output = {};
    for (const key of scalarFields) if (frame[key] != null) output[key] = frame[key];
    for (const key of structuredFields) if (frame[key] != null) {
        let value; try { value = JSON.stringify(frame[key]); } catch { fail('source metadata is invalid'); }
        if (typeof value !== 'string' || value.length > 16384) fail('source metadata is invalid');
        output[key] = value;
    }
    output.tables = {};
    for (const key of ['modalityLut', 'voiLut', 'palette']) {
        const table = frame[key];
        if (!table) continue;
        const fields = key === 'palette' ? ['red', 'green', 'blue'] : ['entries'];
        output.tables[key] = { count: table.count, firstMapped: table.firstMapped, bits: table.bits,
            ...(table.unit != null ? { unit: table.unit } : {}), entries: fields.map(field => ({ field, values: table[field] ?? null })) };
    }
    return output;
}
function suppliedDimensions(expected, actual) {
    if (expected == null || expected === '' || Array.isArray(expected) && !expected.length) return true;
    if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((value, index) => suppliedDimensions(value, actual[index]));
    if (typeof expected !== 'object') return expected === actual;
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([key, value]) => key === 'semanticScope' && value === 'same-series-only'
        ? ['same-series-only', 'classic-exposed-dimensions'].includes(actual[key]) : suppliedDimensions(value, actual[key]));
}
function matches(frame, expected, { dimensionEnrichment = false } = {}) {
    try { return Object.entries(expected).every(([key, value]) => {
        if (key === 'tables') return Object.entries(value).every(([role, expected]) => {
            const table = frame[role];
            return table && ['count', 'firstMapped', 'bits', 'unit'].every(key => expected[key] == null || expected[key] === table[key]) &&
                expected.entries.every(({ field, values }) => !values || table[field]?.length === values.length && values.every((value, index) => value === table[field][index]));
        });
        if (dimensionEnrichment && ['dimensions', 'classicDimensions', 'syncDimensions'].includes(key)) return suppliedDimensions(JSON.parse(value), frame[key]);
        return structuredFields.includes(key) ? JSON.stringify(frame[key]) === value : frame[key] === value;
    }); }
    catch { return false; }
}
function validateFrame(frame, selection) {
    if (!frame || !matches(frame, selection.metadata, { dimensionEnrichment: true })) fail('decoded frame identity or declared metadata differs from its source');
    const color = frame.photometric === 'RGB', palette = frame.photometric === 'PALETTE COLOR';
    if (!(frame.samples instanceof Uint8Array || frame.samples instanceof Uint16Array || frame.samples instanceof Int16Array) ||
        !integer(frame.rows, 8192) || !integer(frame.columns, 8192) || frame.rows < 1 || frame.columns < 1 ||
        frame.rows * frame.columns > 16 * 1024 * 1024 || !['MONOCHROME1', 'MONOCHROME2', 'RGB', 'PALETTE COLOR'].includes(frame.photometric) ||
        frame.samplesPerPixel !== (color ? 3 : 1) || frame.samples.length !== frame.rows * frame.columns * (color ? 3 : 1)) fail('decoded stored sample layout is invalid');
    if (selection.view.window && (color || palette || selection.view.windowUnit !== null && frame.unit !== selection.view.windowUnit ||
        frame.voiFunction === 'LINEAR' && selection.view.window.width < 1)) fail('the requested window does not match the declared grayscale intensity unit');
}
function bytes(frames) {
    const buffers = new Set();
    for (const frame of frames) for (const view of [frame.samples, frame.modalityLut?.entries, frame.voiLut?.entries, frame.palette?.red, frame.palette?.green, frame.palette?.blue]) if (ArrayBuffer.isView(view)) buffers.add(view.buffer);
    return [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0);
}

/**
 * Prepare only already-loaded selections. The host's getFrame uses its owned
 * broker; holdFrame admits/pins a returned frame and returns its release callback.
 * Commit must finish its rollback before rejecting, and call accept at the last
 * synchronous guarded commit point. This class never disposes a borrowed source.
 */
export class ReadingProtocolCoordinator {
    #generation = 0; #active = null; #pending = new Set(); #disposed = false;
    constructor(options) {
        plain(options, ['getSeries', 'getRevision', 'getClient', 'getFrame', 'holdFrame', 'commit', 'onChange']);
        for (const key of ['getSeries', 'getRevision', 'getFrame', 'holdFrame', 'commit']) if (typeof options[key] !== 'function') throw new TypeError('Provide all reading-protocol source, admission and commit callbacks.');
        for (const key of ['getClient', 'onChange']) if (options[key] != null && typeof options[key] !== 'function') throw new TypeError('Use function callbacks for reading-protocol observation and connection.');
        this.callbacks = { ...options, getClient: options.getClient ?? (() => null) };
    }
    getState() {
        const operations = [...this.#pending];
        return { disposed: this.#disposed, busy: operations.length > 0, preparing: operations.some(operation => operation.phase === 'preparing'),
            committing: operations.some(operation => operation.phase === 'committing'), preparedFrames: operations.reduce((sum, operation) => sum + operation.frames.size, 0),
            preparedBytes: bytes(operations.flatMap(operation => [...operation.frames.values()])), assignmentCount: this.#active?.assignments.length ?? 0 };
    }
    #observe() { try { Promise.resolve(this.callbacks.onChange?.(this.getState())).catch(() => {}); } catch {} }
    #check(operation) {
        if (operation.failure) throw operation.failure;
        if (this.#disposed || operation.signal.aborted || operation.generation !== this.#generation) throw canceled();
        let catalog, revision, client;
        try { catalog = this.callbacks.getSeries(); revision = this.callbacks.getRevision(); client = this.callbacks.getClient(); } catch { catalog = null; }
        if (revision !== operation.revision || client !== operation.client || !Array.isArray(catalog) || catalog.length !== operation.catalog.length ||
            catalog.some((series, index) => series !== operation.catalog[index]) || operation.selections.some(selection => selection.series.disposed ||
                !selection.series.frames?.[selection.index] || !matches(selection.series.frames[selection.index], selection.metadata))) {
            operation.failure = new Error('Reading protocol could not be applied: the loaded source or connection changed.');
            operation.failure.code = 'READING_PROTOCOL_CHANGED'; operation.controller.abort(); throw operation.failure;
        }
    }
    #current(operation) { try { this.#check(operation); return true; } catch { return false; } }
    #await(operation, callback, label) {
        this.#check(operation);
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (handler, value) => { if (settled) return; settled = true; operation.signal.removeEventListener('abort', abort); handler(value); };
            const abort = () => finish(reject, operation.failure ?? canceled());
            operation.signal.addEventListener('abort', abort, { once: true });
            Promise.resolve().then(() => { this.#check(operation); return callback(); }).then(value => {
                if (settled) return;
                try { this.#check(operation); finish(resolve, value); } catch (error) { finish(reject, error); }
            }, () => {
                if (settled) return;
                try { this.#check(operation); } catch (error) { finish(reject, error); return; }
                finish(reject, new Error(`Reading protocol could not be applied: ${label} failed.`));
            });
            if (operation.signal.aborted) abort();
        });
    }
    apply(input, options = {}) {
        if (this.#disposed) return Promise.reject(new Error('The reading-protocol coordinator is disposed.'));
        let normalized, catalog, revision, client, selections;
        try {
            plain(options, ['signal']);
            if (options.signal != null && !(options.signal instanceof AbortSignal)) throw new TypeError('Use an AbortSignal for reading-protocol application.');
            if (options.signal?.aborted) throw canceled();
            normalized = plan(input);
            if (normalized.status !== 'ready' || normalized.slots.some(slot => slot.status !== 'ready')) fail('resolve every missing, blocked or ambiguous pane first');
            try { catalog = this.callbacks.getSeries(); revision = this.callbacks.getRevision(); client = this.callbacks.getClient(); } catch { fail('source callbacks are unavailable'); }
            if (!Array.isArray(catalog) || catalog.length > MAX_SERIES || new Set(catalog).size !== catalog.length ||
                catalog.some(series => !series || series.disposed || !Array.isArray(series.frames) || !series.frames.length) ||
                catalog.reduce((sum, series) => sum + series.frames.length, 0) > MAX_FRAMES || !integer(revision, Number.MAX_SAFE_INTEGER) || client !== null && typeof client !== 'object') fail('the loaded source catalog is invalid');
            catalog = [...catalog];
            selections = normalized.slots.map(view => {
                const series = catalog[view.candidateIndex], descriptor = series?.frames[view.frameIndex];
                if (!descriptor) fail('a selected frame is not already loaded');
                return { view, slot: view.id, series, index: view.frameIndex, metadata: metadata(descriptor) };
            });
        } catch (error) { return Promise.reject(error); }
        const previous = [...this.#pending].map(operation => operation.done);
        for (const pending of this.#pending) pending.controller.abort();
        const controller = new AbortController(), operation = { generation: ++this.#generation, controller,
            signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal, catalog, revision, client,
            selections, assignments: [], frames: new Map(), releases: [], phase: 'preparing', accepted: false, failure: null, done: null };
        this.#active = operation; this.#pending.add(operation);
        operation.done = Promise.resolve().then(() => this.#run(operation, normalized, previous));
        this.#observe();
        // Preserve rejection for the caller without creating an unhandled
        // rejection when cancellation is observed only through whenIdle().
        void operation.done.catch(() => {});
        return operation.done;
    }
    async #run(operation, normalized, previous) {
        try {
            if (previous.length) await this.#await(operation, () => Promise.allSettled(previous), 'previous transaction cleanup');
            this.#check(operation);
            const decoded = new Map();
            for (const selection of operation.selections) {
                this.#check(operation);
                let indices = decoded.get(selection.series);
                if (!indices) { indices = new Map(); decoded.set(selection.series, indices); }
                if (!indices.has(selection.index)) {
                    const frame = await this.#await(operation, () => this.callbacks.getFrame(selection.series, selection.index, { signal: operation.signal }), 'selected frame preparation');
                    validateFrame(frame, selection); this.#check(operation);
                    let release;
                    try { release = this.callbacks.holdFrame(frame, { signal: operation.signal }); } catch { fail('selected frame admission failed'); }
                    if (typeof release !== 'function') fail('selected frame admission requires a release callback');
                    operation.releases.push(release); operation.frames.set(frame, frame); indices.set(selection.index, frame);
                    this.#check(operation); this.#observe(); this.#check(operation);
                }
                const frame = indices.get(selection.index); validateFrame(frame, selection);
                operation.assignments.push({ slot: selection.slot, view: selection.view, series: selection.series, index: selection.index, frame });
            }
            this.#check(operation); operation.phase = 'committing'; this.#observe(); this.#check(operation);
            const accept = () => {
                if (operation.accepted) return;
                this.#check(operation); operation.accepted = true;
            };
            // No abort race here: a commit may be performing asynchronous
            // rollback and must retain prepared frames until that work settles.
            try {
                await this.callbacks.commit({ plan: normalized, assignments: operation.assignments, signal: operation.signal,
                    isCurrent: () => this.#current(operation), accept });
            } catch {
                if (!operation.accepted) this.#check(operation);
                fail('transactional pane commit failed');
            }
            if (!operation.accepted) accept();
            return normalized;
        } finally {
            operation.phase = 'cleanup';
            for (const release of operation.releases.splice(0)) { try { await release(); } catch { /* Attempt every borrowed-frame release. */ } }
            operation.frames.clear(); operation.assignments.length = 0; operation.selections.length = 0; operation.catalog.length = 0;
            this.#pending.delete(operation); if (this.#active === operation) this.#active = null;
            this.#observe();
        }
    }
    cancel() { ++this.#generation; for (const operation of this.#pending) operation.controller.abort(); return this.whenIdle(); }
    async whenIdle() { while (this.#pending.size) await Promise.allSettled([...this.#pending].map(operation => operation.done)); }
    dispose() { if (!this.#disposed) { this.#disposed = true; this.cancel(); this.#observe(); } return this.whenIdle(); }
}
