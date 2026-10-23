import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { sourceDigest } from '../tools/source-digest.mjs';

test('qualification fingerprint detects core source drift even with unchanged version and lock', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'easi-view-core-digest-'));
    try {
        for (const name of ['src', 'public', 'licenses', 'node_modules/@xinonix/easi-js/src', 'node_modules/@xinonix/easi-js/licenses']) {
            await mkdir(resolve(directory, name), { recursive: true });
        }
        for (const name of ['index.html', 'package.json', 'package-lock.json', 'LICENSE', 'NOTICE', 'tools/build.mjs',
            'tools/source-digest.mjs', 'tools/dist-manifest.mjs', 'tools/release-profile.mjs', 'node_modules/@xinonix/easi-js/package.json',
            'node_modules/@xinonix/easi-js/LICENSE', 'node_modules/@xinonix/easi-js/NOTICE', 'node_modules/@xinonix/easi-js/src/index.js']) {
            await mkdir(dirname(resolve(directory, name)), { recursive: true });
            await writeFile(resolve(directory, name), 'Generated synthetic provenance fixture.\n');
        }
        const before = await sourceDigest(directory);
        await writeFile(resolve(directory, 'node_modules/@xinonix/easi-js/src/index.js'), 'export const fixture = 2;\n');
        const changed = await sourceDigest(directory);
        assert.notEqual(changed, before);
        assert.equal(await sourceDigest(directory), changed);
        await writeFile(resolve(directory, 'node_modules/@xinonix/easi-js/src/index.js'), 'Generated synthetic provenance fixture.\n');
        assert.equal(await sourceDigest(directory), before);
    } finally { await rm(directory, { recursive: true, force: true }); }
});
