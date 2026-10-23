import test from 'node:test';
import assert from 'node:assert/strict';
import EASI from '@xinonix/easi-js';
import { createDicomFixture } from '../src/data/synthetic.js';
import { loadResponse, MAX_SOURCE_BYTES } from '../src/data/sources.js';
import { loadArchiveSeries, EncodedInstanceCache, ARCHIVE_DECODED_CACHE_BYTES, ARCHIVE_ENCODED_CACHE_BYTES, MAX_ARCHIVE_FRAMES } from '../src/data/archive-source.js';

const STUDY = '1.2.826.0.1.3680043.10.543.900.1';
const SERIES = '1.2.3.4';
const SOP_CLASS = '1.2.840.10008.5.1.4.1.1.2';

function metadata(options = {}) {
    const entry = (vr, ...Value) => ({ vr, Value });
    const item = {
        '00080008': entry('CS', 'DERIVED', 'SECONDARY', 'SYNTHETIC'),
        '00080016': entry('UI', options.sopClass ?? SOP_CLASS), '00080018': entry('UI', options.sopUid ?? '1.2.3.10'),
        '00080060': entry('CS', options.modality ?? 'CT'), '0008103E': entry('LO', 'Synthetic archive series'),
        '0020000D': entry('UI', options.studyUid ?? STUDY), '0020000E': entry('UI', options.seriesUid ?? SERIES),
        '00200013': entry('IS', options.instanceNumber ?? 1), '00200032': entry('DS', ...(options.position ?? [0, 0, 0])),
        '00200037': entry('DS', ...(options.orientation ?? [1, 0, 0, 0, 1, 0])),
        '00280002': entry('US', 1), '00280004': entry('CS', options.photometric ?? 'MONOCHROME2'),
        '00280008': entry('IS', options.frames ?? 1), '00280010': entry('US', options.rows ?? 2),
        '00280011': entry('US', options.columns ?? 2), '00280030': entry('DS', ...(options.pixelSpacing ?? [0.75, 0.75])),
        '00280100': entry('US', options.bitsAllocated ?? 16), '00280101': entry('US', options.bitsStored ?? options.bitsAllocated ?? 16),
        '00280102': entry('US', options.highBit ?? (options.bitsStored ?? options.bitsAllocated ?? 16) - 1),
        '00280103': entry('US', options.signed ? 1 : 0),
        '00281052': entry('DS', options.intercept ?? 0), '00281053': entry('DS', options.slope ?? 1),
        '00281054': entry('LO', 'HU'), '00281056': entry('CS', options.voiFunction ?? 'LINEAR'),
        '7FE00010': { vr: 'OW', BulkDataURI: 'https://archive.example.test/never-follow-this' }
    };
    if (options.window) { item['00281050'] = entry('DS', options.window.center); item['00281051'] = entry('DS', options.window.width); }
    if ((options.frames ?? 1) > 1) item['00181063'] = entry('DS', options.frameTime ?? 50);
    for (const [tag, value] of Object.entries(options.metadataOverrides ?? {})) {
        if (value == null) delete item[tag]; else item[tag] = value;
    }
    return item;
}

async function parseMetadata(options) {
    const json = new TextEncoder().encode(JSON.stringify(options.map(metadata)));
    const result = await EASI.pipelineBuilder().fromByteStream().ofDicomMetadata().toInstances().build().process({ source: json });
    return result.toArray();
}

function fixture(options = {}) {
    return createDicomFixture({ ...options, seriesUid: options.seriesUid ?? SERIES,
        sopUid: options.sopUid ?? '1.2.3.10', extraAttributes: { '0020000D': ['UI', options.studyUid ?? STUDY], ...options.extraAttributes } });
}

function response(bytes) { return new Response(bytes, { headers: { 'content-type': 'application/dicom', 'content-length': String(bytes.length) } }); }

async function client(options, retrieve = null) {
    const instances = await parseMetadata(options);
    const calls = [];
    return { calls, instances,
        async getSeriesMetadata(study, series, { signal }) {
            assert.equal(study, STUDY); assert.equal(series, SERIES); assert.notEqual(signal?.aborted, true);
            calls.push('metadata'); return instances;
        },
        async retrieveInstance(study, series, uid, { signal }) {
            calls.push(uid);
            assert.equal(study, STUDY); assert.equal(series, SERIES);
            if (retrieve) return retrieve(uid, signal);
            const selected = options.find(item => (item.sopUid ?? '1.2.3.10') === uid);
            return response(fixture(selected));
        }
    };
}

async function until(condition) {
    for (let step = 0; step < 100 && !condition(); step++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.ok(condition(), 'The expected asynchronous operation did not start.');
}

const EXPECTED_PATIENT = Object.freeze({ patientId: 'SYNTHETIC-001', issuerOfPatientId: 'SYNTHETIC-ISSUER', patientName: 'SYNTHETIC ONE', patientBirthDate: '19800102' });
function patientMetadata(changes = {}) {
    return { '00100020': { vr: 'LO', Value: [EXPECTED_PATIENT.patientId] },
        '00100021': { vr: 'LO', Value: [EXPECTED_PATIENT.issuerOfPatientId] },
        '00100010': { vr: 'PN', Value: [{ Alphabetic: 'SYNTHETIC^ONE^^^ ' }] },
        '00100030': { vr: 'DA', Value: [EXPECTED_PATIENT.patientBirthDate] }, ...changes };
}
function patientNative(changes = {}) {
    return { '00100020': ['LO', EXPECTED_PATIENT.patientId], '00100021': ['LO', EXPECTED_PATIENT.issuerOfPatientId],
        '00100010': ['PN', 'SYNTHETIC^ONE^^^ '], '00100030': ['DA', EXPECTED_PATIENT.patientBirthDate], ...changes };
}

test('selected-patient identity normalizes JSON and native PN padding while preserving all known identifiers', async () => {
    const archive = await client([{ values: [1, 2, 3, 4], metadataOverrides: patientMetadata(), extraAttributes: patientNative() }]);
    const sources = await loadArchiveSeries(archive, STUDY, SERIES, { expectedPatient: EXPECTED_PATIENT });
    try {
        assert.deepEqual(archive.calls, ['metadata']); assert.deepEqual([...(await sources[0].getFrame(0)).samples], [1, 2, 3, 4]);
        assert.equal(sources[0]._session.encoded.entries.size, 1);
    } finally { sources.forEach(stack => stack.dispose()); }
});

for (const [field, tag, vr, changed] of [
    ['patient ID', '00100020', 'LO', 'OTHER-001'], ['issuer', '00100021', 'LO', 'OTHER-ISSUER'],
    ['patient name', '00100010', 'PN', { Alphabetic: 'OTHER^PATIENT' }], ['birth date', '00100030', 'DA', '20000102']
]) {
    test(`selected ${field} mismatch or missing metadata fails before pixels or series publication`, async () => {
        for (const replacement of [{ vr, Value: [changed] }, null]) {
            const archive = await client([{ metadataOverrides: patientMetadata({ [tag]: replacement }) }]), published = [];
            await assert.rejects(loadArchiveSeries(archive, STUDY, SERIES, { expectedPatient: EXPECTED_PATIENT, onSeries: result => published.push(result) }), /patient identity does not match/);
            assert.deepEqual(archive.calls, ['metadata']); assert.deepEqual(published, []);
        }
    });
    test(`retrieved ${field} mismatch cannot bypass matching metadata UIDs or enter pixel caches`, async () => {
        const replacement = typeof changed === 'object' ? changed.Alphabetic : changed;
        const archive = await client([{ metadataOverrides: patientMetadata() }], () => response(fixture({ extraAttributes: patientNative({ [tag]: [vr, replacement] }) })));
        const sources = await loadArchiveSeries(archive, STUDY, SERIES, { expectedPatient: EXPECTED_PATIENT });
        try {
            await assert.rejects(sources[0].getFrame(0), /patient identity does not match/);
            assert.deepEqual(archive.calls, ['metadata', '1.2.3.10']); assert.equal(sources[0].sourceBytes, 0); assert.equal(sources[0].cacheBytes, 0);
        } finally { sources.forEach(stack => stack.dispose()); }
    });
}

test('identity mismatch in a later metadata instance never publishes a partial series or touches another displayed source', async () => {
    const displayed = await loadResponse(response(fixture({ values: [4, 3, 2, 1] })));
    const original = await displayed[0].getFrame(0), published = [], progress = [];
    const archive = await client([{ metadataOverrides: patientMetadata() }, { sopUid: '1.2.3.11', metadataOverrides: patientMetadata({ '00100020': { vr: 'LO', Value: ['OTHER-PATIENT'] } }) }]);
    try {
        await assert.rejects(loadArchiveSeries(archive, STUDY, SERIES, { expectedPatient: EXPECTED_PATIENT, onSeries: value => published.push(value), onProgress: value => progress.push(value) }), /patient identity does not match/);
        assert.deepEqual(published, []); assert.deepEqual(archive.calls, ['metadata']);
        assert.equal(await displayed[0].getFrame(0), original); assert.deepEqual([...original.samples], [4, 3, 2, 1]);
        assert.equal(JSON.stringify(progress).includes('OTHER-PATIENT'), false); assert.equal(JSON.stringify(progress).includes(EXPECTED_PATIENT.patientId), false);
    } finally { displayed.forEach(stack => stack.dispose()); }
});

test('retrieval remains bound to metadata demographics even when only the selected patient ID was supplied', async () => {
    const archive = await client([{ metadataOverrides: patientMetadata() }], () => response(fixture({ extraAttributes: patientNative({ '00100030': ['DA', '20000102'] }) })));
    const sources = await loadArchiveSeries(archive, STUDY, SERIES, { expectedPatient: { patientId: EXPECTED_PATIENT.patientId } });
    try { await assert.rejects(sources[0].getFrame(0), /patient identity does not match/); assert.equal(sources[0].cacheBytes, 0); }
    finally { sources.forEach(stack => stack.dispose()); }
});

test('malformed expected-patient scope and pre-canceled operations perform no metadata request', async () => {
    const archive = await client([{ metadataOverrides: patientMetadata() }]);
    for (const expectedPatient of [null, { patientId: 42 }, { patientId: EXPECTED_PATIENT.patientId, headers: { Authorization: 'private' } }, { patientName: 'x'.repeat(4097) }]) {
        await assert.rejects(loadArchiveSeries(archive, STUDY, SERIES, { expectedPatient })); assert.deepEqual(archive.calls, []);
    }
    const controller = new AbortController(); controller.abort();
    await assert.rejects(loadArchiveSeries(archive, STUDY, SERIES, { expectedPatient: EXPECTED_PATIENT, signal: controller.signal }), { name: 'AbortError' }); assert.deepEqual(archive.calls, []);
});

test('canceling after identity metadata fetch preserves an independent active source and publishes no replacement', async () => {
    const displayed = await loadResponse(response(fixture({ values: [7, 8, 9, 10] }))), original = await displayed[0].getFrame(0);
    const controller = new AbortController(), archive = await client([{ metadataOverrides: patientMetadata() }]), published = [];
    const fetchMetadata = archive.getSeriesMetadata.bind(archive);
    archive.getSeriesMetadata = async (...args) => { const result = await fetchMetadata(...args); controller.abort(); return result; };
    try {
        await assert.rejects(loadArchiveSeries(archive, STUDY, SERIES, { expectedPatient: EXPECTED_PATIENT, signal: controller.signal, onSeries: value => published.push(value) }), { name: 'AbortError' });
        assert.deepEqual(published, []); assert.deepEqual(archive.calls, ['metadata']); assert.equal(await displayed[0].getFrame(0), original);
    } finally { displayed.forEach(stack => stack.dispose()); }
});

test('metadata creates spatially sorted navigable stacks without retrieving any pixels or BulkDataURI', async () => {
    const archive = await client([
        { sopUid: '1.2.3.10', position: [0, 0, 10], instanceNumber: 1 },
        { sopUid: '1.2.3.11', position: [0, 0, -10], instanceNumber: 99 }
    ]);
    const published = [];
    const sources = await loadArchiveSeries(archive, STUDY, SERIES, { onSeries: value => published.push(value) });
    try {
        assert.deepEqual(archive.calls, ['metadata']);
        assert.equal(published.length, 1);
        assert.equal(sources[0].frames.length, 2);
        assert.deepEqual(sources[0].frames.map(frame => frame.sopUid), ['1.2.3.11', '1.2.3.10']);
        assert.deepEqual(sources[0].frames[0].pixelSpacing, [0.75, 0.75]);
        assert.equal(sources[0].sourceType, 'archive');
        assert.equal(sources[0].sourceBytes, 0); assert.equal(sources[0].cacheBytes, 0);
        assert.equal(sources[0]._session.cache.budget, ARCHIVE_DECODED_CACHE_BYTES);
        assert.equal(sources[0]._session.encoded.budget, ARCHIVE_ENCODED_CACHE_BYTES);
    } finally { sources.forEach(stack => stack.dispose()); }
});

test('first-frame and random-seek retrieval request only the selected SOP and retain original samples', async () => {
    const archive = await client([
        { sopUid: '1.2.3.10', position: [0, 0, 0], values: [1, 2, 3, 4] },
        { sopUid: '1.2.3.11', position: [0, 0, 1], values: [11, 12, 13, 14] },
        { sopUid: '1.2.3.12', position: [0, 0, 2], values: [21, 22, 23, 24] }
    ]);
    const sources = await loadArchiveSeries(archive, STUDY, SERIES);
    try {
        const first = await sources[0].getFrame(0);
        assert.deepEqual([...first.samples], [1, 2, 3, 4]);
        assert.deepEqual(archive.calls, ['metadata', '1.2.3.10']);
        const last = await sources[0].getFrame(2);
        assert.deepEqual([...last.samples], [21, 22, 23, 24]);
        assert.deepEqual(archive.calls, ['metadata', '1.2.3.10', '1.2.3.12']);
        assert.equal(await sources[0].getFrame(0), first);
        assert.equal(sources[0].sourceBytes, 16); assert.equal(sources[0].cacheBytes, 16);
        assert.ok(sources[0].frames.every(frame => frame._metadata.bytes === null));
    } finally { sources.forEach(stack => stack.dispose()); }
});

test('native multiframe seeks reuse encoded instances while decoding only each requested frame', async () => {
    const archive = await client([{ frames: 3, values: [1, 2, 3, 4, 11, 12, 13, 14, 21, 22, 23, 24] }]);
    const sources = await loadArchiveSeries(archive, STUDY, SERIES);
    try {
        assert.equal(sources[0].frames.length, 3);
        assert.deepEqual([...(await sources[0].getFrame(2)).samples], [21, 22, 23, 24]);
        assert.equal(sources[0].cacheBytes, 8); assert.equal(sources[0].sourceBytes, 24);
        assert.deepEqual([...(await sources[0].getFrame(0)).samples], [1, 2, 3, 4]);
        assert.deepEqual(archive.calls, ['metadata', '1.2.3.10']);
    } finally { sources.forEach(stack => stack.dispose()); }
});

for (const transferSyntax of ['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']) {
    test(`archive decoding uses retrieved native syntax when JSON metadata has no syntax (${transferSyntax})`, async () => {
        const archive = await client([{ transferSyntax, signed: true, bitsStored: 12, highBit: 14,
            values: [-2048, -1, 0, 2047], slope: 2, intercept: -1000 }]);
        const sources = await loadArchiveSeries(archive, STUDY, SERIES);
        try {
            const frame = await sources[0].getFrame(0);
            assert.deepEqual([...frame.samples], [-2048, -1, 0, 2047]);
            assert.deepEqual(frame.range, { min: -5096, max: 3094 });
            assert.equal(frame.littleEndian, transferSyntax !== '1.2.840.10008.1.2.2');
        } finally { sources.forEach(stack => stack.dispose()); }
    });
}

test('different orientations and positioned versus unpositioned images use independent stacks', async () => {
    const archive = await client([
        { sopUid: '1.2.3.10', position: [0, 0, 20], instanceNumber: 1 },
        { sopUid: '1.2.3.11', position: [0, 0, -10], instanceNumber: 99 },
        { sopUid: '1.2.3.12', orientation: [0, 1, 0, 0, 0, 1] },
        { sopUid: '1.2.3.13', metadataOverrides: { '00200032': null } }
    ]);
    const sources = await loadArchiveSeries(archive, STUDY, SERIES);
    try {
        assert.equal(sources.length, 3);
        assert.deepEqual(sources[0].frames.map(frame => frame.instanceNumber), [99, 1]);
        assert.equal(sources[2].frames[0].position, null);
    } finally { sources.forEach(stack => stack.dispose()); }
});

test('canceling or superseding a requested frame aborts its fetch and allows the latest frame', async () => {
    const aborted = [];
    const archive = await client([{ sopUid: '1.2.3.10' }, { sopUid: '1.2.3.11', position: [0, 0, 1] }], (uid, signal) => {
        if (uid === '1.2.3.11') return response(fixture({ sopUid: uid, position: [0, 0, 1], values: [11, 12, 13, 14] }));
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
            aborted.push(uid); reject(new DOMException('Canceled', 'AbortError'));
        }, { once: true }));
    });
    const sources = await loadArchiveSeries(archive, STUDY, SERIES);
    try {
        const first = sources[0].getFrame(0);
        const rejected = assert.rejects(first, { name: 'AbortError' });
        assert.deepEqual([...(await sources[0].getFrame(1)).samples], [11, 12, 13, 14]);
        await rejected;
        assert.deepEqual(aborted, ['1.2.3.10']);
        const controller = new AbortController();
        const pending = sources[0].getFrame(0, { signal: controller.signal });
        const canceled = assert.rejects(pending, { name: 'AbortError' });
        controller.abort(); await canceled;
        assert.equal(aborted.length, 2);
    } finally { sources.forEach(stack => stack.dispose()); }
});

test('canceling while native DICOM bytes are still streaming cancels the underlying response body', async () => {
    let canceled = false;
    let reading = false;
    const archive = await client([{}], () => {
        let step = 0;
        return new Response(new ReadableStream({
            pull(controller) {
                if (step++ === 0) controller.enqueue(fixture().subarray(0, 140));
                else { reading = true; return new Promise(() => {}); }
            }, cancel() { canceled = true; }
        }), { headers: { 'content-type': 'application/dicom' } });
    });
    const sources = await loadArchiveSeries(archive, STUDY, SERIES);
    const controller = new AbortController();
    try {
        const pending = sources[0].getFrame(0, { signal: controller.signal });
        const rejected = assert.rejects(pending, { name: 'AbortError' });
        await until(() => reading);
        controller.abort();
        await rejected; await until(() => canceled);
        assert.equal(sources[0].sourceBytes, 0); assert.equal(sources[0].cacheBytes, 0);
    } finally { sources.forEach(stack => stack.dispose()); }
});

test('disposing an archive series terminates worker decoding and releases its bytes and descriptors', async () => {
    const archive = await client([{}]);
    const sources = await loadArchiveSeries(archive, STUDY, SERIES);
    const originalWorker = globalThis.Worker;
    const workers = [];
    globalThis.Worker = class {
        constructor() { workers.push(this); }
        postMessage(value) { this.message = value; }
        terminate() { this.terminated = true; }
    };
    try {
        const pending = sources[0].getFrame(0);
        const rejected = assert.rejects(pending, { name: 'AbortError' });
        await until(() => workers.length === 1);
        sources[0].dispose();
        await rejected;
        assert.equal(workers[0].terminated, true);
        assert.equal(sources[0].sourceBytes, 0); assert.equal(sources[0].cacheBytes, 0);
        assert.equal(sources[0].frames.length, 0);
        await assert.rejects(sources[0].getFrame(0), /disposed/);
    } finally { globalThis.Worker = originalWorker; sources.forEach(stack => stack.dispose()); }
});

test('encoded and decoded LRUs evict stale instances without leaving pixel bytes in metadata', async () => {
    const archive = await client([{ sopUid: '1.2.3.10' }, { sopUid: '1.2.3.11', position: [0, 0, 1] }]);
    const sources = await loadArchiveSeries(archive, STUDY, SERIES);
    try {
        sources[0]._session.cache.budget = 8;
        sources[0]._session.encoded.budget = 8;
        await sources[0].getFrame(0); await sources[0].getFrame(1); await sources[0].getFrame(0);
        assert.deepEqual(archive.calls, ['metadata', '1.2.3.10', '1.2.3.11', '1.2.3.10']);
        assert.equal(sources[0].cacheBytes, 8); assert.equal(sources[0].sourceBytes, 8);
        assert.ok(sources[0].frames.every(frame => frame._metadata.bytes === null));
    } finally { sources.forEach(stack => stack.dispose()); }
});

test('disposing one compatible stack releases only its resources and preserves another stack', async () => {
    const archive = await client([
        { sopUid: '1.2.3.10', values: [1, 2, 3, 4] },
        { sopUid: '1.2.3.11', orientation: [0, 1, 0, 0, 0, 1], values: [11, 12, 13, 14] }
    ]);
    const sources = await loadArchiveSeries(archive, STUDY, SERIES);
    try {
        await sources[0].getFrame(0);
        const other = await sources[1].getFrame(0);
        assert.equal(sources[0].sourceBytes, 8); assert.equal(sources[1].sourceBytes, 8);
        sources[0].dispose();
        assert.equal(sources[0].sourceBytes, 0); assert.equal(sources[1].sourceBytes, 8);
        assert.equal(sources[1]._session.disposed, false);
        assert.equal(await sources[1].getFrame(0), other);
        sources[1].dispose(); assert.equal(sources[1]._session.disposed, true);
    } finally { sources.forEach(stack => stack.dispose()); }
});

test('an oversized active encoded instance is decoded transiently and never retained', async () => {
    const archive = await client([{}]);
    const sources = await loadArchiveSeries(archive, STUDY, SERIES);
    try {
        sources[0]._session.encoded.budget = 7;
        await sources[0].getFrame(0);
        assert.equal(sources[0].sourceBytes, 0); assert.equal(sources[0]._session.encoded.entries.size, 0);
        sources[0]._session.cache.clear();
        await sources[0].getFrame(0);
        assert.deepEqual(archive.calls, ['metadata', '1.2.3.10', '1.2.3.10']);
    } finally { sources.forEach(stack => stack.dispose()); }
});

test('encoded LRU refreshes recency, enforces byte limits and rejects invalid budgets', () => {
    const cache = new EncodedInstanceCache(10);
    const record = value => ({ bytes: new Uint8Array(value) });
    cache.set('a', record(4)); cache.set('b', record(4));
    cache.get('a'); cache.set('c', record(4));
    assert.equal(cache.get('b'), null); assert.equal(cache.bytes, 8);
    cache.set('huge', record(11)); assert.equal(cache.get('huge'), null); assert.equal(cache.bytes, 8);
    cache.clear(); assert.equal(cache.bytes, 0);
    assert.throws(() => new EncodedInstanceCache(0), /budget/);
});

for (const [label, options, error] of [
    ['study identity', { studyUid: '1.2.99' }, /identity/],
    ['series identity', { seriesUid: '1.2.99' }, /identity/],
    ['SOP identity', { sopUid: '1.2.99' }, /identity/],
    ['dimensions', { rows: 1, columns: 4 }, /dimensions/],
    ['frame count', { frames: 2, values: [1, 2, 3, 4, 5, 6, 7, 8] }, /frame count/],
    ['pixel calibration', { pixelSpacing: [1, 1] }, /geometry/],
    ['image position', { position: [0, 0, 10] }, /geometry/],
    ['compressed transfer syntax', { transferSyntax: '1.2.840.10008.1.2.4.90' }, /Pixel Data encoding/],
    ['unsupported object class', { sopClass: '1.2.840.10008.5.1.4.1.1.88.22' }, /object type/],
    ['unsupported enhanced geometry', { extraAttributes: { '52009230': ['SQ', new Uint8Array()] } }, /functional groups/]
]) {
    test(`retrieved ${label} fails explicitly without poisoning either cache`, async () => {
        const archive = await client([{}], () => response(fixture(options)));
        const sources = await loadArchiveSeries(archive, STUDY, SERIES);
        try {
            await assert.rejects(sources[0].getFrame(0), error);
            assert.equal(sources[0].sourceBytes, 0); assert.equal(sources[0].cacheBytes, 0);
        } finally { sources.forEach(stack => stack.dispose()); }
    });
}

test('metadata identity, duplicate UIDs and maximum instance or series frame counts fail before WADO', async () => {
    for (const [options, expected] of [
        [[{ studyUid: '1.2.99' }], /requested Study/],
        [[{ seriesUid: '1.2.99' }], /requested Study/],
        [[{}, {}], /duplicate/],
        [[{ frames: 4097 }], /pixel metadata/],
        [[{ frames: 4096 }, { sopUid: '1.2.3.11', frames: 4096 }, { sopUid: '1.2.3.12', frames: 4096 }], /10,000-frame/]
    ]) {
        const archive = await client(options);
        await assert.rejects(loadArchiveSeries(archive, STUDY, SERIES), expected);
        assert.deepEqual(archive.calls, ['metadata']);
    }
    assert.equal(MAX_ARCHIVE_FRAMES, 10000);
});

test('an onSeries cancellation disposes metadata-only sources and never retrieves pixels', async () => {
    const archive = await client([{}]);
    const controller = new AbortController();
    let emitted;
    await assert.rejects(loadArchiveSeries(archive, STUDY, SERIES, { signal: controller.signal, onSeries: sources => {
        emitted = sources[0]; controller.abort();
    } }), { name: 'AbortError' });
    assert.equal(emitted.disposed, true); assert.equal(emitted.frames.length, 0);
    assert.deepEqual(archive.calls, ['metadata']);
});

test('the shared response parser enforces declared byte budgets before streaming', async () => {
    let canceled = false;
    const body = new ReadableStream({ cancel() { canceled = true; } });
    await assert.rejects(loadResponse(new Response(body, { headers: {
        'content-type': 'application/dicom', 'content-length': String(MAX_SOURCE_BYTES + 1)
    } })), /256 MiB/);
    assert.equal(canceled, true);
});

test('RetrieveInstance rejects extra multipart images, including repeated SOPs normally deduplicated locally', async () => {
    for (const secondUid of ['1.2.3.10', '1.2.3.11']) {
        const archive = await client([{}], () => {
            const body = new Blob([
                '--easi-archive\r\nContent-Type: application/dicom\r\n\r\n', fixture(),
                '\r\n--easi-archive\r\nContent-Type: application/dicom\r\n\r\n', fixture({ sopUid: secondUid }),
                '\r\n--easi-archive--\r\n'
            ]);
            return new Response(body.stream(), { headers: {
                'content-type': 'multipart/related; type="application/dicom"; boundary=easi-archive'
            } });
        });
        const sources = await loadArchiveSeries(archive, STUDY, SERIES);
        try {
            await assert.rejects(sources[0].getFrame(0), /exactly one/);
            assert.equal(sources[0].sourceBytes, 0); assert.equal(sources[0].cacheBytes, 0);
        } finally { sources.forEach(stack => stack.dispose()); }
    }
});

for (const planarConfiguration of [0, 1]) {
    test(`archive RGB descriptors fetch one native instance and preserve multiframe channels (planar ${planarConfiguration})`, async () => {
        const first = [255, 0, 0, 0, 255, 0, 0, 0, 255, 17, 31, 129];
        const second = [1, 2, 3, 11, 12, 13, 21, 22, 23, 31, 32, 33];
        const order = values => planarConfiguration ? [0, 1, 2].flatMap(channel =>
            [0, 1, 2, 3].map(pixel => values[pixel * 3 + channel])) : values;
        const options = { photometric: 'RGB', bitsAllocated: 8, bitsStored: 8, frames: 2,
            rawPixelBytes: new Uint8Array([...order(first), ...order(second)]),
            extraAttributes: { '00280002': ['US', 3], '00280006': ['US', planarConfiguration] },
            metadataOverrides: { '00280002': { vr: 'US', Value: [3] }, '00280006': { vr: 'US', Value: [planarConfiguration] } } };
        const archive = await client([options]);
        const sources = await loadArchiveSeries(archive, STUDY, SERIES);
        try {
            assert.deepEqual(archive.calls, ['metadata']);
            assert.equal(sources[0].frames[0].samplesPerPixel, 3);
            assert.equal(sources[0].frames[0].window, null);
            const frame = await sources[0].getFrame(1);
            assert.deepEqual([...frame.samples], second); assert.equal(frame.range, null); assert.equal(frame.window, null);
            assert.equal(sources[0].cacheBytes, 12); assert.equal(sources[0].sourceBytes, 24);
            assert.deepEqual([...(await sources[0].getFrame(0)).samples], first);
            assert.deepEqual(archive.calls, ['metadata', '1.2.3.10']);
        } finally { sources.forEach(stack => stack.dispose()); }
    });
}

test('archive RGB retrieval may change planar storage while preserving its canonical channels', async () => {
    const options = { photometric: 'RGB', bitsAllocated: 8, bitsStored: 8, rawPixelBytes: new Uint8Array([255,0,0,17,0,255,0,31,0,0,255,129]),
        extraAttributes: { '00280002': ['US', 3], '00280006': ['US', 1] },
        metadataOverrides: { '00280002': { vr: 'US', Value: [3] }, '00280006': { vr: 'US', Value: [0] } } };
    const archive = await client([options]);
    const sources = await loadArchiveSeries(archive, STUDY, SERIES);
    try {
        const frame = await sources[0].getFrame(0);
        assert.deepEqual([...frame.samples], [255,0,0,0,255,0,0,0,255,17,31,129]);
        assert.equal(frame.photometric, 'RGB'); assert.equal(sources[0].cacheBytes,12); assert.equal(sources[0].sourceBytes,12);
    } finally { sources.forEach(stack => stack.dispose()); }
});

// Independent explicit-little-endian sequence writer for generated mask fixtures.
function xaMaskSequence(operation) {
    const text = new TextEncoder().encode(operation.length % 2 ? `${operation} ` : operation);
    const bytes = new Uint8Array(16 + text.length);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 0xFFFE, true); view.setUint16(2, 0xE000, true);
    view.setUint32(4, 8 + text.length, true);
    view.setUint16(8, 0x0028, true); view.setUint16(10, 0x6101, true);
    bytes.set([0x43, 0x53], 12); view.setUint16(14, text.length, true); bytes.set(text, 16);
    return bytes;
}

function xaOptions(operation = 'NONE') {
    return {
        sopClass: '1.2.840.10008.5.1.4.1.1.12.1', modality: 'XA',
        bitsAllocated: 8, bitsStored: 8, frames: 96, frameTime: 33,
        values: Array.from({ length: 96 * 4 }, (_, index) => Math.floor(index / 4) * 2 + index % 4),
        extraAttributes: {
            '00281040': ['CS', 'LIN'], '00281090': ['CS', 'NAT'],
            '00286100': ['SQ', xaMaskSequence(operation)],
            '00280030': null, '00200032': null, '00200037': null
        },
        metadataOverrides: {
            '00280009': { vr: 'AT', Value: ['00181063'] },
            '00281040': { vr: 'CS', Value: ['LIN'] }, '00281090': { vr: 'CS', Value: ['NAT'] },
            '00286100': { vr: 'SQ', Value: [{ '00286101': { vr: 'CS', Value: [operation] } }] },
            '00281054': null, '00280030': null, '00200032': null, '00200037': null
        }
    };
}

test('archive classic XA accepts an inactive mask and lazily decodes 96 native cine frames', async () => {
    const archive = await client([xaOptions()]);
    const sources = await loadArchiveSeries(archive, STUDY, SERIES);
    try {
        const stack = sources[0];
        assert.deepEqual(archive.calls, ['metadata']);
        assert.equal(stack.frames.length, 96);
        assert.equal(stack.frames[0].frameTime, 33); assert.equal(stack.frames[0].pixelSpacing, null);
        assert.equal(stack.sourceBytes, 0); assert.equal(stack.cacheBytes, 0);
        const first = await stack.getFrame(0), last = await stack.getFrame(95);
        assert.deepEqual([...first.samples], [0, 1, 2, 3]);
        assert.deepEqual([...last.samples], [190, 191, 192, 193]);
        assert.equal(first.photometric, 'MONOCHROME2'); assert.equal(first.unit, '');
        assert.equal(last.frameTime, 33); assert.equal(last.pixelSpacing, null);
        assert.equal(await stack.getFrame(0), first);
        assert.deepEqual(archive.calls, ['metadata', '1.2.3.10']);
        assert.equal(stack.sourceBytes, 384); assert.equal(stack.cacheBytes, 16);
    } finally { sources.forEach(stack => stack.dispose()); }
});

test('archive classic XA active subtraction fails during metadata navigation before retrieving pixels', async () => {
    const archive = await client([xaOptions('AVG_SUB')]);
    await assert.rejects(loadArchiveSeries(archive, STUDY, SERIES), /subtraction/i);
    assert.deepEqual(archive.calls, ['metadata']);
});

test('archive classic XA rejects a retrieved active mask despite inactive metadata and leaves caches empty', async () => {
    const archive = await client([xaOptions()], () => response(fixture(xaOptions('AVG_SUB'))));
    const sources = await loadArchiveSeries(archive, STUDY, SERIES);
    try {
        await assert.rejects(sources[0].getFrame(0), /subtraction/i);
        assert.equal(sources[0].cacheBytes, 0); assert.equal(sources[0].sourceBytes, 0);
    } finally { sources.forEach(stack => stack.dispose()); }
});
