import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyContextCoordinator, MAX_CONTEXT_STACKS, MAX_CONTEXT_FRAMES } from '../src/integration/StudyContextCoordinator.js';

const archiveKey = 'synthetic-archive', clientA = {}, clientB = {};
const ref = (patch = {}) => ({ archiveKey, studyUid: '2.25.910', seriesUid: '2.25.911', sopUid: '2.25.912', ...patch });
const view = (patch = {}) => ({ slot: 0, reference: ref(), frameIndex: 17, originalFrameNumber: 6, window: { center: 40, width: 400 }, ...patch });
const context = (views = [view()], layout = views.length === 1 ? 1 : views.length === 2 ? 2 : 4) => ({ version: 1, layout, activeViewport: views[0].slot, viewports: views });
const descriptor = (originalFrameIndex, sopUid = '2.25.912') => ({ sopUid, frameIndex: originalFrameIndex, rows: 1, columns: 1, photometric: 'MONOCHROME2', samplesPerPixel: 1 });
const stack = (originalFrameIndices = [0, 5, 3], patch = {}) => ({ studyUid: '2.25.910', seriesUid: '2.25.911', _session: { client: clientA },
    frames: originalFrameIndices.map(index => descriptor(index)), disposed: false, ...patch });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture({ existing = [], loaded, load, list, decode, commit, release } = {}) {
    let current = clientA, visible = existing, previous = ['unchanged']; const requests = [], decodes = [], releases = [], commits = [];
    const coordinator = new StudyContextCoordinator({ getClient: () => current, getSeries: () => visible,
        async loadSeries(client, studyUid, seriesUid, options) { requests.push({ client, studyUid, seriesUid, signal: options.signal }); return load ? load(client, studyUid, seriesUid, options) : loaded ?? [stack()]; },
        async listSeries(client, studyUid, options) { requests.push({ type: 'query', client, studyUid, options }); return list ? list(client, studyUid, options) : { items: [{ studyUid, seriesUid: '2.25.911' }], hasMore: false }; },
        async getFrame(series, index, options) { decodes.push({ series, index, signal: options.signal }); return decode ? decode(series, index, options) : { ...series.frames[index], samples: Uint16Array.of(10 + series.frames[index].frameIndex) }; },
        async commit(value) { commits.push(value); if (commit) await commit(value); else { assert.equal(value.isCurrent(), true); previous = value.assignments; visible = [...visible, ...value.newSeries]; } },
        releaseSeries(series) { releases.push(series); if (release) return release(series); series.disposed = true; } });
    return { coordinator, requests, decodes, releases, commits, get previous() { return previous; }, get visible() { return visible; }, setClient(value) { current = value; }, setVisible(value) { visible = value; } };
}

test('prepare grouped full metadata once, select exact enhanced originals and decode only requested assignments before commit', async () => {
    const a = stack([0, 2, 4]), b = stack([7, 5, 3]), f = fixture({ loaded: [a, b] });
    const input = context([view(), view({ slot: 1, originalFrameNumber: 4, frameIndex: 99 })]);
    const result = await f.coordinator.apply(input, { archiveKey });
    assert.deepEqual(result, input); assert.equal(f.requests.length, 1); assert.deepEqual(f.decodes.map(call => call.index), [1, 2]);
    assert.ok(f.decodes.every(call => call.series === b)); assert.equal(f.commits.length, 1); assert.equal(f.commits[0].client, clientA);
    assert.deepEqual(f.commits[0].assignments.map(item => [item.slot, item.frame.frameIndex, item.frame.samples[0]]), [[0, 5, 15], [1, 3, 13]]);
    assert.deepEqual(f.commits[0].newSeries, [a, b]); assert.equal(f.releases.length, 0); f.coordinator.dispose(); assert.equal(f.releases.length, 0);
});
test('cached exact-client sources are borrowed and duplicate requested frames decode once across panes', async () => {
    const cached = stack(), foreign = stack([5], { _session: { client: clientB } }), local = stack([5], { _session: {} }), f = fixture({ existing: [foreign, local, cached] });
    await f.coordinator.apply(context([view(), view({ slot: 1 })]), { archiveKey });
    assert.equal(f.requests.length, 0); assert.equal(f.decodes.length, 1); assert.equal(f.decodes[0].series, cached); assert.deepEqual(f.commits[0].newSeries, []);
    assert.equal(f.commits[0].assignments[0].frame, f.commits[0].assignments[1].frame); assert.deepEqual(f.releases, []);
});
test('fresh full enhanced generation supersedes same-key cached groups before any pixel decode', async () => {
    const cached = stack([0]), freshA = stack([0, 2]), freshB = stack([5]), f = fixture({ existing: [cached], loaded: [freshA, freshB] });
    await f.coordinator.apply(context([view({ originalFrameNumber: 1 }), view({ slot: 1 }), view({ slot: 2, originalFrameNumber: 1 })], 4), { archiveKey });
    assert.equal(f.requests.length, 1); assert.deepEqual(f.decodes.map(call => call.series), [freshA, freshB]);
    assert.deepEqual(f.commits[0].assignments.map(item => item.series), [freshA, freshB, freshA]); assert.equal(cached.disposed, false);
});
test('all metadata references resolve before pixels; absent second target releases only new stacks', async () => {
    const loaded = stack(), borrowed = stack([1], { seriesUid: '2.25.913' }), f = fixture({ existing: [borrowed], loaded: [loaded] });
    await assert.rejects(f.coordinator.apply(context([view(), view({ slot: 1, originalFrameNumber: 100 })]), { archiveKey }), /absent/);
    assert.equal(f.decodes.length, 0); assert.equal(f.commits.length, 0); assert.deepEqual(f.releases, [loaded]); assert.equal(borrowed.disposed, false); assert.deepEqual(f.previous, ['unchanged']);
});
test('scope, archive address and original frame validation reject before any metadata/provider access', async () => {
    const f = fixture();
    for (const input of [context([view({ reference: ref({ archiveKey: 'foreign' }) })]), context([view({ reference: ref({ archiveKey: 'https://private.invalid' }) })]), context([view({ originalFrameNumber: 0 })])]) await assert.rejects(f.coordinator.apply(input, { archiveKey }));
    await assert.rejects(f.coordinator.apply(context([view(), view({ slot: 1, reference: ref({ sopUid: '2.25.999' }) })]), { archiveKey, scope: ref() }), /outside/);
    assert.equal(f.requests.length, 0); assert.equal(f.decodes.length, 0); assert.equal(f.commits.length, 0);
});
test('ambiguous enhanced references without original numbers, duplicate originals and foreign loaded scopes fail closed', async () => {
    for (const [loaded, changed] of [[[stack([0]), stack([1])], view({ frameIndex: 0, originalFrameNumber: undefined })],
        [[stack([5]), stack([5])], view()], [[stack([5], { studyUid: '2.25.999' })], view()], [[stack([5], { _session: { client: clientB } })], view()]]) {
        const f = fixture({ loaded }); await assert.rejects(f.coordinator.apply(context([changed]), { archiveKey }), /ambiguous|original frame|exact Study|ownership/);
        assert.equal(f.decodes.length, 0); assert.equal(f.commits.length, 0); assert.deepEqual(new Set(f.releases), new Set(loaded));
    }
});
test('latest apply cancels a non-cooperative metadata load and releases its late owned result exactly once', async () => {
    let finish, firstSignal, calls = 0; const late = stack(), latest = stack();
    const f = fixture({ load(_client, _study, _series, { signal }) { if (++calls === 1) { firstSignal = signal; return new Promise(resolve => finish = resolve); } return [latest]; } });
    const pending = f.coordinator.apply(context(), { archiveKey }), rejected = assert.rejects(pending, { name: 'AbortError' }); await tick();
    await f.coordinator.apply(context(), { archiveKey }); await rejected; assert.equal(firstSignal.aborted, true); assert.equal(f.commits.length, 1);
    finish([late, late]); await tick(); assert.deepEqual(f.releases, [late]); assert.equal(latest.disposed, false); assert.equal(f.decodes.length, 1);
});
test('external cancellation and disposal reject pending decode promptly without releasing borrowed sources', async () => {
    for (const dispose of [false, true]) {
        const borrowed = stack(); let finish, requestedSignal; const f = fixture({ existing: [borrowed], decode(_source, _index, { signal }) { requestedSignal = signal; return new Promise(resolve => finish = resolve); } });
        const abort = new AbortController(), pending = f.coordinator.apply(context(), { archiveKey, signal: abort.signal }), rejected = assert.rejects(pending, { name: 'AbortError' });
        await tick(); if (dispose) f.coordinator.dispose(); else abort.abort(); await rejected; assert.equal(requestedSignal.aborted, true); assert.equal(f.commits.length, 0); assert.deepEqual(f.releases, []);
        finish({ ...borrowed.frames[1], samples: Uint16Array.of(15) }); await tick(); assert.equal(f.commits.length, 0); assert.equal(borrowed.disposed, false);
        if (dispose) await assert.rejects(f.coordinator.apply(context(), { archiveKey }), /disposed/);
    }
});
test('client change during metadata and commit cannot publish or restore a foreign-client context', async () => {
    let finish; const loaded = stack(), f = fixture({ load: () => new Promise(resolve => finish = resolve) });
    const pending = f.coordinator.apply(context(), { archiveKey }); await tick(); f.setClient(clientB); finish([loaded]); await assert.rejects(pending, /archive client changed/);
    assert.deepEqual(f.releases, [loaded]); assert.equal(f.commits.length, 0);
    let g; const second = stack(); g = fixture({ loaded: [second], commit(value) { g.setClient(clientB); assert.equal(value.isCurrent(), false); assert.equal(value.signal.aborted, true); } });
    await assert.rejects(g.coordinator.apply(context(), { archiveKey }), /archive client changed/); assert.deepEqual(g.releases, [second]); assert.deepEqual(g.previous, ['unchanged']);
});
test('transactional commit rejection leaves prior panes and borrowed catalog intact and releases all newly owned sources', async () => {
    const borrowed = stack([0], { seriesUid: '2.25.914' }), a = stack([0, 2]), b = stack([5]);
    const f = fixture({ existing: [borrowed], loaded: [a, b], commit(value) { assert.equal(value.isCurrent(), true); assert.equal(value.assignments[0].frame.samples[0], 15); throw new Error('Synthetic renderer rollback.'); } });
    await assert.rejects(f.coordinator.apply(context(), { archiveKey }), /transactional pane commit failed/);
    assert.deepEqual(f.previous, ['unchanged']); assert.equal(borrowed.disposed, false); assert.deepEqual(f.releases, [a, b]);
});
test('canceled commit keeps staged sources alive and apply pending until asynchronous rollback completes', async () => {
    for (const cancellation of ['cancel', 'external', 'dispose']) {
        const loaded = stack(), borrowed = stack([0], { seriesUid: '2.25.914' }), controller = new AbortController();
        let finish, handedOff, settled = false, visible = borrowed;
        const f = fixture({ existing: [borrowed], loaded: [loaded], async commit(value) {
            handedOff = value; visible = loaded;
            await new Promise(resolve => finish = resolve);
            assert.equal(loaded.disposed, false, 'rollback must retain its staged source');
            assert.equal(borrowed.disposed, false, 'rollback must retain its previous source');
            visible = borrowed;
            throw new DOMException('Synthetic completed rollback.', 'AbortError');
        } });
        const pending = f.coordinator.apply(context(), { archiveKey, signal: controller.signal });
        pending.then(() => settled = true, () => settled = true);
        const rejected = assert.rejects(pending, { name: 'AbortError' }); await tick();
        assert.equal(handedOff.isCurrent(), true);
        if (cancellation === 'external') controller.abort();
        else if (cancellation === 'dispose') f.coordinator.dispose();
        else f.coordinator.cancel();
        await tick();
        assert.equal(handedOff.isCurrent(), false); assert.equal(handedOff.signal.aborted, true);
        assert.equal(settled, false); assert.deepEqual(f.releases, []); assert.equal(visible, loaded);
        finish(); await rejected;
        assert.equal(visible, borrowed); assert.equal(borrowed.disposed, false); assert.deepEqual(f.releases, [loaded]);
        assert.equal(f.commits.length, 1);
    }
});
test('client revocation during commit waits for host cleanup before releasing owned staged sources', async () => {
    const loaded = stack(); let finish, handedOff;
    const f = fixture({ loaded: [loaded], async commit(value) { handedOff = value; await new Promise(resolve => finish = resolve); } });
    let settled = false;
    const pending = f.coordinator.apply(context(), { archiveKey }); pending.catch(() => { settled = true; });
    const rejected = assert.rejects(pending, /archive client changed/); await tick();
    f.setClient(clientB); assert.equal(handedOff.isCurrent(), false); await tick();
    assert.equal(handedOff.signal.aborted, true); assert.equal(settled, false); assert.deepEqual(f.releases, []);
    finish(); await rejected; assert.deepEqual(f.releases, [loaded]); assert.deepEqual(f.previous, ['unchanged']);
});
test('atomic accept transfers ownership before a microtask cancellation and cannot drop displayed sources', async () => {
    const loaded = stack(), controller = new AbortController(); let visible;
    const f = fixture({ loaded: [loaded], commit(value) {
        assert.equal(value.isCurrent(), true); visible = value.assignments[0].series;
        value.accept(); queueMicrotask(() => controller.abort());
    } });
    const input = context(), result = await f.coordinator.apply(input, { archiveKey, signal: controller.signal });
    assert.deepEqual(result, input); assert.equal(controller.signal.aborted, true);
    assert.equal(visible, loaded); assert.equal(loaded.disposed, false); assert.deepEqual(f.releases, []);
    f.coordinator.dispose(); assert.deepEqual(f.releases, []);
});
test('abort before atomic accept rejects the handoff and waits for guarded rollback before dropping sources', async () => {
    const loaded = stack(), borrowed = stack([0], { seriesUid: '2.25.914' }), controller = new AbortController();
    let visible = borrowed, finish;
    const f = fixture({ existing: [borrowed], loaded: [loaded], async commit(value) {
        visible = loaded; controller.abort();
        assert.throws(value.accept, { name: 'AbortError' });
        await new Promise(resolve => finish = resolve); visible = borrowed;
        throw new DOMException('Synthetic completed rollback.', 'AbortError');
    } });
    const pending = f.coordinator.apply(context(), { archiveKey, signal: controller.signal }), rejected = assert.rejects(pending, { name: 'AbortError' });
    await tick(); assert.equal(visible, loaded); assert.equal(loaded.disposed, false); assert.deepEqual(f.releases, []);
    finish(); await rejected; assert.equal(visible, borrowed); assert.equal(borrowed.disposed, false); assert.deepEqual(f.releases, [loaded]);
});
test('a host failure after explicit acceptance surfaces without releasing transferred image ownership', async () => {
    const loaded = stack(), f = fixture({ loaded: [loaded], commit(value) { value.accept(); throw new Error('Synthetic final notification failure.'); } });
    await assert.rejects(f.coordinator.apply(context(), { archiveKey }), /transactional pane commit failed/);
    assert.equal(loaded.disposed, false); assert.deepEqual(f.releases, []); f.coordinator.dispose(); assert.deepEqual(f.releases, []);
});
test('study-only exploration lists one bounded page, tries no more than5 metadata series and fetches no unrelated pixels', async () => {
    const queried = Array.from({ length: 25 }, (_, index) => ({ studyUid: '2.25.910', seriesUid: `2.25.${920 + index}` })), successful = stack([5], { seriesUid: '2.25.923' });
    const f = fixture({ list: () => ({ items: queried, hasMore: true, nextOffset: 25 }), load(_client, _study, seriesUid) {
        if (seriesUid === '2.25.920') throw new Error('Unsupported synthetic structured report.');
        return seriesUid === '2.25.923' ? [successful] : [stack([0], { seriesUid })];
    } });
    await f.coordinator.apply(context([view({ reference: { archiveKey, studyUid: '2.25.910' }, frameIndex: 0, originalFrameNumber: undefined })]), { archiveKey });
    // The first compatible stack is enough; no subsequent metadata or pixels.
    assert.equal(f.requests[0].options.limit, 25); assert.equal(f.requests.filter(item => !item.type).length, 2); assert.equal(f.decodes.length, 1); assert.equal(f.decodes[0].series.seriesUid, '2.25.921');
    const noMatch = fixture({ list: () => ({ items: queried, hasMore: true }), load(_client, _study, seriesUid) { return [stack([0], { seriesUid })]; } });
    await assert.rejects(noMatch.coordinator.apply(context([view({ reference: { archiveKey, studyUid: '2.25.910' }, frameIndex: 2, originalFrameNumber: undefined })]), { archiveKey }), /first5/);
    assert.equal(noMatch.requests.filter(item => !item.type).length, 5); assert.equal(noMatch.decodes.length, 0); assert.equal(noMatch.releases.length, 5);
});
test('foreign Study, duplicate Series, invalid UID or oversized query pages reject before any series load', async () => {
    const one = { studyUid: '2.25.910', seriesUid: '2.25.920' };
    for (const items of [[{ ...one, studyUid: '2.25.999' }], [one, one], [{ ...one, seriesUid: 'https://private.invalid/pixels' }], Array(26).fill(one)]) {
        const f = fixture({ list: () => ({ items, hasMore: false }) });
        await assert.rejects(f.coordinator.apply(context([view({ reference: { archiveKey, studyUid: '2.25.910' }, frameIndex: 0, originalFrameNumber: undefined })]), { archiveKey }));
        assert.equal(f.requests.filter(item => !item.type).length, 0); assert.equal(f.decodes.length, 0);
    }
});
test('combined metadata stack and frame quotas apply before any selected pixel preparation', async () => {
    const tooMany = Array.from({ length: MAX_CONTEXT_STACKS + 1 }, (_, index) => stack([0], { seriesUid: `2.25.${1000 + index}` }));
    const first = fixture({ existing: tooMany }); await assert.rejects(first.coordinator.apply(context(), { archiveKey }), /stack list|combined metadata/); assert.equal(first.decodes.length, 0); assert.equal(first.releases.length, 0);
    const makeMany = (suffix, count) => stack([], { seriesUid: `2.25.${suffix}`, frames: Array.from({ length: count }, (_, index) => descriptor(0, `2.25.${suffix}.${index + 1}`)) });
    const a = makeMany(911, 5001), b = makeMany(911, 5000), frames = fixture({ loaded: [a, b] });
    await assert.rejects(frames.coordinator.apply(context(), { archiveKey }), /10000 frames/); assert.equal(frames.decodes.length, 0); assert.deepEqual(frames.releases, [a, b]);
    const oversized = stack([], { frames: Array.from({ length: MAX_CONTEXT_FRAMES + 1 }, () => descriptor(0)) }), third = fixture({ loaded: [oversized] });
    await assert.rejects(third.coordinator.apply(context(), { archiveKey }), /frame count/); assert.deepEqual(third.releases, [oversized]);
});
test('decoded identity/profile and grayscale-on-color mismatches fail before commit', async () => {
    for (const patch of [{ sopUid: '2.25.999' }, { frameIndex: 0 }, { studyUid: '2.25.999' }, { columns: 2, samples: Uint16Array.of(1, 2) },
        { photometric: 'RGB', samplesPerPixel: 3, samples: Uint8Array.of(1, 2, 3) }]) {
        const source = stack(), f = fixture({ loaded: [source], decode: (series, index) => ({ ...series.frames[index], samples: Uint16Array.of(15), ...patch }) });
        await assert.rejects(f.coordinator.apply(context(), { archiveKey }), /identity|profile|grayscale/); assert.equal(f.commits.length, 0); assert.deepEqual(f.releases, [source]);
    }
    const color = stack([5], { frames: [{ ...descriptor(5), photometric: 'RGB', samplesPerPixel: 3 }] }), f = fixture({ loaded: [color], decode: series => ({ ...series.frames[0], samples: Uint8Array.of(1, 2, 3) }) });
    await assert.rejects(f.coordinator.apply(context(), { archiveKey }), /color context/); assert.equal(f.commits.length, 0);
});
test('new stack duplication releases each object once and release failures cannot skip other owned cleanup', async () => {
    const duplicate = stack(), repeated = fixture({ loaded: [duplicate, duplicate] }); await assert.rejects(repeated.coordinator.apply(context(), { archiveKey }), /duplicated/); assert.deepEqual(repeated.releases, [duplicate]);
    const a = stack([0]), b = stack([1]), release = fixture({ loaded: [a, b], release() { throw new Error('Synthetic release rejection'); } });
    await assert.rejects(release.coordinator.apply(context(), { archiveKey }), /absent/); assert.deepEqual(release.releases, [a, b]);
});
test('input is detached, providers see only validated client/UID/signal arguments and no network is initiated by coordinator', async () => {
    const loaded = stack(); let finish; const f = fixture({ load: () => new Promise(resolve => finish = resolve) }), input = context();
    const originalFetch = globalThis.fetch; globalThis.fetch = () => { throw new Error('Coordinator must not fetch addresses itself.'); };
    try {
        const pending = f.coordinator.apply(input, { archiveKey }); await tick(); input.viewports[0].reference.sopUid = '2.25.999'; input.viewports[0].window.center = 999;
        finish([loaded]); const result = await pending; assert.equal(result.viewports[0].reference.sopUid, '2.25.912'); assert.equal(result.viewports[0].window.center, 40);
        assert.equal(f.requests[0].client, clientA); assert.equal(f.requests[0].studyUid, '2.25.910'); assert.equal(f.requests[0].seriesUid, '2.25.911'); assert.ok(f.requests[0].signal instanceof AbortSignal);
        assert.ok(!/url|samples|rgba|patient/iu.test(JSON.stringify(result)));
    } finally { globalThis.fetch = originalFetch; }
});
test('pre-cancel, disposed coordinator, invalid callbacks and observer options fail without provider work', async () => {
    const f = fixture(), controller = new AbortController(); controller.abort(); await assert.rejects(f.coordinator.apply(context(), { archiveKey, signal: controller.signal }), { name: 'AbortError' });
    assert.equal(f.requests.length, 0); f.coordinator.dispose(); await assert.rejects(f.coordinator.apply(context(), { archiveKey }), /disposed/);
    assert.throws(() => new StudyContextCoordinator({ getClient() {}, onChange() {} }), TypeError);
});
