import test from 'node:test';
import assert from 'node:assert/strict';
import {AiAssistPanel} from '../src/ui/AiAssistPanel.js';

class Element extends EventTarget {
    constructor(tagName, ownerDocument) { super(); Object.assign(this, {tagName, ownerDocument, children: [], parentNode: null, attributes: {}, dataset: {}, hidden: false, disabled: false, open: false, checked: false, _text: ''}); }
    get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.replaceChildren(); }
    set innerHTML(value) { throw new Error('AI output must never be interpreted as HTML.'); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    removeAttribute(key) { delete this.attributes[key]; }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children.forEach(node => { node.parentNode = null; }); this.children = []; this.append(...nodes); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
    focus() { this.ownerDocument.shadow.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; this.ownerDocument.pendingClose.push(this); }
}
const walk = node => node.children.flatMap(child => [child, ...walk(child)]);
const findClass = (root, name) => walk(root).find(node => node.className?.split(' ').includes(name));
const seriesRequest = () => ({version: 1, task: 'explain-series', facts: [{id: 'E1', code: 'modality', value: 'CT'}, {id: 'E2', code: 'row-spacing', value: 0.5, unit: 'mm'}]});
const snapshot = (task = 'explain-series', changes = {}) => ({request: task === 'explain-series' ? seriesRequest() : {version: 1, task, facts: [{id: 'E1', code: 'measurement-kind', value: 'length', group: 'M1'}, {id: 'E2', code: 'value', value: 10.5, unit: 'mm', group: 'M1'}, {id: 'E3', code: 'calibration', value: 'physical', group: 'M1'}]}, contextKey: 'patient-1', revision: 1, label: 'Pane A · Image 1 of 16', evidence: [{id: 'E1', label: 'Selected image'}, {id: 'E2', label: 'Distance 1'}], ...changes});
const baseState = () => ({configured: true, profile: {label: 'Synthetic demonstration', model: 'test-model', recipient: 'Host demonstration gateway'}, hasImage: true, measurements: [{id: 'a-1', label: 'Distance 1 · Image 1'}], contextKey: 'patient-1', revision: 1});
function send(target, type, extra = {}) { const event = new Event(type, {cancelable: true}); for (const [key, value] of Object.entries(extra)) Object.defineProperty(event, key, {value}); target.dispatchEvent(event); return event; }
function fixture(overrides = {}) {
    const document = {activeElement: null, shadow: {activeElement: null}, pendingClose: [], createElement: tag => new Element(tag, document)}, root = document.createElement('div'); root.getRootNode = () => document.shadow;
    const source = document.createElement('button'); root.append(source); document.shadow.activeElement = source;
    const prepared = [], generated = [], navigated = [], changes = [], cancelled = [], tested = [], closed = [];
    const panel = new AiAssistPanel(root, {getSnapshot(task, ids) { prepared.push({task, ids}); return snapshot(task); }, onGenerate: value => generated.push(value), onCancel: () => cancelled.push(true), onTestConnection: () => tested.push(true), onNavigateEvidence: (...args) => navigated.push(args), onSelectionChange: value => changes.push(value), onClose: () => closed.push(true), ...overrides});
    const node = name => name ? findClass(root, `ai-assist-${name}`) ?? walk(root).find(node => node.dataset.aiAction === name) : walk(root).find(node => node.className === 'ai-assist');
    return {document, root, source, panel, prepared, generated, navigated, changes, cancelled, tested, closed, node,
        action(action, qualifier) { const target = walk(root).find(node => node.dataset?.aiAction === action && (!qualifier || node.dataset.aiTask === qualifier || node.dataset.aiEvidence === qualifier || node.dataset.aiMode === qualifier)); assert.ok(target, `missing action ${action}`); const event = new Event('click'); Object.defineProperty(event, 'target', {value: target}); node('')?.dispatchEvent(event); },
        select(id, checked) { const target = walk(root).find(node => node.dataset.aiMeasurement === id); assert.ok(target); target.checked = checked; send(node(''), 'change', {target}); },
        cleanup() { panel.dispose(); }
    };
}

// Root class is exactly ai-assist; keep discovery independent from selectors.
const fixtureWithDialog = fixture;

function ready(f, state = {}) { f.panel.update({...baseState(), ...state}); f.panel.open(); }

test('workflow Tasks defaults without capturing image facts and keyboard tabs reveal the existing Explain action', () => {
    const f = fixtureWithDialog({workflow: {}}); try {
        ready(f, {workflow: {phase: 'idle', command: '', busy: false}}); assert.equal(f.prepared.length, 0); assert.equal(f.node('generate').hidden, true);
        const tabs = walk(f.root).filter(node => node.dataset.aiAction === 'mode'); assert.equal(tabs[0].attributes.role, 'tab'); assert.equal(tabs[0].attributes['aria-selected'], 'true'); assert.equal(tabs[1].tabIndex, -1);
        const event = send(f.node(''), 'keydown', {target: tabs[0], key: 'ArrowRight'}); assert.equal(event.defaultPrevented, true); assert.equal(tabs[1].attributes['aria-selected'], 'true'); assert.equal(tabs[1].tabIndex, 0); assert.equal(f.prepared.length, 1); assert.equal(f.node('generate').hidden, false);
        f.panel.update({workflow: {phase: 'planning', command: 'Use two panes.', busy: true}}); assert.equal(tabs[0].disabled, true); assert.equal(f.node('test').disabled, true); f.panel.close(); assert.equal(f.panel.isOpen(), false);
    } finally { f.cleanup(); }
});

test('AI stays optional and opening an unconfigured panel makes no context or network request', () => {
    const f = fixtureWithDialog(); try {
        f.panel.open(); assert.equal(f.panel.isOpen(), true); assert.equal(f.prepared.length, 0); assert.equal(f.generated.length, 0); assert.equal(f.tested.length, 0);
        assert.equal(f.node('setup').hidden, false); assert.equal(f.node('generate').disabled, true); assert.equal(f.node('test').disabled, true); assert.match(f.root.textContent, /credentials stay on the server/);
    } finally { f.cleanup(); }
});

test('opening captures technical context without sending and exact preview matches the request passed to Generate', () => {
    const f = fixtureWithDialog(); try {
        ready(f); assert.equal(f.prepared.length, 1); assert.equal(f.generated.length, 0); assert.equal(f.node('setup').hidden, true); assert.match(f.node('recipient').textContent, /Host demonstration gateway/);
        assert.equal(f.node('context').textContent, JSON.stringify(seriesRequest())); assert.match(f.node('facts').textContent, /Authoritative viewer facts/); assert.match(f.node('facts').textContent, /0.5 mm/);
        f.action('generate'); assert.equal(f.generated.length, 1); assert.equal(JSON.stringify(f.generated[0].request), f.node('context').textContent);
        assert.equal(f.node('generate').disabled, true); f.action('generate'); assert.equal(f.generated.length, 1); assert.equal(f.node('cancel').hidden, false);
    } finally { f.cleanup(); }
});

test('no active image disables context preparation and Generate while allowing an explicit synthetic connection test', () => {
    const f = fixtureWithDialog(); try { ready(f, {hasImage: false}); assert.equal(f.prepared.length, 0); assert.equal(f.node('generate').disabled, true); f.action('test'); assert.equal(f.tested.length, 1); assert.equal(f.generated.length, 0); assert.match(f.node('status').textContent, /synthetic facts only/); } finally { f.cleanup(); }
});

test('measurement summaries require explicit checkbox selection and table preserves measurement group and units', () => {
    const f = fixtureWithDialog(); try {
        ready(f); f.action('task', 'summarize-measurements'); assert.equal(f.node('measurement-section').hidden, false); assert.equal(f.node('generate').disabled, true); assert.equal(f.generated.length, 0);
        f.select('a-1', true); assert.equal(f.node('generate').disabled, false); assert.deepEqual(f.prepared.at(-1), {task: 'summarize-measurements', ids: ['a-1']}); assert.match(f.node('facts').textContent, /M1 · Viewer-computed measurement10.5 mm/);
        f.action('generate'); assert.equal(f.generated[0].request.task, 'summarize-measurements');
    } finally { f.cleanup(); }
});

test('busy state disables context edits and connection test but cancellation and closing stay available', () => {
    const f = fixtureWithDialog(); try {
        ready(f); f.action('generate'); assert.equal(f.node('refresh').disabled, true); assert.equal(f.node('test').disabled, true); const before = f.prepared.length; f.action('refresh'); f.action('task', 'summarize-measurements'); assert.equal(f.prepared.length, before);
        f.action('cancel'); assert.equal(f.cancelled.length, 1); assert.equal(f.node('cancel').hidden, true); assert.match(f.node('status').textContent, /Request canceled/); assert.equal(f.node('generate').disabled, false);
        f.action('close'); assert.equal(f.panel.isOpen(), false); assert.equal(f.closed.length, 1);
    } finally { f.cleanup(); }
});

test('a running draft keeps captured source label and literal inert text while browser image navigation updates unrelated state', () => {
    const f = fixtureWithDialog(); try {
        ready(f); f.action('generate'); const request = f.node('context').textContent, factTable = f.node('fact-table');
        f.panel.update({phase: 'generating', text: '<script>window.invalid = true</script> Read [E1].', currentFrameLabel: 'Image 9'});
        assert.equal(f.node('context').textContent, request); assert.match(f.node('scope').textContent, /Image 1 of 16/); assert.equal(f.node('output').textContent, '<script>window.invalid = true</script> Read [E1].'); assert.equal(f.node('fact-table'), factTable);
        assert.match(f.root.textContent, /Unverified draft/); assert.match(f.root.textContent, /does not interpret image pixels/);
    } finally { f.cleanup(); }
});

test('numeric discrepancies and unknown references are flagged, and only known admitted evidence is navigable', () => {
    const f = fixtureWithDialog(); try {
        ready(f); f.panel.update({phase: 'complete', text: 'A draft [E2] [E99]', result: {evidenceIds: ['E2', 'E99'], numericWarnings: ['unexpected'], unknownEvidenceIds: ['E99']}});
        assert.match(f.node('flags').textContent, /numeric statements could not be matched/); assert.match(f.node('flags').textContent, /source references were not supplied/);
        const buttons = walk(f.node('evidence')).filter(node => node.dataset.aiAction === 'evidence'); assert.equal(buttons.length, 1); f.action('evidence', 'E2'); assert.equal(f.navigated.length, 1); assert.equal(f.navigated[0][0], 'E2'); assert.equal(f.navigated[0][1].contextKey, 'patient-1');
    } finally { f.cleanup(); }
});

test('patient or annotation revision changes make prior context stale until deliberate refresh', () => {
    const f = fixtureWithDialog(); try {
        ready(f); const initial = f.prepared.length; f.panel.update({contextKey: 'patient-2'}); assert.equal(f.node('scope').dataset.stale, 'true'); assert.equal(f.node('generate').disabled, true); assert.equal(f.prepared.length, initial);
        f.action('refresh'); assert.equal(f.prepared.length, initial + 1); assert.equal(f.node('scope').dataset.stale, 'false'); assert.equal(f.changes.length, 1);
        f.panel.update({revision: 2}); assert.equal(f.node('generate').disabled, true);
    } finally { f.cleanup(); }
});

test('removing a selected measurement invalidates its prepared summary and never sends another selection automatically', () => {
    const f = fixtureWithDialog(); try {
        ready(f); f.action('task', 'summarize-measurements'); f.select('a-1', true); assert.equal(f.node('generate').disabled, false); f.panel.update({measurements: []});
        assert.equal(f.node('generate').disabled, true); assert.equal(f.node('scope').dataset.stale, 'true'); assert.equal(f.generated.length, 0); assert.match(f.node('measurements').textContent, /Create a supported measurement/);
    } finally { f.cleanup(); }
});

test('Escape closes with cancellation and restores shadow-root focus; queued native close does not dismiss a reopened panel', () => {
    const f = fixtureWithDialog(); try {
        ready(f); assert.equal(f.document.shadow.activeElement, f.node('close')); const event = send(f.node(''), 'cancel'); assert.equal(event.defaultPrevented, true); assert.equal(f.panel.isOpen(), false); assert.equal(f.document.shadow.activeElement, f.source); assert.equal(f.cancelled.length, 1);
        f.panel.open(); for (const dialog of f.document.pendingClose.splice(0)) send(dialog, 'close'); assert.equal(f.panel.isOpen(), true);
    } finally { f.cleanup(); }
});

test('context errors remain visible and Generate unavailable; synchronous callback failure restores controls', () => {
    const a = fixtureWithDialog({getSnapshot() { throw new Error('Selected facts unavailable.'); }}), b = fixtureWithDialog({onGenerate() { throw new Error('Synthetic service unavailable.'); }});
    try { ready(a); assert.equal(a.node('generate').disabled, true); assert.match(a.node('error').textContent, /Selected facts unavailable/); ready(b); b.action('generate'); assert.match(b.node('error').textContent, /Synthetic service unavailable/); assert.equal(b.node('generate').disabled, false); assert.equal(b.node('cancel').hidden, true); } finally { a.cleanup(); b.cleanup(); }
});

test('closing and reopening clears selection/draft and late callback errors cannot enter the reopened context', async () => {
    let reject; const promise = new Promise((_, failed) => { reject = failed; }), f = fixtureWithDialog({onGenerate: () => promise});
    try {
        ready(f); f.action('generate'); f.panel.close(); f.panel.open(); reject(new Error('Old service failed.')); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.node('error').hidden, true); assert.equal(f.node('output').textContent, ''); assert.equal(f.node('generate').disabled, false);
    } finally { f.cleanup(); }
});

test('output is bounded, evidence IDs and dialog headings are isolated between embedded viewers', () => {
    const a = fixtureWithDialog(), b = fixtureWithDialog(); try {
        ready(a); ready(b); assert.notEqual(a.node('').id, b.node('').id); assert.equal(a.node('').attributes['aria-labelledby'], `${a.node('').id}-title`);
        a.panel.update({phase: 'complete', text: 'x'.repeat(70000)}); assert.equal(a.node('output').textContent.length, 65536); assert.equal(b.node('output').textContent, ''); a.panel.close(); assert.equal(b.panel.isOpen(), true);
    } finally { a.cleanup(); b.cleanup(); }
});

test('disposal removes owned controls/listeners and further host updates cannot reopen or invoke callbacks', () => {
    const f = fixtureWithDialog(); ready(f); const dialog = f.node(''); f.cleanup(); assert.equal(f.panel.isOpen(), false); assert.equal(walk(f.root).some(node => node.className === 'ai-assist'), false); f.panel.update(baseState()); f.panel.open(); send(dialog, 'cancel'); assert.equal(f.closed.length, 1); assert.equal(f.generated.length, 0); f.cleanup();
});

test('host invalidation immediately removes captured source facts and draft without preparing a replacement', () => {
    const f = fixtureWithDialog(); try {
        ready(f); f.action('task', 'summarize-measurements'); f.select('a-1', true); f.panel.update({phase:'complete',text:'Prior context draft [E2].',result:{evidenceIds:['E2']}}); const count=f.prepared.length;
        f.panel.invalidate(); assert.equal(f.panel.isOpen(),true);assert.equal(f.prepared.length,count);assert.equal(f.node('context').textContent,'');assert.equal(f.node('output').textContent,'');assert.equal(f.node('evidence').children.length,0);assert.equal(f.node('generate').disabled,true);assert.equal(f.node('scope').dataset.stale,'true');
        assert.equal(walk(f.node('measurements')).find(node=>node.dataset.aiMeasurement)?.checked,false);
    } finally { f.cleanup(); }
});

test('synthetic connection output is separate from image drafts and controlled transport errors render their message', () => {
    const f = fixtureWithDialog(); try {
        ready(f);f.action('test');f.panel.update({phase:'testing',text:'Synthetic model text.'});assert.equal(f.node('output').textContent,'');f.panel.update({phase:'complete',text:'Synthetic model text.',result:{connectionTest:true,text:'Synthetic model text.'}});assert.equal(f.node('result').hidden,true);assert.match(f.node('status').textContent,/Connection succeeded using synthetic facts/);
        f.panel.update({phase:'error',text:'',result:null,error:{code:'unavailable',message:'The AI service is unavailable.'}});assert.equal(f.node('error').textContent,'The AI service is unavailable.');
    } finally {f.cleanup();}
});


const signInProfile = () => ({...baseState().profile, baseUrl: 'https://gateway.example/api/ai', signInUrl: '/api/ai/login'});

test('configured sign-in stays discoverable after a fresh viewer open without any automatic request', () => {
    const f = fixtureWithDialog({workflow: {}}); try {
        ready(f, {profile: signInProfile()}); const link = f.node('sign-in');
        assert.equal(link.hidden, false); assert.equal(link.attributes.href, 'https://gateway.example/api/ai/login');
        assert.equal(link.attributes.target, '_blank'); assert.equal(link.attributes.rel, 'noopener noreferrer'); assert.equal(link.attributes.referrerpolicy, 'no-referrer');
        assert.equal(f.node('auth-notice').hidden, true); assert.equal(f.tested.length, 0); assert.equal(f.generated.length, 0);
        f.panel.close(); f.panel.open(); assert.equal(link.hidden, false); assert.equal(f.tested.length, 0); assert.equal(f.prepared.length, 0);
    } finally { f.cleanup(); }
});

for (const source of ['plan', 'transcribe', 'explain', 'connection-test']) test(`${source} unauthorized state gives the shared sign-in recovery without erasing context or retrying`, () => {
    const f = fixtureWithDialog({workflow: {}}); try {
        const workflow = {phase: 'error', command: 'Show frame twelve.', busy: false, error: {code: 'unauthorized', message: 'Sign in to the AI service.'}};
        ready(f, {profile: signInProfile(), ...(source === 'plan' || source === 'transcribe' ? {workflow} : {phase: 'error', error: workflow.error})});
        assert.equal(f.node('auth-notice').hidden, false); assert.match(f.node('auth-notice').textContent, /retry here/); assert.match(f.node('auth-notice').textContent, /refreshing the viewer does not renew/);
        assert.equal(f.node('sign-in').hidden, false); assert.equal(f.tested.length, 0); assert.equal(f.generated.length, 0);
        if (source === 'plan' || source === 'transcribe') assert.equal(walk(f.root).find(node => node.tagName === 'textarea').value, workflow.command);
        f.panel.update({phase: 'complete', error: null, workflow: {phase: 'review', command: workflow.command, busy: false, error: null}});
        assert.equal(f.node('auth-notice').hidden, true); assert.equal(f.node('sign-in').hidden, false); assert.equal(f.tested.length, 0);
    } finally { f.cleanup(); }
});

test('missing or invalid host sign-in URLs are never turned into navigation links', () => {
    const f = fixtureWithDialog(); try {
        for (const profile of [baseState().profile, {...signInProfile(), signInUrl: 'javascript:alert(1)'}, {...signInProfile(), signInUrl: 'https://other.example/login'}]) {
            ready(f, {profile, error: {code: 'unauthorized'}}); assert.equal(f.node('sign-in').hidden, true); assert.equal(f.node('sign-in').attributes.href, undefined); assert.equal(f.node('auth-notice').hidden, true); f.panel.close();
        }
        ready(f, {configured: false, profile: signInProfile()}); assert.equal(f.node('sign-in').hidden, true); assert.equal(f.node('sign-in').attributes.href, undefined);
    } finally { f.cleanup(); }
});
