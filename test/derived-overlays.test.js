import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImageReference } from '../src/annotations/model.js';
import { OverlayStore, renderOverlayRgba } from '../src/derived/index.js';
import { sourceFrame } from './derived-fixtures.js';

const overlay = (frame, changes = {}) => ({ id: 'mask-1', image: createImageReference(frame), kind: 'binary', values: Uint8Array.from([1, 0, 1]),
    opacity: 0.5, color: [200, 0, 0], ...changes });

test('overlay store owns masks independently of every input/output and never changes original image samples', async () => {
    const frame = sourceFrame(), input = overlay(frame), store = new OverlayStore();
    const added = store.add(input); input.values[0] = 0; input.image.frameNumber = 99; added.values[2] = 0;
    assert.deepEqual([...store.get('mask-1').values], [1, 0, 1]);
    assert.equal(store.get('mask-1').image.frameNumber, 1);
    assert.deepEqual([...frame.samples], [10, 11, 12]);
    const output = await store.render(frame);
    assert.deepEqual([...output.rgba], [200, 0, 0, 128, 0, 0, 0, 0, 200, 0, 0, 128]);
    assert.equal(store.listDescriptors()[0].values, undefined); store.dispose();
});

test('style updates share owned mask allocation, return style metadata and validate explicit invalid values', () => {
    const frame = sourceFrame(), store = new OverlayStore(); store.add(overlay(frame));
    const buffer = store._items.get('mask-1').values.buffer; // Resource ownership invariant, not rendered sample expectation.
    const style = store.updateStyle('mask-1', { color: [0, 0, 255], opacity: 0.25 });
    assert.deepEqual(style, { id: 'mask-1', color: [0, 0, 255], opacity: 0.25 });
    assert.equal(store._items.get('mask-1').values.buffer, buffer); assert.equal(store.getState().count, 1);
    for (const changes of [{ opacity: null }, { opacity: 2 }, { color: [0, 0, 999] }, { values: [0, 0, 0] }]) assert.throws(() => store.updateStyle('mask-1', changes));
    assert.equal(store.get('mask-1').opacity, 0.25); store.dispose();
});

test('Float32 probability masks retain their explicit probability semantics and normalized opacity', async () => {
    const frame = sourceFrame(), store = new OverlayStore();
    store.add(overlay(frame, { kind: 'probability', values: Float32Array.from([0, 0.5, 1]), fractionalType: 'PROBABILITY' }));
    const samples = store.get('mask-1').values; assert.ok(samples instanceof Float32Array); assert.deepEqual([...samples], [0, 0.5, 1]);
    const output = await store.render(frame, { alphaMode: 'premultiplied' });
    assert.deepEqual([...output.rgba], [0, 0, 0, 0, 50, 0, 0, 64, 100, 0, 0, 128]); store.dispose();
});

test('overlapping color masks composite in explicit list order with declared straight/premultiplied alpha', async () => {
    const frame = sourceFrame();
    const items = [overlay(frame, { values: Uint8Array.of(1, 1, 1), color: [255, 0, 0] }),
        overlay(frame, { id: 'mask-2', values: Uint8Array.of(1, 1, 1), color: [0, 0, 255] })];
    const straight = await renderOverlayRgba(items, frame), premultiplied = await renderOverlayRgba(items, frame, { alphaMode: 'premultiplied' });
    assert.deepEqual([...straight.rgba].slice(0, 4), [85, 0, 170, 191]);
    assert.deepEqual([...premultiplied.rgba].slice(0, 4), [64, 0, 128, 191]);
    assert.deepEqual([...frame.samples], [10, 11, 12]);
});

test('wrong SOP/original frame or changed exact geometry cannot render a mask', async () => {
    const frame = sourceFrame(), item = overlay(frame);
    for (const changed of [{ ...frame, sopUid: '2.25.999' }, { ...frame, frameIndex: 1 }, { ...frame, pixelSpacing: [1, 1] }]) {
        await assert.rejects(renderOverlayRgba([item], changed), /annotation does not belong/);
    }
    const store = new OverlayStore(); store.add(item);
    assert.throws(() => store.add(overlay(frame, { id: 'other', image: { ...item.image, columns: 1 }, values: Uint8Array.of(1) })), /disagree about source/);
    store.dispose();
});

test('overlay schema JSON roundtrips exact scoped values, rejects collisions atomically and exports no source pixels/patient fields', () => {
    const frame = sourceFrame(), store = new OverlayStore(); store.add(overlay(frame));
    const saved = store.exportJson(), model = JSON.parse(saved), restored = new OverlayStore(); restored.import(saved);
    assert.deepEqual(restored.export(), model); assert.equal(model.frameNumberBase, 1);
    assert.equal(saved.includes('samples'), false); assert.equal(saved.includes('patient'), false);
    const previous = restored.exportJson(); assert.throws(() => restored.import(model), /collision/); assert.equal(restored.exportJson(), previous);
    const invalid = structuredClone(model); invalid.overlays[0].id = 'new'; invalid.overlays.push({ ...invalid.overlays[0], id: 'bad', values: [0, 2, 0] });
    assert.throws(() => restored.import(invalid), /semantics/); assert.equal(restored.exportJson(), previous);
    assert.equal(restored.import(model, { mode: 'replace' }), 1); store.dispose(); restored.dispose();
});

test('unknown patient, host, source-pixel and nested semantic fields reject before a store mutation', () => {
    const frame = sourceFrame(), store = new OverlayStore();
    for (const changed of [{ patientName: 'forbidden' }, { sourceUrl: 'forbidden' }, { samples: [10, 11, 12] }]) assert.throws(() => store.add(overlay(frame, changed)), /unsupported overlay fields/);
    assert.throws(() => store.add(overlay(frame, { image: { ...createImageReference(frame), patientId: 'forbidden' } })));
    assert.throws(() => store.add(overlay(frame, { geometry: { rows: 1, columns: 3, frameOfReferenceUid: frame.frameOfReferenceUid,
        position: frame.position, orientation: frame.orientation, pixelSpacing: frame.pixelSpacing, patientName: 'forbidden' } })));
    assert.equal(store.getState().count, 0); store.dispose();
});

test('invalid mask values/maximum/fraction type, byte/count budgets and export expansion fail explicitly', () => {
    const frame = sourceFrame(), store = new OverlayStore();
    for (const changes of [{ values: [1, 2, 0] }, { kind: 'probability', values: [0, Infinity, 1] },
        { kind: 'fractional', values: [0, 100, 201], maximum: 200, fractionalType: 'PROBABILITY' },
        { kind: 'fractional', values: [0, 1, 2], maximum: 200, fractionalType: 'UNKNOWN' }]) assert.throws(() => store.add(overlay(frame, changes)));
    const small = new OverlayStore({ maxBytes: 2 }); assert.throws(() => small.add(overlay(frame)), /byte budget/); assert.equal(small.getState().count, 0);
    const limited = new OverlayStore({ maxRecords: 1 }); limited.add(overlay(frame));
    assert.throws(() => limited.add(overlay(frame, { id: 'second' })), /count or byte/);
    store.add(overlay(frame)); assert.throws(() => store.exportJson({ maxBytes: 10 }), /export byte budget/);
    store.dispose(); small.dispose(); limited.dispose();
});

test('rendering validates budgets before copying inputs and canceled/disposed work never returns a partial RGBA', async () => {
    const frame = sourceFrame(), items = [overlay(frame)];
    await assert.rejects(renderOverlayRgba(items, frame, { maxBytes: 11 }), /rendering budget/);
    const controller = new AbortController(), pending = renderOverlayRgba(items, frame, { signal: controller.signal }); controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    const store = new OverlayStore(); store.add(items[0]); const disposed = store.render(frame); store.dispose(); await assert.rejects(disposed, /disposed/);
    assert.throws(() => store.get('mask-1'), /disposed/);
});

test('fixed count/byte observer payloads isolate host errors and unsubscribe/dispose release lifecycle callbacks', async () => {
    const frame = sourceFrame(), store = new OverlayStore(), events = [];
    const unsubscribe = store.subscribe(event => { events.push(event); return Promise.reject(new Error('optional observer')); });
    store.add(overlay(frame)); assert.deepEqual(Object.keys(events[0]).sort(), ['bytes', 'count']);
    assert.equal(store.remove('mask-1'), true); assert.equal(store.remove('mask-1'), false);
    unsubscribe(); store.add(overlay(frame)); assert.equal(events.length, 2); store.dispose(); store.dispose();
    await new Promise(resolve => setTimeout(resolve, 0));
});
