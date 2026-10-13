import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { distInventory } from './dist-manifest.mjs';
const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'dist');
const required = ['index.html', 'assets/app.js', 'assets/app.css', 'assets/decode-worker.js', 'LICENSE', 'NOTICE', 'licenses/EASI-JS-LICENSE.txt', 'licenses/EASI-JS-NOTICE.txt'];
for (const name of required) assert((await stat(resolve(out, name))).size > 0, `Missing ${name}`);
const html = await readFile(resolve(out, 'index.html'), 'utf8');
assert(html.includes('assets/app.js') && html.includes('assets/app.css'), 'HTML must reference the built app.');
assert(!/<script[^>]+src=["']https?:/i.test(html), 'Runtime scripts must be local.');
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
        }
    }
}
await check(out);
const info = JSON.parse(await readFile(resolve(out, 'build-info.json'), 'utf8'));
assert.deepEqual(await distInventory(out), info.files, 'Distribution changed after building. Rebuild to remove QA files or modified output.');
console.log('Distributable checked: local assets, own renderer, synthetic-only demos, and license notices.');
