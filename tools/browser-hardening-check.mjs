import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { browserSession, delay } from './browser-session.mjs';
import { startCorpusServer } from './local-corpus-check.mjs';
import { sourceDigest } from './source-digest.mjs';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'artifacts/browser-hardening');
const work = await mkdtemp(resolve(tmpdir(), 'easi-view-hardening-browser-'));
const host = resolve(work, 'host');
let browser, server;
const entry = `
import { ImageViewport, renderScalarToRgba, probe } from './src/render/ImageViewport.js';
window.__hardening = { ready: true, run() {
    const checks = [], visible = new Set([3, 7, 8, 9, 13]);
    for (const cpu of [false, true]) {
        const canvas = document.createElement('canvas'); canvas.className = 'numeric'; document.body.append(canvas);
        const native = canvas.getContext.bind(canvas);
        if (cpu) canvas.getContext = (kind, ...args) => kind === 'webgl2' ? null : native(kind, ...args);
        const viewport = new ImageViewport(canvas), gl = cpu ? null : canvas.getContext('webgl2');
        if (!cpu && !gl) throw new Error('This numeric gate requires WebGL2.');
        const read = index => {
            const p = viewport.imageToScreen(index % 5 + .5, Math.floor(index / 5) + .5);
            if (p.x < 0 || p.y < 0 || p.x >= canvas.width || p.y >= canvas.height) throw new Error('Probe left the test canvas.');
            if (!gl) return [...canvas.getContext('2d').getImageData(Math.floor(p.x), Math.floor(p.y), 1, 1).data];
            const pixel = new Uint8Array(4); gl.readPixels(Math.floor(p.x), canvas.height - 1 - Math.floor(p.y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel); return [...pixel];
        };
        for (const photometric of ['MONOCHROME2', 'MONOCHROME1']) for (const presentationValue of [0, 16384, 65535]) {
            const samples = new Uint16Array(25).fill(255), before = [...samples];
            const frame = { id: 'generated-shutter', rows: 5, columns: 5, pixelSpacing: [1,1], photometric,
                samples, samplesPerPixel: 1, bitsAllocated: 16, bitsStored: 8, highBit: 7, signed: false,
                slope: 1, intercept: 0, unit: '', window: { center: 128, width: 256 }, range: { min: 0, max: 255 },
                displayShutter: { shape: 'CIRCULAR', row: 2, column: 4, radius: 1, presentationValue, presentationValueDeclared: true } };
            viewport.setFrame(frame);
            let uploads = 0, upload;
            if (gl) { upload = gl.texImage2D.bind(gl); gl.texImage2D = (...args) => { uploads++; return upload(...args); }; }
            for (const invert of [false, true]) {
                viewport.setTransform({ invert });
                for (const transformed of [false, true]) {
                    viewport.setTransform(transformed ? { zoom: .8, rotation: 90, flipX: true, panX: 6, panY: -4 } : { zoom: 1, rotation: 0, flipX: false, panX: 0, panY: 0 });
                    const inside = ((photometric === 'MONOCHROME1') !== invert) ? 0 : 255;
                    const outside = Math.round(presentationValue * 255 / 65535);
                    const reference = renderScalarToRgba(frame, { center: 128, width: 256, invert });
                    for (let index = 0; index < 25; index++) {
                        const wanted = visible.has(index) ? inside : outside, actual = read(index);
                        for (let channel = 0; channel < 3; channel++) {
                            if (Math.abs(actual[channel] - wanted) > (cpu ? 0 : 1)) throw new Error('Actual renderer differs from independent shutter oracle.');
                            if (reference[index * 4 + channel] !== wanted) throw new Error('CPU reference differs from independent shutter oracle.');
                        }
                        if (actual[3] !== 255) throw new Error('Shutter transparency changed.');
                    }
                    const point = probe(frame, .5, .5);
                    if (point.stored !== 255 || point.rescaled !== 255 || samples.some((value,index) => value !== before[index])) throw new Error('Display mask changed source or probe values.');
                    if (gl && gl.getError() !== gl.NO_ERROR) throw new Error('Shutter renderer produced a GL error.');
                    checks.push({ backend: cpu ? 'Canvas2D' : 'WebGL2', photometric, presentationValue, invert, transformed, pixels: 25 });
                }
            }
            if (gl) { gl.texImage2D = upload; if (uploads !== 0) throw new Error('Transforming the shutter reuploaded original samples.'); }
            viewport.setFrame({ ...frame, id: 'generated-no-shutter', photometric: 'MONOCHROME2', displayShutter: null });
            for (let index = 0; index < 25; index++) if (read(index).some((value, channel) => value !== 255)) throw new Error('A shutter leaked into the following ordinary frame.');
        }
        viewport.dispose(); canvas.remove();
    }
    return checks;
} };
`;
try {
    const info = JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8'));
    assert.equal(await sourceDigest(root), info.sourceDigest, 'Build is stale.');
    await mkdir(host); await mkdir(output, { recursive: true });
    await build({ stdin: { contents: entry, resolveDir: root, sourcefile: 'generated-hardening-entry.js' }, outfile: resolve(host, 'hardening.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true });
    await writeFile(resolve(host, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="host.css"><script type="module" src="hardening.js"></script>');
    await writeFile(resolve(host, 'host.css'), 'body{margin:0;background:#000}.numeric{width:360px;height:360px;display:block}');
    server = await startCorpusServer({ dist: resolve(root, 'dist'), host, styleHash: info.inlineStyleSha256 });
    browser = await browserSession(resolve(work, 'browser'));
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 1000, deviceScaleFactor: 1, mobile: false });
    await browser.send('Page.navigate', { url: server.url });
    await browser.until('window.__hardening?.ready', 'Generated renderer gate did not initialize.');
    const checks = await browser.evaluate('window.__hardening.run()');
    assert.equal(checks.length, 48); assert.equal(browser.errors.length, 0); assert.equal(browser.consoleErrors.length, 0);
    assert.equal(await sourceDigest(root), info.sourceDigest, 'Inputs changed during renderer check.');
    const origin = new URL(server.url).origin;
    assert.equal(browser.requests.filter(r => !['GET','HEAD','OPTIONS'].includes(r.method) || new URL(r.url).origin !== origin).length, 0);
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ generatedAt: new Date().toISOString(), sourceDigest: info.sourceDigest,
        easiJsVersion: info.easiJsVersion, scope: 'Generated numeric WebGL2/Canvas2D display mask, polarity, source-coordinate transforms, source preservation and uniform reset; no original images.', checks }, null, 2) + '\n');
    console.log('PASS: 48 generated renderer scenarios, 1,200 pixel checks, both backends, no uploads/external requests.');
} finally {
    browser?.close(); if (server) await server.close(); await delay(250); await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
