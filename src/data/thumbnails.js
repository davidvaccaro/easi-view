import { renderScalarToRgba, renderColorToRgba, isColorFrame } from '../render/DisplayMath.js';
import { validateCircularShutter, circularShutterOccludes } from './display-shutter.js';

/** A small display preview, kept separate from original samples and measurements. */
export function createThumbnail(frame, { maximumSize = 96 } = {}) {
    if (!Number.isInteger(maximumSize) || maximumSize < 16 || maximumSize > 256 ||
        !Number.isInteger(frame?.rows) || !Number.isInteger(frame.columns) || frame.rows < 1 || frame.columns < 1 ||
        !ArrayBuffer.isView(frame.samples)) throw new TypeError('Use a decoded image and a thumbnail size from 16 to 256.');
    const scale = Math.min(1, maximumSize / Math.max(frame.rows, frame.columns));
    const rows = Math.max(1, Math.round(frame.rows * scale));
    const columns = Math.max(1, Math.round(frame.columns * scale));
    const components = frame.photometric === 'RGB' ? 3 : 1;
    if (frame.samples.length !== frame.rows * frame.columns * components) throw new TypeError('Thumbnail samples do not match their image dimensions.');
    const shutter = validateCircularShutter(frame);
    const occluded = shutter ? new Uint8Array(rows * columns) : null;
    const samples = new frame.samples.constructor(rows * columns * components);
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
        const sourceY = Math.min(frame.rows - 1, Math.floor((y + 0.5) * frame.rows / rows));
        const sourceX = Math.min(frame.columns - 1, Math.floor((x + 0.5) * frame.columns / columns));
        const input = (sourceY * frame.columns + sourceX) * components;
        const output = (y * columns + x) * components;
        for (let component = 0; component < components; component++) samples[output + component] = frame.samples[input + component];
        if (occluded) occluded[y * columns + x] = circularShutterOccludes(shutter, sourceY + 1, sourceX + 1);
    }
    // The shutter belongs to original one-based raster coordinates. Resizing its
    // center/radius would change boundary decisions on a center-sampled preview.
    const miniature = { ...frame, rows, columns, samples, displayShutter: null };
    const rgba = isColorFrame(miniature) ? renderColorToRgba(miniature) : renderScalarToRgba(miniature, frame.window);
    if (occluded) {
        const gray = Math.round(shutter.presentationValue * 255 / 65535);
        for (let index = 0; index < occluded.length; index++) if (occluded[index]) {
            rgba[index * 4] = gray; rgba[index * 4 + 1] = gray; rgba[index * 4 + 2] = gray;
        }
    }
    return { rows, columns, rgba, derived: true };
}

/** Small byte-budgeted thumbnail storage; no Blob URL or original image retention. */
export class ThumbnailCache {
    constructor(budget = 4 * 1024 * 1024) {
        if (!Number.isSafeInteger(budget) || budget <= 0) throw new TypeError('Use a positive thumbnail byte budget.');
        this.budget = budget; this.bytes = 0; this.entries = new Map();
    }
    get(key) {
        const value = this.entries.get(key);
        if (!value) return null;
        this.entries.delete(key); this.entries.set(key, value); return value;
    }
    set(key, thumbnail) {
        if (!(thumbnail?.rgba instanceof Uint8ClampedArray) || thumbnail.rgba.length !== thumbnail.rows * thumbnail.columns * 4) throw new TypeError('Use a bounded RGBA thumbnail.');
        this.delete(key);
        if (thumbnail.rgba.byteLength > this.budget) return thumbnail;
        while (this.bytes + thumbnail.rgba.byteLength > this.budget) this.delete(this.entries.keys().next().value);
        this.entries.set(key, thumbnail); this.bytes += thumbnail.rgba.byteLength; return thumbnail;
    }
    delete(key) {
        const value = this.entries.get(key); if (!value) return;
        this.bytes -= value.rgba.byteLength; this.entries.delete(key);
    }
    clear() { this.entries.clear(); this.bytes = 0; }
}
