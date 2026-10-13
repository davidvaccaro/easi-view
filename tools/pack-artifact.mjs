import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readdir, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import './check-dist.mjs';
import { sourceDigest } from './source-digest.mjs';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
const directory = resolve(root, 'artifacts/releases');
await mkdir(directory, { recursive: true });
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const buildInfo = JSON.parse(await readFile(resolve(dist, 'build-info.json'), 'utf8'));
if (buildInfo.sourceDigest !== await sourceDigest(root)) throw new Error('The browser build is stale. Run npm run build before packaging.');
if (!/^[0-9A-Za-z.-]+$/.test(pkg.version)) throw new Error('The package version is not a safe artifact filename.');
const name = `easi-view-${pkg.version}`;
const files = [];
async function collect(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = resolve(directory, entry.name);
        if (entry.isDirectory()) await collect(file);
        else {
            const bytes = await readFile(file);
            files.push({ path: relative(dist, file).replaceAll('\\', '/'), bytes: bytes.length,
                sha256: createHash('sha256').update(bytes).digest('hex') });
        }
    }
}
await collect(dist);
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
const state = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
const archive = resolve(directory, `${name}.tar.gz`);
const tar = spawnSync('tar', ['-czf', archive, '-C', dist, '.'], { encoding: 'utf8' });
if (tar.status !== 0) throw new Error('Could not package the static distribution with tar.');
const checksum = createHash('sha256').update(await readFile(archive)).digest('hex');
const manifest = {
    project: pkg.name, version: pkg.version, easiJsVersion: pkg.dependencies['@xinonix/easi-js'],
    sourceCommit: revision.status === 0 ? revision.stdout.trim() : null,
    sourceClean: state.status === 0 && state.stdout.trim() === '',
    sourceDigest: buildInfo.sourceDigest, createdAt: new Date().toISOString(), archive: `${name}.tar.gz`,
    archiveBytes: (await stat(archive)).size, archiveSha256: checksum, files
};
await writeFile(resolve(directory, `${name}.manifest.json`), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(resolve(directory, `${name}.sha256`), `${checksum}  ${name}.tar.gz\n`);
console.log(`Packaged artifacts/releases/${name}.tar.gz with a per-file SHA-256 manifest.`);
