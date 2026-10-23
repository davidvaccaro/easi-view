import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, open, rename, rm, lstat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverCorpus, corpusFingerprint, validateCorpusInventory, MAX_CORPUS_FILES,
    renderCorpusReport, renderCorpusReportRows, renderCorpusCsv } from './local-corpus.mjs';
import { sourceDigest } from './source-digest.mjs';

const root = resolve(import.meta.dirname, '..');
const drivers = ['local-corpus-campaign.mjs', 'local-corpus-check.mjs', 'local-corpus-browser.mjs',
    'local-corpus.mjs', 'local-corpus-profile.mjs', 'browser-session.mjs'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const CHILD_DRIVERS = ['local-corpus-check.mjs', 'local-corpus-browser.mjs', 'local-corpus.mjs', 'local-corpus-profile.mjs'];
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const emptySummary = () => ({ passed: 0, failed: 0, unsupported: 0, invalid: 0 });
const batchName = index => 'batch-' + String(index).padStart(6, '0');
const help = 'Usage: node tools/local-corpus-campaign.mjs --directory PATH --output PATH [--batch-size 200] [--resume] [--sample-frames] [--timeout-ms 120000] [--max-files 100000]\n'
    + 'A private inventory is hashed once per invocation. Each deterministic batch uses a fresh isolated browser.\n'
    + 'Resume requires the exact same inputs, viewer, drivers and configuration. Incomplete batches are rerun.\n'
    + 'Exit codes: 0 all cases passed; 1 completed with other outcomes; 130 interrupted; 2 setup/harness error.\n';

export function parseCampaignArguments(argv, cwd = process.cwd()) {
    const options = { directory: null, output: null, batchSize: 200, timeoutMs: 120000,
        maxFiles: MAX_CORPUS_FILES, allFrames: true, resume: false, help: false };
    const names = { '--directory': 'directory', '--output': 'output', '--batch-size': 'batchSize',
        '--timeout-ms': 'timeoutMs', '--max-files': 'maxFiles' };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--resume') { options.resume = true; continue; }
        if (arg === '--sample-frames') { options.allFrames = false; continue; }
        if (arg === '--help') { options.help = true; continue; }
        const key = names[arg], value = argv[++index];
        if (!key) throw new Error('Unknown campaign argument: ' + arg);
        if (!value || value.startsWith('--')) throw new Error('A value is required for ' + arg + '.');
        if (key === 'directory' || key === 'output') options[key] = resolve(cwd, value);
        else {
            if (!/^\d+$/.test(value)) throw new Error(arg + ' requires a positive integer.');
            options[key] = Number(value);
        }
    }
    if (options.help) return options;
    return validateOptions(options);
}

function validateOptions(options) {
    if (typeof options.directory !== 'string' || typeof options.output !== 'string') throw new Error('Specify --directory and --output for the private campaign.');
    const result = { directory: resolve(options.directory), output: resolve(options.output),
        batchSize: options.batchSize ?? 200, timeoutMs: options.timeoutMs ?? 120000,
        maxFiles: options.maxFiles ?? MAX_CORPUS_FILES, allFrames: options.allFrames ?? true, resume: options.resume ?? false };
    if (result.output === result.directory || result.output.startsWith(result.directory + sep)) throw new Error('Campaign output must be outside the input collection.');
    if (!Number.isSafeInteger(result.batchSize) || result.batchSize < 1 || result.batchSize > 1000
        || !Number.isSafeInteger(result.timeoutMs) || result.timeoutMs < 1000 || result.timeoutMs > 600000
        || !Number.isSafeInteger(result.maxFiles) || result.maxFiles < 1 || result.maxFiles > MAX_CORPUS_FILES
        || typeof result.allFrames !== 'boolean' || typeof result.resume !== 'boolean') throw new Error('Campaign options are outside their supported ranges.');
    return result;
}

export function planCorpusBatches(count, batchSize = 200) {
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_CORPUS_FILES
        || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error('Invalid campaign batch bounds.');
    return Array.from({ length: Math.ceil(count / batchSize) }, (_, index) => ({
        index, offset: index * batchSize, count: Math.min(batchSize, count - index * batchSize)
    }));
}

export async function campaignIdentity(directory = root) {
    const info = JSON.parse(await readFile(resolve(directory, 'dist/build-info.json'), 'utf8'));
    if (info.sourceDigest !== await sourceDigest(directory)) throw new Error('The viewer build is stale. Run npm run check before the campaign.');
    const harnessSha256 = Object.fromEntries(await Promise.all(drivers.map(async name =>
        [name, digest(await readFile(resolve(directory, 'tools', name)))])));
    return { sourceDigest: info.sourceDigest, viewerVersion: info.version, easiJsVersion: info.easiJsVersion, harnessSha256 };
}

async function atomicJson(path, value) {
    const temporary = path + '.tmp';
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
    await rename(temporary, path);
}

async function boundedRead(path, maximum = 64 * 1024 * 1024) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) throw new Error('Invalid or oversized private campaign report.');
    return readFile(path);
}

async function acquireLock(output) {
    const path = resolve(output, '.campaign.lock');
    try {
        const handle = await open(path, 'wx');
        await handle.writeFile(JSON.stringify({ pid: process.pid }));
        await handle.close();
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = JSON.parse(await readFile(path, 'utf8'));
        if (!Number.isSafeInteger(existing.pid) || existing.pid < 1) throw new Error('Invalid campaign lock; inspect it before retrying.');
        let running = true;
        try { process.kill(existing.pid, 0); } catch (failure) { if (failure.code === 'ESRCH') running = false; }
        if (running) throw new Error('Another campaign owns this output directory.');
        throw new Error('A stale campaign lock remains. Verify its owner has exited and remove only that lock before resuming.');
    }
    return () => rm(path, { force: true });
}

/** No HTTP input paths: child opens originals only through its local File API. */
export async function spawnCorpusBatch({ options, batch, inventoryPath, output, signal,
    launch = (args, settings) => spawn(process.execPath, args, settings), timing = {} }) {
    const workRoot = resolve(output, '.browser-work');
    await mkdir(workRoot, { recursive: true });
    const args = ['tools/local-corpus-check.mjs', '--directory', options.directory, '--output', output,
        '--inventory', inventoryPath, '--offset', String(batch.offset), '--limit', String(batch.count),
        '--timeout-ms', String(options.timeoutMs), '--work-root', workRoot];
    if (!options.allFrames) args.push('--sample-frames');
    // Launch/timing injection is used only by generated process-lifecycle tests.
    const child = launch(args, { cwd: root, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'inherit'] });
    let forwarded = false, forced = false, timedOut = false, watchdog, escalation, operationTimer;
    const killGroup = kind => { try { process.platform === 'win32' ? child.kill(kind) : process.kill(-child.pid, kind); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
    const interrupt = () => {
        if (forwarded) return;
        forwarded = true; child.kill('SIGINT');
        // Normally the child finishes its case and removes its isolated profile.
        // If it hangs, terminate this owned process group, never Chrome globally.
        watchdog = setTimeout(() => {
            forced = true; killGroup('SIGTERM');
            escalation = setTimeout(() => killGroup('SIGKILL'), timing.escalationMs ?? 2000);
        }, timing.abortMs ?? options.timeoutMs + 45000);
    };
    // Watch outside the child's event loop, including parser/decoder hangs.
    const budget = milliseconds => {
        clearTimeout(operationTimer);
        operationTimer = setTimeout(() => { timedOut = true; interrupt(); }, milliseconds);
    };
    budget(timing.setupMs ?? 60000);
    let line = '';
    child.stdout.on('data', bytes => {
        process.stdout.write(bytes);
        line += bytes.toString();
        const lines = line.split('\n'); line = lines.pop().slice(-4096);
        if (lines.some(value => /^\[\d+\/\d+\]/.test(value))) budget(options.timeoutMs + 45000);
    });
    signal?.addEventListener('abort', interrupt, { once: true });
    if (signal?.aborted) interrupt();
    try {
        const exitCode = await new Promise((accept, reject) => {
            child.once('error', reject);
            child.once('close', (code, childSignal) => accept(code ?? (childSignal === 'SIGINT' ? 130 : 2)));
        });
        let report = null;
        try { report = JSON.parse(await boundedRead(resolve(output, 'results.json'))); } catch { /* Setup may fail before a report exists. */ }
        return { exitCode: timedOut ? 2 : forced ? 130 : exitCode, report };
    } finally {
        clearTimeout(operationTimer); clearTimeout(watchdog); clearTimeout(escalation); signal?.removeEventListener('abort', interrupt);
        if (child.pid && process.platform !== 'win32') {
            const active = () => { try { process.kill(-child.pid, 0); return true; } catch { return false; } };
            for (let attempt = 0; active() && attempt < 20; attempt++) await new Promise(accept => setTimeout(accept, 100));
            if (active()) { killGroup('SIGTERM'); await new Promise(accept => setTimeout(accept, 2000)); }
            if (active()) killGroup('SIGKILL');
            for (let attempt = 0; active() && attempt < 20; attempt++) await new Promise(accept => setTimeout(accept, 100));
            if (active()) throw new Error('Owned corpus browser process group did not exit.');
        }
        await rm(workRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
}

function checkBatchReport(report, files, identity, options) {
    if (!report || report.schemaVersion !== 1 || report.directory !== options.directory
        || report.sourceDigest !== identity.sourceDigest || !Array.isArray(report.results)
        || report.results.length > files.length || report.selectionFingerprint !== corpusFingerprint(files)
        || report.coverage?.selectedFiles !== files.length
        || report.coverage?.frameMode !== (options.allFrames ? 'all' : 'first-middle-last')
        || report.coverage?.perFileTimeoutMs !== options.timeoutMs
        || report.network?.observed !== true
        || !['uploads', 'externalRequests'].every(key => report.network[key] === 0)) throw new Error('A child report does not match the frozen batch or local-only network boundary.');
    if (!report.harnessSha256 || Object.keys(report.harnessSha256).length !== CHILD_DRIVERS.length) throw new Error('Missing child driver identity.');
    for (const name of CHILD_DRIVERS) {
        if (report.harnessSha256[name] !== identity.harnessSha256[name]) throw new Error('A child driver changed during the campaign.');
    }
    for (let index = 0; index < report.results.length; index++) {
        const result = report.results[index], file = files[index];
        if (!['passed', 'failed', 'unsupported', 'invalid'].includes(result.status)
            || typeof result.sourceUnchanged !== 'boolean' || result.status === 'passed' && !result.sourceUnchanged
            || !equal(result.file, { relativePath: file.relativePath, bytes: file.bytes, sha256: file.sha256 })) throw new Error('Missing, reordered or invalid child results.');
    }
    if (!equal(report.summary, batchSummary(report).summary)) throw new Error('A child summary disagrees with its results.');
}

function batchSummary(report) {
    const summary = emptySummary();
    for (const result of report.results) summary[result.status]++;
    return { checked: report.results.length, parsed: report.results.filter(result => result.parsing?.passed).length,
        summary, network: { uploads: report.network.uploads, externalRequests: report.network.externalRequests } };
}

function rollup(state) {
    const summary = emptySummary();
    let checked = 0, parsed = 0, uploads = 0, externalRequests = 0;
    for (const batch of state.batches) {
        for (const status of Object.keys(summary)) summary[status] += batch.summary[status];
        checked += batch.checked; parsed += batch.parsed;
        uploads += batch.network.uploads; externalRequests += batch.network.externalRequests;
    }
    return { summary, checked, parsed, network: { observed: state.batches.length > 0, uploads, externalRequests } };
}

function metadata(state) {
    const totals = rollup(state);
    return { schemaVersion: 1, startedAt: state.startedAt, completedAt: state.completedAt,
        interrupted: state.interrupted, ...state.identity, directory: state.configuration.directory,
        inputFingerprint: state.inputFingerprint, reportedFiles: totals.checked, parsedCount: totals.parsed,
        coverage: { discoveredFiles: state.fileCount, selectedFiles: state.fileCount, completeDirectory: true,
            frameMode: state.configuration.allFrames ? 'all' : 'first-middle-last', perFileTimeoutMs: state.configuration.timeoutMs },
        scope: 'Local file parse, decode, renderer submission, frames/tools and disposal. No independent clinical pixel-correctness claim.',
        network: totals.network, summary: totals.summary, batches: state.batches.map(batch => ({
            index: batch.index, offset: batch.offset, count: batch.count, checked: batch.checked, complete: batch.complete,
            summary: batch.summary, report: 'batches/' + batchName(batch.index) + '/report.html'
        })) };
}

async function progressReport(output, state) {
    const report = metadata(state);
    const links = state.batches.map(batch => '<li><a href="batches/' + batchName(batch.index)
        + '/report.html">Batch ' + (batch.index + 1) + '</a>: ' + batch.checked + '/' + batch.count
        + ' cases; ' + (batch.complete ? 'complete' : 'partial') + '.</li>').join('');
    const html = renderCorpusReport({ ...report, results: [] }).replace('</body>', '<p>Campaign progress; batch reports contain checked filenames and outcomes.</p><ul>' + links + '</ul></body>');
    const temporary = resolve(output, 'report.html.tmp');
    await writeFile(temporary, html); await rename(temporary, resolve(output, 'report.html'));
}

/** Merge bounded batch reports without retaining the complete collection in memory. */
async function aggregateReports(output, state) {
    const report = metadata(state), names = ['results.json', 'report.html', 'results.csv'];
    const handles = await Promise.all(names.map(name => open(resolve(output, name + '.tmp'), 'w')));
    try {
        await handles[0].writeFile(JSON.stringify(report, null, 2).slice(0, -2) + ',\n  "results": [\n');
        await handles[1].writeFile(renderCorpusReport({ ...report, results: [] }).split('<tbody>')[0] + '<tbody>\n');
        await handles[2].writeFile(renderCorpusCsv({ results: [] }));
        let first = true;
        for (const batch of state.batches) {
            const contents = await boundedRead(resolve(output, 'batches', batchName(batch.index), 'results.json'));
            if (digest(contents) !== batch.reportSha256) throw new Error('A saved child report changed.');
            const child = JSON.parse(contents);
            for (const result of child.results) {
                await handles[0].writeFile((first ? '' : ',\n') + JSON.stringify(result));
                first = false;
            }
            await handles[1].writeFile(renderCorpusReportRows(child.results) + '\n');
            const csv = renderCorpusCsv({ results: child.results });
            await handles[2].writeFile(csv.slice(csv.indexOf('\r\n') + 2));
        }
        await handles[0].writeFile('\n  ]\n}\n');
        await handles[1].writeFile('</tbody></table></div></body></html>\n');
    } finally { await Promise.all(handles.map(handle => handle.close())); }
    for (const name of names) await rename(resolve(output, name + '.tmp'), resolve(output, name));
}

/** Injected children exercise orchestration with generated fixtures, without launching Chrome. */
export async function runCorpusCampaign(input, { inventory, identity, runBatch = spawnCorpusBatch,
    verifyIdentity = () => campaignIdentity(), verifyInputs, signal, onProgress } = {}) {
    const options = validateOptions(input);
    const files = validateCorpusInventory(inventory, options.directory);
    if (files.length > options.maxFiles) throw new Error('Discovered DICOM files exceed --max-files; choose a larger explicit bound.');
    if (!identity?.sourceDigest || !identity.harnessSha256) throw new Error('A frozen viewer and driver identity is required.');
    await mkdir(options.output, { recursive: true });
    if ((await lstat(options.output)).isSymbolicLink()) throw new Error('Campaign output must not be a symbolic link.');
    if (!options.resume && (await readdir(options.output)).length) throw new Error('Campaign output is not empty. Use --resume or a new output directory.');
    const unlock = await acquireLock(options.output);
    let state, validated = false;
    try {
        const configuration = { directory: options.directory, batchSize: options.batchSize, timeoutMs: options.timeoutMs,
            maxFiles: options.maxFiles, allFrames: options.allFrames };
        const checkpoint = resolve(options.output, 'campaign.json'), inventoryPath = resolve(options.output, 'inventory.json');
        if (options.resume) {
            state = JSON.parse(await boundedRead(checkpoint));
            if (state.schemaVersion !== 1 || !equal(state.identity, identity) || !equal(state.configuration, configuration)
                || state.inputFingerprint !== inventory.fingerprint || state.fileCount !== files.length) throw new Error('Cannot resume: viewer, drivers, configuration or input fingerprint changed.');
            const saved = JSON.parse(await boundedRead(inventoryPath));
            validateCorpusInventory(saved, options.directory);
            if (saved.fingerprint !== inventory.fingerprint) throw new Error('The saved inventory changed.');
        } else {
            state = { schemaVersion: 1, startedAt: new Date().toISOString(), completedAt: null, interrupted: false,
                identity, configuration, inputFingerprint: inventory.fingerprint, fileCount: files.length, batches: [] };
            await atomicJson(inventoryPath, inventory);
        }
        const plan = planCorpusBatches(files.length, options.batchSize);
        if (!Array.isArray(state.batches) || state.batches.some((batch, index) => batch.index !== index
            || !equal({ index: batch.index, offset: batch.offset, count: batch.count }, plan[index])
            || typeof batch.complete !== 'boolean' || index < state.batches.length - 1 && !batch.complete)) throw new Error('Invalid campaign checkpoint batch layout.');
        // Validate every completed artifact before changing an existing checkpoint.
        for (const batch of state.batches) {
            const bytes = await boundedRead(resolve(options.output, 'batches', batchName(batch.index), 'results.json'));
            if (digest(bytes) !== batch.reportSha256) throw new Error('A completed batch report changed.');
            const saved = JSON.parse(bytes);
            checkBatchReport(saved, files.slice(batch.offset, batch.offset + batch.count), identity, options);
            if (batch.complete && (!saved.completedAt || saved.interrupted || saved.results.length !== batch.count)) throw new Error('A completed batch has missing results.');
            if (!equal(batchSummary(saved), { checked: batch.checked, parsed: batch.parsed, summary: batch.summary, network: batch.network })) throw new Error('Checkpoint totals disagree with the saved child report.');
        }
        validated = true;
        state.completedAt = null; state.interrupted = false;
        let exitCode = 0;
        await atomicJson(checkpoint, state); await progressReport(options.output, state);
        for (const batch of plan) {
            const previous = state.batches[batch.index];
            if (previous?.complete) continue;
            if (signal?.aborted) { exitCode = 130; break; }
            if (!equal(await verifyIdentity(), identity)) throw new Error('Viewer or drivers changed during the campaign.');
            const output = resolve(options.output, 'batches', batchName(batch.index));
            await mkdir(output, { recursive: true });
            onProgress?.({ batch: batch.index + 1, totalBatches: plan.length, offset: batch.offset, count: batch.count });
            const child = await runBatch({ options, batch, inventoryPath, output, signal });
            if (child.report) {
                checkBatchReport(child.report, files.slice(batch.offset, batch.offset + batch.count), identity, options);
                const complete = [0, 1].includes(child.exitCode) && Boolean(child.report.completedAt) && !child.report.interrupted && child.report.results.length === batch.count;
                // Persist the exact validated child report; real children already write it.
                const reportPath = resolve(output, 'results.json');
                await atomicJson(reportPath, child.report);
                state.batches[batch.index] = { ...batch, complete, ...batchSummary(child.report),
                    reportSha256: digest(await readFile(reportPath)) };
                await atomicJson(checkpoint, state); await progressReport(options.output, state);
                if (!complete || child.report.network.uploads || child.report.network.externalRequests) { exitCode = signal?.aborted || child.exitCode === 130 ? 130 : 2; break; }
            } else { exitCode = signal?.aborted || child.exitCode === 130 ? 130 : 2; break; }
        }
        if (signal?.aborted) exitCode = 130;
        if (!equal(await verifyIdentity(), identity)) throw new Error('Viewer or drivers changed during the campaign.');
        state.interrupted = exitCode === 130;
        const complete = state.batches.length === plan.length && state.batches.every(batch => batch.complete);
        if (complete && [0, 1].includes(exitCode)) {
            const currentFingerprint = verifyInputs ? await verifyInputs()
                : corpusFingerprint(await discoverCorpus(options.directory, { signal }));
            if (currentFingerprint !== inventory.fingerprint) throw new Error('The complete input collection changed during the campaign.');
            state.completedAt = new Date().toISOString();
            const summary = rollup(state).summary;
            exitCode = summary.passed === files.length ? 0 : 1;
        } else state.completedAt = null;
        await atomicJson(checkpoint, state);
        await aggregateReports(options.output, state);
        if (signal?.aborted && !state.interrupted) {
            state.interrupted = true; state.completedAt = null; exitCode = 130;
            await atomicJson(checkpoint, state); await aggregateReports(options.output, state);
        }
        return { exitCode, state, reportPath: resolve(options.output, 'report.html') };
    } catch (error) {
        if (state && validated) {
            state.completedAt = null; state.interrupted = signal?.aborted === true;
            state.harnessError = state.interrupted ? 'The campaign was interrupted; completed cases are retained.'
                : 'The campaign did not complete; inspect its batch reports and rerun on the same frozen inputs.';
            await atomicJson(resolve(options.output, 'campaign.json'), state);
            try { await aggregateReports(options.output, state); } catch { await progressReport(options.output, state); }
            if (state.interrupted) return { exitCode: 130, state, reportPath: resolve(options.output, 'report.html') };
        }
        throw error;
    } finally { await unlock(); }
}

export async function main(argv = process.argv.slice(2)) {
    const options = parseCampaignArguments(argv);
    if (options.help) { console.log(help); return 0; }
    const controller = new AbortController(), interrupt = () => controller.abort();
    process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
    try {
        const identity = await campaignIdentity();
        console.log('Inventory: discovering and fingerprinting local DICOM candidates.');
        const files = await discoverCorpus(options.directory, { signal: controller.signal, onProgress({ completed, total }) {
            if (completed % 1000 === 0 || completed === total) console.log('Inventory: ' + completed + '/' + total + ' fingerprinted.');
        } });
        const inventory = { schemaVersion: 1, directory: options.directory,
            files: files.map(({ relativePath, bytes, sha256 }) => ({ relativePath, bytes, sha256 })), fingerprint: corpusFingerprint(files) };
        const result = await runCorpusCampaign(options, { inventory, identity, signal: controller.signal,
            onProgress({ batch, totalBatches, offset, count }) { console.log('Batch ' + batch + '/' + totalBatches + ': sorted entries ' + offset + '..' + (offset + count - 1)); } });
        console.log('Private campaign report: ' + result.reportPath);
        return result.exitCode;
    } catch (error) {
        if (controller.signal.aborted || error.name === 'AbortError') return 130;
        throw error;
    } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().then(code => { process.exitCode = code; }, error => { console.error('Corpus campaign: ' + error.message); process.exitCode = 2; });
}
