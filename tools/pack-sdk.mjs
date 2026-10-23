import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { sourceDigest } from './source-digest.mjs';
import './check-dist.mjs';

const root = resolve(import.meta.dirname, '..');
const target = resolve(root, 'artifacts/releases');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const build = JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8'));
if (build.sourceDigest !== await sourceDigest(root)) throw new Error('The SDK build is stale. Run npm run build before packing.');
await mkdir(target, { recursive: true });
const result = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', target], { cwd: root, encoding: 'utf8' });
if (result.status !== 0) throw new Error('npm could not create the local SDK archive.');
const packed = JSON.parse(result.stdout)[0];
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(packed.filename)) throw new Error('npm returned an invalid local artifact name.');
const paths = new Set(packed.files.map(file => file.path));
try {
    for (const file of ['dist/assets/easi-view.js', 'dist/assets/easi-view.d.ts', 'dist/assets/decode-worker.js', 'dist/assets/dicom-codecs.wasm', 'tools/copy-assets.mjs', 'LICENSE', 'NOTICE', 'README.md']) {
        if (!paths.has(file)) throw new Error(`The SDK archive is missing ${file}.`);
    }
    if (paths.size > 1000) throw new Error('The SDK archive exceeds its file-count limit.');
    let total = 0;
    for (const path of paths) {
        if (!/^(?:dist\/|docs\/|licenses\/|examples\/dimse-gateway\/(?:gateway\.mjs|server\.mjs|README\.md)$|tools\/copy-assets\.mjs$|package\.json$|README\.md$|LICENSE$|NOTICE$|CHANGELOG\.md$)/.test(path) ||
            path.split('/').some(name => name.startsWith('.env') || name === '..') || /\.(dcm|dicom)$/i.test(path)) throw new Error('The SDK archive includes an unintended repository file.');
        const bytes = await readFile(resolve(root, path)); total += bytes.length;
        if (bytes.length > 16 * 1024 * 1024 || total > 32 * 1024 * 1024 || bytes.length >= 132 && bytes.subarray(128, 132).toString() === 'DICM') throw new Error('The SDK archive includes an unsupported asset or exceeds its byte limit.');
    }
} catch (error) { await rm(resolve(target, packed.filename), { force: true }); throw error; }
const archive = await readFile(resolve(target, packed.filename));
const checksum = createHash('sha256').update(archive).digest('hex');
const manifest = { name: pkg.name, version: pkg.version, archive: packed.filename,
    sha256: checksum, npmIntegrity: packed.integrity, sourceDigest: build.sourceDigest,
    fileCount: paths.size, files: packed.files };
await writeFile(resolve(target, packed.filename.replace(/\.tgz$/, '.manifest.json')), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(resolve(target, `${packed.filename}.sha256`), `${checksum}  ${packed.filename}\n`);
console.log(`Created installable SDK artifacts/releases/${packed.filename} with checksums and license notices.`);
