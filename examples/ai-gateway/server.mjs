import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { AiGateway, aiRequestByteLimit } from './gateway.mjs';
import { createConfiguredProvider } from './provider-selection.mjs';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
export function createAiServer({ gateway, staticDirectory } = {}) {
    if (!(gateway instanceof AiGateway)) throw new Error('An AI gateway is required.');
    const server = http.createServer(async (request, response) => {
        const controller = new AbortController();
        request.on('aborted', () => controller.abort()); response.on('close', () => { if (!response.writableEnded) controller.abort(); });
        try {
            const path = new URL(request.url, 'http://localhost').pathname;
            if (!path.startsWith('/api/ai/') && staticDirectory && ['GET', 'HEAD'].includes(request.method)) {
                const root = await realpath(staticDirectory), file = await realpath(resolve(root, `.${decodeURIComponent(path === '/' ? '/index.html' : path)}`));
                if (!file.startsWith(`${root}${sep}`) || !(await stat(file)).isFile()) { response.writeHead(404); response.end(); return; }
                response.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
                response.end(request.method === 'HEAD' ? undefined : await readFile(file)); return;
            }
            const chunks = []; let bytes = 0;
            for await (const chunk of request) {
                bytes += chunk.length;
                if (bytes > aiRequestByteLimit(path)) { response.writeHead(413, { 'Cache-Control': 'no-store' }); response.end(); return; }
                chunks.push(chunk);
            }
            const output = await gateway.handle({ method: request.method, path, headers: request.headers, body: Buffer.concat(chunks).toString('utf8'), ip: request.socket.remoteAddress, signal: controller.signal });
            response.writeHead(output.status, output.headers); response.flushHeaders();
            if (typeof output.body === 'string') response.end(output.body);
            else await pipeline(Readable.from(output.body), response);
        } catch {
            if (!response.headersSent) response.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
            response.end();
        }
    });
    server.requestTimeout = 65000; server.headersTimeout = 10000;
    return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
    if (!args.includes('--passcode-file')) throw new Error('Use --passcode-file with a private local invitation-code file. Never put an access code in command arguments.');
    const file = await readFile(value('--passcode-file'), 'utf8'), passcode = file.trim().startsWith('{') ? JSON.parse(file).passcode : file.trim();
    const port = Number(args.includes('--port') ? value('--port') : 5188);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port.');
    const providerName = args.includes('--provider') ? value('--provider') : 'bedrock';
    let openAiApiKey;
    if (args.includes('--openai-key-file')) {
        const path = value('--openai-key-file'), details = await stat(path);
        if (!details.isFile() || details.size > 16384 || (details.mode & 0o077) !== 0) throw new Error('The OpenAI server key file must be a small private mode-0600 file.');
        const content = await readFile(path, 'utf8');
        if (content.length > 16384) throw new Error('The OpenAI key file exceeds its limit.');
        openAiApiKey = content;
    }
    const origin = `http://127.0.0.1:${port}`, provider = await createConfiguredProvider({ provider: providerName, modelId: args.includes('--model') ? value('--model') : undefined,
        openAiApiKey, openAiApiKeySecretArn: args.includes('--openai-secret-arn') ? value('--openai-secret-arn') : undefined });
    const gateway = new AiGateway({ provider, passcode, secureCookies: false, allowedOrigins: [origin], requireModelBinding: true });
    const server = createAiServer({ gateway, staticDirectory: args.includes('--static') ? value('--static') : undefined });
    server.listen(port, '127.0.0.1', () => process.stdout.write(`AI demonstration ready at ${origin}/api/ai/login (${providerName}; local invitation required).\n`));
}
