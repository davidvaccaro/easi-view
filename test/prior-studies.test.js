import test from 'node:test';
import assert from 'node:assert/strict';
import { findPriorCandidates } from '../src/data/prior-studies.js';

const context = { patientId: 'SYNTHETIC-ID', currentStudyUid: '2.25.860.10', currentStudyDate: '20261014' };
const item = (index, date = '20260101', values = {}) => ({ studyUid: `2.25.860.${index}`, patientId: context.patientId,
    patientName: 'Never copied into candidates', studyDate: date, description: 'Generated study', accessionNumber: 'Not copied',
    modalities: ['CT'], seriesCount: 2, instanceCount: 20, ...values });
function client(pages) {
    const requests = []; return { requests, async searchStudies(filters, options) {
        requests.push({ filters, ...options }); return pages[requests.length - 1];
    }, retrieveInstance() { throw new Error('Prior lookup must never retrieve pixels.'); } };
}

test('explicit prior search matches exact archive patient ID, older dates and optional modality without pixel requests or patient names in its result', async () => {
    const archive = client([{ items: [item(1, '20260201'), item(2, '20250101'), item(10), item(3, '20270101'),
        item(4, '20261014'), item(5, '20250101', { patientId: 'ANOTHER-ID' }), item(6, '20250501', { modalities: ['MR'] })], hasMore: false }]);
    const result = await findPriorCandidates(archive, { ...context, modality: 'CT' }, { limit: 25 });
    assert.deepEqual(result.items.map(value => value.studyUid), ['2.25.860.1', '2.25.860.2']);
    assert.deepEqual(archive.requests[0].filters, { patientId: context.patientId, studyDate: '-20261014', modality: 'CT' });
    assert.equal(result.truncated, false); assert.equal(result.pages, 1); assert.equal(result.nextOffset, null);
    assert.match(result.warnings[0], /Confirm patient identity/);
    assert.ok(!/patientId|patientName|accessionNumber/.test(JSON.stringify(result)));
});

test('bounded pages de-duplicate studies, sort independent complete dates and expose truncation without automatically loading another page', async () => {
    const archive = client([{ items: [item(1), item(2, '20260201')], hasMore: true, nextOffset: 2 },
        { items: [item(1), item(3, '20260301')], hasMore: true, nextOffset: 4 }]);
    const result = await findPriorCandidates(archive, context, { limit: 2, maxPages: 2 });
    assert.deepEqual(result.items.map(value => value.studyUid), ['2.25.860.3', '2.25.860.2', '2.25.860.1']);
    assert.equal(result.pages, 2); assert.equal(result.truncated, true); assert.equal(result.nextOffset, 4);
    assert.deepEqual(archive.requests.map(request => request.offset), [0, 2]);
    assert.ok(result.warnings.some(value => /bounded candidate/.test(value)));
});

test('incomplete or invalid dates are excluded without being mistaken for a prior study, including Gregorian leap boundaries', async () => {
    const archive = client([{ items: [item(1, ''), item(2, '20250229'), item(3, '20240229'), item(4, '20251301'), item(5, '00000101')], hasMore: false }]);
    const result = await findPriorCandidates(archive, context);
    assert.deepEqual(result.items.map(value => value.studyUid), ['2.25.860.3']); assert.ok(result.warnings.some(value => /valid date/.test(value)));
    const old = client([{ items: [item(1, '00990228')], hasMore: false }]);
    assert.equal((await findPriorCandidates(old, { ...context, currentStudyDate: '01000301' })).items.length, 1);
});

test('strict context and bounded request options fail before any archive request', async () => {
    const archive = client([]);
    for (const changed of [{ patientId: '' }, { patientId: 'SYN*' }, { patientId: 'SYN?' }, { patientId: 'ID\\OTHER' },
        { patientId: 'ID\n' }, { currentStudyUid: 'not-a-uid' }, { currentStudyDate: '20250229' }, { currentStudyDate: '202610' },
        { modality: 'ct' }, { modality: 'MR&x=y' }, { unknown: true }]) await assert.rejects(findPriorCandidates(archive, { ...context, ...changed }), TypeError);
    for (const options of [{ limit: 26 }, { limit: 0 }, { maxPages: 5 }, { maxPages: 0 }, { signal: {} }, { headers: {} }]) {
        await assert.rejects(findPriorCandidates(archive, context, options), TypeError);
    }
    await assert.rejects(findPriorCandidates(archive, { ...context, get modality() { throw new Error('A getter must not execute.'); } }), TypeError);
    assert.equal(archive.requests.length, 0);
});

test('cancellation before or during metadata search stops paging and returns a fixed AbortError', async () => {
    const controller = new AbortController(); controller.abort(); const unused = client([]);
    await assert.rejects(findPriorCandidates(unused, context, { signal: controller.signal }), { name: 'AbortError' }); assert.equal(unused.requests.length, 0);
    const active = new AbortController(), archive = { async searchStudies() { active.abort(); return { items: [item(1)], hasMore: true, nextOffset: 1 }; } };
    await assert.rejects(findPriorCandidates(archive, context, { signal: active.signal }), { name: 'AbortError' });
});

test('invalid peer pagination/schema and provider failures expose no response bodies, identifiers, or credential context', async () => {
    for (const page of [{ items: [item(1)], hasMore: true, nextOffset: 0 }, { items: [item(1)], hasMore: 'yes' },
        { items: [item(1), item(2)], hasMore: false }, { items: [item(1, '20260101', { studyUid: 'secret-invalid' })], hasMore: false },
        { items: [item(1, '20260101', { seriesCount: { token: 'private' } })], hasMore: false }]) {
        await assert.rejects(findPriorCandidates(client([page]), context, { limit: 1 }), error => !/secret|token|private|SYNTHETIC|2\.25/.test(error.message));
    }
    await assert.rejects(findPriorCandidates({ searchStudies() { throw new Error('token=private https://secret.invalid?patient=example'); } }, context), error => !/token|private|secret|https/.test(error.message));
});

test('returned arrays/records are detached from archive metadata and cannot mutate a subsequent candidate page', async () => {
    const original = item(1), archive = client([{ items: [original], hasMore: false }]);
    const result = await findPriorCandidates(archive, context); result.items[0].modalities.push('MR'); result.items[0].description = 'changed';
    assert.deepEqual(original.modalities, ['CT']); assert.equal(original.description, 'Generated study');
});
