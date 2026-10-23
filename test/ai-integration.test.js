import test from 'node:test';
import assert from 'node:assert/strict';
import { AiAssistIntegration } from '../src/integration/AiAssistIntegration.js';

class Element extends EventTarget {
    constructor(tagName, ownerDocument) { super(); Object.assign(this, { tagName, ownerDocument, children: [], parentNode: null, attributes: {}, dataset: {}, hidden: false, disabled: false, open: false, checked: false, _text: '' }); }
    get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.replaceChildren(); }
    set innerHTML(value) { throw new Error('AI output cannot become HTML.'); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    removeAttribute(key) { delete this.attributes[key]; }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children.forEach(node => { node.parentNode = null; }); this.children = []; this.append(...nodes); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
    focus() { this.ownerDocument.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; }
}
const walk = node => node.children.flatMap(child => [child, ...walk(child)]);
const turn = () => new Promise(resolve => setImmediate(resolve));
function response(text = 'Image rows are 512 [E2].') {
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/x-ndjson' }), body: new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: 'delta', text })}\n${JSON.stringify({ type: 'done', model: 'synthetic-model' })}\n`)); controller.close();
    } }) };
}
function context() {
    return { contextKey: 'frame-A', patientKey: 'patient-A', revision: 1, source: { key: 'source-1', index: 0, slot: 0, samples: new Uint16Array([123]) },
        label: 'Synthetic CT · Image 1', frameCount: 16, notices: ['encoding', 'PRIVATE_NOTICE'], sourceBitsStored: 12, sourceBitsAllocated: 16,
        frame: { modality: 'CT', rows: 512, columns: 512, photometric: 'MONOCHROME2', bitsStored: 16, bitsAllocated: 16, signed: true,
            slope: 1, intercept: -1024, unit: 'HU', pixelSpacing: [0.5, 0.5], samples: new Uint16Array([123]), patientName: 'PRIVATE_PATIENT', uid: 'PRIVATE_UID', sourceUrl: 'PRIVATE_URL' },
        measurements: [{ id: 'PRIVATE_ANNOTATION', label: 'Length 1', measure: () => ({ id: 'PRIVATE_ANNOTATION', geometry: { kind: 'length', value: 12.5, unit: 'mm', calibrated: true }, statistics: null }) }] };
}
function fixture({ configuration = { baseUrl: 'https://gateway.example/api/ai', label: 'Synthetic AI', recipient: 'Host gateway', model: 'synthetic-model' }, fetchImpl, workflow } = {}) {
    const document = { activeElement: null, createElement: tag => new Element(tag, document) }, root = document.createElement('div');
    let current = context(), available = true;
    const calls = [], events = [], navigation = [];
    const bridge = new AiAssistIntegration(root, { configuration, getContext: () => current, isSourceAvailable: () => available,
        navigateEvidence: (snapshot, id) => navigation.push({ snapshot, id }), onChange: state => events.push(state), workflow,
        fetchImpl: async (url, options) => { calls.push({ url, options }); return fetchImpl ? fetchImpl(url, options) : response(); } });
    const node = name => walk(root).find(item => item.className?.split(' ').includes(name ? `ai-assist-${name}` : 'ai-assist'));
    return { bridge, root, calls, events, navigation, node, setCurrent(value) { current = value; }, getCurrent: () => current, setAvailable(value) { available = value; },
        action(action, qualifier) { const target = walk(root).find(item => item.dataset?.aiAction === action && (!qualifier || item.dataset.aiTask === qualifier || item.dataset.aiEvidence === qualifier)); assert.ok(target, action); const event = new Event('click'); Object.defineProperty(event, 'target', { value: target }); node('')?.dispatchEvent(event); },
        select(id, checked) { const target = walk(root).find(item => item.dataset.aiMeasurement === id); assert.ok(target); target.checked = checked; const event = new Event('change'); Object.defineProperty(event, 'target', { value: target }); node('')?.dispatchEvent(event); },
        dispose: () => bridge.dispose()
    };
}

const workflowBroker = changes => ({getSnapshot: ({mode}) => ({mode, catalog: 'PRIVATE_CATALOG'}), preview: () => ({status: 'ready', message: 'Ready', actions: [{label: 'Display two panes'}], choices: []}), execute: async () => ({message: 'Applied', canUndo: true}), undo: async () => {}, cancel() {}, ...changes});
function workflowAction(f, action) { const target = walk(f.root).find(node => node.dataset.aiWorkflowAction === action), event = new Event('click'); assert.ok(target); Object.defineProperty(event, 'target', {value: target}); walk(f.root).find(node => node.className === 'ai-assist-workflow').dispatchEvent(event); }
function command(f, value) { const target = walk(f.root).find(node => node.className === 'ai-workflow-command'), event = new Event('input'); target.value = value; Object.defineProperty(event, 'target', {value: target}); walk(f.root).find(node => node.className === 'ai-assist-workflow').dispatchEvent(event); }

test('workflow Tasks is the integrated default and explicit Explain preserves the existing metadata action', async () => {
    let executed = 0;
    const f = fixture({workflow: workflowBroker({execute: async () => { executed++; return {canUndo: true}; }}), fetchImpl: async url => url.endsWith('/plan') ? new Response(JSON.stringify({version: 1, model: 'synthetic-model', plan: {version: 1, status: 'ready', summary: 'Display two panes.', question: null, actions: [{type: 'layout', count: 2}]}}), {headers: {'Content-Type': 'application/json'}}) : response()});
    try {
        f.bridge.open(); assert.equal(f.calls.length, 0); assert.equal(f.node('context').textContent, ''); assert.equal(f.node('generate').hidden, true);
        command(f, 'Display two panes.'); workflowAction(f, 'plan'); await turn(); assert.equal(f.calls.length, 1); assert.deepEqual(JSON.parse(f.calls[0].options.body), {version: 1, task: 'plan-workflow', command: 'Display two panes.', mode: 'fresh'}); assert.equal(executed, 0);
        workflowAction(f, 'run'); await turn(); assert.equal(executed, 1); assert.equal(f.bridge.getState().canUndoTask, true); assert.ok(!JSON.stringify(f.events).includes('PRIVATE')); assert.ok(!JSON.stringify(f.events).includes('Display two panes'));
        const tab = walk(f.root).find(node => node.dataset.aiMode === 'explain'), event = new Event('click'); Object.defineProperty(event, 'target', {value: tab}); f.node('').dispatchEvent(event);
        assert.equal(f.node('generate').hidden, false); assert.ok(f.node('context').textContent.includes('explain-series')); f.action('generate'); await turn(); assert.equal(f.calls.length, 2); assert.ok(f.bridge.getDraft());
    } finally { f.dispose(); }
});

test('workflow source invalidation clears reviewed commands but broker-owned execution is not self-canceled', async () => {
    let release, executing = false, cancelled = 0;
    const f = fixture({workflow: workflowBroker({isExecuting: () => executing, execute: () => { executing = true; return new Promise(resolve => { release = () => { executing = false; resolve({canUndo: true}); }; }); }, cancel() { cancelled++; }}), fetchImpl: async () => new Response(JSON.stringify({version: 1, model: 'synthetic-model', plan: {version: 1, status: 'ready', summary: 'Display two panes.', question: null, actions: [{type: 'layout', count: 2}]}}), {headers: {'Content-Type': 'application/json'}})});
    try {
        f.bridge.open(); command(f, 'Display two panes.'); workflowAction(f, 'plan'); await turn(); workflowAction(f, 'run'); await turn(); const before = cancelled;
        f.bridge.invalidate(); assert.equal(cancelled, before); assert.equal(f.bridge.getState().workflowPhase, 'running'); release(); await turn(); assert.equal(f.bridge.getState().workflowPhase, 'complete');
        f.bridge.invalidate(); assert.equal(f.bridge.getState().workflowPhase, 'idle'); assert.equal(walk(f.root).find(node => node.className === 'ai-workflow-command').value, '');
    } finally { f.dispose(); }
});

test('closing an integrated workflow cancels transport and clears private task text', async () => {
    let signal;
    const f = fixture({workflow: workflowBroker(), fetchImpl: (_, options) => { signal = options.signal; return new Promise(() => {}); }});
    try { f.bridge.open(); command(f, 'PRIVATE_COMMAND'); workflowAction(f, 'plan'); await turn(); f.bridge.close(); await turn(); assert.equal(signal.aborted, true); assert.equal(f.bridge.getState().open, false); assert.ok(!JSON.stringify(f.events).includes('PRIVATE_COMMAND')); f.bridge.open(); assert.equal(walk(f.root).find(node => node.className === 'ai-workflow-command').value, ''); } finally { f.dispose(); }
});

test('disabled and unconfigured integration never calls inference or decodes measurements', () => {
    for (const configuration of [undefined, { enabled: false }, { enabled: true }]) {
        // Explicitly pass undefined through a separate constructor for the disabled default.
        const f = fixture({ configuration: configuration ?? false });
        try { const opened = f.bridge.open(); assert.equal(f.calls.length, 0); assert.equal(f.bridge.getState().configured, false); assert.equal(opened, configuration?.enabled === true); }
        finally { f.dispose(); }
    }
});

test('opening prepares exact coded facts without sending, retaining samples, or exposing source identifiers in public state', async () => {
    const f = fixture(); try {
        f.bridge.open(); assert.equal(f.calls.length, 0); const preview = JSON.parse(f.node('context').textContent);
        assert.equal(preview.facts.find(fact => fact.code === 'bits-stored').value, 12);
        assert.equal(preview.facts.find(fact => fact.code === 'decoded-bits-stored').value, 16);
        assert.ok(!JSON.stringify(preview).includes('PRIVATE')); assert.ok(!JSON.stringify(f.events).includes('PRIVATE'));
        f.action('generate'); await turn();
        assert.equal(f.calls.length, 1); assert.deepEqual(JSON.parse(f.calls[0].options.body), preview);
        assert.equal(f.bridge.getState().hasDraft, true); assert.equal(f.bridge.getState().phase, 'complete');
        const draft = f.bridge.getDraft(); assert.equal(draft.text, 'Image rows are 512 [E2].'); assert.ok(!JSON.stringify(draft).includes('PRIVATE'));
        draft.facts[0].value = 'MR'; assert.equal(f.bridge.getDraft().facts[0].value, 'CT');
        assert.ok(!Object.hasOwn(f.bridge.getState(), 'text')); assert.ok(!Object.hasOwn(f.bridge.getState(), 'facts'));
    } finally { f.dispose(); }
});

test('measurement summary computes only explicitly selected annotations and never transmits their labels or IDs', async () => {
    const f = fixture(); let first = 0, second = 0;
    const current = f.getCurrent(); current.measurements[0].measure = () => { first++; return { geometry: { kind: 'length', value: 12.5, unit: 'mm', calibrated: true } }; };
    current.measurements.push({ id: 'PRIVATE_OTHER', label: 'Length 2', measure() { second++; throw new Error('must not calculate unselected ROI'); } });
    try {
        f.bridge.open(); assert.equal(first, 0); assert.equal(second, 0);
        f.action('task', 'summarize-measurements'); assert.equal(f.node('generate').disabled, true);
        f.select('PRIVATE_ANNOTATION', true); assert.equal(first, 1); assert.equal(second, 0); assert.equal(f.node('generate').disabled, false);
        const preview = f.node('context').textContent; assert.ok(!preview.includes('PRIVATE')); assert.ok(preview.includes('12.5'));
        f.action('generate'); await turn(); assert.equal(first, 1); assert.equal(second, 0);
        assert.equal(JSON.parse(f.calls[0].options.body).task, 'summarize-measurements'); assert.equal(f.bridge.getState().selectedMeasurementCount, 1);
    } finally { f.dispose(); }
});

test('ordinary frame navigation keeps reviewed facts pinned and evidence returns to the original frame', async () => {
    const f = fixture(); try {
        f.bridge.open(); const preview = f.node('context').textContent;
        f.setCurrent({ ...context(), contextKey: 'frame-B', source: { key: 'source-1', index: 9, slot: 0 }, label: 'Synthetic CT · Image 10', measurements: [] }); f.bridge.sync();
        assert.equal(f.node('context').textContent, preview); assert.equal(f.node('scope').dataset.stale, 'false'); assert.equal(f.node('generate').disabled, false);
        f.action('generate'); await turn(); f.action('evidence', 'E2');
        assert.equal(f.navigation.length, 1); assert.deepEqual(f.navigation[0].snapshot.source, { key: 'source-1', index: 0, slot: 0 });
        assert.ok(!JSON.stringify(f.navigation[0]).includes('samples')); assert.ok(!JSON.stringify(f.navigation[0]).includes('PRIVATE_UID'));
    } finally { f.dispose(); }
});

test('reviewed measurement selections stay pinned across navigation until an explicit refresh', () => {
    const f = fixture(); try {
        f.bridge.open(); f.action('task', 'summarize-measurements'); f.select('PRIVATE_ANNOTATION', true); const preview = f.node('context').textContent;
        f.setCurrent({ ...context(), contextKey: 'frame-B', source: { key: 'source-1', index: 1, slot: 0 }, measurements: [] }); f.bridge.sync();
        assert.equal(f.node('generate').disabled, false); assert.equal(f.node('context').textContent, preview);
        f.action('refresh'); assert.equal(f.node('generate').disabled, true); assert.equal(f.calls.length, 0);
    } finally { f.dispose(); }
});

for (const change of ['patient', 'revision', 'source']) test(`${change} changes immediately clear reviewed facts and drafts, cancel in-flight work and ignore late output`, async () => {
    let resolveFetch, signal;
    const f = fixture({ fetchImpl: (_, options) => { signal = options.signal; return new Promise(resolve => { resolveFetch = resolve; }); } });
    try {
        f.bridge.open(); f.action('generate'); await Promise.resolve();
        if (change === 'source') f.setAvailable(false);
        else f.setCurrent({ ...context(), ...(change === 'patient' ? { patientKey: 'patient-B', contextKey: 'frame-B' } : { revision: 2 }) });
        f.bridge.sync(); assert.equal(signal.aborted, true); assert.equal(f.node('context').textContent, ''); assert.equal(f.node('output').textContent, '');
        assert.equal(f.node('generate').disabled, true); assert.equal(f.bridge.getDraft(), null);
        resolveFetch(response('LATE_PRIVATE_DRAFT')); await turn();
        assert.equal(f.node('output').textContent, ''); assert.equal(f.bridge.getDraft(), null); assert.ok(!JSON.stringify(f.events).includes('LATE_PRIVATE_DRAFT'));
    } finally { f.dispose(); }
});

test('completed drafts and facts are cleared on explicit invalidation, close and disposal', async () => {
    const f = fixture(); try {
        f.bridge.open(); f.action('generate'); await turn(); assert.ok(f.bridge.getDraft());
        f.bridge.invalidate(); assert.equal(f.bridge.getDraft(), null); assert.equal(f.node('context').textContent, ''); assert.equal(f.bridge.isOpen(), true);
        f.action('refresh'); f.action('generate'); await turn(); assert.ok(f.bridge.getDraft());
        f.bridge.close(); assert.equal(f.bridge.getDraft(), null); assert.equal(f.bridge.isOpen(), false);
        f.bridge.open(); assert.equal(f.node('output').textContent, ''); assert.equal(f.calls.length, 2);
        f.dispose(); assert.equal(f.bridge.isOpen(), false); assert.equal(f.bridge.open(), false); assert.equal(f.bridge.getDraft(), null);
    } finally { f.dispose(); }
});

test('connection test remains explicit and synthetic without exposing its output as a source-bound draft', async () => {
    const f = fixture({ fetchImpl: async () => response('Connected.') }); try {
        f.bridge.open(); f.action('test'); await turn();
        assert.equal(f.calls[0].url, 'https://gateway.example/api/ai/test');
        assert.deepEqual(JSON.parse(f.calls[0].options.body), { version: 1, task: 'connection-test', facts: [] });
        assert.equal(f.bridge.getDraft(), null); assert.equal(f.bridge.getState().hasDraft, false); assert.match(f.node('status').textContent, /Connection succeeded/);
    } finally { f.dispose(); }
});

test('embedded viewer AI state, captured facts and cancellation are isolated', async () => {
    const a = fixture(), b = fixture(); try {
        a.bridge.open(); b.bridge.open(); a.action('generate'); await turn();
        assert.equal(a.calls.length, 1); assert.equal(b.calls.length, 0); assert.ok(a.bridge.getDraft()); assert.equal(b.bridge.getDraft(), null);
        a.bridge.close(); assert.equal(b.bridge.isOpen(), true); assert.equal(b.node('generate').disabled, false);
    } finally { a.dispose(); b.dispose(); }
});
