import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

test('independent artifact packaging verifies distribution and source provenance', async t => {
    const project = resolve(import.meta.dirname, '..');
    const fixture = await mkdtemp(resolve(tmpdir(), 'easi-view-artifact-test-'));
    const run = file => spawnSync(process.execPath, [resolve(fixture, 'tools', file)], { cwd: fixture, encoding: 'utf8' });
    try {
        await mkdir(resolve(fixture, 'tools'));
        await mkdir(resolve(fixture, 'src/ui'), { recursive: true });
        await mkdir(resolve(fixture, 'src/runtime'), { recursive: true });
        await mkdir(resolve(fixture, 'public'));
        for (const name of ['package.json', 'package-lock.json', 'LICENSE', 'NOTICE']) await cp(resolve(project, name), resolve(fixture, name));
        for (const name of ['build.mjs', 'source-digest.mjs', 'dist-manifest.mjs', 'check-dist.mjs', 'pack-artifact.mjs']) {
            await cp(resolve(project, 'tools', name), resolve(fixture, 'tools', name));
        }
        await symlink(resolve(project, 'node_modules'), resolve(fixture, 'node_modules'), 'dir');
        await writeFile(resolve(fixture, 'src/main.js'), 'export const fixture = 1;\n');
        await writeFile(resolve(fixture, 'src/runtime/decode-worker.js'), 'self.onmessage = () => {};\n');
        await writeFile(resolve(fixture, 'src/ui/styles.css'), 'body { color: black; }\n');
        await writeFile(resolve(fixture, 'public/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
        await writeFile(resolve(fixture, 'index.html'), '<!doctype html><link rel="stylesheet" href="./assets/app.css"><script type="module" src="./assets/app.js"></script>');
        let result = run('build.mjs');
        assert.equal(result.status, 0, result.stderr);

        await t.test('complete distribution packages with independently verified archive and file hashes', async () => {
            const result = run('pack-artifact.mjs');
            assert.equal(result.status, 0, result.stderr);
            const version = JSON.parse(await readFile(resolve(fixture, 'package.json'), 'utf8')).version;
            const name = `easi-view-${version}`;
            const manifest = JSON.parse(await readFile(resolve(fixture, 'artifacts/releases', `${name}.manifest.json`), 'utf8'));
            const bytes = await readFile(resolve(fixture, 'artifacts/releases', `${name}.tar.gz`));
            assert.equal(manifest.archiveSha256, createHash('sha256').update(bytes).digest('hex'));
            const listing = spawnSync('tar', ['-tzf', resolve(fixture, 'artifacts/releases', `${name}.tar.gz`)], { encoding: 'utf8' });
            assert.equal(listing.status, 0);
            for (const path of ['assets/app.js', 'assets/decode-worker.js', 'LICENSE', 'NOTICE', 'licenses/EASI-JS-LICENSE.txt']) {
                assert(listing.stdout.split('\n').includes(`./${path}`), `Archive is missing ${path}`);
                const file = await readFile(resolve(fixture, 'dist', path));
                assert.equal(manifest.files.find(entry => entry.path === path).sha256, createHash('sha256').update(file).digest('hex'));
            }
        });

        await t.test('temporary browser-QA files cannot enter a deployment artifact', async () => {
            await mkdir(resolve(fixture, 'dist/qa'));
            await writeFile(resolve(fixture, 'dist/qa/exports.js'), 'export const unexpected = true;');
            const result = run('pack-artifact.mjs');
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /Distribution changed after building/);
            await rm(resolve(fixture, 'dist/qa'), { recursive: true });
        });

        await t.test('modified browser output is rejected even with unchanged source inputs', async () => {
            const file = resolve(fixture, 'dist/assets/app.js');
            const original = await readFile(file);
            await writeFile(file, 'export const corrupted = true;');
            const result = run('pack-artifact.mjs');
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /Distribution changed after building/);
            await writeFile(file, original);
        });

        await t.test('changed source requires a new build before packaging', async () => {
            await writeFile(resolve(fixture, 'src/main.js'), 'export const fixture = 2;\n');
            const stale = run('pack-artifact.mjs');
            assert.notEqual(stale.status, 0);
            assert.match(stale.stderr, /browser build is stale/);
            const build = run('build.mjs');
            assert.equal(build.status, 0, build.stderr);
            const fresh = run('pack-artifact.mjs');
            assert.equal(fresh.status, 0, fresh.stderr);
        });
    } finally { await rm(fixture, { recursive: true, force: true }); }
});
