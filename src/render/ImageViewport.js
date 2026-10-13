import { normalizeWindow, paddingRange, renderScalarToRgba, validateFrame } from './DisplayMath.js';
import { createImageTransform, inverseTransformPoint, transformPoint } from './ViewportTransform.js';

export { renderScalarToRgba, measureDistance, probe } from './DisplayMath.js';

const VERTEX_SHADER = `#version 300 es
in vec2 position;
uniform mat3 imageToClip;
uniform vec2 dimensions;
out vec2 textureCoordinate;
void main() {
    vec2 imagePosition = position * dimensions;
    vec3 clip = imageToClip * vec3(imagePosition, 1.0);
    gl_Position = vec4(clip.xy, 0.0, 1.0);
    textureCoordinate = position;
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform highp sampler2D samples;
uniform vec2 rescale;
uniform vec2 window;
uniform bool linearExact;
uniform bool inverted;
uniform bool hasPadding;
uniform vec2 padding;
in vec2 textureCoordinate;
out vec4 color;
void main() {
    float stored = texture(samples, textureCoordinate).r;
    if (hasPadding && stored >= padding.x && stored <= padding.y) {
        color = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }
    float value = stored * rescale.x + rescale.y;
    float level;
    if (linearExact) level = clamp((value - window.x) / window.y + 0.5, 0.0, 1.0);
    else if (window.y <= 1.0) level = value <= window.x - 0.5 ? 0.0 : 1.0;
    else level = clamp((value - (window.x - 0.5)) / (window.y - 1.0) + 0.5, 0.0, 1.0);
    if (inverted) level = 1.0 - level;
    color = vec4(level, level, level, 1.0);
}`;

const DEFAULT_TRANSFORM = Object.freeze({ zoom: 1, panX: 0, panY: 0, rotation: 0, flipX: false, flipY: false, invert: false });

function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`EASI View shader compilation failed: ${message}`);
    }
    return shader;
}

/** Independent scalar renderer. Raw samples upload once; interaction changes GPU uniforms. */
export class ImageViewport {
    constructor(canvas) {
        if (!canvas || typeof canvas.getContext !== 'function') throw new TypeError('An image viewport requires a canvas.');
        this.canvas = canvas;
        this.frame = null;
        this._state = { center: 0, width: 1, ...DEFAULT_TRANSFORM };
        this._width = 1;
        this._height = 1;
        this._dpr = 1;
        this._disposed = false;
        this._contextLost = false;
        this._sourceDirty = true;
        this._sourceCanvas = null;
        this._gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false });
        this._context = this._gl ? null : canvas.getContext('2d', { alpha: false });
        if (!this._gl && !this._context) throw new Error('This browser cannot create a WebGL2 or Canvas2D image viewport.');
        this._onContextLost = event => {
            event.preventDefault();
            this._contextLost = true;
            this._texture = null;
            this._notify('The graphics context was lost. Waiting for browser recovery.');
        };
        this._onContextRestored = () => {
            if (this._disposed) return;
            this._contextLost = false;
            try {
                this._initializeGpu();
                if (this.frame) this._uploadFrame();
                this.render();
                this._notify('The graphics context was restored.');
            } catch (error) {
                this._contextLost = true;
                this._notify(error.message);
            }
        };
        canvas.addEventListener('webglcontextlost', this._onContextLost);
        canvas.addEventListener('webglcontextrestored', this._onContextRestored);
        if (this._gl) this._initializeGpu();
        this.resize();
    }

    get state() { return { ...this._state }; }
    get backend() { return this._gl ? 'WebGL2 · raw scalar texture' : 'Canvas2D · CPU reference'; }
    get center() { return this._state.center; }
    get width() { return this._state.width; }
    get zoom() { return this._state.zoom; }
    get panX() { return this._state.panX; }
    get panY() { return this._state.panY; }
    get rotation() { return this._state.rotation; }
    get flipX() { return this._state.flipX; }
    get flipY() { return this._state.flipY; }
    get invert() { return this._state.invert; }

    _notify(message) {
        const EventClass = this.canvas.ownerDocument?.defaultView?.CustomEvent ?? globalThis.CustomEvent;
        if (EventClass) this.canvas.dispatchEvent(new EventClass('viewportstatus', { detail: { message, contextLost: this._contextLost } }));
    }

    _assertActive() {
        if (this._disposed) throw new Error('This image viewport has been disposed.');
    }

    _initializeGpu() {
        const gl = this._gl;
        const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
        let fragment;
        let program;
        try {
            fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
            program = gl.createProgram();
            gl.attachShader(program, vertex);
            gl.attachShader(program, fragment);
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`EASI View shader linking failed: ${gl.getProgramInfoLog(program)}`);
        } catch (error) {
            if (program) gl.deleteProgram(program);
            throw error;
        } finally {
            gl.deleteShader(vertex);
            if (fragment) gl.deleteShader(fragment);
        }
        this._program = program;
        this._vao = gl.createVertexArray();
        this._buffer = gl.createBuffer();
        gl.bindVertexArray(this._vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
        const location = gl.getAttribLocation(program, 'position');
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
        this._uniforms = Object.fromEntries(['imageToClip', 'dimensions', 'samples', 'rescale', 'window', 'linearExact', 'inverted', 'hasPadding', 'padding']
            .map(name => [name, gl.getUniformLocation(program, name)]));
        this._texture = null;
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.BLEND);
        gl.disable(gl.DITHER);
        gl.clearColor(0, 0, 0, 1);
    }

    _uploadFrame() {
        const gl = this._gl;
        const frame = this.frame;
        if (!gl || this._contextLost || !frame) return;
        const maximum = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        if (frame.columns > maximum || frame.rows > maximum) throw new RangeError(`Frame dimensions exceed this GPU's ${maximum}-pixel texture limit.`);
        if (this._texture) gl.deleteTexture(this._texture);
        this._texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this._texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        // Every signed/unsigned 16-bit integer is exactly representable as float32.
        // This temporary upload copy is not retained by the viewport.
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, frame.columns, frame.rows, 0, gl.RED, gl.FLOAT, Float32Array.from(frame.samples));
        const error = gl.getError();
        if (error !== gl.NO_ERROR) {
            gl.deleteTexture(this._texture);
            this._texture = null;
            throw new Error(`The GPU could not upload this scalar frame (WebGL error ${error}).`);
        }
    }

    setFrame(frame) {
        this._assertActive();
        validateFrame(frame);
        this.frame = frame;
        this._sourceDirty = true;
        try {
            this._uploadFrame();
        } catch (error) {
            if (this._texture && this._gl && !this._contextLost) this._gl.deleteTexture(this._texture);
            this._texture = null;
            this.frame = null;
            this.render();
            throw error;
        }
        this.reset();
    }

    clearFrame() {
        this._assertActive();
        if (this._texture && this._gl && !this._contextLost) this._gl.deleteTexture(this._texture);
        this._texture = null;
        this.frame = null;
        if (this._sourceCanvas) {
            this._sourceCanvas.width = 0;
            this._sourceCanvas.height = 0;
        }
        this._sourceCanvas = null;
        this._sourceDirty = true;
        this._state = { center: 0, width: 1, ...DEFAULT_TRANSFORM };
        this.render();
    }

    setWindow(center, width) {
        this._assertActive();
        Object.assign(this._state, normalizeWindow(center, width, this.frame?.voiFunction));
        this._sourceDirty = true;
        this.render();
    }

    setTransform(changes) {
        this._assertActive();
        for (const key of ['zoom', 'panX', 'panY', 'rotation']) {
            if (changes[key] !== undefined && !Number.isFinite(changes[key])) throw new TypeError(`${key} must be finite.`);
        }
        if (changes.zoom !== undefined && changes.zoom <= 0) throw new RangeError('Zoom must be positive.');
        for (const key of ['zoom', 'panX', 'panY', 'rotation']) {
            if (changes[key] !== undefined) this._state[key] = changes[key];
        }
        for (const key of ['flipX', 'flipY', 'invert']) {
            if (changes[key] !== undefined) this._state[key] = Boolean(changes[key]);
        }
        if (changes.invert !== undefined) this._sourceDirty = true;
        this.render();
    }

    reset() {
        this._assertActive();
        let center = this.frame?.window?.center;
        let width = this.frame?.window?.width;
        if (!Number.isFinite(center) || !Number.isFinite(width)) {
            const min = this.frame?.range?.min ?? 0;
            const max = this.frame?.range?.max ?? 1;
            center = (min + max + (this.frame?.voiFunction === 'LINEAR_EXACT' ? 0 : 1)) / 2;
            width = Math.max(1, max - min + (this.frame?.voiFunction === 'LINEAR_EXACT' ? 0 : 1));
        }
        this._state = { ...normalizeWindow(center, width, this.frame?.voiFunction), ...DEFAULT_TRANSFORM };
        this._sourceDirty = true;
        this.render();
    }

    resize() {
        this._assertActive();
        const rectangle = this.canvas.getBoundingClientRect();
        this._width = Math.max(1, rectangle.width);
        this._height = Math.max(1, rectangle.height);
        this._dpr = Math.max(1, this.canvas.ownerDocument?.defaultView?.devicePixelRatio ?? globalThis.devicePixelRatio ?? 1);
        const width = Math.max(1, Math.round(this._width * this._dpr));
        const height = Math.max(1, Math.round(this._height * this._dpr));
        if (this.canvas.width !== width) this.canvas.width = width;
        if (this.canvas.height !== height) this.canvas.height = height;
        this.render();
    }

    _matrix() {
        return this.frame ? createImageTransform(this.frame, this._state, this._width, this._height) : null;
    }

    imageToScreen(x, y) {
        const matrix = this._matrix();
        return matrix ? transformPoint(matrix, x, y) : null;
    }

    screenToImage(clientX, clientY) {
        const matrix = this._matrix();
        if (!matrix) return null;
        const rectangle = this.canvas.getBoundingClientRect();
        return inverseTransformPoint(matrix, clientX - rectangle.left, clientY - rectangle.top);
    }

    render() {
        if (this._disposed || this._contextLost) return;
        if (this._gl) this._renderGpu();
        else this._renderCpu();
    }

    _renderGpu() {
        const gl = this._gl;
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (!this.frame || !this._texture) return;
        const matrix = this._matrix();
        const uniforms = this._uniforms;
        gl.useProgram(this._program);
        gl.bindVertexArray(this._vao);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this._texture);
        gl.uniform1i(uniforms.samples, 0);
        gl.uniformMatrix3fv(uniforms.imageToClip, false, new Float32Array([
            matrix.a * 2 / this._width, matrix.b * -2 / this._height, 0,
            matrix.c * 2 / this._width, matrix.d * -2 / this._height, 0,
            matrix.e * 2 / this._width - 1, 1 - matrix.f * 2 / this._height, 1
        ]));
        gl.uniform2f(uniforms.dimensions, this.frame.columns, this.frame.rows);
        gl.uniform2f(uniforms.rescale, this.frame.slope ?? 1, this.frame.intercept ?? 0);
        gl.uniform2f(uniforms.window, this._state.center, this._state.width);
        gl.uniform1i(uniforms.linearExact, this.frame.voiFunction === 'LINEAR_EXACT' ? 1 : 0);
        gl.uniform1i(uniforms.inverted, (this.frame.photometric === 'MONOCHROME1') !== this._state.invert ? 1 : 0);
        const padding = paddingRange(this.frame);
        gl.uniform1i(uniforms.hasPadding, padding ? 1 : 0);
        gl.uniform2f(uniforms.padding, padding?.min ?? 0, padding?.max ?? 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.bindVertexArray(null);
    }

    _renderCpu() {
        const context = this._context;
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.fillStyle = '#000';
        context.fillRect(0, 0, this.canvas.width, this.canvas.height);
        if (!this.frame) return;
        if (!this._sourceCanvas) {
            this._sourceCanvas = typeof OffscreenCanvas === 'function'
                ? new OffscreenCanvas(this.frame.columns, this.frame.rows)
                : this.canvas.ownerDocument.createElement('canvas');
        }
        if (this._sourceDirty) {
            this._sourceCanvas.width = this.frame.columns;
            this._sourceCanvas.height = this.frame.rows;
            const source = this._sourceCanvas.getContext('2d');
            const pixels = source.createImageData(this.frame.columns, this.frame.rows);
            pixels.data.set(renderScalarToRgba(this.frame, this._state));
            source.putImageData(pixels, 0, 0);
            this._sourceDirty = false;
        }
        const matrix = this._matrix();
        context.setTransform(matrix.a * this._dpr, matrix.b * this._dpr, matrix.c * this._dpr,
            matrix.d * this._dpr, matrix.e * this._dpr, matrix.f * this._dpr);
        context.imageSmoothingEnabled = false;
        context.drawImage(this._sourceCanvas, 0, 0);
        context.setTransform(1, 0, 0, 1, 0, 0);
    }

    dispose() {
        if (this._disposed) return;
        this.canvas.removeEventListener('webglcontextlost', this._onContextLost);
        this.canvas.removeEventListener('webglcontextrestored', this._onContextRestored);
        if (this._gl && !this._contextLost) {
            if (this._texture) this._gl.deleteTexture(this._texture);
            this._gl.deleteBuffer(this._buffer);
            this._gl.deleteVertexArray(this._vao);
            this._gl.deleteProgram(this._program);
            this._gl.clear(this._gl.COLOR_BUFFER_BIT);
        }
        if (this._sourceCanvas) {
            this._sourceCanvas.width = 0;
            this._sourceCanvas.height = 0;
        }
        if (this._context) {
            this._context.setTransform(1, 0, 0, 1, 0, 0);
            this._context.fillStyle = '#000';
            this._context.fillRect(0, 0, this.canvas.width, this.canvas.height);
        }
        this.frame = null;
        this._texture = null;
        this._sourceCanvas = null;
        this._disposed = true;
    }
}

export default ImageViewport;
