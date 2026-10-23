import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalLibraryPanel } from '../src/ui/LocalLibraryPanel.js';

class Element extends EventTarget {
    constructor(tagName, ownerDocument) {
        super(); this.tagName = tagName; this.ownerDocument = ownerDocument; this.children = []; this.parentNode = null;
        this.attributes = {}; this.dataset = {}; this.value = ''; this.hidden = false; this.disabled = false; this._text = '';
    }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.replaceChildren(); }
    set innerHTML(value) { throw new Error('Local metadata must never become HTML.'); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
    append(...children) { for (const child of children) { child.remove(); child.parentNode = this; this.children.push(child); } }
    replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...children); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
    focus() { this.ownerDocument.activeElement = this; }
}
const walk = node => node.children.flatMap(child => [child, ...walk(child)]);
const find = (root, className) => walk(root).find(node => node.className?.split(' ').includes(className));
const actions = (root, action) => walk(root).filter(node => node.dataset?.localAction === action);
const byStudy = (root, action, id) => actions(root, action).find(node => node.dataset.studyId === id);
function event(root, target, type = 'click') {
    assert.ok(target, `Expected ${type} target`); const e = new Event(type); Object.defineProperty(e, 'target', {value: target}); find(root, 'local-library').dispatchEvent(e);
}
const series = (id, changes = {}) => ({id, seriesUid: `2.25.${id.length}`, description: `Axial ${id}`, modality: 'CT', seriesNumber: 1, instanceCount: 1, frameCount: 12, status: 'indexed', ...changes});
const study = (id, date, changes = {}) => ({id, studyUid: `2.25.${id.length}`, studyDate: date, description: `Chest ${id}`, modalities: ['CT'], instanceCount: 1, frameCount: 12, series: [series(`${id}-series`)], ...changes});
const patient = (id, changes = {}) => ({id, patientName: `Synthetic^${id}`, patientId: `ID-${id}`, issuerOfPatientId: 'SYNTHETIC', patientBirthDate: '19800506', identityStatus: 'issuer-qualified', studies: [study(`${id}-new`, '20261016'), study(`${id}-old`, '20240612')], ...changes});
function fixture(view = {patients: [patient('a')]}, state = {}) {
    const document = {activeElement: null, createElement: tag => new Element(tag, document)}, root = document.createElement('div'), calls = [];
    const callbacks = Object.fromEntries(['onSelectPatient', 'onOpenStudy', 'onOpenSeries', 'onCompareStudies', 'onImportFiles', 'onImportFolder', 'onCancelImport', 'onClearLocalLibrary', 'onAssociatePatient'].map(key => [key, (...args) => calls.push([key, ...args])]));
    const panel = new LocalLibraryPanel(root, callbacks); panel.setCatalog(view, state);
    return {root, document, calls, callbacks, panel, click(action, target = actions(root, action)[0]) { event(root, target); }, update(nextView = view, nextState = state) { view = nextView; state = nextState; panel.setCatalog(view, state); }, cleanup() { panel.dispose(); }};
}

test('DICOMDIR outcome explains unresolved references and media progress separately from image indexing', () => {
    const media = { mode: 'dicomdir', resolved: 3, missing: 1, invalid: 0, ambiguous: 0, unsupported: 1, warnings: ['Select the complete media folder.'] };
    const f = fixture({ patients: [] }, { media });
    try {
        const note = find(f.root, 'local-library-media');
        assert.equal(note.hidden, false); assert.match(note.textContent, /DICOMDIR.*3 referenced images.*1 missing.*1 unsupported/);
        assert.match(note.textContent, /complete media folder/);
        f.update({ patients: [] }, { media: { ...media, missing: 0, unsupported: 0, warnings: ['A recoverable directory pointer was inconsistent.'] } });
        assert.equal(note.dataset.kind, 'warning'); assert.match(note.textContent, /recoverable directory pointer/);
        f.update({ patients: [] }, { busy: true, indexing: true, progress: { phase: 'media', total: 1, completed: 0 } });
        assert.match(find(f.root, 'local-library-message').textContent, /Reading DICOMDIR media index/);
        assert.equal(note.hidden, true);
    } finally { f.cleanup(); }
});

test('empty local catalog explains additive local imports and invokes independent file/folder actions', () => {
    const f = fixture({patients: []});
    try {
        assert.match(f.root.textContent, /Files stay on this device/); assert.equal(f.panel.getState().patientCount, 0);
        f.click('import-files'); f.click('import-folder'); assert.deepEqual(f.calls, [['onImportFiles'], ['onImportFolder']]);
        assert.equal(actions(f.root, 'clear-library')[0].hidden, true);
        assert.equal(find(f.root, 'local-library-search').attributes['aria-label'], 'Find a local patient by name, ID, issuer, or birth date');
    } finally { f.cleanup(); }
});

test('several patients remain a selection list and never auto-open or compare', () => {
    const f = fixture({patients: [patient('a'), patient('b')]});
    try {
        assert.equal(f.panel.getState().findingPatient, true); assert.equal(actions(f.root, 'select-patient').length, 2); assert.deepEqual(f.calls, []);
        f.click('select-patient', actions(f.root, 'select-patient')[1]); assert.deepEqual(f.calls, [['onSelectPatient', 'b']]);
        f.update(undefined, {activePatientId: 'b'}); assert.equal(find(f.root, 'local-library-finder').hidden, true); assert.equal(find(f.root, 'local-library-patient').hidden, false);
        assert.match(find(f.root, 'local-library-patient').textContent, /Synthetic b/); assert.equal(actions(f.root, 'open-study').length, 2);
        f.click('change-patient'); assert.equal(f.panel.getState().findingPatient, true); assert.equal(f.document.activeElement, find(f.root, 'local-library-search'));
    } finally { f.cleanup(); }
});

test('patient search matches literal names, issuer, patient ID and unambiguous birth dates without HTML', () => {
    const evil = '<img src="https://unrequested.invalid/">', view = {patients: [patient('a', {patientName: evil}), patient('b')]}, f = fixture(view);
    try {
        assert.ok(f.root.textContent.includes(evil)); assert.equal(walk(f.root).some(node => ['img', 'script', 'a'].includes(node.tagName)), false);
        const input = find(f.root, 'local-library-search');
        for (const [term, count] of [['id-a', 1], ['SYNTHETIC 06 MAY 1980', 2], ['19800506', 2], ['<img', 1], ['not-present', 0]]) {
            input.value = term; input.dispatchEvent(new Event('input')); assert.equal(f.panel.getState().matchedPatientCount, count);
        }
        assert.match(find(f.root, 'local-library-patients').textContent, /No patients match/); assert.deepEqual(f.calls, []);
    } finally { f.cleanup(); }
});

test('timeline is newest first, preserves absolute dates and supports both earlier and later comparison studies', () => {
    const view = {patients: [patient('a', {studies: [study('old', '20240612'), study('unknown', ''), study('new', '20261016')]})]}, f = fixture(view, {activePatientId: 'a', currentStudyId: 'old'});
    try {
        assert.deepEqual(actions(f.root, 'open-study').map(node => node.dataset.studyId), ['new', 'old', 'unknown']);
        assert.match(find(f.root, 'local-library-timeline').textContent, /16 Oct 2026/); assert.match(find(f.root, 'local-library-timeline').textContent, /12 Jun 2024/);
        assert.equal(byStudy(f.root, 'compare-study', 'old').disabled, true); assert.equal(byStudy(f.root, 'compare-study', 'new').disabled, false);
        f.click('compare-study', byStudy(f.root, 'compare-study', 'new')); assert.deepEqual(f.calls[0], ['onCompareStudies', 'old', 'new', {comparisonSeriesId: 'new-series'}]);
        assert.match(find(f.root, 'local-library-comparison-hint').textContent, /Spatial linking stays off/);
    } finally { f.cleanup(); }
});

test('comparison is disabled without a current study in the selected patient, including foreign study IDs', () => {
    const view = {patients: [patient('a'), patient('b')]}, f = fixture(view, {activePatientId: 'a', currentStudyId: 'b-new'});
    try {
        assert.ok(actions(f.root, 'compare-study').every(node => node.disabled));
        f.click('compare-study', byStudy(f.root, 'compare-study', 'a-old')); assert.deepEqual(f.calls, []);
        f.update(undefined, {activePatientId: 'a'}); assert.ok(actions(f.root, 'compare-study').every(node => node.disabled));
    } finally { f.cleanup(); }
});

test('exact chosen series is passed for opening and comparison; series cards preserve current/comparison roles', () => {
    const view = {patients: [patient('a', {studies: [study('new', '20261016'), study('old', '20240612', {series: [series('old-axial'), series('old-coronal', {seriesNumber: 4})]})]})]}, f = fixture(view, {activePatientId: 'a', currentStudyId: 'new', comparisonStudyId: 'old'});
    try {
        const select = find(f.root, 'local-library-series-select'); select.value = 'old-coronal'; event(f.root, select, 'change');
        f.click('open-study', byStudy(f.root, 'open-study', 'old')); assert.deepEqual(f.calls.pop(), ['onOpenStudy', 'old', {patientId: 'a', seriesId: 'old-coronal'}]);
        f.update(undefined, {activePatientId: 'a', currentStudyId: 'new'}); f.click('compare-study', byStudy(f.root, 'compare-study', 'old'));
        assert.deepEqual(f.calls.pop(), ['onCompareStudies', 'new', 'old', {comparisonSeriesId: 'old-coronal'}]);
        f.update(undefined, {activePatientId: 'a', currentStudyId: 'new', comparisonStudyId: 'old', selectedSeriesId: 'old-coronal'});
        const button = actions(f.root, 'open-series').find(node => node.dataset.seriesId === 'old-coronal'); assert.equal(button.attributes['aria-pressed'], 'true');
        f.click('open-series', button); assert.deepEqual(f.calls.pop(), ['onOpenSeries', 'old-coronal', {patientId: 'a', studyId: 'old', role: 'comparison'}]);
    } finally { f.cleanup(); }
});

test('expanded studies retain manual collapse across repeated snapshots and focus follows the toggle', () => {
    const f = fixture(undefined, {activePatientId: 'a', currentStudyId: 'a-new'});
    try {
        assert.equal(byStudy(f.root, 'toggle-study', 'a-new').attributes['aria-expanded'], 'true');
        f.click('toggle-study', byStudy(f.root, 'toggle-study', 'a-new')); assert.equal(byStudy(f.root, 'toggle-study', 'a-new').attributes['aria-expanded'], 'false');
        assert.equal(f.document.activeElement, byStudy(f.root, 'toggle-study', 'a-new'));
        f.update(); assert.equal(byStudy(f.root, 'toggle-study', 'a-new').attributes['aria-expanded'], 'false');
        assert.equal(f.document.activeElement, byStudy(f.root, 'toggle-study', 'a-new'));
    } finally { f.cleanup(); }
});

test('local identity is qualified and cross-import association requires explicit demographic review and checked consent', () => {
    const view = {patients: [patient('a', {issuerOfPatientId: '', identityStatus: 'batch-scoped'}), patient('b', {issuerOfPatientId: '', identityStatus: 'batch-scoped', patientBirthDate: '19911213'})]}, f = fixture(view, {activePatientId: 'a'});
    try {
        assert.match(find(f.root, 'local-library-patient').textContent, /imports kept separate/); f.click('change-patient');
        f.click('review-association'); const review = find(f.root, 'local-library-association'); assert.equal(review.hidden, false);
        assert.match(review.textContent, /Synthetic a/); assert.match(review.textContent, /Synthetic b/); assert.match(review.textContent, /13 Dec 1991/); assert.match(review.textContent, /Original DICOM attributes stay unchanged/);
        const confirm = actions(f.root, 'confirm-association')[0]; assert.equal(confirm.disabled, true); f.click('confirm-association'); assert.deepEqual(f.calls, []);
        const checkbox = walk(review).find(node => node.type === 'checkbox'); checkbox.checked = true; checkbox.focus(); event(f.root, checkbox, 'change');
        assert.equal(f.document.activeElement, checkbox); assert.equal(confirm.disabled, false); f.click('confirm-association');
        assert.deepEqual(f.calls, [['onAssociatePatient', 'b', 'a']]); assert.equal(review.hidden, true);
    } finally { f.cleanup(); }
});

test('association confirmation resets on cancel and patient selection changes', () => {
    const view = {patients: [patient('a'), patient('b')]}, f = fixture(view, {activePatientId: 'a'});
    try {
        f.click('change-patient'); f.click('review-association'); const checkbox = walk(find(f.root, 'local-library-association')).find(node => node.type === 'checkbox'); checkbox.checked = true; event(f.root, checkbox, 'change');
        f.click('cancel-association'); assert.equal(find(f.root, 'local-library-association').hidden, true);
        f.click('review-association'); assert.equal(actions(f.root, 'confirm-association')[0].disabled, true);
        f.update(undefined, {activePatientId: 'b'}); assert.equal(find(f.root, 'local-library-association').hidden, true); assert.deepEqual(f.calls, []);
    } finally { f.cleanup(); }
});

test('busy indexing exposes progress and cancellation while preventing import/open/compare changes', () => {
    const f = fixture(undefined, {activePatientId: 'a', currentStudyId: 'a-new', busy: true, indexing: true, progress: {processed: 3, total: 11}});
    try {
        assert.match(find(f.root, 'local-library-message').textContent, /Indexing 3 of 11 files/); assert.equal(find(f.root, 'local-library-progress').value, 3);
        assert.equal(find(f.root, 'local-library-progress-row').hidden, false);
        assert.equal(find(f.root, 'local-library-progress').hidden, false);
        assert.equal(actions(f.root, 'import-files')[0].disabled, true); assert.ok(actions(f.root, 'open-study').every(node => node.disabled)); assert.ok(actions(f.root, 'compare-study').every(node => node.disabled));
        f.click('import-files'); f.click('cancel-import'); assert.deepEqual(f.calls, [['onCancelImport']]);
        f.update(undefined, {summary: '4 files indexed. 1 file skipped.'}); assert.match(find(f.root, 'local-library-message').textContent, /1 file skipped/);
        f.update(undefined, {summary: {added: 4, duplicates: 2, failed: 1}});
        assert.equal(find(f.root, 'local-library-message').textContent, '4 files indexed · 2 duplicates · 1 file skipped');
    } finally { f.cleanup(); }
});

test('pixel preparation has its own operation message and does not claim metadata indexing', () => {
    const f = fixture(undefined, {activePatientId: 'a', busy: true, indexing: false, operationLabel: 'Preparing comparison…'});
    try {
        assert.equal(find(f.root, 'local-library-message').textContent, 'Preparing comparison…');
        assert.equal(find(f.root, 'local-library-progress-row').hidden, false);
        assert.equal(find(f.root, 'local-library-progress').hidden, true);
        assert.equal(actions(f.root, 'cancel-import')[0].hidden, false);
        f.click('cancel-import'); assert.deepEqual(f.calls, [['onCancelImport']]);
        assert.equal(actions(f.root, 'import-files')[0].disabled, true);
        f.update(undefined, {busy: true, indexing: false, operationLabel: 'Opening selected series…'});
        assert.equal(find(f.root, 'local-library-message').textContent, 'Opening selected series…');
        assert.equal(find(f.root, 'local-library-progress-row').hidden, false);
        assert.equal(find(f.root, 'local-library-progress').hidden, true);
        f.update(undefined, {});
        assert.equal(find(f.root, 'local-library-progress-row').hidden, true);
    } finally { f.cleanup(); }
});

test('patient and study pagination bounds the DOM even for very large metadata catalogs', () => {
    const view = {patients: Array.from({length: 10001}, (_, index) => patient(String(index)))}, f = fixture(view);
    try {
        assert.equal(actions(f.root, 'select-patient').length, 25); f.click('patients-next'); assert.equal(actions(f.root, 'select-patient')[0].dataset.patientId, '25');
        const p = patient('a', {studies: Array.from({length: 101}, (_, index) => study(`study-${String(index).padStart(3, '0')}`, '20261016'))});
        f.update({patients: [p]}, {activePatientId: 'a'}); assert.equal(actions(f.root, 'open-study').length, 12); f.click('studies-next'); assert.equal(actions(f.root, 'open-study').length, 12); assert.equal(f.panel.getState().studyPage, 1);
    } finally { f.cleanup(); }
});

test('large series collections bound dropdowns and expanded cards while preserving exact choices across pages', () => {
    const s = study('large', '20261016', {series: Array.from({length: 1001}, (_, index) => series(`series-${index}`))});
    const f = fixture({patients: [patient('a', {studies: [s]})]}, {activePatientId: 'a', currentStudyId: 'large'});
    try {
        assert.equal(actions(f.root, 'open-series').length, 20); assert.ok(find(f.root, 'local-library-series-select').children.length <= 21);
        f.click('series-next'); assert.equal(actions(f.root, 'open-series')[0].dataset.seriesId, 'series-20'); assert.ok(find(f.root, 'local-library-series-select').children.length <= 21);
        const input = find(f.root, 'local-library-series-select'); input.value = 'series-22'; event(f.root, input, 'change');
        f.click('open-study'); assert.equal(f.calls.pop()[2].seriesId, 'series-22'); f.click('series-next'); f.click('open-study'); assert.equal(f.calls.pop()[2].seriesId, 'series-22');
    } finally { f.cleanup(); }
});

test('unsupported series remain visible and cannot be opened, but other series remain selectable', () => {
    const s = study('one', '20261016', {series: [series('unsupported', {status: 'unsupported'}), series('supported')]}), f = fixture({patients: [patient('a', {studies: [s]})]}, {activePatientId: 'a', currentStudyId: 'one'});
    try {
        const buttons = actions(f.root, 'open-series'); assert.equal(buttons[0].disabled, true); assert.equal(buttons[1].disabled, false);
        assert.match(buttons[0].textContent, /Not displayable/); f.click('open-series', buttons[0]); assert.deepEqual(f.calls, []);
        f.click('open-study'); assert.equal(f.calls[0][2].seriesId, 'supported');
    } finally { f.cleanup(); }
});

test('async action errors stay in the local panel and dispose removes handlers and retained metadata', async () => {
    const f = fixture(); f.callbacks.onImportFiles = () => Promise.reject(new Error('Synthetic indexing failure.'));
    f.click('import-files'); await Promise.resolve(); await Promise.resolve(); assert.match(find(f.root, 'local-library-message').textContent, /Synthetic indexing failure/);
    f.panel.dispose(); assert.equal(f.root.children.length, 0); assert.equal(f.panel.getState().patientCount, 0); assert.equal(f.panel.getState().disposed, true);
    f.panel.setCatalog({patients: [patient('new')]}); assert.equal(f.root.children.length, 0); f.panel.dispose();
});
