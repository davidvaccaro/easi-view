import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

/** Fingerprint owned inputs and the independently installed EASI JS core. */
export async function sourceDigest(root) {
    const files = [];
    async function visit(file) {
        const info = await stat(file);
        if (info.isDirectory()) {
            for (const name of (await readdir(file)).sort()) await visit(resolve(file, name));
        } else files.push(file);
    }
    for (const name of ['src', 'public', 'licenses', 'index.html', 'package.json', 'package-lock.json', 'LICENSE', 'NOTICE', 'tools/build.mjs', 'tools/source-digest.mjs', 'tools/dist-manifest.mjs', 'tools/release-profile.mjs']) {
        await visit(resolve(root, name));
    }
    for (const name of ['src', 'package.json', 'LICENSE', 'NOTICE', 'licenses']) {
        await visit(resolve(root, 'node_modules/@xinonix/easi-js', name));
    }
    const hash = createHash('sha256');
    for (const file of files.sort()) {
        hash.update(relative(root, file).replaceAll('\\', '/'));
        hash.update('\0');
        hash.update(await readFile(file));
        hash.update('\0');
    }
    return hash.digest('hex');
}
