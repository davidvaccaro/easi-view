import test from 'node:test';
import assert from 'node:assert/strict';
import { planLocalWorkingSet, MAX_LOCAL_WORKING_STACKS } from '../src/integration/LocalWorkingSet.js';
import { loadFiles } from '../src/data/sources.js';
import { WorkspaceModel } from '../src/runtime/workspace.js';
import { createEnhancedDicom, fixtureFile, pixels } from './enhanced-fixtures.js';
import { createDicomFixture } from '../src/data/synthetic.js';

function stack(id, { frames = 1, bytes = 1, ...rest } = {}) {
    return { id, frames: Array.from({ length: frames }, () => ({})), sourceBytes: bytes, disposed: false, ...rest };
}
function group(id, options) { return { id, stacks: [stack(id, options)] }; }
function partitioned(id, count) { return { id, stacks: Array.from({ length: count }, (_, index) => stack(`${id}-${index}`)) }; }
const ids = value => value.map(item => item.id);

test('a selected group is retained and planning never disposes or mutates source groups', () => {
    const current = group('current', { bytes: 30, frames: 3 });
    Object.freeze(current.stacks); Object.freeze(current);
    const result = planLocalWorkingSet([current]);
    assert.deepEqual(result.groups, [current]); assert.deepEqual(result.stacks, current.stacks);
    assert.equal(result.bytes, 30); assert.equal(result.frames, 3); assert.deepEqual(result.evicted, []);
    assert.equal(current.stacks[0].disposed, false);
});

test('optional groups use newest-first priority and required groups are promoted to newest', () => {
    const a = group('a'), b = group('b'), c = group('c'), selected = group('selected');
    const result = planLocalWorkingSet([selected], [c, b, a], { maxStacks: 3 });
    assert.deepEqual(ids(result.groups), ['b', 'c', 'selected']);
    assert.deepEqual(ids(result.stacks), ['b', 'c', 'selected']); assert.deepEqual(ids(result.evicted), ['a']);
});

test('more than 128 successive opened groups evict old resident sources without limiting the catalog', () => {
    const catalog = Array.from({ length: 160 }, (_, index) => group(`series-${index}`));
    let resident = [];
    for (const selected of catalog) resident = planLocalWorkingSet([selected], [...resident].reverse()).groups;
    assert.equal(catalog.length, 160); assert.equal(resident.length, 128);
    assert.equal(resident[0].id, 'series-32'); assert.equal(resident.at(-1).id, 'series-159');
});

test('selected series with129 or419 logical image partitions fit independently of the128-series group cap', () => {
    for (const count of [129, 419]) {
        const selected = partitioned('one-series', count);
        const result = planLocalWorkingSet([selected]);
        assert.equal(result.groups.length, 1); assert.equal(result.stacks.length, count); assert.equal(result.frames, count);
        assert.equal(result.bytes, count); assert.deepEqual(result.evicted, []);
        assert.ok(selected.stacks.every(value => !value.disposed));
    }
    const comparison = planLocalWorkingSet([partitioned('current', 419), partitioned('prior', 283)]);
    assert.equal(comparison.groups.length, 2); assert.equal(comparison.stacks.length, 702); assert.equal(comparison.frames, 702);
});

test('the default1024 logical stack boundary admits exactly1024 and rejects1025 without disposing either source', () => {
    assert.equal(MAX_LOCAL_WORKING_STACKS, 1024);
    const boundary = partitioned('boundary', MAX_LOCAL_WORKING_STACKS), excessive = partitioned('excessive', MAX_LOCAL_WORKING_STACKS + 1);
    assert.equal(planLocalWorkingSet([boundary]).stacks.length, MAX_LOCAL_WORKING_STACKS);
    assert.throws(() => planLocalWorkingSet([excessive]), /128 series, 1,024 image stacks, 10,000 frames and 256 MiB/);
    assert.ok(boundary.stacks.every(value => !value.disposed)); assert.ok(excessive.stacks.every(value => !value.disposed));
    assert.throws(() => planLocalWorkingSet([partitioned('custom', 129)], [], { maxStacks: 128 }), /selected view/);
});

test('series-group bounds count unique valid catalog groups separately from shared image stack objects', () => {
    const shared = stack('shared'), groups = Array.from({ length: 129 }, (_, index) => ({ id: `series-${index}`, stacks: [shared] }));
    const result = planLocalWorkingSet(groups.slice(0, 128));
    assert.equal(result.groups.length, 128); assert.equal(result.stacks.length, 1); assert.equal(result.frames, 1);
    assert.throws(() => planLocalWorkingSet(groups), /128 series/);
    assert.equal(planLocalWorkingSet([groups[0], groups[0]], [], { maxGroups: 1 }).groups.length, 1);
    assert.throws(() => planLocalWorkingSet(groups.slice(0, 2), [], { maxGroups: 1 }), /selected view/);
    assert.equal(shared.disposed, false);
});

test('group-budget eviction removes an optional multi-partition series atomically and keeps required partitions', () => {
    const selected = partitioned('selected', 419), recent = partitioned('recent', 283), old = partitioned('old', 129);
    const result = planLocalWorkingSet([selected], [recent, old], { maxGroups: 2 });
    assert.deepEqual(ids(result.groups), ['recent', 'selected']); assert.equal(result.stacks.length, 702);
    assert.deepEqual(result.evicted, old.stacks); assert.ok(result.evicted.every(value => !value.disposed));
    assert.deepEqual(planLocalWorkingSet([], [old], { maxGroups: 0 }).evicted, old.stacks);
});

for (const [name, options, limits] of [
    ['stack', {}, { maxStacks: 2 }],
    ['frame', { frames: 3 }, { maxFrames: 6 }],
    ['encoded byte', { bytes: 3 }, { maxBytes: 6 }]
]) test(`${name} budget keeps the exact boundary and evicts the next inactive group`, () => {
    const current = group('current', options), recent = group('recent', options), old = group('old', options);
    const result = planLocalWorkingSet([current], [recent, old], limits);
    assert.deepEqual(ids(result.groups), ['recent', 'current']); assert.deepEqual(result.evicted, old.stacks);
    for (const value of [current, recent, old]) assert.equal(value.stacks[0].disposed, false);
});

test('required current and comparison groups displace inactive groups without evicting either selection', () => {
    const current = group('current', { bytes: 4 }), prior = group('prior', { bytes: 4 }), recent = group('recent', { bytes: 3 });
    const result = planLocalWorkingSet([current, prior], [recent], { maxBytes: 8 });
    assert.deepEqual(ids(result.groups), ['current', 'prior']); assert.equal(result.bytes, 8);
    assert.deepEqual(result.evicted, recent.stacks);
});

test('greedy admission skips an oversized recent group and can retain a smaller older group', () => {
    const current = group('current', { bytes: 4 }), recent = group('recent', { bytes: 8 }), old = group('old', { bytes: 2 });
    const result = planLocalWorkingSet([current], [recent, old], { maxBytes: 6 });
    assert.deepEqual(ids(result.groups), ['old', 'current']); assert.deepEqual(result.evicted, recent.stacks);
});

test('all stacks in a catalog group are retained or evicted together', () => {
    const current = group('current'), composite = { id: 'split-series', stacks: [stack('first'), stack('second')] };
    const result = planLocalWorkingSet([current], [composite], { maxStacks: 2 });
    assert.deepEqual(result.stacks, current.stacks); assert.deepEqual(result.evicted, composite.stacks);
});

for (const [name, current, limits] of [
    ['stack', { id: 'selected', stacks: [stack('a'), stack('b')] }, { maxStacks: 1 }],
    ['frame', group('selected', { frames: 4 }), { maxFrames: 3 }],
    ['encoded byte', group('selected', { bytes: 4 }), { maxBytes: 3 }]
]) test(`an oversized required ${name} footprint fails before mutation`, () => {
    assert.throws(() => planLocalWorkingSet([current], [], limits), /selected view.*budget.*smaller series/i);
    assert.equal(current.stacks.some(value => value.disposed), false);
});

test('default frame budget admits 10,000 frames exactly and rejects one more', () => {
    assert.equal(planLocalWorkingSet([group('boundary', { frames: 10000 })]).frames, 10000);
    assert.throws(() => planLocalWorkingSet([group('excess', { frames: 10001 })]), /selected view/);
});

test('default encoded budget admits 256 MiB exactly and rejects one more byte without allocating it', () => {
    assert.equal(planLocalWorkingSet([group('boundary', { bytes: 256 * 1024 * 1024 })]).bytes, 256 * 1024 * 1024);
    assert.throws(() => planLocalWorkingSet([group('excess', { bytes: 256 * 1024 * 1024 + 1 })]), /selected view/);
});

test('shared records count once independently of first-owner sourceBytes attribution', () => {
    const record = { bytes: new Uint8Array(12) }, first = stack('first', { bytes: 12, _records: new Map([['record', record]]) }),
        second = stack('second', { bytes: 0, _records: new Map([['record', record]]) });
    const retained = planLocalWorkingSet([{ id: 'second', stacks: [second] }], [], { maxBytes: 12 });
    assert.equal(retained.bytes, 12);
    assert.throws(() => planLocalWorkingSet([{ id: 'second', stacks: [second] }], [], { maxBytes: 11 }), /selected view/);
    assert.equal(planLocalWorkingSet([{ id: 'both', stacks: [first, second] }], [], { maxBytes: 12 }).bytes, 12);
});

test('different record views of the same buffer retain and count the whole backing allocation once', () => {
    const buffer = new ArrayBuffer(20), a = stack('a', { _records: new Map([['a', { bytes: new Uint8Array(buffer, 4, 4) }]]) }),
        b = stack('b', { _records: new Map([['b', { bytes: new DataView(buffer, 12, 2) }]]) });
    const result = planLocalWorkingSet([{ id: 'a', stacks: [a] }, { id: 'b', stacks: [b] }], [], { maxBytes: 20 });
    assert.equal(result.bytes, 20); assert.throws(() => planLocalWorkingSet(result.groups, [], { maxBytes: 19 }), /selected view/);
});

test('independent backing buffers count separately even when records reuse an identifier', () => {
    const a = stack('a', { _records: new Map([['same', { bytes: new Uint8Array(4) }]]) }),
        b = stack('b', { _records: new Map([['same', { bytes: new Uint8Array(4) }]]) });
    assert.equal(planLocalWorkingSet([{ id: 'both', stacks: [a, b] }]).bytes, 8);
});

test('SharedArrayBuffer-backed record views count the full shared allocation once', () => {
    const buffer = new SharedArrayBuffer(16), a = stack('a', { _records: new Map([['record', { bytes: new Uint8Array(buffer, 0, 4) }]]) }),
        b = stack('b', { _records: new Map([['record', { bytes: new Uint8Array(buffer, 8, 4) }]]) });
    assert.equal(planLocalWorkingSet([{ id: 'both', stacks: [a, b] }]).bytes, 16);
});

test('overlapping groups deduplicate stack frames and allocations and never evict a shared survivor', () => {
    const shared = stack('shared', { bytes: 5, frames: 3 }), oldOnly = stack('old-only');
    const result = planLocalWorkingSet([{ id: 'selected', stacks: [shared] }],
        [{ id: 'old', stacks: [shared, oldOnly] }], { maxStacks: 1, maxFrames: 3, maxBytes: 5 });
    assert.equal(result.frames, 3); assert.equal(result.bytes, 5); assert.deepEqual(result.evicted, [oldOnly]);
});

test('identical required groups are deduplicated while conflicting required revisions are rejected', () => {
    const current = group('current'), same = { id: current.id, stacks: [...current.stacks] };
    assert.equal(planLocalWorkingSet([current, same]).groups.length, 1);
    assert.throws(() => planLocalWorkingSet([current, group('current')]), /one available revision/);
});

test('required revision wins over a stale optional group with the same catalog identifier', () => {
    const selected = group('same'), old = group('same');
    const result = planLocalWorkingSet([selected], [old]);
    assert.deepEqual(result.groups, [selected]); assert.deepEqual(result.evicted, old.stacks);
});

test('duplicate optional identifiers use their first newest revision and evict older stale stacks', () => {
    const newest = group('same'), old = group('same');
    const result = planLocalWorkingSet([], [newest, old]);
    assert.deepEqual(result.groups, [newest]); assert.deepEqual(result.evicted, old.stacks);
});

test('disposed or empty optional groups are excluded atomically and required groups fail clearly', () => {
    const disposed = group('disposed'); disposed.stacks[0].disposed = true;
    const empty = group('empty', { frames: 0 });
    assert.deepEqual(planLocalWorkingSet([], [disposed, empty]).groups, []);
    for (const value of [disposed, empty]) assert.throws(() => planLocalWorkingSet([value]), /no longer available/);
});

test('empty selections retain a bounded optional cache and empty input has a zero footprint', () => {
    const a = group('a'), b = group('b');
    assert.deepEqual(ids(planLocalWorkingSet([], [b, a], { maxStacks: 1 }).groups), ['b']);
    assert.deepEqual(planLocalWorkingSet([], []), { groups: [], stacks: [], bytes: 0, frames: 0, evicted: [] });
    assert.deepEqual(planLocalWorkingSet([], [a], { maxStacks: 0 }).groups, []);
});

test('malformed source accounting and unsafe sums are refused rather than silently undercounted', () => {
    for (const bytes of [undefined, -1, 1.5, NaN, Infinity, '10', Number.MAX_SAFE_INTEGER + 1]) {
        const invalid = group('invalid'); invalid.stacks[0].sourceBytes = bytes;
        assert.throws(() => planLocalWorkingSet([invalid]), /safe integers/);
    }
    assert.throws(() => planLocalWorkingSet([{ id: 'invalid', stacks: [stack('invalid', { _records: new Map([['bad', { bytes: null }]]) })] }]), /encoded bytes/);
    assert.throws(() => planLocalWorkingSet([group('a', { bytes: Number.MAX_SAFE_INTEGER }), group('b')]), /safe integer accounting/);
});

test('invalid groups and unsupported limits are rejected before producing a partial plan', () => {
    for (const groups of [null, {}, [null], [{ id: '', stacks: [] }], [{ id: 'a', stacks: [] }], [{ id: 'a', stacks: [{}] }]]) {
        assert.throws(() => planLocalWorkingSet(groups), TypeError);
    }
    for (const limits of [null, [], { maxBytes: Infinity }, { maxFrames: -1 }, { maxStacks: 0.5 }, { maxGroups: -1 },
        { maxGroups: 0.5 }, { maxGroups: 129 }, { maxStacks: 1025 }, { maxFrames: 10001 }, { maxBytes: 256 * 1024 * 1024 + 1 }, { unexpected: 2 }]) {
        assert.throws(() => planLocalWorkingSet([], [], limits), TypeError);
    }
});

test('419 real EASI partitions share one bounded workspace decoder/cache and decode only deliberately requested images', async () => {
    const files = Array.from({ length: 419 }, (_, index) => new File([createDicomFixture({ rows: 2, columns: 2,
        sopUid: `2.25.9951.${index + 1}`, seriesUid: '2.25.9951', instanceNumber: index + 1,
        values: [index, index + 1, index + 2, index + 3],
        extraAttributes: { '0020000D': ['UI', '2.25.9950'], '00200012': ['IS', index + 1] } })], 'GENERATED'));
    const sources = await loadFiles(files), workspace = new WorkspaceModel(), leases = new Map(); let decoded = 0;
    try {
        assert.equal(sources.length, 419);
        for (const source of sources) {
            const getFrame = source.getFrame.bind(source);
            source.getFrame = (...args) => { decoded++; return getFrame(...args); };
            leases.set(source, workspace.registerSource([source], { owned: false }));
        }
        const plan = planLocalWorkingSet([{ id: 'one-catalog-series', stacks: sources }]);
        assert.equal(plan.groups.length, 1); assert.equal(plan.stacks.length, 419); assert.equal(plan.frames, 419); assert.equal(plan.bytes, 419 * 8);
        assert.equal(decoded, 0); assert.equal(workspace.cache.bytes, 0); assert.equal(workspace.cache.budget, 64 * 1024 * 1024);
        assert.equal(workspace.decoderScopes.size, 1); assert.equal(workspace.scopes.size, 1); assert.equal(workspace.slots.length, 1);
        for (const index of [128, 418]) {
            const frame = await workspace.request(sources[index], 0, new AbortController().signal);
            assert.deepEqual([...frame.samples], [index, index + 1, index + 2, index + 3]);
        }
        assert.equal(decoded, 2); assert.equal(workspace.cache.bytes, 16); assert.equal(workspace.cache.budget, 64 * 1024 * 1024);
    } finally {
        for (const source of sources) { workspace.releaseSource(leases.get(source)); source.dispose(); }
        workspace.dispose();
    }
    assert.equal(workspace.cache.bytes, 0); assert.equal(sources.every(source => source.disposed), true);
});

test('evicting real EASI-loaded enhanced partitions releases leases while the selected partition stays decodable', async () => {
    const sources = await loadFiles([fixtureFile(createEnhancedDicom())]), workspace = new WorkspaceModel();
    const leases = new Map(sources.map(source => [source, workspace.registerSource([source], { owned: false })]));
    try {
        const selected = sources.at(-1), record = [...selected._records.values()][0];
        assert.equal(selected.sourceBytes, 0);
        const result = planLocalWorkingSet([{ id: 'selected', stacks: [selected] }],
            sources.slice(0, -1).map((source, index) => ({ id: `inactive-${index}`, stacks: [source] })), { maxStacks: 1, maxBytes: 64 });
        assert.equal(result.bytes, 64); assert.equal(result.evicted.length, sources.length - 1);
        for (const source of result.evicted) { workspace.releaseSource(leases.get(source)); source.dispose(); }
        assert.equal(record.bytes.byteLength, 64); assert.equal(selected.sourceBytes, 64);
        const frame = await workspace.request(selected, 1, new AbortController().signal);
        assert.deepEqual([...frame.samples], pixels[frame.frameIndex]);
        assert.equal(workspace.seriesOwners.has(selected), true);
        assert.equal(result.evicted.every(source => !workspace.seriesOwners.has(source) && source.disposed), true);
    } finally {
        for (const source of sources) { workspace.releaseSource(leases.get(source)); source.dispose(); }
        workspace.dispose();
    }
});
