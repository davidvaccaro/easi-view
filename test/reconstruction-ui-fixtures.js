import { createAxialSeries } from './volume-fixtures.js';

/** Generated analytic DICOM-like metadata/samples; no original imaging asset. */
export function reconstructionSeries({ uid = '1.2.3', frameOfReferenceUid = '1.2.9', modality = 'CT', unit = 'HU', window = { center: 150, width: 300, voiFunction: 'LINEAR_EXACT' }, ...options } = {}) {
    const series = createAxialSeries({ frameOfReferenceUid, unit, ...options });
    for (let index = 0; index < series.frames.length; index++) for (const frame of [series.frames[index], series.actual[index]]) {
        frame.seriesUid = uid; frame.sopUid = `${uid}.${100 + index}`; frame.modality = modality; frame.window = window ? { ...window } : null;
    }
    return series;
}

export function reconstructionDom() {
    const document = { activeElement: null, defaultView: { ImageData: class { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } } } };
    class Element {
        constructor(tag) { this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.children = []; this.parentNode = null; this.attributes = {}; this.listeners = {}; this.style = {}; this.hidden = false; this.disabled = false; this.value = ''; this.checked = false; this._width = 0; this._height = 0; }
        append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
        replaceChildren(...children) { this.children.forEach(child => child.parentNode = null); this.children = []; this.append(...children); }
        remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; } }
        setAttribute(key, value) { this.attributes[key] = value; }
        addEventListener(key, callback) { (this.listeners[key] ??= []).push(callback); }
        getRootNode() { return document; }
        focus() { document.activeElement = this; }
        querySelectorAll(selector) { const tags = selector.split(',').map(tag => tag.toUpperCase()); return this.children.flatMap(child => [...(tags.includes(child.tagName) ? [child] : []), ...child.querySelectorAll(selector)]); }
        closest() { let node = this.parentNode; while (node) { if (node.tagName === 'DETAILS' && !node.attributes.open) return node; node = node.parentNode; } return null; }
        getBoundingClientRect() { return { left: 0, top: 0, width: this.width || 1, height: this.height || 1 }; }
        set width(value) { this._width = value; this.backingPeak = Math.max(this.backingPeak ?? 0, this._width * this._height * 4); if (this.context) this.context.image = null; } get width() { return this._width; }
        set height(value) { this._height = value; this.backingPeak = Math.max(this.backingPeak ?? 0, this._width * this._height * 4); if (this.context) this.context.image = null; } get height() { return this._height; }
        getContext() { return this.context ??= { image: null, rejectNext: false, createImageData: (columns, rows) => ({ data: new Uint8ClampedArray(rows * columns * 4) }),
            putImageData(data) { if (this.rejectNext) { this.rejectNext = false; throw new Error('Synthetic canvas rejection.'); } this.image = new Uint8ClampedArray(data.data); } }; }
    }
    document.createElement = tag => new Element(tag);
    const root = new Element('main'); return { root, document, canvases: () => root.querySelectorAll('canvas'), controls: () => root.querySelectorAll('input,select,textarea') };
}
