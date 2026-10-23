const UID = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*$/u;
export const CONTEXT_BYTES = 64 * 1024;
export const AUDIT_OPERATIONS = new Set(['login', 'logout', 'dicom-auth', 'worklist', 'open-study', 'save-context', 'load-context', 'create-share', 'resolve-share', 'revoke-share']);
export function plain(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
        Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) throw new TypeError('Use supported enterprise options as plain data properties.');
    return value;
}
export function text(value, maximum = 128) {
    if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x1f\x7f]/u.test(value)) throw new TypeError('Enterprise text is missing, invalid, or exceeds its bound.');
    return value;
}
export function uid(value) {
    if (typeof value !== 'string' || value.length > 64 || !UID.test(value)) throw new TypeError('Use a valid DICOM identifier in enterprise references.');
    return value;
}
export function canceled() { return new DOMException('The enterprise operation was canceled.', 'AbortError'); }
export function check(signal) { if (signal?.aborted) throw canceled(); }
export function abortable(operation, signal) {
    check(signal);
    return new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(canceled()); };
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(operation).then(value => { signal.removeEventListener('abort', abort); signal.aborted ? reject(canceled()) : resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
        if (signal.aborted) abort();
    });
}
export function observe(callback, value) { try { Promise.resolve(callback?.(value)).catch(() => {}); } catch {} }
export function origin(value, { loopback = false } = {}) {
    let url; try { url = new URL(value); } catch { throw new TypeError('Configure an explicit trusted enterprise origin.'); }
    if (typeof value !== 'string' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        url.protocol !== 'https:' && !(loopback && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new TypeError('Enterprise origins require HTTPS; explicit local development may use HTTP loopback.');
    return url.origin;
}
export function reference(value) {
    plain(value, ['archiveKey', 'studyUid', 'seriesUid', 'sopUid']);
    const result = { archiveKey: text(value.archiveKey, 64), studyUid: uid(value.studyUid) };
    if (!/^[A-Za-z0-9_.:-]+$/u.test(result.archiveKey) || ['.', '..'].includes(result.archiveKey)) throw new TypeError('Use a configured archive key, not an address.');
    if (value.seriesUid != null) result.seriesUid = uid(value.seriesUid);
    if (value.sopUid != null) { if (!result.seriesUid) throw new TypeError('An instance reference needs its series.'); result.sopUid = uid(value.sopUid); }
    return result;
}
export function context(value) {
    plain(value, ['version', 'layout', 'activeViewport', 'viewports']);
    if (value.version !== 1 || ![1, 2, 4].includes(value.layout) || !Number.isInteger(value.activeViewport) || value.activeViewport < 0 || value.activeViewport >= value.layout ||
        !Array.isArray(value.viewports) || value.viewports.length > value.layout) throw new TypeError('Use a version1 enterprise viewing context with one, two or four panes.');
    const slots = new Set();
    const result = { version: 1, layout: value.layout, activeViewport: value.activeViewport, viewports: value.viewports.map(item => {
        plain(item, ['slot', 'reference', 'frameIndex', 'originalFrameNumber', 'window']);
        if (!Number.isInteger(item.slot) || item.slot < 0 || item.slot >= value.layout || slots.has(item.slot) || !Number.isInteger(item.frameIndex) || item.frameIndex < 0 || item.frameIndex >= 10000) throw new TypeError('Enterprise pane indices must be bounded and unique.');
        slots.add(item.slot);
        const entry = { slot: item.slot, reference: reference(item.reference), frameIndex: item.frameIndex };
        if (item.originalFrameNumber != null) {
            if (!entry.reference.sopUid || !Number.isInteger(item.originalFrameNumber) || item.originalFrameNumber < 1 || item.originalFrameNumber > 4096) throw new TypeError('An original frame number requires an exact SOP reference and one-based frame within4096.');
            entry.originalFrameNumber = item.originalFrameNumber;
        }
        if (item.window != null) {
            plain(item.window, ['center', 'width']);
            if (!Number.isFinite(item.window.center) || !Number.isFinite(item.window.width) || item.window.width <= 0 || Math.abs(item.window.center) > 1e12 || item.window.width > 1e12) throw new TypeError('Use a finite enterprise grayscale window.');
            entry.window = { center: item.window.center, width: item.window.width };
        }
        return entry;
    }) };
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > CONTEXT_BYTES) throw new TypeError('The enterprise viewing context exceeds64KiB.');
    return result;
}
