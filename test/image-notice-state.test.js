import test from 'node:test';
import assert from 'node:assert/strict';
import ImageNoticeState, { MAX_NOTICE_SCOPES, MAX_NOTICE_WARNINGS, MAX_NOTICE_CHARS } from '../src/ui/ImageNoticeState.js';

const A = 'Legacy fragment padding was ignored.', B = 'JPEG precision follows the verified codestream.';
const G = 'Image orientation is unavailable.', T = 'Recorded frame timing is unavailable.';
const input = (overrides = {}) => ({ series: {}, scope: 'session-study-1', calibrated: true,
    geometryWarnings: [], timingWarnings: [], encodingWarnings: [], ...overrides });

test('encoding acknowledgements follow individual warnings, not a changing image warning combination', () => {
    const notices = new ImageNoticeState(), first = input({ encodingWarnings: [A] });
    assert.deepEqual(notices.get(first).visibleMessages, [A]);
    assert.deepEqual(notices.dismiss(first).visibleMessages, []);
    const both = input({ encodingWarnings: [A, B] });
    assert.deepEqual(notices.get(both).visibleMessages, [B]);
    assert.equal(notices.get(both).hasDismissed, true);
    notices.dismiss(both);
    for (const encodingWarnings of [[A], [B], [A, B], [B, A], [A, A, B]]) {
        assert.deepEqual(notices.get(input({ encodingWarnings })).visibleMessages, []);
    }
    assert.deepEqual(notices.get(both).messages, [A, B]);
});

test('new study and source-scoped admitted study tokens remain independent', () => {
    const notices = new ImageNoticeState(), first = input({ encodingWarnings: [A] });
    notices.dismiss(first);
    assert.deepEqual(notices.get(input({ scope: 'session-study-2', encodingWarnings: [A] })).visibleMessages, [A]);
    assert.deepEqual(notices.get(input({ scope: 'source-b-study-1', encodingWarnings: [A] })).visibleMessages, [A]);
    assert.deepEqual(notices.get(input({ encodingWarnings: [A] })).visibleMessages, []);
});

test('technical acknowledgement matches the exact geometry/timing combination and calibration', () => {
    const notices = new ImageNoticeState(), series = {};
    const first = input({ series, geometryWarnings: [G], timingWarnings: [T], encodingWarnings: [A] });
    notices.dismiss(first);
    assert.deepEqual(notices.get({ ...first, encodingWarnings: [A, B] }).visibleMessages, [B]);
    assert.deepEqual(notices.get({ ...first, calibrated: false }).visibleMessages, [G, T]);
    assert.deepEqual(notices.get({ ...first, geometryWarnings: [G, 'Unverified slice spacing.'] }).visibleMessages,
        [G, 'Unverified slice spacing.', T]);
    assert.deepEqual(notices.get({ ...first, timingWarnings: [] }).visibleMessages, [G]);
    assert.deepEqual(notices.get({ ...first, geometryWarnings: [T], timingWarnings: [G] }).visibleMessages, [T, G]);
    assert.deepEqual(notices.get({ ...first, series: {} }).visibleMessages, [G, T]);
});

test('technical keys are stable under ordering and duplication while encoding stays outside the key', () => {
    const notices = new ImageNoticeState(), series = {};
    const first = input({ series, geometryWarnings: [G, 'Missing patient position.'], timingWarnings: [T] });
    notices.dismiss(first);
    assert.deepEqual(notices.get({ ...first, geometryWarnings: ['Missing patient position.', G, G],
        encodingWarnings: [B] }).visibleMessages, [B]);
    notices.dismiss({ ...first, timingWarnings: [] });
    assert.deepEqual(notices.get(first).visibleMessages, []);
    assert.deepEqual(notices.get({ ...first, timingWarnings: [] }).visibleMessages, []);
});

test('show clears only current image acknowledgements and retains other warning and study contexts', () => {
    const notices = new ImageNoticeState(), series = {};
    const both = input({ series, geometryWarnings: [G], timingWarnings: [T], encodingWarnings: [A, B] });
    notices.dismiss(both);
    notices.dismiss({ ...both, timingWarnings: [], encodingWarnings: [] });
    notices.dismiss(input({ scope: 'session-study-2', encodingWarnings: [A, B] }));
    const current = { ...both, encodingWarnings: [A] };
    assert.deepEqual(notices.show(current).visibleMessages, [G, T, A]);
    assert.equal(notices.get(current).hasDismissed, false);
    assert.deepEqual(notices.get({ ...both, timingWarnings: [], encodingWarnings: [B] }).visibleMessages, []);
    assert.deepEqual(notices.get(input({ scope: 'session-study-2', encodingWarnings: [A, B] })).visibleMessages, []);
});

test('technical reset retains encoding acknowledgements and full reset removes both', () => {
    const notices = new ImageNoticeState(), current = input({ geometryWarnings: [G], encodingWarnings: [A] });
    notices.dismiss(current); notices.clearTechnical();
    assert.deepEqual(notices.get(current).visibleMessages, [G]);
    assert.equal(notices.get(current).hasDismissed, true);
    notices.dismiss(current); notices.clear();
    assert.deepEqual(notices.get(current).visibleMessages, [G, A]);
    assert.equal(notices.get(current).hasDismissed, false);
});

test('forgetting deleted study scopes keeps unrelated acknowledgements intact', () => {
    const notices = new ImageNoticeState(), first = input({ encodingWarnings: [A] });
    const other = input({ scope: 'session-study-2', encodingWarnings: [B] });
    notices.dismiss(first); notices.dismiss(other);
    notices.forgetScopes(new Set([first.scope, null, 1]));
    assert.deepEqual(notices.get(first).visibleMessages, [A]);
    assert.deepEqual(notices.get(other).visibleMessages, []);
    assert.doesNotThrow(() => notices.forgetScopes(null));
    assert.doesNotThrow(() => notices.forgetScopes(first.scope));
});

test('scope LRU is bounded and getters do not create unseen acknowledgement contexts', () => {
    const notices = new ImageNoticeState({ maxScopes: 2 });
    const first = input({ scope: 'study-a', encodingWarnings: [A] });
    const second = input({ scope: 'study-b', encodingWarnings: [B] });
    notices.dismiss(first); notices.dismiss(second);
    for (let index = 0; index < 300; index++) notices.get(input({ scope: `unseen-study-${index}`, encodingWarnings: [A] }));
    assert.deepEqual(notices.get(first).visibleMessages, []);
    notices.dismiss(input({ scope: 'study-c', encodingWarnings: [A] }));
    assert.deepEqual(notices.get(first).visibleMessages, []);
    assert.deepEqual(notices.get(second).visibleMessages, [B]);
    notices.show(input({ scope: 'never-dismissed', encodingWarnings: [A] }));
    assert.deepEqual(notices.get(first).visibleMessages, []);
});

test('encoding warning retention is bounded within each context', () => {
    const notices = new ImageNoticeState({ maxWarnings: 2 }), first = input({ encodingWarnings: [A, B] });
    notices.dismiss(first);
    const extra = 'One additional warning.';
    notices.dismiss({ ...first, encodingWarnings: [extra] });
    assert.deepEqual(notices.get({ ...first, encodingWarnings: [A, B, extra] }).visibleMessages, [A]);
});

test('default scope and warning caps evict excess acknowledgement state', () => {
    const notices = new ImageNoticeState();
    for (let index = 0; index <= MAX_NOTICE_SCOPES; index++) notices.dismiss(input({ scope: `study-${index}`, encodingWarnings: [A] }));
    assert.deepEqual(notices.get(input({ scope: 'study-0', encodingWarnings: [A] })).visibleMessages, [A]);
    assert.deepEqual(notices.get(input({ scope: `study-${MAX_NOTICE_SCOPES}`, encodingWarnings: [A] })).visibleMessages, []);
    const many = Array.from({ length: MAX_NOTICE_WARNINGS + 1 }, (_, index) => `Warning ${index}.`);
    notices.dismiss(input({ encodingWarnings: many }));
    assert.deepEqual(notices.get(input({ encodingWarnings: many })).visibleMessages, [many[0]]);
});

test('legacy fallback acknowledgement belongs weakly to the actual series object', () => {
    const notices = new ImageNoticeState(), series = {};
    const legacy = input({ scope: null, series, encodingWarnings: [A] });
    notices.dismiss(legacy);
    assert.deepEqual(notices.get(legacy).visibleMessages, []);
    assert.deepEqual(notices.get({ ...legacy, series: {} }).visibleMessages, [A]);
    assert.deepEqual(notices.get({ ...legacy, scope: 'session-study-1' }).visibleMessages, [A]);
    notices.clearTechnical();
    assert.deepEqual(notices.get(legacy).visibleMessages, []);
    notices.show(legacy);
    assert.deepEqual(notices.get(legacy).visibleMessages, [A]);
});

test('invalid scope values fall back to series ownership rather than retaining raw identifiers or paths', () => {
    const notices = new ImageNoticeState(), invalidScopes = [null, '', 23, {}, '2.25.123', '/private/study',
        'https://archive.invalid/studies/2.25.123', 'patient name', 'x'.repeat(257)];
    for (const scope of invalidScopes) {
        const current = input({ scope, encodingWarnings: [A] });
        notices.dismiss(current);
        assert.deepEqual(notices.get(current).visibleMessages, []);
        assert.deepEqual(notices.get({ ...current, series: {} }).visibleMessages, [A]);
    }
    assert.deepEqual(notices.dismiss(input({ scope: null, series: null, encodingWarnings: [A] })).visibleMessages, [A]);
});

test('oversized and invalid warning strings remain visible but cannot acquire acknowledgement state', () => {
    const notices = new ImageNoticeState(), oversized = 'x'.repeat(MAX_NOTICE_CHARS + 1), control = 'Warning\u0000with control';
    const current = input({ geometryWarnings: [G, oversized], timingWarnings: [null, {}, 2, '', ' '],
        encodingWarnings: [A, oversized, control, null, 3, {}, ''] });
    const dismissed = notices.dismiss(current);
    assert.deepEqual(dismissed.messages, [G, oversized, A, control]);
    assert.deepEqual(dismissed.geometryWarnings, [G, oversized]);
    assert.deepEqual(dismissed.encodingWarnings, [oversized, control]);
    assert.deepEqual(dismissed.timingWarnings, []);
    assert.equal(dismissed.hasDismissed, true);
    assert.deepEqual(notices.show(current).visibleMessages, [G, oversized, A, control]);
});

test('maximum-length valid notices are retained without truncating their display text', () => {
    const notices = new ImageNoticeState(), value = 'x'.repeat(MAX_NOTICE_CHARS);
    const current = input({ geometryWarnings: [value], encodingWarnings: [value] });
    assert.deepEqual(notices.get(current).messages, [value]);
    assert.deepEqual(notices.dismiss(current).visibleMessages, []);
    assert.deepEqual(notices.show(current).visibleMessages, [value]);
});

test('an excessive technical combination remains visible instead of recording a partial acknowledgement', () => {
    const notices = new ImageNoticeState({ maxWarnings: 2 }), current = input({ geometryWarnings: [G, 'Missing position.'], timingWarnings: [T] });
    assert.deepEqual(notices.dismiss(current).visibleMessages, [G, 'Missing position.', T]);
    assert.equal(notices.get(current).hasDismissed, false);
    notices.dismiss({ ...current, timingWarnings: [] });
    assert.deepEqual(notices.get({ ...current, timingWarnings: [] }).visibleMessages, []);
    assert.deepEqual(notices.get(current).visibleMessages, [G, 'Missing position.', T]);
});

test('technical combinations are bounded and empty warning lists never dismiss calibration by themselves', () => {
    const notices = new ImageNoticeState(), series = {};
    notices.dismiss(input({ series }));
    assert.equal(notices.get(input({ series })).hasDismissed, false);
    for (let index = 0; index <= MAX_NOTICE_WARNINGS; index++) notices.dismiss(input({ series, geometryWarnings: [`Geometry ${index}.`] }));
    assert.deepEqual(notices.get(input({ series, geometryWarnings: ['Geometry 0.'] })).visibleMessages, ['Geometry 0.']);
    assert.deepEqual(notices.get(input({ series, geometryWarnings: [`Geometry ${MAX_NOTICE_WARNINGS}.`] })).visibleMessages, []);
});

test('helper instances, caller arrays and returned arrays do not share acknowledgement ownership', () => {
    const first = new ImageNoticeState(), second = new ImageNoticeState();
    const current = input({ geometryWarnings: [G], encodingWarnings: [A] });
    first.dismiss(current);
    current.encodingWarnings.push(B);
    assert.deepEqual(first.get(current).visibleMessages, [B]);
    assert.deepEqual(second.get(current).visibleMessages, [G, A, B]);
    const view = first.get(current); view.messages.push('Invented display message.'); view.encodingWarnings.length = 0;
    assert.deepEqual(first.get(current).messages, [G, A, B]);
    assert.deepEqual(first.get(current).visibleMessages, [B]);
});

test('resource limit options reject unbounded or invalid values', () => {
    for (const options of [{ maxScopes: 0 }, { maxScopes: 257 }, { maxWarnings: 0 }, { maxWarnings: 129 },
        { maxScopes: Infinity }, { maxWarnings: 1.5 }]) assert.throws(() => new ImageNoticeState(options), /bounded/iu);
});
