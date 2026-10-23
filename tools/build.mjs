import { build } from 'esbuild';
import { mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { sourceDigest } from './source-digest.mjs';
import { distInventory } from './dist-manifest.mjs';
import { EMBED_STYLE_PREFIX } from '../src/integration/style-prefix.js';
import { RELEASE_PROFILE, releaseModules } from './release-profile.mjs';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'dist');
const packageInfo = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const dependency = resolve(root, 'node_modules/@xinonix/easi-js');
const easiJsPackage = JSON.parse(await readFile(resolve(dependency, 'package.json'), 'utf8'));
if (packageInfo.dependencies?.['@xinonix/easi-js'] !== easiJsPackage.version) {
    throw new Error('The installed EASI JS core does not match the exact declared version. Install the pinned dependency before building.');
}
const inputs = await sourceDigest(root);
const inlineStyleSha256 = createHash('sha256')
    .update(EMBED_STYLE_PREFIX + await readFile(resolve(root, 'src/ui/styles.css'), 'utf8'))
    .digest('base64');
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
const sdk = await build({
    absWorkingDir: root,
    entryPoints: { 'easi-view': 'src/integration/viewer.js' },
    outdir: resolve(out, 'assets'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    minify: true,
    sourcemap: false,
    metafile: true,
    loader: { '.css': 'text' },
    legalComments: 'linked'
});
const bundledModules = releaseModules(result.metafile, sdk.metafile);
await cp(resolve(root, 'node_modules/dcmjs-codecs/build/dcmjs-native-codecs.wasm'), resolve(out, 'assets/dicom-codecs.wasm'));
await cp(resolve(root, 'src/integration/easi-view.d.ts'), resolve(out, 'assets/easi-view.d.ts'));
await cp(resolve(root, 'index.html'), resolve(out, 'index.html'));
await cp(resolve(root, 'src/ui/styles.css'), resolve(out, 'assets/app.css'));
await cp(resolve(root, 'public'), out, { recursive: true });
for (const name of ['LICENSE', 'NOTICE']) await cp(resolve(root, name), resolve(out, name));
await mkdir(resolve(out, 'licenses'), { recursive: true });
await cp(resolve(dependency, 'LICENSE'), resolve(out, 'licenses/EASI-JS-LICENSE.txt'));
await cp(resolve(dependency, 'NOTICE'), resolve(out, 'licenses/EASI-JS-NOTICE.txt'));
await cp(resolve(dependency, 'licenses'), resolve(out, 'licenses/easi-js'), { recursive: true });
await cp(resolve(root, 'node_modules/jpeg-js/LICENSE'), resolve(out, 'licenses/JPEG-JS-LICENSE.txt'));
await cp(resolve(root, 'node_modules/dcmjs-codecs/LICENSE.txt'), resolve(out, 'licenses/DCMJS-CODECS-LICENSE.txt'));
await cp(resolve(root, 'licenses/codecs'), resolve(out, 'licenses/codecs'), { recursive: true });
if (await sourceDigest(root) !== inputs) throw new Error('Build inputs changed while bundling. Rebuild once the source changes are saved.');
await writeFile(resolve(out, 'build-info.json'), JSON.stringify({
    project: 'EASI View', version: packageInfo.version, releaseProfile: RELEASE_PROFILE, bundledModules,
    easiJsVersion: easiJsPackage.version, renderer: 'owned WebGL2 / Canvas2D reference', sourceDigest: inputs,
    inlineStyleSha256,
    files: await distInventory(out),
    entries: [...Object.keys(result.metafile.outputs), ...Object.keys(sdk.metafile.outputs)].filter(name => name.endsWith('.js'))
}, null, 2) + '\n');
console.log('Built EASI View in dist/ with EASI JS and redistribution notices.');
