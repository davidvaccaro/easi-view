// Optional loopback-only configuration service for the standalone development
// viewer. Each gateway is bound to a saved, explicit DIMSE peer; URL queries
// cannot select sockets. This is a research connector, not a PACS TLS service.
import { lookup as lookupHost } from 'node:dns/promises';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { DimseClient } from '@xinonix/easi-js/dimse/node';
import { createDimseGateway, DIMSE_GATEWAY_LIMITS } from '../examples/dimse-gateway/gateway.mjs';
import { EasiStoreDimseTransport } from './easi-store-dimse-transport.mjs';

const PREFIX = '/storage-connections';
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_PROFILES = 32, MAX_JSON = 16384, MAX_FILE = 65536;
const LOCAL_ERROR = Symbol('local connector error');
const failure = (status, message) => Object.assign(new Error(message), { status, [LOCAL_ERROR]: true });
const plain = value => value && typeof value === 'object' && [null, Object.prototype].includes(Object.getPrototypeOf(value));
const hasOnly = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));

class LocalDimseTransport extends EasiStoreDimseTransport {
    async read(peer, options) {
        try { return await super.read(peer, options); }
        catch {
            options.signal?.throwIfAborted();
            // Peer/library exception messages and typed HTTP-like statuses are
            // never trusted as browser-safe gateway diagnostics.
            throw new Error('The configured DIMSE peer did not complete the operation.');
        }
    }
}

function address(value) {
    if (typeof value !== 'string' || value.includes('%') || !isIP(value)) return null;
    if (isIP(value) === 4) return value;
    const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([a-f\d]{1,4}):([a-f\d]{1,4})$/.exec(normalized);
    if (!mapped) return normalized;
    const a = Number.parseInt(mapped[1], 16), b = Number.parseInt(mapped[2], 16);
    return `${a >>> 8}.${a & 255}.${b >>> 8}.${b & 255}`;
}
const loopback = value => { const normalized = address(value); return normalized === '::1' || normalized?.startsWith('127.') === true; };

export function allowedStorageAddress(value) {
    const normalized = address(value);
    if (!normalized) return false;
    if (isIP(normalized) === 4) {
        const [a, b] = normalized.split('.').map(Number);
        return a !== 0 && a < 224 && !(a === 169 && b === 254) && normalized !== '100.100.100.200';
    }
    return normalized !== '::' && !normalized.startsWith('ff') && !/^fe[89ab]/.test(normalized)
        && normalized !== 'fd00:ec2::254';
}

function hostName(value) {
    if (typeof value !== 'string' || value.length > 253 || !value || value !== value.trim()) throw failure(400, 'Use a DIMSE host name or literal IP address.');
    if (isIP(value)) {
        if (!allowedStorageAddress(value)) throw failure(400, 'This DIMSE address is not allowed. Metadata, link-local, unspecified and multicast addresses cannot be targets.');
        return address(value);
    }
    let shorthand = false;
    try { shorthand = !!isIP(new URL(`http://${value}`).hostname); } catch { /* The DNS syntax check below rejects invalid names. */ }
    if (!/^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)*\.?$/i.test(value)
        || /^\d+(?:\.\d+)*\.?$/.test(value) || shorthand) throw failure(400, 'Use a DIMSE host name without URL schemes, paths, ports, credentials or IP shorthand.');
    return value.toLowerCase().replace(/\.$/, '');
}

function profile(input, id) {
    if (!hasOnly(input, ['name', 'remember', 'dimse']) || typeof input.name !== 'string'
        || !input.name.trim() || input.name.length > 100 || /[\x00-\x1f\x7f]/.test(input.name)
        || typeof input.remember !== 'boolean' || !hasOnly(input.dimse, ['host', 'port', 'callingAeTitle', 'calledAeTitle'])) {
        throw failure(400, 'Use a name, a remember choice and a DIMSE host/port/calling/called AE configuration.');
    }
    const dimse = input.dimse;
    if (!Number.isInteger(dimse.port) || dimse.port < 1 || dimse.port > 65535
        || ['callingAeTitle', 'calledAeTitle'].some(key => typeof dimse[key] !== 'string' || !/^[\x20-\x7e]{1,16}$/.test(dimse[key])
            || !dimse[key].trim() || dimse[key] !== dimse[key].trim() || dimse[key].includes('\\'))) {
        throw failure(400, 'Use a port from 1–65535 and nonempty calling/called AE titles of at most 16 printable characters.');
    }
    return { id, name: input.name.trim(), remember: input.remember,
        dimse: { host: hostName(dimse.host), port: dimse.port, callingAeTitle: dimse.callingAeTitle, calledAeTitle: dimse.calledAeTitle } };
}

function originFor(request) {
    let target;
    try { target = new URL(`http://${request.headers.host}`); } catch { return null; }
    if (!HOSTS.has(target.hostname) || target.username || target.password || target.pathname !== '/' || target.search || target.hash
        || !Number.isInteger(request.socket?.localPort) || Number(target.port || 80) !== request.socket.localPort
        || !loopback(request.socket.remoteAddress) || !loopback(request.socket.localAddress)
        || request.headers.origin && request.headers.origin !== target.origin
        || request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])) return null;
    return target.origin;
}

function json(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    response.end(value === undefined ? undefined : JSON.stringify(value));
}

async function requestJson(request) {
    if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw failure(415, 'Use application/json for local connector configuration.');
    const declared = Number(request.headers['content-length']);
    if (declared > MAX_JSON) { request.resume(); throw failure(413, 'Local connector configuration is too large.'); }
    const parts = []; let length = 0;
    for await (const part of request) {
        length += part.byteLength;
        if (length > MAX_JSON) throw failure(413, 'Local connector configuration is too large.');
        parts.push(part);
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))); }
    catch { throw failure(400, 'Use valid JSON for local connector configuration.'); }
}

function wait(operation, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const aborted = () => reject(signal.reason || new DOMException('Canceled', 'AbortError'));
        signal.addEventListener('abort', aborted, { once: true });
        Promise.resolve(operation).then(value => { signal.removeEventListener('abort', aborted); resolve(value); }, error => {
            signal.removeEventListener('abort', aborted); reject(error);
        });
    });
}

export function defaultStorageProfilePath() {
    const directory = process.platform === 'darwin' ? path.join(homedir(), 'Library/Application Support/EASI View')
        : process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData/Local'), 'EASI View')
            : path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'easi-view');
    return path.join(directory, 'storage-connections.json');
}

/** No PACS requests occur during creation, listing or restoration. The returned
 * async handler also exposes close() to cancel in-flight operations on shutdown.
 * profilePath:null disables disk persistence (useful for disposable test servers).
 */
export async function createStorageConnections({ profilePath = defaultStorageProfilePath(), lookup = lookupHost,
    echo = (peer, options) => new DimseClient(peer).echo(options), gatewayFactory = createDimseGateway,
    operationTimeoutMs = 15000, maxConcurrent = 2 } = {}) {
    if (profilePath !== null && (typeof profilePath !== 'string' || !path.isAbsolute(profilePath))) throw new TypeError('Configure an absolute private connector profile path.');
    if (typeof lookup !== 'function' || typeof echo !== 'function' || typeof gatewayFactory !== 'function'
        || !Number.isInteger(operationTimeoutMs) || operationTimeoutMs < 10 || operationTimeoutMs > 60000
        || !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 4) throw new TypeError('Configure bounded local connector operations.');
    let records = new Map(), closed = false, changed = Promise.resolve(), queued = 0, persisted = false;
    const running = new Set();
    if (profilePath) {
        try {
            const info = await lstat(profilePath);
            if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE || process.platform !== 'win32' && (info.mode & 0o077)) {
                throw new Error('The local connector profile must be a private owner-only regular file.');
            }
            const value = JSON.parse(await readFile(profilePath, 'utf8'));
            if (!hasOnly(value, ['version', 'profiles']) || value.version !== 1 || !Array.isArray(value.profiles) || value.profiles.length > MAX_PROFILES) throw new Error();
            for (const input of value.profiles) {
                if (!hasOnly(input, ['id', 'name', 'remember', 'dimse']) || !ID.test(input.id) || input.remember !== true || records.has(input.id)) throw new Error();
                const { id, ...values } = input; records.set(id, profile(values, id));
            }
            persisted = true;
        } catch (error) {
            if (error.code !== 'ENOENT') throw new Error('The saved local connector profiles could not be loaded. Check the private configuration file and permissions.');
        }
    }
    async function persist(next) {
        if (!profilePath) return;
        const profiles = [...next.values()].filter(item => item.remember);
        if (!persisted && !profiles.length) return;
        const directory = path.dirname(profilePath), temporary = `${profilePath}.${randomUUID()}.tmp`;
        await mkdir(directory, { recursive: true, mode: 0o700 });
        try {
            const file = await open(temporary, 'wx', 0o600);
            try { await file.writeFile(JSON.stringify({ version: 1, profiles }) + '\n'); await file.sync(); } finally { await file.close(); }
            await rename(temporary, profilePath);
            if (process.platform !== 'win32') { const directoryFile = await open(directory, 'r'); try { await directoryFile.sync(); } finally { await directoryFile.close(); } }
            persisted = true;
        } finally { await rm(temporary, { force: true }); }
    }
    async function mutate(operation) {
        if (queued >= 4) throw failure(429, 'Local connector settings are busy. Retry shortly.');
        queued++;
        const task = changed.then(async () => {
            if (closed) throw failure(503, 'The local connector is stopping.');
            const next = new Map(records), result = operation(next);
            await persist(next); records = next; return result;
        });
        changed = task.catch(() => {});
        try { return await task; } finally { queued--; }
    }
    function cancelProfile(id) { for (const operation of running) if (operation.id === id) { operation.controller.abort(); operation.response.destroy(); } }
    async function resolvedPeer(record, signal) {
        const host = record.dimse.host;
        if (isIP(host)) return { ...record.dimse, host };
        let answers;
        try { answers = await wait(lookup(host, { all: true, verbatim: true }), signal); }
        catch { signal.throwIfAborted(); throw failure(502, 'The DIMSE host could not be resolved. Check its configuration.'); }
        signal.throwIfAborted();
        if (!Array.isArray(answers) || !answers.length || answers.length > 32 || answers.some(item => !allowedStorageAddress(item.address))) {
            throw failure(400, 'The DIMSE host resolves to an address that the local connector cannot use.');
        }
        // Pass a validated literal to the socket transport. It cannot perform a
        // second DNS lookup and follow a rebinding to a forbidden address.
        return { ...record.dimse, host: address(answers[0].address) };
    }
    const descriptor = (record, origin) => ({ ...structuredClone(record), baseUrl: `${origin}${PREFIX}/${record.id}/dimse/` });
    const handler = async (request, response) => {
        let url;
        try { url = new URL(request.url, 'http://connector.invalid'); } catch { return false; }
        if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) return false;
        const origin = originFor(request);
        if (!origin) { json(response, 403, { error: 'The local connector accepts same-origin loopback requests only.' }); return true; }
        if (closed) { json(response, 503, { error: 'The local connector is stopping.' }); return true; }
        if (request.url.length > 8192 || url.pathname.includes('%')) { json(response, 404, { error: 'Unknown local connector route.' }); return true; }
        const parts = url.pathname.slice(PREFIX.length).split('/').filter(Boolean), id = parts[0], action = parts[1];
        const gateway = parts.length >= 3 && action === 'dimse';
        const method = request.method;
        if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) { response.setHeader('Allow', 'GET, POST, PUT, DELETE'); json(response, 405, { error: 'Unsupported local connector method.' }); return true; }
        if (method !== 'GET' && request.headers['x-easi-view'] !== '1') { json(response, 403, { error: 'Include X-EASI-View: 1 for local connector actions.' }); return true; }
        try {
            if (!parts.length && method === 'GET' && !url.search) {
                json(response, 200, { available: true, profiles: [...records.values()].map(item => descriptor(item, origin)),
                    limits: { maxProfiles: MAX_PROFILES, maxConcurrent, operationTimeoutMs }, dicomTls: false }); return true;
            }
            if (!parts.length && method === 'POST' && !url.search) {
                const input = await requestJson(request), record = profile(input, randomUUID());
                await mutate(next => { if (next.size >= MAX_PROFILES) throw failure(409, 'The local connector supports at most 32 configured peers.'); next.set(record.id, record); });
                json(response, 201, descriptor(record, origin)); return true;
            }
            if (!ID.test(id || '')) throw failure(404, 'Unknown local connector profile.');
            if (parts.length === 1 && method === 'PUT' && !url.search) {
                const input = await requestJson(request), record = profile(input, id);
                await mutate(next => { if (!next.has(id)) throw failure(404, 'Unknown local connector profile.'); next.set(id, record); });
                cancelProfile(id); json(response, 200, descriptor(record, origin)); return true;
            }
            if (parts.length === 1 && method === 'DELETE' && !url.search) {
                await mutate(next => { if (!next.delete(id)) throw failure(404, 'Unknown local connector profile.'); });
                cancelProfile(id); json(response, 204); return true;
            }
            const record = records.get(id);
            if (!record) throw failure(404, 'Unknown local connector profile.');
            if (!(parts.length === 2 && action === 'echo' && method === 'POST' && !url.search) && !(gateway && method === 'GET')) {
                throw failure(404, 'Unknown local connector route.');
            }
            if (running.size >= maxConcurrent) throw failure(429, 'The local DIMSE connector is busy. Retry after the current operation.');
            const deadline = Date.now() + operationTimeoutMs;
            const controller = new AbortController(), timeout = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), operationTimeoutMs);
            const operation = { id, controller, response }; running.add(operation);
            const canceled = () => { if (!response.writableEnded) controller.abort(); };
            response.on('close', canceled); request.on('aborted', canceled);
            try {
                if (!gateway) {
                    const body = await requestJson(request);
                    if (!hasOnly(body, [])) throw failure(400, 'C-ECHO accepts an empty JSON object and uses the configured peer.');
                }
                const peer = await resolvedPeer(record, controller.signal);
                if (gateway) {
                    const previous = request.url;
                    request.url = '/dimse/' + parts.slice(2).join('/') + url.search;
                    const serve = gatewayFactory({ association: peer, publicOrigin: origin, authorize: async () => true, basePath: '/dimse',
                        transportFactory: () => new LocalDimseTransport(), limits: { ...DIMSE_GATEWAY_LIMITS, maxConcurrent: Math.min(maxConcurrent, 2), operationTimeoutMs: Math.max(1, deadline - Date.now()) } });
                    try { await serve(request, response); } finally { request.url = previous; }
                } else {
                    const result = await wait(echo({ ...peer, timeoutMs: operationTimeoutMs }, { signal: controller.signal, operationTimeoutMs }), controller.signal);
                    if (result?.status !== 0) throw failure(502, 'The DIMSE peer did not complete C-ECHO successfully.');
                    json(response, 200, { ok: true, summary: 'DIMSE C-ECHO succeeded.', checks: [{ name: 'DIMSE C-ECHO', status: 'passed' }],
                        scope: 'Verification only; query, retrieval and image rendering are tested separately.' });
                }
            } finally { clearTimeout(timeout); running.delete(operation); response.off('close', canceled); request.off('aborted', canceled); }
        } catch (error) {
            if (!response.destroyed) {
                if (response.headersSent) response.destroy();
                else {
                    const status = ['AbortError', 'TimeoutError'].includes(error?.name) ? 504 : error?.[LOCAL_ERROR] ? error.status : 502;
                    json(response, status, { error: status === 504 ? 'The local DIMSE operation was canceled or timed out.'
                        : error?.[LOCAL_ERROR] ? error.message : 'The local DIMSE connector could not complete the operation. Check the peer and its calling-AE/IP rules.' });
                }
            }
        }
        return true;
    };
    handler.close = async () => { closed = true; for (const operation of running) { operation.controller.abort(); operation.response.destroy(); } await changed; };
    handler.getState = () => Object.freeze({ activeRequests: running.size, profiles: records.size });
    return handler;
}
