import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { browserSession } from './browser-session.mjs';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'artifacts/render-browser');
await mkdir(output, { recursive: true });
await build({ entryPoints: [resolve(root, 'src/render/ImageViewport.js')], outfile: resolve(output, 'renderer.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022' });
const server = createServer(async (request, response) => {
    if (request.url === '/renderer.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile(resolve(output, 'renderer.js'))); }
    else if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>EASI View renderer QA</title><body></body>'); }
    else { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
    browser = await browserSession(output);
    await browser.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    await browser.until("document.readyState === 'complete'", 'Renderer QA page did not load.');
    const result = await browser.evaluate(`(async () => {
        const { ImageViewport, renderScalarToRgba } = await import('/renderer.js');
        const canvas = document.createElement('canvas');
        canvas.style.width = '300px'; canvas.style.height = '200px';
        document.body.append(canvas);
        const viewport = new ImageViewport(canvas);
        const gl = canvas.getContext('webgl2');
        if (!gl) throw new Error('WebGL2 is required for shader verification.');
        const cases = [
            { label:'signed-rescale', samples:new Int16Array([-2048,-1000,-1,0,500,2047]), slope:2, intercept:-1024, window:{center:0,width:4001} },
            { label:'unsigned-high-range', samples:new Uint16Array([0,1,4095,32767,32768,65535]), slope:1, intercept:0, window:{center:32768,width:65536} },
            { label:'threshold', samples:new Int16Array([-2,-1,0,1,2,3]), slope:1, intercept:0, window:{center:0,width:1} },
            { label:'linear-exact-inverted', samples:new Int16Array([-5,-2,0,1,3,5]), slope:1, intercept:0, window:{center:0,width:10}, voiFunction:'LINEAR_EXACT', photometric:'MONOCHROME1' },
            { label:'padding-remains-black', samples:new Int16Array([-1000,-10,0,10,20,1000]), slope:1, intercept:0, window:{center:0,width:101}, photometric:'MONOCHROME1', padding:{value:-1000,limit:-1000} }
        ];
        const checks = [];
        for (const scenario of cases) {
            const frame = { id:scenario.label, rows:2, columns:3, pixelSpacing:[1,1], photometric:'MONOCHROME2', voiFunction:'LINEAR', ...scenario };
            viewport.setFrame(frame);
            const expected = renderScalarToRgba(frame, viewport.state);
            const actual = [];
            for (let index=0;index<6;index++) {
                const point = viewport.imageToScreen(index%3+0.5,Math.floor(index/3)+0.5);
                const pixel = new Uint8Array(4);
                gl.readPixels(Math.floor(point.x), canvas.height-1-Math.floor(point.y),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
                actual.push([...pixel]);
                for (let channel=0;channel<4;channel++) if (Math.abs(pixel[channel]-expected[index*4+channel])>1) {
                    throw new Error(scenario.label+': shader differs from CPU at sample '+index+' channel '+channel+' '+pixel[channel]+' vs '+expected[index*4+channel]);
                }
            }
            checks.push({label:scenario.label,actual});
        }
        const before = viewport.frame.samples.slice();
        const originalUpload = gl.texImage2D.bind(gl);
        let uploads=0;
        gl.texImage2D = (...args) => { uploads++; return originalUpload(...args); };
        for(let index=0;index<15;index++) { viewport.setWindow(index*5,200); viewport.setTransform({zoom:1+index/100,panX:index}); }
        if(uploads!==0) throw new Error('Window and pan must not reupload source samples.');
        if(before.some((value,index)=>value!==viewport.frame.samples[index])) throw new Error('Presentation changed raw samples.');
        gl.texImage2D=originalUpload;
        const backend=viewport.backend;
        viewport.dispose();
        if(viewport.frame!==null) throw new Error('Viewport disposal retained its frame.');
        return {backend,checks,interactionUploads:uploads,disposed:true};
    })()`);
    assert.equal(result.checks.length, 5);
    assert.equal(browser.errors.length, 0);
    await writeFile(resolve(output, 'results.json'), JSON.stringify(result, null, 2) + '\n');
    console.log('Browser renderer passed: 5 scalar shader/reference cases, texture reuse and disposal.');
} finally {
    browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
}
