import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStudyContext, referenceWithinScope, exportStudyContext, selectContextFrame } from '../src/integration/study-context.js';
import { CONTEXT_BYTES } from '../src/enterprise/contracts.js';

const archiveKey = 'synthetic-archive';
const archiveClient = Object.freeze({ marker: 'opaque-local-client', baseUrl: 'https://private.invalid/archive/' });
const reference = { archiveKey, studyUid: '2.25.870', seriesUid: '2.25.871', sopUid: '2.25.872' };
const view = (patch = {}) => ({ slot: 0, reference: { ...reference }, frameIndex: 17, originalFrameNumber: 6, window: { center: 40, width: 400 }, ...patch });
const context = (patch = {}) => ({ version: 1, layout: 1, activeViewport: 0, viewports: [view()], ...patch });
const frame = (sopUid, frameIndex, extra = {}) => ({ sopUid, frameIndex, photometric: 'MONOCHROME2', samples: Uint16Array.of(99), patientName: 'SYNTHETIC-NEVER-EXPORTED', ...extra });
const stack = (frames, patch = {}) => ({ studyUid: reference.studyUid, seriesUid: reference.seriesUid, frames, ...patch });
const pane = (slot, series, selectedFrame, renderedIndex = 0, patch = {}) => ({ slot,
    view: { currentSeries: series, frame: selectedFrame, renderedIndex, ...patch }, viewport: { state: { center: 40, width: 400, pan: [1, 2], patientName: 'SYNTHETIC-PRIVATE' } } });

test('context normalization detaches a strict version1 durable original-frame reference from logical navigation hints', () => {
    const input = context(), result = normalizeStudyContext(input, { archiveKey });
    assert.deepEqual(result, input); assert.notEqual(result, input); assert.notEqual(result.viewports[0].reference, input.viewports[0].reference);
    result.viewports[0].reference.sopUid = '2.25.999'; result.viewports[0].window.center = 9;
    assert.equal(input.viewports[0].reference.sopUid, reference.sopUid); assert.equal(input.viewports[0].window.center, 40);
    assert.equal(normalizeStudyContext(JSON.parse(JSON.stringify(input)), { archiveKey }).viewports[0].originalFrameNumber, 6);
});
test('verified archive, Study, Series and SOP scopes constrain every pane without accepting addresses', () => {
    assert.equal(referenceWithinScope(reference, { archiveKey, studyUid: reference.studyUid }), true);
    assert.equal(referenceWithinScope(reference, { archiveKey, studyUid: reference.studyUid, seriesUid: reference.seriesUid }), true);
    assert.equal(referenceWithinScope(reference, reference), true);
    for (const patch of [{ archiveKey: 'foreign-archive' }, { studyUid: '2.25.880' }, { seriesUid: '2.25.881' }, { sopUid: '2.25.882' }]) {
        assert.equal(referenceWithinScope({ ...reference, ...patch }, reference), false);
        assert.throws(() => normalizeStudyContext(context({ layout: 2, viewports: [view(), view({ slot: 1, reference: { ...reference, ...patch } })] }), { archiveKey, scope: reference }), /outside/);
    }
    for (const address of ['https://example.invalid/archive', 'http://localhost:8042/', '../archive', 'archive?token=secret']) {
        assert.throws(() => normalizeStudyContext(context({ viewports: [view({ reference: { ...reference, archiveKey: address } })] }), { archiveKey }), TypeError);
    }
});
test('enhanced groups select exact SOP plus one-based original frame independent of reordered/logical stack indices', () => {
    const early = stack([frame(reference.sopUid, 0), frame(reference.sopUid, 2), frame(reference.sopUid, 4)]);
    const late = stack([frame(reference.sopUid, 7), frame(reference.sopUid, 5), frame(reference.sopUid, 3)]);
    const foreignStudy = stack([frame(reference.sopUid, 5)], { studyUid: '2.25.900' }), foreignSeries = stack([frame(reference.sopUid, 5)], { seriesUid: '2.25.901' });
    const result = selectContextFrame([foreignStudy, early, foreignSeries, late], view());
    assert.equal(result.series, late); assert.equal(result.index, 1); assert.equal(result.series.frames[result.index].frameIndex, 5);
    const withoutHint = selectContextFrame([late, early], view({ frameIndex: 0, originalFrameNumber: 6 })); assert.equal(withoutHint.series, late); assert.equal(withoutHint.index, 1);
});
test('ambiguous enhanced SOP hints reject without durable original frame; duplicates and absent original targets reject', () => {
    const a = stack([frame(reference.sopUid, 0)]), b = stack([frame(reference.sopUid, 1)]);
    assert.throws(() => selectContextFrame([a, b], view({ frameIndex: 0, originalFrameNumber: undefined })), /original frame number/);
    assert.throws(() => selectContextFrame([a, stack([frame(reference.sopUid, 0)])], view({ frameIndex: 9, originalFrameNumber: 1 })), /ambiguous/);
    assert.throws(() => selectContextFrame([a, b], view({ originalFrameNumber: 6 })), /absent/);
    assert.throws(() => selectContextFrame([a], view({ reference: { ...reference, studyUid: '2.25.899' } })), /absent/);
    const exact = selectContextFrame([a, b], view({ frameIndex: 0, originalFrameNumber: 2 })); assert.equal(exact.series, b); assert.equal(exact.index, 0);
});
test('single unpartitioned stack supports a legacy logical hint without changing an exact requested SOP', () => {
    const series = stack([frame('2.25.873', 0), frame(reference.sopUid, 0)]);
    assert.equal(selectContextFrame([series], view({ frameIndex: 1, originalFrameNumber: undefined })).index, 1);
    assert.throws(() => selectContextFrame([series], view({ frameIndex: 0, originalFrameNumber: undefined })), /original frame number/);
    assert.throws(() => selectContextFrame([], view()), /compatible stacks/);
});
test('explicit export includes archive references/original frame/window only, skips local pixels/URLs, and redirects an active local pane', () => {
    const archive = stack([frame(reference.sopUid, 5)], { description: 'SYNTHETIC-PATIENT-LIKE-NAME', url: 'https://private.invalid/pixels' }), local = stack([frame('2.25.990', 0)]);
    const color = frame('2.25.874', 11, { photometric: 'RGB', samples: Uint8Array.of(1, 2, 3) });
    const panes = [pane(0, local, local.frames[0], 0, { file: new Blob(['synthetic']) }), pane(1, archive, archive.frames[0], 17), pane(2, archive, color, 9), pane(3, null, null)];
    const calls = []; const output = exportStudyContext(panes, { archiveKey, archiveClient, activeViewport: 0, getOrigin: source => { calls.push(source); return { sourceType: source === local ? 'files' : 'archive', archiveClient, baseUrl: 'https://private.invalid/dicom-web/', credentials: 'private-test-only' }; } });
    assert.deepEqual(output, { version: 1, layout: 4, activeViewport: 1, viewports: [
        { slot: 1, reference: { ...reference }, frameIndex: 17, originalFrameNumber: 6, window: { center: 40, width: 400 } },
        { slot: 2, reference: { ...reference, sopUid: '2.25.874' }, frameIndex: 9, originalFrameNumber: 12 }
    ] });
    assert.deepEqual(calls, [local, archive, archive]);
    assert.ok(!/patient|private|pixels|samples|url|baseUrl|Blob|file|credentials|description|pan/iu.test(JSON.stringify(output)));
    const preserved = exportStudyContext(panes, { archiveKey, archiveClient, activeViewport: 2, getOrigin: source => ({ sourceType: source === local ? 'files' : 'archive', archiveClient }) }); assert.equal(preserved.activeViewport, 2);
});
test('file, URL, demo and unrendered panes cannot produce an archive export', () => {
    const source = stack([frame(reference.sopUid, 0)]);
    for (const sourceType of ['files', 'url', 'demo', undefined]) assert.throws(() => exportStudyContext([pane(0, source, source.frames[0])], { archiveKey, archiveClient, activeViewport: 0, getOrigin: () => ({ sourceType, archiveClient }) }), /archive image/);
    assert.throws(() => exportStudyContext([pane(0, source, null)], { archiveKey, archiveClient, activeViewport: 0, getOrigin: () => ({ sourceType: 'archive', archiveClient }) }), /archive image/);
});
test('export requires the exact configured opaque archive client and cannot relabel a foreign source', () => {
    const source = stack([frame(reference.sopUid, 0)]), foreign = Object.freeze({ marker: 'other-client' });
    const available = [pane(0, source, source.frames[0])];
    for (const origin of [{ sourceType: 'archive' }, { sourceType: 'archive', archiveClient: foreign }]) {
        assert.throws(() => exportStudyContext(available, { archiveKey, archiveClient, activeViewport: 0, getOrigin: () => origin }), /configured archive|client/);
    }
    assert.throws(() => exportStudyContext([pane(0, { ...source, _session: { client: foreign } }, source.frames[0])], { archiveKey, archiveClient, activeViewport: 0,
        getOrigin: () => ({ sourceType: 'archive', archiveClient }) }), /configured archive|client/);
    assert.throws(() => exportStudyContext(available, { archiveKey, activeViewport: 0, getOrigin: () => ({ sourceType: 'archive', archiveClient }) }), /archive|client/);
    const failure = new Error('Host origin lookup rejected.'); assert.throws(() => exportStudyContext(available, { archiveKey, archiveClient, activeViewport: 0, getOrigin() { throw failure; } }), error => error === failure);
    const exported = exportStudyContext([pane(0, { ...source, _session: { client: archiveClient } }, source.frames[0])], { archiveKey, archiveClient, activeViewport: 0,
        getOrigin: () => ({ sourceType: 'archive', archiveClient }) });
    assert.equal(exported.viewports[0].reference.archiveKey, archiveKey); assert.ok(!/archiveClient|opaque-local-client|private.invalid|_session/.test(JSON.stringify(exported)));
});
test('schema cardinality, original numbering, windows and non-data properties fail before valid normalized output', () => {
    for (const patch of [{ version: 2 }, { layout: 3 }, { activeViewport: 1 }, { viewports: [] }, { pixelData: [1] }, { url: 'https://private.invalid' }, { patientName: 'SYNTHETIC' }]) {
        assert.throws(() => normalizeStudyContext(context(patch), { archiveKey }));
    }
    for (const originalFrameNumber of [0, -1, 4097, 1.5, NaN]) assert.throws(() => normalizeStudyContext(context({ viewports: [view({ originalFrameNumber })] }), { archiveKey }), TypeError);
    assert.throws(() => normalizeStudyContext(context({ viewports: [view({ reference: { archiveKey, studyUid: reference.studyUid, seriesUid: reference.seriesUid } })] }), { archiveKey }), /exact SOP/);
    assert.throws(() => normalizeStudyContext(context({ layout: 2, viewports: [view(), view()] }), { archiveKey }), /unique/);
    for (const window of [{ center: Infinity, width: 2 }, { center: 0, width: 0 }, { center: 0, width: 1e13 }, { center: 0, width: 1, modality: 'HU' }]) assert.throws(() => normalizeStudyContext(context({ viewports: [view({ window })] }), { archiveKey }), TypeError);
    const malicious = { ...context() }; Object.defineProperty(malicious, 'version', { get() { throw new Error('must not invoke getter'); }, enumerable: true });
    assert.throws(() => normalizeStudyContext(malicious, { archiveKey }), TypeError);
});
test('maximal accepted four-pane reference schema stays below the fixed64KiB cap and larger untrusted fields reject', () => {
    const maxKey = 'A'.repeat(64), identifier = '2.' + '1'.repeat(62), ref = { archiveKey: maxKey, studyUid: identifier, seriesUid: identifier, sopUid: identifier };
    const output = normalizeStudyContext(context({ layout: 4, activeViewport: 3, viewports: [0, 1, 2, 3].map(slot => view({ slot, reference: ref, frameIndex: 9999, originalFrameNumber: 4096, window: { center: -1e12, width: 1e12 } })) }), { archiveKey: maxKey });
    assert.ok(new TextEncoder().encode(JSON.stringify(output)).byteLength < CONTEXT_BYTES); assert.equal(output.viewports.length, 4);
    assert.throws(() => normalizeStudyContext(context({ viewports: [view({ reference: { ...reference, archiveKey: 'A'.repeat(CONTEXT_BYTES) } })] }), { archiveKey }), TypeError);
    assert.throws(() => normalizeStudyContext(context({ extra: 'x'.repeat(CONTEXT_BYTES) }), { archiveKey }), TypeError);
});
