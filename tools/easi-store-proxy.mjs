import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDimseGateway } from '../examples/dimse-gateway/gateway.mjs';
import { EasiStoreDimseTransport } from './easi-store-dimse-transport.mjs';

const PREFIX = '/easi-store';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const UID = '(?:0|[1-9]\\d*)(?:\\.(?:0|[1-9]\\d*))*';
const SCOPED = `/studies/(${UID})/series/(${UID})/instances/(${UID})`;
const HTTP_ROUTES = [
    /^\/studies$/,
    new RegExp(`^/studies/(${UID})(?:/series|/instances|/metadata)?$`),
    new RegExp(`^/studies/(${UID})/series/(${UID})(?:/instances|/metadata)?$`),
    new RegExp(`^${SCOPED}(?:/metadata|/frames/[1-9]\\d*(?:,[1-9]\\d*)*|/bulkdata/(?:[A-F0-9]{8}|\\d+)(?:/(?:[A-F0-9]{8}|\\d+))*)?$`)
];
const DIMSE_ROUTES = [/^\/studies$/, new RegExp(`^/studies/(${UID})/series$`),
    new RegExp(`^/studies/(${UID})/series/(${UID})/metadata$`), new RegExp(`^${SCOPED}$`)];

function fixedPeer(value) {
    let url; try { url = new URL(value); } catch { throw new TypeError('Configure a fixed HTTP loopback Store root.'); }
    if (typeof value !== 'string' || url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || url.pathname !== '/' ||
        url.username || url.password || url.search || url.hash || value.includes('?') || value.includes('#')) {
        throw new TypeError('Configure a fixed HTTP loopback Store root without paths or credentials.');
    }
    return url.origin;
}
function allowedRequest(request) {
    let host;
    try { host = new URL(`http://${request.headers.host}`); } catch { return false; }
    if (!LOOPBACK.has(host.hostname) || host.username || host.password || host.pathname !== '/' || host.search || host.hash) return false;
    if (request.socket?.localPort && Number(host.port || 80) !== request.socket.localPort) return false;
    if (request.headers.origin && request.headers.origin !== host.origin) return false;
    return true;
}
function headersFor(request) {
    const headers = {};
    const token = typeof request.headers.authorization === 'string' && /^Bearer [A-Za-z0-9_.-]{1,512}$/.test(request.headers.authorization)
        ? request.headers.authorization : null;
    if (token) headers.Authorization = token;
    else {
        // Loopback applications deliberately share the Store HttpOnly session on
        // the same hostname. Forward only this cookie, only to the fixed Store.
        const cookie = (request.headers.cookie || '').split(';').map(value => value.trim()).find(value => /^easi_store_session=[A-Za-z0-9_-]{1,128}$/.test(value));
        if (cookie) headers.Cookie = cookie;
    }
    return headers;
}
function fail(response, status, message) {
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(message);
}
async function jsonBody(body, signal, max = 8 * 1024 * 1024) {
    const chunks = []; let length = 0;
    if (!body) throw new Error('Missing JSON body.');
    const reader = body.getReader();
    try {
        while (true) {
            signal.throwIfAborted(); const { done, value } = await reader.read(); if (done) break;
            length += value.byteLength; if (length > max) throw new Error('Metadata response exceeds the local bridge limit.');
            chunks.push(value);
        }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function proxiedBulkUris(value, depth = 0) {
    if (depth > 64) throw new Error('Metadata nesting exceeds the bridge limit.');
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
        if (key === 'BulkDataURI' && typeof child === 'string' && child.startsWith('/dicomweb/')) value[key] = PREFIX + child;
        else if (child && typeof child === 'object') proxiedBulkUris(child, depth + 1);
    }
}

/** Fixed, read-only local integration. No wildcard CORS, login proxy, arbitrary
 * destination, credential persistence, query logging or medical-data cache. */
export function createEasiStoreProxy({ upstream = 'http://127.0.0.1:8048',
    association = { host: '127.0.0.1', port: 4248, calledAeTitle: 'EASISTORE', callingAeTitle: 'EASI_VIEW' },
    dimseFactory = createDimseGateway, maxConcurrent = 4 } = {}) {
    const store = fixedPeer(upstream), gateways = new Map();
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) throw new TypeError('Use a bounded local bridge connection limit.');
    let active = 0;
    return async (request, response) => {
        let url; try { url = new URL(request.url, 'http://localhost'); } catch { return false; }
        if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) return false;
        if (!allowedRequest(request)) { fail(response, 403, 'The Store bridge accepts same-origin loopback requests only.'); return true; }
        if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); fail(response, 405, 'The Store bridge provides read-only access.'); return true; }
        const session = url.pathname === PREFIX + '/session';
        const isDimse = url.pathname.startsWith(PREFIX + '/dimse/');
        const isWeb = url.pathname.startsWith(PREFIX + '/dicomweb/');
        const path = isDimse ? url.pathname.slice((PREFIX + '/dimse').length) : isWeb ? url.pathname.slice((PREFIX + '/dicomweb').length) : '';
        const routes = isDimse ? DIMSE_ROUTES : HTTP_ROUTES;
        if ((!session && !isDimse && !isWeb) || !session && !routes.some(route => {
            const match = path.match(route); return match && match.slice(1).every(uid => uid.length <= 64);
        }) || request.url.length > 8192 || url.pathname.includes('%')) {
            fail(response, 404, 'Unknown Store bridge route.'); return true;
        }
        if (active >= maxConcurrent) { fail(response, 429, 'The Store bridge is busy. Retry after the current requests.'); return true; }
        active++;
        const controller = new AbortController();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(65000)]);
        const closed = () => { if (!response.writableEnded) controller.abort(); };
        response.on('close', closed); request.on('aborted', closed);
        try {
            const credentials = headersFor(request);
            if (!session && !Object.keys(credentials).length) { fail(response, 401, `Sign in to EASI Store at ${store}/ using the same loopback hostname, then retry.`); return true; }
            if (isDimse || session) {
                const check = await fetch(store + '/api/v1/session', { headers: credentials, signal, redirect: 'error', cache: 'no-store' });
                if (!check.ok) { await check.body?.cancel(); throw new Error('Store authentication check failed.'); }
                const state = await jsonBody(check.body, signal, 4096);
                if (session) { response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify({ authenticated: state.authenticated === true, setupRequired: state.setupRequired === true })); return true; }
                if (state.authenticated !== true) { fail(response, 401, `Sign in to EASI Store at ${store}/, then retry.`); return true; }
                const origin = `http://${request.headers.host}`;
                if (!gateways.has(origin)) gateways.set(origin, dimseFactory({ association, publicOrigin: origin,
                    // Authentication is checked above for every request before
                    // this private fixed-peer handler can run.
                    authorize: async () => true, transportFactory: () => new EasiStoreDimseTransport(), basePath: '/dimse' }));
                const previous = request.url; request.url = '/dimse' + path + url.search;
                try { await gateways.get(origin)(request, response); } finally { request.url = previous; }
                return true;
            }
            const headers = { ...credentials, 'X-EASI-Store-Public-Base': '/easi-store/dicomweb' };
            if (typeof request.headers.accept === 'string') headers.Accept = request.headers.accept;
            const peer = await fetch(store + '/dicomweb' + path + url.search, { headers, redirect: 'error', cache: 'no-store', signal });
            if (!peer.ok) {
                await peer.body?.cancel();
                fail(response, peer.status, peer.status === 401 ? `Sign in to EASI Store at ${store}/, then retry.` : `EASI Store returned HTTP ${peer.status}.`); return true;
            }
            response.setHeader('Cache-Control', 'no-store'); response.statusCode = peer.status;
            const contentType = peer.headers.get('content-type'); if (contentType) response.setHeader('Content-Type', contentType);
            if (/\b299\b/.test(peer.headers.get('warning') || '')) response.setHeader('Warning', '299 local-store-preview "The archive limited these results."');
            if (/^application\/dicom\+json(?:;|$)/i.test(contentType || '')) {
                const metadata = await jsonBody(peer.body, signal); proxiedBulkUris(metadata);
                response.end(JSON.stringify(metadata));
            } else if (peer.body) await pipeline(Readable.fromWeb(peer.body), response, { signal });
            else response.end();
        } catch {
            if (!response.destroyed) { if (!response.headersSent) fail(response, 502, 'EASI Store is unavailable or returned an unsupported response. Check the local Store service.'); else response.destroy(); }
        } finally { active--; response.off('close', closed); request.off('aborted', closed); }
        return true;
    };
}
