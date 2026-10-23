import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnnotationStore, createImageReference } from '../src/annotations/index.js';
import { AnnotationController } from '../src/ui/AnnotationController.js';

class Element extends EventTarget {
    constructor(name = 'canvas', document = null) {
        super(); this.name = name; this.ownerDocument = document; this.children = []; this.attributes = {};
        this.parentNode = null; this.textContent = ''; this.captures = new Set(); this.focused = false;
    }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
    replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...nodes); }
    remove() {
        if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        this.parentNode = null;
    }
    getBoundingClientRect() { return { left: 100, top: 200, width: 400, height: 400 }; }
    setPointerCapture(id) { this.captures.add(id); }
    hasPointerCapture(id) { return this.captures.has(id); }
    releasePointerCapture(id) { this.captures.delete(id); fire(this, 'lostpointercapture', { pointerId: id }); }
    focus() { this.focused = true; }
}
const document = { createElementNS: (_, name) => new Element(name, document) };
function fire(element, name, values = {}) {
    const event = new Event(name, { cancelable: true });
    for (const [key, value] of Object.entries(values)) Object.defineProperty(event, key, { value });
    element.dispatchEvent(event); return event;
}
function fixture(options = {}) {
    const canvas = new Element('canvas', document), layer = new Element('svg', document);
    let frame = { rows: 8, columns: 8, sopUid: '1.2.3.4', seriesUid: '1.2.3', frameOfReferenceUid: '1.2.5',
        frameIndex: 2, pixelSpacing: [2, 3], samples: Uint16Array.from({ length: 64 }, (_, index) => index + 1), photometric: 'MONOCHROME2' };
    let tool = 'distance', id = 0;
    const store = new AnnotationStore({ idFactory: () => `annotation-${++id}` });
    const changes = [], errors = [];
    const viewport = {
        screenToImage: (x, y) => ({ x: (x - 100) / 50, y: (y - 200) / 50 }),
        imageToScreen: (x, y) => ({ x: x * 50, y: y * 50 })
    };
    const controller = new AnnotationController({ canvas, layer, viewport, store, getFrame: () => frame, getTool: () => tool,
        onChange: event => { changes.push(event); return options.onChange?.(event); },
        onError: error => { errors.push(error); return options.onError?.(error); } });
    return { canvas, layer, viewport, store, controller, changes, errors,
        get frame() { return frame; }, set frame(value) { frame = value; },
        get tool() { return tool; }, set tool(value) { tool = value; },
        pointer(name, x, y, values = {}) { return fire(canvas, name, { pointerId: 1, button: 0, clientX: 100 + x * 50, clientY: 200 + y * 50, ...values }); },
        click(x, y) { this.pointer('pointerdown', x, y); this.pointer('pointerup', x, y); },
        drag(a, b) { this.pointer('pointerdown', ...a); this.pointer('pointermove', ...b); this.pointer('pointerup', ...b); },
        key(key) { return fire(canvas, 'keydown', { key }); },
        cleanup() { controller.dispose(); store.dispose(); }
    };
}
function descendants(node) { return node.children.flatMap(child => [child, ...descendants(child)]); }
function add(f, tool, points) { return f.store.add({ tool, points: points.map(([x, y]) => ({ x, y })), image: createImageReference(f.frame) }); }

test('explicit list selection stays on the displayed original frame and changes no undo history', () => {
    const f = fixture();
    try {
        const annotation = add(f, 'rectangle', [[1, 1], [3, 4]]);
        const history = f.store.getState().historyCount;
        assert.equal(f.controller.select(annotation.id).id, annotation.id);
        assert.equal(f.store.getState().historyCount, history);
        assert.equal(f.controller.select(null), null);
        f.frame = { ...f.frame, frameIndex: 3 };
        assert.throws(() => f.controller.select(annotation.id), /displayed image/);
        assert.equal(f.controller.getSelected(), null);
        assert.equal(f.store.getState().historyCount, history);
        f.controller.dispose(); assert.throws(() => f.controller.select(null), /disposed/);
    } finally { f.cleanup(); }
});

test('a length drag commits once, with original frame scope and calibrated geometry-only SVG', () => {
    const f = fixture();
    try {
        assert.equal(f.pointer('pointerdown', 1, 1).defaultPrevented, true);
        assert.equal(f.canvas.focused, true);
        assert.equal(f.canvas.hasPointerCapture(1), true);
        for (const x of [1.5, 2, 3]) f.pointer('pointermove', x, 2);
        assert.equal(f.store.getState().count, 0);
        assert.equal(f.store.getState().historyCount, 0);
        f.pointer('pointerup', 3, 2);
        const annotation = f.controller.getSelected();
        assert.equal(annotation.tool, 'length'); assert.equal(annotation.image.frameNumber, 3);
        assert.deepEqual(annotation.points, [{ x: 1, y: 1 }, { x: 3, y: 2 }]);
        assert.equal(f.store.getState().historyCount, 1);
        assert.equal(f.canvas.hasPointerCapture(1), false);
        const nodes = descendants(f.layer);
        assert.equal(nodes.filter(node => node.attributes.class?.includes('measurement-line')).length, 1);
        assert.equal(nodes.find(node => node.attributes.class === 'measurement-label').textContent, '6.32 mm');
        assert.equal(f.changes.at(-1).selectedId, annotation.id);
        assert.equal(f.changes.length, 1); // One host commit notification, after selection is final.
        assert.ok(f.changes.every(change => Object.keys(change).sort().join(',') === 'count,selectedId'));
        assert.equal(f.store.undo(), true); assert.equal(f.controller.getSelected(), null);
        assert.equal(f.store.redo(), true); assert.equal(f.store.getState().count, 1);
    } finally { f.cleanup(); }
});

test('length alias and ROI drags clamp image-edge coordinates, not pixel centers', () => {
    const f = fixture();
    try {
        f.tool = 'length'; f.drag([-2, -1], [12, 9]);
        assert.deepEqual(f.controller.getSelected().points, [{ x: 0, y: 0 }, { x: 8, y: 8 }]);
        f.tool = 'rectangle'; f.drag([1, 2], [4, 5]);
        assert.equal(f.controller.getSelected().tool, 'rectangle');
        assert.equal(descendants(f.layer).filter(node => node.attributes.class?.includes('measurement-line')).length, 2);
        f.tool = 'ellipse'; f.drag([2, 1], [6, 5]);
        assert.equal(f.controller.getSelected().tool, 'ellipse');
        const outline = descendants(f.layer).filter(node => node.attributes.class?.includes('measurement-line')).at(-1);
        assert.equal(outline.attributes.points.split(' ').length, 64);
        assert.equal(f.errors.length, 0);
    } finally { f.cleanup(); }
});

test('degenerate drops report an error and leave prior annotation/history unchanged', () => {
    const f = fixture();
    try {
        f.drag([1, 1], [2, 2]);
        const before = f.store.exportJson(), history = f.store.getState().historyCount;
        f.click(3, 3);
        f.tool = 'rectangle'; f.drag([2, 1], [2, 7]);
        assert.equal(f.store.exportJson(), before);
        assert.equal(f.store.getState().historyCount, history);
        assert.equal(f.errors.length, 2);
    } finally { f.cleanup(); }
});

test('three-click angle commits on the third click with anisotropic angle measurement', () => {
    const f = fixture();
    try {
        f.tool = 'angle'; f.click(1, 2); f.click(1, 1);
        f.pointer('pointermove', 3, 1); assert.equal(f.store.getState().count, 0);
        f.click(3, 1);
        assert.equal(f.controller.getSelected().tool, 'angle');
        assert.equal(f.store.getState().historyCount, 1);
        assert.equal(descendants(f.layer).find(node => node.attributes.class === 'measurement-label').textContent, '90.00°');
    } finally { f.cleanup(); }
});

test('polygon supports Enter, double-click without duplicate vertices, and explicit closure', () => {
    const f = fixture();
    try {
        f.tool = 'polygon'; f.click(1, 1); f.click(4, 1); f.click(3, 4);
        f.pointer('pointermove', 5, 5);
        assert.equal(f.key('Enter').defaultPrevented, true);
        assert.equal(f.controller.getSelected().points.length, 3); // Hover is not a committed vertex.
        f.click(2, 2); f.click(6, 2); f.click(5, 6); f.click(5, 6);
        fire(f.canvas, 'dblclick', { clientX: 350, clientY: 500 });
        assert.equal(f.controller.getSelected().points.length, 3);
        f.click(1, 2); f.click(4, 2); f.click(3, 5); f.click(1, 2);
        assert.equal(f.controller.getSelected().points.length, 3);
        assert.equal(f.store.getState().count, 3); assert.equal(f.store.getState().historyCount, 3);
        assert.equal(f.errors.length, 0);
    } finally { f.cleanup(); }
});

test('self-crossing polygon finish rejects atomically', () => {
    const f = fixture();
    try {
        f.tool = 'polygon'; for (const [x, y] of [[1, 1], [6, 6], [1, 6], [6, 1]]) f.click(x, y);
        f.key('Enter');
        assert.equal(f.store.getState().count, 0); assert.equal(f.store.canUndo, false);
        assert.equal(f.errors.length, 1);
    } finally { f.cleanup(); }
});

test('Escape, pointer cancellation and lost capture discard the entire unfinished gesture', () => {
    const f = fixture();
    try {
        f.pointer('pointerdown', 1, 1); f.pointer('pointermove', 3, 3); f.key('Escape');
        f.pointer('pointerup', 3, 3);
        f.tool = 'polygon'; f.click(1, 1); f.click(4, 1); f.key('Escape');
        f.tool = 'ellipse'; f.pointer('pointerdown', 1, 1); f.pointer('pointermove', 3, 3);
        fire(f.canvas, 'pointercancel', { pointerId: 1 });
        f.pointer('pointerdown', 1, 1); f.pointer('pointermove', 3, 3);
        fire(f.canvas, 'lostpointercapture', { pointerId: 1 });
        assert.equal(f.store.getState().count, 0); assert.equal(f.store.canUndo, false);
        assert.equal(f.canvas.captures.size, 0);
    } finally { f.cleanup(); }
});

test('selection, handle and whole-shape moves commit one edit; invalid moves preserve the model', () => {
    const f = fixture();
    try {
        const annotation = add(f, 'rectangle', [[1, 1], [4, 4]]);
        f.tool = 'select'; f.click(2, 2);
        assert.equal(f.controller.getSelected().id, annotation.id);
        assert.equal(f.store.getState().historyCount, 1); // Selecting never edits.
        f.pointer('pointerdown', 4, 4); f.pointer('pointermove', 5, 5); f.pointer('pointermove', 6, 5);
        assert.deepEqual(f.store.get(annotation.id).points, annotation.points);
        f.pointer('pointerup', 6, 5);
        assert.deepEqual(f.store.get(annotation.id).points, [{ x: 1, y: 1 }, { x: 6, y: 5 }]);
        assert.equal(f.store.getState().historyCount, 2);
        f.drag([3, 3], [4, 4]);
        assert.deepEqual(f.store.get(annotation.id).points, [{ x: 2, y: 2 }, { x: 7, y: 6 }]);
        const before = f.store.exportJson();
        f.drag([4, 4], [8, 8]); // Whole shape would extend beyond the image.
        assert.equal(f.store.exportJson(), before); assert.equal(f.store.getState().historyCount, 3);
        assert.equal(f.errors.length, 1);
        f.drag([2, 2], [7, 6]); // Duplicate opposing corners.
        assert.equal(f.store.exportJson(), before); assert.equal(f.store.getState().historyCount, 3);
        assert.equal(f.errors.length, 2);
        assert.equal(f.controller.deleteSelected(), true); assert.equal(f.store.getState().count, 0);
        assert.equal(f.controller.deleteSelected(), false); f.store.undo(); assert.equal(f.store.getState().count, 1);
    } finally { f.cleanup(); }
});

test('canceling an edit and changing the store during a drag never overwrites a committed annotation', () => {
    const f = fixture();
    try {
        const annotation = add(f, 'length', [[1, 1], [4, 4]]); f.tool = 'select'; f.click(2, 2);
        f.pointer('pointerdown', 4, 4); f.pointer('pointermove', 6, 5); f.key('Escape');
        assert.deepEqual(f.store.get(annotation.id), annotation);
        f.pointer('pointerdown', 4, 4); f.pointer('pointermove', 6, 5);
        f.store.update(annotation.id, { points: [{ x: 1, y: 1 }, { x: 3, y: 3 }] });
        f.pointer('pointerup', 6, 5);
        assert.deepEqual(f.store.get(annotation.id).points, [{ x: 1, y: 1 }, { x: 3, y: 3 }]);
        assert.equal(f.store.getState().historyCount, 2);
    } finally { f.cleanup(); }
});

test('scope changes and tool switches cancel drafts and hide annotations from other original frames', () => {
    const f = fixture();
    try {
        f.drag([1, 1], [2, 2]); f.pointer('pointerdown', 2, 2); f.pointer('pointermove', 3, 3);
        f.frame = { ...f.frame, frameIndex: 3 }; f.controller.render();
        assert.equal(f.controller.getSelected(), null);
        f.pointer('pointerup', 3, 3); assert.equal(f.store.getState().count, 1);
        assert.equal(descendants(f.layer).filter(node => node.attributes.class?.includes('measurement-line')).length, 0);
        f.frame = { ...f.frame, frameIndex: 2 }; f.controller.render();
        assert.equal(descendants(f.layer).filter(node => node.attributes.class?.includes('measurement-line')).length, 1);
        f.pointer('pointerdown', 2, 2); f.tool = 'pan'; f.controller.render(); f.pointer('pointerup', 3, 3);
        assert.equal(f.store.getState().count, 1);
        f.frame = { ...f.frame, sopUid: '1.2.9' }; f.controller.render();
        assert.equal(descendants(f.layer).filter(node => node.attributes.class?.includes('measurement-line')).length, 0);
    } finally { f.cleanup(); }
});

test('pan/window/probe and secondary pointers are left to the host; owned tools intercept resets', () => {
    const f = fixture();
    try {
        for (const tool of ['pan', 'window', 'probe', 'zoom']) {
            f.tool = tool; assert.equal(f.pointer('pointerdown', 1, 1).defaultPrevented, false);
            assert.equal(fire(f.canvas, 'dblclick').defaultPrevented, false);
        }
        f.tool = 'rectangle';
        assert.equal(f.pointer('pointerdown', 1, 1, { button: 2 }).defaultPrevented, false);
        assert.equal(f.pointer('pointerdown', 1, 1, { isPrimary: false }).defaultPrevented, false);
        assert.equal(f.pointer('pointerdown', 1, 1).defaultPrevented, true);
        assert.equal(f.pointer('pointermove', 2, 2, { pointerId: 2 }).defaultPrevented, false);
        f.controller.cancelDraft();
        f.tool = 'polygon'; f.click(1, 1);
        assert.equal(f.pointer('pointermove', 2, 2, { button: 2, buttons: 2 }).defaultPrevented, false);
        assert.equal(f.pointer('pointermove', 2, 2, { pointerId: 2, isPrimary: false }).defaultPrevented, false);
        f.controller.cancelDraft();
        assert.equal(fire(f.canvas, 'dblclick').defaultPrevented, true);
        assert.equal(f.key('Enter').defaultPrevented, false);
    } finally { f.cleanup(); }
});

test('rendering reattaches after host overlay clearing and never accesses samples or exports image IDs', () => {
    const f = fixture();
    try {
        Object.defineProperty(f.frame, 'samples', { get() { throw new Error('ROI statistics must not run during interaction or SVG rendering.'); } });
        f.drag([1, 1], [3, 4]);
        f.tool = 'ellipse'; f.pointer('pointerdown', 1, 1); f.pointer('pointermove', 5, 5); f.pointer('pointerup', 5, 5);
        f.layer.replaceChildren(new Element('host-probe', document));
        f.controller.render();
        assert.equal(f.layer.children[0].name, 'host-probe');
        assert.equal(f.layer.children[1].attributes.class, 'persistent-annotations');
        assert.equal(descendants(f.layer).filter(node => node.attributes.class?.includes('measurement-line')).length, 2);
        assert.equal(f.errors.length, 0);
        const serialized = JSON.stringify(descendants(f.layer).map(node => ({ attrs: node.attributes, text: node.textContent })));
        assert.equal(serialized.includes(f.frame.sopUid), false);
        assert.equal(serialized.includes('samples'), false); assert.equal(serialized.includes('data-'), false);
    } finally { f.cleanup(); }
});

test('host callback failures are isolated and dispose removes listeners/subscriptions without disposing the store', async () => {
    const f = fixture({ onChange: () => Promise.reject(new Error('host observer rejected')), onError: () => { throw new Error('host observer threw'); } });
    f.drag([1, 1], [2, 2]); f.click(2, 2);
    assert.equal(f.store.getState().count, 1); assert.equal(f.errors.length, 1);
    f.pointer('pointerdown', 1, 1); f.pointer('pointermove', 4, 4);
    const count = f.changes.length;
    f.controller.dispose(); f.controller.dispose();
    assert.equal(f.canvas.captures.size, 0); assert.equal(f.layer.children.length, 0);
    assert.equal(f.pointer('pointerdown', 1, 1).defaultPrevented, false); f.pointer('pointerup', 5, 5);
    add(f, 'length', [[2, 2], [3, 3]]);
    assert.equal(f.store.getState().count, 2); assert.equal(f.changes.length, count);
    assert.equal(f.controller.getSelected(), null); assert.equal(f.controller.deleteSelected(), false);
    await new Promise(resolve => setTimeout(resolve, 0));
    f.store.dispose();
});

test('missing durable source identity rejects an interaction without a model mutation', () => {
    const f = fixture();
    try {
        f.frame = { ...f.frame, sopUid: undefined }; f.drag([1, 1], [2, 2]);
        assert.equal(f.store.getState().count, 0); assert.equal(f.errors.length, 1);
    } finally { f.cleanup(); }
});
