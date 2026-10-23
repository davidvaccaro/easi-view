import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { build } from 'esbuild';

test('a minified SDK can be bundled again for a browser without Node built-ins, preserving worker and codec asset references', async () => {
    const root = resolve(import.meta.dirname, '..');
    const options = { bundle: true, minify: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, metafile: true, loader: { '.css': 'text' } };
    const published = await build({ ...options, absWorkingDir: root, entryPoints: ['src/integration/viewer.js'] });
    const consumer = await build({ ...options, stdin: { contents: published.outputFiles[0].text, resolveDir: root, sourcefile: 'installed-easi-view.js' } });
    const output = consumer.outputFiles[0].text;
    assert.match(output, /decode-worker\.js/u);
    assert.match(output, /dicom-codecs\.wasm/u);
    assert.ok(Object.values(consumer.metafile.outputs).some(file =>
        file.exports.includes('createViewer') && file.exports.includes('createEnterpriseViewer')));
    assert.equal(Object.values(consumer.metafile.outputs).flatMap(file => file.imports).some(item => item.path.startsWith('node:')), false);
    assert.doesNotMatch(output, /import\(["']node:fs\/promises["']\)/u);
});
