import test from 'node:test';
import assert from 'node:assert/strict';
import {ImageNoticePopover} from '../src/ui/ImageNoticePopover.js';

class Element extends EventTarget {
    constructor(tagName, ownerDocument) { super(); Object.assign(this, {tagName, ownerDocument, children: [], parentNode: null, attributes: {}, dataset: {}, style: {}, hidden: false, disabled: false, _text: '', bounds: {left: 700, right: 734, top: 20, bottom: 54, width: 34, height: 34}, nativeOpen: false}); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.replaceChildren(); }
    set innerHTML(value) { throw new Error('Notice metadata must never be interpreted as HTML.'); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
    append(...children) { for (const child of children) { child.remove(); child.parentNode = this; this.children.push(child); } }
    replaceChildren(...children) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this.append(...children); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
    focus() { this.ownerDocument.activeElement = this; this.dispatchEvent(new Event('focus')); }
    getBoundingClientRect() { return this.bounds; }
    closest() { return this.ownerDocument.shell; }
    showPopover() { this.nativeOpen = true; }
    hidePopover() { this.nativeOpen = false; }
    matches(selector) { return selector === ':popover-open' && this.nativeOpen; }
}
const walk = node => node.children.flatMap(child => [child, ...walk(child)]);
const byClass = (root, name) => walk(root).find(node => node.className?.split(' ').includes(name));
const wait = () => new Promise(resolve => setTimeout(resolve, 210));
function send(node, type, extra = {}) { const event = new Event(type, {cancelable: true}); for (const [key, value] of Object.entries(extra)) Object.defineProperty(event, key, {value}); node.dispatchEvent(event); return event; }
const content = changes => ({contextKey: 'a/frame-1', contextLabel: 'Pane A · Image 1 of 20', groups: [{id: 'geometry', label: 'Geometry', messages: ['Limited geometry.']}, {id: 'encoding', label: 'Encoding compatibility', messages: ['Source bytes are unchanged.', 'Source bytes are unchanged.', '']}], unreadCount: 2, ...changes});
function fixture(callbacks = {}) {
    const document = new EventTarget(); document.createElement = tag => new Element(tag, document); document.defaultView = new EventTarget(); document.defaultView.innerWidth = 1024; document.defaultView.innerHeight = 768;
    document.shell = new Element('div', document); document.shell.bounds = {left: 100, right: 900, top: 0, bottom: 700};
    const root = document.createElement('div'), shown = [], read = [];
    const popover = new ImageNoticePopover(root, {onShow: value => shown.push(value), onAcknowledge: value => read.push(value), ...callbacks});
    const node = name => byClass(root, `image-notice-${name}`);
    node('popover').bounds = {left: 0, right: 420, top: 0, bottom: 300, width: 420, height: 300};
    return {document, root, popover, shown, read, node, cleanup: () => popover.dispose()};
}

test('empty current image reserves a muted disabled notice icon and has no popup', () => {
    const f = fixture(); try { assert.equal(f.node('button').disabled, true); assert.equal(f.node('popover').hidden, true); assert.equal(f.node('button').attributes['aria-label'], 'No image notices'); f.popover.open(); assert.equal(f.popover.isOpen(), false); } finally { f.cleanup(); }
});

test('current notices are deduplicated and grouped with safe literal text and accessible counts', () => {
    const f = fixture(); try {
        const unsafe = '<img src=x onerror=alert(1)> & "source"';
        f.popover.update(content({groups: [{id: 'encoding', label: unsafe, messages: [unsafe, unsafe, ' ', 'Second']}, {id: 'timing', label: 'Playback timing', messages: ['Second', 'Timing']}] }));
        assert.equal(walk(f.root).filter(node => node.className === 'image-notice-message').length, 3); assert.ok(f.root.textContent.includes(unsafe));
        assert.equal(f.node('button').dataset.noticeCount, '3'); assert.equal(f.node('button').dataset.unread, 'true'); assert.match(f.node('button').attributes['aria-label'], /3 notices, 2 unread/);
        assert.equal(f.node('button').attributes['aria-controls'], f.node('popover').id); assert.equal(f.node('context').textContent, 'Pane A · Image 1 of 20');
    } finally { f.cleanup(); }
});

test('hover opens without acknowledging and survives pointer movement into the scrollable popup', async () => {
    const f = fixture(); try {
        f.popover.update(content()); send(f.node('button'), 'pointerenter', {pointerType: 'mouse'}); assert.equal(f.popover.isOpen(), true); assert.equal(f.node('popover').nativeOpen, true); assert.equal(f.read.length, 0);
        send(f.node('button'), 'pointerleave'); send(f.node('popover'), 'pointerenter', {pointerType: 'mouse'}); await wait(); assert.equal(f.popover.isOpen(), true);
        send(f.node('popover'), 'pointerleave'); await wait(); assert.equal(f.popover.isOpen(), false); assert.equal(f.node('popover').hidden, true);
    } finally { f.cleanup(); }
});

test('keyboard focus opens, click pins, and Escape closes with focus returned without reopening', async () => {
    const f = fixture(); try {
        f.popover.update(content()); f.node('button').focus(); assert.equal(f.popover.isOpen(), true);
        send(f.node('button'), 'click'); assert.equal(f.node('popover').dataset.pinned, 'true'); assert.equal(f.document.activeElement, f.node('close'));
        send(f.node('button'), 'pointerleave'); await wait(); assert.equal(f.popover.isOpen(), true);
        const event = send(f.document, 'keydown', {key: 'Escape', target: f.node('close')}); assert.equal(event.defaultPrevented, true); assert.equal(f.popover.isOpen(), false); assert.equal(f.document.activeElement, f.node('button'));
        assert.equal(f.node('button').attributes['aria-expanded'], 'false'); assert.equal(f.read.length, 0);
    } finally { f.cleanup(); }
});

test('Escape dismisses hovered content without moving an unrelated keyboard focus', () => {
    const f = fixture(); try {
        f.popover.update(content()); const outside = f.document.createElement('canvas'); outside.focus(); send(f.node('button'), 'pointerenter', {pointerType: 'mouse'});
        const event = send(f.document, 'keydown', {key: 'Escape', target: outside}); assert.equal(event.defaultPrevented, true); assert.equal(f.popover.isOpen(), false); assert.equal(f.document.activeElement, outside);
    } finally { f.cleanup(); }
});

test('touch requires explicit click and outside pointer closes without stealing focus', () => {
    const f = fixture(); try {
        f.popover.update(content()); send(f.node('button'), 'pointerenter', {pointerType: 'touch'}); assert.equal(f.popover.isOpen(), false);
        send(f.node('button'), 'click'); assert.equal(f.popover.isOpen(), true); const outside = f.document.createElement('button'); outside.focus(); send(f.document, 'pointerdown', {target: outside}); assert.equal(f.popover.isOpen(), false); assert.equal(f.document.activeElement, outside);
    } finally { f.cleanup(); }
});

test('marking read keeps all current notices available and handles a synchronously hidden focused action', () => {
    let f; f = fixture({onAcknowledge: input => { assert.deepEqual(input, {contextKey: 'a/frame-1'}); f.popover.update(content({unreadCount: 0})); }});
    try {
        f.popover.update(content()); f.popover.open({pinned: true}); f.node('acknowledge').focus(); const body = f.node('body'), message = f.node('message'); body.scrollTop = 40;
        send(f.node('acknowledge'), 'click'); assert.equal(f.popover.isOpen(), true); assert.equal(f.node('button').dataset.unread, 'false'); assert.equal(f.node('badge').hidden, true); assert.equal(f.node('acknowledge').hidden, true); assert.equal(f.document.activeElement, f.node('close'));
        assert.equal(f.node('message'), message); assert.equal(body.scrollTop, 40); assert.ok(f.root.textContent.includes('Source bytes are unchanged.'));
        f.popover.close(); f.popover.open(); assert.equal(f.popover.isOpen(), true); assert.match(f.node('button').attributes['aria-label'], /all read/);
    } finally { f.cleanup(); }
});

test('changing frame or pane closes stale notes and clears old hover timers', async () => {
    const f = fixture(); try {
        f.popover.update(content()); send(f.node('button'), 'pointerenter', {pointerType: 'mouse'}); send(f.node('button'), 'pointerleave');
        f.popover.update(content({contextKey: 'b/frame-9', contextLabel: 'Pane B · Image 9 of 20'})); assert.equal(f.popover.isOpen(), false); f.popover.open({pinned: true}); await wait(); assert.equal(f.popover.isOpen(), true); assert.equal(f.node('context').textContent, 'Pane B · Image 9 of 20');
        f.popover.update({contextKey: 'b/frame-clean'}); assert.equal(f.popover.isOpen(), false); assert.equal(f.node('button').disabled, true);
    } finally { f.cleanup(); }
});

test('native toggle events cannot dismiss a newly reopened popup', () => {
    const f = fixture(); try {
        f.popover.update(content()); f.popover.open(); f.popover.close(); f.popover.open(); send(f.node('popover'), 'toggle', {newState: 'closed'}); assert.equal(f.popover.isOpen(), true);
        f.node('popover').nativeOpen = false; send(f.node('popover'), 'toggle', {newState: 'closed'}); assert.equal(f.popover.isOpen(), false);
    } finally { f.cleanup(); }
});

test('popup position clamps to an embedded viewer and the visual viewport, including long content', () => {
    const f = fixture(); try {
        f.document.defaultView.visualViewport = {offsetLeft: 0, offsetTop: 0, width: 390, height: 400}; f.document.shell.bounds = {left: 20, right: 370, top: 10, bottom: 390}; f.node('button').bounds = {left: 330, right: 364, top: 20, bottom: 54}; f.node('popover').bounds.height = 350;
        f.popover.update(content()); f.popover.open(); assert.equal(f.node('popover').style.width, '334px'); assert.equal(f.node('popover').style.left, '28px'); assert.equal(f.node('popover').style.top, '32px'); assert.equal(f.node('popover').style.maxHeight, '364px');
    } finally { f.cleanup(); }
});

test('popover fallback works without native methods and independent viewers retain unique controls', () => {
    const a = fixture(), b = fixture(); try {
        a.node('popover').showPopover = undefined; a.node('popover').hidePopover = undefined; a.popover.update(content()); b.popover.update(content()); a.popover.open();
        assert.equal(a.node('popover').hidden, false); assert.equal(b.popover.isOpen(), false); assert.notEqual(a.node('popover').id, b.node('popover').id); a.popover.close(); assert.equal(a.node('popover').hidden, true);
    } finally { a.cleanup(); b.cleanup(); }
});

test('disposal cancels hover timers and removes native controls and listeners', async () => {
    const f = fixture(); f.popover.update(content()); send(f.node('button'), 'pointerenter', {pointerType: 'mouse'}); send(f.node('button'), 'pointerleave'); f.cleanup(); await wait();
    assert.equal(f.root.children.length, 0); assert.equal(f.popover.isOpen(), false); f.popover.update(content()); f.popover.open(); assert.equal(f.root.children.length, 0);
});
