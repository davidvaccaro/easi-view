import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReadingProtocol, normalizeReadingProtocols, evaluateReadingProtocol, getDefaultReadingProtocols,
    MAX_READING_PROTOCOL_BYTES } from '../src/protocols/index.js';
import { createDicomFixture } from '../src/data/synthetic.js';
import { loadFiles } from '../src/data/sources.js';
import { createEnhancedDicom } from './enhanced-fixtures.js';
const clone = value => JSON.parse(JSON.stringify(value));
const rule = (field, op, value, more = {}) => ({ field, op, value, ...more });
function protocol(overrides = {}) {
    return { version: 1, id: 'synthetic-reading', name: 'Synthetic reading', layout: 1,
        selectors: [{ id: 'main', scope: 'all', rules: [rule('modality', 'eq', 'MR')] }],
        slots: [{ id: 0, selector: 'main', frame: { mode: 'first' } }], ...overrides };
}
const candidate = (index, more = {}) => ({ index, role: 'current', modality: 'MR', description: 'Synthetic sequence',
    photometric: 'MONOCHROME2', unit: '', rows: 2, columns: 2, frameCount: 8, geometryKnown: true, dimensionsValid: true, ...more });
const preset = id => getDefaultReadingProtocols().find(value => value.id === id);
const rejects = value => assert.throws(() => normalizeReadingProtocol(value), /Invalid reading protocol/u);

test('versioned normalization is detached, immutable, JSON roundtrippable and idempotent', () => {
    const input = protocol(), normalized = normalizeReadingProtocol(input);
    assert.equal(normalized.version, 1); assert.deepEqual(normalized.links, { scroll: false, window: false, camera: false });
    assert.deepEqual(normalizeReadingProtocol(normalized), normalized); assert.deepEqual(normalizeReadingProtocol(JSON.stringify(input)), normalized);
    input.selectors[0].rules[0].value = 'CT'; input.slots[0].frame.mode = 'middle';
    assert.equal(normalized.selectors[0].rules[0].value, 'MR'); assert.equal(normalized.slots[0].frame.mode, 'first');
    assert.ok(Object.isFrozen(normalized) && Object.isFrozen(normalized.selectors) && Object.isFrozen(normalized.selectors[0].rules[0]));
    assert.throws(() => { normalized.slots.push({}); }, TypeError);
    assert.deepEqual(getDefaultReadingProtocols().map(value => value.id), ['ct-dual-window', 'mr-sequence-comparison', 'current-prior-comparison']);
    assert.ok(Object.isFrozen(getDefaultReadingProtocols()));
});

test('schema rejects guessed operators, unknown fields, executable values and malformed identities without invoking accessors', () => {
    for (const patch of [{ version: 2 }, { id: '../protocol' }, { name: '' }, { layout: 3 }, { sourceUid: '2.25.1' }, { links: { registration: true } }]) rejects(protocol(patch));
    for (const bad of [rule('studyUid', 'eq', '2.25.1'), rule('description', 'regex', '.*'), rule('description', 'contains', ''),
        rule('frameCount', 'contains', '3'), rule('modality', 'eq', 1), rule('geometryKnown', 'eq', 'true'), rule('modality', 'eq', 'MR', { weight: 101 }),
        rule('modality', 'eq', 'MR', { required: 'yes' }), rule('description', 'eq', () => true), rule('description', 'eq', 'a\nname')]) {
        rejects(protocol({ selectors: [{ id: 'main', scope: 'all', rules: [bad] }] }));
    }
    let calls = 0; const input = protocol(); Object.defineProperty(input, 'layout', { enumerable: true, get() { calls++; return 1; } });
    rejects(input); assert.equal(calls, 0);
    const array = [rule('modality', 'eq', 'MR')]; Object.defineProperty(array, '0', { get() { calls++; return rule('modality', 'eq', 'CT'); } });
    rejects(protocol({ selectors: [{ id: 'main', scope: 'all', rules: array }] })); assert.equal(calls, 0);
    const cyclic = protocol(); cyclic.slots[0].frame.circular = cyclic; rejects(cyclic);
});

test('schema enforces collection, serialized UTF8, selector, rule, pane and dependency limits', () => {
    const list = Array.from({ length: 32 }, (_, index) => protocol({ id: `protocol-${index}` }));
    assert.equal(normalizeReadingProtocols(list).length, 32); assert.throws(() => normalizeReadingProtocols([...list, protocol({ id: 'extra' })]), /thirty-two/u);
    assert.throws(() => normalizeReadingProtocols([protocol(), protocol()]), /unique/u);
    rejects(protocol({ selectors: [{ id: 'main', scope: 'all', rules: Array.from({ length: 17 }, () => rule('modality', 'eq', 'MR')) }] }));
    rejects(protocol({ layout: 2, slots: [{ id: 0, selector: 'main' }, { id: 0, selector: 'main' }] }));
    rejects(protocol({ layout: 2 })); rejects(protocol({ slots: [{ id: 1, selector: 'main' }] }));
    rejects(protocol({ selectors: [{ id: 'main', scope: 'all', distinctFrom: ['later'], rules: [rule('modality', 'eq', 'MR')] },
        { id: 'later', scope: 'all', rules: [rule('modality', 'eq', 'MR')] }] }));
    rejects(protocol({ selectors: [{ id: 'main', scope: 'all', rules: [rule('effectiveEchoTime', 'range', [10, 0])] }] }));
    rejects(protocol({ selectors: [{ id: 'main', scope: 'all', rules: [rule('modality', 'in', ['MR', 'mr'])] }] }));
    assert.throws(() => normalizeReadingProtocol(' '.repeat(MAX_READING_PROTOCOL_BYTES + 1)), /64 KiB/u);
    const heavy = list.map(value => ({ ...value, selectors: [{ id: 'main', scope: 'all', rules: Array.from({ length: 16 }, () => rule('description', 'contains', '合'.repeat(256))) }] }));
    assert.throws(() => normalizeReadingProtocols(heavy), /64 KiB/u);
    assert.throws(() => normalizeReadingProtocol(JSON.stringify(protocol()) + '/* comments */'), /valid JSON/u);
});

test('retained normalized JSON fits64KiB and every accepted near-cap collection roundtrips after defaults', () => {
    const compact = index => ({ version: 1, id: `p-${index}`, name: 'Synthetic', layout: 4,
        selectors: Array.from({ length: 4 }, (_, selector) => ({ id: `s-${selector}`, scope: 'all',
            rules: Array.from({ length: 16 }, () => rule('modality', 'eq', 'MR')) })),
        slots: Array.from({ length: 4 }, (_, slot) => ({ id: slot, selector: `s-${slot}` })) });
    const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    const nearCap = Array.from({ length: 12 }, (_, index) => compact(index));
    const normalized = normalizeReadingProtocols(nearCap);
    assert.equal(bytes(nearCap), 37767); assert.equal(bytes(normalized), 63291);
    assert.ok(bytes(normalized) <= MAX_READING_PROTOCOL_BYTES);
    assert.deepEqual(normalizeReadingProtocols(normalized), normalized);
    assert.deepEqual(normalizeReadingProtocols(JSON.stringify(normalized)), normalized);
    for (const item of normalized) assert.deepEqual(normalizeReadingProtocol(item), item);
    // This is the same boundary used by getReadingProtocols -> setReadingProtocols.
    assert.deepEqual(normalizeReadingProtocols(normalizeReadingProtocols(nearCap)), normalized);
    const expandsOverCap = Array.from({ length: 14 }, (_, index) => compact(index));
    assert.equal(bytes(expandsOverCap), 44063); assert.ok(bytes(expandsOverCap) < MAX_READING_PROTOCOL_BYTES);
    assert.throws(() => normalizeReadingProtocols(expandsOverCap), /64 KiB/u);
    assert.throws(() => normalizeReadingProtocols(JSON.stringify(expandsOverCap)), /64 KiB/u);
    // One definition also respects the retained limit, independent of collection use.
    const maximum = compact(0);
    maximum.selectors.forEach(selector => selector.rules.forEach(value => { value.field = 'description'; value.value = '合'.repeat(256); }));
    const single = normalizeReadingProtocol(maximum);
    assert.ok(bytes(single) <= MAX_READING_PROTOCOL_BYTES);
    assert.deepEqual(normalizeReadingProtocol(JSON.stringify(single)), single);
    assert.deepEqual(normalizeReadingProtocols([single]), [single]);
});

test('ranking sums declared literal preference weights and distinguishes required missing fields', () => {
    const ranked = protocol({ selectors: [{ id: 'main', scope: 'all', rules: [rule('modality', 'eq', 'MR', { weight: 3 }),
        rule('effectiveEchoTime', 'range', [20, 40], { required: false, weight: 7 }), rule('description', 'contains', 'sequence a', { required: false, weight: 2 })] }] });
    const plan = evaluateReadingProtocol(ranked, [candidate(0, { description: 'SYNTHETIC SEQUENCE A', effectiveEchoTime: 30 }),
        candidate(1, { description: 'Sequence A', effectiveEchoTime: 60 }), candidate(2, { modality: null, effectiveEchoTime: 30 })]);
    assert.equal(plan.status, 'ready'); assert.equal(plan.selectors[0].matchedIndex, 0);
    assert.deepEqual(plan.selectors[0].candidates.map(value => [value.index, value.eligible, value.score]), [[0, true, 12], [1, true, 5], [2, false, 7]]);
    assert.ok(plan.selectors[0].candidates[2].reasonCodes.includes('rule-missing:modality'));
    assert.ok(plan.selectors[0].candidates[1].reasonCodes.includes('preference-mismatch:effectiveEchoTime'));
    const optional = evaluateReadingProtocol(ranked, [candidate(0, { effectiveEchoTime: null })]);
    assert.equal(optional.status, 'ready'); assert.ok(optional.selectors[0].candidates[0].reasonCodes.includes('preference-missing:effectiveEchoTime'));
});

test('equal ranked candidates remain ambiguous and output is invariant under candidate input order', () => {
    const candidates = [candidate(9), candidate(2), candidate(5, { modality: 'CT' })];
    const first = evaluateReadingProtocol(protocol(), candidates), second = evaluateReadingProtocol(protocol(), [...candidates].reverse());
    assert.deepEqual(first, second); assert.equal(first.status, 'unresolved'); assert.equal(first.selectors[0].status, 'ambiguous');
    assert.equal(first.slots[0].candidateIndex, null); assert.ok(first.selectors[0].reasonCodes.includes('equal-ranked-candidates'));
    assert.deepEqual(first.selectors[0].candidates.map(value => value.index), [2, 5, 9]);
    const missing = evaluateReadingProtocol(protocol(), [candidate(0, { modality: null })]);
    assert.equal(missing.selectors[0].status, 'missing'); assert.equal(missing.slots[0].frameIndex, null);
});

test('manual overrides resolve ties only for eligible candidates and preserve explicit scopes', () => {
    const values = [candidate(0), candidate(1), candidate(2, { modality: 'CT' })];
    const overridden = evaluateReadingProtocol(protocol(), values, { overrides: { main: 1 } });
    assert.equal(overridden.status, 'ready'); assert.equal(overridden.selectors[0].matchedIndex, 1); assert.equal(overridden.selectors[0].manual, true);
    assert.ok(overridden.selectors[0].reasonCodes.includes('manual-override'));
    assert.throws(() => evaluateReadingProtocol(protocol(), values, { overrides: { main: 2 } }), /not eligible/u);
    assert.throws(() => evaluateReadingProtocol(protocol(), values, { overrides: { unknown: 0 } }), /declared selectors/u);
    assert.throws(() => evaluateReadingProtocol(protocol(), values, { overrides: { main: 99 } }), /current stack candidates/u);
    const selected = protocol({ selectors: [{ id: 'main', scope: 'selected', rules: [rule('modality', 'eq', 'MR')] }] });
    assert.throws(() => evaluateReadingProtocol(selected, values, { selectedIndex: 0, overrides: { main: 1 } }), /not eligible/u);
});

test('CT dual-window preset uses exactly the selected HU stack and same active frame with explicit independent windows', () => {
    const plan = evaluateReadingProtocol(preset('ct-dual-window'), [candidate(7, { modality: 'CT', unit: 'HU' }), candidate(1, { modality: 'CT', unit: 'HU' })],
        { selectedIndex: 7, activeFrames: { 7: 5 } });
    assert.equal(plan.status, 'ready'); assert.deepEqual(plan.slots.map(value => [value.id, value.candidateIndex, value.frameIndex]), [[0, 7, 5], [1, 7, 5]]);
    assert.deepEqual(plan.slots.map(value => value.window), [{ center: 40, width: 400 }, { center: -600, width: 1500 }]);
    assert.deepEqual(plan.links, { scroll: true, window: false, camera: true }); assert.ok(plan.slots.every(value => value.windowUnit === 'HU'));
    for (const more of [{ unit: '' }, { unit: 'hu' }, { modality: 'MR' }, { photometric: 'RGB' }, { photometric: 'PALETTE COLOR' }]) {
        assert.equal(evaluateReadingProtocol(preset('ct-dual-window'), [candidate(0, { modality: 'CT', unit: 'HU', ...more })], { selectedIndex: 0, activeFrames: { 0: 0 } }).status, 'unresolved');
    }
    assert.ok(evaluateReadingProtocol(preset('ct-dual-window'), [candidate(0, { modality: 'CT', unit: 'hu' })], { selectedIndex: 0 }).selectors[0].candidates[0].reasonCodes.includes('window-unit-mismatch'));
});

test('MR comparison preserves separate acquisition/echo stacks, exposes ambiguity, and never chooses a physiological label', () => {
    const values = [candidate(0, { effectiveEchoTime: 10, acquisitionNumber: 1 }), candidate(1, { effectiveEchoTime: 80, acquisitionNumber: 1 }),
        candidate(2, { effectiveEchoTime: 20, acquisitionNumber: 2 }), candidate(3, { role: 'prior' })];
    const ambiguous = evaluateReadingProtocol(preset('mr-sequence-comparison'), values, { selectedIndex: 0, activeFrames: { 0: 2 } });
    assert.equal(ambiguous.selectors[0].matchedIndex, 0); assert.equal(ambiguous.selectors[1].status, 'ambiguous');
    assert.equal(ambiguous.selectors[1].candidates[0].eligible, false); assert.ok(ambiguous.selectors[1].candidates[0].reasonCodes.includes('stack-must-be-distinct'));
    const chosen = evaluateReadingProtocol(preset('mr-sequence-comparison'), values, { selectedIndex: 0, activeFrames: { 0: 2 }, overrides: { comparison: 2 } });
    assert.equal(chosen.status, 'ready'); assert.deepEqual(chosen.slots.map(value => [value.candidateIndex, value.frameIndex]), [[0, 2], [2, 3]]);
    assert.throws(() => evaluateReadingProtocol(preset('mr-sequence-comparison'), values, { selectedIndex: 0, overrides: { comparison: 0 } }), /not eligible/u);
    assert.throws(() => evaluateReadingProtocol(preset('mr-sequence-comparison'), values, { selectedIndex: 0, overrides: { comparison: 3 } }), /not eligible/u);
    assert.doesNotMatch(JSON.stringify(chosen), /T1|T2|effectiveEchoTime|acquisitionNumber/u);
    const blocked = evaluateReadingProtocol(preset('mr-sequence-comparison'), values);
    assert.equal(blocked.selectors[0].status, 'missing'); assert.equal(blocked.selectors[1].status, 'blocked');
});

test('current/prior roles require explicit assignments and never infer identity, dates or registration', () => {
    const values = [candidate(0, { role: 'unassigned', description: 'Current CT 20261014' }), candidate(1, { role: 'unassigned', description: 'Prior CT 20201001' })];
    const missing = evaluateReadingProtocol(preset('current-prior-comparison'), values);
    assert.equal(missing.status, 'unresolved'); assert.ok(missing.selectors.every(value => value.status === 'missing'));
    const explicit = evaluateReadingProtocol(preset('current-prior-comparison'), [candidate(0), candidate(1, { role: 'prior' })]);
    assert.equal(explicit.status, 'ready'); assert.deepEqual(explicit.slots.map(value => value.candidateIndex), [0, 1]);
    assert.deepEqual(explicit.links, { scroll: false, window: false, camera: false });
    const ambiguous = evaluateReadingProtocol(preset('current-prior-comparison'), [candidate(0), candidate(1), candidate(2, { role: 'prior' })]);
    assert.equal(ambiguous.selectors[0].status, 'ambiguous');
});

test('frame policies use explicit zero-based logical indices, lower middle and unavailable active/index states', () => {
    const multi = protocol({ layout: 4, slots: [{ id: 3, selector: 'main', frame: { mode: 'index', index: 7 } },
        { id: 1, selector: 'main', frame: { mode: 'middle' } }, { id: 0, selector: 'main', frame: { mode: 'first' } },
        { id: 2, selector: 'main', frame: { mode: 'active' } }] });
    const ready = evaluateReadingProtocol(multi, [candidate(0)], { activeFrames: { 0: 6 } });
    assert.equal(ready.status, 'ready'); assert.deepEqual(ready.slots.map(value => value.frameIndex), [0, 3, 6, 7]);
    const missing = evaluateReadingProtocol(multi, [candidate(0, { frameCount: 3 })]);
    assert.deepEqual(missing.slots.map(value => value.status), ['ready', 'ready', 'frame-unavailable', 'frame-unavailable']);
    assert.deepEqual(missing.slots[2].reasonCodes, ['active-frame-unavailable']); assert.deepEqual(missing.slots[3].reasonCodes, ['frame-index-out-of-range']);
    const last = protocol({ slots: [{ id: 0, selector: 'main', frame: { mode: 'index', index: 9999 } }] });
    assert.equal(evaluateReadingProtocol(last, [candidate(0, { frameCount: 10000 })]).slots[0].frameIndex, 9999);
    rejects(protocol({ slots: [{ id: 0, selector: 'main', frame: { mode: 'index', index: 10000 } }] }));
    rejects(protocol({ slots: [{ id: 0, selector: 'main', frame: { mode: 'first', index: 0 } }] }));
});

test('literal exists/in/range operators distinguish false, zero, unknown and case-insensitive text safely', () => {
    const criteria = protocol({ selectors: [{ id: 'main', scope: 'all', rules: [rule('modality', 'in', ['CT', 'MR']),
        rule('geometryKnown', 'eq', false), rule('effectiveEchoTime', 'range', [0, 0]), rule('acquisitionContrast', 'exists', false)] }] });
    const plan = evaluateReadingProtocol(criteria, [candidate(0, { modality: 'mr', geometryKnown: false, effectiveEchoTime: 0, acquisitionContrast: null })]);
    assert.equal(plan.status, 'ready'); assert.equal(plan.selectors[0].candidates[0].score, 4);
    assert.equal(evaluateReadingProtocol(criteria, [candidate(0, { geometryKnown: null, effectiveEchoTime: null })]).status, 'unresolved');
    const literal = protocol({ selectors: [{ id: 'main', scope: 'all', rules: [rule('description', 'contains', '.*')] }] });
    assert.equal(evaluateReadingProtocol(literal, [candidate(0, { description: 'not a wildcard' })]).status, 'unresolved');
    assert.equal(evaluateReadingProtocol(literal, [candidate(0, { description: 'literal .* text' })]).status, 'ready');
});

test('candidate/options validation rejects collisions, unbounded fields, IDs and executable accessors', () => {
    for (const values of [[candidate(0), candidate(0)], [candidate(128)], [candidate(0, { frameCount: 0 })], [candidate(0, { frameCount: 10001 })],
        [candidate(0, { rows: 0 })], [candidate(0, { effectiveEchoTime: Infinity })], [candidate(0, { studyUid: '2.25.1' })],
        [candidate(0, { description: 'x'.repeat(513) })], [candidate(0, { role: 'auto-prior' })]]) {
        assert.throws(() => evaluateReadingProtocol(protocol(), values), /Invalid reading protocol/u);
    }
    const values = Array.from({ length: 128 }, (_, index) => candidate(index));
    assert.equal(evaluateReadingProtocol(protocol(), values).selectors[0].candidates.length, 128);
    assert.throws(() => evaluateReadingProtocol(protocol(), [...values, candidate(0)]), /at most/u);
    assert.throws(() => evaluateReadingProtocol(protocol(), [candidate(0)], { selectedIndex: 1 }), /current candidate/u);
    assert.throws(() => evaluateReadingProtocol(protocol(), [candidate(0)], { activeFrames: { '00': 0 } }), /current candidates/u);
    assert.throws(() => evaluateReadingProtocol(protocol(), [candidate(0)], { regex: true }), /evaluation options/u);
    let calls = 0; const accessor = candidate(0); Object.defineProperty(accessor, 'description', { enumerable: true, get() { calls++; return 'should not run'; } });
    assert.throws(() => evaluateReadingProtocol(protocol(), [accessor]), /candidate metadata/u); assert.equal(calls, 0);
    const accessorArray = [candidate(0)]; Object.defineProperty(accessorArray, '0', { get() { calls++; return candidate(0); } });
    assert.throws(() => evaluateReadingProtocol(protocol(), accessorArray), /without accessors/u); assert.equal(calls, 0);
});

test('plans contain only operational indices and rule codes, excluding metadata descriptions and any identifiers', () => {
    const values = [candidate(0, { description: 'SYNTHETIC PERSON 2.25.9090 SECRET METADATA' })];
    const plan = evaluateReadingProtocol(protocol(), values), serialized = JSON.stringify(plan);
    assert.doesNotMatch(serialized, /SYNTHETIC PERSON|2\.25\.9090|SECRET METADATA|description|studyUid|sopUid/u);
    assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.slots) && Object.isFrozen(plan.selectors[0].candidates[0].reasonCodes));
    const copy = clone(plan); assert.deepEqual(copy.slots[0], { id: 0, selector: 'main', status: 'ready', candidateIndex: 0, frameIndex: 0,
        window: null, windowUnit: null, reasonCodes: ['unique-best-match'] });
});

test('real synthetic EASI CT/MR and enhanced partitions can be planned without a fetch, decoder or Attributes snapshot read', async () => {
    const ct = await loadFiles([new File([createDicomFixture()], 'synthetic-ct.dcm')]);
    const mr = await loadFiles([new File([createDicomFixture({ modality: 'MR', sopClass: '1.2.840.10008.5.1.4.1.1.4', sopUid: '2.25.9231', extraAttributes: { '00180081': ['DS', 10] } })], 'synthetic-mr-a.dcm'),
        new File([createDicomFixture({ modality: 'MR', sopClass: '1.2.840.10008.5.1.4.1.1.4', sopUid: '2.25.9232', extraAttributes: { '00180081': ['DS', 80] } })], 'synthetic-mr-b.dcm')]);
    const enhanced = await loadFiles([new File([createEnhancedDicom()], 'synthetic-enhanced.dcm')]);
    const sources = [...ct, ...mr, ...enhanced], originalFetch = globalThis.fetch; let reads = 0;
    try {
        assert.equal(mr.length, 2); assert.equal(enhanced.length, 4);
        globalThis.fetch = () => { reads++; throw Error('Protocols never fetch.'); };
        for (const source of sources) { source.getAttributes = source.getFrame = () => { reads++; throw Error('Metadata planning never reads pixels or display snapshots.'); }; }
        const snapshots = sources.map((source, index) => {
            const frame = source.frames[0], dimensions = frame.dimensions ?? frame.classicDimensions;
            return { index, role: 'current', modality: source.modality, photometric: frame.photometric, unit: frame.unit,
                rows: frame.rows, columns: frame.columns, frameCount: source.frames.length,
                effectiveEchoTime: dimensions?.effectiveEchoTime ?? null, temporalPositionIndex: dimensions?.temporalPositionIndex ?? null };
        });
        const plan = evaluateReadingProtocol(preset('ct-dual-window'), snapshots, { selectedIndex: 0, activeFrames: { 0: 0 } });
        assert.equal(plan.status, 'ready'); assert.deepEqual(plan.slots.map(value => value.candidateIndex), [0, 0]);
        const mrPlan = evaluateReadingProtocol(preset('mr-sequence-comparison'), snapshots.filter(value => value.index === 1 || value.index === 2), { selectedIndex: 1, activeFrames: { 1: 0 } });
        assert.equal(mrPlan.status, 'ready'); assert.deepEqual(mrPlan.slots.map(value => value.candidateIndex), [1, 2]);
        assert.equal(reads, 0); assert.ok(sources.every(source => source._session.cache.bytes === 0));
        assert.equal(snapshots.length, 7); // independent partition indices never coalesced
    } finally { globalThis.fetch = originalFetch; sources.forEach(source => source.dispose()); }
});
