import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArguments, startCorpusServer, main } from '../tools/local-corpus-check.mjs';

test('local corpus execution requires an explicit collection; defaults cover every file and frame', () => {
    assert.throws(() => parseArguments([]), /explicitly opt in/);
    const options = parseArguments(['--directory', 'synthetic-dicoms'], '/tmp');
    assert.equal(options.directory, '/tmp/synthetic-dicoms');
    assert.equal(options.allFrames, true);
    assert.equal(options.timeoutMs, 120000);
    assert.equal(options.limit, undefined);
    assert.equal(options.match, undefined);
    assert.equal(options.help, false);
});

test('explicit subsets and sampled frames are represented without claiming exhaustive coverage', () => {
    const options = parseArguments(['--directory', 'input', '--sample-frames', '--match', 'XA', '--limit', '5',
        '--timeout-ms', '60000', '--output', 'private-report'], '/tmp');
    assert.equal(options.allFrames, false);
    assert.equal(options.match, 'XA');
    assert.equal(options.limit, 5);
    assert.equal(options.timeoutMs, 60000);
    assert.equal(options.output, '/tmp/private-report');
});

test('invalid arguments and report directories inside the input collection reject before any original is opened', () => {
    for (const tail of [['--unknown'], ['--limit'], ['--limit', '0'], ['--limit', '100001'], ['--limit', 'NaN'],
        ['--timeout-ms', '999'], ['--timeout-ms', '600001'], ['--timeout-ms', '1.5']]) {
        assert.throws(() => parseArguments(['--directory', '/tmp/input', ...tail]));
    }
    for (const output of ['/tmp/input', '/tmp/input/report']) {
        assert.throws(() => parseArguments(['--directory', '/tmp/input', '--output', output]), /outside the input/);
    }
    assert.equal(parseArguments(['--help']).help, true);
});

test('the corpus static host serves viewer/driver assets, enforces restrictive CSP and rejects writes and traversal', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'easi-view-corpus-host-test-'));
    const dist = resolve(directory, 'dist'), host = resolve(directory, 'host');
    await mkdir(resolve(dist, 'assets'), { recursive: true });
    await mkdir(host);
    await writeFile(resolve(dist, 'assets/sdk.js'), 'export const synthetic = true;');
    await writeFile(resolve(host, 'index.html'), '<!doctype html><title>Synthetic test</title>');
    await writeFile(resolve(directory, 'outside.txt'), 'Must not be served');
    let server;
    try {
        server = await startCorpusServer({ dist, host, styleHash: 'a'.repeat(43) + '=' });
        const response = await fetch(server.url);
        assert.equal(response.status, 200);
        assert.match(await response.text(), /Synthetic test/);
        const csp = response.headers.get('content-security-policy');
        assert.match(csp, /connect-src 'self'/);
        assert.match(csp, /form-action 'none'/);
        assert.ok(!csp.includes('unsafe-inline'));
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const origin = new URL(server.url).origin;
        assert.equal((await fetch(origin + '/assets/sdk.js')).status, 200);
        assert.equal((await fetch(server.url, { method: 'POST', body: 'synthetic' })).status, 405);
        assert.equal(server.requests.rejectedMethods, 1);
        for (const path of ['/qa-corpus/%2e%2e%2foutside.txt', '/qa-corpus/%5c..%5coutside.txt', '/qa-corpus/%00', '/original.dcm']) {
            assert.equal((await fetch(origin + path)).status, 404);
        }
        assert.equal((await fetch(origin + '/assets/sdk.js', { method: 'HEAD' })).status, 200);
    } finally { if (server) await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test('help does not start a browser, inspect a collection, or require a built viewer', async () => {
    assert.equal(await main(['--help']), 0);
});
