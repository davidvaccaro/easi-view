import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowBroker } from '../src/ai/WorkflowBroker.js';
import { workflowFromMetadata } from '../src/catalog/workflow.js';

const clone = value => structuredClone(value);
const selector = changes => ({ study: 'active', modality: null, plane: null, contrast: null, bodyPart: null, seriesNumber: null, ...changes });
const select = (changes, viewport = 0) => ({ type: 'select-series', viewport, selector: selector(changes) });
const plan = (...actions) => ({ version: 1, status: 'ready', summary: 'Arrange the requested views.', question: null, actions });
const series = (id, changes = {}) => ({ id, studyId: 'current', modality: 'CT', number: 1, frameCount: 50, description: 'Synthetic axial series', status: 'available',
    workflow: workflowFromMetadata({ imageOrientation: [1, 0, 0, 0, 1, 0], bodyPartExamined: 'CHEST', imageType: 'ORIGINAL\\PRIMARY\\AXIAL' }), ...changes });
const pane = (slot, item) => ({ slot, series: item, studyId: item?.studyId ?? null, frame: 0, window: { center: 40, width: 400 }, transform: { zoom: 1 } });
function harness({ studies, apply, restore, playing = false } = {}) {
    const initial = series('ct');
    let context = { patientId: 'synthetic-patient', currentStudyId: 'current', comparisonStudyId: null, activeViewport: 0, layout: 1, playing,
        annotationRevision: 0, tool: 'window', studies: studies ?? [{ id: 'current', date: '20260101', time: '120000', series: [initial] }],
        panes: [pane(0, initial)], measurements: [], synchronization: { slice: false, window: false, camera: false } };
    const calls = [], restores = [], progress = [];
    const broker = new WorkflowBroker({ getContext: () => context,
        apply: async (action, binding, options) => {
            calls.push({ action: clone(action), binding: clone(binding) });
            if (apply) return apply(action, binding, options, api);
            if (action.type === 'layout') { context.layout = action.count; context.panes = Array.from({ length: action.count }, (_, slot) => context.panes[slot] ?? pane(slot, null)); if (context.activeViewport >= action.count) context.activeViewport = 0; }
            if (action.type === 'select-series') context.panes[action.viewport] = pane(action.viewport, clone(binding));
            if (action.type === 'retain-active-view') context.panes[action.viewport] = {...clone(binding), slot: action.viewport};
            if (action.type === 'tool') context.tool = action.tool;
            if (action.type === 'frame') context.panes[action.viewport].frame = action.frame - 1;
        }, restore: async (snapshot, options) => { restores.push(clone(snapshot)); if (restore) await restore(snapshot, options, api); else context = clone(snapshot); } });
    const api = { broker, calls, restores, progress, get context() { return context; }, set context(value) { context = value; } };
    return api;
}

test('broker validates callback ownership and closed plans before any local action', async () => {
    assert.throws(() => new WorkflowBroker(), /callbacks/u);
    const h = harness(), snapshot = h.broker.getSnapshot();
    for (const invalid of [plan({ type: 'execute', code: 'doAnything()' }), { ...plan({ type: 'layout', count: 2 }), remoteUrl: 'https://invalid.test' },
        plan({ type: 'frame', viewport: 0, frame: 0 }), plan({ type: 'layout', count: 3 }),
        plan({ type: 'select-series', viewport: 0, selector: { ...selector(), rawPatientName: 'PRIVATE' } })]) {
        await assert.rejects(h.broker.execute(invalid, snapshot));
    }
    assert.equal(h.calls.length, 0); assert.equal(h.restores.length, 0);
});

test('missing contrast evidence cannot match a with-contrast description', async () => {
    const h = harness({ studies: [{ id: 'current', date: '20260101', series: [series('unknown', { description: 'CT chest WITH CONTRAST' })] }] });
    const command = plan(select({ modality: 'CT', contrast: 'present' })), snapshot = h.broker.getSnapshot();
    const result = h.broker.preview(command, snapshot);
    assert.equal(result.status, 'clarify'); assert.match(result.message, /Missing contrast/u);
    await assert.rejects(h.broker.execute(command, snapshot), /No series/u); assert.equal(h.calls.length, 0);
});

test('three original MRI contrast acquisitions require a choice while derived/localizer candidates stay excluded', async () => {
    const workflow = workflowFromMetadata({ imageType: 'ORIGINAL\\PRIMARY\\AXIAL', contrastBolusAgent: 'SYNTHETIC' });
    const items = [1001, 1002, 1003].map(number => series('phase-' + number, { modality: 'MR', number, workflow }));
    items.push(series('subtraction', { modality: 'MR', number: 11001, workflow: { ...workflow, derivation: 'derived' } }));
    items.push(series('scout', { modality: 'MR', number: 1, workflow: { ...workflow, localizer: true } }));
    const h = harness({ studies: [{ id: 'current', date: '20260101', series: items }] }), snapshot = h.broker.getSnapshot();
    const command = plan(select({ modality: 'MR', contrast: 'present' })), preview = h.broker.preview(command, snapshot);
    assert.equal(preview.status, 'clarify'); assert.equal(preview.choices.length, 3);
    assert.ok(preview.choices.every(item => /100[123]/u.test(item.label)));
    const chosen = preview.choices[1].id;
    assert.equal(h.broker.preview(command, snapshot, [chosen]).status, 'ready');
    await h.broker.execute(command, snapshot, [chosen]); assert.equal(h.calls[0].binding.number, 1002);
    const second = h.broker.getSnapshot();
    assert.equal(h.broker.preview(plan(select({ modality: 'MR', seriesNumber: 11001 })), second).status, 'ready');
    assert.equal(h.broker.preview(plan(select({ modality: 'MR', seriesNumber: 1 })), second).status, 'ready');
});

test('displayed selection duplicates exactly the active stack without searching matching siblings', async () => {
    const h = harness(); h.context.studies[0].series.push(series('other-ct'));
    const command = plan({ type: 'layout', count: 2 }, select({ study: 'displayed' }, 1));
    const preview = h.broker.preview(command, h.broker.getSnapshot()); assert.equal(preview.status, 'ready'); assert.deepEqual(preview.choices, []);
    await h.broker.execute(command, h.broker.getSnapshot()); assert.equal(h.calls[1].binding.id, 'ct'); assert.equal(h.context.panes[1].series.id, 'ct');
});

test('pending CT choices do not get rejected because an older MR image still occupies the destination', () => {
    const h = harness({ studies: [{ id: 'current', date: '20260101', series: [series('ct-a'), series('ct-b')] }] });
    h.context.panes[0].series.modality = 'MR';
    const result = h.broker.preview(plan(select({ modality: 'CT' }), { type: 'window', viewport: 0, preset: 'lung' }), h.broker.getSnapshot());
    assert.equal(result.status, 'clarify'); assert.equal(result.choices.length, 2);
});

test('unknown and stale choice IDs, duplicate choices and multiple candidates per step are refused', () => {
    const h = harness({ studies: [{ id: 'current', date: '20260101', series: [series('a'), series('b')] }] });
    const command = plan(select()), snapshot = h.broker.getSnapshot(), { choices } = h.broker.preview(command, snapshot);
    for (const chosen of [['stale'], [choices[0].id, choices[0].id], choices.map(item => item.id), Array(13).fill('candidate'), [1]]) {
        assert.throws(() => h.broker.preview(command, snapshot, chosen), /Choose|chosen/u);
    }
});

test('latest/prior same-time studies remain ambiguous and selected prior resolves only its explicit study', async () => {
    const h = harness({ studies: [
        { id: 'current', date: '20260201', time: '', series: [series('current-ct')] },
        { id: 'prior-a', date: '20260101', time: '', series: [series('prior-a', { studyId: 'prior-a' })] },
        { id: 'prior-b', date: '20260101', time: '', series: [series('prior-b', { studyId: 'prior-b' })] },
        { id: 'unknown', date: '', time: '', series: [series('unknown', { studyId: 'unknown' })] }
    ] });
    const command = plan(select({ study: 'prior' }));
    assert.equal(h.broker.preview(command, h.broker.getSnapshot()).choices.length, 2);
    h.context.comparisonStudyId = 'prior-b';
    await h.broker.execute(plan(select({ study: 'selected-prior' })), h.broker.getSnapshot()); assert.equal(h.calls[0].binding.id, 'prior-b');
    h.context.studies.push({ id: 'current-b', date: '20260201', time: '', series: [series('current-b')] });
    assert.equal(h.broker.preview(plan(select({ study: 'latest' })), h.broker.getSnapshot()).choices.length, 2);
});

test('review snapshots reject mutations, annotation changes and manual frame changes before execution', async () => {
    const h = harness(), command = plan({ type: 'tool', tool: 'pan' }), old = h.broker.getSnapshot();
    h.context.annotationRevision++;
    await assert.rejects(h.broker.execute(command, old), /viewing session changed/u);
    const fresh = h.broker.getSnapshot(); fresh.context.layout = 2;
    assert.throws(() => h.broker.preview(command, fresh), /viewing session changed/u);
    const frame = h.broker.getSnapshot(); h.context.panes[0].frame++;
    await assert.rejects(h.broker.execute(command, frame), /viewing session changed/u); assert.equal(h.calls.length, 0);
});

test('automatic cine progression does not invalidate a reviewed navigation task while playing', async () => {
    const h = harness({ playing: true }), snapshot = h.broker.getSnapshot(); h.context.panes[0].frame = 10;
    assert.equal(h.broker.preview(plan({ type: 'cine', viewport: 0, playing: false }), snapshot).status, 'ready');
});

test('cine automatic per-frame windows preserve Undo while explicit window edits still invalidate it', async () => {
    const h = harness({ playing: true });
    h.context.panes[0].windowOverride = false;
    const snapshot = h.broker.getSnapshot();
    await h.broker.execute(plan({ type: 'tool', tool: 'pan' }), snapshot);
    h.context.panes[0].frame = 12;
    h.context.panes[0].window = { center: 120, width: 1900 };
    await h.broker.undo();
    assert.deepEqual(h.context, snapshot.context);
    await h.broker.execute(plan({ type: 'tool', tool: 'pan' }), h.broker.getSnapshot());
    h.context.panes[0].windowOverride = true;
    h.context.panes[0].window.center = 125;
    await assert.rejects(h.broker.undo(), /view changed/u);
    const explicit = harness({ playing: true });
    explicit.context.panes[0].windowOverride = true;
    await explicit.broker.execute(plan({ type: 'tool', tool: 'pan' }), explicit.broker.getSnapshot());
    explicit.context.panes[0].window.center += 1;
    await assert.rejects(explicit.broker.undo(), /view changed/u);
});

test('pane bounds and declared frame bounds are checked before applying any step', async () => {
    const h = harness(), snapshot = h.broker.getSnapshot();
    assert.throws(() => h.broker.preview(plan(select({}, 1)), snapshot), /outside.*layout/u);
    assert.throws(() => h.broker.preview(plan({ type: 'frame', viewport: 0, frame: 51 }), snapshot), /outside.*series/u);
    h.context.panes[0].series.modality = 'MR';
    assert.throws(() => h.broker.preview(plan({ type: 'window', viewport: 0, preset: 'lung' }), h.broker.getSnapshot()), /CT window/u);
    h.context.panes[0].series = null;
    assert.throws(() => h.broker.preview(plan({ type: 'frame', viewport: 0, frame: 1 }), h.broker.getSnapshot()), /Display an image/u);
    assert.throws(() => h.broker.preview(plan({ type: 'window', viewport: 0, preset: 'default' }), h.broker.getSnapshot()), /Display an image/u);
    assert.equal(h.calls.length, 0);
});

test('failed partial execution restores its snapshot and clears undo', async () => {
    let count = 0;
    const h = harness({ apply: async (action, binding, options, current) => { current.context.layout = 2; if (++count === 2) throw new Error('Synthetic source failure'); } });
    const before = h.broker.getSnapshot();
    await assert.rejects(h.broker.execute(plan({ type: 'layout', count: 2 }, { type: 'tool', tool: 'pan' }), before), /Synthetic source failure/u);
    assert.deepEqual(h.context, before.context); assert.equal(h.restores.length, 1); assert.equal(h.broker.isExecuting(), false);
    await assert.rejects(h.broker.undo(), /no completed/u);
});

test('canceling during an in-flight step propagates AbortSignal then restores only the original patient', async () => {
    const h = harness({ apply: async (action, binding, { signal }, current) => {
        current.context.layout = 2;
        const pending = new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')), { once: true }));
        queueMicrotask(() => current.broker.cancel()); await pending;
    } });
    const snapshot = h.broker.getSnapshot();
    await assert.rejects(h.broker.execute(plan({ type: 'layout', count: 2 }), snapshot), { name: 'AbortError' });
    assert.equal(h.restores.length, 1); assert.deepEqual(h.context, snapshot.context);
});

test('external user interruption preserves the new workspace instead of rolling it back', async () => {
    const h = harness({ apply: async (action, binding, options, current) => {
        current.context.panes[0].frame = 27; current.broker.interrupt();
    } });
    await assert.rejects(h.broker.execute(plan({ type: 'tool', tool: 'pan' }), h.broker.getSnapshot()), { name: 'AbortError' });
    assert.equal(h.context.panes[0].frame, 27); assert.equal(h.restores.length, 0);
});

test('a patient change during execution stops remaining actions and prevents restoration into another patient', async () => {
    const h = harness({ apply: async (action, binding, options, current) => { current.context.patientId = 'another-synthetic-patient'; } });
    await assert.rejects(h.broker.execute(plan({ type: 'tool', tool: 'pan' }, { type: 'tool', tool: 'zoom' }), h.broker.getSnapshot()), /patient changed/u);
    assert.equal(h.calls.length, 1); assert.equal(h.restores.length, 0);
});

test('pre-aborted tasks have no effects and concurrent execution is rejected', async () => {
    const stopped = new AbortController(); stopped.abort(); const h = harness();
    await assert.rejects(h.broker.execute(plan({ type: 'tool', tool: 'pan' }), h.broker.getSnapshot(), [], { signal: stopped.signal }), { name: 'AbortError' });
    assert.equal(h.calls.length, 0); assert.equal(h.restores.length, 0);
    let done;
    const running = harness({ apply: () => new Promise(resolve => { done = resolve; }) });
    const task = running.broker.execute(plan({ type: 'tool', tool: 'pan' }), running.broker.getSnapshot());
    await assert.rejects(running.broker.execute(plan({ type: 'tool', tool: 'zoom' }), running.broker.getSnapshot()), /already running/u);
    done(); await task;
});

test('undo is available only while the exact post-task view remains unchanged', async () => {
    const h = harness(), before = h.broker.getSnapshot();
    const result = await h.broker.execute(plan({ type: 'tool', tool: 'pan' }), before);
    assert.equal(result.canUndo, true); assert.equal(h.context.tool, 'pan');
    const undone = await h.broker.undo(); assert.equal(undone.canUndo, false); assert.equal(h.context.tool, 'window');
    await h.broker.execute(plan({ type: 'tool', tool: 'zoom' }), h.broker.getSnapshot());
    h.context.panes[0].transform.zoom = 2;
    await assert.rejects(h.broker.undo(), /preserve your changes/u); assert.equal(h.context.panes[0].transform.zoom, 2);
});

test('rollback and undo both receive cancelable signals so external changes can interrupt restoration', async () => {
    let started;
    const active = new Promise(resolve => { started = resolve; });
    const h = harness({ restore: (snapshot, { signal }) => new Promise((resolve, reject) => {
        started(); signal.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')), { once: true });
    }) });
    await h.broker.execute(plan({ type: 'tool', tool: 'pan' }), h.broker.getSnapshot());
    const undo = h.broker.undo(); await active; h.context.panes[0].frame = 22; h.broker.interrupt();
    await assert.rejects(undo, { name: 'AbortError' }); assert.equal(h.context.panes[0].frame, 22);
});

test('progress has the controller message field and incompatible link notices remain visible in completion', async () => {
    const h = harness({ apply: async () => ({ notices: ['One pane remains unlinked. No registration was inferred.'] }) });
    const result = await h.broker.execute(plan({ type: 'synchronize', slice: true, window: false, camera: false }), h.broker.getSnapshot(), [], { onProgress: value => h.progress.push(value) });
    assert.match(h.progress[0].message, /Link compatible slices/u);
    assert.match(result.message, /unlinked.*No registration/u);
});

test('existing last measurement returns to its actual source and never creates a new annotation', async () => {
    const h = harness();
    const command = plan({ type: 'last-measurement', viewport: 0 });
    assert.equal(h.broker.preview(command, h.broker.getSnapshot()).status, 'clarify');
    h.context.measurements.push({ id: 'synthetic-measurement', series: h.context.panes[0].series, frame: 17 });
    const revision = h.context.annotationRevision;
    await h.broker.execute(command, h.broker.getSnapshot());
    assert.equal(h.calls[0].binding.frame, 17); assert.equal(h.calls[0].binding.id, 'synthetic-measurement');
    assert.equal(h.context.annotationRevision, revision); assert.equal(h.context.measurements.length, 1);
});


test('active viewport resolves once from the review snapshot and never defaults to pane A', async () => {
    const h = harness(); h.context.layout = 2; h.context.activeViewport = 1; h.context.panes.push(pane(1, series('us', { modality: 'US', frameCount: 42 })));
    await h.broker.execute(plan({ type: 'cine', viewport: 'active', playing: false }, { type: 'frame', viewport: 'active', frame: 40 }), h.broker.getSnapshot());
    assert.equal(h.calls[0].action.viewport, 1); assert.equal(h.calls[1].action.viewport, 1);
    assert.equal(h.context.panes[1].frame, 39); assert.equal(h.context.panes[0].frame, 0);
});


const ctWindows = (criteria = {}) => plan({type: 'layout', count: 2},
    select({modality: 'CT', plane: 'axial', ...criteria}, 0), select({modality: 'CT', plane: 'axial', ...criteria}, 1),
    {type: 'window', viewport: 0, preset: 'lung'}, {type: 'window', viewport: 1, preset: 'soft-tissue'},
    {type: 'synchronize', slice: true, camera: true, window: false});
const reconstruction = (purpose, extra = {}) => ({...series('unused').workflow, reconstruction: purpose, ...extra});

test('paired CT windows search the active study and automatically choose its sole suitable axial stack', async () => {
    const chosen = series('unique-axial', {number: 18});
    const excluded = [series('scout', {workflow: reconstruction('axial', {localizer: true})}),
        ...['projection', 'reformatted', 'virtual-unenhanced', 'material-map'].map((purpose, index) => series('special-' + index, {workflow: reconstruction(purpose)})),
        series('derived', {workflow: reconstruction('axial', {derivation: 'derived'})}),
        series('coronal', {workflow: {...series('unused').workflow, plane: 'coronal'}})];
    const h = harness({studies: [{id: 'current', series: [excluded[0], chosen, ...excluded.slice(1)]}]});
    h.context.panes[0] = pane(0, excluded[0]);
    const snapshot = h.broker.getSnapshot(), preview = h.broker.preview(ctWindows(), snapshot);
    assert.equal(preview.status, 'ready'); assert.equal(preview.choices.length, 0); assert.equal(h.calls.length, 0);
    assert.match(preview.actions[1].label, /recorded axial orientation/); assert.match(preview.actions[1].label, /HU calibration checked when opened/);
    await h.broker.execute(ctWindows(), snapshot);
    assert.deepEqual(h.calls.filter(call => call.action.type === 'select-series').map(call => call.binding.id), ['unique-axial', 'unique-axial']);
});

test('equally suitable CT energy reconstructions produce one shared local choice rather than a guessed winner', async () => {
    const items = ['70 keV', '50 keV', 'Blended'].map((description, index) => series('energy-' + index, {number: [12, 93, 47][index], description}));
    items.push(series('vue-original', {workflow: reconstruction('virtual-unenhanced')}));
    const h = harness({studies: [{id: 'current', series: items}]}), snapshot = h.broker.getSnapshot();
    const preview = h.broker.preview(ctWindows(), snapshot);
    assert.equal(preview.status, 'clarify'); assert.equal(preview.choices.length, 3); assert.equal(new Set(preview.choices.map(choice => choice.group)).size, 1);
    assert.match(preview.message, /both windows/); assert.ok(preview.choices.every(choice => /recorded axial orientation/.test(choice.label)));
    const id = preview.choices.find(choice => choice.label.includes('50 keV')).id;
    assert.equal(h.broker.preview(ctWindows(), snapshot, [id]).status, 'ready');
    await h.broker.execute(ctWindows(), snapshot, [id]);
    assert.deepEqual(h.calls.filter(call => call.action.type === 'select-series').map(call => call.binding.id), ['energy-1', 'energy-1']);
});

test('an explicit displayed scout remains the literal requested image rather than triggering a study search', async () => {
    const scout = series('shown-scout', {workflow: reconstruction('axial', {localizer: true})});
    const h = harness({studies: [{id: 'current', series: [scout, series('other-volume')]}]}); h.context.panes[0] = pane(0, scout);
    const command = ctWindows({study: 'displayed', plane: null}), snapshot = h.broker.getSnapshot();
    assert.equal(h.broker.preview(command, snapshot).status, 'ready'); await h.broker.execute(command, snapshot);
    assert.deepEqual(h.calls.filter(call => call.action.type === 'select-series').map(call => call.binding.id), ['shown-scout', 'shown-scout']);
});

test('an exact requested special reconstruction is permitted without a general CT eligibility substitution', async () => {
    const explicit = series('vue-exact', {number: 88, workflow: reconstruction('virtual-unenhanced')});
    const h = harness({studies: [{id: 'current', series: [explicit, series('other')]}]}); const snapshot = h.broker.getSnapshot(), command = ctWindows({seriesNumber: 88});
    assert.equal(h.broker.preview(command, snapshot).status, 'ready'); await h.broker.execute(command, snapshot);
    assert.deepEqual(h.calls.filter(call => call.action.type === 'select-series').map(call => call.binding.id), ['vue-exact', 'vue-exact']);
});

test('an absent active study does not silently choose the first study when CT candidates span examinations', () => {
    const h = harness({studies: [{id: 'study-a', description: 'Examination A', series: [series('a', {studyId: 'study-a'})]},
        {id: 'study-b', description: 'Examination B', series: [series('b', {studyId: 'study-b'})]}]});
    h.context.currentStudyId = null; h.context.panes[0] = pane(0, null);
    const preview = h.broker.preview(ctWindows(), h.broker.getSnapshot());
    assert.equal(preview.status, 'clarify'); assert.equal(preview.choices.length, 2); assert.match(preview.choices[0].label, /Examination A/); assert.match(preview.choices[1].label, /Examination B/);
});

test('a study containing only specialized CT reconstructions cannot silently borrow another study', () => {
    const h = harness({studies: [{id: 'current', series: [series('vue', {workflow: reconstruction('virtual-unenhanced')})]},
        {id: 'other', series: [series('other-axial', {studyId: 'other'})]}]});
    const preview = h.broker.preview(ctWindows(), h.broker.getSnapshot());
    assert.equal(preview.status, 'clarify'); assert.equal(preview.choices.length, 0); assert.match(preview.message, /No suitable axial CT/); assert.equal(h.calls.length, 0);
});

const viewSelector = changes => ({study: 'active', modality: 'CT', plane: 'axial', contrast: null, bodyPart: null,
    purpose: 'routine', reconstruction: null, energyKeV: null, energyPreference: null, thickness: null, kernel: null, ...changes});
const view = (changes = {}, viewport = 0) => ({type: 'select-view', viewport, selector: viewSelector(changes)});
const conceptualSeries = (id, changes = {}, workflow = {}) => series(id, {frameCount: 228, ...changes,
    workflow: {...series('unused').workflow, ctFamily: 'monoenergetic', familyEvidence: 'image-type', energyKeV: 70,
        energyEvidence: 'attribute', sliceThicknessMm: 1.25, kernel: 'standard', kernelEvidence: 'attribute', ...workflow}});

test('four different CT presentations share one conceptual image-stack choice without a series-number prerequisite', async () => {
    const items = [conceptualSeries('70', {number: 81, description: 'Synthetic 70 keV'}), conceptualSeries('50', {number: 38, description: 'Synthetic 50 keV'}, {energyKeV: 50}),
        conceptualSeries('blend', {number: 17, description: 'Synthetic blended'}, {ctFamily: 'blended', familyEvidence: 'label', energyKeV: null, energyEvidence: 'unknown'})];
    items.push(conceptualSeries('vue', {}, {reconstruction: 'virtual-unenhanced'}), conceptualSeries('map', {}, {reconstruction: 'material-map'}));
    const h = harness({studies: [{id: 'current', date: '20260101', series: items}]});
    const command = plan({type: 'layout', count: 4}, ...[0, 1, 2, 3].map(slot => view({}, slot)),
        ...['lung', 'soft-tissue', 'bone', 'default'].map((preset, viewport) => ({type: 'window', viewport, preset})),
        {type: 'synchronize', slice: true, camera: true, window: false}, {type: 'position', viewport: 0, position: 'middle'});
    const snapshot = h.broker.getSnapshot(), preview = h.broker.preview(command, snapshot);
    assert.equal(preview.status, 'clarify'); assert.equal(preview.choices.length, 3); assert.equal(new Set(preview.choices.map(item => item.group)).size, 1);
    assert.ok(preview.choices.every(item => !item.label.startsWith('Series '))); assert.match(preview.actions.at(-1).label, /middle.*after image-stack selection/u);
    const chosen = preview.choices.find(item => item.label.includes('50 keV')).id;
    const ready = h.broker.preview(command, snapshot, [chosen]); assert.equal(ready.status, 'ready'); assert.match(ready.actions.at(-1).label, /114 of 228/u);
    await h.broker.execute(command, snapshot, [chosen]);
    assert.deepEqual(h.calls.filter(call => call.action.type === 'select-series').map(call => call.binding.id), ['50', '50', '50', '50']);
    assert.equal(h.calls.at(-1).action.type, 'frame'); assert.equal(h.context.panes[0].frame, 113);
    assert.ok(h.calls.every(call => !['select-view', 'position'].includes(call.action.type)));
});

test('routine conceptual choice stays ambiguous by default and honors only an explicit configured blended preference', async () => {
    const items = [conceptualSeries('mono'), conceptualSeries('blend', {}, {ctFamily: 'blended', familyEvidence: 'label'})];
    const h = harness({studies: [{id: 'current', date: '20260101', series: items}]}), command = plan(view());
    assert.equal(h.broker.preview(command, h.broker.getSnapshot()).choices.length, 2);
    h.context.preferences = {routineCt: 'no-preference'};
    assert.equal(h.broker.preview(command, h.broker.getSnapshot()).choices.length, 2);
    h.context.preferences.routineCt = 'blended';
    const snapshot = h.broker.getSnapshot(), preview = h.broker.preview(command, snapshot);
    assert.equal(preview.status, 'ready'); assert.match(preview.actions[0].label, /configured routine CT preference: blended; not a clinical ranking/u);
    await h.broker.execute(command, snapshot); assert.equal(h.calls[0].binding.id, 'blend');
    await h.broker.execute(plan(view({energyKeV: 70})), h.broker.getSnapshot()); assert.equal(h.calls.at(-1).binding.id, 'mono');
});

test('an evidence-based energy comparison grounds distinct conceptual requests without sharing their choices', async () => {
    const items = [conceptualSeries('70'), conceptualSeries('50', {}, {energyKeV: 50})];
    const h = harness({studies: [{id: 'current', date: '20260101', series: items}]});
    const command = plan({type: 'layout', count: 2}, view({energyPreference: 'lowest'}, 0), view({energyPreference: 'highest'}, 1),
        {type: 'window', viewport: 0, preset: 'soft-tissue'}, {type: 'window', viewport: 1, preset: 'soft-tissue'});
    const snapshot = h.broker.getSnapshot(); assert.equal(h.broker.preview(command, snapshot).status, 'ready');
    await h.broker.execute(command, snapshot);
    assert.deepEqual(h.calls.filter(call => call.action.type === 'select-series').map(call => call.binding.id), ['50', '70']);
});

test('unknown energy or thickness cannot become an automatic best-ranked conceptual source', () => {
    const items = [conceptualSeries('known'), conceptualSeries('unknown', {}, {energyKeV: null, energyEvidence: 'unknown', sliceThicknessMm: null})];
    const h = harness({studies: [{id: 'current', date: '20260101', series: items}]});
    for (const criteria of [{energyPreference: 'lowest'}, {thickness: 'thinnest'}]) {
        const preview = h.broker.preview(plan(view(criteria)), h.broker.getSnapshot());
        assert.equal(preview.status, 'clarify'); assert.equal(preview.choices.length, 0); assert.match(preview.message, /missing or conflicting/u);
    }
    assert.equal(h.calls.length, 0);
});

test('conceptual current/prior study roles remain distinct and never fall back when chronology or selected prior is missing', async () => {
    const h = harness({studies: [{id: 'current', date: '20260201', series: [conceptualSeries('current')]},
        {id: 'prior', date: '20260101', series: [conceptualSeries('prior', {studyId: 'prior'})]}]});
    const command = plan({type: 'layout', count: 2}, view({}, 0), view({study: 'prior'}, 1));
    await h.broker.execute(command, h.broker.getSnapshot());
    assert.deepEqual(h.calls.filter(call => call.action.type === 'select-series').map(call => call.binding.id), ['current', 'prior']);
    h.context.studies[0].date = ''; h.context.studies[1].date = '';
    for (const study of ['latest', 'prior', 'selected-prior']) {
        const preview = h.broker.preview(plan(view({study})), h.broker.getSnapshot());
        assert.equal(preview.status, 'clarify'); assert.deepEqual(preview.choices, []);
    }
});

test('a conceptual sharp-kernel request cannot borrow evidence from a different study or a misleading label', async () => {
    const h = harness({studies: [{id: 'current', date: '20260201', series: [conceptualSeries('standard', {description: 'Synthetic SHARP LUNG'}, {kernel: 'standard'})]},
        {id: 'other', date: '20260101', series: [conceptualSeries('sharp', {studyId: 'other'}, {kernel: 'sharp'})]}]});
    const command = plan(view({purpose: 'bone', kernel: 'sharp'}));
    assert.equal(h.broker.preview(command, h.broker.getSnapshot()).status, 'clarify');
    await assert.rejects(h.broker.execute(command, h.broker.getSnapshot()), /No image stack/u); assert.equal(h.calls.length, 0);
});

test('conceptual latest remains ambiguous for same-day missing or partial times and prior never infers their ordering', async () => {
    for (const unknownTime of ['', '12', '1200', '256000']) {
        const h = harness({studies: [{id: 'current', date: '20260201', time: '120000', series: [conceptualSeries('current')]},
            {id: 'same-day', date: '20260201', time: unknownTime, series: [conceptualSeries('unknown-time', {studyId: 'same-day'})]}]});
        const latest = h.broker.preview(plan(view({study: 'latest'})), h.broker.getSnapshot());
        assert.equal(latest.status, 'clarify'); assert.equal(latest.choices.length, 2);
        const prior = h.broker.preview(plan(view({study: 'prior'})), h.broker.getSnapshot());
        assert.equal(prior.status, 'clarify'); assert.deepEqual(prior.choices, []);
    }
    const h = harness({studies: [{id: 'current', date: '20260201', time: '120000.0', series: [conceptualSeries('current')]},
        {id: 'earlier', date: '20260201', time: '115959.999999', series: [conceptualSeries('earlier', {studyId: 'earlier'})]},
        {id: 'equal', date: '20260201', time: '120000', series: [conceptualSeries('equal', {studyId: 'equal'})]}]});
    assert.equal(h.broker.preview(plan(view({study: 'latest'})), h.broker.getSnapshot()).choices.length, 2);
    await h.broker.execute(plan(view({study: 'prior'})), h.broker.getSnapshot()); assert.equal(h.calls[0].binding.id, 'earlier');
});

test('conceptual preferences participate in snapshot epochs and cannot change after review', async () => {
    const h = harness(); h.context.preferences = {routineCt: 'no-preference'};
    const snapshot = h.broker.getSnapshot(); h.context.preferences.routineCt = 'blended';
    await assert.rejects(h.broker.execute(plan(view()), snapshot), /viewing session changed/u); assert.equal(h.calls.length, 0);
});

test('first middle and last positions resolve from selected navigable counts, reject unknown counts and retain ordinary frame bounds', async () => {
    for (const [position, expected] of [['first', 1], ['middle', 114], ['last', 228]]) {
        const h = harness({studies: [{id: 'current', date: '20260101', series: [conceptualSeries('ct')]}]});
        await h.broker.execute(plan(view(), {type: 'position', viewport: 0, position}), h.broker.getSnapshot());
        assert.equal(h.calls.at(-1).action.frame, expected); assert.equal(h.context.panes[0].frame, expected - 1);
    }
    const h = harness({studies: [{id: 'current', date: '20260101', series: [conceptualSeries('unknown', {frameCount: null})]}]});
    assert.throws(() => h.broker.preview(plan(view(), {type: 'position', viewport: 0, position: 'last'}), h.broker.getSnapshot()), /reliable navigable image count/u);
    const bounded = harness();
    assert.throws(() => bounded.broker.preview(plan({type: 'position', viewport: 0, position: 'last'}, {type: 'frame', viewport: 0, frame: 51}), bounded.broker.getSnapshot()), /outside.*series/u);
});

test('conceptual presentation setup unlinks old windows before applying independent presets and Undo restores old links', async () => {
    const initial = conceptualSeries('ct');
    const h = harness({studies: [{id: 'current', date: '20260101', series: [initial]}], apply: (action, binding, options, current) => {
        const context = current.context;
        if (action.type === 'synchronize') context.synchronization = {slice: action.slice, window: action.window, camera: action.camera};
        if (action.type === 'layout') { context.layout = action.count; context.panes = Array.from({length: action.count}, (_, slot) => context.panes[slot] ?? pane(slot, null)); }
        if (action.type === 'select-series') context.panes[action.viewport] = pane(action.viewport, clone(binding));
        if (action.type === 'window') {
            context.panes[action.viewport].window = action.preset;
            if (context.synchronization.window) context.panes.forEach(item => { item.window = action.preset; });
        }
    }});
    h.context.layout = 2; h.context.panes = [pane(0, initial), pane(1, initial)]; h.context.synchronization = {slice: true, window: true, camera: true};
    const snapshot = h.broker.getSnapshot(), command = plan({type: 'layout', count: 2}, view({}, 0), view({}, 1),
        {type: 'window', viewport: 0, preset: 'lung'}, {type: 'window', viewport: 1, preset: 'soft-tissue'},
        {type: 'synchronize', slice: true, camera: true, window: false});
    assert.match(h.broker.preview(command, snapshot).actions[0].label, /Temporarily unlink/u);
    await h.broker.execute(command, snapshot);
    assert.deepEqual(h.calls[0].action, {type: 'synchronize', slice: false, window: false, camera: false});
    assert.deepEqual(h.context.panes.map(item => item.window), ['lung', 'soft-tissue']);
    await h.broker.undo(); assert.deepEqual(h.context.synchronization, {slice: true, window: true, camera: true});
});

test('different conceptual endpoint positions are unlinked before navigation even when final unlink was planned last', async () => {
    const initial = conceptualSeries('ct');
    const h = harness({apply: (action, binding, options, current) => {
        if (action.type === 'synchronize') current.context.synchronization = {slice: action.slice, window: action.window, camera: action.camera};
        if (action.type === 'frame') {
            current.context.panes[action.viewport].frame = action.frame - 1;
            if (current.context.synchronization.slice) current.context.panes.forEach(item => { item.frame = action.frame - 1; });
        }
    }});
    h.context.layout = 2; h.context.panes = [pane(0, initial), pane(1, initial)]; h.context.synchronization = {slice: true, window: true, camera: true};
    const command = plan({type: 'position', viewport: 0, position: 'first'}, {type: 'position', viewport: 1, position: 'last'},
        {type: 'synchronize', slice: false, window: false, camera: false});
    await h.broker.execute(command, h.broker.getSnapshot());
    assert.equal(h.calls[0].action.type, 'synchronize'); assert.deepEqual(h.context.panes.map(item => item.frame), [0, 227]);
});

test('an explicit initial unlink is not duplicated and legacy plans retain their original steps', async () => {
    const h = harness(); h.context.synchronization = {slice: true, window: true, camera: true};
    const unlink = {type: 'synchronize', slice: false, window: false, camera: false};
    const conceptual = plan(unlink, {type: 'layout', count: 2}, view({}, 0));
    assert.equal(h.broker.preview(conceptual, h.broker.getSnapshot()).actions.length, 3);
    const legacy = plan({type: 'layout', count: 2}, select({}, 0));
    assert.equal(h.broker.preview(legacy, h.broker.getSnapshot()).actions.length, 2);
});

test('fresh request planning ignores old panes while preserving the actual snapshot for execution and Undo', async () => {
    const initial = conceptualSeries('ct');
    const h = harness({studies: [{id: 'current', date: '20260101', series: [initial]}]});
    h.context.layout = 2; h.context.activeViewport = 1; h.context.playing = true;
    h.context.panes = [pane(0, initial), pane(1, initial)]; h.context.panes[1].frame = 27;
    h.context.measurements = [{id: 'kept-annotation', series: initial, frame: 12}];
    h.context.synchronization = {slice: true, window: true, camera: true};
    const before = clone(h.context), snapshot = h.broker.getSnapshot({mode: 'fresh'});
    const command = plan({type: 'layout', count: 1}, view({}, 'active'), {type: 'position', viewport: 'active', position: 'middle'});
    const preview = h.broker.preview(command, snapshot);
    assert.equal(preview.status, 'ready'); assert.match(preview.actions[0].label, /one clean pane/u);
    assert.deepEqual(h.context, before); assert.deepEqual(h.calls, []);
    await h.broker.execute(command, snapshot);
    assert.equal(h.calls[0].action.type, 'prepare-fresh-view');
    assert.equal(h.calls.find(call => call.action.type === 'select-series').action.viewport, 0);
    assert.equal(h.context.panes[0].frame, 113);
    assert.deepEqual(h.context.studies, before.studies); assert.deepEqual(h.context.measurements, before.measurements);
    await h.broker.undo(); assert.deepEqual(h.context, before);
});

test('continue edits active pane B while a requested one-pane layout rebinds implicit active to pane A', async () => {
    const h = harness(); h.context.layout = 2; h.context.activeViewport = 1;
    h.context.panes.push(pane(1, series('shown-b')));
    await h.broker.execute(plan({type: 'window', viewport: 'active', preset: 'bone'}), h.broker.getSnapshot({mode: 'continue'}));
    assert.equal(h.calls[0].action.viewport, 1); assert.equal(h.calls.length, 1);
    const command = plan({type: 'layout', count: 1}, select({study: 'displayed'}, 'active'), {type: 'window', viewport: 'active', preset: 'lung'});
    await h.broker.execute(command, h.broker.getSnapshot({mode: 'continue'}));
    const opened = h.calls.filter(call => call.action.type === 'select-series').at(-1);
    assert.equal(opened.action.viewport, 0); assert.equal(opened.binding.id, 'shown-b');
    assert.throws(() => h.broker.preview(plan({type: 'layout', count: 1}, {type: 'window', viewport: 1, preset: 'bone'}), h.broker.getSnapshot()), /outside.*layout/u);
});

test('continue shrinking to one pane carries the previously active source and validates subsequent implicit actions against it', async () => {
    const h = harness(); h.context.layout = 2; h.context.activeViewport = 1;
    const a = series('old-a', {modality: 'MR'}), b = series('active-b', {frameCount: 228});
    h.context.panes = [pane(0, a), {...pane(1, b), frame: 33, windowOverride: false, transform: {zoom: 3, panX: 4, panY: -7}}];
    const before = clone(h.context), command = plan({type: 'layout', count: 1}, {type: 'window', viewport: 'active', preset: 'lung'},
        {type: 'position', viewport: 'active', position: 'middle'}), snapshot = h.broker.getSnapshot({mode: 'continue'});
    const preview = h.broker.preview(command, snapshot);
    assert.equal(preview.status, 'ready'); assert.match(preview.actions[1].label, /previously active image in pane A/u); assert.deepEqual(h.context, before);
    await h.broker.execute(command, snapshot);
    assert.equal(h.calls[1].action.type, 'retain-active-view'); assert.equal(h.calls[1].binding.series.id, 'active-b'); assert.equal(h.calls[1].binding.frame, 33);
    assert.equal(h.calls.find(call => call.action.type === 'frame').action.frame, 114); assert.equal(h.context.panes[0].series.id, 'active-b');
    await h.broker.undo(); assert.deepEqual(h.context, before);
});

test('continue cannot pretend the previously active empty pane contains the old pane A image after shrinking', () => {
    const h = harness(); h.context.layout = 2; h.context.activeViewport = 1; h.context.panes.push(pane(1, null));
    assert.throws(() => h.broker.preview(plan({type: 'layout', count: 1}, {type: 'window', viewport: 'active', preset: 'lung'}), h.broker.getSnapshot({mode: 'continue'})), /Display an image/u);
    assert.equal(h.calls.length, 0);
});

test('fresh mode cannot reuse a displayed source or erase views for a source-free adjustment', async () => {
    const h = harness(); const before = clone(h.context), snapshot = h.broker.getSnapshot({mode: 'fresh'});
    for (const command of [plan({type: 'tool', tool: 'ellipse'}), plan(select({study: 'displayed'}))]) {
        const preview = h.broker.preview(command, snapshot);
        assert.equal(preview.status, 'clarify'); assert.match(preview.message, /Continue current view/u);
        await assert.rejects(h.broker.execute(command, snapshot), /Continue current view/u);
    }
    assert.deepEqual(h.context, before); assert.deepEqual(h.calls, []);
    snapshot.mode = 'continue'; assert.throws(() => h.broker.preview(plan(select()), snapshot), /viewing session changed/u);
});

test('failed fresh preparation restores the original complete view and does not remove studies or annotations', async () => {
    const h = harness({apply: (action, binding, options, current) => {
        if (action.type === 'prepare-fresh-view') { current.context.layout = 1; current.context.panes = [pane(0, null)]; }
        if (action.type === 'select-series') throw new Error('Synthetic source unavailable');
    }});
    h.context.layout = 2; h.context.panes.push(pane(1, series('other'))); h.context.measurements = [{id: 'retained'}];
    const before = clone(h.context);
    await assert.rejects(h.broker.execute(plan(select()), h.broker.getSnapshot({mode: 'fresh'})), /Synthetic source unavailable/u);
    assert.deepEqual(h.context, before); assert.equal(h.restores.length, 1);
});
