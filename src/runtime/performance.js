const PHASES = new Set(['study-query', 'series-query', 'series-metadata', 'metadata-read', 'metadata-parse', 'metadata-index',
    'instance-headers', 'stream', 'pipeline', 'decode', 'frame', 'display', 'first-display', 'source-open']);
const STATUSES = new Set(['success', 'error', 'canceled']);
const SOURCES = new Set(['demo', 'files', 'url', 'archive']);
const BYTE_FIELDS = ['bytes', 'decodedBytes', 'encodedCacheBytes', 'decodedCacheBytes'];
const HIT_FIELDS = ['decodedCacheHit', 'encodedCacheHit'];
let lastClock = 0;

/** Relative monotonic time only; never use a wall-clock date in viewing measurements. */
export function clockNow() {
    try {
        const value = globalThis.performance?.now?.();
        if (Number.isFinite(value)) lastClock = Math.max(lastClock, value);
    } catch { /* Optional observation must not change the viewing operation. */ }
    return lastClock;
}

function sanitize(event) {
    try {
        if (!event || !PHASES.has(event.phase) || !STATUSES.has(event.status) ||
            !Number.isFinite(event.durationMs) || event.durationMs < 0 || event.durationMs > Number.MAX_SAFE_INTEGER) return null;
        const clean = { phase: event.phase, durationMs: event.durationMs, status: event.status };
        for (const key of BYTE_FIELDS) {
            if (Number.isSafeInteger(event[key]) && event[key] >= 0) clean[key] = event[key];
        }
        for (const key of HIT_FIELDS) if (typeof event[key] === 'boolean') clean[key] = event[key];
        if (SOURCES.has(event.source)) clean.source = event.source;
        return clean;
    } catch { return null; }
}

/** One safe observation; cancellation finishes synchronously and suppresses late results. */
export function beginMeasure(onMeasure, phase, { signal } = {}) {
    if (typeof onMeasure !== 'function' || !PHASES.has(phase)) return () => null;
    const started = clockNow();
    let finished = false;
    const finish = (status = 'success', details = {}) => {
        if (finished) return null;
        finished = true;
        signal?.removeEventListener('abort', cancel);
        let event;
        try { event = sanitize({ ...details, phase, durationMs: Math.max(0, clockNow() - started), status }); }
        catch { return null; }
        if (!event) return null;
        try { Promise.resolve(onMeasure(event)).catch(() => {}); }
        catch { /* Observers cannot fail or stall the viewer's operation. */ }
        return event;
    };
    const cancel = () => finish('canceled');
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    return finish;
}

function percentile(values, ratio) {
    return values.length ? values[Math.max(0, Math.ceil(values.length * ratio) - 1)] : null;
}

/** Bounded, in-memory observations; the caller owns export and no telemetry is sent. */
export class PerformanceRecorder {
    constructor({ limit = 256 } = {}) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4096) throw new RangeError('Use a performance measurement limit from 1 to 4096.');
        this.limit = limit;
        this.measurements = [];
        this.disposed = false;
    }

    record(event) {
        if (this.disposed) return false;
        const clean = sanitize(event);
        if (!clean) return false;
        this.measurements.push(clean);
        if (this.measurements.length > this.limit) this.measurements.splice(0, this.measurements.length - this.limit);
        return true;
    }

    snapshot() {
        const measurements = this.measurements.map(event => ({ ...event }));
        const summary = {};
        for (const phase of PHASES) {
            const events = measurements.filter(event => event.phase === phase);
            if (!events.length) continue;
            const successful = events.filter(event => event.status === 'success').map(event => event.durationMs).sort((a, b) => a - b);
            const middle = Math.floor(successful.length / 2);
            summary[phase] = {
                count: events.length,
                successCount: successful.length,
                errorCount: events.filter(event => event.status === 'error').length,
                canceledCount: events.filter(event => event.status === 'canceled').length,
                lastMs: events.at(-1).durationMs,
                medianMs: successful.length ? successful.length % 2 ? successful[middle] : (successful[middle - 1] + successful[middle]) / 2 : null,
                p95Ms: percentile(successful, 0.95)
            };
        }
        return { limit: this.limit, measurements, summary };
    }

    reset() { this.measurements = []; }
    dispose() { this.disposed = true; this.reset(); }
}
