import test from 'node:test';
import assert from 'node:assert/strict';
import { ArchiveBrowser } from '../src/ui/ArchiveBrowser.js';

// Isolate the archive-lifetime operations from unrelated query/list rendering.
// Real retained images and attribute DOM are exercised by the browser gate.
function fixture() {
    const oldClient = { name: 'generated old archive' }, elements = new Map(), calls = [];
    const browser = Object.assign(Object.create(ArchiveBrowser.prototype), {
        disposed: false, client: oldClient,
        resetQueries() { calls.push('cancel-queries'); },
        el(id) { if (!elements.has(id)) elements.set(id, { hidden: false, value: '', textContent: '' }); return elements.get(id); }
    });
    return { browser, oldClient, elements, calls };
}

test('disconnect releases references owned by the old client before clearing the connected client', () => {
    const f = fixture(), otherClient = {}, retained = new Map([[f.oldClient, { frames: 2, attributeRows: 40 }], [otherClient, { frames: 1, attributeRows: 20 }]]);
    f.browser.disconnectSource = () => {
        f.calls.push('release-source');
        assert.equal(f.browser.requireClient(), f.oldClient);
        retained.delete(f.browser.client);
    };
    f.browser.disconnect();
    assert.deepEqual(f.calls, ['cancel-queries', 'release-source']);
    assert.equal(f.browser.client, null);
    assert.equal(retained.has(f.oldClient), false);
    assert.deepEqual(retained.get(otherClient), { frames: 1, attributeRows: 20 });
    assert.equal(f.elements.get('archive-search-form').hidden, true);
    assert.equal(f.elements.get('archive-disconnect').hidden, true);
    assert.throws(() => f.browser.requireClient(), /Connect a DICOMweb archive/);
});

test('reconfiguring an archive releases its old owner before installing a different client', () => {
    const f = fixture();
    f.browser.disconnectSource = () => { f.calls.push('release-source'); assert.equal(f.browser.client, f.oldClient); };
    assert.deepEqual(f.browser.configure({ baseUrl: 'https://generated.invalid/dicom-web/' }), { connected: true });
    assert.deepEqual(f.calls, ['cancel-queries', 'release-source']);
    assert.notEqual(f.browser.client, f.oldClient);
    assert.equal(f.browser.client.baseUrl, 'https://generated.invalid/dicom-web');
    assert.equal(f.elements.get('archive-disconnect').hidden, false);
});

test('a disposed archive cannot invoke a revocation callback or replace its client', () => {
    const f = fixture(); f.browser.disposed = true;
    f.browser.disconnectSource = () => assert.fail('Disposed owners must not mutate another viewing lifetime.');
    assert.throws(() => f.browser.disconnect(), /disposed/);
    assert.throws(() => f.browser.configure({ baseUrl: 'https://generated.invalid/' }), /disposed/);
    assert.equal(f.browser.client, f.oldClient);
    assert.deepEqual(f.calls, []);
});

test('a throwing synchronous revocation callback still clears the connection and disconnect controls', () => {
    const f = fixture(), failure = new Error('Generated cleanup failure');
    f.browser.disconnectSource = () => { assert.equal(f.browser.client, f.oldClient); throw failure; };
    assert.throws(() => f.browser.disconnect(), error => error === failure);
    assert.equal(f.browser.client, null);
    assert.equal(f.elements.get('archive-search-form').hidden, true);
    assert.equal(f.elements.get('archive-disconnect').hidden, true);
});
