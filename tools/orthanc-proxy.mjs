import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const PREFIX = '/orthanc';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const UID = '(?:0|[1-9]\\d*)(?:\\.(?:0|[1-9]\\d*))*';
const ROUTES = [
    /^\/dicom-web\/studies$/,
    new RegExp(`^/dicom-web/studies/(${UID})/(?:series|instances|metadata)$`),
    new RegExp(`^/dicom-web/studies/(${UID})/series/(${UID})/(?:instances|metadata)$`),
    new RegExp(`^/dicom-web/studies/(${UID})/series/(${UID})/instances/(${UID})(?:/metadata)?$`)
];

function validUpstream(value) {
    let url;
    try { url = new URL(value); } catch { throw new TypeError('Use an HTTP loopback root for the local Orthanc preview peer.'); }
    if (typeof value !== 'string' || url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) ||
        url.pathname !== '/' || url.username || url.password || url.search || url.hash || value.includes('?') || value.includes('#')) {
        throw new TypeError('Use an HTTP loopback root without credentials, paths, queries, or fragments for the local Orthanc preview peer.');
    }
    return url.origin;
}

function safeRequestOrigin(request) {
    if (typeof request.headers.host !== 'string') return false;
    let host;
    try { host = new URL(`http://${request.headers.host}`); } catch { return false; }
    if (!LOOPBACK_HOSTS.has(host.hostname) || host.username || host.password || host.pathname !== '/' || host.search || host.hash) return false;
    if (request.headers.origin == null) return true;
    if (typeof request.headers.origin !== 'string') return false;
    let origin;
    try { origin = new URL(request.headers.origin); } catch { return false; }
    return origin.protocol === 'http:' && origin.origin === host.origin && origin.pathname === '/' &&
        !origin.username && !origin.password && !origin.search && !origin.hash;
}

function validRoute(path) {
    for (const route of ROUTES) {
        const match = path.match(route);
        if (match && match.slice(1).every(value => value.length <= 64)) return true;
    }
    return false;
}

function fail(response, status, message) {
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(message);
}

/** Read-only bridge for a fixed local Orthanc peer. This is a preview tool, not a production proxy. */
export function createOrthancProxy(upstream = 'http://127.0.0.1:8042') {
    const origin = validUpstream(upstream);
    return async (request, response) => {
        let url;
        try { url = new URL(request.url, 'http://localhost'); } catch {
            if (!request.url?.startsWith(PREFIX)) return false;
            fail(response, 404, 'Unknown local Orthanc preview route.');
            return true;
        }
        if (!(url.pathname === PREFIX || url.pathname.startsWith(`${PREFIX}/`))) return false;
        if (!safeRequestOrigin(request)) { fail(response, 403, 'The local Orthanc preview accepts same-origin loopback requests only.'); return true; }
        if (request.method !== 'GET') {
            response.setHeader('Allow', 'GET');
            fail(response, 405, 'The local Orthanc preview supports GET only.');
            return true;
        }
        const path = url.pathname.slice(PREFIX.length);
        if (!validRoute(path) || request.url.length > 8192) { fail(response, 404, 'Unknown local Orthanc preview route.'); return true; }
        const controller = new AbortController();
        const onClose = () => { if (!response.writableEnded) controller.abort(); };
        response.on('close', onClose);
        let peer;
        try {
            const headers = {};
            if (typeof request.headers.accept === 'string') headers.Accept = request.headers.accept;
            peer = await fetch(`${origin}${path}${url.search}`, {
                method: 'GET', headers, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal
            });
            if (controller.signal.aborted || response.destroyed) { await peer.body?.cancel().catch(() => {}); return true; }
            if (!peer.ok) {
                await peer.body?.cancel().catch(() => {});
                fail(response, peer.status, `The local Orthanc peer returned HTTP ${peer.status}.`);
                return true;
            }
            response.statusCode = peer.status;
            response.setHeader('Cache-Control', 'no-store');
            const contentType = peer.headers.get('content-type');
            if (contentType) response.setHeader('Content-Type', contentType);
            if (/(?:^|,)\s*299(?:\s|$)/.test(peer.headers.get('warning') ?? '')) {
                response.setHeader('Warning', '299 local-orthanc-preview "The archive limited these results."');
            }
            // Node fetch transparently decompresses responses. Do not copy Content-Length or Content-Encoding.
            if (peer.body) await pipeline(Readable.fromWeb(peer.body), response, { signal: controller.signal });
            else response.end();
        } catch {
            if (!controller.signal.aborted && !response.destroyed) {
                if (!response.headersSent) fail(response, 502, 'The local Orthanc peer is unavailable or refused the preview request.');
                else response.destroy();
            }
        } finally { response.removeListener('close', onClose); }
        return true;
    };
}
