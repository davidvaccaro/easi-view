import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

/** Fingerprint every owned input used to produce the browser distribution. */
export async function sourceDigest(root) {
    const files = [];
    async function visit(file) {
        const info = await stat(file);
        if (info.isDirectory()) {
            for (const name of (await readdir(file)).sort()) await visit(resolve(file, name));
        } else files.push(file);
    }
    for (const name of ['src', 'public', 'index.html', 'package.json', 'package-lock.json', 'LICENSE', 'NOTICE', 'tools/build.mjs', 'tools/source-digest.mjs', 'tools/dist-manifest.mjs']) {
        await visit(resolve(root, name));
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
