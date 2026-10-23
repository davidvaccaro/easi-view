import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDicomFixture } from '../src/data/synthetic.js';
import { discoverCorpus, classifyFailure, renderCorpusReport, renderCorpusCsv, LOCAL_SOURCE_LIMIT_BYTES } from '../tools/local-corpus.mjs';

async function temporary(t) {
    const directory = await mkdtemp(join(tmpdir(), 'easi-view-corpus-synthetic-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    return directory;
}

test('local corpus inventories sorted recursive DICOM and sniffed extensionless files without touching source bytes', async t => {
    const root = await temporary(t);
    const encoded = createDicomFixture({ rows: 2, columns: 2, values: [17, 31, 129, 201] });
    await mkdir(join(root, 'a'));
    await mkdir(join(root, 'nested'));
    await mkdir(join(root, '.hidden'));
    await mkdir(join(root, '__MACOSX'));
    for (const path of ['z.DCM', 'a.dicom', 'a/image.dcm', 'nested/extensionless', '.hidden.dcm', '.hidden/image.dcm', '__MACOSX/image.dcm', 'ignored.bin']) {
        await writeFile(join(root, path), encoded);
    }
    await writeFile(join(root, 'not-dicom'), 'Generated plain text, not DICOM');
    await writeFile(join(root, 'malformed.dcm'), 'Malformed named file must be included for reporting.');
    await symlink(join(root, 'z.DCM'), join(root, 'linked.dcm'));
    await symlink(join(root, 'nested'), join(root, 'linked-directory'));
    const files = await discoverCorpus(root);
    assert.deepEqual(files.map(file => file.relativePath), ['a.dicom', 'a/image.dcm', 'ignored.bin', 'malformed.dcm', 'nested/extensionless', 'z.DCM']);
    assert.equal(files.discoveredCount, 6);
    assert.equal(files.selectedCount, 6);
    const fingerprint = createHash('sha256').update(encoded).digest('hex');
    for (const file of files.filter(file => file.relativePath !== 'malformed.dcm')) {
        assert.equal(file.bytes, encoded.byteLength);
        assert.equal(file.sha256, fingerprint);
        assert.equal(file.overSourceLimit, false);
        assert.deepEqual(new Uint8Array(await readFile(file.path)), encoded);
    }
    const selected = await discoverCorpus(root, { limit: 2 });
    assert.deepEqual(selected.map(file => file.relativePath), ['a.dicom', 'a/image.dcm']);
    assert.equal(selected.discoveredCount, 6);
    assert.equal(selected.selectedCount, 2);
    assert.equal(selected.limit, 2);
    const matched = await discoverCorpus(root, { match: 'NESTED/' });
    assert.deepEqual(matched.map(file => file.relativePath), ['nested/extensionless']);
    assert.equal(matched.discoveredCount, 1);
});

test('missing, empty, non-directory and invalid corpus options fail explicitly', async t => {
    const root = await temporary(t);
    await assert.rejects(discoverCorpus(join(root, 'missing')), /directory does not exist/);
    await assert.rejects(discoverCorpus(root), /No matching DICOM files/);
    await writeFile(join(root, 'named.dcm'), createDicomFixture());
    await assert.rejects(discoverCorpus(join(root, 'named.dcm')), /must be a directory/);
    await symlink(root, join(root, 'root-link'));
    await assert.rejects(discoverCorpus(join(root, 'root-link')), /symbolic link/);
    for (const options of [null, [], { unknown: true }, { limit: null }, { limit: 0 }, { limit: 100001 }, { limit: 1.5 }, { limit: '2' }, { match: '' }, { match: /dcm/ }, { offset: -1 }, { signal: {} }]) {
        await assert.rejects(discoverCorpus(root, options), /options|limit|match|offset|signal/);
    }
    await assert.rejects(discoverCorpus(''), /non-empty/);
    await assert.rejects(discoverCorpus(root, { match: 'absent-name' }), /No matching DICOM files/);
});

test('oversized synthetic sparse DICOM remains inventoried with a bounded stream fingerprint', async t => {
    const root = await temporary(t);
    const path = join(root, 'oversized.dcm');
    const handle = await open(path, 'w');
    try { await handle.truncate(LOCAL_SOURCE_LIMIT_BYTES + 1); }
    finally { await handle.close(); }
    const [file] = await discoverCorpus(root);
    assert.equal(file.bytes, LOCAL_SOURCE_LIMIT_BYTES + 1);
    assert.equal(file.overSourceLimit, true);
    const zeroChunk = Buffer.alloc(64 * 1024);
    const expected = createHash('sha256');
    for (let offset = 0; offset < LOCAL_SOURCE_LIMIT_BYTES; offset += zeroChunk.length) expected.update(zeroChunk);
    expected.update(new Uint8Array([0]));
    assert.equal(file.sha256, expected.digest('hex'));
});

test('failure classification recognizes explicit profile limits and malformed inputs without disguising defects', () => {
    for (const message of ['This DICOM transfer syntax does not have a verified pixel decoder.',
        'Embedded HP color transforms require a dedicated decoding profile.',
        'Enhanced DICOM LUT and real-world value transformations require a dedicated presentation implementation.',
        'Unsupported or invalid DICOM presentation: alpha, segmented and enhanced palettes require a separate profile.',
        'Unsupported undefined-length UN sequence value.',
        'Deflated Explicit VR Little Endian datasets are not supported.',
        'This DICOM object type is outside the 2D image profile supported by this alpha.',
        'This alpha supports 8-bit and 16-bit native pixels.',
        'Classic XA mask subtraction is not supported. Open native, unsubtracted image frames.',
        'The input exceeds the 256 MiB source limit. Load a smaller series.']) {
        assert.equal(classifyFailure(message), 'unsupported', message);
    }
    for (const message of ['Invalid native image dimensions or pixel metadata.',
        'The native Pixel Data length does not match its frame count and dimensions.',
        'Invalid encapsulated Pixel Data: the frame fragment is truncated.',
        'Invalid DICOM RLE frame: a literal run is truncated.',
        'Invalid codec module size.', 'Shader compilation failed: invalid token.',
        'Compressed frame decoding failed or produced an unsupported layout.',
        'Unsupported WebGL operation.', 'A new unsupported image implementation failed.', '', null]) {
        const expected = typeof message === 'string' && /^(?:Invalid native image|The native Pixel Data|Invalid encapsulated|Invalid DICOM RLE)/.test(message) ? 'invalid' : 'unexpected';
        assert.equal(classifyFailure(message), expected, String(message));
    }
});

test('HTML reports escape hostile filenames and allowlisted text while omitting payloads and patient attributes', () => {
    const attack = '<img src="https://example.invalid/leak" onerror="alert(1)">&\'';
    const report = {
        title: `Synthetic report ${attack}`, directory: '/Users/private-corpus', discoveredCount: 8,
        patientName: 'PATIENT-SECRET', rawDicom: 'DICOM-SECRET', pixels: 'PIXEL-SECRET',
        results: [{ file: { relativePath: `nested/${attack}.dcm`, path: '/Users/private/source.dcm', bytes: 140, sha256: 'a'.repeat(64) },
            status: 'failed', stage: 'open', reason: attack, profile: { rows: 2, columns: 2, patientName: 'PATIENT-SECRET' },
            warnings: [attack], framesChecked: [0], frameCount: 3, samples: 'PIXEL-SECRET', attributes: 'DICOM-SECRET' },
        { file: { relativePath: '/Users/private/absolute.dcm', bytes: 12 }, status: 'unsupported' }]
    };
    const html = renderCorpusReport(report);
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(html.includes('&lt;img src=&quot;https://example.invalid/leak&quot;'));
    assert.ok(html.includes('&amp;&#39;'));
    assert.ok(html.includes('2 reported files of 8 discovered matching files'));
    assert.ok(html.includes('Coverage limits'));
    assert.ok(html.includes('do not establish pixel correctness'));
    assert.ok(html.includes('[absolute path omitted]'));
    assert.ok(!/<(?:img|script|iframe|link)\b/i.test(html));
    assert.ok(!/<[^>]*\s(?:src|href)\s*=/i.test(html));
    assert.ok(!/PATIENT-SECRET|DICOM-SECRET|PIXEL-SECRET|\/Users\/private/.test(html));
    assert.match(html, /default-src 'none'/);
    assert.throws(() => renderCorpusReport({}), /results array/);
});

test('human report totals count unsupported and validation rejections as unsuccessful viewing sessions', () => {
    const report = { startedAt: '2026-10-15T12:00:00Z', completedAt: '2026-10-15T20:00:00Z',
        reportedFiles: 23893, summary: { passed: 23788, failed: 0, unsupported: 97, invalid: 8 },
        coverage: { selectedFiles: 23893, discoveredFiles: 23893, completeDirectory: true, frameMode: 'all' }, results: [] };
    const before = JSON.stringify(report), html = renderCorpusReport(report);
    assert.match(html, /23893 files with reported attempts · 23788 successful viewing sessions · 105 could not complete/);
    assert.match(html, /Unexpected error \(failed\): 0/);
    assert.match(html, /Rejected by current validation \(invalid\): 8/);
    assert.match(html, /input validity requires independent review/);
    assert.match(html, /Zero unexpected errors does not mean every file opened successfully/);
    assert.match(html, /0 selected files pending without a reported outcome/);
    assert.equal(JSON.stringify(report), before);
});

test('partial reports distinguish reported attempts, pending selected files and unknown remaining coverage', () => {
    const report = { startedAt: '2026-10-15T12:00:00Z', reportedFiles: 3,
        summary: { passed: 2, failed: 0, unsupported: 0, invalid: 1 }, results: [],
        coverage: { selectedFiles: 10, discoveredFiles: 20, completeDirectory: false, frameMode: 'all' } };
    const html = renderCorpusReport(report);
    assert.match(html, /Partial run/);
    assert.match(html, /3 files with reported attempts · 2 successful viewing sessions · 1 could not complete/);
    assert.match(html, /7 selected files pending without a reported outcome/);
    assert.doesNotMatch(html, /10 files with reported attempts/);
    assert.match(renderCorpusReport({ ...report, coverage: undefined }), /Selected-file total unavailable; remaining coverage is unknown/);
    assert.match(renderCorpusReport({ ...report, summary: { passed: 10 } }), /Outcome totals need review/);
});

test('HTML labels clarify validation rejection while CSV retains original machine status', () => {
    const report = { results: [{ file: { relativePath: 'generated.dcm', bytes: 132 }, status: 'invalid', reason: 'Generated validation rejection.' }] };
    const before = JSON.stringify(report);
    assert.match(renderCorpusReport(report), /<td>Rejected by current validation \(invalid\)<\/td>/);
    assert.match(renderCorpusCsv(report), /"invalid"/);
    assert.doesNotMatch(renderCorpusCsv(report), /Rejected by current validation/);
    assert.equal(JSON.stringify(report), before);
});

test('CSV output quotes paths, prevents filename formulas and excludes arbitrary report fields', () => {
    const csv = renderCorpusCsv({ results: [{ file: { relativePath: '=SUM(1,2)".dcm', bytes: 12 },
        status: 'passed', frameCount: 4, framesChecked: 2, patientName: 'PATIENT-SECRET', pixels: 'PIXEL-SECRET' }] });
    assert.ok(csv.includes('"\'=SUM(1,2)"".dcm"'));
    assert.ok(csv.endsWith('\r\n'));
    assert.ok(!/PATIENT-SECRET|PIXEL-SECRET/.test(csv));
});
