import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, symlink, readFile, realpath, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

test('installable SDK includes adjacent runtime assets and rejects unintended repository content', async t => {
    const project = resolve(import.meta.dirname, '..');
    const root = await mkdtemp(resolve(tmpdir(), 'easi-view-sdk-test-'));
    const run = tool => spawnSync(process.execPath, [resolve(root, 'tools', tool)], { cwd: root, encoding: 'utf8' });
    try {
        for (const name of ['src', 'public', 'tools', 'licenses', 'docs', 'index.html', 'package.json', 'package-lock.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE']) {
            await cp(resolve(project, name), resolve(root, name), { recursive: true });
        }
        await cp(resolve(project, 'examples/dimse-gateway'), resolve(root, 'examples/dimse-gateway'), { recursive: true });
        await symlink(resolve(project, 'node_modules'), resolve(root, 'node_modules'), 'dir');
        let result = run('build.mjs'); assert.equal(result.status, 0, result.stderr);
        result = run('pack-sdk.mjs'); assert.equal(result.status, 0, result.stderr);
        const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
        const name = `xinonix-easi-view-${pkg.version}`;
        const manifest = JSON.parse(await readFile(resolve(root, 'artifacts/releases', `${name}.manifest.json`), 'utf8'));
        const archive = resolve(root, 'artifacts/releases', `${name}.tgz`);
        assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), manifest.sha256);
        const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' }); assert.equal(listing.status, 0);
        for (const path of ['dist/assets/easi-view.js', 'dist/assets/easi-view.d.ts', 'dist/assets/decode-worker.js', 'dist/assets/dicom-codecs.wasm', 'dist/build-info.json', 'tools/copy-assets.mjs', 'examples/dimse-gateway/gateway.mjs', 'examples/dimse-gateway/server.mjs', 'examples/dimse-gateway/README.md', 'LICENSE', 'NOTICE', 'README.md']) {
            assert.ok(listing.stdout.split('\n').includes(`package/${path}`), path);
        }
        for (const path of ['docs/AI_ASSIST.md', 'docs/AI_WORKFLOWS.md', 'dist/viewer-config.json']) {
            assert.equal(listing.stdout.split('\n').includes(`package/${path}`), false, path);
        }
        const releaseInfo = JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8'));
        assert.equal(releaseInfo.releaseProfile, 'core-no-ai');
        assert.equal(releaseInfo.bundledModules.some(path => path.startsWith('src/ai/')), false);
        const types = await readFile(resolve(root, 'dist/assets/easi-view.d.ts'), 'utf8');
        assert.doesNotMatch(types, /AiConfiguration|AiState|AiDraft|openAiAssist|aichange/);
        assert.match(types, /importDerived\(/, 'DICOM derived-result import remains available.');
        assert.match(types, /addOverlay\(/, 'Explicit host-supplied overlays remain available.');
        assert.equal(pkg.exports['.'].types, './dist/assets/easi-view.d.ts');
        assert.equal(pkg.publishConfig.access, 'public');
        assert.equal(pkg.publishConfig.tag, pkg.version.includes('-') ? 'next' : 'latest', 'Prerelease artifacts must not default to the stable npm tag.');
        const { copyViewerAssets } = await import(pathToFileURL(resolve(root, 'tools/copy-assets.mjs')).href);
        const destination = resolve(root, 'consumer/public/viewer');
        await copyViewerAssets(destination);
        const copiedFiles = ['assets/easi-view.js', 'assets/decode-worker.js', 'assets/dicom-codecs.wasm', 'build-info.json', 'LICENSE', 'NOTICE'];
        for (const path of copiedFiles) {
            assert.deepEqual(await readFile(resolve(destination, path)), await readFile(resolve(root, 'dist', path)));
        }
        await assert.rejects(copyViewerAssets(destination), /already exists/);
        const cli = await realpath(resolve(root, 'tools/copy-assets.mjs'));
        const alias = resolve(root, 'cli-directory-alias');
        await symlink(await realpath(root), alias, 'dir');
        const bin = resolve(root, 'consumer/node_modules/.bin/easi-view-copy-assets');
        await mkdir(dirname(bin), { recursive: true });
        await symlink(cli, bin, 'file');
        for (const [name, executable, args] of [
            ['direct CLI', process.execPath, [cli]],
            ['directory-alias CLI', process.execPath, [resolve(alias, 'tools/copy-assets.mjs')]],
            ['package-bin symlink CLI', bin, []]
        ]) await t.test(name + ' copies every asset and rejects an existing destination', async () => {
            const target = resolve(root, 'consumer/public', name.replaceAll(' ', '-'));
            const invoke = () => spawnSync(executable, [...args, target], { cwd: root, encoding: 'utf8', timeout: 30000 });
            const copied = invoke();
            assert.equal(copied.status, 0, copied.stderr || copied.error?.message);
            assert.equal(copied.stdout.trim(), `Copied EASI View assets and license notices to ${target}`);
            for (const path of copiedFiles) assert.deepEqual(await readFile(resolve(target, path)), await readFile(resolve(root, 'dist', path)));
            const marker = resolve(target, 'consumer-owned.txt');
            await writeFile(marker, 'Keep the existing destination intact.');
            const repeated = invoke();
            assert.notEqual(repeated.status, 0);
            assert.match(repeated.stderr, /destination already exists/);
            assert.doesNotMatch(repeated.stdout, /Copied EASI View/);
            assert.equal(await readFile(marker, 'utf8'), 'Keep the existing destination intact.');
            for (const path of copiedFiles) assert.deepEqual(await readFile(resolve(target, path)), await readFile(resolve(root, 'dist', path)));
        });
        await writeFile(resolve(root, 'docs/AI_ASSIST.md'), '# Generated historical-only guide marker.\n');
        result = run('pack-sdk.mjs'); assert.notEqual(result.status, 0); assert.match(result.stderr, /unintended release document/);
        await assert.rejects(stat(archive), { code: 'ENOENT' });
        await rm(resolve(root, 'docs/AI_ASSIST.md'));
        await writeFile(resolve(root, 'fixture-only.txt'), 'Generated harmless test marker.');
        pkg.files.push('fixture-only.txt'); await writeFile(resolve(root, 'package.json'), JSON.stringify(pkg));
        result = run('build.mjs'); assert.equal(result.status, 0, result.stderr);
        result = run('pack-sdk.mjs'); assert.notEqual(result.status, 0); assert.match(result.stderr, /unintended repository file/);
        await assert.rejects(stat(archive), { code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
});
