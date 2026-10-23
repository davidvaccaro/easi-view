import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewerWorkflow } from '../src/integration/ViewerWorkflow.js';
import { workflowFromMetadata } from '../src/catalog/workflow.js';
import {wrapWorkflowMutation} from '../src/ui/app.js';

const clone = value => structuredClone(value);
const selector = changes => ({ study: 'displayed', modality: null, plane: null, contrast: null, bodyPart: null, seriesNumber: null, ...changes });
const choose = (changes, viewport = 0) => ({ type: 'select-series', viewport, selector: selector(changes) });
const plan = (...actions) => ({ version: 1, status: 'ready', summary: 'Set up the requested view.', question: null, actions });
const workflow = changes => workflowFromMetadata({ imageOrientation: [1, 0, 0, 0, 1, 0], bodyPartExamined: 'CHEST', imageType: 'ORIGINAL\\PRIMARY\\AXIAL', ...changes });
function stack(id, { modality = 'CT', unit = 'HU', count = 50, evidence = workflow(), stackIndex = 0, ...extra } = {}) {
    return { id, description: 'Synthetic stack ' + id, modality, stackIndex,
        frames: Array.from({ length: count }, (_, index) => ({ sopUid: `2.25.1000.${index + 1}`, frameIndex: 0,
            modality, unit, photometric: 'MONOCHROME2', orientation: [1, 0, 0, 0, 1, 0], bodyPartExamined: 'CHEST', workflow: evidence })), ...extra };
}
function harness({ loaded = [stack('ct')], catalog, origins, roles, layout = 1, annotations = [], onOpen, onLayout, onSynchronization, windowOverride, preserveWindowOverrides = false } = {}) {
    const state = { tool: 'window', playing: false }, logs = [], transforms = [], selections = [];
    const workspace = { layout, activeViewport: 0, synchronization: { slice: false, window: false, camera: false }, lastSync: [],
        viewports: Array.from({ length: layout }, (_, slot) => ({ slot, seriesIndex: slot === 0 ? 0 : null, frameIndex: slot === 0 ? 0 : null,
            window: slot === 0 ? { center: 25, width: 300 } : null, transform: { zoom: 1, panX: 0, panY: 0 }, ...(preserveWindowOverrides ? {windowOverride: windowOverride === true} : {}) })) };
    const active = () => workspace.viewports.find(pane => pane.slot === workspace.activeViewport);
    const automaticWindow = pane => { if (preserveWindowOverrides && !pane.windowOverride) pane.window = {center: 100 + (pane.frameIndex ?? 0) * 10, width: 2001}; };
    const originMap = origins ?? new Map();
    const api = { loaded, state, workspace, logs, transforms, selections,
        roles: roles ?? { patientId: null, currentStudyId: null, comparisonStudyId: null },
        catalog: catalog ?? { patients: [] }, annotations, revision: 0 };
    const viewer = {
        getWorkspaceState: () => clone(workspace), getState: () => clone(state),
        setActiveViewport(slot) { logs.push(['active', slot]); workspace.activeViewport = slot; },
        async setLayout(count) { logs.push(['layout', count]); workspace.layout = count;
            workspace.viewports = Array.from({ length: count }, (_, slot) => workspace.viewports[slot] ?? { slot, seriesIndex: null, frameIndex: null, window: null, transform: { zoom: 1 } });
            if (workspace.activeViewport >= count) workspace.activeViewport = 0;
            await onLayout?.(count, api);
        },
        async openSessionSeries(id, { viewport, stackIndex, signal }) {
            logs.push(['open', id, viewport, stackIndex]);
            await onOpen?.(id, { viewport, stackIndex, signal }, api);
            if (signal?.aborted) throw new DOMException('Canceled', 'AbortError');
            const index = loaded.findIndex(item => originMap.get(item)?.seriesId === id && item.stackIndex === stackIndex);
            if (index < 0) throw new Error('Synthetic series unavailable');
            workspace.viewports[viewport].seriesIndex = index; workspace.viewports[viewport].frameIndex = 0;
            automaticWindow(workspace.viewports[viewport]);
        },
        async assignViewportSeries(viewport, index) { logs.push(['assign', viewport, index]); workspace.viewports[viewport].seriesIndex = index; workspace.viewports[viewport].frameIndex = 0; automaticWindow(workspace.viewports[viewport]); },
        async setFrame(index) { logs.push(['frame', workspace.activeViewport, index]);
            const current = loaded[active().seriesIndex];
            if (!Number.isInteger(index) || index < 0 || index >= current.frames.length) throw new Error('Synthetic frame outside source');
            active().frameIndex = index;
            automaticWindow(active());
        },
        setWindow(value) { logs.push(['window', workspace.activeViewport, clone(value)]); active().window = clone(value); if (preserveWindowOverrides) active().windowOverride = true; },
        async setSynchronization(value) { logs.push(['synchronize', clone(value)]); workspace.synchronization = clone(value);
            await onSynchronization?.(value, api); return clone(workspace);
        },
        async clearViewport(slot) { logs.push(['clear', slot]); workspace.viewports[slot].seriesIndex = null; workspace.viewports[slot].frameIndex = null; workspace.viewports[slot].window = null; },
        reset() { logs.push(['reset', workspace.activeViewport]); active().transform.zoom = 1; if (preserveWindowOverrides) active().windowOverride = false; automaticWindow(active()); },
        play() { logs.push(['play', workspace.activeViewport]); state.playing = true; },
        pause() { logs.push(['pause', workspace.activeViewport]); state.playing = false; },
        setTool(tool) { logs.push(['tool', tool]); state.tool = tool; }
    };
    api.broker = createViewerWorkflow({ getViewer: () => viewer, getCatalog: () => api.catalog, getRoles: () => api.roles, getLoaded: () => loaded,
        getOrigin: item => originMap.get(item), getStackIndex: item => item.stackIndex, getMeasurements: () => api.annotations,
        getFrame: slot => { const pane = workspace.viewports.find(item => item.slot === slot); return loaded[pane?.seriesIndex]?.frames[pane?.frameIndex]; },
        getAnnotationRevision: () => api.revision,
        ...(preserveWindowOverrides ? {getWindowOverride: slot => workspace.viewports[slot]?.windowOverride === true} : typeof windowOverride === 'boolean' ? { getWindowOverride: () => windowOverride } : {}),
        restoreTransform: (slot, transform) => { transforms.push([slot, clone(transform)]); workspace.viewports[slot].transform = clone(transform); },
        selectAnnotation: id => selections.push(id) });
    return api;
}

function admitted(loaded, { groups = null, evidence = workflow() } = {}) {
    const origins = new Map(loaded.map(item => [item, { patientId: 'session-patient', studyId: 'session-study', seriesId: 'session-series' }]));
    const catalog = { patients: [{ id: 'session-patient', studies: [{ id: 'session-study', studyDate: '20260101', studyTime: '120000', description: 'Synthetic study',
        series: [{ id: 'session-series', seriesNumber: 7, modality: loaded[0].modality, description: 'Synthetic acquisition', status: 'loaded',
            frameCount: loaded.reduce((n, item) => n + item.frames.length, 0), workflow: evidence,
            stackGroups: groups ?? loaded.map((item, index) => ({ id: 'group-' + index, label: 'Acquisition ' + (index + 1), frameCount: item.frames.length })) }] }] }] };
    return { loaded, origins, catalog, roles: { patientId: 'session-patient', currentStudyId: 'session-study', comparisonStudyId: null } };
}

test('fresh preparation keeps the actual activePatientId role while every pane is temporarily empty', async () => {
    const data = admitted([stack('ct')]);
    data.roles = {activePatientId: 'session-patient', currentStudyId: 'session-study', comparisonStudyId: null};
    const h = harness(data), snapshot = h.broker.getSnapshot({mode: 'fresh'});
    assert.equal(snapshot.context.patientId, 'session-patient');
    const command = plan(choose({study: 'active', seriesNumber: 7}));
    await h.broker.execute(command, snapshot);
    assert.equal(h.broker.getSnapshot().context.patientId, 'session-patient');
    assert.equal(h.workspace.viewports[0].seriesIndex, 0);
    assert.deepEqual(h.logs.filter(item => ['clear', 'open'].includes(item[0])).map(item => item[0]), ['clear', 'open']);
    await h.broker.undo();
    assert.equal(h.workspace.viewports[0].seriesIndex, 0);
});

test('adapter aggregates evidence across all loaded frames and never overwrites contrast when orientation is unknown', () => {
    const source = stack('mixed', { evidence: workflow({ contrastBolusAgent: 'SYNTHETIC', imageOrientation: null }) });
    const h = harness({ loaded: [source] }), snapshot = h.broker.getSnapshot();
    const evidence = snapshot.context.panes[0].series.workflow;
    assert.equal(evidence.plane, 'unknown'); assert.equal(evidence.contrast, 'present'); assert.equal(evidence.bodyPart, 'chest');
    source.frames[20].workflow = workflow({ imageOrientation: null });
    assert.equal(h.broker.getSnapshot().context.panes[0].series.workflow.contrast, 'unknown');
});

test('orientation fallback runs only without workflow metadata and uses the actual bodyPartExamined field', () => {
    const source = stack('fallback'); source.frames.forEach(frame => { delete frame.workflow; frame.bodyPartExamined = 'LIVER'; });
    const h = harness({ loaded: [source] });
    const evidence = h.broker.getSnapshot().context.panes[0].series.workflow;
    assert.equal(evidence.plane, 'axial'); assert.equal(evidence.bodyPart, 'liver'); assert.equal(evidence.contrast, 'unknown');
});

test('multiple image stacks remain separate review choices with their own counts and exact stack indices', async () => {
    const a = stack('a', { count: 10, stackIndex: 0 }), b = stack('b', { count: 25, stackIndex: 1 });
    const h = harness(admitted([a, b])), command = plan(choose({ study: 'active', seriesNumber: 7 }));
    const snapshot = h.broker.getSnapshot(), preview = h.broker.preview(command, snapshot);
    assert.equal(preview.status, 'clarify'); assert.equal(preview.choices.length, 2);
    assert.match(preview.choices[0].label, /Image stack 1.*10 images/u); assert.match(preview.choices[1].label, /Image stack 2.*25 images/u);
    assert.notEqual(snapshot.context.studies[0].series[0].id, snapshot.context.studies[0].series[1].id);
    await h.broker.execute(command, snapshot, [preview.choices[1].id]);
    assert.deepEqual(h.logs.find(item => item[0] === 'open'), ['open', 'session-series', 0, 1]);
    assert.equal(h.workspace.viewports[0].seriesIndex, 1);
});

test('displayed stack duplicates to pane B without changing the selected image-stack group', async () => {
    const a = stack('a', { stackIndex: 0 }), b = stack('b', { stackIndex: 1 });
    const h = harness(admitted([a, b])); h.workspace.viewports[0].seriesIndex = 1;
    await h.broker.execute(plan({ type: 'layout', count: 2 }, choose({}, 1)), h.broker.getSnapshot());
    assert.deepEqual(h.logs.find(item => item[0] === 'open'), ['open', 'session-series', 1, 1]);
    assert.equal(h.workspace.viewports[1].seriesIndex, 1);
});

test('frame commands are one based and preserve the exact final requested ultrasound image', async () => {
    const h = harness({ loaded: [stack('us', { modality: 'US', unit: '', count: 42 })] });
    await h.broker.execute(plan({ type: 'cine', viewport: 0, playing: false }, { type: 'frame', viewport: 0, frame: 40 }), h.broker.getSnapshot());
    assert.deepEqual(h.logs.filter(item => item[0] === 'frame'), [['frame', 0, 39]]); assert.equal(h.workspace.viewports[0].frameIndex, 39); assert.equal(h.state.playing, false);
    await assert.rejects(h.broker.execute(plan({ type: 'frame', viewport: 0, frame: 43 }), h.broker.getSnapshot()), /outside.*series/u);
});

test('Undo retains automatic source windowing instead of converting it into an explicit override', async () => {
    const automatic = harness({ windowOverride: false });
    await automatic.broker.execute(plan({ type: 'tool', tool: 'pan' }), automatic.broker.getSnapshot());
    await automatic.broker.undo();
    assert.equal(automatic.logs.some(item => item[0] === 'window'), false);
    const explicit = harness({ windowOverride: true });
    await explicit.broker.execute(plan({ type: 'tool', tool: 'pan' }), explicit.broker.getSnapshot());
    await explicit.broker.undo();
    assert.deepEqual(explicit.logs.find(item => item[0] === 'window'), ['window', 0, { center: 25, width: 300 }]);
});

test('Continue window Undo removes a later explicit override when reopening the same source preserves it', async () => {
    const h = harness({preserveWindowOverrides: true});
    Object.assign(h.workspace.viewports[0], {frameIndex: 2, window: {center: 120, width: 2001}, transform: {zoom: 4, panX: 7, panY: -3}});
    const before = clone(h.workspace), command = plan({type: 'window', viewport: 'active', preset: 'bone'});
    await h.broker.execute(command, h.broker.getSnapshot({mode: 'continue'}));
    assert.equal(h.workspace.viewports[0].windowOverride, true); assert.deepEqual(h.workspace.viewports[0].window, {center: 500, width: 2000});
    await h.broker.undo();
    assert.deepEqual(h.workspace, before); assert.equal(h.logs.filter(item => item[0] === 'reset').length, 1);
    const reset = h.logs.findIndex(item => item[0] === 'reset'), seek = h.logs.findIndex((item, index) => index > reset && item[0] === 'frame');
    assert.ok(reset >= 0 && seek > reset); assert.equal(h.logs.filter(item => item[0] === 'window').length, 1, 'Automatic restoration must not create a new explicit numeric override.');
});

test('retaining automatic pane B into an explicitly windowed pane A resets its override before restoring B frame and camera', async () => {
    const a = stack('old-a'), b = stack('active-b');
    const h = harness({loaded: [a, b], layout: 2, preserveWindowOverrides: true});
    Object.assign(h.workspace.viewports[0], {windowOverride: true, window: {center: -600, width: 1500}});
    Object.assign(h.workspace.viewports[1], {seriesIndex: 1, frameIndex: 2, window: {center: 120, width: 2001}, windowOverride: false, transform: {zoom: 3, panX: -4, panY: 8}});
    h.workspace.activeViewport = 1; const before = clone(h.workspace);
    await h.broker.execute(plan({type: 'layout', count: 1}), h.broker.getSnapshot({mode: 'continue'}));
    assert.equal(h.workspace.viewports[0].seriesIndex, 1); assert.equal(h.workspace.viewports[0].frameIndex, 2); assert.equal(h.workspace.viewports[0].windowOverride, false);
    assert.deepEqual(h.workspace.viewports[0].window, {center: 120, width: 2001}); assert.deepEqual(h.workspace.viewports[0].transform, before.viewports[1].transform);
    await h.broker.undo(); assert.deepEqual(h.workspace, before);
});

test('fresh execution clears only presentation and restores panes, playback and measurements with Undo', async () => {
    const source = stack('ct');
    const h = harness({loaded: [source], layout: 2, annotations: [{id: 'kept-annotation', image: {sopUid: '2.25.1000.1', frameNumber: 1}}]});
    h.workspace.activeViewport = 1; h.workspace.viewports[1].seriesIndex = 0; h.workspace.viewports[1].frameIndex = 12;
    h.state.playing = true; const before = clone(h.workspace), annotations = clone(h.annotations);
    const command = plan({type: 'select-series', viewport: 'active', selector: selector({study: 'active'})}, {type: 'window', viewport: 'active', preset: 'lung'});
    const snapshot = h.broker.getSnapshot({mode: 'fresh'});
    assert.equal(h.broker.preview(command, snapshot).status, 'ready'); assert.deepEqual(h.logs, []);
    await h.broker.execute(command, snapshot);
    assert.deepEqual(h.logs.slice(0, 4), [['pause', 1], ['synchronize', {slice: false, window: false, camera: false}], ['layout', 1], ['clear', 0]]);
    assert.equal(h.loaded.length, 1); assert.deepEqual(h.annotations, annotations); assert.equal(h.workspace.layout, 1);
    assert.equal(h.workspace.activeViewport, 0); assert.equal(h.workspace.viewports[0].seriesIndex, 0);
    await h.broker.undo(); assert.deepEqual(h.workspace, before); assert.equal(h.state.playing, true); assert.deepEqual(h.annotations, annotations);
});

test('continue one-pane layout preserves active pane B source, frame and camera before applying a requested window', async () => {
    for (const windowOverride of [false, true]) {
        const a = stack('old-a', {modality: 'MR', unit: ''}), b = stack('active-b', {count: 228});
        const h = harness({loaded: [a, b], layout: 2, windowOverride});
        Object.assign(h.workspace.viewports[1], {seriesIndex: 1, frameIndex: 33, window: {center: 37, width: 500}, transform: {zoom: 3, panX: 4, panY: -7}});
        h.workspace.activeViewport = 1; const before = clone(h.workspace);
        const command = plan({type: 'layout', count: 1}, {type: 'window', viewport: 'active', preset: 'lung'});
        const snapshot = h.broker.getSnapshot({mode: 'continue'}), preview = h.broker.preview(command, snapshot);
        assert.equal(preview.status, 'ready'); assert.match(preview.actions[1].label, /previously active image in pane A/u); assert.deepEqual(h.logs, []);
        await h.broker.execute(command, snapshot);
        assert.equal(h.workspace.viewports[0].seriesIndex, 1); assert.equal(h.workspace.viewports[0].frameIndex, 33); assert.deepEqual(h.workspace.viewports[0].transform, before.viewports[1].transform);
        assert.deepEqual(h.workspace.viewports[0].window, {center: -600, width: 1500});
        const windows = h.logs.filter(item => item[0] === 'window'); assert.equal(windows.length, windowOverride ? 2 : 1);
        if (windowOverride) assert.deepEqual(windows[0], ['window', 0, {center: 37, width: 500}]);
        await h.broker.undo();
        if (windowOverride) assert.deepEqual(h.workspace, before);
        else {
            // The fake viewer does not calculate per-frame automatic windows;
            // verify source/frame/camera restoration and no explicit override.
            const withoutWindows = workspace => ({...workspace, viewports: workspace.viewports.map(({window, ...pane}) => pane)});
            assert.deepEqual(withoutWindows(h.workspace), withoutWindows(before)); assert.equal(h.logs.filter(item => item[0] === 'window').length, 1);
        }
    }
});

test('cancellation during active-pane retention restores the full previous layout without applying later steps', async () => {
    const a = stack('old-a', {stackIndex: 0}), b = stack('active-b', {stackIndex: 1}); let cancelOnce = true;
    const h = harness({...admitted([a, b]), layout: 2, onOpen: (id, options, current) => {
        if (cancelOnce && options.viewport === 0 && options.stackIndex === 1) { cancelOnce = false; current.broker.cancel(); }
    }});
    h.workspace.viewports[1].seriesIndex = 1; h.workspace.viewports[1].frameIndex = 21; h.workspace.activeViewport = 1; const before = clone(h.workspace);
    await assert.rejects(h.broker.execute(plan({type: 'layout', count: 1}, {type: 'tool', tool: 'ellipse'}), h.broker.getSnapshot({mode: 'continue'})), {name: 'AbortError'});
    assert.deepEqual(h.workspace, before); assert.equal(h.logs.some(item => item[0] === 'tool' && item[1] === 'ellipse'), false);
});

for (const [preset, expected] of [['lung', { center: -600, width: 1500 }], ['soft-tissue', { center: 40, width: 400 }], ['bone', { center: 500, width: 2000 }], ['brain', { center: 40, width: 80 }]]) {
    test(`CT preset has independent numeric HU expectation: ${preset}`, async () => {
        const h = harness();
        await h.broker.execute(plan({ type: 'window', viewport: 0, preset }), h.broker.getSnapshot());
        assert.deepEqual(h.logs.find(item => item[0] === 'window'), ['window', 0, expected]);
    });
}

for (const [label, changes] of [['uncalibrated', { unit: '' }], ['PET units', { unit: 'BQML' }], ['color pixels', { unit: 'HU', photometric: 'RGB' }]]) {
    test(`CT presets reject ${label} without inventing HU calibration`, async () => {
        const source = stack('ct'); Object.assign(source.frames[0], changes);
        const h = harness({ loaded: [source] });
        await assert.rejects(h.broker.execute(plan({ type: 'window', viewport: 0, preset: 'lung' }), h.broker.getSnapshot()), /calibrated HU/u);
        assert.equal(h.logs.some(item => item[0] === 'window' && item[2].center === -600), false);
    });
}

test('existing measurement resolves its SOP/frame reference and selects the original annotation', async () => {
    const source = stack('ct');
    const h = harness({ loaded: [source], annotations: [{ id: 'original-measurement', image: { sopUid: source.frames[17].sopUid, frameNumber: 1 } }] });
    await h.broker.execute(plan({ type: 'last-measurement', viewport: 0 }), h.broker.getSnapshot());
    assert.deepEqual(h.logs.find(item => item[0] === 'frame'), ['frame', 0, 17]); assert.deepEqual(h.selections, ['original-measurement']);
    assert.equal(h.annotations.length, 1); assert.equal(h.revision, 0);
});

test('undo restores layout, original stack, frame, window, transform, tool, links and playing state', async () => {
    const h = harness(); h.workspace.viewports[0].frameIndex = 12; h.workspace.viewports[0].transform = { zoom: 2, panX: 15, panY: -3 };
    h.state.playing = true; h.state.tool = 'probe';
    const before = h.broker.getSnapshot();
    await h.broker.execute(plan({ type: 'layout', count: 2 }, choose({}, 1), { type: 'tool', tool: 'length' }), before);
    assert.equal(h.state.tool, 'distance'); await h.broker.undo();
    assert.equal(h.workspace.layout, 1); assert.equal(h.workspace.viewports[0].frameIndex, 12);
    assert.deepEqual(h.workspace.viewports[0].window, { center: 25, width: 300 });
    assert.deepEqual(h.workspace.viewports[0].transform, { zoom: 2, panX: 15, panY: -3 });
    assert.equal(h.state.tool, 'probe'); assert.equal(h.state.playing, true);
    assert.deepEqual(h.workspace.synchronization, before.context.synchronization);
});

test('external interruption during undo prevents later restoration from overwriting the user workspace', async () => {
    let intercept = false;
    const h = harness({ onLayout: (count, api) => {
        if (intercept) { api.workspace.viewports[0].frameIndex = 31; api.workspace.viewports[0].transform.zoom = 4; api.broker.interrupt(); }
    } });
    await h.broker.execute(plan({ type: 'tool', tool: 'pan' }), h.broker.getSnapshot());
    intercept = true;
    await assert.rejects(h.broker.undo(), { name: 'AbortError' });
    assert.equal(h.workspace.viewports[0].frameIndex, 31); assert.equal(h.workspace.viewports[0].transform.zoom, 4);
    assert.equal(h.logs.some(item => item[0] === 'assign'), false); assert.equal(h.transforms.length, 0);
});

test('patient change during restore stops before reopening or transforming the previous patient images', async () => {
    let changePatient = false;
    const h = harness({ roles: { patientId: 'synthetic-patient' }, onLayout: (count, api) => { if (changePatient) api.roles.patientId = 'different-synthetic-patient'; } });
    await h.broker.execute(plan({ type: 'tool', tool: 'zoom' }), h.broker.getSnapshot()); changePatient = true;
    await assert.rejects(h.broker.undo(), /patient workspace changed/u);
    assert.equal(h.logs.some(item => item[0] === 'assign'), false); assert.equal(h.transforms.length, 0);
});

test('unmatched geometry is reported instead of claiming registration or synchronized prior images', async () => {
    const h = harness({ onSynchronization: (value, api) => { api.workspace.lastSync = [{ slot: 1, matched: false, reason: 'frame-of-reference-mismatch' }]; } });
    const result = await h.broker.execute(plan({ type: 'synchronize', slice: true, window: false, camera: false }), h.broker.getSnapshot());
    assert.match(result.message, /1 pane remains unlinked/u); assert.match(result.message, /No registration was inferred/u);
});


test('play and seek with active viewport target pane B and preserve pane A', async () => {
    const h = harness({ loaded: [stack('us', { modality: 'US', unit: '', count: 42 })], layout: 2 });
    h.workspace.activeViewport = 1; h.workspace.viewports[1].seriesIndex = 0; h.workspace.viewports[1].frameIndex = 0;
    await h.broker.execute(plan({ type: 'cine', viewport: 'active', playing: true }, { type: 'cine', viewport: 'active', playing: false },
        { type: 'frame', viewport: 'active', frame: 40 }), h.broker.getSnapshot());
    assert.deepEqual(h.logs.filter(item => ['play', 'pause', 'frame'].includes(item[0])), [['play', 1], ['pause', 1], ['frame', 1, 39]]);
    assert.equal(h.workspace.viewports[0].frameIndex, 0); assert.equal(h.workspace.viewports[1].frameIndex, 39);
});

for (const method of ['addAnnotation', 'removeAnnotation', 'importAnnotations', 'undoAnnotations', 'redoAnnotations', 'clearAnnotations']) {
    test(`public ${method} interrupts an awaited task before preserving the caller's annotation change`, async () => {
        let entered, release; const started = new Promise(resolve => { entered = resolve; });
        const h = harness({onLayout: async () => { entered(); await new Promise(resolve => { release = resolve; }); }});
        const original = {marker: 'synthetic-annotation-change'}, api = {[method](value) { assert.equal(value, original); h.revision++; h.annotations.push({id: 'synthetic-user-edit'}); return 'caller-result'; }};
        wrapWorkflowMutation(api, h.broker, method);
        const pending = h.broker.execute(plan({type: 'layout', count: 2}, {type: 'tool', tool: 'pan'}), h.broker.getSnapshot());
        await started; assert.equal(api[method](original), 'caller-result'); release();
        await assert.rejects(pending, {name: 'AbortError'});
        assert.equal(h.revision, 1); assert.equal(h.annotations.at(-1).id, 'synthetic-user-edit'); assert.equal(h.logs.some(item => item[0] === 'tool'), false); assert.equal(h.transforms.length, 0);
        await assert.rejects(h.broker.undo(), /no completed/u);
    });
}
