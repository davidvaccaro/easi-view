import test from 'node:test';
import assert from 'node:assert/strict';
import { ImageViewport, measureDistance, probe, renderScalarToRgba } from '../src/render/ImageViewport.js';
import { normalizeWindow, validateFrame, windowValue } from '../src/render/DisplayMath.js';
import { createImageTransform, inverseTransformPoint, transformPoint } from '../src/render/ViewportTransform.js';

function makeFrame(overrides = {}) {
    return {
        id: 'synthetic-render-test', rows: 1, columns: 5,
        samples: new Int16Array([-2, -1, 0, 1, 2]),
        slope: 1, intercept: 0, photometric: 'MONOCHROME2',
        pixelSpacing: [1, 1], window: { center: 0.5, width: 3 },
        range: { min: -2, max: 2 }, unit: '', voiFunction: 'LINEAR',
        ...overrides
    };
}

function grays(frame, state) {
    return [...renderScalarToRgba(frame, state)].filter((_, index) => index % 4 === 0);
}

test('DICOM LINEAR uses center-minus-half and width-minus-one, including exact endpoints', () => {
    assert.deepEqual(grays(makeFrame()), [0, 0, 128, 255, 255]);
    assert.equal(windowValue(-1, 0.5, 3), 0);
    assert.equal(windowValue(1, 0.5, 3), 1);
});

test('width one is a threshold rather than division by zero', () => {
    const frame = makeFrame({ samples: new Int16Array([-2, -1, 0, 1, 2]), window: { center: 0, width: 1 } });
    assert.deepEqual(grays(frame), [0, 0, 255, 255, 255]);
    assert.equal(windowValue(1.5, 2, 1), 0);
    assert.equal(windowValue(1.500001, 2, 1), 1);
});

test('LINEAR_EXACT uses the supplied center and width without half-unit adjustment', () => {
    assert.deepEqual(grays(makeFrame({ voiFunction: 'LINEAR_EXACT', window: { center: 0, width: 4 } })), [0, 64, 128, 191, 255]);
    assert.equal(windowValue(0, 0, 1, 'LINEAR_EXACT'), 0.5);
});

test('stored signed and unsigned values survive rescale exactly once', () => {
    const signed = makeFrame({ samples: new Int16Array([-2000, -1000, 0, 1000, 2000]), slope: 0.5, intercept: -1000,
        window: { center: -1000, width: 2000 }, unit: 'HU', voiFunction: 'LINEAR_EXACT' });
    assert.deepEqual(grays(signed), [0, 64, 128, 191, 255]);
    assert.deepEqual(probe(signed, 2.5, 0.5), { x: 2, y: 0, stored: 0, rescaled: -1000, unit: 'HU', padding: false });
    const unsigned = makeFrame({ samples: new Uint16Array([0, 100, 32768, 65534, 65535]), window: { center: 32767.5, width: 65535 }, voiFunction: 'LINEAR_EXACT' });
    assert.deepEqual(grays(unsigned), [0, 0, 128, 255, 255]);
    assert.equal(probe(unsigned, 4.5, 0.5).stored, 65535);
});

test('MONOCHROME1 and user inversion compose; stored padding remains black', () => {
    const normal = makeFrame();
    const inverse = makeFrame({ photometric: 'MONOCHROME1' });
    assert.deepEqual(grays(inverse), [255, 255, 128, 0, 0]);
    assert.deepEqual(grays(inverse, { ...inverse.window, invert: true }), grays(normal));
    assert.deepEqual(grays(makeFrame({ photometric: 'MONOCHROME1', padding: { value: -2, limit: -1 } })), [0, 0, 128, 0, 0]);
    assert.equal(probe(makeFrame({ padding: { value: -1, limit: -2 } }), 0.5, 0.5).padding, true);
});

test('CPU display outputs opaque RGBA without changing stored samples', () => {
    const frame = makeFrame();
    const original = [...frame.samples];
    const rgba = renderScalarToRgba(frame);
    assert.equal(rgba.length, 20);
    for (let index = 0; index < 5; index++) {
        assert.equal(rgba[index * 4], rgba[index * 4 + 1]);
        assert.equal(rgba[index * 4], rgba[index * 4 + 2]);
        assert.equal(rgba[index * 4 + 3], 255);
    }
    assert.deepEqual([...frame.samples], original);
});

test('probe maps continuous pixel-center coordinates and rejects edges outside the image', () => {
    const frame = makeFrame();
    assert.equal(probe(frame, 0.5, 0.5).stored, -2);
    assert.equal(probe(frame, 4.999, 0.999).stored, 2);
    for (const [x, y] of [[-0.001, 0.5], [5, 0.5], [0.5, -0.001], [0.5, 1], [NaN, 0.5]]) {
        assert.equal(probe(frame, x, y), null);
    }
});

test('measurements use row/column spacing correctly and label uncalibrated distances', () => {
    const points = [{ x: 0.5, y: 0.5 }, { x: 3.5, y: 4.5 }];
    assert.deepEqual(measureDistance(points, [2, 3]), { value: Math.hypot(9, 8), unit: 'mm', calibrated: true });
    for (const spacing of [null, [0, 1], [NaN, 1], [-1, 1], [1]]) {
        assert.deepEqual(measureDistance(points, spacing), { value: 5, unit: 'px', calibrated: false });
    }
    assert.throws(() => measureDistance([{ x: 0, y: 0 }], [1, 1]), /two image-coordinate/);
});

test('fit respects non-square pixels rather than stretching into a square viewport', () => {
    const frame = makeFrame({ columns: 100, rows: 100, pixelSpacing: [2, 1] });
    const state = { zoom: 1, panX: 0, panY: 0, rotation: 0, flipX: false, flipY: false };
    const matrix = createImageTransform(frame, state, 200, 200);
    assert.deepEqual(transformPoint(matrix, 0, 0), { x: 50, y: 0 });
    assert.deepEqual(transformPoint(matrix, 100, 100), { x: 150, y: 200 });
    assert.deepEqual(transformPoint(matrix, 50, 50), { x: 100, y: 100 });
});

test('image/screen transform round trips across rotation, flips, pan, and zoom', () => {
    const frame = makeFrame({ columns: 512, rows: 300, pixelSpacing: [0.5, 0.75] });
    for (const rotation of [0, 90, 180, 270, 33]) {
        for (const flipX of [false, true]) {
            for (const flipY of [false, true]) {
                const matrix = createImageTransform(frame, { zoom: 2.3, panX: 27, panY: -11, rotation, flipX, flipY }, 700, 420);
                for (const [x, y] of [[0, 0], [0.5, 0.5], [256.5, 149.5], [512, 300]]) {
                    const screen = transformPoint(matrix, x, y);
                    const roundTrip = inverseTransformPoint(matrix, screen.x, screen.y);
                    assert.ok(Math.abs(roundTrip.x - x) < 1e-9);
                    assert.ok(Math.abs(roundTrip.y - y) < 1e-9);
                }
            }
        }
    }
});

test('frames with mismatched samples, color data, or unsupported VOI fail explicitly', () => {
    assert.throws(() => validateFrame(makeFrame({ samples: new Uint16Array(4) })), /number of stored samples/);
    assert.throws(() => validateFrame(makeFrame({ photometric: 'RGB' })), /MONOCHROME/);
    assert.throws(() => validateFrame(makeFrame({ voiFunction: 'SIGMOID' })), /Unsupported VOI/);
    assert.throws(() => validateFrame(makeFrame({ slope: Infinity })), /finite/);
    assert.throws(() => normalizeWindow(NaN, 10), /finite/);
    assert.throws(() => normalizeWindow(1, Infinity), /finite/);
});

function gpuCanvas() {
    const events = new Map();
    const calls = [];
    let identity = 0;
    const constants = ['VERTEX_SHADER', 'FRAGMENT_SHADER', 'COMPILE_STATUS', 'LINK_STATUS', 'ARRAY_BUFFER', 'STATIC_DRAW', 'FLOAT',
        'DEPTH_TEST', 'BLEND', 'DITHER', 'MAX_TEXTURE_SIZE', 'TEXTURE_2D', 'TEXTURE_MIN_FILTER', 'TEXTURE_MAG_FILTER', 'NEAREST',
        'TEXTURE_WRAP_S', 'TEXTURE_WRAP_T', 'CLAMP_TO_EDGE', 'UNPACK_ALIGNMENT', 'R32F', 'RED', 'COLOR_BUFFER_BIT', 'TEXTURE0', 'TRIANGLES'];
    const gl = Object.fromEntries(constants.map((key, index) => [key, index + 1]));
    gl.NO_ERROR = 0;
    for (const method of ['createShader', 'createProgram', 'createVertexArray', 'createBuffer', 'createTexture']) {
        gl[method] = () => ({ kind: method, id: ++identity });
    }
    for (const method of ['shaderSource', 'compileShader', 'deleteShader', 'attachShader', 'linkProgram', 'deleteProgram', 'bindVertexArray',
        'bindBuffer', 'bufferData', 'enableVertexAttribArray', 'vertexAttribPointer', 'disable', 'clearColor', 'bindTexture', 'texParameteri',
        'pixelStorei', 'texImage2D', 'deleteTexture', 'viewport', 'clear', 'useProgram', 'activeTexture', 'uniform1i', 'uniformMatrix3fv',
        'uniform2f', 'drawArrays', 'deleteBuffer', 'deleteVertexArray']) {
        gl[method] = (...args) => calls.push({ method, args });
    }
    gl.getShaderParameter = () => true;
    gl.getProgramParameter = () => true;
    gl.getAttribLocation = () => 0;
    gl.getUniformLocation = (_, name) => name;
    gl.getParameter = () => 4096;
    gl.getError = () => 0;
    const canvas = {
        width: 1, height: 1,
        getContext: type => type === 'webgl2' ? gl : null,
        getBoundingClientRect: () => ({ left: 30, top: 20, width: 200, height: 100 }),
        ownerDocument: { defaultView: { devicePixelRatio: 2 } },
        dispatchEvent: event => calls.push({ method: 'dispatchEvent', args: [event] }),
        addEventListener: (name, handler) => events.set(name, handler),
        removeEventListener: name => events.delete(name)
    };
    return { canvas, gl, calls, events };
}

test('GPU preserves raw values, uploads once per frame, reuses texture during interaction, and disposes resources', () => {
    const { canvas, calls, events } = gpuCanvas();
    const viewport = new ImageViewport(canvas);
    const frame = makeFrame({ samples: new Uint16Array([0, 1, 32768, 65534, 65535]) });
    viewport.setFrame(frame);
    const uploads = () => calls.filter(call => call.method === 'texImage2D');
    assert.equal(uploads().length, 1);
    assert.deepEqual([...uploads()[0].args[8]], [...frame.samples]);
    assert.equal(canvas.width, 400);
    assert.equal(canvas.height, 200);
    viewport.setWindow(2000, 4000);
    viewport.setTransform({ zoom: 2, panX: 13, panY: 21, rotation: 90, flipX: true, invert: true });
    viewport.resize();
    assert.equal(uploads().length, 1);
    assert.equal(viewport.state.rotation, 90);
    const screen = viewport.imageToScreen(2.5, 0.5);
    const image = viewport.screenToImage(screen.x + 30, screen.y + 20);
    assert.ok(Math.abs(image.x - 2.5) < 1e-9);
    assert.ok(Math.abs(image.y - 0.5) < 1e-9);
    viewport.setFrame(makeFrame());
    assert.equal(uploads().length, 2);
    assert.equal(calls.filter(call => call.method === 'deleteTexture').length, 1);
    viewport.dispose();
    assert.equal(calls.filter(call => call.method === 'deleteTexture').length, 2);
    assert.equal(calls.filter(call => call.method === 'deleteBuffer').length, 1);
    assert.equal(calls.filter(call => call.method === 'deleteVertexArray').length, 1);
    assert.equal(calls.filter(call => call.method === 'deleteProgram').length, 1);
    assert.equal(events.size, 0);
    assert.equal(viewport.frame, null);
    assert.throws(() => viewport.setWindow(1, 1), /disposed/);
    viewport.dispose();
});

test('invalid transform input cannot poison the viewport state', () => {
    const { canvas } = gpuCanvas();
    const viewport = new ImageViewport(canvas);
    viewport.setFrame(makeFrame());
    const before = viewport.state;
    assert.throws(() => viewport.setTransform({ zoom: 0 }), /positive/);
    assert.throws(() => viewport.setTransform({ panX: NaN }), /finite/);
    assert.deepEqual(viewport.state, before);
    viewport.dispose();
});

test('context loss suspends drawing and restoration recreates and reuploads the visible frame', () => {
    const { canvas, calls, events } = gpuCanvas();
    const viewport = new ImageViewport(canvas);
    viewport.setFrame(makeFrame());
    let prevented = false;
    events.get('webglcontextlost')({ preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    const before = calls.filter(call => call.method === 'drawArrays').length;
    viewport.setWindow(1, 20);
    assert.equal(calls.filter(call => call.method === 'drawArrays').length, before);
    events.get('webglcontextrestored')();
    assert.equal(calls.filter(call => call.method === 'texImage2D').length, 2);
    assert.equal(viewport.state.center, 1);
    assert.equal(viewport.state.width, 20);
    viewport.dispose();
});

test('a failed GPU upload clears the previous texture and never displays old samples as a new frame', () => {
    const { canvas, gl, calls } = gpuCanvas();
    const viewport = new ImageViewport(canvas);
    viewport.setFrame(makeFrame());
    gl.getParameter = () => 2;
    assert.throws(() => viewport.setFrame(makeFrame()), /texture limit/);
    assert.equal(viewport.frame, null);
    assert.equal(calls.filter(call => call.method === 'deleteTexture').length, 1);
    viewport.dispose();
});

test('clearing a failed source releases its texture and keeps the viewport reusable', () => {
    const { canvas, calls } = gpuCanvas();
    const viewport = new ImageViewport(canvas);
    viewport.setFrame(makeFrame());
    const drawnBeforeClear = calls.filter(call => call.method === 'drawArrays').length;
    viewport.clearFrame();
    assert.equal(viewport.frame, null);
    assert.equal(viewport.screenToImage(100, 50), null);
    assert.equal(calls.filter(call => call.method === 'deleteTexture').length, 1);
    assert.equal(calls.filter(call => call.method === 'drawArrays').length, drawnBeforeClear);
    assert.equal(calls.filter(call => call.method === 'deleteProgram').length, 0);
    viewport.setFrame(makeFrame());
    assert.equal(calls.filter(call => call.method === 'texImage2D').length, 2);
    viewport.dispose();
});

function cpuCanvas() {
    const calls = [];
    const context = {
        setTransform: (...args) => calls.push({ method: 'setTransform', args }),
        fillRect: (...args) => calls.push({ method: 'fillRect', args }),
        drawImage: (...args) => calls.push({ method: 'drawImage', args })
    };
    const sourceContext = {
        createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
        putImageData: (...args) => calls.push({ method: 'putImageData', args })
    };
    const source = { getContext: () => sourceContext, width: 0, height: 0 };
    const canvas = {
        width: 1, height: 1,
        getContext: type => type === '2d' ? context : null,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 500, height: 100 }),
        ownerDocument: { defaultView: { devicePixelRatio: 1 }, createElement: () => source },
        addEventListener: () => {}, removeEventListener: () => {}
    };
    return { canvas, calls, source, context };
}

test('Canvas2D fallback matches the reference pixels and reuses them during navigation', () => {
    const { canvas, calls, source, context } = cpuCanvas();
    const viewport = new ImageViewport(canvas);
    const frame = makeFrame();
    viewport.setFrame(frame);
    assert.match(viewport.backend, /Canvas2D/);
    const materialized = () => calls.filter(call => call.method === 'putImageData');
    assert.equal(materialized().length, 1);
    assert.deepEqual(materialized()[0].args[0].data, renderScalarToRgba(frame));
    viewport.setTransform({ zoom: 1.5, rotation: 90, panX: 10 });
    viewport.resize();
    assert.equal(materialized().length, 1);
    assert.equal(context.imageSmoothingEnabled, false);
    viewport.setWindow(0, 1);
    assert.equal(materialized().length, 2);
    assert.deepEqual(materialized()[1].args[0].data, renderScalarToRgba(frame, viewport.state));
    viewport.dispose();
    assert.equal(source.width, 0);
    assert.equal(source.height, 0);
    assert.equal(viewport.frame, null);
    assert.equal(calls.at(-1).method, 'fillRect');
});

test('auto-window uses DICOM half-unit adjustment and preserves inclusive stored endpoints', () => {
    const { canvas } = gpuCanvas();
    const viewport = new ImageViewport(canvas);
    const frame = makeFrame({ window: null, range: { min: 0, max: 4 }, samples: new Int16Array([0, 1, 2, 3, 4]) });
    viewport.setFrame(frame);
    assert.equal(viewport.center, 2.5);
    assert.equal(viewport.width, 5);
    assert.deepEqual(grays(frame, viewport.state), [0, 64, 128, 191, 255]);
    viewport.dispose();
});
