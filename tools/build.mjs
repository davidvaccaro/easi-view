import { build } from 'esbuild';
import { mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sourceDigest } from './source-digest.mjs';
import { distInventory } from './dist-manifest.mjs';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'dist');
const inputs = await sourceDigest(root);
await rm(out, { recursive: true, force: true });
await mkdir(resolve(out, 'assets'), { recursive: true });
const result = await build({
    absWorkingDir: root,
    entryPoints: { app: 'src/main.js', 'decode-worker': 'src/runtime/decode-worker.js' },
    outdir: resolve(out, 'assets'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    minify: true,
    sourcemap: false,
    metafile: true,
    legalComments: 'linked'
});
await cp(resolve(root, 'index.html'), resolve(out, 'index.html'));
await cp(resolve(root, 'src/ui/styles.css'), resolve(out, 'assets/app.css'));
await cp(resolve(root, 'public'), out, { recursive: true });
for (const name of ['LICENSE', 'NOTICE']) await cp(resolve(root, name), resolve(out, name));
await mkdir(resolve(out, 'licenses'), { recursive: true });
const dependency = resolve(root, 'node_modules/@xinonix/easi-js');
await cp(resolve(dependency, 'LICENSE'), resolve(out, 'licenses/EASI-JS-LICENSE.txt'));
await cp(resolve(dependency, 'NOTICE'), resolve(out, 'licenses/EASI-JS-NOTICE.txt'));
await cp(resolve(dependency, 'licenses'), resolve(out, 'licenses/easi-js'), { recursive: true });
if (await sourceDigest(root) !== inputs) throw new Error('Build inputs changed while bundling. Rebuild once the source changes are saved.');
await writeFile(resolve(out, 'build-info.json'), JSON.stringify({
    project: 'EASI View', version: JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version,
    easiJsVersion: '1.0.0', renderer: 'owned WebGL2 / Canvas2D reference', sourceDigest: inputs,
    files: await distInventory(out),
    entries: Object.keys(result.metafile.outputs).filter(name => name.endsWith('.js'))
}, null, 2) + '\n');
console.log('Built EASI View in dist/ with EASI JS and redistribution notices.');
