import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { watch } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { createOrthancProxy } from './orthanc-proxy.mjs';
import { createEasiStoreProxy } from './easi-store-proxy.mjs';
import { createStorageConnections } from './storage-connections.mjs';

const root = resolve(import.meta.dirname, '..');
const directory = resolve(root, 'dist');
const production = process.argv.includes('--production');
const port = Number(process.env.EASI_VIEW_PORT || 5174);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('EASI_VIEW_PORT must be 1024–65535.');

function rebuild() {
    return new Promise((accept, reject) => {
        const child = spawn(process.execPath, [resolve(root, 'tools/build.mjs')], { cwd: root, stdio: 'inherit' });
        child.on('error', reject);
        child.on('exit', code => code === 0 ? accept() : reject(new Error('Build failed.')));
    });
}
if (!production) await rebuild();
await stat(resolve(directory, 'index.html'));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm' };
const orthancProxy = createOrthancProxy();
const storeHttpPort = Number(process.env.EASI_VIEW_STORE_HTTP_PORT || 8048);
const storeDimsePort = Number(process.env.EASI_VIEW_STORE_DIMSE_PORT || 4248);
if (![storeHttpPort, storeDimsePort].every(value => Number.isInteger(value) && value >= 1024 && value <= 65535)) throw new Error('EASI View Store ports must be 1024–65535.');
const easiStoreProxy = createEasiStoreProxy({ upstream: `http://127.0.0.1:${storeHttpPort}`, association: { host: '127.0.0.1', port: storeDimsePort, calledAeTitle: 'EASISTORE', callingAeTitle: 'EASI_VIEW' } });
const profileDirectory = process.env.EASI_VIEW_CONFIG_DIR || (process.platform === 'darwin'
    ? resolve(homedir(), 'Library/Application Support/EASI View')
    : process.platform === 'win32' ? resolve(process.env.APPDATA || homedir(), 'EASI View')
        : resolve(process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config'), 'easi-view'));
const storageConnections = await createStorageConnections({ profilePath: resolve(profileDirectory, `storage-sources-${port}.json`) });
export function requestedPath(requestUrl) {
    let decoded;
    try { decoded = decodeURIComponent(new URL(requestUrl, 'http://localhost').pathname); } catch { return null; }
    if (decoded.includes('\0') || decoded.includes('\\')) return null;
    const target = resolve(directory, '.' + (decoded === '/' ? '/index.html' : decoded));
    return target.startsWith(directory + sep) ? target : null;
}
const server = createServer(async (request, response) => {
    const target = requestedPath(request.url);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    let styleHash;
    try {
        styleHash = JSON.parse(await readFile(resolve(directory, 'build-info.json'), 'utf8')).inlineStyleSha256;
        if (typeof styleHash !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(styleHash)) throw new Error('Invalid stylesheet hash.');
    } catch {
        response.writeHead(503);
        response.end('Viewer assets are rebuilding. Refresh shortly.');
        return;
    }
    response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'sha256-${styleHash}'; img-src 'self' data: blob:; connect-src 'self' http: https:; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`);
    if (await orthancProxy(request, response)) return;
    if (await easiStoreProxy(request, response)) return;
    if (await storageConnections(request, response)) return;
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
    if (!target) { response.writeHead(404); response.end(); return; }
    try {
        if (!(await stat(target)).isFile()) throw new Error('Not a file.');
        const bytes = await readFile(target);
        response.setHeader('Content-Type', types[extname(target)] || 'text/plain; charset=utf-8');
        response.setHeader('Content-Length', bytes.length);
        response.writeHead(200);
        response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch { response.writeHead(404); response.end('Not found.'); }
});
server.listen(port, '127.0.0.1', () => console.log(`EASI View: http://127.0.0.1:${port}/`));
const watchers = [];
let timer;
let rebuilding = false;
let queued = false;
if (!production) {
    const changed = () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
            if (rebuilding) { queued = true; return; }
            rebuilding = true;
            try { await rebuild(); console.log('Rebuilt. Refresh the browser to see changes.'); }
            catch { console.error('Build failed; fix the reported source error.'); }
            finally { rebuilding = false; if (queued) { queued = false; changed(); } }
        }, 150);
    };
    watchers.push(watch(resolve(root, 'src'), { recursive: true }, changed));
    watchers.push(watch(resolve(root, 'public'), { recursive: true }, changed));
    watchers.push(watch(resolve(root, 'index.html'), changed));
}
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => {
    clearTimeout(timer);
    watchers.forEach(watcher => watcher.close());
    Promise.resolve(storageConnections.close()).finally(() => server.close(() => process.exit(0)));
});
