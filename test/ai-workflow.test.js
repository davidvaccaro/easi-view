import test from 'node:test';
import assert from 'node:assert/strict';
import {AiWorkflowController} from '../src/ai/AiWorkflowController.js';
import {AiVoiceCapture} from '../src/ui/AiVoiceCapture.js';
import {AiWorkflowPanel} from '../src/ui/AiWorkflowPanel.js';
import {AiAssistIntegration} from '../src/integration/AiAssistIntegration.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
const plan = () => ({version: 1, status: 'ready', summary: 'Display two panes.', question: null, actions: [{type: 'layout', count: 2}]});
function controllerFixture({client: overrides = {}, broker: brokerOverrides = {}} = {}) {
    const requests = [], runs = [], previews = [], state = [], snapshot = {mode: 'fresh', patient: 'PRIVATE_LOCAL_PATIENT', catalog: ['PRIVATE_LOCAL_SERIES']};
    const client = {planCommand: async (command, options) => { requests.push({command, options}); return {version: 1, model: 'test-model', plan: plan()}; }, transcribeCommand: async recording => { requests.push({recording}); return {text: 'Display two panes.'}; }, cancel() {}, ...overrides};
    const broker = {getSnapshot: ({mode}) => { snapshot.mode = mode; return snapshot; }, preview: (value, source, choices) => { previews.push({value, source, choices}); return {status: 'ready', actions: [{label: 'Switch to two panes'}], message: 'Ready', choices: []}; }, execute: async (...args) => { runs.push(args); return {message: 'Applied', canUndo: true}; }, undo: async () => {}, cancel() {}, ...brokerOverrides};
    const controller = new AiWorkflowController({client, broker, onChange: value => state.push(value)});
    return {controller, requests, runs, previews, state, snapshot};
}

test('workflow never plans or executes on construction or typing and never transmits its local snapshot', async () => {
    const f = controllerFixture(); try {
        f.controller.setCommand('Display two panes.'); assert.equal(f.requests.length, 0); assert.equal(f.runs.length, 0);
        await f.controller.plan(); assert.deepEqual(Object.keys(f.requests[0]).sort(), ['command', 'options']); assert.equal(f.requests[0].command, 'Display two panes.'); assert.equal(f.previews[0].source, f.snapshot); assert.equal(f.runs.length, 0);
        assert.ok(!JSON.stringify(f.controller.getOperationalState()).includes('PRIVATE')); assert.ok(!JSON.stringify(f.controller.getOperationalState()).includes('Display'));
        await f.controller.run(); assert.equal(f.runs.length, 1); assert.equal(f.runs[0][1], f.snapshot); assert.equal(f.controller.getState().canUndo, true);
        await f.controller.undo(); assert.equal(f.controller.getState().canUndo, false);
    } finally { f.controller.dispose(); }
});

test('transcription returns editable text and requires a later explicit planning action', async () => {
    const f = controllerFixture(); try {
        await f.controller.transcribe({mimeType: 'audio/webm', audio: 'AQID'}); assert.equal(f.requests.length, 1); assert.equal(f.controller.getState().command, 'Display two panes.'); assert.equal(f.controller.getState().plan, null); assert.match(f.controller.getState().message, /Review and edit/);
        f.controller.setCommand('Display four panes.'); await f.controller.plan(); assert.equal(f.requests[1].command, 'Display four panes.'); assert.equal(f.runs.length, 0);
    } finally { f.controller.dispose(); }
});

test('grouped ambiguity is resolved locally and cannot run before every required choice is reviewed', async () => {
    const f = controllerFixture({broker: {preview: (_, __, ids) => ids.length < 2 ? {status: 'clarify', message: 'Choose both series', actions: [], choices: [{id: 'current-a', label: 'Current CT', group: 'current'}, {id: 'prior-a', label: 'Prior CT', group: 'prior'}]} : {status: 'ready', message: 'Both selected', actions: [{label: 'Compare chosen series'}], choices: []}}});
    try {
        f.controller.setCommand('Compare current and prior CT.'); await f.controller.plan(); assert.throws(() => f.controller.run(), /Review/);
        await f.controller.choose('current-a'); assert.throws(() => f.controller.run(), /Review/); await f.controller.choose('prior-a'); assert.equal(f.requests.length, 1);
        await f.controller.run(); assert.deepEqual(f.runs[0][2], ['current-a', 'prior-a']);
    } finally { f.controller.dispose(); }
});

test('clarifying and unsupported model plans remain inert and ask for a revised command', async () => {
    for (const status of ['clarify', 'unsupported']) {
        const f = controllerFixture({client: {planCommand: async () => ({plan: {version: 1, status, summary: 'No supported task yet.', question: status === 'clarify' ? 'Which view?' : null, actions: []}})}});
        try { f.controller.setCommand('An ambiguous task.'); await f.controller.plan(); assert.equal(f.controller.getState().preview.status, status); assert.throws(() => f.controller.run()); assert.equal(f.runs.length, 0); } finally { f.controller.dispose(); }
    }
});

test('editing a reviewed command removes its executable plan without fetching another', async () => {
    const f = controllerFixture(); try { f.controller.setCommand('Display two panes.'); await f.controller.plan(); f.controller.setCommand('Display four panes.'); assert.equal(f.controller.getState().plan, null); assert.throws(() => f.controller.run()); assert.equal(f.requests.length, 1); } finally { f.controller.dispose(); }
});

test('cancel ignores a late planning response and never applies it to the new task', async () => {
    let release, signal;
    const f = controllerFixture({client: {planCommand: (_, options) => { signal = options.signal; return new Promise(resolve => { release = resolve; }); }}});
    f.controller.setCommand('Display two panes.'); const pending = f.controller.plan(); await turn(); f.controller.cancel(); assert.equal(signal.aborted, true); release({plan: plan()}); await pending;
    assert.equal(f.controller.getState().phase, 'cancelled'); assert.equal(f.controller.getState().plan, null); assert.equal(f.runs.length, 0); f.controller.dispose();
});

test('a failed or canceled new execution clears Undo from the superseded completed task', async () => {
    for (const outcome of ['failure', 'cancel']) {
        let attempts = 0, release;
        const f = controllerFixture({broker: {execute: async (...args) => {
            if (++attempts === 1) return {canUndo: true};
            if (outcome === 'failure') throw new Error('Generated execution failure');
            await new Promise(resolve => { release = resolve; });
            if (args[3].signal.aborted) throw new DOMException('Canceled', 'AbortError');
        }}});
        try {
            f.controller.setCommand('Display two panes.'); await f.controller.plan(); await f.controller.run();
            f.controller.newRequest(); assert.equal(f.controller.getState().canUndo, true);
            f.controller.setCommand('Start a different task.'); await f.controller.plan();
            assert.equal(f.controller.getState().canUndo, true);
            const pending = f.controller.run();
            assert.equal(f.controller.getState().canUndo, false);
            if (outcome === 'cancel') { f.controller.cancel(); release(); }
            await pending; assert.equal(f.controller.getState().canUndo, false); assert.throws(() => f.controller.undo());
        } finally { f.controller.dispose(); }
    }
});

test('local broker failure becomes a controlled UI message without leaking private details', async () => {
    const f = controllerFixture({broker: {execute: async () => { throw new Error('PRIVATE_LOCAL_FAILURE'); }}}); try {
        f.controller.setCommand('Display two panes.'); await f.controller.plan(); await f.controller.run(); assert.equal(f.controller.getState().phase, 'error'); assert.ok(!JSON.stringify(f.controller.getState()).includes('PRIVATE')); assert.equal(f.controller.getState().canUndo, false);
    } finally { f.controller.dispose(); }
});

class Recorder extends EventTarget {
    static instances = [];
    static isTypeSupported(type) { return type === 'audio/webm'; }
    constructor(stream, {mimeType}) { super(); this.stream = stream; this.mimeType = mimeType; this.state = 'inactive'; Recorder.instances.push(this); }
    start() { this.state = 'recording'; }
    data(bytes) { const event = new Event('dataavailable'); event.data = new Blob([bytes]); this.dispatchEvent(event); }
    stop() { this.state = 'inactive'; queueMicrotask(() => this.dispatchEvent(new Event('stop'))); }
}
function voiceFixture(overrides = {}) {
    let stopped = 0, requested = 0; const recordings = [], states = [], errors = [], stream = {getTracks: () => [{stop() { stopped++; }}]};
    const voice = new AiVoiceCapture({MediaRecorder: Recorder, mediaDevices: {async getUserMedia(options) { requested++; assert.deepEqual(options, {audio: true, video: false}); return stream; }}, onRecording: value => recordings.push(value), onState: value => states.push(value), onError: value => errors.push(value), ...overrides});
    return {voice, recordings, states, errors, requested: () => requested, stopped: () => stopped};
}

test('microphone is requested only by Start and Stop produces bounded audio while releasing every track', async () => {
    const f = voiceFixture(); try { assert.equal(f.requested(), 0); await f.voice.start(); const recorder = Recorder.instances.at(-1); recorder.data(new Uint8Array([1, 2, 3])); assert.equal(f.recordings.length, 0); f.voice.stop(); await turn(); assert.equal(f.stopped(), 1); assert.deepEqual(f.recordings[0], {mimeType: 'audio/webm', audio: 'AQID'}); } finally { f.voice.dispose(); }
});

test('microphone permission denial has an actionable message and never produces audio', async () => {
    const f = voiceFixture({mediaDevices: {getUserMedia: async () => { throw Object.assign(new Error('private device detail'), {name: 'NotAllowedError'}); }}}); try { await f.voice.start(); assert.match(f.errors[0], /permission was not granted/); assert.equal(f.recordings.length, 0); assert.ok(!f.errors[0].includes('private')); } finally { f.voice.dispose(); }
});

test('cancel during a pending microphone permission releases the later stream and never records', async () => {
    let release, stopped = 0; const f = voiceFixture({mediaDevices: {getUserMedia: () => new Promise(resolve => { release = resolve; })}}); const pending = f.voice.start(); f.voice.cancel(); release({getTracks: () => [{stop() { stopped++; }}]}); await pending; assert.equal(stopped, 1); assert.equal(f.recordings.length, 0); f.voice.dispose();
});

test('a stale rejected permission request cannot stop a newer successful recording', async () => {
    let rejectOld, resolveCurrent, requested = 0, stoppedCurrent = 0;
    const f = voiceFixture({mediaDevices: {getUserMedia: () => ++requested === 1 ? new Promise((_, reject) => { rejectOld = reject; }) : new Promise(resolve => { resolveCurrent = resolve; })}});
    try {
        const old = f.voice.start(); f.voice.cancel(); const current = f.voice.start();
        resolveCurrent({getTracks: () => [{stop() { stoppedCurrent++; }}]}); await current;
        const recorder = Recorder.instances.at(-1); assert.equal(recorder.state, 'recording');
        rejectOld(Object.assign(new Error('Synthetic stale permission rejection'), {name: 'NotAllowedError'})); await old;
        assert.equal(stoppedCurrent, 0); assert.equal(recorder.state, 'recording'); assert.equal(f.errors.length, 0);
        recorder.data(new Uint8Array([1, 2, 3])); f.voice.stop(); await turn();
        assert.equal(stoppedCurrent, 1); assert.deepEqual(f.recordings, [{mimeType: 'audio/webm', audio: 'AQID'}]);
    } finally { f.voice.dispose(); }
});

test('oversized recordings are discarded and source tracks are stopped', async () => {
    const f = voiceFixture(); try { await f.voice.start(); Recorder.instances.at(-1).data(new Uint8Array(2097153)); await turn(); assert.equal(f.recordings.length, 0); assert.equal(f.stopped(), 1); assert.match(f.errors[0], /exceeded 2 MiB/); } finally { f.voice.dispose(); }
});

test('recording automatically stops at the fixed twenty-second limit', async context => {
    context.mock.timers.enable({apis: ['setTimeout']});
    const f = voiceFixture(); try { await f.voice.start(); const recorder = Recorder.instances.at(-1); recorder.data(new Uint8Array([1, 2, 3])); context.mock.timers.tick(19999); assert.equal(recorder.state, 'recording'); context.mock.timers.tick(1); await turn(); assert.equal(recorder.state, 'inactive'); assert.equal(f.stopped(), 1); assert.equal(f.recordings.length, 1); } finally { f.voice.dispose(); context.mock.timers.reset(); }
});

test('closing/disposal discards recorded audio and a late old stop cannot end a new capture', async () => {
    const f = voiceFixture(); await f.voice.start(); const old = Recorder.instances.at(-1); old.data(new Uint8Array([1])); f.voice.cancel(); await f.voice.start(); await turn(); assert.equal(Recorder.instances.at(-1).state, 'recording'); assert.equal(f.stopped(), 1); f.voice.dispose(); await turn(); assert.equal(f.stopped(), 2); assert.equal(f.recordings.length, 0);
});

class Element extends EventTarget {
    constructor(tagName, ownerDocument) { super(); Object.assign(this, {tagName, ownerDocument, children: [], parentNode: null, attributes: {}, dataset: {}, hidden: false, disabled: false, value: '', _text: ''}); }
    get textContent() { return this._text + this.children.map(item => item.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.replaceChildren(); }
    set innerHTML(_) { throw new Error('AI text must remain inert.'); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
    append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
    focus() { this.ownerDocument.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; }
}
const walk = root => root.children.flatMap(item => [item, ...walk(item)]);
function panelFixture(voiceOptions = {}) {
    const document = {createElement: tag => new Element(tag, document)}, root = document.createElement('div'), events = [];
    const panel = new AiWorkflowPanel(root, {onCommand: value => events.push(['command', value]), onPlan: () => events.push(['plan']), onRun: () => events.push(['run']), onCancel: () => events.push(['cancel']), onMode: mode => events.push(['mode', mode]), onNewRequest: () => events.push(['new-request'])}, {mediaDevices: {}, MediaRecorder: null, ...voiceOptions});
    const node = action => walk(root).find(item => item.dataset.aiWorkflowAction === action), send = (type, target) => { const event = new Event(type); Object.defineProperty(event, 'target', {value: target}); root.dispatchEvent(event); };
    return {panel, root, events, node, send, command: walk(root).find(item => item.tagName === 'textarea')};
}

test('workflow UI labels the editable command and separates Plan from explicit Run', () => {
    const f = panelFixture(); try {
        assert.equal(f.events.length, 0); const label = walk(f.root).find(item => item.tagName === 'label' && item.attributes.for === f.command.id); assert.equal(label.attributes.for, f.command.id); assert.equal(f.command.maxLength, 1200);
        f.panel.update({configured: true, command: 'Use two panes.'}); f.send('click', f.node('plan')); assert.deepEqual(f.events, [['plan']]);
        f.panel.update({phase: 'review', plan: plan(), preview: {status: 'clarify', actions: [], choices: []}}); assert.equal(f.node('run').disabled, true);
        f.panel.update({preview: {status: 'ready', actions: [{label: '<script>inert</script>'}], choices: []}}); assert.equal(f.node('run').disabled, false); assert.ok(f.root.textContent.includes('<script>inert</script>')); f.send('click', f.node('run')); assert.deepEqual(f.events.at(-1), ['run']);
    } finally { f.panel.dispose(); }
});

test('workflow UI busy state locks task changes but leaves Cancel available and explains voice transmission', () => {
    const f = panelFixture(); try { f.panel.update({configured: true, busy: true, phase: 'planning', command: 'Use two panes.'}); assert.equal(f.command.disabled, true); assert.equal(f.node('plan').disabled, true); assert.equal(f.node('cancel').disabled, false); f.send('click', f.node('cancel')); assert.deepEqual(f.events.at(-1), ['cancel']); assert.match(f.root.textContent, /Review and edit the returned transcript before planning/); assert.match(f.root.textContent, /session catalog stay local/); } finally { f.panel.dispose(); }
});

test('completed task Undo survives actual dialog close and reopen while invalidation revokes it', async () => {
    const document = {activeElement: null, createElement: tag => new Element(tag, document)}, root = document.createElement('div');
    let undone = 0, inference = 0;
    const broker = {getSnapshot: ({mode}) => ({mode, privateLocalContext: true}), preview: () => ({status: 'ready', actions: [{label: 'Use two panes'}], choices: []}), execute: async () => ({canUndo: true}), undo: async () => { undone++; }, cancel() {}};
    const bridge = new AiAssistIntegration(root, {configuration: {baseUrl: 'https://gateway.example/api/ai', model: 'test-model'}, workflow: broker,
        fetchImpl: async () => { inference++; return new Response(JSON.stringify({version: 1, model: 'test-model', plan: plan()}), {headers: {'Content-Type': 'application/json'}}); }});
    const workflowRoot = () => walk(root).find(node => node.className === 'ai-assist-workflow');
    const click = action => { const event = new Event('click'); Object.defineProperty(event, 'target', {value: walk(root).find(node => node.dataset.aiWorkflowAction === action)}); workflowRoot().dispatchEvent(event); };
    const setCommand = () => { const input = walk(root).find(node => node.className === 'ai-workflow-command'); input.value = 'Use two panes.'; const event = new Event('input'); Object.defineProperty(event, 'target', {value: input}); workflowRoot().dispatchEvent(event); };
    try {
        bridge.open();
        const modeInput = walk(root).find(node => node.dataset.aiWorkflowMode); modeInput.value = 'continue'; const modeEvent = new Event('change'); Object.defineProperty(modeEvent, 'target', {value: modeInput}); workflowRoot().dispatchEvent(modeEvent);
        assert.equal(bridge.getState().workflowMode, 'continue'); setCommand(); click('plan'); await turn(); click('run'); await turn(); assert.equal(bridge.getState().canUndoTask, true);
        bridge.close(); bridge.open(); assert.equal(bridge.getState().workflowMode, 'fresh'); assert.equal(bridge.getState().canUndoTask, true); assert.equal(walk(root).find(node => node.dataset.aiWorkflowAction === 'undo').disabled, false); assert.equal(walk(root).find(node => node.className === 'ai-workflow-command').value, '');
        click('undo'); await turn(); assert.equal(undone, 1); assert.equal(inference, 1); assert.equal(bridge.getState().canUndoTask, false);
        setCommand(); click('plan'); await turn(); click('run'); await turn(); assert.equal(bridge.getState().canUndoTask, true); bridge.invalidate(); assert.equal(bridge.getState().canUndoTask, false);
    } finally { bridge.dispose(); }
});

test('request mode defaults fresh and is captured locally and sent as a bounded planning option before preview', async () => {
    const order = [], f = controllerFixture({broker: {getSnapshot: ({mode}) => { order.push(['snapshot', mode]); return {mode}; }, preview: (_, snapshot) => { order.push(['preview', snapshot.mode]); return {status: 'ready', actions: [{label: 'Prepare current view'}], choices: []}; }}, client: {planCommand: async (_, options) => { order.push(['plan', options.mode]); return {plan: plan()}; }}});
    try {
        assert.equal(f.controller.getState().mode, 'fresh'); assert.equal(f.controller.getOperationalState().mode, 'fresh');
        f.controller.setMode('continue'); f.controller.setCommand('Change the current view.'); assert.deepEqual(order, []);
        await f.controller.plan(); assert.deepEqual(order, [['snapshot', 'continue'], ['plan', 'continue'], ['preview', 'continue']]);
        await f.controller.run(); assert.equal(f.runs[0][1].mode, 'continue');
        assert.throws(() => f.controller.setMode('PRIVATE_MODE'), /starting point/); assert.equal(f.controller.getState().mode, 'continue');
    } finally { f.controller.dispose(); }
});

test('changing request mode preserves command and Undo but invalidates reviewed choices without inference or execution', async () => {
    const f = controllerFixture(); try {
        f.controller.setCommand('Display two panes.'); await f.controller.plan(); await f.controller.run();
        await f.controller.plan(); assert.ok(f.controller.getState().preview); const calls = f.requests.length, executions = f.runs.length;
        f.controller.setMode('continue'); const state = f.controller.getState();
        assert.equal(state.command, 'Display two panes.'); assert.equal(state.mode, 'continue'); assert.equal(state.canUndo, true); assert.equal(state.plan, null); assert.equal(state.preview, null); assert.deepEqual(state.selectedChoices, []); assert.equal(state.error, null);
        assert.equal(f.requests.length, calls); assert.equal(f.runs.length, executions); assert.throws(() => f.controller.run(), /Review/);
        await f.controller.plan(); assert.equal(f.requests.at(-1).options.mode, 'continue');
    } finally { f.controller.dispose(); }
});

test('New request clears reviewed text and errors, resets fresh and preserves the prior task Undo without source execution', async () => {
    let undo = 0; const f = controllerFixture({broker: {undo: async () => { undo++; }}}); try {
        f.controller.setMode('continue'); f.controller.setCommand('Display two panes.'); await f.controller.plan(); await f.controller.run();
        await f.controller.plan(); const calls = f.requests.length, executions = f.runs.length; f.controller.newRequest();
        assert.deepEqual({...f.controller.getState(), canUndo: false}, {mode: 'fresh', phase: 'idle', command: '', plan: null, preview: null, selectedChoices: [], message: '', error: null, canUndo: false, busy: false});
        assert.equal(f.controller.getState().canUndo, true); assert.equal(f.requests.length, calls); assert.equal(f.runs.length, executions);
        await f.controller.undo(); assert.equal(undo, 1);
    } finally { f.controller.dispose(); }
    const errorFixture = controllerFixture({client: {planCommand: async () => { throw Object.assign(new Error('PRIVATE_SERVICE_ERROR'), {code: 'unauthorized'}); }}});
    try { errorFixture.controller.setMode('continue'); errorFixture.controller.setCommand('Display two panes.'); await errorFixture.controller.plan(); assert.equal(errorFixture.controller.getState().error.code, 'unauthorized'); errorFixture.controller.newRequest(); assert.equal(errorFixture.controller.getState().mode, 'fresh'); assert.equal(errorFixture.controller.getState().error, null); } finally { errorFixture.controller.dispose(); }
});

test('planning locks mode and New request; cancellation retains the editable command and selected mode', async () => {
    let release; const f = controllerFixture({client: {planCommand: () => new Promise(resolve => { release = resolve; })}}); try {
        f.controller.setMode('continue'); f.controller.setCommand('Adjust the current view.'); const pending = f.controller.plan(); await turn();
        f.controller.setMode('fresh'); f.controller.newRequest(); assert.equal(f.controller.getState().mode, 'continue'); assert.equal(f.controller.getState().command, 'Adjust the current view.');
        f.controller.cancel(); release({plan: plan()}); await pending;
        assert.equal(f.controller.getState().mode, 'continue'); assert.equal(f.controller.getState().command, 'Adjust the current view.'); assert.equal(f.controller.getState().plan, null); assert.equal(f.runs.length, 0);
    } finally { f.controller.dispose(); }
});

test('transcription and subsequent editing retain the chosen mode; a canceled late transcript cannot replace it', async () => {
    const f = controllerFixture(); try {
        f.controller.setMode('continue'); await f.controller.transcribe({mimeType: 'audio/webm', audio: 'AQID'}); f.controller.setCommand('Adjust this existing view.');
        assert.equal(f.controller.getState().mode, 'continue'); await f.controller.plan(); assert.equal(f.requests.at(-1).options.mode, 'continue');
    } finally { f.controller.dispose(); }
    let release; const cancelled = controllerFixture({client: {transcribeCommand: () => new Promise(resolve => { release = resolve; })}}); try {
        cancelled.controller.setMode('continue'); cancelled.controller.setCommand('Keep this draft.'); const pending = cancelled.controller.transcribe({mimeType: 'audio/webm', audio: 'AQID'}); await turn(); cancelled.controller.cancel(); release({text: 'Discard this late transcript.'}); await pending;
        assert.equal(cancelled.controller.getState().mode, 'continue'); assert.equal(cancelled.controller.getState().command, 'Keep this draft.');
    } finally { cancelled.controller.dispose(); }
});

test('snapshot mode mismatch blocks planning before inference and blocks Run after a changed snapshot', async () => {
    const mismatch = controllerFixture({broker: {getSnapshot: () => ({mode: 'continue'})}}); try {
        mismatch.controller.setCommand('Set up a study.'); await mismatch.controller.plan(); assert.equal(mismatch.requests.length, 0); assert.equal(mismatch.previews.length, 0); assert.equal(mismatch.controller.getState().phase, 'error');
    } finally { mismatch.controller.dispose(); }
    const f = controllerFixture(); try {
        f.controller.setCommand('Set up a study.'); await f.controller.plan(); f.snapshot.mode = 'continue'; assert.throws(() => f.controller.run(), /starting point changed/); assert.equal(f.runs.length, 0);
    } finally { f.controller.dispose(); }
});

test('review displays every locally expanded step up to sixteen and rejects a longer hidden execution list', async () => {
    for (const count of [13, 16, 17]) {
        const f = controllerFixture({broker: {preview: () => ({status: 'ready', choices: [], actions: Array.from({length: count}, (_, index) => ({label: `Actual local step ${index + 1}`}))})}}); try {
            f.controller.setCommand('Prepare this study.'); await f.controller.plan();
            if (count <= 16) { assert.equal(f.controller.getState().preview.actions.length, count); assert.equal(f.controller.getState().preview.actions.at(-1).label, `Actual local step ${count}`); }
            else { assert.equal(f.controller.getState().phase, 'error'); assert.equal(f.controller.getState().preview, null); assert.throws(() => f.controller.run()); }
        } finally { f.controller.dispose(); }
    }
});

test('workflow UI exposes labelled request modes and New request without submitting or modifying the command', () => {
    const f = panelFixture(); try {
        f.panel.update({configured: true, command: 'Review this CT.'}); const mode = walk(f.root).find(node => node.dataset.aiWorkflowMode);
        const label = walk(f.root).find(node => node.attributes.for === mode.id); assert.equal(label.textContent, 'Request starting point'); assert.equal(mode.value, 'fresh');
        assert.deepEqual(mode.children.map(option => [option.value, option.textContent]), [['fresh', 'New task from study'], ['continue', 'Continue current view']]);
        assert.ok(mode.attributes['aria-describedby']); assert.match(f.root.textContent, /only when you choose Run task/); assert.match(f.root.textContent, /Imported studies and measurements stay/);
        mode.value = 'continue'; f.send('change', mode); assert.deepEqual(f.events, [['mode', 'continue']]); assert.equal(f.command.value, 'Review this CT.');
        f.panel.update({mode: 'continue'}); assert.match(f.root.textContent, /panes, images and viewing settings you currently have open/);
        f.send('click', f.node('new-request')); assert.deepEqual(f.events.at(-1), ['new-request']); assert.equal(f.root.ownerDocument.activeElement, f.command);
        f.panel.clear(); assert.equal(mode.value, 'fresh');
    } finally { f.panel.dispose(); }
});

test('busy workflow and microphone permission both disable request-mode changes and New request', async () => {
    const f = panelFixture(); try {
        f.panel.update({configured: true, busy: true, command: 'Review this CT.'}); const mode = walk(f.root).find(node => node.dataset.aiWorkflowMode);
        assert.equal(mode.disabled, true); assert.equal(f.node('new-request').disabled, true); mode.value = 'continue'; f.send('change', mode); f.send('click', f.node('new-request')); assert.deepEqual(f.events, []); assert.equal(f.node('cancel').disabled, false);
    } finally { f.panel.dispose(); }
    let release, stopped = 0; const voice = panelFixture({MediaRecorder: Recorder, mediaDevices: {getUserMedia: () => new Promise(resolve => { release = resolve; })}}); try {
        voice.panel.update({configured: true, command: 'Keep my draft.'}); voice.send('click', voice.node('record')); await turn(); const mode = walk(voice.root).find(node => node.dataset.aiWorkflowMode);
        assert.equal(mode.disabled, true); assert.equal(voice.node('new-request').disabled, true); assert.equal(voice.node('cancel').disabled, false); voice.send('click', voice.node('cancel')); release({getTracks: () => [{stop() { stopped++; }}]}); await turn();
        assert.equal(stopped, 1); assert.equal(mode.disabled, false); assert.equal(voice.command.value, 'Keep my draft.');
    } finally { voice.panel.dispose(); }
});
