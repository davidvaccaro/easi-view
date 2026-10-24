import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenWorkflow } from '../src/ui/OpenWorkflow.js';

class Element extends EventTarget {
    constructor(tagName, ownerDocument) { super(); Object.assign(this, {tagName, ownerDocument, children: [], parentNode: null, attributes: {}, dataset: {}, value: '', hidden: false, disabled: false, open: false, _text: ''}); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.replaceChildren(); }
    set innerHTML(value) { throw new Error('Untrusted source metadata must never be HTML.'); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
    append(...children) { for (const child of children) { child.remove(); child.parentNode = this; this.children.push(child); } }
    replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...children); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
    focus() { this.ownerDocument.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; this.dispatchEvent(new Event('close')); }
    querySelectorAll(selector) { return walk(this).filter(node => selector.split(',').includes(node.tagName)); }
    querySelector(selector) { return walk(this).find(node => selector === `[name="${node.name}"]`) ?? null; }
}
const walk = node => node.children.flatMap(child => [child, ...walk(child)]);
const byClass = (root, name) => walk(root).find(node => node.className?.split(' ').includes(name));
const actions = (root, action) => walk(root).filter(node => node.dataset?.openAction === action);
const fields = root => walk(root).filter(node => node.dataset.openFilter);
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
async function previewLocal(f, files, options) {
    const pending = f.workflow.acceptFiles(files, options);
    if (f.paint) { f.paint.frame(); f.paint.frame(); await tick(); }
    return pending;
}
function event(root, target, type = 'click') { assert.ok(target, `Missing ${type} target`); const event = new Event(type, {cancelable: true}); Object.defineProperty(event, 'target', {value: target}); byClass(root, 'open-workflow').dispatchEvent(event); return event; }
const study = (id, changes = {}) => ({id, studyUid: `2.25.${id.length}`, description: `Exam ${id}`, studyDate: '20261019', modalities: ['CT'], instanceCount: 120, seriesCount: 1, ...changes});
const patient = (id, changes = {}) => ({id, patientName: `Synthetic^${id}`, patientId: `ID-${id}`, issuerOfPatientId: 'SYNTHETIC', patientBirthDate: '19800102', studies: [study(`${id}-new`), study(`${id}-old`)], ...changes});
function fixture(callbacks = {}, policy = {}) {
    const document = {activeElement: null, createElement: tag => new Element(tag, document)}, root = document.createElement('div'), calls = [];
    const sources = [{id: 'pacs', name: 'Research archive', type: 'dicomweb', capabilities: {searchFields: ['patientId', 'patientName', 'accessionNumber', 'studyDate', 'modality']}}];
    const options = {getSources: () => sources, getPolicy: () => policy, onPickFiles: (...args) => calls.push(['files', ...args]), onPickFolder: (...args) => calls.push(['folder', ...args]), onClose: () => calls.push(['close']), onPreviewLocal: async () => ({token: {}, patients: [patient('a')], warnings: []}), onCommitLocal: async (...args) => calls.push(['commit-local', ...args]), onOpenTest: async (...args) => calls.push(['test', ...args]), ...callbacks};
    const workflow = new OpenWorkflow(root, options);
    return {root, document, calls, sources, options, workflow, click(action, index = 0) { event(root, actions(root, action)[index]); }, cleanup() { workflow.dispose(); }};
}
function input(f, name, value) { const node = fields(f.root).find(node => node.dataset.openFilter === name); assert.ok(node, `Missing ${name} filter`); node.value = value; event(f.root, node, 'input'); return node; }
function checkStudy(f, id, checked = true) { const node = walk(f.root).find(node => node.dataset.openStudy === id); assert.ok(node); node.checked = checked; event(f.root, node, 'change'); return node; }
async function remotePatient(f) { f.workflow.open('study'); f.click('remote'); f.click('source'); input(f, 'patientId', 'ID-a'); event(f.root, walk(f.root).find(node => node.dataset.openForm === 'criteria'), 'submit'); await tick(); }
function controlledPaint(f) {
    let id = 0; const frames = new Map(), timers = new Map();
    f.document.defaultView = {
        requestAnimationFrame(callback) { const token = ++id; frames.set(token, callback); return token; },
        cancelAnimationFrame(token) { frames.delete(token); },
        setTimeout(callback) { const token = ++id; timers.set(token, callback); return token; },
        clearTimeout(token) { timers.delete(token); }
    };
    f.paint = {frames, timers, frame() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); }, fallback() { [...timers.values()].forEach(callback => callback()); }}; return f.paint;
}

test('one launcher exposes three clear intents and respects embedding gates', () => {
    const f = fixture({}, {localImages: false, localStudies: false, remoteStudies: true, tests: false});
    try { f.workflow.open(); assert.equal(actions(f.root, 'images').length, 0); assert.equal(actions(f.root, 'study').length, 1); assert.equal(actions(f.root, 'test').length, 0); f.click('study'); assert.equal(actions(f.root, 'pick-study-folder').length, 0); assert.equal(actions(f.root, 'remote').length, 1); }
    finally { f.cleanup(); }
});

test('native file and folder choices preserve explicit intent and recursive-folder option', () => {
    const f = fixture();
    try {
        f.workflow.open('images'); f.click('pick-files'); const option = walk(f.root).find(node => node.dataset.openSubfolders != null); option.checked = false; event(f.root, option, 'change'); f.click('pick-images-folder');
        assert.deepEqual(f.calls.filter(call => call[0] !== 'close'), [['files', 'images', {includeSubfolders: true}], ['folder', 'images', {includeSubfolders: false}]]);
        f.workflow.open('study'); f.click('pick-study-folder'); assert.equal(f.calls.at(-1)[1], 'study');
    } finally { f.cleanup(); }
});

test('local images stage all selected patient studies but change the session only after Add', async () => {
    const people = [patient('a'), patient('b')], token = {}, f = fixture({onPreviewLocal: async () => ({token, patients: people, warnings: ['One file was not an image.']})});
    try {
        f.workflow.open('images'); await previewLocal(f, [{name: 'without-extension'}], {intent: 'images'});
        assert.equal(f.workflow.getState().step, 'local-images'); assert.deepEqual(f.workflow.getState().selectedStudyIds, ['a-new', 'a-old', 'b-new', 'b-old']); assert.equal(f.calls.some(call => call[0] === 'commit-local'), false); assert.match(f.root.textContent, /Patients stay separate/);
        f.click('add'); await tick(); const commit = f.calls.find(call => call[0] === 'commit-local'); assert.equal(commit[1].token, token); assert.equal(commit[2].intent, 'images'); assert.deepEqual(commit[2].selection, [{patientId: 'a', studyIds: ['a-new', 'a-old']}, {patientId: 'b', studyIds: ['b-new', 'b-old']}]); assert.equal(f.workflow.getState().open, false);
    } finally { f.cleanup(); }
});

test('DICOMDIR opening selects a patient then requires checked examinations', async () => {
    const f = fixture({onPreviewLocal: async () => ({patients: [patient('a'), patient('b')]})});
    try {
        f.workflow.open('study'); await previewLocal(f, [{name: 'DICOMDIR'}], {intent: 'study'}); assert.equal(f.workflow.getState().step, 'local-patients'); f.click('patient', 1); assert.equal(f.workflow.getState().patientId, 'b'); assert.equal(f.workflow.getState().step, 'local-studies'); assert.equal(actions(f.root, 'add')[0].disabled, true);
        checkStudy(f, 'b-old'); f.click('add'); await tick(); const commit = f.calls.find(call => call[0] === 'commit-local'); assert.deepEqual(commit[2].studyIds, ['b-old']); assert.equal(commit[2].patientId, 'b');
    } finally { f.cleanup(); }
});

test('local preview errors are inline and do not commit or close the viewer', async () => {
    const f = fixture({onPreviewLocal: async () => { throw new Error('The selected folder has no DICOMDIR.'); }});
    try { f.workflow.open('study'); await previewLocal(f, [{name: 'unrelated'}], {intent: 'study'}); assert.match(f.workflow.getState().error, /no DICOMDIR/); assert.equal(f.workflow.getState().open, true); assert.equal(f.calls.some(call => call[0] === 'commit-local'), false); assert.equal(byClass(f.root, 'open-workflow-error').attributes.role, 'alert'); }
    finally { f.cleanup(); }
});

test('remote criteria show only declared capabilities and reject unbounded searches', async () => {
    const requests = [], f = fixture({onSearchRemote: async (...args) => { requests.push(args); return {items: []}; }});
    try {
        f.workflow.open('study'); f.click('remote'); f.click('source'); assert.deepEqual(fields(f.root).map(field => field.dataset.openFilter), ['patientId', 'patientName', 'accessionNumber', 'studyDate', 'modality']); assert.ok(fields(f.root).every(field => field.value === ''));
        event(f.root, walk(f.root).find(node => node.dataset.openForm === 'criteria'), 'submit'); await tick(); assert.equal(requests.length, 0); assert.match(f.workflow.getState().error, /before searching/); input(f, 'patientName', 'Synthetic'); input(f, 'studyDate', '2026-10-19'); event(f.root, walk(f.root).find(node => node.dataset.openForm === 'criteria'), 'submit'); await tick(); assert.deepEqual(requests[0].slice(0, 3), ['pacs', {patientName: 'Synthetic', studyDate: '20261019'}, {offset: 0, limit: 25}]); assert.equal(f.workflow.getState().step, 'patients'); assert.match(f.root.textContent, /No patients matched/);
    } finally { f.cleanup(); }
});

test('remote patient selection refreshes studies without initial study filters and preserves checked studies across pages', async () => {
    const requests = [], commits = [], f = fixture({onSearchRemote: async () => ({items: [patient('a')], nextOffset: 25}), onListRemoteStudies: async (...args) => { requests.push(args); return args[2].offset === 0 ? {items: [study('new')], nextOffset: 25} : {items: [study('old')], nextOffset: null}; }, onCommitRemote: async (...args) => commits.push(args)});
    try {
        await remotePatient(f); f.click('patient'); await tick(); assert.equal(f.workflow.getState().step, 'studies'); assert.equal(requests[0][1].patientId, 'ID-a'); assert.deepEqual(requests[0][2], {offset: 0, limit: 25}); checkStudy(f, 'new'); f.click('studies-next'); await tick(); checkStudy(f, 'old'); assert.deepEqual(f.workflow.getState().selectedStudyIds, ['new', 'old']); f.click('add'); await tick(); assert.deepEqual(commits[0][2].map(study => study.id), ['new', 'old']); assert.equal(f.workflow.getState().open, false);
    } finally { f.cleanup(); }
});

test('cancel aborts metadata work, restores focus and ignores results from old workflows', async () => {
    let resolve, receivedSignal; const f = fixture({onPreviewLocal: (files, {signal}) => { receivedSignal = signal; return new Promise(done => { resolve = done; }); }});
    try {
        const launcher = f.document.createElement('button'); launcher.focus(); f.workflow.open('images'); const pending = f.workflow.acceptFiles([{name: 'example'}]); assert.equal(f.workflow.getState().busy, true); f.click('close'); assert.equal(receivedSignal.aborted, true); assert.equal(f.document.activeElement, launcher); f.workflow.open('test'); resolve({patients: [patient('stale')]}); await pending; assert.equal(f.workflow.getState().step, 'test'); assert.equal(f.workflow.getState().patientCount, 0);
    } finally { f.cleanup(); }
});

test('stale asynchronous native picker results cannot enter a different opening workflow', async () => {
    let resolve; const f = fixture({onPickFiles: () => new Promise(done => { resolve = done; })});
    try { f.workflow.open('images'); f.click('pick-files'); f.workflow.close(); f.workflow.open('test'); resolve([{name: 'old-selection'}]); await tick(); assert.equal(f.workflow.getState().step, 'test'); }
    finally { f.cleanup(); }
});

test('synthetic examples use a distinct callback and an explicit test-image identity', async () => {
    const f = fixture();
    try { f.workflow.open('test'); assert.match(f.root.textContent, /separate.*test workspace/); f.click('open-test', 3); await tick(); const call = f.calls.find(call => call[0] === 'test'); assert.equal(call[1], 'us'); assert.ok(call[2].signal instanceof AbortSignal); assert.equal(f.workflow.getState().open, false); }
    finally { f.cleanup(); }
});

test('source metadata and patient labels render as text, never HTML', async () => {
    const payload = '<img src="https://unrequested.invalid/">', f = fixture({onSearchRemote: async () => ({items: [patient('a', {patientName: payload})]})});
    try { f.sources[0].name = payload; await remotePatient(f); assert.ok(f.root.textContent.includes(payload)); assert.equal(walk(f.root).some(node => ['img', 'script'].includes(node.tagName)), false); }
    finally { f.cleanup(); }
});

test('Escape cancels without changing the current patient session and dispose removes the dialog', () => {
    const f = fixture(); f.workflow.open(); const cancelled = event(f.root, byClass(f.root, 'open-workflow'), 'cancel'); assert.equal(cancelled.defaultPrevented, true); assert.equal(f.workflow.getState().open, false); assert.equal(f.calls.some(call => call[0] === 'commit-local'), false); f.cleanup(); assert.equal(f.root.children.length, 0); assert.throws(() => f.workflow.open(), /disposed/);
});

test('local media notices remain visible after selecting a patient and going back', async () => {
    const f = fixture({onPreviewLocal: async () => ({patients: [patient('a'), patient('b')], warnings: ['Two referenced images are unavailable.']})});
    try { f.workflow.open('study'); await previewLocal(f, [{name: 'DICOMDIR'}], {intent: 'study'}); f.click('patient'); assert.match(byClass(f.root, 'open-workflow-warnings').textContent, /Two referenced images/); f.click('back'); assert.match(byClass(f.root, 'open-workflow-warnings').textContent, /Two referenced images/); }
    finally { f.cleanup(); }
});

test('remote source editing is optional, collapsed and returns to the configured-source workflow', async () => {
    const configurations = [], f = fixture({onConfigureSource: async configuration => { configurations.push(configuration); const source = {id: 'orthanc', name: configuration.name, type: configuration.type}; f.sources.push(source); return source; }}, {sourceEditing: true});
    try {
        f.workflow.open('study'); f.click('remote'); const details = byClass(f.root, 'open-workflow-settings'); assert.equal(details.open, false); const form = walk(details).find(node => node.dataset.openForm === 'configure'); form.querySelector('[name="sourceName"]').value = 'Local Orthanc'; form.querySelector('[name="sourceType"]').value = 'dicomweb'; form.querySelector('[name="sourceUrl"]').value = 'http://localhost:8042/dicom-web'; event(f.root, form, 'submit'); await tick();
        assert.deepEqual(configurations, [{name: 'Local Orthanc', type: 'dicomweb', baseUrl: 'http://localhost:8042/dicom-web'}]); assert.equal(f.workflow.getState().sourceId, 'orthanc'); assert.equal(f.workflow.getState().step, 'criteria');
        f.workflow.close(); f.options.getPolicy = () => ({sourceEditing: false}); f.workflow.open('study'); f.click('remote'); assert.equal(byClass(f.root, 'open-workflow-settings'), undefined);
    } finally { f.cleanup(); }
});

test('local patient and study selection remains bounded for large metadata catalogs', async () => {
    const people = Array.from({length: 130}, (_, i) => patient(String(i))), f = fixture({onPreviewLocal: async () => ({patients: people})});
    try {
        f.workflow.open('study'); await previewLocal(f, [{name: 'DICOMDIR'}], {intent: 'study'}); assert.equal(actions(f.root, 'patient').length, 25); f.click('local-patients-next'); assert.equal(f.workflow.getState().patientOffset, 25); assert.equal(actions(f.root, 'patient')[0].dataset.patientId, '25');
        f.workflow.close(); f.options.onPreviewLocal = async () => ({patients: [patient('one', {studies: Array.from({length: 101}, (_, i) => study(String(i)))})]}); f.workflow.open('study'); await previewLocal(f, [{name: 'DICOMDIR'}], {intent: 'study'}); assert.equal(walk(f.root).filter(node => node.dataset.openStudy != null).length, 25); checkStudy(f, '0'); f.click('studies-next'); assert.equal(f.workflow.getState().studyOffset, 25); assert.equal(walk(f.root).filter(node => node.dataset.openStudy != null).length, 25); checkStudy(f, '25'); assert.deepEqual(f.workflow.getState().selectedStudyIds, ['0', '25']);
    } finally { f.cleanup(); }
});

test('a queued native close event from an earlier dialog cannot close a reopened workflow', () => {
    const f = fixture();
    try { f.workflow.open('images'); const dialog = byClass(f.root, 'open-workflow'); f.workflow.close(); f.workflow.open('study'); dialog.dispatchEvent(new Event('close')); assert.equal(f.workflow.getState().open, true); assert.equal(f.workflow.getState().step, 'study'); }
    finally { f.cleanup(); }
});

test('changing an already open workflow preserves the original external focus target', () => {
    const f = fixture();
    try { const launcher = f.document.createElement('button'); launcher.focus(); f.workflow.open('images'); f.workflow.open('study'); f.workflow.close(); assert.equal(f.document.activeElement, launcher); }
    finally { f.cleanup(); }
});

test('an independently canceled callback returns the current workflow to an interactive state', async () => {
    const f = fixture({onPreviewLocal: async () => { throw new DOMException('Canceled by the source.', 'AbortError'); }});
    try { f.workflow.open('images'); await previewLocal(f, [{name: 'example'}]); assert.equal(f.workflow.getState().busy, false); assert.equal(f.workflow.getState().open, true); assert.match(byClass(f.root, 'open-workflow-status').textContent, /canceled.*try again/); assert.equal(actions(f.root, 'pick-files')[0].disabled, false); }
    finally { f.cleanup(); }
});

test('final study Add dims inert selection content, focuses enabled Cancel and paints before calling the source', async () => {
    let resolve, signal, starts = 0; const f = fixture({onCommitLocal: (preview, request) => { starts++; signal = request.signal; return new Promise(done => { resolve = done; }); }}), paint = controlledPaint(f);
    try {
        f.workflow.open('study'); await previewLocal(f, [{name: 'DICOMDIR'}], {intent: 'study'}); const checked = checkStudy(f, 'a-new'); checked.focus(); f.click('add');
        const progress = byClass(f.root, 'open-workflow-progress'), content = byClass(f.root, 'open-workflow-content'), cancel = actions(f.root, 'close').at(-1);
        assert.equal(f.workflow.getState().busy, true); assert.equal(content.inert, true); assert.equal(progress.hidden, false); assert.equal(progress.attributes.role, 'status'); assert.equal(progress.attributes['aria-live'], 'polite'); assert.equal(byClass(f.root, 'open-workflow').attributes['aria-busy'], 'true');
        assert.match(progress.textContent, /Adding selected studies/); assert.equal(cancel.disabled, false); assert.equal(actions(f.root, 'back')[0].disabled, true); assert.equal(actions(f.root, 'add')[0].disabled, true); assert.equal(f.document.activeElement, cancel); assert.equal(cancel.attributes['aria-describedby'], byClass(f.root, 'open-workflow-progress-label').id); assert.equal(starts, 0);
        paint.frame(); await tick(); assert.equal(starts, 0); paint.frame(); await tick(); assert.equal(starts, 1); assert.ok(signal instanceof AbortSignal); assert.equal(paint.frames.size, 0); assert.equal(paint.timers.size, 0);
        f.click('add'); assert.equal(starts, 1); resolve(); await tick(); assert.equal(f.workflow.getState().open, false); assert.equal(progress.hidden, true); assert.equal(content.inert, false); assert.equal(byClass(f.root, 'open-workflow').attributes['aria-busy'], 'false');
    } finally { f.cleanup(); }
});

test('Cancel before the first Add paint prevents heavy work and does not affect a reopened workflow', async () => {
    let starts = 0; const f = fixture({onCommitLocal: async () => { starts++; }}), paint = controlledPaint(f);
    try {
        const launcher = f.document.createElement('button'); launcher.focus(); f.workflow.open('images'); await previewLocal(f, [{name: 'synthetic'}]); f.click('add'); assert.equal(paint.frames.size, 1); f.click('close');
        assert.equal(f.document.activeElement, launcher); assert.equal(paint.frames.size, 0); assert.equal(paint.timers.size, 0); assert.equal(byClass(f.root, 'open-workflow-progress').hidden, true); assert.equal(byClass(f.root, 'open-workflow-content').inert, false);
        f.workflow.open('test'); paint.frame(); paint.fallback(); await tick(); assert.equal(starts, 0); assert.equal(f.workflow.getState().step, 'test'); assert.equal(f.workflow.getState().busy, false);
    } finally { f.cleanup(); }
});

test('Escape aborts an active final Add and stale completion cannot close a different workflow', async () => {
    let resolve, received; const f = fixture({onCommitLocal: (preview, {signal}) => { received = signal; return new Promise(done => { resolve = done; }); }}), paint = controlledPaint(f);
    try {
        f.workflow.open('images'); await previewLocal(f, [{name: 'synthetic'}]); f.click('add'); paint.frame(); paint.frame(); await tick(); assert.equal(received.aborted, false);
        event(f.root, byClass(f.root, 'open-workflow'), 'cancel'); assert.equal(received.aborted, true); f.workflow.open('study'); resolve(); await tick(); assert.equal(f.workflow.getState().step, 'study'); assert.equal(f.workflow.getState().open, true); assert.equal(byClass(f.root, 'open-workflow-progress').hidden, true); assert.equal(byClass(f.root, 'open-workflow-content').inert, false);
    } finally { f.cleanup(); }
});

test('failed final Add restores selected studies, interactive controls and recoverable inline feedback', async () => {
    let fail = true; const f = fixture({onCommitLocal: async () => { if (fail) throw new Error('Generated source failed.'); }}), paint = controlledPaint(f);
    try {
        f.workflow.open('study'); await previewLocal(f, [{name: 'DICOMDIR'}], {intent: 'study'}); checkStudy(f, 'a-old'); f.click('add'); paint.frame(); paint.frame(); await tick();
        assert.equal(f.workflow.getState().busy, false); assert.equal(f.workflow.getState().open, true); assert.deepEqual(f.workflow.getState().selectedStudyIds, ['a-old']); assert.match(f.workflow.getState().error, /Generated source failed/); assert.equal(byClass(f.root, 'open-workflow-progress').hidden, true); assert.equal(byClass(f.root, 'open-workflow-content').inert, false); assert.equal(actions(f.root, 'add')[0].disabled, false); assert.equal(actions(f.root, 'back')[0].disabled, false); assert.equal(f.document.activeElement, byClass(f.root, 'open-workflow-title'));
        fail = false; f.click('add'); paint.frame(); paint.frame(); await tick(); assert.equal(f.workflow.getState().open, false);
    } finally { f.cleanup(); }
});

test('independent source cancellation during final Add restores interaction without an error', async () => {
    const f = fixture({onCommitLocal: async () => { throw new DOMException('Generated cancellation.', 'AbortError'); }}), paint = controlledPaint(f);
    try {
        f.workflow.open('images'); await previewLocal(f, [{name: 'synthetic'}]); f.click('add'); paint.frame(); paint.frame(); await tick();
        assert.equal(f.workflow.getState().busy, false); assert.equal(f.workflow.getState().error, ''); assert.equal(byClass(f.root, 'open-workflow-content').inert, false); assert.equal(byClass(f.root, 'open-workflow-progress').hidden, true); assert.match(byClass(f.root, 'open-workflow-status').textContent, /canceled.*try again/); assert.equal(actions(f.root, 'add')[0].disabled, false);
    } finally { f.cleanup(); }
});

test('the bounded paint fallback starts Add in a background document and clears pending frame work', async () => {
    let starts = 0; const f = fixture({onCommitLocal: async () => { starts++; }}), paint = controlledPaint(f);
    try {
        f.workflow.open('images'); await previewLocal(f, [{name: 'synthetic'}]); f.click('add'); paint.fallback(); await tick(); assert.equal(starts, 1); assert.equal(f.workflow.getState().open, false); assert.equal(paint.frames.size, 0); assert.equal(paint.timers.size, 0);
    } finally { f.cleanup(); }
});

test('remote patient and study metadata reads use the same cancelable painted progress guard as final Add', async () => {
    let foundPatients, foundStudies, added, searches = 0, listings = 0;
    const f = fixture({onSearchRemote: () => { searches++; return new Promise(done => { foundPatients = done; }); },
        onListRemoteStudies: () => { listings++; return new Promise(done => { foundStudies = done; }); },
        onCommitRemote: () => new Promise(done => { added = done; })}), paint = controlledPaint(f);
    try {
        f.workflow.open('study'); f.click('remote'); f.click('source'); input(f, 'patientId', 'ID-a'); event(f.root, walk(f.root).find(node => node.dataset.openForm === 'criteria'), 'submit');
        assert.equal(searches, 0); assert.equal(byClass(f.root, 'open-workflow-content').inert, true); assert.match(byClass(f.root, 'open-workflow-progress').textContent, /Finding matching patients/);
        paint.frame(); paint.frame(); await tick(); assert.equal(searches, 1); foundPatients({items: [patient('a')]}); await tick(); assert.equal(byClass(f.root, 'open-workflow-progress').hidden, true);
        f.click('patient'); assert.equal(listings, 0); assert.equal(byClass(f.root, 'open-workflow-content').inert, true); assert.match(byClass(f.root, 'open-workflow-progress').textContent, /Finding this patient’s studies/);
        paint.frame(); paint.frame(); await tick(); assert.equal(listings, 1); foundStudies({items: [study('remote')]}); await tick(); assert.equal(byClass(f.root, 'open-workflow-progress').hidden, true);
        checkStudy(f, 'remote'); f.click('add'); assert.equal(byClass(f.root, 'open-workflow-progress').hidden, false); assert.match(byClass(f.root, 'open-workflow-progress').textContent, /Adding selected studies/); paint.frame(); paint.frame(); await tick(); added(); await tick(); assert.equal(f.workflow.getState().open, false);
    } finally { f.cleanup(); }
});

test('synthetic opening has the same progress guard and disposal cancels pending paint work', async () => {
    let starts = 0; const f = fixture({onOpenTest: async () => { starts++; }}), paint = controlledPaint(f);
    f.workflow.open('test'); f.click('open-test'); assert.equal(byClass(f.root, 'open-workflow-progress').hidden, false); assert.match(byClass(f.root, 'open-workflow-progress').textContent, /synthetic test images/); f.cleanup(); assert.equal(paint.frames.size, 0); assert.equal(paint.timers.size, 0); paint.frame(); await tick(); assert.equal(starts, 0); assert.equal(f.root.children.length, 0);
});

test('native local selection immediately dims inert content and paints a busy indicator before indexing starts', async () => {
    for (const intent of ['images', 'study']) {
        let resolve, received, starts = 0;
        const f = fixture({onPreviewLocal: (files, {signal}) => { starts++; received = signal; return new Promise(done => { resolve = done; }); }}), paint = controlledPaint(f);
        try {
            f.workflow.open(intent); const pending = f.workflow.acceptFiles([{name: 'synthetic-input'}], {intent});
            const overlay = byClass(f.root, 'open-workflow-progress'), content = byClass(f.root, 'open-workflow-content'), cancel = actions(f.root, 'close').at(-1);
            assert.equal(f.workflow.getState().busy, true); assert.equal(overlay.hidden, false); assert.equal(content.inert, true); assert.equal(byClass(f.root, 'open-workflow-stage').dataset.busy, 'true');
            assert.match(overlay.textContent, intent === 'study' ? /Preparing local studies/ : /Reading local files/); assert.doesNotMatch(overlay.textContent, /upload/i); assert.equal(cancel.disabled, false); assert.equal(f.document.activeElement, cancel); assert.equal(starts, 0);
            paint.frame(); await tick(); assert.equal(starts, 0); paint.frame(); await tick(); assert.equal(starts, 1); assert.ok(received instanceof AbortSignal);
            resolve({patients: [patient('a')]}); await pending;
            assert.equal(f.workflow.getState().busy, false); assert.equal(overlay.hidden, true); assert.equal(content.inert, false); assert.equal(byClass(f.root, 'open-workflow-stage').dataset.busy, 'false'); assert.equal(actions(f.root, 'add')[0].disabled, intent === 'study'); assert.equal(f.calls.some(call => call[0] === 'commit-local'), false);
        } finally { f.cleanup(); }
    }
});

test('canceling before the initial indexing paint prevents reading selected files or changing a reopened workflow', async () => {
    let starts = 0; const f = fixture({onPreviewLocal: async () => { starts++; return {patients: [patient('stale')]}; }}), paint = controlledPaint(f);
    try {
        f.workflow.open('study'); const pending = f.workflow.acceptFiles([{name: 'DICOMDIR'}], {intent: 'study'}); assert.equal(paint.frames.size, 1);
        f.click('close'); f.workflow.open('test'); await pending; paint.frame(); paint.fallback(); await tick();
        assert.equal(starts, 0); assert.equal(f.workflow.getState().step, 'test'); assert.equal(f.workflow.getState().patientCount, 0); assert.equal(byClass(f.root, 'open-workflow-content').inert, false); assert.equal(byClass(f.root, 'open-workflow-progress').hidden, true); assert.equal(f.calls.some(call => call[0] === 'commit-local'), false);
    } finally { f.cleanup(); }
});

test('canceling active indexing aborts its source signal and a late result cannot add files or populate another workflow', async () => {
    let resolve, received; const f = fixture({onPreviewLocal: (files, {signal}) => { received = signal; return new Promise(done => { resolve = done; }); }}), paint = controlledPaint(f);
    try {
        f.workflow.open('study'); const pending = f.workflow.acceptFiles([{name: 'DICOMDIR'}], {intent: 'study'}); paint.frame(); paint.frame(); await tick(); assert.equal(received.aborted, false);
        event(f.root, byClass(f.root, 'open-workflow'), 'cancel'); assert.equal(received.aborted, true); f.workflow.open('images'); resolve({patients: [patient('stale')]}); await pending;
        assert.equal(f.workflow.getState().step, 'images'); assert.equal(f.workflow.getState().busy, false); assert.equal(f.workflow.getState().patientCount, 0); assert.equal(byClass(f.root, 'open-workflow-content').inert, false); assert.equal(f.calls.some(call => call[0] === 'commit-local'), false);
    } finally { f.cleanup(); }
});

test('an indexing error releases the overlay and controls so the user can choose different files', async () => {
    const f = fixture({onPreviewLocal: async () => { throw new Error('Generated media has no readable directory.'); }}), paint = controlledPaint(f);
    try {
        f.workflow.open('study'); const pending = f.workflow.acceptFiles([{name: 'DICOMDIR'}], {intent: 'study'}); paint.frame(); paint.frame(); await pending;
        assert.equal(f.workflow.getState().busy, false); assert.match(f.workflow.getState().error, /Generated media/); assert.equal(byClass(f.root, 'open-workflow-progress').hidden, true); assert.equal(byClass(f.root, 'open-workflow-content').inert, false); assert.equal(actions(f.root, 'pick-study-folder')[0].disabled, false); assert.equal(f.document.activeElement, byClass(f.root, 'open-workflow-title'));
    } finally { f.cleanup(); }
});

const bulk = f => walk(f.root).find(node => node.dataset.openSelectAll != null);
function selectAll(f, checked = true) { const node = bulk(f); assert.ok(node); node.checked = checked; event(f.root, node, 'change'); }

test('local select all covers every discovered study for this patient across pages and never another patient', async () => {
    const studies = Array.from({length: 61}, (_, i) => study(`a-${i}`));
    const f = fixture({onPreviewLocal: async () => ({patients: [patient('a', {studies}), patient('b')]})});
    try {
        f.workflow.open('study'); await previewLocal(f, [{name: 'DICOMDIR'}], {intent: 'study'}); f.click('patient');
        assert.equal(walk(f.root).filter(node => node.dataset.openStudy != null).length, 25); assert.match(byClass(f.root, 'open-workflow-select-all').textContent, /all 61 studies for this patient/);
        selectAll(f); assert.deepEqual(f.workflow.getState().selectedStudyIds, studies.map(item => item.id)); assert.equal(bulk(f).checked, true); assert.equal(bulk(f).indeterminate, false); assert.match(byClass(f.root, 'open-workflow-selection-count').textContent, /61 of 61 available studies selected/);
        f.click('studies-next'); assert.equal(walk(f.root).filter(node => node.dataset.openStudy != null && node.checked).length, 25); f.click('studies-next'); assert.equal(walk(f.root).filter(node => node.dataset.openStudy != null && node.checked).length, 11);
        f.click('add'); await tick(); const request = f.calls.find(call => call[0] === 'commit-local')[2]; assert.equal(request.patientId, 'a'); assert.deepEqual(request.studyIds, studies.map(item => item.id)); assert.equal(request.selection.length, 1); assert.equal(request.selection[0].patientId, 'a');
    } finally { f.cleanup(); }
});

test('local study partial and cleared selections remain consistent across pages with an accessible mixed checkbox', async () => {
    const f = fixture({onPreviewLocal: async () => ({patients: [patient('a', {studies: Array.from({length: 31}, (_, i) => study(String(i)))})]})});
    try {
        f.workflow.open('study'); await previewLocal(f, [{name: 'DICOMDIR'}], {intent: 'study'}); selectAll(f); f.click('studies-next'); checkStudy(f, '30', false);
        assert.equal(bulk(f).checked, false); assert.equal(bulk(f).indeterminate, true); assert.equal(bulk(f).attributes['aria-checked'], 'mixed'); assert.match(byClass(f.root, 'open-workflow-selection-count').textContent, /30 of 31/); assert.equal(byClass(f.root, 'open-workflow-selection-count').attributes['aria-live'], 'polite');
        f.click('studies-previous'); assert.equal(bulk(f).indeterminate, true); assert.equal(walk(f.root).filter(node => node.dataset.openStudy != null && node.checked).length, 25);
        f.click('clear-studies'); assert.deepEqual(f.workflow.getState().selectedStudyIds, []); assert.equal(bulk(f).checked, false); assert.equal(bulk(f).indeterminate, false); assert.equal(bulk(f).attributes['aria-checked'], 'false'); assert.equal(actions(f.root, 'add')[0].disabled, true);
        f.click('studies-next'); assert.equal(walk(f.root).filter(node => node.dataset.openStudy != null && node.checked).length, 0); selectAll(f); selectAll(f, false); assert.deepEqual(f.workflow.getState().selectedStudyIds, []);
    } finally { f.cleanup(); }
});

test('changing the selected local patient clears previous bulk choices and recomputes the eligible scope', async () => {
    const f = fixture({onPreviewLocal: async () => ({patients: [patient('a', {studies: Array.from({length: 30}, (_, i) => study(String(i)))}), patient('b')]})});
    try {
        f.workflow.open('study'); await previewLocal(f, [{name: 'DICOMDIR'}], {intent: 'study'}); f.click('patient'); selectAll(f); assert.equal(f.workflow.getState().selectedStudyIds.length, 30);
        f.click('back'); f.click('patient', 1); assert.equal(f.workflow.getState().patientId, 'b'); assert.deepEqual(f.workflow.getState().selectedStudyIds, []); assert.match(byClass(f.root, 'open-workflow-select-all').textContent, /all 2 studies for this patient/); selectAll(f); assert.deepEqual(f.workflow.getState().selectedStudyIds, ['b-new', 'b-old']);
    } finally { f.cleanup(); }
});

test('bulk and individual study selection agree about explicitly unavailable studies without excluding unknown profiles', async () => {
    const candidates = [study('good'), study('unknown-profile', {status: 'unknown'}), study('unsupported', {status: 'unsupported'}), study('unavailable', {status: 'unavailable'}), study('error', {status: 'error'})];
    const f = fixture({onPreviewLocal: async () => ({patients: [patient('a', {studies: candidates})]})});
    try {
        f.workflow.open('study'); await previewLocal(f, [{name: 'DICOMDIR'}], {intent: 'study'}); selectAll(f);
        assert.deepEqual(f.workflow.getState().selectedStudyIds, ['good', 'unknown-profile']); assert.match(byClass(f.root, 'open-workflow-select-all').textContent, /all 2 studies/);
        for (const id of ['unsupported', 'unavailable', 'error']) { const row = walk(f.root).find(node => node.dataset.openStudy === id); assert.equal(row.disabled, true); checkStudy(f, id); }
        assert.deepEqual(f.workflow.getState().selectedStudyIds, ['good', 'unknown-profile']);
    } finally { f.cleanup(); }
});

test('remote select all names its page scope, preserves earlier choices and never fetches hidden pages', async () => {
    const requests = [];
    const f = fixture({onSearchRemote: async () => ({items: [patient('a')]}), onListRemoteStudies: async (source, patient, {offset}) => {
        requests.push(offset); return {items: Array.from({length: 25}, (_, i) => study(String(offset + i))), nextOffset: offset === 0 ? 25 : 50};
    }});
    try {
        await remotePatient(f); f.click('patient'); await tick(); assert.match(byClass(f.root, 'open-workflow-select-all').textContent, /on this page/); selectAll(f); assert.equal(f.workflow.getState().selectedStudyIds.length, 25); assert.deepEqual(requests, [0]);
        f.click('studies-next'); await tick(); assert.deepEqual(requests, [0, 25]); assert.equal(bulk(f).checked, false); assert.match(byClass(f.root, 'open-workflow-selection-count').textContent, /0 studies selected on this page · 25 studies selected across pages/);
        checkStudy(f, '25'); assert.equal(bulk(f).indeterminate, true); selectAll(f); assert.equal(f.workflow.getState().selectedStudyIds.length, 50); assert.deepEqual(requests, [0, 25]);
        selectAll(f, false); assert.equal(f.workflow.getState().selectedStudyIds.length, 25); assert.ok(f.workflow.getState().selectedStudyIds.every(id => Number(id) < 25)); f.click('clear-studies'); assert.deepEqual(f.workflow.getState().selectedStudyIds, []); assert.deepEqual(requests, [0, 25]);
    } finally { f.cleanup(); }
});

test('an explicitly refreshed remote page removes a newly unavailable checked study without querying unseen pages', async () => {
    let firstPageReads = 0; const requests = [];
    const f = fixture({onSearchRemote: async () => ({items: [patient('a')]}), onListRemoteStudies: async (source, patient, {offset}) => {
        requests.push(offset); if (offset) return {items: [study('other-page')], nextOffset: null};
        firstPageReads++; return {items: [study('changed', firstPageReads > 1 ? {status: 'unavailable'} : {})], nextOffset: 25};
    }});
    try {
        await remotePatient(f); f.click('patient'); await tick(); selectAll(f); assert.deepEqual(f.workflow.getState().selectedStudyIds, ['changed']);
        f.click('studies-next'); await tick(); f.click('studies-previous'); await tick();
        assert.deepEqual(requests, [0, 25, 0]); assert.deepEqual(f.workflow.getState().selectedStudyIds, []); assert.equal(bulk(f).disabled, true); assert.equal(actions(f.root, 'add')[0].disabled, true);
    } finally { f.cleanup(); }
});

test('expired local Store sessions offer sign-in without losing criteria and require an explicit search retry', async () => {
    const { localStoreAuthenticationHelp } = await import('../src/integration/local-store-authentication.js');
    for (const id of ['easi-store-web', 'easi-store-dimse']) {
        const requests = []; let signedIn = false;
        const f = fixture({getAuthenticationHelp: localStoreAuthenticationHelp, onSearchRemote: async (source, filters) => {
            requests.push({source, filters});
            if (!signedIn) throw Object.assign(new Error('The archive returned HTTP 401.'), {status: 401});
            return {items: [patient('a')]};
        }}); f.sources[0].id = id;
        try {
            f.workflow.open('study'); f.click('remote'); f.click('source'); input(f, 'patientName', 'Synthetic*');
            const submit = () => event(f.root, walk(f.root).find(node => node.dataset.openForm === 'criteria'), 'submit');
            submit(); await tick();
            assert.equal(f.workflow.getState().step, 'criteria'); assert.match(f.workflow.getState().error, /session is missing or has expired/);
            assert.equal(fields(f.root).find(node => node.dataset.openFilter === 'patientName').value, 'Synthetic*');
            const link = byClass(f.root, 'open-workflow-sign-in'); assert.ok(link);
            assert.equal(link.href, '/easi-store/sign-in'); assert.equal(link.target, '_blank'); assert.equal(link.rel, 'noopener noreferrer');
            assert.equal(requests.length, 1, 'offering sign-in never repeats a patient request');
            signedIn = true; await tick(); assert.equal(requests.length, 1, 'sign-in does not automatically replay an action');
            submit(); await tick(); assert.equal(f.workflow.getState().step, 'patients');
            assert.equal(requests.length, 2); assert.deepEqual(requests[1], requests[0]);
            assert.equal(byClass(f.root, 'open-workflow-sign-in'), undefined);
        } finally { f.cleanup(); }
    }
});

test('authentication failure during admission preserves checked studies and never commits again without Add', async () => {
    const { localStoreAuthenticationHelp } = await import('../src/integration/local-store-authentication.js');
    let commits = 0;
    const f = fixture({getAuthenticationHelp: localStoreAuthenticationHelp, onSearchRemote: async () => ({items: [patient('a')]}),
        onListRemoteStudies: async () => ({items: [study('one'), study('two')]}), onCommitRemote: async () => {
            if (++commits === 1) throw Object.assign(new Error('HTTP 401'), {status: 401});
        }}); f.sources[0].id = 'easi-store-web';
    try {
        await remotePatient(f); f.click('patient'); await tick(); checkStudy(f, 'one'); checkStudy(f, 'two'); f.click('add'); await tick();
        assert.equal(f.workflow.getState().step, 'studies'); assert.deepEqual(f.workflow.getState().selectedStudyIds, ['one', 'two']);
        assert.ok(byClass(f.root, 'open-workflow-sign-in')); assert.equal(commits, 1);
        await tick(); assert.equal(commits, 1); f.click('add'); await tick(); assert.equal(commits, 2); assert.equal(f.workflow.getState().open, false);
    } finally { f.cleanup(); }
});

test('unrelated sources, non-auth failures and unsafe host links never show a Store sign-in action', async () => {
    const { localStoreAuthenticationHelp } = await import('../src/integration/local-store-authentication.js');
    const cases = [{id: 'orthanc', status: 401}, {id: 'easi-store-web', status: 403}, {id: 'easi-store-dimse', status: 502},
        ...['javascript:alert(1)', '//foreign.invalid/login', '/signin?PatientID=SYNTHETIC', '/signin#secret', '/bad\\path'].map(href => ({id: 'easi-store-web', status: 401, href}))];
    for (const value of cases) {
        const f = fixture({getAuthenticationHelp: value.href ? () => ({href: value.href, label: 'Unsafe'}) : localStoreAuthenticationHelp,
            onSearchRemote: async () => { throw Object.assign(new Error(`HTTP ${value.status}`), {status: value.status}); }}); f.sources[0].id = value.id;
        try { await remotePatient(f); assert.equal(byClass(f.root, 'open-workflow-sign-in'), undefined); if (value.status === 401) assert.match(f.workflow.getState().error, /Sign in to this repository/); }
        finally { f.cleanup(); }
    }
});

test('source changes and close/reopen clear sign-in guidance', async () => {
    const { localStoreAuthenticationHelp } = await import('../src/integration/local-store-authentication.js');
    const f = fixture({getAuthenticationHelp: localStoreAuthenticationHelp, onSearchRemote: async () => { throw Object.assign(new Error('HTTP 401'), {status: 401}); }}); f.sources[0].id = 'easi-store-web';
    try {
        await remotePatient(f); assert.ok(byClass(f.root, 'open-workflow-sign-in')); f.click('back'); assert.equal(byClass(f.root, 'open-workflow-sign-in'), undefined);
        f.workflow.close(); f.workflow.open('study'); assert.equal(byClass(f.root, 'open-workflow-sign-in'), undefined); assert.equal(f.workflow.getState().error, '');
    } finally { f.cleanup(); }
});

test('remote storage has one manager entry point and can resume source selection without querying', () => {
    let opened = 0;
    const f = fixture({ onManageSources: () => { opened++; }, onConfigureSource: () => { throw new Error('Legacy form should not run.'); } }, { sourceEditing: true });
    try {
        f.workflow.open('remote');
        assert.equal(f.workflow.getState().step, 'sources');
        assert.equal(actions(f.root, 'manage-sources').length, 1);
        assert.equal(byClass(f.root, 'open-workflow-settings'), undefined);
        f.click('manage-sources'); assert.equal(opened, 1);
        assert.equal(f.calls.some(call => call[0] === 'commit-remote'), false);
        f.workflow.close(); f.options.getPolicy = () => ({ remoteStudies: false });
        f.workflow.open('remote'); assert.notEqual(f.workflow.getState().step, 'sources');
        assert.equal(actions(f.root, 'manage-sources').length, 0);
    } finally { f.cleanup(); }
});

test('managed source settings remain available for connection testing when user editing is disabled', () => {
    let opened = 0; const f = fixture({ onManageSources: () => opened++ }, { sourceEditing: false });
    try { f.workflow.open('sources'); assert.equal(actions(f.root, 'manage-sources').length, 1); f.click('manage-sources'); assert.equal(opened, 1); }
    finally { f.cleanup(); }
});
