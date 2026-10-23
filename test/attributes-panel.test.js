import test from 'node:test';
import assert from 'node:assert/strict';
import EASI from '@xinonix/easi-js';
import { AttributesPanel } from '../src/ui/AttributesPanel.js';
import { createAttributeSnapshot } from '../src/data/attributes.js';
import { independentNativeFixture, j, sq } from './derived-fixtures.js';

class Element extends EventTarget {
    constructor(tagName, ownerDocument) {
        super(); this.tagName = tagName; this.ownerDocument = ownerDocument; this.children = []; this.parentNode = null;
        this.attributes = {}; this.dataset = {}; this.value = ''; this.hidden = false; this.disabled = false; this._text = ''; this.focused = false;
    }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.replaceChildren(); }
    set innerHTML(value) { throw new Error('Attribute values must never become HTML.'); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    append(...children) { for (const child of children) { child.remove(); child.parentNode = this; this.children.push(child); } }
    replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...children); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
    focus() { if (this.ownerDocument.activeElement) this.ownerDocument.activeElement.focused = false; this.focused = true; this.ownerDocument.activeElement = this; }
}
const document = { activeElement: null, createElement: tagName => new Element(tagName, document) };
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
const find = (root, value) => descendants(root).find(node => node.id === value || node.className?.split(' ').includes(value));
const rows = root => descendants(root).filter(node => node.className?.split(' ').includes('attributes-row'));
const row = (tag, name, value, options = {}) => ({ section: 'dataset', path: `Dataset/${tag}`, depth: 0, tag, name, vr: 'LO', kind: 'value', value, truncated: false, ...options });
function snapshot(rows, changes = {}) {
    return Object.freeze({ rows: Object.freeze(rows.map(row => Object.freeze(row))), bytes: 100, truncated: false,
        limits: Object.freeze({maxRows: 4096, maxDepth: 16, maxValueChars: 4096, maxBytes: 131072}), ...changes });
}
function fixture(initial) {
    const root = document.createElement('div'), panel = new AttributesPanel(root);
    const source = { calls: [], current: initial, getAttributes(index) { this.calls.push(index); return this.current; } };
    return {root, panel, source, search(value) { const input = find(root, 'attributes-search'); input.value = value; input.dispatchEvent(new Event('input')); },
        click(value) { find(root, value).dispatchEvent(new Event('click')); }, cleanup() { panel.dispose(); } };
}
const pathOf = element => find(element, 'attributes-path').textContent;
function activateToggle(f, path, occurrence = 0) {
    const target = find(rows(f.root).filter(element => pathOf(element) === path)[occurrence], 'attributes-toggle');
    assert.ok(target, `Expected a retained branch at ${path}`);
    // The small DOM stub does not bubble; preserve the real click target for
    // the panel's single delegated listener rather than attaching row handlers.
    const event = new Event('click'); Object.defineProperty(event, 'target', {value: target});
    find(f.root, 'attributes-table').children[2].dispatchEvent(event);
    return target;
}
function treeRows() {
    const parent = 'dataset/(0008,1115)', first = `${parent}/item[1]`, second = `${parent}/item[2]`, nested = `${first}/(0008,1140)`, child = `${nested}/item[1]`;
    return [
        row('(0008,1115)', 'Referenced Series Sequence', '2 items', {vr: 'SQ', kind: 'sequence', path: parent}),
        row('(fffe,e000)', 'Item 1', '', {vr: 'ITEM', kind: 'item', path: first, depth: 1}),
        row('(0020,000e)', 'Series Instance UID', '2.25.101', {vr: 'UI', path: `${first}/(0020,000e)`, depth: 1}),
        row('(0008,1140)', 'Referenced Image Sequence', '1 item', {vr: 'SQ', kind: 'sequence', path: nested, depth: 1}),
        row('(fffe,e000)', 'Item 1', '', {vr: 'ITEM', kind: 'item', path: child, depth: 2}),
        row('(0008,1155)', 'Referenced SOP Instance UID', 'DEEP-SYNTHETIC-NEEDLE', {vr: 'UI', path: `${child}/(0008,1155)`, depth: 2}),
        row('(fffe,e000)', 'Item 2', '', {vr: 'ITEM', kind: 'item', path: second, depth: 1}),
        row('(0020,000e)', 'Series Instance UID', '2.25.102', {vr: 'UI', path: `${second}/(0020,000e)`, depth: 1}),
        row('(0008,0060)', 'Modality', 'CT', {path: 'dataset/(0008,0060)'})
    ];
}

test('attribute search matches names, literal values, sequence paths and compact/formatted tags without interpreting data as HTML', () => {
    const value = '<script>synthetic literal</script><img src="https://unrequested.invalid/">';
    const f = fixture(snapshot([
        row('(0010,0010)', 'Patient Name', value, {vr: 'PN'}),
        row('(0008,1115)', 'Referenced Series Sequence', '1 item', {vr: 'SQ', kind: 'sequence'}),
        row('(fffe,e000)', 'Item 1', '', {kind: 'item', vr: 'ITEM', depth: 1, path: 'Dataset/(0008,1115)/Item 1'}),
        row('(0008,1155)', 'Referenced SOP Instance UID', '2.25.100', {vr: 'UI', depth: 2, path: 'Dataset/(0008,1115)/Item 1/(0008,1155)'})
    ]));
    try {
        f.panel.setSource({series: f.source, index: 0}); assert.equal(rows(f.root).length, 2); assert.equal(f.panel.getState().matchedCount, 4); assert.ok(f.root.textContent.includes(value));
        assert.equal(descendants(f.root).some(node => ['script', 'img', 'a'].includes(node.tagName)), false);
        for (const term of ['00100010', '(0010,0010)', '(0010, 0010)', '(00100010)', 'patient name', 'synthetic literal', '<script>']) {
            f.search(term); assert.equal(f.panel.getState().matchedCount, 1); assert.equal(find(f.root, 'attributes-tag').textContent, '(0010,0010)');
        }
        f.search('Item 1 00081155'); assert.equal(f.panel.getState().matchedCount, 1);
        assert.equal(rows(f.root)[0].dataset.depth, '2'); assert.ok(find(f.root, 'attributes-path').textContent.includes('Item 1'));
        assert.equal(find(f.root, 'attributes-count').attributes.role, 'status'); assert.equal(find(f.root, 'attributes-search-label').htmlFor, 'attributes-search');
        assert.equal(find(f.root, 'attributes-table').id, 'attributes-table');
    } finally { f.cleanup(); }
});

test('pagination bounds rendered rows, resets on filtering and exposes stable navigation counts', () => {
    const f = fixture(snapshot(Array.from({length: 121}, (_, index) => row(`(1001,${index.toString(16).padStart(4, '0')})`, `Generated attribute ${index}`, `marker ${index}`))));
    try {
        f.panel.setSource({series: f.source, index: 0}); assert.equal(rows(f.root).length, 50);
        assert.equal(find(f.root, 'attributes-prev').disabled, true); assert.equal(find(f.root, 'attributes-next').disabled, false);
        assert.equal(find(f.root, 'attributes-page').textContent, '1–50 of 121 · Page 1 of 3');
        f.click('attributes-next'); assert.equal(rows(f.root).length, 50); assert.equal(find(f.root, 'attributes-page').textContent, '51–100 of 121 · Page 2 of 3');
        f.click('attributes-next'); assert.equal(rows(f.root).length, 21); assert.equal(find(f.root, 'attributes-next').disabled, true);
        f.click('attributes-next'); assert.equal(f.panel.getState().page, 2);
        f.search('marker 120'); assert.equal(rows(f.root).length, 1); assert.equal(f.panel.getState().page, 0);
        f.search('no match'); assert.equal(rows(f.root).length, 0); assert.equal(find(f.root, 'attributes-empty').textContent, 'No attributes match this search.');
        f.click('attributes-clear-search'); assert.equal(rows(f.root).length, 50); assert.equal(find(f.root, 'attributes-search').focused, true);
        assert.equal(f.source.calls.length, 1, 'Search and paging use the retained snapshot only.');
    } finally { f.cleanup(); }
});

test('sequence and item branches reveal a flat hierarchy from paths, preserve child expansion, and restore keyboard focus', () => {
    const input = treeRows(), f = fixture(snapshot(input));
    const [parent, first, , nested, child] = input.map(value => value.path);
    try {
        f.panel.setSource({series: f.source, index: 0});
        assert.deepEqual(rows(f.root).map(pathOf), [parent, 'dataset/(0008,0060)']);
        assert.equal(find(f.root, 'attributes-count').textContent, '2 shown of 9 attributes');
        assert.equal(find(f.root, 'attributes-toggle').textContent, '+'); assert.equal(find(f.root, 'attributes-toggle').attributes['aria-expanded'], 'false');
        assert.equal(find(f.root, 'attributes-toggle').attributes['aria-label'], 'Expand Referenced Series Sequence (0008,1115), level 0');
        activateToggle(f, parent);
        assert.deepEqual(rows(f.root).map(pathOf), [parent, first, input[6].path, input[8].path]);
        assert.deepEqual(rows(f.root).map(element => element.dataset.level), ['0', '1', '1', '0']);
        assert.equal(find(rows(f.root)[0], 'attributes-tag').textContent, '(0008,1115)', 'Tag text stays unchanged.');
        let toggle = find(rows(f.root)[0], 'attributes-toggle');
        assert.equal(toggle.textContent, '−'); assert.equal(toggle.attributes['aria-expanded'], 'true'); assert.equal(document.activeElement, toggle);
        activateToggle(f, first); activateToggle(f, nested); activateToggle(f, child);
        const deep = rows(f.root).find(element => pathOf(element) === input[5].path);
        assert.equal(deep.dataset.level, '4'); assert.equal(deep.dataset.depth, '2'); assert.equal(deep.dataset.tone, '4');
        assert.equal(find(deep, 'attributes-level').textContent, 'L4'); assert.equal(find(deep, 'attributes-toggle'), undefined);
        assert.equal(find(rows(f.root).find(element => pathOf(element) === nested), 'attributes-toggle').attributes['aria-expanded'], 'true');
        activateToggle(f, first); assert.equal(rows(f.root).some(element => pathOf(element) === input[5].path), false);
        activateToggle(f, first); assert.ok(rows(f.root).some(element => pathOf(element) === input[5].path), 'Reopening a parent keeps its descendants expanded.');
        toggle = find(rows(f.root).find(element => pathOf(element) === first), 'attributes-toggle'); assert.equal(document.activeElement, toggle);
        assert.equal(f.source.calls.length, 1);
    } finally { f.cleanup(); }
});

test('search finds collapsed descendants without ancestor inflation and clearing it restores the previous hierarchy', () => {
    const input = treeRows(), f = fixture(snapshot(input));
    try {
        f.panel.setSource({series: f.source, index: 0});
        f.search('DEEP-SYNTHETIC-NEEDLE'); assert.equal(f.panel.getState().matchedCount, 1); assert.equal(rows(f.root).length, 1);
        assert.equal(rows(f.root)[0].dataset.level, '4'); assert.equal(pathOf(rows(f.root)[0]), input[5].path);
        assert.match(find(f.root, 'attributes-hint').textContent, /inside collapsed sequences.*Clear search/);
        assert.equal(find(f.root, 'attributes-expand-all').disabled, true); assert.equal(find(f.root, 'attributes-collapse-all').disabled, true);
        f.click('attributes-clear-search'); assert.equal(rows(f.root).length, 2);
        activateToggle(f, input[0].path); activateToggle(f, input[1].path); const expanded = rows(f.root).map(pathOf);
        f.search('Referenced Image Sequence'); assert.equal(rows(f.root).length, 1); const disabledToggle = find(f.root, 'attributes-toggle');
        assert.equal(disabledToggle.disabled, true); assert.equal(disabledToggle.attributes['aria-expanded'], 'false');
        activateToggle(f, input[3].path); f.click('attributes-expand-all');
        f.click('attributes-clear-search'); assert.deepEqual(rows(f.root).map(pathOf), expanded);
    } finally { f.cleanup(); }
});

test('repeated sequence paths have occurrence-local expansion and section changes cannot inherit parents', () => {
    const branch = 'dataset/(0008,1115)', item = `${branch}/item[1]`, leaf = `${item}/(0020,000e)`;
    const section = [
        row('(0008,1115)', 'Repeated Sequence', '1 item', {path: branch, vr: 'SQ', kind: 'sequence'}),
        row('(fffe,e000)', 'Item 1', '', {path: item, depth: 1, vr: 'ITEM', kind: 'item'}),
        row('(0020,000e)', 'UID', 'FIRST-OCCURRENCE', {path: leaf, depth: 1})
    ];
    const f = fixture(snapshot([...section, ...section.map(value => ({...value, value: value.kind === 'value' ? 'SECOND-OCCURRENCE' : value.value})),
        row('(0002,0010)', 'Meta value', 'EXPLICIT', {section: 'meta', path: `${item}/(0002,0010)`})]));
    try {
        f.panel.setSource({series: f.source, index: 0}); assert.equal(rows(f.root).length, 3);
        activateToggle(f, branch, 0); activateToggle(f, item);
        assert.ok(f.root.textContent.includes('FIRST-OCCURRENCE')); assert.equal(f.root.textContent.includes('SECOND-OCCURRENCE'), false);
        const second = rows(f.root).filter(element => pathOf(element) === branch)[1]; assert.equal(find(second, 'attributes-toggle').attributes['aria-expanded'], 'false');
        activateToggle(f, branch, 1); activateToggle(f, item, 1);
        assert.ok(f.root.textContent.includes('SECOND-OCCURRENCE'));
        assert.equal(rows(f.root).at(-1).dataset.level, '0');
        activateToggle(f, branch, 0); assert.equal(f.root.textContent.includes('FIRST-OCCURRENCE'), false); assert.ok(f.root.textContent.includes('SECOND-OCCURRENCE'));
    } finally { f.cleanup(); }
});

test('expand and collapse all respect page bounds, and empty or truncated parents have no false disclosure', () => {
    const parent = 'dataset/(0008,1115)', item = `${parent}/item[1]`;
    const input = [row('(0008,1115)', 'Sequence', '1 item', {path: parent, vr: 'SQ', kind: 'sequence'}),
        row('(fffe,e000)', 'Item 1', '', {path: item, depth: 1, vr: 'ITEM', kind: 'item'}),
        ...Array.from({length: 121}, (_, index) => row(`(1001,${index.toString(16).padStart(4, '0')})`, `Nested ${index}`, `marker ${index}`, {path: `${item}/(1001,${index.toString(16).padStart(4, '0')})`, depth: 1})),
        row('(0008,1140)', 'Empty Sequence', '0 items', {path: 'dataset/(0008,1140)', vr: 'SQ', kind: 'sequence'}),
        row('(0040,a730)', 'Shortened Sequence', '2 items · depth limit reached', {path: 'dataset/(0040,a730)', vr: 'SQ', kind: 'sequence', truncated: true})];
    const f = fixture(snapshot(input, {truncated: true}));
    try {
        f.panel.setSource({series: f.source, index: 0}); assert.equal(rows(f.root).length, 3); assert.equal(find(f.root, 'attributes-collapse-all').disabled, true);
        assert.equal(descendants(f.root).filter(element => element.className === 'attributes-toggle').length, 1);
        assert.equal(descendants(f.root).filter(element => element.className === 'attributes-toggle-placeholder').length, 2);
        f.click('attributes-expand-all'); assert.equal(rows(f.root).length, 50); assert.equal(f.panel.getState().matchedCount, 125); assert.equal(f.panel.getState().pageCount, 3);
        assert.equal(find(f.root, 'attributes-expand-all').disabled, true); f.click('attributes-next'); f.click('attributes-next'); assert.equal(rows(f.root).length, 25);
        f.click('attributes-collapse-all'); assert.equal(rows(f.root).length, 3); assert.equal(f.panel.getState().page, 0); assert.equal(f.panel.getState().pageCount, 1);
        assert.equal(find(f.root, 'attributes-collapse-all').disabled, true); assert.equal(f.source.calls.length, 1);
    } finally { f.cleanup(); }
});

test('deep paths keep true levels beyond the shade cycle without changing metadata depth or exposing an arbitrary UI cap', () => {
    const input = []; let path = 'dataset';
    for (let depth = 0; depth < 16; depth++) {
        path += '/(0008,1115)'; input.push(row('(0008,1115)', 'Nested Sequence', '1 item', {path, depth, vr: 'SQ', kind: 'sequence'}));
        path += '/item[1]'; input.push(row('(fffe,e000)', 'Item 1', '', {path, depth: depth + 1, vr: 'ITEM', kind: 'item'}));
    }
    input.push(row('(0010,0020)', 'Patient ID', 'DEEPEST', {path: `${path}/(0010,0020)`, depth: 16}));
    const f = fixture(snapshot(input));
    try {
        f.panel.setSource({series: f.source, index: 0}); f.click('attributes-expand-all'); assert.equal(rows(f.root).length, 33);
        const deepest = rows(f.root).at(-1); assert.equal(deepest.dataset.level, '32'); assert.equal(deepest.dataset.depth, '16'); assert.equal(deepest.dataset.tone, '2');
        assert.equal(find(deepest, 'attributes-level').textContent, 'L32'); assert.equal(find(deepest, 'attributes-level').attributes['aria-label'], 'Nesting level 32');
    } finally { f.cleanup(); }
});

test('a real EASI native snapshot separates item ancestry from equal metadata depths and keeps repeated tags in their own items', async () => {
    const metadata = { '00080016': j('UI', '1.2.840.10008.5.1.4.1.1.7'), '00080018': j('UI', '2.25.88001'),
        '00081115': sq({ '0020000E': j('UI', '2.25.881'), '00081140': sq({ '00081155': j('UI', '2.25.8811') }, { '00081155': j('UI', '2.25.8812') }) }, { '0020000E': j('UI', '2.25.882') }) };
    const parsed = (await EASI.pipelineBuilder().fromByteStream().ofDicomData({includePart10Header: true}).toInstances().build().process({source: independentNativeFixture(metadata)})).first();
    const retained = createAttributeSnapshot(parsed), f = fixture(retained);
    try {
        f.panel.setSource({series: f.source, index: 0}); f.click('attributes-expand-all');
        const refs = rows(f.root).filter(element => find(element, 'attributes-tag').textContent === '(0008,1155)');
        assert.equal(refs.length, 2); assert.deepEqual(refs.map(element => element.dataset.depth), ['2', '2']); assert.deepEqual(refs.map(element => element.dataset.level), ['4', '4']);
        assert.ok(pathOf(refs[0]).endsWith('/item[1]/(0008,1155)')); assert.ok(pathOf(refs[1]).endsWith('/item[2]/(0008,1155)'));
        activateToggle(f, 'dataset/(0008,1115)/item[1]/(0008,1140)/item[1]');
        assert.equal(f.root.textContent.includes('2.25.8811'), false); assert.ok(f.root.textContent.includes('2.25.8812'));
        assert.ok(f.root.textContent.includes('2.25.882')); assert.equal(f.source.calls.length, 1);
    } finally { f.cleanup(); }
});

test('expansion survives a shared retained snapshot but resets on a new snapshot, source, failure, clear, and disposal', () => {
    const initial = snapshot(treeRows()), f = fixture(initial), parent = initial.rows[0].path;
    try {
        f.panel.setSource({series: f.source, index: 0}); activateToggle(f, parent); const before = rows(f.root)[0];
        f.panel.setSource({series: f.source, index: 1}); assert.equal(rows(f.root)[0], before); assert.equal(rows(f.root).length, 4);
        f.source.current = snapshot(treeRows()); f.panel.setSource({series: f.source, index: 2}); assert.equal(rows(f.root).length, 2);
        activateToggle(f, parent); f.source.current = snapshot(treeRows()); f.panel.setSource({series: f.source, index: 2}); assert.equal(rows(f.root).length, 2);
        activateToggle(f, parent);
        const replacement = {getAttributes() { assert.equal(rows(f.root).length, 0); return initial; }};
        f.panel.setSource({series: replacement, index: 0}); assert.equal(rows(f.root).length, 2); activateToggle(f, parent);
        f.panel.setSource({series: {getAttributes() { throw Error('SYNTHETIC PRIVATE'); }}, index: 0});
        assert.equal(rows(f.root).length, 0); assert.equal(f.panel.getState().error, true); assert.equal(find(f.root, 'attributes-expand-all').disabled, true);
        f.panel.setSource({series: f.source, index: 0}); assert.equal(rows(f.root).length, 2); activateToggle(f, parent); f.panel.clear();
        f.panel.setSource({series: f.source, index: 0}); assert.equal(rows(f.root).length, 2); activateToggle(f, parent);
        const body = find(f.root, 'attributes-table').children[2], toggle = find(f.root, 'attributes-toggle'); f.panel.dispose();
        const event = new Event('click'); Object.defineProperty(event, 'target', {value: toggle}); body.dispatchEvent(event);
        assert.equal(f.root.children.length, 0); assert.equal(f.panel.getState().rowCount, 0);
        assert.ok(!/SYNTHETIC|dataset|1115/iu.test(JSON.stringify(f.panel.getState())));
    } finally { f.cleanup(); }
});

test('long text has an available-value disclosure while binary/pixel/bulk rows remain summaries with no request or byte view', () => {
    const original = globalThis.fetch; let requests = 0; globalThis.fetch = () => { requests++; throw new Error('No retrieval is allowed.'); };
    const long = 'Generated narrative '.repeat(100);
    const f = fixture(snapshot([
        row('(0040,a160)', 'Text Value', long, {vr: 'UT', truncated: true}),
        row('(7fe0,0010)', 'Pixel Data', 'Pixel data omitted · 4096 bytes', {vr: 'OW', kind: 'binary'}),
        row('(0011,1010)', 'Bulk Reference', 'External bulk reference omitted', {kind: 'bulk', vr: 'OB'})
    ]));
    try {
        f.panel.setSource({series: f.source, index: 0});
        const details = descendants(f.root).filter(node => node.tagName === 'details'); assert.equal(details.length, 1);
        assert.equal(find(f.root, 'attributes-full-value').textContent, long); assert.ok(find(f.root, 'attributes-value-preview').textContent.length <= 129);
        assert.equal(descendants(f.root).filter(node => node.className === 'attributes-binary-summary').length, 2);
        assert.match(find(f.root, 'attributes-warning').textContent, /4,096 rows, 16 sequence levels, 4,096 characters/);
        assert.match(find(f.root, 'attributes-warning').textContent, /128 KiB.*2 MiB.*may be shortened/);
        f.search('external bulk'); assert.equal(rows(f.root).length, 1); assert.equal(requests, 0);
    } finally { f.cleanup(); globalThis.fetch = original; }
});

test('a retained snapshot shared across frames preserves DOM/search, and a new frame in the same Series retains its filter with fresh values', () => {
    const first = snapshot([row('(0010,0020)', 'Patient ID', 'SYNTHETIC-FIRST'), row('(0008,0060)', 'Modality', 'CT')]), f = fixture(first);
    try {
        f.panel.setSource({series: f.source, index: 0}); f.search('patient id'); const before = rows(f.root)[0];
        f.panel.setSource({series: f.source, index: 1}); assert.equal(rows(f.root)[0], before); assert.equal(find(f.root, 'attributes-search').value, 'patient id');
        f.source.current = snapshot([row('(0010,0020)', 'Patient ID', 'SYNTHETIC-SECOND'), row('(0008,0060)', 'Modality', 'MR')]);
        f.panel.setSource({series: f.source, index: 2}); assert.equal(rows(f.root).length, 1); assert.equal(f.panel.getState().page, 0);
        assert.equal(find(f.root, 'attributes-search').value, 'patient id'); assert.equal(f.root.textContent.includes('SYNTHETIC-FIRST'), false);
        assert.ok(f.root.textContent.includes('SYNTHETIC-SECOND'));
    } finally { f.cleanup(); }
});

test('retention-budget exhaustion explains unavailable rows using fixed text and readable bounds rather than treating it as an empty dataset', () => {
    const f = fixture(snapshot([], {truncated: true, reasons: Object.freeze(['byte-limit', 'SYNTHETIC-PRIVATE-REASON']),
        limits: {maxRows: 4096, maxDepth: 16, maxValueChars: 4096, maxBytes: 0}}));
    try {
        f.panel.setSource({series: f.source, index: 0}); assert.equal(f.panel.getState().ready, true); assert.equal(f.panel.getState().truncated, true);
        assert.match(find(f.root, 'attributes-empty').textContent, /retention budget reached/);
        assert.match(find(f.root, 'attributes-warning').textContent, /0 bytes.*2 MiB/);
        assert.equal(f.root.textContent.includes('SYNTHETIC-PRIVATE-REASON'), false);
        assert.equal(find(f.root, 'attributes-table').hidden, true); assert.equal(rows(f.root).length, 0);
    } finally { f.cleanup(); }
});

test('same retained frame refresh is cheap, enrichment preserves search, and a changed source drops protected rows and search before its getter runs', () => {
    const first = snapshot([row('(0010,0010)', 'Patient Name', 'SYNTHETIC-SECRET'), row('(0008,0060)', 'Modality', 'CT')]), f = fixture(first);
    try {
        f.panel.setSource({series: f.source, index: 0}); f.search('modality'); const oldRow = rows(f.root)[0];
        f.panel.setSource({series: f.source, index: 0}); assert.equal(rows(f.root)[0], oldRow);
        f.source.current = snapshot([...first.rows, row('(0002,0010)', 'Transfer Syntax UID', '1.2.840.10008.1.2.1', {section: 'meta'})]);
        f.panel.setSource({series: f.source, index: 0}); assert.equal(f.panel.getState().matchedCount, 1); assert.equal(f.panel.getState().rowCount, 3);
        const replacement = { getAttributes(index) { assert.equal(index, 7); assert.equal(f.root.textContent.includes('SYNTHETIC-SECRET'), false); assert.equal(rows(f.root).length, 0); assert.equal(find(f.root, 'attributes-search').value, ''); return snapshot([row('(0008,0060)', 'Modality', 'MR')]); } };
        f.panel.setSource({series: replacement, index: 7}); assert.equal(f.panel.getState().rowCount, 1); assert.ok(f.root.textContent.includes('MR'));
        f.search('MR'); f.panel.setSource({series: replacement, index: 8}); assert.equal(f.panel.getState().error, true);
        assert.equal(rows(f.root).length, 0); assert.equal(find(f.root, 'attributes-search').value, '');
    } finally { f.cleanup(); }
});

test('source failures and malformed or oversized snapshots clear stale values with a fixed message and no source error disclosure', () => {
    const f = fixture(snapshot([row('(0010,0010)', 'Patient Name', 'SYNTHETIC-PRIVATE')]));
    try {
        f.panel.setSource({series: f.source, index: 0}); f.search('SYNTHETIC-PRIVATE');
        const failing = {getAttributes() { throw new Error('SYNTHETIC-PRIVATE token and source URL'); }};
        assert.doesNotThrow(() => f.panel.setSource({series: failing, index: 0})); assert.equal(rows(f.root).length, 0);
        assert.equal(find(f.root, 'attributes-empty').textContent, 'Attributes are unavailable for this image.'); assert.equal(f.root.textContent.includes('SYNTHETIC-PRIVATE'), false);
        for (const invalid of [null, {rows: Array(4097).fill(firstRow()), truncated: false}, snapshot([row('(0010,0010)', 'Name', 'x'.repeat(4097))]), snapshot([row('(0010,0010)', 'Name', 'x', {depth: 17})])]) {
            assert.doesNotThrow(() => f.panel.setSource({series: {getAttributes: () => invalid}, index: 0}));
            assert.equal(f.panel.getState().ready, false); assert.equal(f.panel.getState().visibleCount, 0);
        }
        assert.ok(!/SYNTHETIC|token|url|query|rows"\s*:/iu.test(JSON.stringify(f.panel.getState())));
    } finally { f.cleanup(); }
});
function firstRow() { return row('(0008,0060)', 'Modality', 'CT'); }

test('clear and dispose purge retained metadata and listener effects without producing persistence or export actions', () => {
    const f = fixture(snapshot([row('(0010,0010)', 'Patient Name', 'SYNTHETIC-PURGED')]));
    f.panel.setSource({series: f.source, index: 0}); const input = find(f.root, 'attributes-search'), next = find(f.root, 'attributes-next');
    f.search('SYNTHETIC'); f.panel.clear(); assert.equal(rows(f.root).length, 0); assert.equal(input.value, ''); assert.equal(f.root.textContent.includes('SYNTHETIC-PURGED'), false);
    f.panel.setSource({series: f.source, index: 0}); f.panel.dispose(); assert.equal(f.root.children.length, 0); assert.equal(f.panel.getState().rowCount, 0);
    input.value = 'late synthetic search'; input.dispatchEvent(new Event('input')); next.dispatchEvent(new Event('click')); assert.equal(f.root.children.length, 0);
    assert.throws(() => f.panel.setSource({series: f.source, index: 0}), /disposed/); f.panel.dispose();
});
