import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { watch } from 'node:fs';
import { spawn } from 'node:child_process';

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
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };
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
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' http: https:; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
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
    watchers.push(watch(resolve(root, 'index.html'), changed));
}
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => {
    clearTimeout(timer);
    watchers.forEach(watcher => watcher.close());
    server.close(() => process.exit(0));
});
