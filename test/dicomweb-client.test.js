import test from 'node:test';
import assert from 'node:assert/strict';
import { DicomWebClient, MAX_METADATA_BYTES, validateDicomUid } from '../src/data/DicomWebClient.js';
import { Tag } from '@xinonix/easi-js';

const studyUid = '2.25.101';
const seriesUid = '2.25.101.1';
const sopUid = '2.25.101.1.1';
const encoder = new TextEncoder();
const attr = (vr, ...values) => ({ vr, Value: values });
function study(overrides = {}) {
    return {
        '0020000D': attr('UI', studyUid), '00100010': attr('PN', { Alphabetic: 'SYNTHETIC^PATIENT', Ideographic: '合成^患者' }),
        '00100020': attr('LO', 'SYNTH-001'), '00080020': attr('DA', '20261013'), '00081030': attr('LO', 'Synthetic study'),
        '00080050': attr('SH', 'SYNTH-ACCESSION'), '00080061': attr('CS', 'CT', 'MR'),
        '00201206': attr('IS', 2), '00201208': attr('IS', '18'), ...overrides
    };
}
function series(overrides = {}) {
    return { '0020000D': attr('UI', studyUid), '0020000E': attr('UI', seriesUid),
        '00080060': attr('CS', 'CT'), '0008103E': attr('LO', 'Synthetic CT'),
        '00200011': attr('IS', 3), '00201209': attr('IS', 8), ...overrides };
}
function metadata(overrides = {}) {
    return { ...series(), '00080018': attr('UI', sopUid), '00080016': attr('UI', '1.2.840.10008.5.1.4.1.1.2'),
        '7FE00010': { vr: 'OW', BulkDataURI: 'https://different.invalid/pixels' }, ...overrides };
}
function response(data, options = {}) {
    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/dicom+json', ...options.headers }, status: options.status ?? 200 });
}
function client(options = {}) { return new DicomWebClient({ baseUrl: 'https://archive.invalid/dicom-web/', ...options }); }
async function withFetch(stub, action) {
    const original = globalThis.fetch;
    globalThis.fetch = stub;
    try { return await action(); } finally { globalThis.fetch = original; }
}
const pause = () => new Promise(resolve => setTimeout(resolve, 0));

test('QIDO study search maps bounded EASI metadata and escapes filters as individual query values', async () => {
    let request;
    await withFetch(async (url, options) => { request = { url: new URL(url), options }; return response([study()]); }, async () => {
        const result = await client().searchStudies({ patientId: 'SYNTH*&notAParameter=1', patientName: '合成^Patient?',
            studyDate: '20260101-20261231', accessionNumber: 'SYNTH ACCESSION', modality: 'CT', studyUid }, { offset: 10, limit: 25 });
        assert.deepEqual(result.items, [{ studyUid, patientName: 'SYNTHETIC PATIENT', patientId: 'SYNTH-001',
            studyDate: '20261013', description: 'Synthetic study', accessionNumber: 'SYNTH-ACCESSION',
            modalities: ['CT', 'MR'], seriesCount: 2, instanceCount: 18 }]);
        assert.equal(result.hasMore, false);
        assert.equal(result.nextOffset, null);
        assert.deepEqual(result.warnings, []);
    });
    assert.equal(request.url.pathname, '/dicom-web/studies');
    assert.equal(request.url.searchParams.get('PatientID'), 'SYNTH*&notAParameter=1');
    assert.equal(request.url.searchParams.has('notAParameter'), false);
    assert.equal(request.url.searchParams.get('PatientName'), '合成^Patient?');
    assert.equal(request.url.searchParams.get('ModalitiesInStudy'), 'CT');
    assert.equal(request.url.searchParams.get('Modality'), null);
    assert.equal(request.url.searchParams.get('offset'), '10');
    assert.equal(request.url.searchParams.get('limit'), '25');
    assert.match(request.url.searchParams.get('includefield'), /00201208/);
    assert.equal(request.options.credentials, 'omit');
    assert.equal(request.options.redirect, 'error');
    assert.equal(request.options.headers.get('accept'), 'application/dicom+json');
});

test('missing optional fields remain empty and unknown counts are null, not invented zeros', async () => {
    await withFetch(async () => response([{ '0020000D': attr('UI', studyUid) }]), async () => {
        const { items } = await client().searchStudies();
        assert.equal(items[0].patientName, '');
        assert.equal(items[0].seriesCount, null);
        assert.equal(items[0].instanceCount, null);
        assert.deepEqual(items[0].modalities, []);
    });
});

test('PN display chooses an available script group and keeps Unicode metadata intact', async () => {
    await withFetch(async () => response([study({ '00100010': attr('PN', { Ideographic: '合成^患者', Phonetic: 'ゴウセイ^カンジャ' }) })]), async () => {
        assert.equal((await client().searchStudies()).items[0].patientName, '合成 患者');
    });
});

test('zero-length PN attributes remain empty for omitted Value, [], and [null] encodings', async () => {
    for (const name of [{ vr: 'PN' }, { vr: 'PN', Value: [] }, { vr: 'PN', Value: [null] }]) {
        await withFetch(async () => response([study({ '00100010': name })]), async () => {
            assert.equal((await client().searchStudies()).items[0].patientName, '');
        });
    }
});

test('empty components in multi-valued Modalities In Study are omitted from display values', async () => {
    for (const [modalities, expected] of [[{ vr: 'CS' }, []], [attr('CS', 'CT', null, '', 'MR'), ['CT', 'MR']]]) {
        await withFetch(async () => response([study({ '00080061': modalities })]), async () => {
            assert.deepEqual((await client().searchStudies()).items[0].modalities, expected);
        });
    }
});

test('an exact full page reports a conservative next page and a short page ends pagination', async () => {
    await withFetch(async () => response([study(), study({ '0020000D': attr('UI', '2.25.102') })]), async () => {
        const full = await client().searchStudies({}, { offset: 4, limit: 2 });
        assert.equal(full.hasMore, true);
        assert.equal(full.nextOffset, 6);
        assert.equal((await client().searchStudies({}, { limit: 3 })).hasMore, false);
    });
});

test('a 299 warning exposes a fixed message rather than server text or patient data', async () => {
    await withFetch(async () => response([], { headers: { warning: '299 archive "truncated https://secret.invalid?token=SENSITIVE"' } }), async () => {
        const result = await client().searchStudies({}, { offset: 25 });
        assert.equal(result.hasMore, true);
        assert.equal(result.nextOffset, 50);
        assert.equal(result.warnings.length, 1);
        assert.doesNotMatch(result.warnings[0], /SENSITIVE|secret.invalid/);
    });
});

test('series query maps independent counts and requires the requested study parent', async () => {
    let url;
    await withFetch(async request => { url = new URL(request); return response([series()]); }, async () => {
        const result = await client().listSeries(studyUid);
        assert.deepEqual(result.items[0], { studyUid, seriesUid, modality: 'CT', description: 'Synthetic CT', seriesNumber: 3, instanceCount: 8 });
        assert.equal(url.pathname, `/dicom-web/studies/${studyUid}/series`);
        assert.equal(url.searchParams.get('limit'), '50');
    });
    await withFetch(async () => response([series({ '0020000D': attr('UI', '2.25.999') })]), async () => {
        await assert.rejects(client().listSeries(studyUid), /different study/);
    });
});

test('series listings allow the parent UID to be omitted at the scoped resource', async () => {
    const row = series(); delete row['0020000D'];
    await withFetch(async () => response([row]), async () => assert.equal((await client().listSeries(studyUid)).items[0].studyUid, studyUid));
});

test('Series Number is a signed identifier while instance counts cannot be negative', async () => {
    await withFetch(async () => response([series({ '00200011': attr('IS', '-3') })]), async () => {
        assert.equal((await client().listSeries(studyUid)).items[0].seriesNumber, -3);
    });
});

test('series metadata returns actual EASI instances and never dereferences BulkDataURI', async () => {
    const requests = [];
    await withFetch(async url => { requests.push(String(url)); return response([metadata()]); }, async () => {
        const instances = await client().getSeriesMetadata(studyUid, seriesUid);
        assert.equal(instances[0].dataSet.value(Tag.SOPInstanceUID), sopUid);
        assert.equal(instances[0].dataSet.value(Tag.SeriesInstanceUID), seriesUid);
        assert.equal(requests.length, 1);
        assert.equal(new URL(requests[0]).pathname, `/dicom-web/studies/${studyUid}/series/${seriesUid}/metadata`);
    });
});

test('DICOM JSON attribute property order is immaterial across study, series, and instance metadata', async () => {
    const valueFirst = set => Object.fromEntries(Object.entries(set).map(([tag, attribute]) =>
        [tag, Object.fromEntries(Object.entries(attribute).reverse())]));
    await withFetch(async url => response([valueFirst(new URL(url).pathname.endsWith('/metadata') ? metadata()
        : new URL(url).pathname.endsWith('/series') ? series() : study())]), async () => {
        const remote = client();
        const found = (await remote.searchStudies()).items[0];
        assert.equal(found.studyUid, studyUid);
        assert.equal(found.patientName, 'SYNTHETIC PATIENT');
        assert.deepEqual(found.modalities, ['CT', 'MR']);
        assert.equal(found.instanceCount, 18);
        assert.equal((await remote.listSeries(studyUid)).items[0].seriesUid, seriesUid);
        assert.equal((await remote.getSeriesMetadata(studyUid, seriesUid))[0].dataSet.value(Tag.SOPInstanceUID), sopUid);
    });
});

test('metadata normalizes vr after Value recursively inside nested sequence items', async () => {
    const input = metadata({
        '00400275': { Value: [{
            '00401001': { Value: ['SYNTHETIC-REQUEST'], vr: 'SH' },
            '00081140': { Value: [{ '00081155': { Value: ['2.25.777'], vr: 'UI' } }], vr: 'SQ' }
        }], vr: 'SQ' }
    });
    await withFetch(async () => response([input]), async () => {
        const [instance] = await client().getSeriesMetadata(studyUid, seriesUid);
        const item = instance.dataSet.find(Tag.find('00400275')).items[0];
        assert.equal(item.value(Tag.find('00401001')), 'SYNTHETIC-REQUEST');
        assert.equal(item.find(Tag.find('00081140')).items[0].value(Tag.find('00081155')), '2.25.777');
    });
});

test('inline pixel metadata is rejected before EASI can decode pixel bytes', async () => {
    const originalAtob = globalThis.atob;
    let decodes = 0;
    globalThis.atob = () => { decodes++; throw new Error('Pixel decoding must not happen while browsing metadata.'); };
    try {
        for (const tag of ['7FE00008', '7FE00009', '7FE00010']) {
            await withFetch(async () => response([metadata({ [tag]: { InlineBinary: 'AQIDBA==', vr: tag === '7FE00010' ? 'OW' : tag === '7FE00008' ? 'OF' : 'OD' } })]), async () => {
                await assert.rejects(client().getSeriesMetadata(studyUid, seriesUid), /metadata included inline Pixel Data/);
            });
        }
        assert.equal(decodes, 0);
    } finally { globalThis.atob = originalAtob; }
});

test('bounded nonpixel InlineBinary metadata remains available through EASI regardless of property order', async () => {
    await withFetch(async () => response([metadata({ '00111010': { InlineBinary: 'AQID', vr: 'OB' } })]), async () => {
        const [instance] = await client().getSeriesMetadata(studyUid, seriesUid);
        assert.deepEqual(Array.from(instance.dataSet.find(Tag.find('00111010')).value), [1, 2, 3]);
    });
});

test('series metadata rejects conflicting parents, missing identity, and duplicate SOP identities', async () => {
    for (const rows of [[metadata({ '0020000D': attr('UI', '2.25.9') })],
        [metadata({ '0020000E': attr('UI', '2.25.9') })], [series()], [metadata(), metadata()]]) {
        await withFetch(async () => response(rows), async () => assert.rejects(client().getSeriesMetadata(studyUid, seriesUid),
            /different study or series|invalid DICOM JSON|duplicate SOP/));
    }
});

test('instance retrieval requests native transfer syntax without buffering its body', async () => {
    let canceled = false;
    let pulls = 0;
    let settings;
    const body = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(Uint8Array.of(17, 31)); }, cancel() { canceled = true; } }, { highWaterMark: 0 });
    const original = new Response(body, { headers: { 'content-type': 'multipart/related; type="application/dicom"; boundary=synthetic' } });
    await withFetch(async (_url, options) => { settings = options; return original; }, async () => {
        const fetched = await client().retrieveInstance(studyUid, seriesUid, sopUid);
        assert.equal(fetched, original);
        assert.equal(pulls, 0);
        assert.equal(fetched.body.locked, false);
        assert.match(settings.headers.get('accept'), /multipart\/related; type="application\/dicom"; transfer-syntax=\*/);
        await fetched.body.cancel();
        assert.equal(canceled, true);
    });
});

test('retrieve rejects HTML, rendered JPEG, non-DICOM multipart, missing boundaries, and empty bodies', async () => {
    for (const contentType of ['text/html', 'image/jpeg', 'application/dicom+json',
        'multipart/related; type="application/dicom+json"; boundary=SYNTHETIC',
        'multipart/related; type="application/dicom"', 'multipart/related; boundary=SYNTHETIC']) {
        let canceled = false;
        const body = new ReadableStream({ cancel() { canceled = true; } });
        await withFetch(async () => new Response(body, { headers: { 'content-type': contentType } }), async () => {
            await assert.rejects(client().retrieveInstance(studyUid, seriesUid, sopUid), /readable application\/dicom/);
            assert.equal(canceled, true);
        });
    }
    await withFetch(async () => new Response(null, { status: 204 }), async () => assert.rejects(client().retrieveInstance(studyUid, seriesUid, sopUid), /readable/));
});

test('connections reject ambiguous URLs, credentials, unsupported schemes, and unknown settings', () => {
    for (const baseUrl of ['/dicom-web', 'file:///data', 'ftp://archive.invalid/', 'https://user:password@archive.invalid/',
        'https://archive.invalid/?token=SECRET', 'https://archive.invalid/#section', 'https://archive.invalid/?', 'https://archive.invalid/#']) {
        assert.throws(() => client({ baseUrl }), /base URL/);
    }
    assert.throws(() => new DicomWebClient({ baseUrl: 'https://archive.invalid', token: 'SECRET' }), /supported/);
    assert.throws(() => client({ credentials: 'always' }), /credentials/);
    assert.throws(() => client({ headers: [['Authorization', 'Bearer SECRET']] }), /plain object/);
});

test('UIDs reject path injection, empty components, nonnumeric forms, leading zeroes, and excessive length', async () => {
    for (const value of ['', '1..2', '1.', '.1', '1/../../other', '1?token=x', '1#x', '1.02', '1e2', '1\\2', '1 '.repeat(33), '1'.repeat(65)]) {
        assert.throws(() => validateDicomUid(value), /numeric DICOM UID/);
        await assert.rejects(client().listSeries(value), /numeric DICOM UID/);
    }
    assert.equal(validateDicomUid('1'.repeat(64)), '1'.repeat(64));
});

test('plain search options and pagination are validated before any HTTP request', async () => {
    let requests = 0;
    await withFetch(async () => { requests++; return response([]); }, async () => {
        for (const options of [{ offset: -1 }, { offset: 1.1 }, { limit: 0 }, { limit: 101 }, { limit: '25' }, { offset: Infinity },
            { query: 'PatientID=SECRET' }, [], null, { signal: {} }]) {
            await assert.rejects(client().searchStudies({}, options), /supported|offset|limit|AbortSignal/);
        }
        for (const filters of [{ arbitrary: 'SECRET' }, { patientId: 1 }, { patientId: 'x\nSECRET' }, { patientName: 'x'.repeat(257) }, [], null]) {
            await assert.rejects(client().searchStudies(filters), /supported|short text/);
        }
        assert.equal(requests, 0);
    });
});

test('hosts explicitly select cookies while authentication header suppliers refresh per request', async () => {
    let supplies = 0;
    const requests = [];
    const remote = client({ credentials: 'include', headers: async ({ url, signal }) => {
        assert.match(url, /^https:\/\/archive.invalid\/dicom-web\/studies/);
        assert.equal(signal, undefined);
        supplies++;
        return { Authorization: `Bearer SYNTHETIC-${supplies}`, 'X-Synthetic-Header': 'allowed' };
    } });
    await withFetch(async (_url, options) => { requests.push(options); return response([]); }, async () => {
        await remote.searchStudies();
        await remote.listSeries(studyUid);
    });
    assert.equal(supplies, 2);
    assert.equal(requests[0].headers.get('authorization'), 'Bearer SYNTHETIC-1');
    assert.equal(requests[1].headers.get('authorization'), 'Bearer SYNTHETIC-2');
    assert.equal(requests[0].credentials, 'include');
    assert.equal(requests[1].redirect, 'error');
    assert.equal(client({ credentials: 'same-origin' }).credentials, 'same-origin');
});

test('forbidden request headers and managed Accept cannot override browser or pipeline semantics', async () => {
    for (const name of ['Accept', 'Cookie', 'Host', 'Content-Length', 'Origin', 'Sec-Fetch-Site', 'Proxy-Authorization', 'Connection']) {
        assert.throws(() => client({ headers: { [name]: 'SYNTHETIC' } }), /supported DICOMweb/);
        await assert.rejects(client({ headers: async () => ({ [name]: 'SYNTHETIC' }) }).searchStudies(), /supported DICOMweb/);
    }
    assert.throws(() => client({ headers: { Authorization: 'Bearer SYNTHETIC\r\nInjected: 1' } }), /supported DICOMweb/);
});

test('authentication errors are sanitized even when a supplier throws a misleading known prefix', async () => {
    const remote = client({ headers: async () => { throw new Error('Use supported DICOMweb SECRET'); } });
    await assert.rejects(remote.searchStudies(), error => error.message === 'The host could not provide DICOMweb request headers.');
});

test('aborting while host authentication is pending prevents a late request and rejects promptly', async () => {
    let finish;
    let requests = 0;
    const controller = new AbortController();
    const remote = client({ headers: () => new Promise(resolve => { finish = resolve; }) });
    await withFetch(async () => { requests++; return response([]); }, async () => {
        const pending = remote.searchStudies({}, { signal: controller.signal });
        controller.abort();
        await assert.rejects(pending, { name: 'AbortError' });
        finish({ Authorization: 'Bearer SYNTHETIC' });
        await pause();
        assert.equal(requests, 0);
    });
});

test('a custom fetch that ignores abort cannot hold the caller or retain a late response', async () => {
    let finish;
    let canceled = false;
    const controller = new AbortController();
    await withFetch(() => new Promise(resolve => { finish = resolve; }), async () => {
        const pending = client().searchStudies({}, { signal: controller.signal });
        controller.abort();
        await assert.rejects(pending, { name: 'AbortError' });
        finish(new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { 'content-type': 'application/dicom+json' } }));
        await pause();
        assert.equal(canceled, true);
    });
});

test('aborting a pending metadata stream cancels the underlying reader and releases its lock', async () => {
    let canceled = false;
    const body = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { canceled = true; } }, { highWaterMark: 0 });
    const controller = new AbortController();
    await withFetch(async () => new Response(body, { headers: { 'content-type': 'application/dicom+json' } }), async () => {
        const pending = client().searchStudies({}, { signal: controller.signal });
        await pause();
        controller.abort();
        await assert.rejects(pending, { name: 'AbortError' });
        await pause();
        assert.equal(canceled, true);
        assert.equal(body.locked, false);
    });
});

test('HTTP failures cancel unread bodies and reveal only status, never body details or URLs', async () => {
    let canceled = false;
    await withFetch(async () => new Response(new ReadableStream({ cancel() { canceled = true; } }), { status: 401 }), async () => {
        await assert.rejects(client().searchStudies(), error => error.message === 'The DICOMweb archive returned HTTP 401.');
        assert.equal(canceled, true);
    });
    await withFetch(async () => { throw new Error('SECRET https://archive.invalid?token=SYNTH'); }, async () => {
        await assert.rejects(client().searchStudies(), error => !/SECRET|archive.invalid|SYNTH/.test(error.message));
    });
});

test('empty metadata uses 204 or [], and application/json compatibility is explicit', async () => {
    for (const make of [() => new Response(null, { status: 204 }), () => response([]),
        () => response([], { headers: { 'content-type': 'application/json; charset=utf-8' } })]) {
        await withFetch(async () => make(), async () => assert.deepEqual((await client().searchStudies()).items, []));
    }
    await withFetch(async () => new Response('', { headers: { 'content-type': 'application/dicom+json' } }), async () => {
        await assert.rejects(client().searchStudies(), /invalid DICOM JSON/);
    });
});

test('metadata Content-Type and declared byte limit reject before reading and cancel the body', async () => {
    for (const headers of [{ 'content-type': 'text/html' },
        { 'content-type': 'application/dicom+json', 'content-length': String(MAX_METADATA_BYTES + 1) }]) {
        let canceled = false;
        let reads = 0;
        const body = new ReadableStream({ pull() { reads++; }, cancel() { canceled = true; } }, { highWaterMark: 0 });
        await withFetch(async () => new Response(body, { headers }), async () => {
            await assert.rejects(client().searchStudies(), /application\/dicom\+json|8 MiB/);
            assert.equal(reads, 0);
            assert.equal(canceled, true);
            assert.equal(body.locked, false);
        });
    }
});

test('streamed metadata byte budget rejects misleading content lengths and releases input', async () => {
    let canceled = false;
    const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(MAX_METADATA_BYTES + 1)); },
        cancel() { canceled = true; } }, { highWaterMark: 0 });
    await withFetch(async () => new Response(body, { headers: { 'content-type': 'application/dicom+json', 'content-length': '1' } }), async () => {
        await assert.rejects(client().searchStudies(), /8 MiB/);
        assert.equal(canceled, true);
        assert.equal(body.locked, false);
    });
});

test('tiny stream chunks, including split multibyte Unicode, use the metadata pipeline correctly', async () => {
    const encoded = encoder.encode(JSON.stringify([study({ '00081030': attr('LO', '合成 • Synthetic MR') })]));
    let position = 0;
    const body = new ReadableStream({ pull(controller) {
        if (position === encoded.length) controller.close(); else controller.enqueue(encoded.slice(position, ++position));
    } }, { highWaterMark: 0 });
    await withFetch(async () => new Response(body, { headers: { 'content-type': 'application/dicom+json' } }), async () => {
        assert.equal((await client().searchStudies()).items[0].description, '合成 • Synthetic MR');
        assert.equal(body.locked, false);
    });
});

test('malformed JSON and DICOM metadata shape failures are explicit and sanitize response content', async () => {
    const invalid = ['[', '{"SECRET":true}', '[null]', '[42]', JSON.stringify([study({ '00100020': { vr: 'LO', Value: 'SECRET' } })]),
        JSON.stringify([study({ '00100020': { vr: 'LO', Value: ['SECRET'], BulkDataURI: 'https://secret.invalid' } })]),
        JSON.stringify([study({ '00100020': { vr: 'UNKNOWN', Value: ['SECRET'] } })]),
        JSON.stringify([study({ '00100010': attr('PN', { Unrecognized: 'SECRET' }) })]),
        JSON.stringify([study({ '00201208': attr('IS', -1) })]), JSON.stringify([study({ '0020000D': attr('UI', 'invalid') })]),
        JSON.stringify([study({ '0020000D': attr('LO', studyUid) })]),
        JSON.stringify([study({ '0020000D': attr('UI', studyUid, '2.25.999') })])];
    for (const value of invalid) {
        await withFetch(async () => new Response(value, { headers: { 'content-type': 'application/dicom+json' } }), async () => {
            await assert.rejects(client().searchStudies(), error => /invalid DICOM JSON/.test(error.message) && !/SECRET|secret.invalid/.test(error.message));
        });
    }
});
