export const MAX_NOTICE_SCOPES = 256;
export const MAX_NOTICE_WARNINGS = 128;
export const MAX_NOTICE_CHARS = 4096;
const MAX_TECHNICAL_COMBINATIONS = 128;
const OPAQUE_SCOPE = /^[A-Za-z][A-Za-z0-9_-]{0,255}$/u;

function warnings(value) {
    return Array.isArray(value) ? [...new Set(value.filter(item => typeof item === 'string' && item.trim()))] : [];
}
function retainable(value) {
    return value.length <= MAX_NOTICE_CHARS && !/[\u0000-\u001f\u007f]/u.test(value);
}
function object(value) { return value != null && (typeof value === 'object' || typeof value === 'function'); }
function scopeKey(value) { return typeof value === 'string' && OPAQUE_SCOPE.test(value) ? value : null; }
function bounded(value, maximum) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RangeError('Use bounded image notice limits.');
    return value;
}
function remember(map, key, value, maximum) {
    map.delete(key); map.set(key, value);
    while (map.size > maximum) map.delete(map.keys().next().value);
}

/** Memory-only acknowledgement state. Technical notices belong to an actual
 * series object; encoding notices may follow an opaque admitted study token.
 * No frames, pixel buffers, DICOM identifiers or persistent storage are used. */
export class ImageNoticeState {
    #technical = new WeakMap();
    #legacyEncoding = new WeakMap();
    #encodingScopes = new Map();
    #maxScopes;
    #maxWarnings;

    constructor({ maxScopes = MAX_NOTICE_SCOPES, maxWarnings = MAX_NOTICE_WARNINGS } = {}) {
        this.#maxScopes = bounded(maxScopes, MAX_NOTICE_SCOPES);
        this.#maxWarnings = bounded(maxWarnings, MAX_NOTICE_WARNINGS);
    }

    #input(input = {}) {
        return { series: object(input?.series) ? input.series : null, scope: scopeKey(input?.scope),
            calibrated: input?.calibrated === true, geometry: warnings(input?.geometryWarnings),
            timing: warnings(input?.timingWarnings), encoding: warnings(input?.encodingWarnings) };
    }

    #technicalKey(input) {
        const count = input.geometry.length + input.timing.length;
        if (!count || count > this.#maxWarnings || [...input.geometry, ...input.timing].some(value => !retainable(value))) return null;
        return JSON.stringify([input.calibrated, [...input.geometry].sort(), [...input.timing].sort()]);
    }

    #encoding(input, create = false) {
        if (input.scope) {
            let context = this.#encodingScopes.get(input.scope);
            if (!context && create) context = new Map();
            if (context) remember(this.#encodingScopes, input.scope, context, this.#maxScopes);
            return context;
        }
        if (!input.series) return undefined;
        let context = this.#legacyEncoding.get(input.series);
        if (!context && create) { context = new Map(); this.#legacyEncoding.set(input.series, context); }
        return context;
    }

    get(input) {
        const current = this.#input(input), key = this.#technicalKey(current);
        const technicalDismissed = key != null && Boolean(current.series && this.#technical.get(current.series)?.has(key));
        const encoding = this.#encoding(current);
        const geometryWarnings = technicalDismissed ? [] : current.geometry;
        const timingWarnings = technicalDismissed ? [] : current.timing;
        const encodingWarnings = current.encoding.filter(value => !retainable(value) || !encoding?.has(value));
        return { messages: [...new Set([...current.geometry, ...current.timing, ...current.encoding])],
            visibleMessages: [...new Set([...geometryWarnings, ...timingWarnings, ...encodingWarnings])],
            geometryWarnings, timingWarnings, encodingWarnings,
            hasDismissed: technicalDismissed || encodingWarnings.length < current.encoding.length };
    }

    dismiss(input) {
        const current = this.#input(input), key = this.#technicalKey(current);
        if (current.series && key != null) {
            const combinations = this.#technical.get(current.series) ?? new Map();
            remember(combinations, key, true, MAX_TECHNICAL_COMBINATIONS);
            this.#technical.set(current.series, combinations);
        }
        const values = current.encoding.filter(retainable);
        if (values.length) {
            const encoding = this.#encoding(current, true);
            if (encoding) for (const value of values) remember(encoding, value, true, this.#maxWarnings);
        }
        return this.get(input);
    }

    show(input) {
        const current = this.#input(input), key = this.#technicalKey(current);
        const combinations = current.series && this.#technical.get(current.series);
        if (combinations && key != null) {
            combinations.delete(key);
            if (!combinations.size) this.#technical.delete(current.series);
        }
        const encoding = this.#encoding(current);
        if (encoding) {
            for (const value of current.encoding) encoding.delete(value);
            if (!encoding.size) {
                if (current.scope) this.#encodingScopes.delete(current.scope);
                else if (current.series) this.#legacyEncoding.delete(current.series);
            }
        }
        return this.get(input);
    }

    clearTechnical() { this.#technical = new WeakMap(); }

    clear() {
        this.clearTechnical(); this.#legacyEncoding = new WeakMap(); this.#encodingScopes.clear();
    }

    forgetScopes(scopes) {
        if (scopes == null || typeof scopes === 'string' || typeof scopes[Symbol.iterator] !== 'function') return;
        for (const scope of scopes) if (scopeKey(scope)) this.#encodingScopes.delete(scope);
    }
}

export default ImageNoticeState;
