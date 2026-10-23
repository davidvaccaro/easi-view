import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createCompressedDicom } from '../test/compressed-fixtures.js';
import { browserSession, delay } from './browser-session.mjs';
import { startCorpusServer } from './local-corpus-check.mjs';
import { sourceDigest } from './source-digest.mjs';

const root = resolve(import.meta.dirname, '..');
const work = await mkdtemp(resolve(tmpdir(), 'easi-j2k-browser-'));
const output = resolve(root, 'artifacts/browser-jpeg2000-ybr');
let browser, server;
try {
    const info = JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8'));
    assert.equal(await sourceDigest(root), info.sourceDigest, 'Build is stale.');
    const host = resolve(work, 'host'); await mkdir(host); await mkdir(output, { recursive: true });
    await writeFile(resolve(host, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="host.css"><div id="viewer"></div><script type="module" src="host.js"></script>');
    await writeFile(resolve(host, 'host.css'), 'html,body{margin:0;background:#000}#viewer{height:900px;width:1200px}');
    await writeFile(resolve(host, 'host.js'), `
import { createViewer } from '/assets/easi-view.js';
window.__jpegGate = { ready: true, async run(encoded, expected) {
    const OriginalWorker = window.Worker; let created = 0, terminated = 0, decodeCalls = 0, viewer;
    window.Worker = class extends OriginalWorker {
        constructor(...args) { super(...args); created++; }
        postMessage(...args) { decodeCalls++; return super.postMessage(...args); }
        terminate() { terminated++; return super.terminate(); }
    };
    try {
        viewer = createViewer(document.getElementById('viewer'), { ui: { library: false, inspector: false, demos: false } });
        await viewer.ready;
        const canvas = document.querySelector('easi-view-embed').shadowRoot.getElementById('image-canvas');
        const gl = canvas.getContext('webgl2'); if (!gl) throw new Error('Generated JPEG2000 gate requires WebGL2.');
        const upload = gl.texImage2D.bind(gl), uploads = [];
        gl.texImage2D = (...args) => { if (args[8]?.length === 27) uploads.push([...args[8]]); return upload(...args); };
        const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
        await viewer.openFiles([new File([bytes], 'synthetic-j2k-ybr.dcm', { type: 'application/dicom' })]);
        if (!uploads.length || uploads.at(-1).some((v,i) => v !== expected[i])) throw new Error('Real worker did not upload the independently known RGB channels.');
        const program = gl.getParameter(gl.CURRENT_PROGRAM), matrix = gl.getUniform(program, gl.getUniformLocation(program, 'imageToClip'));
        if (!matrix || matrix.length !== 9) throw new Error('Missing image transform.');
        const pixels = [];
        for (let index = 0; index < 9; index++) {
            const x = index % 3 + .5, y = Math.floor(index / 3) + .5;
            const clipX = matrix[0]*x + matrix[3]*y + matrix[6], clipY = matrix[1]*x + matrix[4]*y + matrix[7];
            const pixel = new Uint8Array(4);
            gl.readPixels(Math.floor((clipX + 1)*canvas.width/2), Math.floor((clipY + 1)*canvas.height/2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
            for (let channel = 0; channel < 3; channel++) if (Math.abs(pixel[channel] - expected[index*3 + channel]) > 1) throw new Error('Actual JPEG2000 RGB framebuffer differs from independent color oracle.');
            if (pixel[3] !== 255) throw new Error('Unexpected output alpha.');
            pixels.push([...pixel]);
        }
        if (!created || !decodeCalls || gl.getError() !== gl.NO_ERROR) throw new Error('Missing real worker or GPU error.');
        viewer.dispose(); await new Promise(resolve => setTimeout(resolve, 100));
        if (created !== terminated || document.querySelector('easi-view-embed')) throw new Error('Generated session did not release its worker and mount.');
        return { created, terminated, decodeCalls, pixels };
    } finally { viewer?.dispose(); window.Worker = OriginalWorker; }
} };
`);
    server = await startCorpusServer({ dist: resolve(root, 'dist'), host, styleHash: info.inlineStyleSha256 });
    browser = await browserSession(resolve(work, 'browser'));
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
    await browser.send('Page.navigate', { url: server.url });
    await browser.until('window.__jpegGate?.ready', 'Generated codec browser gate did not initialize.');
    const samples = [0,128,128,255,128,128,128,128,128,76,84,255,149,43,21,29,255,107,100,100,200,0,0,0,255,255,255];
    const expected = [0,0,0,255,255,255,128,128,128,254,0,0,0,255,0,0,0,254,201,58,50,0,135,0,255,121,255];
    const checks = [];
    for (const suffix of [90, 91]) {
        const fixture = await createCompressedDicom({ codec: 'jpeg2000', rows: 3, columns: 3, samplesPerPixel: 3, bitsAllocated: 8, bitsStored: 8, signed: false, photometric: 'YBR_FULL', transferSyntax: '1.2.840.10008.1.2.4.' + suffix, frameSamples: [samples] });
        const result = await browser.evaluate('window.__jpegGate.run(' + JSON.stringify(Buffer.from(fixture.bytes).toString('base64')) + ',' + JSON.stringify(expected) + ')');
        checks.push({ transferSyntax: '1.2.840.10008.1.2.4.' + suffix, ...result });
    }
    assert.equal(browser.errors.length, 0); assert.equal(browser.consoleErrors.length, 0);
    const origin = new URL(server.url).origin;
    assert.equal(browser.requests.filter(r => !['GET','HEAD','OPTIONS'].includes(r.method) || ['http:','https:'].includes(new URL(r.url).protocol) && new URL(r.url).origin !== origin).length, 0);
    assert.equal(await sourceDigest(root), info.sourceDigest, 'Sources changed during browser qualification.');
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ checkedAt: new Date().toISOString(), sourceDigest: info.sourceDigest, easiJsVersion: info.easiJsVersion, scope: 'Generated DICOM through actual SDK, real decode worker and WASM to independently known RGB uploads and actual WebGL pixels; no original images.', checks }, null, 2) + '\n');
    console.log('PASS: JPEG2000 .90/.91 YBR_FULL through real SDK/worker/WASM, 18 independent RGB framebuffer checks, complete worker/mount cleanup.');
} finally {
    browser?.close(); if (server) await server.close(); await delay(250); await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
