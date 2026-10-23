import test from 'node:test';
import assert from 'node:assert/strict';
import { PrimaryMenu } from '../src/ui/PrimaryMenu.js';

class Element extends EventTarget {
    constructor(tagName, ownerDocument) { super(); Object.assign(this, { tagName, ownerDocument, children: [], parentNode: null, attributes: {}, dataset: {}, hidden: false, disabled: false, open: false, textContent: '' }); }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    removeAttribute(key) { delete this.attributes[key]; }
    focus() { this.ownerDocument.shadow.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; this.ownerDocument.pendingClose.push(this); }
    getBoundingClientRect() { return { left: 0, top: 0, right: 320, bottom: 700 }; }
}
const walk = root => root.children.flatMap(node => [node, ...walk(node)]);
function fixture(overrides = {}) {
    const document = { activeElement: null, shadow: { activeElement: null }, pendingClose: [], createElement: tag => new Element(tag, document) };
    const root = document.createElement('div'); root.getRootNode = () => document.shadow; document.activeElement = root;
    const toggle = document.createElement('button'); document.shadow.activeElement = toggle; root.append(toggle);
    const calls = [], callbacks = { toggleButton: toggle, onOpen: () => calls.push('open'), onCloseSession: () => calls.push('close-session'), onShortcuts: () => calls.push('shortcuts'), canClose: () => true, ...overrides };
    const menu = new PrimaryMenu(root, callbacks), byId = id => walk(root).find(node => node.id === id), dialog = byId('primary-menu');
    return { document, root, toggle, calls, callbacks, menu, dialog, byId,
        click(id) { const target = byId(id), event = new Event('click'); Object.defineProperty(event, 'target', { value: target }); for (let node = target; node; node = node.parentNode) node.dispatchEvent(event); },
        flushClose() { for (const node of document.pendingClose.splice(0)) node.dispatchEvent(new Event('close')); }
    };
}

test('primary menu exposes ordered normal navigation buttons and preserves shadow-root focus', () => {
    const f = fixture(); try {
        assert.deepEqual(walk(f.dialog).filter(node => node.dataset.primaryAction).map(node => node.id), ['primary-menu-open', 'primary-menu-close', 'primary-menu-ai-assist', 'primary-menu-shortcuts']);
        assert.equal(walk(f.dialog).some(node => node.attributes.role === 'menu'), false);
        assert.equal(f.toggle.attributes['aria-haspopup'], 'dialog'); assert.equal(f.toggle.attributes['aria-expanded'], 'false');
        f.menu.open(); assert.equal(f.menu.isOpen(), true); assert.equal(f.dialog.open, true); assert.equal(f.document.shadow.activeElement, f.byId('primary-menu-open'));
        assert.equal(f.toggle.attributes['aria-expanded'], 'true'); f.click('primary-menu-dismiss');
        assert.equal(f.menu.isOpen(), false); assert.equal(f.document.shadow.activeElement, f.toggle); assert.deepEqual(f.calls, []);
    } finally { f.menu.dispose(); }
});

test('Open and Close actions dismiss the drawer before invoking the corresponding session operation', () => {
    const f = fixture(); try {
        f.callbacks.onOpen = () => { assert.equal(f.menu.isOpen(), false); assert.equal(f.document.shadow.activeElement, f.toggle); f.calls.push('open'); };
        f.menu.open(); f.click('primary-menu-open'); assert.deepEqual(f.calls, ['open']);
        f.menu.open(); f.click('primary-menu-close'); assert.deepEqual(f.calls, ['open', 'close-session']);
        f.menu.open(); f.click('primary-menu-shortcuts'); assert.deepEqual(f.calls, ['open', 'close-session', 'shortcuts']);
    } finally { f.menu.dispose(); }
});

test('Close availability follows the live session and refresh never performs a session action', () => {
    let canClose = false; const f = fixture({ canClose: () => canClose }); try {
        f.menu.open(); assert.equal(f.byId('primary-menu-close').disabled, true); f.click('primary-menu-close'); assert.deepEqual(f.calls, []); assert.equal(f.menu.isOpen(), true);
        canClose = true; f.menu.refresh(); assert.equal(f.byId('primary-menu-close').disabled, false); assert.deepEqual(f.calls, []);
        f.click('primary-menu-close'); assert.deepEqual(f.calls, ['close-session']);
    } finally { f.menu.dispose(); }
});

test('Escape and backdrop clicks dismiss only the menu, and queued close events cannot close a reopened drawer', () => {
    const f = fixture(); try {
        f.menu.open(); const cancel = new Event('cancel', { cancelable: true }); f.dialog.dispatchEvent(cancel); assert.equal(cancel.defaultPrevented, true); assert.equal(f.menu.isOpen(), false);
        f.menu.open(); f.flushClose(); assert.equal(f.menu.isOpen(), true);
        const click = (x, y) => { const event = new Event('click'); Object.defineProperties(event, { target: { value: f.dialog }, clientX: { value: x }, clientY: { value: y } }); f.dialog.dispatchEvent(event); };
        click(160, 100); assert.equal(f.menu.isOpen(), true); click(500, 100); assert.equal(f.menu.isOpen(), false); assert.deepEqual(f.calls, []);
    } finally { f.menu.dispose(); }
});

test('native external dismissal reconciles expanded state and returns focus', () => {
    const f = fixture(); try {
        f.menu.open(); f.dialog.open = false; f.dialog.dispatchEvent(new Event('close'));
        assert.equal(f.menu.isOpen(), false); assert.equal(f.toggle.attributes['aria-expanded'], 'false'); assert.equal(f.document.shadow.activeElement, f.toggle);
    } finally { f.menu.dispose(); }
});

test('pending session actions cannot be invoked twice while dismissal remains available', async () => {
    let finish; const pending = new Promise(resolve => { finish = resolve; }), f = fixture({ onCloseSession: () => { f.calls.push('close-session'); return pending; } });
    try {
        f.menu.open(); f.click('primary-menu-close'); f.menu.open(); assert.equal(f.byId('primary-menu-close').disabled, true); assert.equal(f.byId('primary-menu-open').disabled, true);
        f.click('primary-menu-close'); assert.deepEqual(f.calls, ['close-session']); f.click('primary-menu-dismiss'); assert.equal(f.menu.isOpen(), false);
        finish(); await pending; await new Promise(resolve => setImmediate(resolve)); f.menu.open(); assert.equal(f.byId('primary-menu-close').disabled, false);
    } finally { f.menu.dispose(); }
});

test('optional actions are hidden and a failed operation is reported without leaving controls permanently busy', () => {
    const expected = new Error('Synthetic operation failure'), errors = [], f = fixture({ onShortcuts: undefined, onOpen() { throw expected; }, onError: error => errors.push(error) });
    try {
        assert.equal(f.byId('primary-menu-shortcuts').hidden, true); f.menu.open(); f.click('primary-menu-open'); assert.deepEqual(errors, [expected]);
        f.menu.open(); assert.equal(f.byId('primary-menu-open').disabled, false); assert.match(walk(f.dialog).find(node => node.className === 'primary-menu-message').textContent, /Synthetic operation failure/);
    } finally { f.menu.dispose(); }
});

test('toggle wiring and disposal remove the drawer and listeners without closing session images', () => {
    const f = fixture(); f.toggle.dispatchEvent(new Event('click')); assert.equal(f.menu.isOpen(), true);
    f.toggle.dispatchEvent(new Event('click')); assert.equal(f.menu.isOpen(), false); f.menu.open(); f.menu.dispose();
    assert.equal(f.menu.isOpen(), false); assert.equal(f.byId('primary-menu'), undefined); assert.equal(f.toggle.attributes['aria-controls'], undefined);
    f.toggle.dispatchEvent(new Event('click')); f.dialog.dispatchEvent(new Event('cancel')); f.menu.open(); assert.equal(f.menu.isOpen(), false); assert.deepEqual(f.calls, []); f.menu.dispose();
});


test('AI Assist is hidden unless explicitly configured as a primary action', () => {
    const f = fixture(); try { assert.equal(f.byId('primary-menu-ai-assist').hidden, true); } finally { f.menu.dispose(); }
    let calls = 0;
    const ai = fixture({onAiAssist: () => ++calls}); try {
        assert.equal(ai.byId('primary-menu-ai-assist').hidden, false);
        ai.menu.open(); ai.click('primary-menu-ai-assist'); assert.equal(calls, 1); assert.equal(ai.menu.isOpen(), false);
    } finally { ai.menu.dispose(); }
});
