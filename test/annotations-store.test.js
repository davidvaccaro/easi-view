import test from 'node:test';
import assert from 'node:assert/strict';
import { AnnotationStore, ANNOTATION_SCHEMA, normalizeImageReference } from '../src/annotations/index.js';

const image = changes => ({ sopUid: '2.25.8001', frameNumber: 1, rows: 8, columns: 8,
    seriesUid: '2.25.8000', frameOfReferenceUid: '2.25.7000', ...changes });
const annotation = (id = 'a1', changes = {}) => ({ id, tool: 'rectangle', image: image(),
    points: [{ x: 1, y: 1 }, { x: 3, y: 4 }], ...changes });
const document = annotations => ({ schema: ANNOTATION_SCHEMA, version: 1, coordinateSystem: 'image-edge', frameNumberBase: 1, annotations });

test('store adds durable scoped annotations and isolates every input/output object', () => {
    const store = new AnnotationStore({ idFactory: () => 'generated-1' });
    const input = annotation(); delete input.id;
    const returned = store.add(input);
    assert.equal(returned.id, 'generated-1');
    input.points[0].x = 5; returned.points[1].x = 7;
    const fetched = store.get('generated-1'); fetched.image.sopUid = '2.25.99';
    assert.deepEqual(store.get('generated-1').points, [{ x: 1, y: 1 }, { x: 3, y: 4 }]);
    assert.equal(store.get('generated-1').image.sopUid, '2.25.8001');
    assert.equal(store.get('missing'), null);
    assert.equal(store.list(image()).length, 1); assert.equal(store.list(image({ frameNumber: 2 })).length, 0);
    const exported = store.export(); exported.annotations[0].points[0].y = 7;
    assert.equal(store.get('generated-1').points[0].y, 1);
});

test('add/update/remove undo and redo restore exact prior states without changing ids or source references', () => {
    const store = new AnnotationStore();
    store.add(annotation()); const added = store.exportJson();
    store.update('a1', { points: [{ x: 2, y: 2 }, { x: 5, y: 6 }] }); const changed = store.exportJson();
    store.remove('a1'); assert.equal(store.list().length, 0);
    assert.equal(store.undo(), true); assert.equal(store.exportJson(), changed);
    assert.equal(store.undo(), true); assert.equal(store.exportJson(), added);
    assert.equal(store.undo(), true); assert.equal(store.list().length, 0);
    assert.equal(store.undo(), false);
    assert.equal(store.redo(), true); assert.equal(store.exportJson(), added);
    assert.equal(store.redo(), true); assert.equal(store.exportJson(), changed);
    assert.equal(store.redo(), true); assert.equal(store.list().length, 0);
    assert.equal(store.redo(), false);
});

test('a new edit after undo discards redo history; clear itself remains reversible', () => {
    const store = new AnnotationStore();
    store.add(annotation('a1')); store.add(annotation('a2')); store.undo();
    assert.equal(store.canRedo, true);
    store.add(annotation('a3')); assert.equal(store.canRedo, false);
    assert.deepEqual(store.list().map(value => value.id), ['a1', 'a3']);
    store.clear(); assert.equal(store.list().length, 0);
    store.undo(); assert.deepEqual(store.list().map(value => value.id), ['a1', 'a3']);
    store.clearHistory(); assert.equal(store.canUndo, false); assert.equal(store.canRedo, false);
});

test('explicit schema v1 import/export preserves coordinates and only exports known model fields', () => {
    const source = new AnnotationStore(); source.add(annotation());
    const exported = source.export();
    assert.deepEqual(Object.keys(exported), ['schema', 'version', 'coordinateSystem', 'frameNumberBase', 'annotations']);
    assert.deepEqual(Object.keys(exported.annotations[0]), ['id', 'tool', 'image', 'points']);
    assert.deepEqual(JSON.parse(JSON.stringify(source)), exported);
    const target = new AnnotationStore(); assert.equal(target.import(source.exportJson()), 1);
    assert.deepEqual(target.export(), exported); assert.equal(target.canUndo, true);
    target.undo(); assert.equal(target.list().length, 0); target.redo(); assert.deepEqual(target.export(), exported);
});

test('import collisions and invalid later annotations are atomic, preserving both model and history', () => {
    const store = new AnnotationStore(); store.add(annotation('existing'));
    const before = store.exportJson(), history = store.getState();
    for (const annotations of [[annotation('new'), annotation('existing')],
        [annotation('new'), annotation('invalid', { points: [{ x: 0, y: 0 }, { x: 99, y: 99 }] })],
        [annotation('duplicate'), annotation('duplicate')]]) {
        assert.throws(() => store.import(document(annotations)), /collision|outside/);
        assert.equal(store.exportJson(), before); assert.deepEqual(store.getState(), history);
    }
    assert.equal(store.import(document([annotation('replacement')]), { mode: 'replace' }), 1);
    assert.equal(store.get('existing'), null); assert.ok(store.get('replacement'));
    store.undo(); assert.equal(store.exportJson(), before);
});

test('unknown PHI/host/pixel fields are rejected at every schema level before a commit', () => {
    const store = new AnnotationStore();
    for (const input of [
        { ...document([]), patientName: 'not-permitted' },
        document([{ ...annotation(), label: 'not-permitted' }]),
        document([{ ...annotation(), image: { ...image(), patientId: 'not-permitted' } }]),
        document([{ ...annotation(), points: [{ x: 1, y: 1, pixels: [10] }, { x: 3, y: 4 }] }]),
        JSON.parse('{"schema":"easi-view.annotations","version":1,"coordinateSystem":"image-edge","frameNumberBase":1,"annotations":[],"__proto__":{"polluted":true}}')
    ]) assert.throws(() => store.import(input), /unsupported fields/);
    assert.equal(store.list().length, 0); assert.equal(store.canUndo, false); assert.equal({}.polluted, undefined);
    assert.throws(() => store.add({ ...annotation(), samples: new Uint16Array(8) }), /unsupported fields/);
});

test('unknown versions, coordinate systems, zero-based frame numbers and malformed JSON fail explicitly', () => {
    const store = new AnnotationStore();
    for (const input of [
        { ...document([]), version: 2 }, { ...document([]), coordinateSystem: 'patient-mm' },
        { ...document([]), frameNumberBase: 0 }, document([annotation('a1', { image: image({ frameNumber: 0 }) })]),
        document([annotation('a1', { image: image({ frameNumber: 4097 }) })]), '{}', '{malformed'
    ]) assert.throws(() => store.import(input), /schema|frame number|JSON/);
    assert.throws(() => normalizeImageReference(image({ sopUid: '../../other' })), /DICOM UID/);
    assert.throws(() => store.import(document([]), { mode: 'append' }), /merge or replace/);
});

test('per-image and total count limits are strict across merge imports and original frame scopes', () => {
    const store = new AnnotationStore({ maxPerImage: 2, maxAnnotations: 3 });
    store.add(annotation('a1')); store.add(annotation('a2'));
    assert.throws(() => store.add(annotation('a3')), /per-image/);
    store.add(annotation('a3', { image: image({ frameNumber: 2 }) }));
    assert.equal(store.list(image()).length, 2); assert.equal(store.list(image({ frameNumber: 2 })).length, 1);
    assert.throws(() => store.import(document([annotation('a4', { image: image({ frameNumber: 3 }) })])), /count limit/);
    assert.equal(store.getState().count, 3);
});

test('conflicting geometry, series or Frame of Reference cannot share one SOP/original-frame scope', () => {
    const store = new AnnotationStore(); store.add(annotation('a1', { image: image({ geometryFingerprint: 'g1-12345678' }) }));
    for (const changed of [{ columns: 7 }, { seriesUid: '2.25.9000' }, { frameOfReferenceUid: '2.25.9001' }, { geometryFingerprint: 'g1-87654321' }]) {
        assert.throws(() => store.add(annotation('a2', { image: image(changed) })), /disagree/);
    }
    // An unspecified intermediate record must not hide a later contradiction.
    const bare = image(); delete bare.geometryFingerprint;
    store.add(annotation('a2', { image: bare }));
    assert.throws(() => store.add(annotation('a3', { image: image({ geometryFingerprint: 'g1-87654321' }) })), /disagree/);
});

test('serialized byte budget rejects edits/imports atomically including oversized whitespace input', () => {
    const store = new AnnotationStore({ maxBytes: 400 }); store.add(annotation('a1'));
    const before = store.exportJson();
    assert.ok(new TextEncoder().encode(before).byteLength <= 400);
    assert.throws(() => store.add(annotation('a2')), /byte limit/);
    assert.equal(store.exportJson(), before);
    assert.throws(() => store.import(' '.repeat(401) + document([])), /byte limit/);
    assert.throws(() => store.import(document([annotation('a2'), annotation('a3')]), { mode: 'replace' }), /byte limit/);
    assert.equal(store.exportJson(), before);
});

test('history count and serialized bytes stay bounded through undo/redo and edits', () => {
    const store = new AnnotationStore({ historyLimit: 2, historyBytes: 2000 });
    store.add(annotation('a1')); store.update('a1', { points: [{ x: 1, y: 1 }, { x: 4, y: 4 }] });
    store.update('a1', { points: [{ x: 1, y: 1 }, { x: 5, y: 5 }] });
    const state = store.getState(); assert.equal(state.historyCount, 2); assert.ok(state.historyBytes <= 2000);
    store.undo(); store.undo(); assert.equal(store.undo(), false); assert.ok(store.get('a1'));
    assert.equal(store.getState().historyCount, 2);
    const noHistory = new AnnotationStore({ historyBytes: 0 }); noHistory.add(annotation());
    assert.equal(noHistory.canUndo, false); assert.equal(noHistory.getState().historyBytes, 0);
});

test('invalid updates/removals and generated id collisions never add history or change durable records', () => {
    const store = new AnnotationStore({ idFactory: () => 'a1' }); store.add(annotation());
    const before = store.exportJson(), history = store.getState();
    for (const action of [() => store.add({ tool: 'length', image: image(), points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }),
        () => store.update('a1', { image: image({ frameNumber: 2 }) }), () => store.update('a1', { points: [{ x: 1, y: 1 }, { x: 1, y: 1 }] }),
        () => store.remove('missing')]) assert.throws(action, /collision|unsupported fields|degenerate|not found/);
    assert.equal(store.exportJson(), before); assert.deepEqual(store.getState(), history);
});

test('host observer failures are isolated and disposal releases listeners/model/history', async () => {
    const store = new AnnotationStore(), events = [];
    const unsubscribe = store.subscribe(event => events.push(event.type));
    store.subscribe(() => { throw new Error('observer'); }); store.subscribe(() => Promise.reject(new Error('observer')));
    store.add(annotation()); store.undo(); store.redo();
    assert.deepEqual(events, ['add', 'undo', 'redo']);
    unsubscribe(); store.remove('a1'); assert.equal(events.length, 3);
    await new Promise(resolve => setTimeout(resolve, 0));
    store.dispose(); store.dispose(); assert.equal(store.bytes, 0); assert.equal(store.canUndo, false);
    assert.equal(store._listeners.size, 0); assert.equal(store._items.size, 0);
    assert.throws(() => store.export(), /disposed/); assert.throws(() => store.add(annotation()), /disposed/);
});
