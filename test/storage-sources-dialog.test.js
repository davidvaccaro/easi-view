import test from 'node:test';
import assert from 'node:assert/strict';
import { StorageSourcesDialog } from '../src/ui/StorageSourcesDialog.js';

class Element extends EventTarget {
    constructor(tagName, ownerDocument) { super(); Object.assign(this, { tagName, ownerDocument, children: [], parentNode: null, attributes: {}, dataset: {}, value: '', checked: false, hidden: false, disabled: false, open: false, _text: '' }); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.replaceChildren(); }
    set innerHTML(value) { throw new Error('Connection values must remain literal text.'); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
    append(...children) { for (const child of children) { child.remove(); child.parentNode = this; this.children.push(child); } }
    replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...children); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
    focus() { this.ownerDocument.activeElement = this; this.ownerDocument.shadow.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; this.ownerDocument.pendingClose.push(this); }
    querySelectorAll(selector) { return walk(this).filter(node => selector.split(',').includes(node.tagName) || selector.includes('[tabindex]') && node.tabIndex != null); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    getBoundingClientRect() { return { left: 100, top: 100, right: 1100, bottom: 900 }; }
}
const walk = node => node.children.flatMap(child => [child, ...walk(child)]);
const tick = () => new Promise(resolve => setImmediate(resolve));
const completeResult = () => ({ ok: true, summary: 'Query endpoint responded. No images were downloaded.', checks: [{ name: 'Query access', status: 'passed', detail: 'A bounded metadata query completed.' }] });
function fixture({ profiles = [], manager: overrides = {}, ...options } = {}) {
    const document = { activeElement: null, shadow: { activeElement: null }, pendingClose: [], createElement: tag => new Element(tag, document) };
    const root = document.createElement('div'); root.getRootNode = () => document.shadow;
    const launcher = document.createElement('button'); root.append(launcher); launcher.focus();
    const calls = [], changes = [], owned = new Map(profiles.map(profile => [profile.id, structuredClone(profile)]));
    const managed = { id: 'managed', name: 'Local EASI Store', connection: 'dicomweb', managed: true, editable: false, isDefault: true };
    const manager = { canRemember: true, defaultId: 'managed',
        list() { return [managed, ...Array.from(owned.values()).map(profile => ({ id: profile.id, name: profile.name, connection: profile.connection, authentication: profile.authentication,
            remember: profile.remember, managed: false, editable: true, isDefault: manager.defaultId === profile.id }))]; },
        getProfile(id) { return id === 'managed' ? { id, name: managed.name, connection: 'dicomweb', managed: true } : structuredClone(owned.get(id)); },
        async save(profile, { signal }) { calls.push(['save', profile, signal]); const id = profile.id || 'created'; const saved = { ...profile, id }; delete saved.token; delete saved.username; delete saved.password;
            owned.set(id, saved); if (profile.isDefault) manager.defaultId = id; return manager.list().find(entry => entry.id === id); },
        async remove(id, { signal }) { calls.push(['remove', id, signal]); owned.delete(id); },
        async test(profile, { signal }) { calls.push(['test', profile, signal]); return completeResult(); },
        async setDefault(id) { calls.push(['default', id]); manager.defaultId = id; }, ...overrides };
    const dialog = new StorageSourcesDialog(root, { manager, onChange: value => changes.push(value), onClose: () => calls.push(['close']), ...options });
    const modal = walk(root).find(node => node.tagName === 'dialog');
    const action = (name, index = 0) => walk(modal).filter(node => node.dataset.storageAction === name)[index];
    function event(target, type = 'click', extra = {}) { assert.ok(target, `Missing ${type} target`); const value = new Event(type, { cancelable: true });
        Object.defineProperty(value, 'target', { value: target }); for (const [key, v] of Object.entries(extra)) Object.defineProperty(value, key, { value: v }); modal.dispatchEvent(value); return value; }
    const field = key => walk(modal).find(node => node.dataset.storageField === key);
    return { root, document, launcher, manager, calls, changes, dialog, modal, action, field, event,
        click: (name, index) => event(action(name, index)),
        input(key, value, type = 'input') { const control = field(key); assert.ok(control, `Missing ${key} field`); if (control.type === 'checkbox') control.checked = value; else control.value = value; event(control, type); return control; },
        cleanup: () => dialog.dispose() };
}
const ownedProfile = values => ({ id: 'own', name: 'Research archive', connection: 'dicomweb', baseUrl: 'https://pacs.example.test/dicomweb/', authentication: 'none', remember: true, isDefault: false, ...values });

test('opening storage sources does not test or save archives and managed details stay private', async () => {
    const f = fixture(); try {
        f.dialog.open(); await tick(); assert.equal(f.dialog.isOpen(), true); assert.equal(f.calls.length, 0);
        assert.match(f.root.textContent, /Managed by the host application/); assert.match(f.root.textContent, /Local EASI Store/);
        assert.equal(f.field('baseUrl'), undefined); assert.equal(f.action('save'), undefined); assert.equal(f.action('remove'), undefined);
        f.click('test'); await tick(); assert.equal(f.calls[0][0], 'test'); assert.equal(f.calls[0][1], 'managed');
        assert.match(f.root.textContent, /bounded metadata query/);
    } finally { f.cleanup(); }
});

test('a new source is explicitly tested as an unsaved draft, and edits invalidate test results', async () => {
    const f = fixture(); try {
        f.dialog.open(); f.click('add'); f.input('name', 'Synthetic archive'); f.input('baseUrl', 'https://pacs.example.test/dicomweb/');
        f.click('test'); await tick();
        const request = f.calls.find(call => call[0] === 'test'); assert.equal(request[1].name, 'Synthetic archive'); assert.equal(request[1].baseUrl, 'https://pacs.example.test/dicomweb/');
        assert.equal(f.calls.some(call => call[0] === 'save'), false); assert.match(f.root.textContent, /No images were downloaded/);
        f.input('name', 'Edited archive'); assert.doesNotMatch(f.root.textContent, /Query endpoint responded/);
        f.input('remember', true, 'change'); f.input('isDefault', true, 'change'); f.click('save'); await tick();
        const saved = f.calls.find(call => call[0] === 'save')[1]; assert.equal(saved.remember, true); assert.equal(saved.isDefault, true);
        assert.equal(f.manager.defaultId, 'created'); assert.deepEqual(f.changes, [{ type: 'save', sourceId: 'created' }]);
    } finally { f.cleanup(); }
});

test('bearer and basic authentication use private input properties, clear credentials on endpoint changes and close', async () => {
    const f = fixture(); try {
        f.dialog.open(); f.click('add'); f.input('authentication', 'bearer', 'change');
        assert.equal(f.field('token').type, 'password'); f.input('token', 'synthetic-secret'); assert.equal(f.field('token').attributes.value, undefined);
        f.input('baseUrl', 'https://different.example.test/dicomweb/'); assert.equal(f.field('token').value, '');
        f.input('authentication', 'basic', 'change'); f.input('username', 'synthetic-user'); f.input('password', 'synthetic-password');
        assert.equal(f.field('password').type, 'password'); const password = f.field('password');
        f.dialog.close(); assert.equal(password.value, ''); assert.doesNotMatch(f.root.textContent, /synthetic-password|synthetic-secret|synthetic-user/);
        f.dialog.open(); assert.equal(f.field('password'), undefined);
    } finally { f.cleanup(); }
});

test('editing a source retains its safe ID and leaves existing credential fields blank', async () => {
    const f = fixture({ profiles: [ownedProfile({ authentication: 'basic', hasCredentials: true })] }); try {
        f.dialog.open({ sourceId: 'own' }); assert.equal(f.field('username').value, ''); assert.equal(f.field('password').value, '');
        assert.match(f.field('username').placeholder, /Leave both blank/); f.input('name', 'Renamed source'); f.click('save'); await tick();
        const draft = f.calls.find(call => call[0] === 'save')[1]; assert.equal(draft.id, 'own'); assert.equal(draft.username, ''); assert.equal(draft.password, ''); assert.equal(draft.hasCredentials, undefined);
        assert.match(f.root.textContent, /Renamed source/);
    } finally { f.cleanup(); }
});

test('busy tests disable draft controls, cancel their signal and ignore late results', async () => {
    let finish, signal;
    const f = fixture({ manager: { test(profile, options) { signal = options.signal; return new Promise(resolve => { finish = resolve; }); } } });
    try {
        f.dialog.open(); f.click('add'); f.input('name', 'Slow archive'); f.click('test'); await tick();
        assert.equal(f.modal.attributes['aria-busy'], 'true'); assert.equal(f.field('name').disabled, true); assert.match(f.root.textContent, /No images will be downloaded/);
        f.click('cancel-operation'); assert.equal(signal.aborted, true); assert.equal(f.field('name').disabled, false);
        finish({ ok: true, summary: 'OLD RESULT', checks: [] }); await tick(); assert.doesNotMatch(f.root.textContent, /OLD RESULT/); assert.match(f.root.textContent, /Operation canceled/);
    } finally { f.cleanup(); }
});

test('closing during work aborts the operation, scrubs draft secrets and restores shadow-root focus', async () => {
    let signal, finish;
    const f = fixture({ manager: { test(profile, options) { signal = options.signal; return new Promise(resolve => { finish = resolve; }); } } }); try {
        f.dialog.open(); f.click('add'); f.input('authentication', 'bearer', 'change'); f.input('token', 'synthetic-private-token'); f.click('test'); await tick();
        const token = f.field('token'); f.dialog.close(); assert.equal(signal.aborted, true); assert.equal(token.value, ''); assert.equal(f.document.shadow.activeElement, f.launcher);
        f.dialog.open(); finish(completeResult()); await tick(); assert.doesNotMatch(f.root.textContent, /Query endpoint responded/);
        assert.equal(f.dialog.isOpen(), true);
    } finally { f.cleanup(); }
});

test('remove requires inline confirmation and exposes safe active-session guard errors', async () => {
    let blocked = true;
    const f = fixture({ profiles: [ownedProfile()], manager: { async remove(id) { if (blocked) throw Object.assign(new Error('RAW SECRET https://private.test/'), { publicMessage: 'Close images from this source before removing it.' }); f.calls.push(['remove', id]); } } }); try {
        f.dialog.open({ sourceId: 'own' }); f.click('remove'); assert.equal(f.calls.length, 0); assert.match(f.root.textContent, /will not be deleted/);
        f.click('cancel-remove'); assert.equal(f.action('confirm-remove'), undefined); f.click('remove'); f.click('confirm-remove'); await tick();
        assert.match(f.root.textContent, /Close images from this source/); assert.doesNotMatch(f.root.textContent, /RAW SECRET|private.test/);
        blocked = false; f.click('remove'); f.click('confirm-remove'); await tick(); assert.deepEqual(f.changes, [{ type: 'remove', sourceId: 'own' }]);
    } finally { f.cleanup(); }
});

test('DIMSE TCP fields appear only with an available local helper, and never accept HTTP credentials', async () => {
    const f = fixture({ getConnectorAvailable: async () => true }); try {
        f.dialog.open(); await tick(); f.click('add');
        assert.ok(f.field('connection').children.some(option => option.value === 'dimse-local'));
        f.input('connection', 'dimse-local', 'change'); assert.equal(f.field('baseUrl'), undefined); assert.equal(f.field('authentication'), undefined);
        assert.equal(f.field('dimse.host').value, '127.0.0.1'); f.input('name', 'Local PACS'); f.input('dimse.port', '11112'); f.input('dimse.calledAeTitle', 'ORTHANC');
        f.click('save'); await tick(); const profile = f.calls.find(call => call[0] === 'save')[1]; assert.equal(profile.authentication, 'none'); assert.equal(profile.dimse.port, 11112); assert.equal(profile.dimse.calledAeTitle, 'ORTHANC');
    } finally { f.cleanup(); }
    const missing = fixture(); try {
        missing.dialog.open(); missing.click('add'); assert.equal(missing.field('connection').children.some(option => option.value === 'dimse-local'), false);
        missing.input('connection', 'dimse-gateway', 'change'); assert.match(missing.root.textContent, /Browsers cannot open DIMSE TCP sockets/);
    } finally { missing.cleanup(); }
});

test('read-only embedding keeps testing but hides mutations and persistence settings when unavailable', async () => {
    const f = fixture({ canEdit: false }); try {
        f.dialog.open(); assert.equal(f.action('add').hidden, true); assert.equal(f.action('save'), undefined); assert.equal(f.action('default'), undefined);
        f.click('test'); await tick(); assert.equal(f.calls.find(call => call[0] === 'test')[1], 'managed');
    } finally { f.cleanup(); }
    const noStorage = fixture({ manager: { canRemember: false } }); try { noStorage.dialog.open(); noStorage.click('add'); assert.equal(noStorage.field('remember'), undefined); } finally { noStorage.cleanup(); }
});

test('managed archives may become the default without exposing or editing connection details', async () => {
    const f = fixture({ manager: { defaultId: 'another' } }); try {
        f.dialog.open({ sourceId: 'managed' }); f.manager.list = () => [{ id: 'managed', name: 'Managed archive', managed: true, connection: 'dicomweb', isDefault: false }];
        f.dialog.close(); f.dialog.open({ sourceId: 'managed' }); f.click('default'); await tick();
        assert.equal(f.manager.defaultId, 'managed'); assert.deepEqual(f.changes, [{ type: 'default', sourceId: 'managed' }]); assert.equal(f.field('baseUrl'), undefined);
    } finally { f.cleanup(); }
});

test('safe literal names/results cannot become HTML and unexpected errors do not reveal raw details', async () => {
    const f = fixture({ profiles: [ownedProfile({ name: '<img src=x onerror=alert(1)>' })], manager: { async test() { throw new Error('Secret raw server response'); } } }); try {
        f.dialog.open({ sourceId: 'own' }); assert.match(f.root.textContent, /<img src=x onerror=alert\(1\)>/); f.click('test'); await tick();
        assert.doesNotMatch(f.root.textContent, /Secret raw server response/); assert.match(f.root.textContent, /Check the connection settings/);
    } finally { f.cleanup(); }
});

test('native modal labels, Escape, focus cycling, queued closes and disposal remain viewer-scoped', () => {
    const a = fixture(), b = fixture(); try {
        a.dialog.open(); b.dialog.open(); assert.notEqual(a.modal.id, b.modal.id); assert.equal(a.modal.attributes['aria-modal'], 'true');
        const first = walk(a.modal).find(node => node.dataset.storageAction === 'close'), last = a.action('close', 1); last.focus();
        const tab = a.event(last, 'keydown', { key: 'Tab', shiftKey: false }); assert.equal(tab.defaultPrevented, true); assert.equal(a.document.shadow.activeElement, first);
        a.modal.dispatchEvent(new Event('cancel', { cancelable: true })); assert.equal(a.dialog.isOpen(), false); assert.equal(b.dialog.isOpen(), true);
        a.dialog.open(); for (const node of a.document.pendingClose.splice(0)) node.dispatchEvent(new Event('close')); assert.equal(a.dialog.isOpen(), true);
        a.cleanup(); assert.equal(a.dialog.isOpen(), false); assert.equal(walk(a.root).some(node => node.tagName === 'dialog'), false); a.dialog.open();
    } finally { a.cleanup(); b.cleanup(); }
});

test('helper discovery preserves a draft and keyboard focus, and retired credential inputs are scrubbed', async () => {
    let available;
    const f = fixture({ getConnectorAvailable: () => new Promise(resolve => { available = resolve; }) }); try {
        f.dialog.open(); await tick(); f.click('add'); f.input('name', 'Typing before helper discovery'); f.field('name').focus();
        available(true); await tick(); assert.equal(f.field('name').value, 'Typing before helper discovery'); assert.equal(f.document.shadow.activeElement, f.field('name'));
        f.input('authentication', 'bearer', 'change'); f.input('token', 'synthetic-secret'); const oldToken = f.field('token');
        f.click('test'); await tick(); assert.equal(oldToken.value, '', 'editor replacement clears the detached secret field');
    } finally { f.cleanup(); }
});

test('query-only test results explicitly mark image retrieval as not tested', async () => {
    const f = fixture({ manager: { async test() { return { ok: true, summary: 'Metadata query succeeded. Image retrieval and viewing were not tested.',
        checks: [{ name: 'Metadata query', status: 'passed' }, { name: 'Image retrieval', status: 'not-tested', detail: 'Open a study to verify display.' }] }; } } }); try {
        f.dialog.open(); f.click('test'); await tick();
        const untouched = walk(f.modal).find(node => node.dataset.status === 'not-tested');
        assert.ok(untouched); assert.match(untouched.textContent, /Image retrievalNot tested/); assert.match(f.root.textContent, /viewing were not tested/);
    } finally { f.cleanup(); }
});
