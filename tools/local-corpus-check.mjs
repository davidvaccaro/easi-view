import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir, mkdtemp, rm, stat, lstat, rename } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { browserSession, delay } from './browser-session.mjs';
import { sourceDigest } from './source-digest.mjs';

const root = resolve(import.meta.dirname, '..');
const help = `Run the private local DICOM collection through the built EASI View SDK.

Usage: npm run test:corpus -- --directory /path/to/local/dicoms

  --directory PATH    Required local input directory (never served or uploaded)
  --output PATH       Local report directory (default artifacts/local-corpus/latest)
  --timeout-ms N      Per-file operation timeout (default 120000)
  --sample-frames     Test first/middle/last frames instead of every frame
  --match TEXT        Explicit filename subset, case-insensitive
  --limit N           Explicit maximum number of files to test
  --offset N          Zero-based offset into the sorted inventory
  --inventory PATH    Private frozen inventory supplied by a campaign
  --help              Show these instructions

Run npm run check first. All frames are tested by default, one file at a time.
Exit codes: 0 every selected file passed; 1 unsuccessful files; 2 harness/setup error.
Reports are private operational evidence, not a clinical image-correctness proof.
`;

export function parseArguments(argv, cwd = process.cwd()) {
    const options = { directory: null, output: resolve(root, 'artifacts/local-corpus/latest'), timeoutMs: 120000,
        allFrames: true, match: undefined, limit: undefined, offset: 0, inventory: null, workRoot: null, help: false };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--help') { options.help = true; continue; }
        if (arg === '--sample-frames') { options.allFrames = false; continue; }
        const names = { '--directory': 'directory', '--output': 'output', '--timeout-ms': 'timeoutMs', '--match': 'match', '--limit': 'limit', '--offset': 'offset', '--inventory': 'inventory', '--work-root': 'workRoot' };
        const key = names[arg];
        if (!key) throw new Error(`Unknown argument: ${arg}`);
        const value = argv[++index];
        if (!value || value.startsWith('--')) throw new Error(`A value is required for ${arg}.`);
        if (key === 'directory' || key === 'output' || key === 'inventory' || key === 'workRoot') options[key] = resolve(cwd, value);
        else if (key === 'timeoutMs' || key === 'limit' || key === 'offset') {
            if (!/^\d+$/.test(value)) throw new Error(`${arg} requires a positive integer.`);
            options[key] = Number(value);
            if (!Number.isSafeInteger(options[key]) || options[key] < (key === 'offset' ? 0 : 1) ||
                (key === 'timeoutMs' && (options[key] < 1000 || options[key] > 600000)) ||
                (key === 'limit' && options[key] > 100000) || (key === 'offset' && options[key] > 100000)) throw new Error(`${arg} is outside its supported range.`);
        } else options[key] = value;
    }
    if (!options.help && !options.directory) throw new Error('Specify --directory to explicitly opt in to testing local DICOM files.');
    if (options.inventory && options.match) throw new Error('Inventory selection cannot also use --match.');
    if (options.workRoot && !options.workRoot.startsWith(options.output + sep)) throw new Error('Managed browser work must be inside this report output directory.');
    if (options.directory && (options.output === options.directory || options.output.startsWith(options.directory + sep))) {
        throw new Error('The report directory must be outside the input collection.');
    }
    return options;
}

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8' };

export async function startCorpusServer({ dist, host, styleHash }) {
    const roots = { dist: resolve(dist), host: resolve(host) };
    if (!/^[A-Za-z0-9+/]{43}=$/.test(styleHash)) throw new Error('The built viewer stylesheet hash is invalid.');
    const requests = { served: 0, rejectedMethods: 0 };
    const server = createServer(async (request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'sha256-${styleHash}'; connect-src 'self'; worker-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
        if (!['GET', 'HEAD'].includes(request.method)) { requests.rejectedMethods++; response.writeHead(405); response.end(); return; }
        let path;
        try { path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname); } catch { response.writeHead(404); response.end(); return; }
        const hostRequest = path.startsWith('/qa-corpus/');
        const base = hostRequest ? roots.host : roots.dist;
        const relative = hostRequest ? path.slice('/qa-corpus/'.length) || 'index.html' : path.slice(1);
        const target = resolve(base, relative);
        if (path.includes('\0') || path.includes('\\') || !target.startsWith(base + sep)) { response.writeHead(404); response.end(); return; }
        try {
            if (!(await stat(target)).isFile()) throw new Error('Not a static asset.');
            const bytes = await readFile(target);
            response.writeHead(200, { 'Content-Type': types[extname(target)] || 'application/octet-stream', 'Content-Length': bytes.length });
            response.end(request.method === 'HEAD' ? undefined : bytes); requests.served++;
        } catch { response.writeHead(404); response.end(); }
    });
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
    return { url: `http://127.0.0.1:${server.address().port}/qa-corpus/`, requests,
        close: async () => { server.closeAllConnections(); await new Promise(accept => server.close(accept)); } };
}

async function hashFile(path) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
}

function totals(results) {
    const counts = { passed: 0, failed: 0, unsupported: 0, invalid: 0 };
    for (const result of results) counts[result.status in counts ? result.status : 'failed']++;
    return counts;
}

export async function main(argv = process.argv.slice(2)) {
    const options = parseArguments(argv);
    if (options.help) { console.log(help); return 0; }
    const { discoverCorpus, readCorpusInventory, selectCorpus, corpusFingerprint, classifyFailure, renderCorpusReport, renderCorpusCsv } = await import('./local-corpus.mjs');
    const { writeCorpusHost, initializeCorpusBrowser, exerciseCorpusFile } = await import('./local-corpus-browser.mjs');
    const { inspectCorpusFile } = await import('./local-corpus-profile.mjs');
    const candidates = options.inventory
        ? selectCorpus(await readCorpusInventory(options.inventory, options.directory), { offset: options.offset, ...(options.limit ? { limit: options.limit } : {}) })
        : await discoverCorpus(options.directory, { offset: options.offset, ...(options.match ? { match: options.match } : {}), ...(options.limit ? { limit: options.limit } : {}) });
    const selected = candidates;
    if (!selected.length) throw new Error('No DICOM files matched the selected collection.');
    const info = JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8'));
    if (info.sourceDigest !== await sourceDigest(root)) throw new Error('The viewer build is stale. Run npm run check before corpus verification.');
    await import('./check-dist.mjs');
    await mkdir(options.output, { recursive: true });
    if (options.workRoot) await mkdir(options.workRoot, { recursive: true });
    const work = await mkdtemp(resolve(options.workRoot ?? tmpdir(), 'easi-view-corpus-'));
    const report = { schemaVersion: 1, startedAt: new Date().toISOString(), completedAt: null, sourceDigest: info.sourceDigest,
        viewerVersion: info.version, easiJsVersion: info.easiJsVersion, directory: options.directory,
        selectionFingerprint: corpusFingerprint(selected),
        coverage: { discoveredFiles: candidates.discoveredCount ?? candidates.length, selectedFiles: selected.length, offset: options.offset, completeDirectory: !options.match && options.offset === 0 && selected.length === (candidates.discoveredCount ?? candidates.length), match: options.match ?? null,
            frameMode: options.allFrames ? 'all' : 'first-middle-last', perFileTimeoutMs: options.timeoutMs },
        scope: 'Local file parse, decode, renderer submission, tools, frames/cine and disposal. No diagnostic or independent clinical image-correctness claim.',
        network: { observed: false, uploads: null, externalRequests: null }, browser: null, results: [], summary: totals([]) };
    report.harnessSha256 = Object.fromEntries(await Promise.all(['local-corpus-check.mjs', 'local-corpus-browser.mjs', 'local-corpus.mjs', 'local-corpus-profile.mjs']
        .map(async name => [name, createHash('sha256').update(await readFile(resolve(root, 'tools', name))).digest('hex')])));
    let server, browser, interrupted = false;
    const interrupt = () => { interrupted = true; };
    process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
    let networkBase = { uploads: 0, externalRequests: 0 };
    const atomicWrite = async (name, contents) => {
        const target = resolve(options.output, name), temporary = target + '.tmp';
        await writeFile(temporary, contents); await rename(temporary, target);
    };
    const save = async () => {
        if (browser && server) {
            const origin = new URL(server.url).origin;
            report.network = { observed: true,
                uploads: Math.max(networkBase.uploads + browser.requests.filter(request => !['GET', 'HEAD', 'OPTIONS'].includes(request.method)).length, server.requests.rejectedMethods),
                externalRequests: networkBase.externalRequests + browser.requests.filter(request => {
                    try { const url = new URL(request.url); return ['http:', 'https:'].includes(url.protocol) && url.origin !== origin; }
                    catch { return false; }
                }).length };
        }
        report.summary = totals(report.results);
        const renderInput = { ...report, results: report.results.map(result => ({ ...result, ...result.file,
            ...result.profile, message: result.reason || '', frameCount: result.frameCount ?? result.profile?.frameCount })) };
        await atomicWrite('results.json', JSON.stringify(report, null, 2) + '\n');
        await atomicWrite('report.html', renderCorpusReport(renderInput));
        await atomicWrite('results.csv', renderCorpusCsv(renderInput));
    };
    try {
        await writeCorpusHost({ directory: resolve(work, 'host'), sdkUrl: '/assets/easi-view.js' });
        server = await startCorpusServer({ dist: resolve(root, 'dist'), host: resolve(work, 'host'), styleHash: info.inlineStyleSha256 });
        browser = await browserSession(resolve(work, 'browser'));
        report.browser = (await browser.send('Browser.getVersion')).product;
        await initializeCorpusBrowser({ browser, url: server.url });
        for (let index = 0; index < selected.length; index++) {
            if (interrupted) throw new Error('The corpus run was interrupted.');
            const file = selected[index];
            console.log(`[${index + 1}/${selected.length}] ${file.relativePath}`);
            let result;
            const started = performance.now();
            try {
                const input = await lstat(file.path);
                if (!input.isFile() || input.isSymbolicLink() || input.size !== file.bytes) throw new Error('Corpus input no longer matches its inventory.');
                const parsing = await inspectCorpusFile(file.path, { timeoutMs: options.timeoutMs });
                const remaining = Math.floor(options.timeoutMs - (performance.now() - started));
                if (remaining < 1000) throw new Error('Per-file time budget exhausted during parse.');
                result = await exerciseCorpusFile({ browser, path: file.path, timeoutMs: remaining, allFrames: options.allFrames });
                result.parsing = { passed: parsing.passed, instances: parsing.instances ?? 0, receivedBytes: parsing.receivedBytes ?? null, reason: parsing.reason ?? null };
                result.profile = { ...parsing.profile, ...result.profile };
                if (result.stage === 'open' && !result.cleanupFailure && parsing.passed &&
                    parsing.profile?.sopClass === '1.2.840.10008.1.3.10' && !parsing.profile.hasPixelData) {
                    result.status = 'unsupported'; result.reason = 'DICOMDIR is a directory index without a directly viewable pixel image.';
                }
                if (!parsing.passed && result.status === 'passed') { result.status = 'failed'; result.stage = 'parse'; result.reason = parsing.reason; }
                if (!['passed', 'failed', 'unsupported', 'invalid'].includes(result.status)) result.status = 'failed';
                if (result.status === 'failed' && !result.cleanupFailure) {
                    const category = classifyFailure(result.reason || '');
                    if (result.stage === 'open' && category !== 'unexpected') result.status = category;
                }
            } catch {
                result = { status: 'failed', stage: 'harness', reason: 'Browser operation failed or timed out; next file uses a fresh page.' };
                try { await initializeCorpusBrowser({ browser, url: server.url }); } catch { throw new Error('The isolated browser could not recover after a file failure.'); }
            }
            try {
                if (await hashFile(file.path) !== file.sha256) throw new Error('Source changed.');
                result.sourceUnchanged = true;
            } catch {
                result.status = 'failed'; result.stage = 'source-integrity'; result.reason = 'The source file changed or became unavailable during verification.'; result.sourceUnchanged = false;
            }
            const record = { file: { relativePath: file.relativePath, bytes: file.bytes, sha256: file.sha256 }, ...result,
                elapsedMs: Math.round(performance.now() - started) };
            report.results.push(record);
            console.log(`  ${record.status.toUpperCase()} · ${record.stage || 'session'} · ${record.framesChecked ?? 0} frames`);
            await save();
            networkBase = { uploads: report.network.uploads, externalRequests: report.network.externalRequests };
            browser.requests.length = 0; browser.errors.length = 0; browser.consoleErrors.length = 0;
        }
        if (interrupted) throw new Error('The corpus run was interrupted.');
        report.network.uploads = Math.max(networkBase.uploads + browser.requests.filter(request => !['GET', 'HEAD', 'OPTIONS'].includes(request.method)).length, server.requests.rejectedMethods);
        report.network.externalRequests = networkBase.externalRequests + browser.requests.filter(request => {
            try { const url = new URL(request.url); return ['http:', 'https:'].includes(url.protocol) && url.origin !== new URL(server.url).origin; }
            catch { return false; }
        }).length;
        if (report.network.uploads || report.network.externalRequests) throw new Error('The corpus harness attempted an unexpected network operation.');
        if (JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8')).sourceDigest !== report.sourceDigest ||
            await sourceDigest(root) !== report.sourceDigest) throw new Error('Viewer inputs changed during the corpus run. Repeat on a frozen build.');
        for (const [name, expected] of Object.entries(report.harnessSha256)) {
            if (createHash('sha256').update(await readFile(resolve(root, 'tools', name))).digest('hex') !== expected) throw new Error('Corpus driver changed during the run. Repeat on a frozen driver.');
        }
        report.completedAt = new Date().toISOString();
        await save();
        console.log(`Corpus: ${report.summary.passed}/${selected.length} passed, ${report.summary.failed} failed, ${report.summary.unsupported} unsupported, ${report.summary.invalid} invalid.`);
        console.log(`Private report: ${resolve(options.output, 'report.html')}`);
        return report.summary.passed === selected.length ? 0 : 1;
    } catch (error) {
        report.interrupted = interrupted;
        report.harnessError = interrupted ? 'The run was interrupted; completed cases are retained.' : 'The harness did not complete; this report is partial.';
        await save();
        if (interrupted) return 130;
        throw error;
    } finally {
        process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
        browser?.close();
        if (server) await server.close();
        await delay(250);
        await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().then(code => { process.exitCode = code; }, error => { console.error(`Corpus harness: ${error.message}`); process.exitCode = 2; });
}
