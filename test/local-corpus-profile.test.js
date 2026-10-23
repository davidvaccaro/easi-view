import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createDicomFixture } from '../src/data/synthetic.js';
import { inspectCorpusFile } from '../tools/local-corpus-profile.mjs';

test('corpus preflight uses EASI streaming parsing but persists only technical image profile fields', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'easi-view-corpus-profile-test-'));
    const path = resolve(directory, 'generated.dcm');
    try {
        await writeFile(path, createDicomFixture({ rows: 2, columns: 3, bitsAllocated: 16, bitsStored: 12, highBit: 11,
            values: [0, 512, 1024, 2048, 3072, 4095], sopUid: '2.25.83741', seriesUid: '2.25.83742',
            description: 'PRIVATE_SOURCE_DESCRIPTION', extraAttributes: { '00100010': ['PN', 'PRIVATE^PATIENT'], '00100020': ['LO', 'PRIVATE_ID'] } }));
        const result = await inspectCorpusFile(path);
        assert.equal(result.passed, true);
        assert.equal(result.instances, 1);
        assert.equal(result.profile.hasPixelData, true);
        assert.equal(result.profile.rows, 2);
        assert.equal(result.profile.columns, 3);
        assert.equal(result.profile.bitsStored, 12);
        assert.equal(result.profile.frameCount, 1);
        assert.equal(result.profile.transferSyntax, '1.2.840.10008.1.2.1');
        assert.ok(!/PRIVATE|83741|83742|samples|patient|seriesUid|sopUid/.test(JSON.stringify(result).replace('samplesPerPixel', 'channels')));
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('malformed files get a bounded static parse reason instead of arbitrary source or exception content', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'easi-view-corpus-invalid-test-'));
    const path = resolve(directory, 'invalid.dcm');
    try {
        await writeFile(path, 'PRIVATE_MALFORMED_SOURCE');
        const result = await inspectCorpusFile(path);
        assert.equal(result.passed, false);
        assert.equal(result.profile, null);
        assert.ok(!JSON.stringify(result).includes('PRIVATE'));
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('non-image directory classes are identified from Part 10 meta without retaining directory records', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'easi-view-corpus-directory-test-'));
    const path = resolve(directory, 'DICOMDIR');
    try {
        await writeFile(path, createDicomFixture({ sopClass: '1.2.840.10008.1.3.10', rows: 2, columns: 2,
            extraAttributes: { '00080016': null, '7FE00010': null } }));
        const result = await inspectCorpusFile(path);
        assert.equal(result.passed, true);
        assert.equal(result.profile.sopClass, '1.2.840.10008.1.3.10');
        assert.equal(result.profile.hasPixelData, false);
    } finally { await rm(directory, { recursive: true, force: true }); }
});
