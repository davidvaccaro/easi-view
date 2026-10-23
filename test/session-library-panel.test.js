import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionLibraryPanel } from '../src/ui/SessionLibraryPanel.js';

class Element extends EventTarget {
    constructor(tagName, ownerDocument) { super(); Object.assign(this, { tagName, ownerDocument, children: [], parentNode: null, attributes: {}, dataset: {}, value: '', hidden: false, disabled: false, _text: '' }); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.replaceChildren(); }
    set innerHTML(value) { throw new Error('Session metadata cannot become HTML.'); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    append(...children) { for (const child of children) { child.remove(); child.parentNode = this; this.children.push(child); } }
    prepend(...children) { for (const child of [...children].reverse()) { child.remove(); child.parentNode = this; this.children.unshift(child); } }
    replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...children); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
    focus() { this.ownerDocument.activeElement = this; }
}
const walk = node => node.children.flatMap(child => [child, ...walk(child)]);
const find = (root, className) => walk(root).find(node => node.className?.split(' ').includes(className));
const actions = (root, action) => walk(root).filter(node => node.dataset?.sessionAction === action);
const byStudy = (root, action, id) => actions(root, action).find(node => node.dataset.studyId === id);
const series = (id, changes = {}) => ({ id, description: `Axial ${id}`, modality: 'CT', seriesNumber: 1, instanceCount: 300, frameCount: 300, status: 'indexed', ...changes });
const study = (id, changes = {}) => ({ id, studyDate: '20261019', description: `Examination ${id}`, modalities: ['CT'], sourceLabel: 'On this device', instanceCount: 300, seriesLoaded: true, series: [series(`${id}-axial`)], ...changes });
const patient = (id, changes = {}) => ({ id, patientName: `SYNTHETIC^${id}`, patientId: `MRN-${id}`, issuerOfPatientId: 'SYNTHETIC', patientBirthDate: '19800102', sourceLabel: 'On this device', studies: [study(`${id}-current`), study(`${id}-prior`, { studyDate: '20240101' })], ...changes });
function fixture(view = { patients: [patient('a')], activePatientId: 'a' }, state = {}) {
    const document = { activeElement: null, createElement: tag => new Element(tag, document) }, root = document.createElement('div'), calls = [];
    const callbacks = Object.fromEntries(['onSelectPatient', 'onOpenStudy', 'onOpenSeries', 'onOpenInstance', 'onListInstances', 'onDragStart', 'onDragEnd', 'onCompareStudies', 'onRemovePatient', 'onAssociatePatients', 'onOpen'].map(name => [name, (...args) => calls.push([name, ...args])]));
    const panel = new SessionLibraryPanel(root, callbacks); panel.setView(view, state);
    return { root, panel, calls, document,
        update(nextView = view, nextState = state) { view = nextView; state = nextState; panel.setView(view, state); },
        click(action, target = actions(root, action)[0]) { assert.ok(target, `Expected ${action} target`); const event = new Event('click'); Object.defineProperty(event, 'target', { value: target }); find(root, 'session-library').dispatchEvent(event); },
        dispose() { panel.dispose(); }
    };
}

test('empty navigator leaves instructions to the viewport and contains no duplicate source/import controls or summary', () => {
    const f = fixture({ patients: [] }); try {
        assert.doesNotMatch(f.root.textContent, /Choose Open…/); assert.equal(find(f.root, 'session-library-summary'), undefined); assert.equal(walk(f.root).some(node => node.type === 'file'), false);
        assert.equal(actions(f.root, 'import-files').length, 0); assert.deepEqual(f.calls, []); assert.equal(f.panel.getState().patientCount, 0);
    } finally { f.dispose(); }
});

test('series cards activate by Enter and Space without duplicating native inner-button actions', () => {
    const f = fixture(); try {
        const card = find(f.root, 'session-library-series-select'), panel = find(f.root, 'session-library');
        for (const key of ['Enter', ' ']) {
            const event = new Event('keydown', { cancelable: true }); Object.defineProperties(event, { target: { value: card }, key: { value: key } }); panel.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
        }
        assert.equal(f.calls.length, 2); assert.ok(f.calls.every(call => call[0] === 'onOpenSeries' && call[2].frameIndex === 0));
        const nativeButton = actions(f.root, 'toggle-instances')[0], key = new Event('keydown', { cancelable: true }); Object.defineProperties(key, { target: { value: nativeButton }, key: { value: 'Enter' } }); panel.dispatchEvent(key);
        assert.equal(f.calls.length, 2); assert.equal(key.defaultPrevented, false);
        const repeated = new Event('keydown'); Object.defineProperties(repeated, { target: { value: card }, key: { value: 'Enter' }, repeat: { value: true } }); panel.dispatchEvent(repeated); assert.equal(f.calls.length, 2);
    } finally { f.dispose(); }
});

test('individual instances are collapsed and paginated, and select exactly one source instance', () => {
    const instances = Array.from({ length: 1001 }, (_, index) => ({ id: `i-${index}`, instanceNumber: index + 101, frameCount: index ? 1 : 120 }));
    const f = fixture({ patients: [patient('a', { studies: [study('s', { series: [series('x', { instanceCount: instances.length, instances, instancesLoaded: true })] })] })], activePatientId: 'a' }); try {
        assert.equal(actions(f.root, 'open-instance').length, 0); assert.equal(actions(f.root, 'toggle-instances')[0].attributes['aria-expanded'], 'false');
        f.click('toggle-instances'); assert.equal(actions(f.root, 'open-instance').length, 25); assert.match(actions(f.root, 'open-instance')[0].textContent, /Image 101.*120 frames/);
        assert.deepEqual(f.calls, []); f.click('open-instance', actions(f.root, 'open-instance')[4]);
        assert.deepEqual(f.calls, [['onOpenInstance', 'i-4', { patientId: 'a', studyId: 's', role: 'current', frameIndex: 0, seriesId: 'x' }]]);
        f.click('instances-next'); assert.equal(actions(f.root, 'open-instance')[0].dataset.instanceId, 'i-25'); assert.equal(actions(f.root, 'open-instance').length, 25);
        f.update(); assert.equal(actions(f.root, 'open-instance')[0].dataset.instanceId, 'i-25');
        f.click('toggle-instances'); assert.equal(actions(f.root, 'open-instance').length, 0); assert.equal(f.calls.length, 1);
    } finally { f.dispose(); }
});

test('remote instance metadata is requested only by explicit expansion and is never fetched during rendering', () => {
    const p = patient('a', { studies: [study('s', { series: [series('x', { instancesLoaded: false, instances: [] })] })] });
    const f = fixture({ patients: [p], activePatientId: 'a' }); try {
        assert.deepEqual(f.calls, []); f.update(); assert.deepEqual(f.calls, []);
        f.click('toggle-instances'); assert.deepEqual(f.calls, [['onListInstances', 'x']]); assert.match(f.root.textContent, /Retrieving instance list/);
        p.studies[0].series[0].instances = [{ id: 'i-remote', instanceNumber: 8, frameCount: 2 }]; p.studies[0].series[0].instancesLoaded = true; f.update();
        assert.equal(actions(f.root, 'open-instance').length, 1); assert.equal(f.calls.length, 1);
        f.click('toggle-instances'); f.click('toggle-instances'); assert.equal(f.calls.length, 1);
    } finally { f.dispose(); }
});

test('series and instance drag callbacks carry only opaque selection references and preserve inner control boundaries', () => {
    const f = fixture({ patients: [patient('a', { studies: [study('s', { series: [series('opaque-series', { instancesLoaded: true, instances: [{ id: 'opaque-instance', instanceNumber: 7, frameCount: 1 }] })] })] })], activePatientId: 'a' }); try {
        const panel = find(f.root, 'session-library'), card = actions(f.root, 'open-series')[0]; assert.equal(card.draggable, true);
        const drag = target => { const event = new Event('dragstart', { cancelable: true }); Object.defineProperty(event, 'target', { value: target }); panel.dispatchEvent(event); return event; };
        const seriesEvent = drag(find(card, 'session-library-series-title')); assert.equal(seriesEvent.defaultPrevented, false);
        assert.deepEqual(f.calls.at(-1), ['onDragStart', seriesEvent, { seriesId: 'opaque-series', frameIndex: 0 }]);
        f.click('toggle-instances'); const item = actions(f.root, 'open-instance')[0]; assert.equal(item.draggable, true); const instanceEvent = drag(item);
        assert.deepEqual(f.calls.at(-1), ['onDragStart', instanceEvent, { seriesId: 'opaque-series', instanceId: 'opaque-instance', frameIndex: 0 }]);
        const count = f.calls.length; assert.equal(drag(actions(f.root, 'toggle-instances')[0]).defaultPrevented, true); assert.equal(f.calls.length, count);
        panel.dispatchEvent(new Event('dragend')); assert.equal(f.calls.at(-1)[0], 'onDragEnd');
        assert.equal(f.calls.some(call => call[0] === 'onOpenSeries'), false);
    } finally { f.dispose(); }
});

test('pane badges follow actual assignments and disappear when a layout clears a pane', () => {
    const f = fixture(undefined, { paneAssignments: [{ seriesId: 'a-current-axial', paneIndex: 0 }, { seriesId: 'a-current-axial', paneIndex: 1 }] }); try {
        assert.deepEqual(walk(f.root).filter(node => node.className === 'session-library-pane-badge').map(node => node.textContent), ['Pane A', 'Pane B']);
        f.update(undefined, { paneAssignments: [{ seriesId: 'a-current-axial', paneIndex: 0 }] });
        assert.deepEqual(walk(f.root).filter(node => node.className === 'session-library-pane-badge').map(node => node.textContent), ['Pane A']);
        f.update(undefined, { paneAssignments: [] }); assert.equal(find(f.root, 'session-library-pane-badge'), undefined);
    } finally { f.dispose(); }
});

test('instance badges identify only the exact displayed instance and clear when pane assignments change', () => {
    const view = { patients: [patient('a', { studies: [study('s', { series: [series('x', { instancesLoaded: true, instances: [{ id: 'one', instanceNumber: 1 }, { id: 'two', instanceNumber: 2 }] })] })] })], activePatientId: 'a' };
    const f = fixture(view, { paneAssignments: [{ seriesId: 'x', instanceId: 'two', paneIndex: 1 }, { seriesId: 'other', instanceId: 'one', paneIndex: 0 }] }); try {
        f.click('toggle-instances'); const [first, second] = actions(f.root, 'open-instance');
        assert.equal(first.attributes['aria-pressed'], 'false'); assert.equal(find(first, 'session-library-instance-pane-badge'), undefined);
        assert.equal(second.attributes['aria-pressed'], 'true'); assert.equal(find(second, 'session-library-instance-pane-badge').textContent, 'Pane B'); assert.match(second.attributes['aria-label'], /Displayed in Pane B/);
        assert.equal(second.tagName, 'button'); assert.equal(walk(second).some(node => node.tagName === 'button'), false);
        f.update(view, { paneAssignments: [{ seriesId: 'x', paneIndex: 0 }] });
        assert.ok(actions(f.root, 'open-instance').every(node => node.attributes['aria-pressed'] === 'false')); assert.equal(find(f.root, 'session-library-instance-pane-badge'), undefined);
        f.update(view, { paneAssignments: [] }); assert.equal(find(f.root, 'session-library-instance-pane-badge'), undefined);
        f.update(view, { paneAssignments: [{ seriesId: 'x', instanceId: 'one', paneIndex: 0 }, { seriesId: 'x', instanceId: 'one', paneIndex: 1 }] });
        assert.deepEqual(walk(actions(f.root, 'open-instance')[0]).filter(node => node.className === 'session-library-instance-pane-badge').map(node => node.textContent), ['Pane A', 'Pane B']);
    } finally { f.dispose(); }
});

test('clicking nested notices or an instance disclosure never opens the containing series', () => {
    const f = fixture({ patients: [patient('a', { studies: [study('s', { series: [series('x', { warnings: ['Synthetic notice'] })] })] })], activePatientId: 'a' }); try {
        const notices = find(f.root, 'session-library-notices'); f.click('ignored', notices.children[0]); f.click('ignored', notices.children[1]);
        f.click('toggle-instances'); assert.deepEqual(f.calls, []);
    } finally { f.dispose(); }
});

test('active patient identity and source remain explicit while patient switching uses separate workspaces', () => {
    const f = fixture({ patients: [patient('a'), patient('b')], activePatientId: 'a' }); try {
        assert.match(find(f.root, 'session-library-patient').textContent, /SYNTHETIC a/); assert.match(find(f.root, 'session-library-patient').textContent, /MRN-a/);
        assert.match(find(f.root, 'session-library-patient').textContent, /02 Jan 1980/); assert.match(find(f.root, 'session-library-patient').textContent, /On this device/);
        f.click('change-patient'); assert.equal(f.panel.getState().findingPatient, true); assert.equal(f.document.activeElement, find(f.root, 'session-library-search'));
        f.click('select-patient', actions(f.root, 'select-patient')[1]); assert.deepEqual(f.calls, [['onSelectPatient', 'b']]);
        f.update(undefined, { activePatientId: 'b' }); assert.equal(find(f.root, 'session-library-finder').hidden, true); assert.match(find(f.root, 'session-library-patient').textContent, /MRN-b/);
        f.click('remove-patient'); assert.deepEqual(f.calls.at(-1), ['onRemovePatient', 'b']);
    } finally { f.dispose(); }
});

test('patient filtering is literal and does not create markup, network elements or hidden source searches', () => {
    const attack = '<img src="https://unrequested.invalid/">', f = fixture({ patients: [patient('a', { patientName: attack }), patient('b')], activePatientId: null }); try {
        assert.ok(f.root.textContent.includes(attack)); assert.equal(walk(f.root).some(node => ['img', 'a', 'script'].includes(node.tagName)), false);
        const search = find(f.root, 'session-library-search'); search.value = '<img'; search.dispatchEvent(new Event('input'));
        assert.equal(f.panel.getState().matchedPatientCount, 1); search.value = 'MRN-b 19800102'; search.dispatchEvent(new Event('input'));
        assert.equal(f.panel.getState().matchedPatientCount, 1); assert.match(find(f.root, 'session-library-patients').textContent, /MRN-b/); assert.deepEqual(f.calls, []);
    } finally { f.dispose(); }
});

test('chronological study groups preserve current/comparison roles and compare only within the active patient', () => {
    const p = patient('a', { studies: [study('old', { studyDate: '20240101' }), study('undated', { studyDate: '' }), study('new')] }), f = fixture({ patients: [p, patient('b')], activePatientId: 'a' }, { currentStudyId: 'old', comparisonStudyId: 'new' }); try {
        assert.deepEqual(actions(f.root, 'open-study').map(node => node.dataset.studyId), ['new', 'old', 'undated']);
        assert.match(find(f.root, 'session-library-timeline').textContent, /Current/); assert.match(find(f.root, 'session-library-timeline').textContent, /Comparison/);
        assert.equal(byStudy(f.root, 'compare-study', 'old').disabled, true); assert.equal(byStudy(f.root, 'compare-study', 'new').disabled, true);
        f.click('compare-study', byStudy(f.root, 'compare-study', 'undated')); assert.deepEqual(f.calls.at(-1), ['onCompareStudies', 'old', 'undated', { comparisonSeriesId: 'undated-axial' }]);
        f.update(undefined, { activePatientId: 'a', currentStudyId: 'b-current' }); assert.ok(actions(f.root, 'compare-study').every(node => node.disabled));
    } finally { f.dispose(); }
});

test('series opening uses exact opaque selection and compact descriptive image-stack choices', () => {
    const groups = [{ id: 'g1', label: 'Echo 1', frameCount: 30 }, { id: 'g2', label: 'Echo 2', frameCount: 30 }];
    const p = patient('a', { studies: [study('a-current', { series: [series('first'), series('second', { stackGroups: groups })] })] }), f = fixture({ patients: [p], activePatientId: 'a' }, { currentStudyId: 'a-current', selectedSeriesId: 'second', paneAssignments: new Map([['second', ['Pane A', 'Pane B']]]) }); try {
        assert.equal(actions(f.root, 'open-series').length, 2); const button = actions(f.root, 'open-series').find(node => node.dataset.seriesId === 'second');
        assert.equal(find(button, 'session-library-series-select').attributes['aria-pressed'], 'true'); assert.match(find(f.root, 'session-library-timeline').textContent, /Pane APane B/);
        assert.equal(button.tagName, 'article'); assert.equal(button.attributes.role, undefined); assert.equal(find(button, 'session-library-series-select').attributes.role, 'button'); assert.equal(find(button, 'session-library-series-select').tabIndex, 0); assert.equal(find(f.root, 'session-library-series-open'), undefined);
        assert.match(find(f.root, 'session-library-stack-groups').textContent, /^Image stacks/);
        assert.doesNotMatch(f.root.textContent, /Display groups/);
        assert.equal(actions(f.root, 'open-group')[1].textContent, 'Echo 2 · 30');
        assert.equal(actions(f.root, 'open-group')[1].title, 'Echo 2 · 30 images');
        assert.equal(actions(f.root, 'open-group')[1].attributes['aria-label'], 'Open Echo 2 image stack, 30 images');
        f.click('open-series', button); assert.deepEqual(f.calls.at(-1), ['onOpenSeries', 'second', { patientId: 'a', studyId: 'a-current', role: 'current', frameIndex: 0 }]);
        f.click('open-group', actions(f.root, 'open-group')[1]); assert.deepEqual(f.calls.at(-1), ['onOpenSeries', 'second', { patientId: 'a', studyId: 'a-current', role: 'current', frameIndex: 0, stackIndex: 1 }]);
        f.click('open-study'); assert.deepEqual(f.calls.at(-1), ['onOpenStudy', 'a-current', { patientId: 'a', seriesId: 'second' }]);
    } finally { f.dispose(); }
});

const stackGroups = length => Array.from({ length }, (_, index) => ({ id: `group-${index}`, label: `Stack ${index + 1}`, frameCount: 1 }));
const stackedView = (entries = [series('many', { stackGroups: stackGroups(419) })]) => ({ patients: [patient('a', {
    studies: [study('a-current', { series: entries })] })], activePatientId: 'a' });
const seriesAction = (f, action, id = 'many') => actions(f.root, action).find(node => node.dataset.seriesId === id);

test('hundreds of image stacks are paged without truncation and preserve global indices 128 and 418', () => {
    const f = fixture(stackedView());
    try {
        assert.equal(actions(f.root, 'open-group').length, 24);
        assert.equal(find(f.root, 'session-library-stack-range').textContent, '1–24 of 419');
        assert.equal(seriesAction(f, 'stacks-previous').disabled, true);
        assert.equal(seriesAction(f, 'stacks-next').type, 'button');
        assert.match(find(f.root, 'session-library-stack-pagination').attributes['aria-label'], /Image stack pages/);
        for (let page = 0; page < 5; page++) f.click('stacks-next');
        assert.equal(find(f.root, 'session-library-stack-range').textContent, '121–144 of 419');
        assert.equal(actions(f.root, 'open-group')[0].dataset.stackIndex, '120');
        f.click('open-group', actions(f.root, 'open-group').find(button => button.dataset.stackIndex === '128'));
        assert.deepEqual(f.calls, [['onOpenSeries', 'many', { patientId: 'a', studyId: 'a-current', role: 'current', frameIndex: 0, stackIndex: 128 }]]);
        for (let page = 5; page < 17; page++) f.click('stacks-next');
        assert.equal(find(f.root, 'session-library-stack-range').textContent, '409–419 of 419');
        assert.equal(actions(f.root, 'open-group').length, 11);
        assert.equal(actions(f.root, 'open-group').at(-1).textContent, 'Stack 419 · 1');
        assert.equal(seriesAction(f, 'stacks-next').disabled, true);
        assert.equal(f.document.activeElement, seriesAction(f, 'stacks-previous'));
        f.click('open-group', actions(f.root, 'open-group').at(-1));
        assert.deepEqual(f.calls.at(-1), ['onOpenSeries', 'many', { patientId: 'a', studyId: 'a-current', role: 'current', frameIndex: 0, stackIndex: 418 }]);
        assert.equal(f.calls.length, 2, 'Paging never opens a containing series.');
        f.click('stacks-next');
        assert.equal(find(f.root, 'session-library-stack-range').textContent, '409–419 of 419');
        for (let page = 17; page > 0; page--) f.click('stacks-previous');
        assert.equal(f.document.activeElement, seriesAction(f, 'stacks-next'));
        assert.equal(find(f.root, 'session-library-stack-range').textContent, '1–24 of 419');
    } finally { f.dispose(); }
});

test('image stack pages survive snapshots independently for each series and individual instance pages', () => {
    const instances = Array.from({ length: 65 }, (_, index) => ({ id: `instance-${index}`, instanceNumber: index + 1 }));
    const view = stackedView([series('x', { stackGroups: stackGroups(75), instances, instancesLoaded: true }),
        series('y', { stackGroups: stackGroups(75) })]);
    const f = fixture(view);
    try {
        f.click('stacks-next', seriesAction(f, 'stacks-next', 'x'));
        f.click('stacks-next', seriesAction(f, 'stacks-next', 'y'));
        f.click('stacks-next', seriesAction(f, 'stacks-next', 'y'));
        f.click('toggle-instances', seriesAction(f, 'toggle-instances', 'x'));
        f.click('instances-next', seriesAction(f, 'instances-next', 'x'));
        f.update(structuredClone(view));
        assert.equal(seriesAction(f, 'open-group', 'x').dataset.stackIndex, '24');
        assert.equal(seriesAction(f, 'open-group', 'y').dataset.stackIndex, '48');
        assert.equal(seriesAction(f, 'open-instance', 'x').dataset.instanceId, 'instance-25');
        f.click('stacks-next', seriesAction(f, 'stacks-next', 'x'));
        assert.equal(seriesAction(f, 'open-group', 'x').dataset.stackIndex, '48');
        assert.equal(seriesAction(f, 'open-instance', 'x').dataset.instanceId, 'instance-25');
        assert.deepEqual(f.calls, []);
    } finally { f.dispose(); }
});

test('metadata changes clamp image stack pages even while the study is collapsed and removed series forget their pages', () => {
    const f = fixture(stackedView());
    try {
        for (let page = 0; page < 17; page++) f.click('stacks-next');
        f.update(stackedView([series('many', { stackGroups: stackGroups(35) })]));
        assert.equal(find(f.root, 'session-library-stack-range').textContent, '25–35 of 35');
        f.click('toggle-study');
        f.update(stackedView([series('many', { stackGroups: stackGroups(2) })]));
        assert.equal(actions(f.root, 'open-group').length, 0);
        f.click('toggle-study');
        assert.deepEqual(actions(f.root, 'open-group').map(button => button.dataset.stackIndex), ['0', '1']);
        assert.equal(find(f.root, 'session-library-stack-range'), undefined);
        assert.equal(find(f.root, 'session-library-stack-pagination'), undefined);
        f.update(stackedView()); f.click('stacks-next');
        f.update(stackedView([])); f.update(stackedView());
        assert.equal(seriesAction(f, 'open-group').dataset.stackIndex, '0');
        assert.equal(find(f.root, 'session-library-stack-range').textContent, '1–24 of 419');
        assert.deepEqual(f.calls, []);
    } finally { f.dispose(); }
});

test('busy state disables image stack selection and pagination and rejects stale paging events', () => {
    const view = stackedView(), f = fixture(view);
    try {
        const oldNext = seriesAction(f, 'stacks-next');
        f.update(view, { busy: true });
        assert.ok(actions(f.root, 'open-group').every(button => button.disabled));
        assert.equal(seriesAction(f, 'stacks-next').disabled, true);
        assert.equal(seriesAction(f, 'stacks-previous').disabled, true);
        f.click('stacks-next', oldNext); f.click('stacks-next'); f.click('open-group');
        assert.equal(find(f.root, 'session-library-stack-range').textContent, '1–24 of 419');
        assert.deepEqual(f.calls, []);
        f.update(view, {}); f.click('stacks-next');
        assert.equal(find(f.root, 'session-library-stack-range').textContent, '25–48 of 419');
    } finally { f.dispose(); }
});

test('stack paging controls use native keyboard activation and never start series drag or opening', () => {
    const f = fixture(stackedView());
    try {
        const panel = find(f.root, 'session-library'), next = seriesAction(f, 'stacks-next');
        const key = new Event('keydown', { cancelable: true }); Object.defineProperties(key, { target: { value: next }, key: { value: 'Enter' } }); panel.dispatchEvent(key);
        assert.equal(key.defaultPrevented, false); assert.equal(find(f.root, 'session-library-stack-range').textContent, '1–24 of 419');
        f.click('stacks-next', next);
        assert.equal(find(f.root, 'session-library-stack-range').textContent, '25–48 of 419');
        for (const target of [seriesAction(f, 'stacks-next'), find(f.root, 'session-library-stack-range'), seriesAction(f, 'open-group')]) {
            const drag = new Event('dragstart', { cancelable: true }); Object.defineProperty(drag, 'target', { value: target }); panel.dispatchEvent(drag);
            assert.equal(drag.defaultPrevented, true);
        }
        f.click('ignored', find(f.root, 'session-library-stack-range'));
        assert.deepEqual(f.calls, []);
    } finally { f.dispose(); }
});

test('stale or invalid stack indices cannot open another stack after metadata changes', () => {
    const f = fixture(stackedView());
    try {
        for (let page = 0; page < 17; page++) f.click('stacks-next');
        const stale = actions(f.root, 'open-group').at(-1);
        f.update(stackedView([series('many', { stackGroups: stackGroups(2) })]));
        f.click('open-group', stale);
        const current = seriesAction(f, 'open-group');
        for (const stackIndex of ['-1', 'NaN', '1.5', '999']) { current.dataset.stackIndex = stackIndex; f.click('open-group', current); }
        assert.deepEqual(f.calls, []);
    } finally { f.dispose(); }
});

test('collapsing a study persists through snapshots and focus returns to its plus/minus button', () => {
    const f = fixture(); try {
        const toggle = byStudy(f.root, 'toggle-study', 'a-current'); assert.equal(toggle.attributes['aria-expanded'], 'true'); f.click('toggle-study', toggle);
        assert.equal(byStudy(f.root, 'toggle-study', 'a-current').attributes['aria-expanded'], 'false'); assert.equal(f.document.activeElement, byStudy(f.root, 'toggle-study', 'a-current'));
        f.update(); assert.equal(byStudy(f.root, 'toggle-study', 'a-current').attributes['aria-expanded'], 'false');
    } finally { f.dispose(); }
});

test('lazy remote studies remain openable before series enumeration while known unsupported series stay disabled', () => {
    const p = patient('a', { sourceLabel: 'Research PACS', studies: [study('remote', { sourceLabel: 'Research PACS', series: [], seriesLoaded: false }), study('unsupported', { series: [series('bad', { status: 'unsupported' })] })] }), f = fixture({ patients: [p], activePatientId: 'a' }); try {
        assert.equal(byStudy(f.root, 'open-study', 'remote').disabled, false); f.click('open-study', byStudy(f.root, 'open-study', 'remote')); assert.deepEqual(f.calls.at(-1), ['onOpenStudy', 'remote', { patientId: 'a', seriesId: undefined }]);
        assert.equal(byStudy(f.root, 'open-study', 'unsupported').disabled, true); assert.match(find(f.root, 'session-library-timeline').textContent, /retrieve the series list/);
        assert.match(find(f.root, 'session-library-timeline').textContent, /Series not listed yet/); assert.doesNotMatch(find(f.root, 'session-library-timeline').textContent, /0 series/);
    } finally { f.dispose(); }
});

test('busy operations guard changing or closing patients, opening series and comparing', () => {
    const f = fixture({ patients: [patient('a'), patient('b')], activePatientId: 'a' }, { busy: true, currentStudyId: 'a-current', operationLabel: 'Preparing selected series…' }); try {
        for (const action of ['open-study', 'open-series', 'compare-study', 'change-patient', 'remove-patient']) assert.ok(actions(f.root, action).every(node => node.disabled));
        f.click('open-study'); f.click('remove-patient'); assert.deepEqual(f.calls, []); assert.match(find(f.root, 'session-library-message').textContent, /Preparing selected series/);
    } finally { f.dispose(); }
});

test('large patient, study and series populations bound navigator DOM and retain accessible pagination', () => {
    const f = fixture({ patients: Array.from({ length: 1001 }, (_, index) => patient(String(index))), activePatientId: null }); try {
        assert.equal(actions(f.root, 'select-patient').length, 20); f.click('patients-next'); assert.equal(actions(f.root, 'select-patient')[0].dataset.patientId, '20');
        f.update({ patients: [patient('a', { studies: Array.from({ length: 25 }, (_, index) => study(String(index))) })], activePatientId: 'a' });
        assert.equal(actions(f.root, 'open-study').length, 12); f.click('studies-next'); assert.equal(f.panel.getState().studyPage, 1);
        f.update({ patients: [patient('a', { studies: [study('huge', { series: Array.from({ length: 1001 }, (_, index) => series(`s-${index}`)) })] })], activePatientId: 'a' });
        assert.equal(actions(f.root, 'open-series').length, 24); f.click('series-next'); assert.equal(actions(f.root, 'open-series')[0].dataset.seriesId, 's-24');
    } finally { f.dispose(); }
});

test('synthetic test workspaces remain visibly identified and disposal removes callbacks and DOM', () => {
    const f = fixture({ patients: [patient('test', { patientName: 'Synthetic test workspace', kind: 'test', synthetic: true })], activePatientId: 'test' });
    assert.match(find(f.root, 'session-library-test-label').textContent, /Synthetic test workspace/);
    const panelNode = find(f.root, 'session-library'), button = actions(f.root, 'open-study')[0]; f.dispose();
    assert.equal(f.root.children.length, 0); const event = new Event('click'); Object.defineProperty(event, 'target', { value: button }); panelNode.dispatchEvent(event); assert.deepEqual(f.calls, []);
    f.panel.setView({ patients: [] }); assert.equal(f.root.children.length, 0);
});

test('canvas thumbnails retain their pixels and dimensions when cloned for an accessible series card', () => {
    const copies = [], supplied = [];
    const document = { createElement: tag => new Element(tag, document) }, root = document.createElement('div');
    const panel = new SessionLibraryPanel(root, { getThumbnail() {
        const canvas = document.createElement('canvas'); canvas.width = 4; canvas.height = 3;
        // A canvas DOM clone copies attributes but does not copy its raster.
        canvas.cloneNode = () => { const clone = document.createElement('canvas'); clone.getContext = () => ({ drawImage(source, x, y) { copies.push({ clone, source, x, y }); } }); return clone; };
        supplied.push(canvas); return canvas;
    } });
    try {
        panel.setView({ patients: [patient('a')], activePatientId: 'a' });
        assert.equal(copies.length, 1); assert.equal(copies[0].source, supplied.at(-1));
        assert.equal(copies[0].clone.width, 4); assert.equal(copies[0].clone.height, 3); assert.equal(copies[0].x, 0); assert.equal(copies[0].y, 0);
        assert.equal(find(root, 'session-library-thumbnail').attributes['aria-hidden'], 'true');
        assert.match(find(root, 'session-library-series-select').attributes['aria-label'], /Open Axial a-current-axial/);
    } finally { panel.dispose(); }
});

test('local patient association requires full identity review and explicit unchecked consent', () => {
    const local = (id, changes = {}) => patient(id, { kind: 'local', sourceId: 'local', sourceLabel: 'On this device', issuerOfPatientId: '', ...changes });
    const view = { patients: [local('a'), local('b', { patientBirthDate: '19991231' })], activePatientId: 'a' }, f = fixture(view);
    try {
        f.click('change-patient'); assert.equal(actions(f.root, 'review-association').length, 1); f.click('review-association');
        const review = find(f.root, 'session-library-association'); assert.equal(review.hidden, false);
        assert.match(review.textContent, /SYNTHETIC a/); assert.match(review.textContent, /SYNTHETIC b/);
        assert.match(review.textContent, /ID: MRN-a/); assert.match(review.textContent, /ID: MRN-b/);
        assert.match(review.textContent, /Source: On this device/); assert.match(review.textContent, /Issuer: not supplied/);
        assert.match(review.textContent, /31 Dec 1999/); assert.match(review.textContent, /Original DICOM attributes stay unchanged/);
        const confirm = actions(f.root, 'confirm-association')[0], checkbox = walk(review).find(node => node.type === 'checkbox');
        assert.equal(checkbox.checked, false); assert.equal(confirm.disabled, true); f.click('confirm-association'); assert.deepEqual(f.calls, []);
        checkbox.checked = true; const event = new Event('change'); Object.defineProperty(event, 'target', { value: checkbox }); find(f.root, 'session-library').dispatchEvent(event);
        assert.equal(confirm.disabled, false); f.click('confirm-association'); assert.deepEqual(f.calls, [['onAssociatePatients', 'b', 'a', { confirmed: true }]]); assert.equal(review.hidden, true);
    } finally { f.dispose(); }
});

test('association review excludes remote, synthetic, foreign-source and active patient records and resets on cancel or switch', () => {
    const local = id => patient(id, { kind: 'local', sourceId: 'local' });
    const view = { patients: [local('a'), local('b'), patient('remote', { kind: 'remote', sourceId: 'local' }), patient('test', { kind: 'test', synthetic: true, sourceId: 'local' }), patient('foreign', { kind: 'local', sourceId: 'another-device' })], activePatientId: 'a' }, f = fixture(view);
    try {
        f.click('change-patient'); assert.equal(actions(f.root, 'review-association').length, 1);
        f.click('review-association'); const checkbox = walk(find(f.root, 'session-library-association')).find(node => node.type === 'checkbox');
        checkbox.checked = true; const change = new Event('change'); Object.defineProperty(change, 'target', { value: checkbox }); find(f.root, 'session-library').dispatchEvent(change);
        f.click('cancel-association'); f.click('review-association'); assert.equal(actions(f.root, 'confirm-association')[0].disabled, true);
        f.update(undefined, { activePatientId: 'b' }); assert.equal(find(f.root, 'session-library-association').hidden, true); assert.deepEqual(f.calls, []);
        f.update(undefined, { activePatientId: 'remote' }); f.click('change-patient'); assert.equal(actions(f.root, 'review-association').length, 0);
    } finally { f.dispose(); }
});

test('busy association review cannot confirm or change its consent', () => {
    const view = { patients: [patient('a', { kind: 'local', sourceId: 'local' }), patient('b', { kind: 'local', sourceId: 'local' })], activePatientId: 'a' }, f = fixture(view);
    try {
        f.click('change-patient'); f.click('review-association'); f.update(undefined, { activePatientId: 'a', busy: true });
        assert.equal(actions(f.root, 'confirm-association')[0].disabled, true); assert.equal(walk(find(f.root, 'session-library-association')).find(node => node.type === 'checkbox').disabled, true);
        f.click('confirm-association'); assert.deepEqual(f.calls, []);
    } finally { f.dispose(); }
});

const matchingLocal = (id, changes = {}) => patient(id, { kind: 'local', sourceId: 'local', sourceLabel: 'On this device',
    patientId: '0012345', patientName: 'SYNTHETIC^JANE', patientBirthDate: '19800229', issuerOfPatientId: '', ...changes });
const setConsent = (f, checked) => {
    const checkbox = walk(find(f.root, 'session-library-association')).find(node => node.type === 'checkbox');
    checkbox.checked = checked; const event = new Event('change'); Object.defineProperty(event, 'target', { value: checkbox }); find(f.root, 'session-library').dispatchEvent(event); return checkbox;
};

test('an exact local identity match has a prominent timeline suggestion and finder badge without automatic combination', () => {
    const f = fixture({ patients: [matchingLocal('a'), matchingLocal('b')], activePatientId: 'a' });
    try {
        const banner = find(f.root, 'session-library-match-banner'); assert.ok(banner); assert.equal(find(f.root, 'session-library-patient').hidden, false);
        assert.match(banner.textContent, /Possible same patient/); assert.match(banner.textContent, /MRN, name and birth date match\. Review to combine studies\./);
        assert.equal(find(banner, 'session-library-match-review').textContent, 'Review and combine…'); assert.deepEqual(f.calls, []);
        f.click('change-patient'); assert.equal(find(f.root, 'session-library-finder').hidden, false);
        assert.equal(find(f.root, 'session-library-match-badge').textContent, 'Possible same patient');
        assert.ok(actions(f.root, 'review-association').some(button => button.className.includes('is-possible-match'))); assert.deepEqual(f.calls, []);
    } finally { f.dispose(); }
});

test('timeline review exposes the complete review and unchecked consent, retains focus, and cancel restores the timeline', () => {
    const view = { patients: [matchingLocal('a'), matchingLocal('b')], activePatientId: 'a' }, f = fixture(view);
    try {
        f.click('review-association', find(f.root, 'session-library-match-review'));
        const finder = find(f.root, 'session-library-finder'), review = find(f.root, 'session-library-association');
        assert.equal(finder.hidden, false); assert.equal(review.hidden, false); assert.equal(find(f.root, 'session-library-patient').hidden, true);
        let checkbox = walk(review).find(node => node.type === 'checkbox'); assert.equal(f.document.activeElement, checkbox);
        assert.equal(checkbox.checked, false); assert.equal(actions(f.root, 'confirm-association')[0].textContent, 'Combine studies');
        assert.equal(actions(f.root, 'confirm-association')[0].disabled, true); assert.match(review.textContent, /Source identities are retained/);
        f.update(view); checkbox = walk(review).find(node => node.type === 'checkbox'); assert.equal(f.document.activeElement, checkbox);
        setConsent(f, true); f.click('cancel-association'); assert.equal(finder.hidden, true); assert.equal(find(f.root, 'session-library-patient').hidden, false);
        assert.equal(f.document.activeElement, find(f.root, 'session-library-match-review')); assert.deepEqual(f.calls, []);
        f.click('review-association', find(f.root, 'session-library-match-review')); assert.equal(walk(review).find(node => node.type === 'checkbox').checked, false);
    } finally { f.dispose(); }
});

test('confirmed combination returns to the surviving active timeline when the source record disappears and retains unrelated patients', () => {
    const a = matchingLocal('a'), b = matchingLocal('b'), sibling = matchingLocal('c', { patientId: 'OTHER' });
    const f = fixture({ patients: [a, b, sibling], activePatientId: 'a' });
    try {
        f.click('review-association', find(f.root, 'session-library-match-review')); setConsent(f, true); f.click('confirm-association');
        assert.deepEqual(f.calls, [['onAssociatePatients', 'b', 'a', { confirmed: true }]]);
        f.update({ patients: [{ ...a, studies: [...a.studies, ...b.studies] }, sibling], activePatientId: 'a' });
        assert.equal(f.panel.getState().findingPatient, false); assert.equal(f.panel.getState().patientCount, 2);
        assert.equal(find(f.root, 'session-library-finder').hidden, true); assert.equal(find(f.root, 'session-library-patient').hidden, false);
        assert.equal(find(f.root, 'session-library-association').hidden, true); assert.equal(find(f.root, 'session-library-match-banner'), undefined);
        assert.equal(actions(f.root, 'toggle-study').length, 4); assert.deepEqual(f.calls, [['onAssociatePatients', 'b', 'a', { confirmed: true }]]);
    } finally { f.dispose(); }
});

test('identity changes reset reviewed consent, and busy views cannot open review or synthesize confirmation', () => {
    const a = matchingLocal('a'), b = matchingLocal('b'), view = { patients: [a, b], activePatientId: 'a' }, f = fixture(view);
    try {
        f.update(view, { busy: true }); const reviewButton = find(f.root, 'session-library-match-review'); assert.equal(reviewButton.disabled, true); f.click('review-association', reviewButton);
        assert.equal(find(f.root, 'session-library-association').hidden, true); assert.deepEqual(f.calls, []);
        f.update(view, {}); f.click('review-association', find(f.root, 'session-library-match-review')); setConsent(f, true);
        f.update({ patients: [a, { ...b, issuerOfPatientId: 'NEW ISSUER' }], activePatientId: 'a' });
        assert.equal(walk(find(f.root, 'session-library-association')).find(node => node.type === 'checkbox').checked, false);
        assert.equal(actions(f.root, 'confirm-association')[0].disabled, true);
        f.update(undefined, { busy: true }); setConsent(f, true); f.click('confirm-association');
        assert.equal(actions(f.root, 'confirm-association')[0].disabled, true); assert.deepEqual(f.calls, []);
    } finally { f.dispose(); }
});

test('incomplete or conflicting identities never receive match hints while deliberate local review remains available', () => {
    const a = matchingLocal('a', { issuerOfPatientId: 'HOSPITAL-A' });
    for (const changes of [{ patientId: '12345' }, { patientName: 'SYNTHETIC^Jane' }, { patientBirthDate: '' },
        { patientBirthDate: '19800230' }, { issuerOfPatientId: 'HOSPITAL-B' }, { kind: 'remote' }, { synthetic: true }, { sourceId: 'other-device' }]) {
        const f = fixture({ patients: [a, matchingLocal('b', changes)], activePatientId: 'a' });
        try {
            assert.equal(find(f.root, 'session-library-match-banner'), undefined); assert.equal(find(f.root, 'session-library-match-badge'), undefined); assert.deepEqual(f.calls, []);
            if (!changes.kind && !changes.synthetic && !changes.sourceId) { f.click('change-patient'); assert.equal(actions(f.root, 'review-association').length, 1); }
        } finally { f.dispose(); }
    }
});

test('the match preview stays compact and large local populations still use the paginated finder', () => {
    const f = fixture({ patients: Array.from({ length: 1001 }, (_, index) => matchingLocal(String(index))), activePatientId: '0' });
    try {
        const banner = find(f.root, 'session-library-match-banner'); assert.equal(walk(banner).filter(node => node.className === 'session-library-match-review').length, 3);
        assert.match(banner.textContent, /Review other matches…/); assert.equal(walk(f.root).filter(node => node.className === 'session-library-patient-card').length, 20); assert.deepEqual(f.calls, []);
    } finally { f.dispose(); }
});
