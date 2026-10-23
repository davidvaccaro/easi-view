import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadingProtocolCoordinator } from '../src/protocols/ReadingProtocolCoordinator.js';
import { evaluateReadingProtocol, getDefaultReadingProtocols } from '../src/protocols/index.js';
import { loadFiles } from '../src/data/sources.js';
import { createDicomFixture } from '../src/data/synthetic.js';
import EASI from '@xinonix/easi-js';
import { loadArchiveSeries } from '../src/data/archive-source.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const original = index => ({ sopUid: `2.25.721.${index + 1}`, studyUid: '2.25.720', seriesUid: '2.25.721', frameIndex: index,
    rows: 1, columns: 2, photometric: 'MONOCHROME2', samplesPerPixel: 1, bitsAllocated: 16, bitsStored: 12, highBit: 11,
    signed: true, modality: 'CT', slope: -2, intercept: 10, unit: 'HU', voiFunction: 'LINEAR', presentationInvert: false,
    position: [0, 0, index * 2], orientation: [1, 0, 0, 0, 1, 0], pixelSpacing: [0.5, 0.8] });
const series = (patch = {}) => ({ frames: [0, 1, 2].map(original), disposed: false, dispose() { this.disposed = true; }, ...patch });
const ctPlan = (frameIndex = 1) => {
    const protocol = getDefaultReadingProtocols().find(protocol => protocol.id === 'ct-dual-window');
    return evaluateReadingProtocol(protocol, [{ index: 0, role: 'current', modality: 'CT', photometric: 'MONOCHROME2', unit: 'HU', frameCount: 3 },
        { index: 1, role: 'current', modality: 'MR', photometric: 'MONOCHROME2', unit: '', frameCount: 3 }], { selectedIndex: 0, activeFrames: { 0: frameIndex } });
};
const planFor = (indices = [0, 1], { window = null, unit = null } = {}) => ({ version: 1, protocolId: 'synthetic-comparison', layout: indices.length,
    links: { scroll: false, window: false, camera: false }, status: 'ready',
    selectors: [...new Set(indices)].map(index => ({ id: `stack-${index}`, status: 'matched', matchedIndex: index,
        candidates: [{ index, eligible: true, score: 1, reasonCodes: [] }], reasonCodes: ['unique-best-match'], manual: false })),
    slots: indices.map((candidateIndex, id) => ({ id, selector: `stack-${candidateIndex}`, status: 'ready', candidateIndex, frameIndex: 1,
        window, windowUnit: unit, reasonCodes: ['unique-best-match'] })) });
function fixture({ sources = [series(), series()], getFrame, holdFrame, commit, onChange } = {}) {
    let catalog = sources, revision = 0, client = {}, visible = ['previous'];
    const requests = [], holds = [], releases = [], commits = [], events = [], retained = new Set();
    const coordinator = new ReadingProtocolCoordinator({ getSeries: () => catalog, getRevision: () => revision, getClient: () => client,
        getFrame(source, index, options) { requests.push({ source, index, signal: options.signal }); return getFrame ? getFrame(source, index, options) : { ...source.frames[index], samples: Int16Array.of(-4, 7) }; },
        holdFrame(frame, options) {
            holds.push(frame);
            if (holdFrame) return holdFrame(frame, options);
            retained.add(frame); let released = false;
            return () => { assert.equal(released, false); released = true; retained.delete(frame); releases.push(frame); };
        },
        async commit(value) { commits.push({ ...value, assignments: value.assignments.map(assignment => ({ ...assignment })) }); if (commit) return commit(value); assert.equal(value.isCurrent(), true); visible = value.assignments.map(assignment => assignment.frame); value.accept(); },
        onChange(value) { events.push(value); return onChange?.(value); } });
    return { coordinator, sources, requests, holds, releases, commits, events, retained,
        get visible() { return visible; }, setCatalog(value) { catalog = value; }, setRevision(value) { revision = value; }, setClient(value) { client = value; } };
}

test('actual planner CT dual-window output prepares one exact original once and never mutates stored values', async () => {
    const f = fixture(), input = ctPlan(), result = await f.coordinator.apply(input);
    assert.deepEqual(result, input); assert.ok(Object.isFrozen(result)); assert.notEqual(result, input);
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0].source, f.sources[0]); assert.equal(f.requests[0].index, 1);
    const [first, second] = f.commits[0].assignments;
    assert.equal(first.frame, second.frame); assert.deepEqual([...first.frame.samples], [-4, 7]); assert.equal(first.frame.slope, -2);
    assert.deepEqual(first.view.window, { center: 40, width: 400 }); assert.deepEqual(second.view.window, { center: -600, width: 1500 });
    assert.equal(first.frame.frameIndex, 1); assert.equal(first.frame.sopUid, '2.25.721.2'); assert.deepEqual(f.holds, f.releases);
    assert.equal(f.retained.size, 0); assert.equal(f.sources.some(source => source.disposed), false);
    assert.deepEqual(f.coordinator.getState(), { disposed: false, busy: false, preparing: false, committing: false, preparedFrames: 0, preparedBytes: 0, assignmentCount: 0 });
});

test('only selected distinct stack/frame requests run and no coordinator fetch, unrelated decode or source disposal occurs', async () => {
    const f = fixture(), oldFetch = globalThis.fetch;
    globalThis.fetch = () => { throw Error('No implicit network'); };
    try {
        await f.coordinator.apply(planFor([1, 1, 0, 1]));
        assert.deepEqual(f.requests.map(request => [f.sources.indexOf(request.source), request.index]), [[1, 1], [0, 1]]);
        assert.equal(f.holds.length, 2); assert.equal(f.commits[0].assignments.length, 4);
        assert.equal(f.commits[0].assignments[0].frame, f.commits[0].assignments[3].frame);
        await f.coordinator.dispose(); assert.equal(f.sources.some(source => source.disposed), false);
    } finally { globalThis.fetch = oldFetch; }
});

test('all selections resolve before decoding and unresolved, unavailable or mismatched plans preserve a running operation', async () => {
    const wait = deferred(), f = fixture({ getFrame: () => wait.promise }), running = f.coordinator.apply(ctPlan()); await tick();
    for (const mutate of [input => input.status = 'unresolved', input => input.slots[1].status = 'ambiguous',
        input => input.slots[1].candidateIndex = 9, input => input.slots[1].frameIndex = 99,
        input => input.slots[1].id = 0, input => input.layout = 4]) {
        const input = structuredClone(ctPlan()); mutate(input); await assert.rejects(f.coordinator.apply(input));
    }
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0].signal.aborted, false);
    wait.resolve({ ...f.sources[0].frames[1], samples: Int16Array.of(-4, 7) }); await running;
    const invalid = planFor([0, 1]); invalid.slots[1].frameIndex = 99;
    const g = fixture(); await assert.rejects(g.coordinator.apply(invalid), /not already loaded/u); assert.equal(g.requests.length, 0);
});

test('supersession promptly cancels noncooperative preparation and its late result cannot pin or commit', async () => {
    const wait = deferred(); let calls = 0;
    const f = fixture({ getFrame(source, index) { return ++calls === 1 ? wait.promise : { ...source.frames[index], samples: Int16Array.of(3, 5) }; } });
    const first = f.coordinator.apply(ctPlan()), rejected = assert.rejects(first, { name: 'AbortError' }); await tick();
    await f.coordinator.apply(ctPlan(2)); await rejected;
    assert.equal(f.requests[0].signal.aborted, true); assert.equal(f.commits.length, 1); assert.equal(f.holds.length, 1);
    wait.resolve({ ...f.sources[0].frames[1], samples: Int16Array.of(99, 100) }); await tick();
    assert.equal(f.holds.length, 1); assert.equal(f.commits.length, 1); assert.deepEqual([...f.visible[0].samples], [3, 5]);
});

test('external abort, cancel and dispose stop stalled preparation promptly with no held pixels or borrowed-source disposal', async () => {
    for (const reason of ['external', 'cancel', 'dispose']) {
        const wait = deferred(), controller = new AbortController(), f = fixture({ getFrame: () => wait.promise });
        const pending = f.coordinator.apply(ctPlan(), { signal: controller.signal }), rejected = assert.rejects(pending, { name: 'AbortError' }); await tick();
        if (reason === 'external') controller.abort(); else if (reason === 'cancel') await f.coordinator.cancel(); else await f.coordinator.dispose();
        await rejected; assert.equal(f.requests[0].signal.aborted, true); assert.equal(f.holds.length, 0); assert.equal(f.commits.length, 0);
        wait.resolve({ ...f.sources[0].frames[1], samples: Int16Array.of(8, 9) }); await tick();
        assert.equal(f.coordinator.getState().busy, false); assert.equal(f.sources.some(source => source.disposed), false);
        if (reason === 'dispose') await assert.rejects(f.coordinator.apply(ctPlan()), /disposed/u);
    }
});

test('source epoch, client, selected descriptor mutation and exact catalog replacement are checked after preparation', async () => {
    for (const change of [f => f.setRevision(1), f => f.setClient(null), f => f.setCatalog([series(), ...f.sources.slice(1)]),
        f => f.sources[0].frames[1].sopUid = '2.25.999', f => f.sources[0].frames[1].orientation[0] = 0.5,
        f => f.sources[0].disposed = true]) {
        const wait = deferred(), f = fixture({ getFrame: () => wait.promise });
        const frame = { ...f.sources[0].frames[1], orientation: [...f.sources[0].frames[1].orientation], samples: Int16Array.of(8, 9) };
        const pending = f.coordinator.apply(ctPlan()); await tick(); change(f); wait.resolve(frame);
        await assert.rejects(pending, /source or connection changed/u); assert.equal(f.commits.length, 0); assert.equal(f.holds.length, 0);
    }
});

test('decoded original identity, geometry, rescale and scalar layout mismatches fail before admission or commit', async () => {
    for (const patch of [{ sopUid: '2.25.999' }, { frameIndex: 2 }, { studyUid: '2.25.998' }, { seriesUid: '2.25.997' },
        { position: [0, 0, 99] }, { pixelSpacing: [1, 1] }, { slope: 1 }, { intercept: 0 }, { samples: Float32Array.of(1, 2) },
        { samples: Int16Array.of(1) }, { samplesPerPixel: 3 }]) {
        const f = fixture({ getFrame(source, index) { return { ...source.frames[index], samples: Int16Array.of(-4, 7), ...patch }; } });
        await assert.rejects(f.coordinator.apply(ctPlan()), /metadata differs|sample layout/u);
        assert.equal(f.holds.length, 0); assert.equal(f.commits.length, 0);
    }
});

test('native acquisition scope can fill omitted metadata but cannot alter supplied families or current-source snapshots', async () => {
    const initial = { semanticScope: 'same-series-only', invalid: false, spatialEligible: true, effectiveEchoTime: null, echoNumbers: [], imageType: [] };
    const enriched = { ...initial, semanticScope: 'classic-exposed-dimensions', effectiveEchoTime: 25, echoNumbers: [1], imageType: ['ORIGINAL', 'PRIMARY', 'M'] };
    const source = series(); source.frames[1].classicDimensions = initial;
    const f = fixture({ sources: [source], getFrame(_source, index) { return { ...source.frames[index], classicDimensions: enriched, samples: Int16Array.of(1, 2) }; } });
    await f.coordinator.apply(planFor([0])); assert.deepEqual(f.commits[0].assignments[0].frame.classicDimensions, enriched);
    for (const patch of [{ effectiveEchoTime: 26 }, { echoNumbers: [2] }, { invalid: true }, { imageType: ['DERIVED', 'PRIMARY', 'M'] }]) {
        const source = series(); source.frames[1].classicDimensions = enriched;
        const f = fixture({ sources: [source], getFrame(_source, index) { return { ...source.frames[index], classicDimensions: { ...enriched, ...patch }, samples: Int16Array.of(1, 2) }; } });
        await assert.rejects(f.coordinator.apply(planFor([0])), /metadata differs/u); assert.equal(f.commits.length, 0);
    }
    const wait = deferred(), changed = series(); changed.frames[1].classicDimensions = { ...initial };
    const g = fixture({ sources: [changed], getFrame: () => wait.promise }), pending = g.coordinator.apply(planFor([0])); await tick();
    changed.frames[1].classicDimensions.effectiveEchoTime = 25;
    wait.resolve({ ...changed.frames[1], samples: Int16Array.of(1, 2) });
    await assert.rejects(pending, /source or connection changed/u); assert.equal(g.holds.length, 0);
});

test('real published-EASI archive decode preserves an exact selected original while enriching optional classic acquisition metadata', async () => {
    const tuple = (vr, ...Value) => ({ vr, Value });
    const data = {
        '00080016': tuple('UI', '1.2.840.10008.5.1.4.1.1.2'), '00080018': tuple('UI', '2.25.730.1'), '00080060': tuple('CS', 'CT'),
        '0020000D': tuple('UI', '2.25.730'), '0020000E': tuple('UI', '2.25.731'), '00200013': tuple('IS', 1),
        '00200032': tuple('DS', 0, 0, 0), '00200037': tuple('DS', 1, 0, 0, 0, 1, 0),
        '00280002': tuple('US', 1), '00280004': tuple('CS', 'MONOCHROME2'), '00280008': tuple('IS', 1),
        '00280010': tuple('US', 2), '00280011': tuple('US', 2), '00280030': tuple('DS', 0.75, 0.75),
        '00280100': tuple('US', 16), '00280101': tuple('US', 16), '00280102': tuple('US', 15), '00280103': tuple('US', 0),
        '00281052': tuple('DS', 0), '00281053': tuple('DS', 1), '00281054': tuple('LO', 'HU'), '00281056': tuple('CS', 'LINEAR'),
        '7FE00010': { vr: 'OW', BulkDataURI: '../synthetic-pixels-not-followed' }
    };
    const instance = (await EASI.pipelineBuilder().fromByteStream().ofDicomMetadata().toInstances().build().process({ source: new TextEncoder().encode(JSON.stringify([data])) })).first();
    const native = createDicomFixture({ sopUid: '2.25.730.1', seriesUid: '2.25.731', values: [2, 4, 8, 12], extraAttributes: {
        '0020000D': ['UI', '2.25.730'], '00180081': ['DS', 25], '00180086': ['IS', 1] } });
    let reads = 0, committed;
    const client = { async getSeriesMetadata() { return [instance]; }, async retrieveInstance() { reads++; return new Response(native, { headers: { 'content-type': 'application/dicom' } }); } };
    const sources = await loadArchiveSeries(client, '2.25.730', '2.25.731'), source = sources[0];
    const coordinator = new ReadingProtocolCoordinator({ getSeries: () => sources, getRevision: () => 0, getClient: () => client,
        getFrame: (series, index, options) => series.getFrame(index, options), holdFrame: () => () => {}, commit(value) { committed = value.assignments[0].frame; value.accept(); } });
    try {
        assert.equal(source.frames[0].classicDimensions.semanticScope, 'same-series-only');
        const input = planFor([0], { window: { center: 40, width: 400 }, unit: 'HU' }); input.slots[0].frameIndex = 0;
        await coordinator.apply(input); assert.equal(reads, 1); assert.equal(committed.sopUid, '2.25.730.1'); assert.deepEqual([...committed.samples], [2, 4, 8, 12]);
        assert.equal(committed.classicDimensions.semanticScope, 'classic-exposed-dimensions'); assert.equal(committed.classicDimensions.effectiveEchoTime, 25);
        assert.deepEqual(committed.classicDimensions.echoNumbers, [1]); assert.equal(source.frames[0].classicDimensions.effectiveEchoTime, null);
    } finally { await coordinator.dispose(); sources.forEach(source => source.dispose()); }
});

test('declared LUT headers and complete table entries match exactly while pending tables can resolve', async () => {
    const table = { count: 2, firstMapped: 0, bits: 16, unit: 'HU', entries: Uint16Array.of(100, 200) };
    for (const patch of [{ bits: 8 }, { entries: Uint16Array.of(100, 201) }]) {
        const source = series(); source.frames[1].modalityLut = table;
        const f = fixture({ sources: [source], getFrame(_source, index) { return { ...source.frames[index], samples: Int16Array.of(0, 1), modalityLut: { ...table, ...patch } }; } });
        await assert.rejects(f.coordinator.apply(planFor([0])), /metadata differs/u); assert.equal(f.holds.length, 0);
    }
    const source = series(); source.frames[1].modalityLut = { ...table, entries: null, pending: true };
    const f = fixture({ sources: [source], getFrame(_source, index) { return { ...source.frames[index], samples: Int16Array.of(0, 1), modalityLut: table }; } });
    await f.coordinator.apply(planFor([0])); assert.equal(f.commits.length, 1);
});

test('explicit unit windows reject color, palette and unknown/mismatched units without fabricating HU', async () => {
    for (const patch of [{ photometric: 'RGB', samplesPerPixel: 3 }, { photometric: 'PALETTE COLOR', samplesPerPixel: 1 }, { unit: '' }, { unit: 'hu' }]) {
        const source = series(); Object.assign(source.frames[1], patch);
        const f = fixture({ sources: [source], getFrame(_source, index) { return { ...source.frames[index], samples: source.frames[index].photometric === 'RGB' ? Uint8Array.of(1, 2, 3, 4, 5, 6) : Int16Array.of(1, 2) }; } });
        await assert.rejects(f.coordinator.apply(planFor([0], { window: { center: 40, width: 400 }, unit: 'HU' })), /declared grayscale intensity unit/u);
        assert.equal(f.commits.length, 0);
    }
    const source = series(); source.frames[1].modality = 'MR'; source.frames[1].unit = '';
    const f = fixture({ sources: [source] }); await f.coordinator.apply(planFor([0], { window: { center: 12, width: 20 }, unit: null }));
    assert.equal(f.commits[0].assignments[0].frame.unit, ''); assert.equal(f.commits[0].assignments[0].frame.modality, 'MR');
});

test('admission failure releases prior pins, never commits and sanitizes provider errors', async () => {
    const released = []; let calls = 0;
    const f = fixture({ holdFrame(frame) { if (++calls === 2) throw Error('Secret patient token'); return () => released.push(frame); } });
    await assert.rejects(f.coordinator.apply(planFor()), error => /admission failed/u.test(error.message) && !error.message.includes('Secret'));
    assert.equal(released.length, 1); assert.equal(f.commits.length, 0); assert.equal(f.coordinator.getState().preparedBytes, 0);
    const g = fixture({ getFrame() { throw Error('Secret URL credential'); } });
    await assert.rejects(g.coordinator.apply(ctPlan()), error => /preparation failed/u.test(error.message) && !/Secret|URL|credential/u.test(error.message));
});

test('cancel during commit holds prepared frames and remains pending until rollback is complete', async () => {
    for (const cancel of ['external', 'cancel', 'dispose']) {
        const rollback = deferred(), controller = new AbortController(); let commit, settled = false, visible = 'old';
        const f = fixture({ async commit(value) { commit = value; visible = 'staged'; await rollback.promise; visible = 'old'; } });
        const pending = f.coordinator.apply(ctPlan(), { signal: controller.signal }); pending.then(() => settled = true, () => settled = true);
        const rejected = assert.rejects(pending, { name: 'AbortError' }); await tick(); assert.equal(visible, 'staged');
        let cleanup; if (cancel === 'external') controller.abort(); else cleanup = f.coordinator[cancel]();
        await tick(); assert.equal(commit.signal.aborted, true); assert.equal(commit.isCurrent(), false); assert.equal(settled, false);
        assert.equal(f.retained.size, 1); assert.equal(f.releases.length, 0); assert.equal(f.coordinator.getState().committing, true);
        rollback.resolve(); await rejected; await cleanup; assert.equal(visible, 'old'); assert.equal(f.retained.size, 0); assert.equal(f.releases.length, 1);
    }
});

test('revocation detected inside commit aborts, forbids acceptance and waits for protected rollback', async () => {
    const rollback = deferred(); let commit, f, done = false;
    f = fixture({ async commit(value) { commit = value; await rollback.promise; } });
    const pending = f.coordinator.apply(ctPlan()); pending.catch(() => done = true); await tick(); f.setClient(null);
    assert.equal(commit.isCurrent(), false); assert.equal(commit.signal.aborted, true); assert.throws(commit.accept, /source or connection changed/u);
    await tick(); assert.equal(done, false); assert.equal(f.releases.length, 0);
    rollback.resolve(); await assert.rejects(pending, /source or connection changed/u); assert.equal(f.retained.size, 0);
});

test('superseded and subsequently canceled apply cannot let a third transaction overtake unfinished rollback', async () => {
    const rollback = deferred(); let commits = 0;
    const f = fixture({ async commit(value) { if (++commits === 1) await rollback.promise; else value.accept(); } });
    const first = f.coordinator.apply(ctPlan()), rejectedFirst = assert.rejects(first, { name: 'AbortError' }); await tick();
    const abort = new AbortController(), second = f.coordinator.apply(ctPlan(2), { signal: abort.signal }), rejectedSecond = assert.rejects(second, { name: 'AbortError' });
    await tick(); abort.abort(); await rejectedSecond;
    const third = f.coordinator.apply(ctPlan(0)); await tick();
    assert.equal(commits, 1); assert.equal(f.requests.length, 1); assert.equal(f.retained.size, 1);
    rollback.resolve(); await rejectedFirst; await third;
    assert.equal(commits, 2); assert.deepEqual(f.requests.map(request => request.index), [1, 0]); assert.equal(f.retained.size, 0);
});

test('atomic accept survives microtask cancellation; abort before acceptance rejects after rollback', async () => {
    const controller = new AbortController(), f = fixture({ commit(value) { value.accept(); queueMicrotask(() => controller.abort()); } });
    await f.coordinator.apply(ctPlan(), { signal: controller.signal }); assert.equal(controller.signal.aborted, true); assert.equal(f.releases.length, 1);
    const abort = new AbortController(), rollback = deferred(); let value;
    const g = fixture({ async commit(handoff) { value = handoff; abort.abort(); assert.throws(handoff.accept, { name: 'AbortError' }); await rollback.promise; throw new DOMException('rollback', 'AbortError'); } });
    const pending = g.coordinator.apply(ctPlan(), { signal: abort.signal }), rejected = assert.rejects(pending, { name: 'AbortError' });
    await tick(); assert.equal(value.isCurrent(), false); assert.equal(g.releases.length, 0); rollback.resolve(); await rejected;
    assert.equal(g.releases.length, 1); assert.equal(g.sources.some(source => source.disposed), false);
});

test('post-accept notification failure cannot dispose sources or suppress borrowed-frame release', async () => {
    const f = fixture({ commit(value) { value.accept(); throw Error('Secret observer payload'); } });
    await assert.rejects(f.coordinator.apply(ctPlan()), error => /transactional pane commit failed/u.test(error.message) && !error.message.includes('Secret'));
    assert.equal(f.releases.length, 1); assert.equal(f.sources.some(source => source.disposed), false);
});

test('async release cleanup remains observable and every release is attempted despite a failure', async () => {
    const cleanup = deferred(); let releases = 0;
    const f = fixture({ holdFrame() { const ordinal = ++releases; return () => ordinal === 1 ? cleanup.promise : Promise.reject(Error('Synthetic cleanup failure')); } });
    const pending = f.coordinator.apply(planFor()); await tick();
    assert.equal(f.coordinator.getState().preparedFrames, 2); assert.equal(f.coordinator.getState().preparedBytes, 8);
    assert.equal(f.coordinator.getState().busy, true); cleanup.resolve(); await pending; await f.coordinator.whenIdle();
    assert.equal(f.coordinator.getState().preparedFrames, 0); assert.equal(releases, 2);
});

test('observer rejection/reentrancy cannot publish identifiers, alter success or bypass cancellation cleanup', async () => {
    const f = fixture({ onChange() { return Promise.reject(Error('Secret patient observer')); } });
    await f.coordinator.apply(ctPlan()); await tick();
    assert.ok(f.events.some(event => event.preparedBytes === 4));
    assert.doesNotMatch(JSON.stringify(f.events), /2\.25|sop|series|patient|samples|position|token|url/iu);
    const state = f.coordinator.getState(); state.preparedFrames = 999; assert.equal(f.coordinator.getState().preparedFrames, 0);
    let g; g = fixture({ onChange(state) { if (state.preparedFrames) void g.coordinator.cancel(); } });
    await assert.rejects(g.coordinator.apply(ctPlan()), { name: 'AbortError' }); assert.equal(g.releases.length, 1); assert.equal(g.commits.length, 0);
});

test('plans detach before asynchronous preparation and unknown or malformed input never invokes providers', async () => {
    const wait = deferred(), f = fixture({ getFrame: () => wait.promise }), input = structuredClone(ctPlan());
    const pending = f.coordinator.apply(input); await tick(); input.slots[0].window.center = 999; input.slots[0].candidateIndex = 1;
    wait.resolve({ ...f.sources[0].frames[1], samples: Int16Array.of(-4, 7) }); const result = await pending;
    assert.equal(result.slots[0].window.center, 40); assert.equal(result.slots[0].candidateIndex, 0);
    for (const mutate of [input => input.patientName = 'Secret', input => input.selectors[0].candidates[0].score = Infinity,
        input => input.slots[0].window.width = 0, input => input.selectors[0].matchedIndex = 1,
        input => input.selectors[0].candidates[0].reasonCodes = ['Secret patient text'], input => input.links.camera = 'yes']) {
        const malformed = structuredClone(ctPlan()); mutate(malformed); const g = fixture(); await assert.rejects(g.coordinator.apply(malformed)); assert.equal(g.requests.length, 0);
    }
    const abort = new AbortController(); abort.abort(); await assert.rejects(f.coordinator.apply(ctPlan(), { signal: abort.signal }), { name: 'AbortError' });
    assert.throws(() => new ReadingProtocolCoordinator({ getSeries() {} }), TypeError);
});

test('bounded planner arrays reject executable components and oversized catalogs without evaluating caller code', async () => {
    let invoked = 0;
    for (const field of ['selectors', 'slots']) {
        const input = structuredClone(ctPlan()), original = input[field][0];
        Object.defineProperty(input[field], '0', { enumerable: true, get() { invoked++; return original; } });
        const f = fixture(); await assert.rejects(f.coordinator.apply(input), TypeError); assert.equal(f.requests.length, 0);
    }
    const input = structuredClone(ctPlan()); Object.defineProperty(input.selectors[0].candidates[0], 'eligible', { enumerable: true, get() { invoked++; return true; } });
    const f = fixture(); await assert.rejects(f.coordinator.apply(input), TypeError); assert.equal(invoked, 0);
    const many = fixture({ sources: Array.from({ length: 129 }, () => series()) });
    await assert.rejects(many.coordinator.apply(ctPlan()), /catalog is invalid/u); assert.equal(many.requests.length, 0);
});

test('bounded128-stack four-selector explanation plans can exceed64KiB while definitions stay small', async () => {
    const strings = ['description', 'photometric', 'unit', 'acquisitionContrast', 'complexImageComponent'];
    const numbers = ['rows', 'columns', 'frameCount', 'effectiveEchoTime', 'temporalPositionIndex', 'acquisitionNumber'];
    const booleans = ['geometryKnown', 'dimensionsValid'];
    const rules = [{ field: 'modality', op: 'eq', value: 'CT' }, ...strings.map(field => ({ field, op: 'eq', value: 'different', required: false })),
        ...numbers.map(field => ({ field, op: 'eq', value: 999, required: false })), ...booleans.map(field => ({ field, op: 'eq', value: true, required: false }))];
    const protocol = { version: 1, id: 'synthetic-bounded-plan', name: 'Synthetic bounded plan', layout: 4,
        selectors: Array.from({ length: 4 }, (_, index) => ({ id: `selected-${index}`, scope: 'selected', rules })),
        slots: Array.from({ length: 4 }, (_, index) => ({ id: index, selector: `selected-${index}`, frame: { mode: 'first' } })) };
    const candidates = Array.from({ length: 128 }, (_, index) => ({ index, role: 'current', modality: 'CT', ...Object.fromEntries(strings.map(field => [field, 'known'])),
        ...Object.fromEntries(numbers.map(field => [field, 2])), ...Object.fromEntries(booleans.map(field => [field, false])) }));
    const input = evaluateReadingProtocol(protocol, candidates, { selectedIndex: 0 });
    assert.ok(Buffer.byteLength(JSON.stringify(protocol)) < 64 * 1024); assert.ok(Buffer.byteLength(JSON.stringify(input)) > 64 * 1024);
    const f = fixture({ sources: Array.from({ length: 128 }, () => series()) });
    await f.coordinator.apply(input); assert.equal(f.requests.length, 1); assert.equal(f.commits[0].assignments.length, 4);
    const tooLarge = structuredClone(input);
    for (const selector of tooLarge.selectors) for (const candidate of selector.candidates) candidate.reasonCodes = Array(32).fill('a'.repeat(128));
    assert.ok(Buffer.byteLength(JSON.stringify(tooLarge)) > 1024 * 1024);
    const g = fixture({ sources: f.sources }); await assert.rejects(g.coordinator.apply(tooLarge), /exceeds1MiB/u); assert.equal(g.requests.length, 0);
});

test('ephemeral commit handoff drops prepared references after settled work and ignores stale accept callbacks', async () => {
    let handoff;
    const f = fixture({ commit(value) { handoff = value; value.accept(); } });
    await f.coordinator.apply(ctPlan()); assert.equal(handoff.assignments.length, 0); assert.equal(f.retained.size, 0);
    handoff.accept(); assert.equal(f.coordinator.getState().busy, false); assert.equal(f.sources.some(source => source.disposed), false);
    const old = handoff, wait = deferred();
    const g = fixture({ async commit(value) { handoff = value; await wait.promise; value.accept(); } });
    const current = g.coordinator.apply(ctPlan()); await tick(); old.accept(); assert.equal(handoff.isCurrent(), true);
    wait.resolve(); await current; assert.equal(g.commits.length, 1);
});

test('published EASI local source remains usable after shared preparation, protocol display windows and coordinator disposal', async () => {
    const bytes = createDicomFixture({ values: [2, 4, 8, 12], signed: true, slope: -2, intercept: 10 });
    const sources = await loadFiles([new File([bytes], 'synthetic-reading-protocol.dcm')]), held = new Set(); let calls = 0, committed;
    const source = sources[0], initial = source.frames[0];
    const coordinator = new ReadingProtocolCoordinator({ getSeries: () => sources, getRevision: () => 0,
        getFrame: (series, index, options) => { calls++; return series.getFrame(index, options); },
        holdFrame(frame) { held.add(frame); return () => held.delete(frame); },
        commit(handoff) { committed = handoff.assignments.map(assignment => assignment.frame); handoff.accept(); } });
    try {
        const input = planFor([0, 0], { window: { center: 40, width: 400 } }); input.slots.forEach(slot => slot.frameIndex = 0);
        await coordinator.apply(input); assert.equal(calls, 1); assert.equal(committed[0], committed[1]); assert.equal(committed[0].sopUid, initial.sopUid);
        assert.deepEqual([...committed[0].samples], [2, 4, 8, 12]); assert.equal(committed[0].slope, -2); assert.equal(committed[0].intercept, 10);
        assert.equal(held.size, 0); await coordinator.dispose(); assert.equal(source.disposed, false);
        assert.deepEqual([...(await source.getFrame(0)).samples], [2, 4, 8, 12]);
    } finally { sources.forEach(source => source.dispose()); }
});
