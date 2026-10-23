import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { distInventory } from './dist-manifest.mjs';
import { EMBED_STYLE_PREFIX } from '../src/integration/style-prefix.js';
import { RELEASE_PROFILE, assertReleaseModules, assertReleaseRuntime } from './release-profile.mjs';
const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'dist');
const required = ['index.html', 'assets/app.js', 'assets/app.css', 'standalone.css', 'assets/easi-view.js', 'assets/easi-view.d.ts', 'assets/decode-worker.js', 'assets/dicom-codecs.wasm', 'licenses/JPEG-JS-LICENSE.txt', 'licenses/DCMJS-CODECS-LICENSE.txt', 'embed.html', 'embed-demo.js', 'embed-demo.css', 'LICENSE', 'NOTICE', 'licenses/EASI-JS-LICENSE.txt', 'licenses/EASI-JS-NOTICE.txt'];
for (const name of required) assert((await stat(resolve(out, name))).size > 0, `Missing ${name}`);
const html = await readFile(resolve(out, 'index.html'), 'utf8');
assert(html.includes('assets/app.js') && html.includes('assets/app.css'), 'HTML must reference the built app.');
assert(!/<script[^>]+src=["']https?:/i.test(html), 'Runtime scripts must be local.');
const embedHtml = await readFile(resolve(out, 'embed.html'), 'utf8');
assert(embedHtml.includes('embed-demo.js') && embedHtml.includes('embed-demo.css'), 'Embedding example must reference its local script and styles.');
assert(!/<script[^>]+src=["']https?:/i.test(embedHtml), 'Embedding example scripts must be local.');
const embedScript = await readFile(resolve(out, 'embed-demo.js'), 'utf8');
assert(embedScript.includes('assets/easi-view.js'), 'Embedding example must import the distributable viewer SDK.');
assert(!(await readdir(resolve(out, 'assets'))).includes('easi-view.css'), 'Embedding SDK must carry its scoped styles without a global stylesheet.');
assert(!/(?:cornerstone|@ohif|vtk\.js|three\/)/i.test(await readFile(resolve(root, 'package-lock.json'), 'utf8')), 'External viewer engines must not enter the dependency graph.');
async function check(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = resolve(directory, entry.name);
        assert(!entry.isSymbolicLink(), 'No symlinks in distributable.');
        if (entry.isDirectory()) await check(file);
        else {
            assert(!/\.(dcm|dicom)$/i.test(entry.name), 'Demo images must be generated, not copied from a corpus.');
            const bytes = await readFile(file);
            assert(bytes.length < 132 || bytes.subarray(128, 132).toString() !== 'DICM', 'No imaging corpus files in distributable.');
            assert(!/^\.env/i.test(entry.name), 'No environment files in distributable.');
            assertReleaseRuntime(file, bytes.toString('utf8'));
        }
    }
}
await check(out);
const info = JSON.parse(await readFile(resolve(out, 'build-info.json'), 'utf8'));
assert.equal(info.releaseProfile, RELEASE_PROFILE, 'The distribution must be the base viewer release profile.');
assertReleaseModules(info.bundledModules);
const inlineStyleSha256 = createHash('sha256')
    .update(EMBED_STYLE_PREFIX + await readFile(resolve(out, 'assets/app.css'), 'utf8'))
    .digest('base64');
assert.equal(info.inlineStyleSha256, inlineStyleSha256, 'Embedding stylesheet CSP hash must match the owned stylesheet.');
assert.deepEqual(await distInventory(out), info.files, 'Distribution changed after building. Rebuild to remove QA files or modified output.');
console.log('Distributable checked: local assets, own renderer, AI-free release, synthetic-only demos, and license notices.');
