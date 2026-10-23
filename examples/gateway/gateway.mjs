import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { nativeFrameTransformer, proveNativeFrameLocation, validateNativeFrameMedia } from './native-frame-stream.mjs';

// Match the viewer's metadata/source/native-frame envelope limits without loading its renderer.
export const GATEWAY_LIMITS = Object.freeze({ metadata: 8 * 1024 * 1024, instance: 256 * 1024 * 1024, frame: 64 * 1024 * 1024 });
const UID = '(?:0|[1-9]\\d*)(?:\\.(?:0|[1-9]\\d*))*';
const ROUTES = [
    [/^\/studies$/, 'metadata'], [new RegExp(`^/studies/(${UID})/series$`), 'metadata'],
    [new RegExp(`^/studies/(${UID})/series/(${UID})/metadata$`), 'metadata'],
    [new RegExp(`^/studies/(${UID})/series/(${UID})/instances/(${UID})/metadata$`), 'metadata'],
    [new RegExp(`^/studies/(${UID})/series/(${UID})/instances/(${UID})$`), 'instance'],
    [new RegExp(`^/studies/(${UID})/series/(${UID})/instances/(${UID})/frames/([1-9]\\d{0,3}|10000)$`), 'frame']
];
const FILTERS = new Set(['offset', 'limit', 'includefield', 'PatientID', 'PatientName', 'StudyDate', 'AccessionNumber',
    'ModalitiesInStudy', 'StudyInstanceUID', 'SeriesInstanceUID', 'SOPInstanceUID', 'Modality']);
const MEDIA = new Set(['application/dicom+json', 'application/json', 'application/dicom', 'application/octet-stream', 'multipart/related']);
function configuredUrl(value, loopback) {
    let url; try { url = new URL(value); } catch { throw new TypeError('Configure a fixed gateway HTTP(S) endpoint.'); }
    if (typeof value !== 'string' || url.username || url.password || url.search || url.hash ||
        url.protocol !== 'https:' && !(loopback && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new TypeError('Gateway endpoints require HTTPS or explicit HTTP loopback development.');
    return url;
}
function reject(response, status, message) {
    if (response.headersSent) { response.destroy(); return; }
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); response.end(message);
}
function authenticate(value) {
    return value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
        Reflect.ownKeys(value).every(key => ['subject', 'realm', 'expiresAt', 'revocationSignal'].includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) &&
        (value.revocationSignal == null || value.revocationSignal instanceof AbortSignal && !value.revocationSignal.aborted) && ['subject', 'realm'].every(key => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 128 && !/[\x00-\x1f\x7f]/u.test(value[key])) && Number.isSafeInteger(value.expiresAt) && value.expiresAt > Date.now();
}
function abortable(operation, signal) {
    return new Promise((resolve, rejectPromise) => {
        const abort = () => { signal.removeEventListener('abort', abort); rejectPromise(new DOMException('Gateway request canceled.', 'AbortError')); };
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(operation).then(value => { signal.removeEventListener('abort', abort); signal.aborted ? abort() : resolve(value); }, error => { signal.removeEventListener('abort', abort); rejectPromise(error); });
        if (signal.aborted) abort();
    });
}
function notify(callback, event) { try { Promise.resolve(callback?.(event)).catch(() => {}); } catch {} }

/** Fixed-origin read-only gateway; authorize() must enforce identity AND resource access on the server. */
export function createDicomGateway({ archiveBaseUrl, publicOrigin, authorize, upstreamHeaders = () => ({}),
    allowInsecureLoopback = false, maxConcurrent = 4, timeoutMs = 30000, limits = GATEWAY_LIMITS, audit } = {}) {
    const archive = configuredUrl(archiveBaseUrl, allowInsecureLoopback), viewer = configuredUrl(publicOrigin, allowInsecureLoopback);
    if (viewer.pathname !== '/' || typeof authorize !== 'function' || typeof upstreamHeaders !== 'function' || typeof allowInsecureLoopback !== 'boolean' ||
        !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000 ||
        Object.keys(GATEWAY_LIMITS).some(key => !Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > GATEWAY_LIMITS[key]) || audit != null && typeof audit !== 'function') throw new TypeError('Configure bounded gateway limits and a server authorization callback.');
    const prefix = archive.href.replace(/\/+$/u, ''); let active = 0;
    return async (request, response) => {
        response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('X-Content-Type-Options', 'nosniff');
        const started = performance.now(); let status = 'error', reserved = false, peer, principalTimer, revocationSignal;
        const controller = new AbortController(); const close = () => { if (!response.writableEnded) controller.abort(); };
        response.on('close', close); const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); reject(response, 405, 'The DICOM gateway supports GET only.'); return; }
            if (request.socket.encrypted !== true && !(allowInsecureLoopback && viewer.protocol === 'http:' && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress))) { reject(response, 403, 'The gateway requires HTTPS.'); return; }
            if (request.headers.host !== viewer.host || request.headers.origin != null && request.headers.origin !== viewer.origin || request.headers['sec-fetch-site'] === 'cross-site') { reject(response, 403, 'The request origin is not configured.'); return; }
            if (typeof request.url !== 'string' || !request.url.startsWith('/') || request.url.startsWith('//') || request.url.length > 8192 || /[\\%]/u.test(request.url.split('?')[0]) || /(?:^|\/)\.{1,2}(?:\/|$)/u.test(request.url.split('?')[0]) || request.headers['transfer-encoding'] || Number(request.headers['content-length'] || 0) > 0) { reject(response, 404, 'Unknown DICOM gateway resource.'); return; }
            const url = new URL(request.url, viewer.origin), path = url.pathname.slice('/dicom-web'.length);
            const match = url.pathname.startsWith('/dicom-web/') ? ROUTES.map(([route, kind]) => ({ match: path.match(route), kind })).find(result => result.match && result.match.slice(1).every(value => value.length <= 64)) : null;
            if (!match) { reject(response, 404, 'Unknown DICOM gateway resource.'); return; }
            const query = [...url.searchParams];
            if (query.length > 64 || new Set(query.map(([key]) => key)).size !== query.length || query.some(([key, value]) =>
                !(FILTERS.has(key) || /^[0-9A-F]{8}$/u.test(key)) || value.length > (key === 'includefield' ? 2048 : 256) || /[\x00-\x1f\x7f]/u.test(value)) ||
                match.kind !== 'metadata' && query.length || query.some(([key, value]) => key === 'limit' && (!/^\d+$/u.test(value) || Number(value) < 1 || Number(value) > 100) || key === 'offset' && (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value))))) { reject(response, 400, 'Unsupported DICOM gateway query.'); return; }
            if (active >= maxConcurrent) { response.setHeader('Retry-After', '1'); reject(response, 429, 'The gateway read limit is currently in use.'); return; }
            active++; reserved = true;
            const principal = await abortable(authorize({ method: 'GET', path, query: Object.fromEntries(query), resource: match.kind,
                identifiers: match.match.slice(1), authorization: request.headers.authorization ?? null, cookie: request.headers.cookie ?? null }, { signal: controller.signal }), controller.signal);
            if (!authenticate(principal)) { reject(response, 403, 'The server did not authorize this DICOM read.'); return; }
            principalTimer = setTimeout(() => controller.abort(), Math.min(timeoutMs, principal.expiresAt - Date.now()));
            revocationSignal = principal.revocationSignal; revocationSignal?.addEventListener('abort', close, { once: true });
            const supplied = await abortable(upstreamHeaders({ signal: controller.signal }), controller.signal);
            if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) || Object.keys(supplied).some(key => !['authorization', 'x-api-key'].includes(key.toLowerCase()) || typeof supplied[key] !== 'string' || supplied[key].length > 8192 || /[\r\n\0]/u.test(supplied[key]))) throw new Error('Invalid server credentials.');
            if (!authenticate(principal)) { reject(response, 403, 'The server authorization expired during this read.'); return; }
            const headers = new Headers(supplied), accept = request.headers.accept ?? (match.kind === 'metadata' ? 'application/dicom+json' : 'application/dicom');
            if (typeof accept !== 'string' || accept.length > 2048 || accept.split(',').some(value => !MEDIA.has(value.split(';')[0].trim().toLowerCase()))) { reject(response, 400, 'Unsupported DICOM representation.'); return; }
            headers.set('Accept', accept);
            peer = await fetch(`${prefix}${path}${url.search}`, { method: 'GET', headers, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal });
            if (!peer.ok) { await peer.body?.cancel().catch(() => {}); reject(response, peer.status, 'The configured archive could not complete this read.'); return; }
            const mime = peer.headers.get('content-type') ?? '', maximum = limits[match.kind];
            const allowed = match.kind === 'metadata' ? ['application/dicom+json', 'application/json'] : match.kind === 'instance' ? ['application/dicom', 'multipart/related'] : ['application/octet-stream', 'multipart/related'];
            if (peer.status !== 204 && !allowed.includes(mime.split(';')[0].trim().toLowerCase()) || Number(peer.headers.get('content-length')) > maximum || !peer.body && peer.status !== 204) throw new Error('Invalid bounded archive response.');
            let frameTransform;
            const upstreamUrl = `${prefix}${path}${url.search}`, downstreamUrl = `${viewer.origin}${url.pathname}${url.search}`;
            if (match.kind === 'frame' && peer.status !== 204) {
                if (mime.split(';')[0].trim().toLowerCase() === 'application/octet-stream') {
                    validateNativeFrameMedia(mime);
                    const location = proveNativeFrameLocation(peer.headers.get('content-location'), upstreamUrl, downstreamUrl);
                    response.setHeader('Content-Location', location);
                } else frameTransform = nativeFrameTransformer({ contentType: mime, upstreamUrl, downstreamUrl, maxBytes: maximum });
            }
            response.statusCode = peer.status; if (mime) response.setHeader('Content-Type', mime);
            if (/(?:^|,)\s*299(?:\s|$)/u.test(peer.headers.get('warning') ?? '')) response.setHeader('Warning', '299 easi-gateway "The archive limited these results."');
            if (!peer.body) { response.end(); status = 'success'; return; }
            let received = 0;
            const bounded = new Transform({ transform(chunk, _encoding, done) { received += chunk.length; if (received > maximum) { controller.abort(); done(new Error('Archive byte limit exceeded.')); } else done(null, chunk); } });
            await pipeline(...[Readable.fromWeb(peer.body), frameTransform, bounded, response].filter(Boolean), { signal: controller.signal }); status = 'success';
        } catch {
            status = controller.signal.aborted ? 'canceled' : 'error';
            if (!response.destroyed) reject(response, 502, 'The configured archive read could not complete safely.');
        } finally {
            clearTimeout(timer); clearTimeout(principalTimer); revocationSignal?.removeEventListener('abort', close); response.removeListener('close', close); if (reserved) active--;
            if (peer?.body && !peer.body.locked) await peer.body.cancel().catch(() => {});
            notify(audit, { operation: 'gateway-read', status, durationMs: Math.max(0, performance.now() - started) });
        }
    };
}
