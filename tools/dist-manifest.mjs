import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

export async function distInventory(root) {
    const entries = [];
    async function visit(directory) {
        for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            const file = resolve(directory, entry.name);
            if (entry.isSymbolicLink()) throw new Error('Distribution files cannot be symbolic links.');
            if (entry.isDirectory()) await visit(file);
            else if (file !== resolve(root, 'build-info.json')) {
                const bytes = await readFile(file);
                entries.push({ path: relative(root, file).replaceAll('\\', '/'), bytes: bytes.length,
                    sha256: createHash('sha256').update(bytes).digest('hex') });
            }
        }
    }
    await visit(root);
    return entries;
}
