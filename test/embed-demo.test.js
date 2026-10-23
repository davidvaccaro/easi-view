import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../public/embed-demo.js', import.meta.url), 'utf8');
const entry = "import { createViewer } from './assets/easi-view.js';";
assert.ok(source.startsWith(entry));
const image = (modality = 'CT', frameCount = 16, frameIndex = 0) => ({ modality, frameCount, frameIndex, image: { columns: 192, rows: 128 } });

async function fixture(initial = image()) {
    const elements = new Map(), listeners = new Map(); let current = initial;
    const node = id => {
        if (!elements.has(id)) elements.set(id, { textContent: id === 'integration-status' ? 'Preparing embedded viewer…' : '', addEventListener() {} });
        return elements.get(id);
    };
    const viewer = { ready: Promise.resolve(), getState: () => current, on(type, callback) { listeners.set(type, callback); } };
    runInNewContext(source.slice(entry.length), { createViewer: () => viewer, document: { getElementById: node, querySelectorAll: () => [] } });
    await Promise.resolve();
    return { status: node('integration-status'), emit(type, state) { current = state; listeners.get(type)?.(state); } };
}

test('the public embedding sample reports its ready image without requiring an extra frame navigation', async () => {
    const f = await fixture();
    assert.equal(f.status.textContent, 'CT · Image 1 of 16 · 192 × 128');
});

test('source-only study changes update the public sample status and normal frame changes stay current', async () => {
    const f = await fixture();
    f.emit('sourcechange', image('US', 24));
    assert.equal(f.status.textContent, 'US · Image 1 of 24 · 192 × 128');
    f.emit('framechange', image('US', 24, 23));
    assert.equal(f.status.textContent, 'US · Image 24 of 24 · 192 × 128');
});

test('clearing the public sample source replaces stale image information and errors remain visible', async () => {
    const f = await fixture();
    f.emit('sourcechange', { image: null, frameCount: 0, frameIndex: 0 });
    assert.equal(f.status.textContent, 'Open a study or image.');
    f.emit('error', { message: 'Generated source could not be opened.' });
    assert.equal(f.status.textContent, 'Generated source could not be opened.');
});
