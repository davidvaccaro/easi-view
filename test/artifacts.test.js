import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

test('independent artifact packaging verifies distribution and source provenance', async t => {
    const project = resolve(import.meta.dirname, '..');
    const fixture = await mkdtemp(resolve(tmpdir(), 'easi-view-artifact-test-'));
    const run = file => spawnSync(process.execPath, [resolve(fixture, 'tools', file)], { cwd: fixture, encoding: 'utf8' });
    try {
        await mkdir(resolve(fixture, 'tools'));
        await mkdir(resolve(fixture, 'src/ui'), { recursive: true });
        await mkdir(resolve(fixture, 'src/runtime'), { recursive: true });
        await mkdir(resolve(fixture, 'src/integration'), { recursive: true });
        await mkdir(resolve(fixture, 'public'));
        await cp(resolve(project, 'licenses'), resolve(fixture, 'licenses'), { recursive: true });
        for (const name of ['package.json', 'package-lock.json', 'LICENSE', 'NOTICE']) await cp(resolve(project, name), resolve(fixture, name));
        for (const name of ['build.mjs', 'source-digest.mjs', 'dist-manifest.mjs', 'check-dist.mjs', 'pack-artifact.mjs', 'release-profile.mjs']) {
            await cp(resolve(project, 'tools', name), resolve(fixture, 'tools', name));
        }
        await cp(resolve(project, 'src/integration/easi-view.d.ts'), resolve(fixture, 'src/integration/easi-view.d.ts'));
        await cp(resolve(project, 'src/integration/style-prefix.js'), resolve(fixture, 'src/integration/style-prefix.js'));
        await symlink(resolve(project, 'node_modules'), resolve(fixture, 'node_modules'), 'dir');
        await writeFile(resolve(fixture, 'src/main.js'), 'export const fixture = 1;\n');
        await writeFile(resolve(fixture, 'src/runtime/decode-worker.js'), 'self.onmessage = () => {};\n');
        await writeFile(resolve(fixture, 'src/ui/styles.css'), 'body { color: black; }\n');
        await writeFile(resolve(fixture, 'src/integration/viewer.js'), "import styles from '../ui/styles.css';\nimport { EMBED_STYLE_PREFIX } from './style-prefix.js';\nexport function createViewer() { return { styles: EMBED_STYLE_PREFIX + styles }; }\n");
        await writeFile(resolve(fixture, 'public/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
        await writeFile(resolve(fixture, 'public/standalone.css'), 'body { margin: 0; }\n');
        await writeFile(resolve(fixture, 'public/embed.html'), '<!doctype html><link rel="stylesheet" href="./embed-demo.css"><script type="module" src="./embed-demo.js"></script>');
        await writeFile(resolve(fixture, 'public/embed-demo.js'), "import { createViewer } from './assets/easi-view.js';\nexport { createViewer };\n");
        await writeFile(resolve(fixture, 'public/embed-demo.css'), 'main { display: grid; }\n');
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
            for (const path of ['assets/app.js', 'assets/easi-view.js', 'assets/app.css', 'standalone.css', 'assets/decode-worker.js', 'embed.html', 'embed-demo.js', 'embed-demo.css', 'LICENSE', 'NOTICE', 'licenses/EASI-JS-LICENSE.txt']) {
                assert(listing.stdout.split('\n').includes(`./${path}`), `Archive is missing ${path}`);
                const file = await readFile(resolve(fixture, 'dist', path));
                assert.equal(manifest.files.find(entry => entry.path === path).sha256, createHash('sha256').update(file).digest('hex'));
            }
        });

        await t.test('browser SDK exports its factory with scoped styles embedded as text', async () => {
            const sdk = await import(pathToFileURL(resolve(fixture, 'dist/assets/easi-view.js')).href);
            assert.equal(typeof sdk.createViewer, 'function');
            const stylesheet = ':host { display: block; width: 100%; height: 100%; min-height: 0; margin: 0; padding: 0; border: 0; box-sizing: border-box; }\nbody { color: black; }\n';
            assert.equal(sdk.createViewer().styles, stylesheet);
            const info = JSON.parse(await readFile(resolve(fixture, 'dist/build-info.json'), 'utf8'));
            assert(info.entries.some(entry => entry.endsWith('assets/easi-view.js')));
            assert.equal(info.inlineStyleSha256, createHash('sha256').update(stylesheet).digest('base64'));
        });

        await t.test('altered embedding stylesheet hash is rejected before packaging', async () => {
            const file = resolve(fixture, 'dist/build-info.json');
            const original = await readFile(file, 'utf8');
            const info = JSON.parse(original);
            info.inlineStyleSha256 = createHash('sha256').update('different stylesheet').digest('base64');
            await writeFile(file, JSON.stringify(info));
            const result = run('pack-artifact.mjs');
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /Embedding stylesheet CSP hash must match/);
            await writeFile(file, original);
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

        await t.test('AI configuration cannot enter a static release even with an updated inventory', async () => {
            const file = resolve(fixture, 'dist/viewer-config.json');
            const infoFile = resolve(fixture, 'dist/build-info.json');
            const original = await readFile(infoFile, 'utf8');
            await writeFile(file, '{"ai":{"enabled":false}}');
            const info = JSON.parse(original);
            const { distInventory } = await import(pathToFileURL(resolve(fixture, 'tools/dist-manifest.mjs')).href);
            info.files = await distInventory(resolve(fixture, 'dist'));
            await writeFile(infoFile, JSON.stringify(info));
            try {
                const result = run('pack-artifact.mjs');
                assert.notEqual(result.status, 0);
                assert.match(result.stderr, /AI (?:runtime code or configuration|deployment asset) must not enter/);
            } finally {
                await rm(file);
                await writeFile(infoFile, original);
            }
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

        await t.test('a disabled AI import is rejected from actual bundler inputs', async () => {
            await mkdir(resolve(fixture, 'src/ai'));
            await writeFile(resolve(fixture, 'src/ai/disabled.js'), 'export const disabled = true;\n');
            await writeFile(resolve(fixture, 'src/main.js'), "import './ai/disabled.js';\nexport const fixture = 3;\n");
            const result = run('build.mjs');
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /AI experiment input must not enter the base viewer/);
        });
    } finally { await rm(fixture, { recursive: true, force: true }); }
});
