import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createDicomFixture } from '../src/data/synthetic.js';
import { discoverCorpus, selectCorpus, corpusFingerprint, validateCorpusInventory } from '../tools/local-corpus.mjs';
import { parseCampaignArguments, planCorpusBatches, runCorpusCampaign, spawnCorpusBatch } from '../tools/local-corpus-campaign.mjs';

const driverNames = ['local-corpus-campaign.mjs', 'local-corpus-check.mjs', 'local-corpus-browser.mjs',
    'local-corpus.mjs', 'local-corpus-profile.mjs', 'browser-session.mjs'];
const identity = { sourceDigest: '1'.repeat(64), viewerVersion: 'synthetic', easiJsVersion: '1.0.0',
    harnessSha256: Object.fromEntries(driverNames.map(name => [name, '2'.repeat(64)])) };
const summary = results => results.reduce((counts, result) => { counts[result.status]++; return counts; },
    { passed: 0, failed: 0, unsupported: 0, invalid: 0 });

async function setup(t, count = 5) {
    const temporary = await mkdtemp(resolve(tmpdir(), 'easi-view-campaign-generated-'));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const directory = resolve(temporary, 'input'), output = resolve(temporary, 'reports');
    await mkdir(directory);
    for (let index = 0; index < count; index++) await writeFile(resolve(directory, String(index).padStart(4, '0') + '.dcm'),
        createDicomFixture({ rows: 2, columns: 2, values: [17 + index, 31, 129, 201] }));
    const files = await discoverCorpus(directory);
    const inventory = { schemaVersion: 1, directory, fingerprint: corpusFingerprint(files),
        files: files.map(({ relativePath, bytes, sha256 }) => ({ relativePath, bytes, sha256 })) };
    const options = { directory, output, batchSize: 2 };
    const dependencies = { inventory, identity, verifyIdentity: async () => identity, verifyInputs: async () => inventory.fingerprint };
    return { temporary, files, inventory, options, dependencies };
}

function reportFor(request, files, { statuses = [], checked = request.batch.count, complete = true } = {}) {
    const selected = files.slice(request.batch.offset, request.batch.offset + request.batch.count);
    const results = selected.slice(0, checked).map((file, index) => ({
        file: { relativePath: file.relativePath, bytes: file.bytes, sha256: file.sha256 },
        status: statuses[index] ?? 'passed', sourceUnchanged: true, parsing: { passed: true }, framesChecked: 1,
        resources: { afterDisposal: { disposed: true, workerCount: 0, encodedBytes: 0, decodedCacheBytes: 0 } }
    }));
    return { schemaVersion: 1, directory: request.options.directory, sourceDigest: identity.sourceDigest,
        startedAt: '2026-10-15T00:00:00.000Z', completedAt: complete ? '2026-10-15T00:01:00.000Z' : null,
        interrupted: !complete, selectionFingerprint: corpusFingerprint(selected),
        harnessSha256: Object.fromEntries(driverNames.slice(1, 5).map(name => [name, identity.harnessSha256[name]])),
        coverage: { selectedFiles: selected.length, frameMode: request.options.allFrames ? 'all' : 'first-middle-last',
            perFileTimeoutMs: request.options.timeoutMs },
        network: { observed: true, uploads: 0, externalRequests: 0 }, results, summary: summary(results) };
}

function child(files, statuses = {}) {
    return async request => {
        const report = reportFor(request, files, { statuses: statuses[request.batch.index] });
        await writeFile(resolve(request.output, 'report.html'), '<!doctype html><title>Generated batch</title>');
        return { exitCode: report.summary.passed === report.results.length ? 0 : 1, report };
    };
}

test('campaign options require explicit private output and bounded full or sampled coverage', () => {
    assert.throws(() => parseCampaignArguments([]), /directory.*output/);
    const options = parseCampaignArguments(['--directory', 'input', '--output', 'reports', '--resume', '--sample-frames'], '/tmp');
    assert.equal(options.batchSize, 200); assert.equal(options.maxFiles, 100000);
    assert.equal(options.resume, true); assert.equal(options.allFrames, false);
    for (const tail of [['--batch-size', '1001'], ['--batch-size', '0'], ['--max-files', '100001'], ['--timeout-ms', '999'], ['--unknown']]) {
        assert.throws(() => parseCampaignArguments(['--directory', '/tmp/input', '--output', '/tmp/report', ...tail]));
    }
    assert.throws(() => parseCampaignArguments(['--directory', '/tmp/input', '--output', '/tmp/input/report']), /outside/);
});

test('deterministic inventory selection crosses10000 without overlap or a silently omitted tail', () => {
    const files = Array.from({ length: 10001 }, (_, index) => ({
        relativePath: String(index).padStart(6, '0') + '.ima', bytes: 132, sha256: 'a'.repeat(64)
    }));
    const inventory = { schemaVersion: 1, directory: '/tmp/generated-input', files, fingerprint: corpusFingerprint(files) };
    const validated = validateCorpusInventory(inventory, inventory.directory);
    const plans = planCorpusBatches(validated.length, 200);
    const selected = plans.flatMap(batch => selectCorpus(validated, { offset: batch.offset, limit: batch.count }));
    assert.equal(plans.length, 51); assert.equal(selected.length, 10001);
    assert.equal(new Set(selected.map(file => file.relativePath)).size, 10001);
    assert.equal(selectCorpus(validated, { offset: 10000, limit: 200 })[0].relativePath, '010000.ima');
    assert.throws(() => selectCorpus(validated, { offset: 10001 }), /offset/);
    assert.throws(() => planCorpusBatches(100001), /bounds/);
    assert.throws(() => validateCorpusInventory({ ...inventory, files: [...files].reverse() }, inventory.directory), /unsorted/);
    assert.throws(() => validateCorpusInventory({ ...inventory, fingerprint: '0'.repeat(64) }, inventory.directory), /fingerprint/);
});

test('completed campaign aggregates every outcome and preserves failures on an unchanged resume', async t => {
    const env = await setup(t);
    const result = await runCorpusCampaign({ ...env.options, allFrames: false }, {
        ...env.dependencies, runBatch: child(env.files, { 0: ['passed', 'failed'], 1: ['unsupported', 'invalid'] })
    });
    assert.equal(result.exitCode, 1); assert.ok(result.state.completedAt);
    const report = JSON.parse(await readFile(resolve(env.options.output, 'results.json')));
    assert.deepEqual(report.summary, { passed: 2, failed: 1, unsupported: 1, invalid: 1 });
    assert.equal(report.results.length, 5); assert.equal(report.coverage.frameMode, 'first-middle-last');
    assert.deepEqual(report.results.map(item => item.file.relativePath), env.files.map(file => file.relativePath));
    assert.match(await readFile(resolve(env.options.output, 'report.html'), 'utf8'), /Completed run/);
    let reruns = 0;
    const resumed = await runCorpusCampaign({ ...env.options, allFrames: false, resume: true }, {
        ...env.dependencies, runBatch: async () => { reruns++; throw new Error('Complete batches must be skipped.'); }
    });
    assert.equal(reruns, 0); assert.equal(resumed.exitCode, 1);
    assert.deepEqual(JSON.parse(await readFile(resolve(env.options.output, 'results.json'))).summary, report.summary);
    await assert.rejects(access(resolve(env.options.output, '.campaign.lock')));
});

test('SIGINT retains the current partial batch and resume reruns only incomplete and unstarted batches', async t => {
    const env = await setup(t, 6), controller = new AbortController(), visited = [];
    const interrupted = await runCorpusCampaign(env.options, { ...env.dependencies, signal: controller.signal,
        runBatch: async request => {
            visited.push(request.batch.index);
            const partial = request.batch.index === 1;
            const report = reportFor(request, env.files, { checked: partial ? 1 : request.batch.count,
                complete: !partial, statuses: request.batch.index === 0 ? ['failed', 'passed'] : [] });
            if (partial) controller.abort();
            return { exitCode: partial ? 130 : 1, report };
        }
    });
    assert.equal(interrupted.exitCode, 130); assert.equal(interrupted.state.completedAt, null);
    assert.equal(interrupted.state.interrupted, true); assert.deepEqual(visited, [0, 1]);
    const partial = JSON.parse(await readFile(resolve(env.options.output, 'results.json')));
    assert.equal(partial.results.length, 3); assert.equal(partial.summary.failed, 1);
    await assert.rejects(access(resolve(env.options.output, '.campaign.lock')));
    const resumedVisits = [];
    const resumed = await runCorpusCampaign({ ...env.options, resume: true }, { ...env.dependencies,
        runBatch: async request => { resumedVisits.push(request.batch.index); return child(env.files)(request); }
    });
    assert.deepEqual(resumedVisits, [1, 2]); assert.equal(resumed.exitCode, 1);
    const full = JSON.parse(await readFile(resolve(env.options.output, 'results.json')));
    assert.equal(full.results.length, 6); assert.equal(full.summary.failed, 1);
});

test('resume rejects configuration, driver and source-content drift without changing a completed checkpoint', async t => {
    const env = await setup(t, 2);
    await runCorpusCampaign(env.options, { ...env.dependencies, runBatch: child(env.files) });
    const checkpoint = resolve(env.options.output, 'campaign.json'), original = await readFile(checkpoint);
    for (const patch of [{ batchSize: 1 }, { allFrames: false }, { timeoutMs: 1000 }, { maxFiles: 20 }]) {
        await assert.rejects(runCorpusCampaign({ ...env.options, ...patch, resume: true }, env.dependencies), /Cannot resume/);
        assert.deepEqual(await readFile(checkpoint), original);
    }
    await assert.rejects(runCorpusCampaign({ ...env.options, resume: true }, {
        ...env.dependencies, identity: { ...identity, sourceDigest: 'f'.repeat(64) }
    }), /Cannot resume/);
    await writeFile(env.files[0].path, createDicomFixture({ values: [1, 2, 3, 4] }));
    const changed = await discoverCorpus(env.options.directory);
    const inventory = { ...env.inventory, files: changed.map(({ relativePath, bytes, sha256 }) => ({ relativePath, bytes, sha256 })),
        fingerprint: corpusFingerprint(changed) };
    await assert.rejects(runCorpusCampaign({ ...env.options, resume: true }, { ...env.dependencies, inventory }), /Cannot resume/);
    assert.deepEqual(await readFile(checkpoint), original);
});

test('corrupt checkpoint totals cannot waive failures or rewrite evidence', async t => {
    const env = await setup(t, 2);
    await runCorpusCampaign(env.options, { ...env.dependencies, runBatch: child(env.files, { 0: ['failed', 'passed'] }) });
    const path = resolve(env.options.output, 'campaign.json');
    const state = JSON.parse(await readFile(path));
    state.batches[0].summary.failed = 0; state.batches[0].summary.passed = 2;
    await writeFile(path, JSON.stringify(state));
    const corrupt = await readFile(path), html = await readFile(resolve(env.options.output, 'report.html'));
    await assert.rejects(runCorpusCampaign({ ...env.options, resume: true }, env.dependencies), /totals/);
    assert.deepEqual(await readFile(path), corrupt);
    assert.deepEqual(await readFile(resolve(env.options.output, 'report.html')), html);
});

test('an aborted resume still validates partial-batch counters before rewriting evidence', async t => {
    const env = await setup(t, 2), controller = new AbortController();
    await runCorpusCampaign(env.options, { ...env.dependencies, signal: controller.signal, runBatch: async request => {
        const report = reportFor(request, env.files, { checked: 1, complete: false, statuses: ['failed'] });
        controller.abort(); return { exitCode: 130, report };
    } });
    const path = resolve(env.options.output, 'campaign.json'), state = JSON.parse(await readFile(path));
    state.batches[0].summary.failed = 0; state.batches[0].summary.passed = 1;
    await writeFile(path, JSON.stringify(state));
    const original = await readFile(path), resumeSignal = new AbortController(); resumeSignal.abort();
    await assert.rejects(runCorpusCampaign({ ...env.options, resume: true }, {
        ...env.dependencies, signal: resumeSignal.signal, runBatch: () => { throw new Error('Should validate first.'); }
    }), /totals/);
    assert.deepEqual(await readFile(path), original);
});

test('a missing completed batch report rejects resume without changing the checkpoint', async t => {
    const env = await setup(t, 2);
    await runCorpusCampaign(env.options, { ...env.dependencies, runBatch: child(env.files) });
    const checkpoint = resolve(env.options.output, 'campaign.json'), original = await readFile(checkpoint);
    await rm(resolve(env.options.output, 'batches/batch-000000/results.json'));
    await assert.rejects(runCorpusCampaign({ ...env.options, resume: true }, env.dependencies), /ENOENT/);
    assert.deepEqual(await readFile(checkpoint), original);
});

for (const [label, change] of [
    ['missing driver hashes', report => { report.harnessSha256 = {}; }],
    ['wrong directory', report => { report.directory = '/tmp/another-input'; }],
    ['unknown status', report => { report.results[0].status = 'unrecognized'; }],
    ['missing source integrity', report => { delete report.results[0].sourceUnchanged; }],
    ['wrong result fingerprint', report => { report.results[0].file.sha256 = 'f'.repeat(64); }],
    ['unknown network observation', report => { report.network.observed = false; }],
    ['negative network counter', report => { report.network.uploads = -1; }],
    ['positive network counter', report => { report.network.externalRequests = 1; }]
]) {
    test('campaign rejects ' + label + ' instead of claiming successful coverage', async t => {
        const env = await setup(t, 2);
        await assert.rejects(runCorpusCampaign(env.options, { ...env.dependencies, runBatch: async request => {
            const report = reportFor(request, env.files); change(report); return { exitCode: 0, report };
        } }), /child|results|batch/);
        const partial = JSON.parse(await readFile(resolve(env.options.output, 'results.json')));
        assert.equal(partial.completedAt, null); assert.equal(partial.results.length, 0);
    });
}

test('final input verification detects added files during the campaign and leaves a partial report', async t => {
    const env = await setup(t, 2);
    await assert.rejects(runCorpusCampaign(env.options, { ...env.dependencies, verifyInputs: undefined,
        runBatch: async request => {
            const report = reportFor(request, env.files);
            await writeFile(resolve(env.options.directory, 'added.ima'), createDicomFixture());
            return { exitCode: 0, report };
        }
    }), /input collection changed/);
    const partial = JSON.parse(await readFile(resolve(env.options.output, 'results.json')));
    assert.equal(partial.completedAt, null); assert.equal(partial.results.length, 2);
});

test('output reuse, active or stale locks and a restrictive max-files guard fail without overwriting reports', async t => {
    const env = await setup(t, 2);
    await assert.rejects(runCorpusCampaign({ ...env.options, maxFiles: 1 }, env.dependencies), /max-files/);
    await mkdir(env.options.output);
    await writeFile(resolve(env.options.output, 'keep.txt'), 'Generated prior evidence.');
    await assert.rejects(runCorpusCampaign(env.options, env.dependencies), /not empty/);
    await rm(resolve(env.options.output, 'keep.txt'));
    await writeFile(resolve(env.options.output, '.campaign.lock'), JSON.stringify({ pid: process.pid }));
    await assert.rejects(runCorpusCampaign({ ...env.options, resume: true }, env.dependencies), /Another campaign/);
    await writeFile(resolve(env.options.output, '.campaign.lock'), JSON.stringify({ pid: 2147483647 }));
    await assert.rejects(runCorpusCampaign({ ...env.options, resume: true }, env.dependencies), /stale campaign lock/);
});

test('external watchdog terminates an owned hanging Node process group and removes managed work', {
    skip: process.platform === 'win32', timeout: 10000
}, async t => {
    const env = await setup(t, 2), output = resolve(env.temporary, 'hanging-child');
    await mkdir(output);
    const evidence = resolve(env.temporary, 'owned-pids.json');
    const descendant = "process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);";
    const script = "const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');"
        + "process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});"
        + "const child=spawn(process.execPath,['-e'," + JSON.stringify(descendant) + "],{stdio:'ignore'});"
        + "writeFileSync(" + JSON.stringify(evidence) + ",JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);";
    const result = await spawnCorpusBatch({ options: { directory: env.options.directory, timeoutMs: 1000, allFrames: true },
        batch: { offset: 0, count: 2 }, inventoryPath: resolve(env.temporary, 'unused-generated-inventory.json'), output,
        launch: (args, settings) => spawn(process.execPath, ['-e', script], settings),
        timing: { setupMs: 500, abortMs: 30, escalationMs: 30 } });
    assert.equal(result.exitCode, 2); assert.equal(result.report, null);
    const pids = JSON.parse(await readFile(evidence));
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
    await assert.rejects(access(resolve(output, '.browser-work')));
});
