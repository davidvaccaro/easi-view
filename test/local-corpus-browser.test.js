import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { safeCorpusFailure, safeCorpusOperationFailure, writeCorpusHost } from '../tools/local-corpus-browser.mjs';

test('browser corpus failures distinguish existing profile boundaries from invalid inputs', () => {
    for (const message of ['Enhanced DICOM LUT and real-world value transformations require a dedicated presentation implementation.',
        'Unsupported or invalid DICOM presentation: alpha, segmented and enhanced palettes require a separate profile.',
        'Unsupported undefined-length UN sequence value.',
        'Deflated Explicit VR Little Endian datasets are not supported.',
        'Embedded HP color transforms require a dedicated decoding profile.']) {
        assert.equal(safeCorpusFailure(new Error(message)).status, 'unsupported');
    }
    assert.equal(safeCorpusFailure(new Error('Unsupported or invalid DICOM presentation: Window Center and Width multiplicities differ.')).status, 'invalid');
    for (const message of ['Invalid enhanced DICOM functional-group metadata.',
        'Invalid DICOM RLE frame: segment offsets are not valid increasing byte boundaries.',
        'Invalid DICOM RLE frame: the segment contains extra encoded samples.']) {
        assert.equal(safeCorpusFailure(new Error(message)).status, 'invalid');
    }
    const upload = safeCorpusFailure(new Error('The GPU could not upload this image frame (WebGL error 1282).'));
    assert.equal(upload.status, 'failed');
    assert.equal(upload.reasonCode, 'gpu-upload-failed');
});

test('unknown or metadata-bearing diagnostics stay failed without persisting arbitrary text', () => {
    for (const message of ['Unsupported patient PATIENT-SECRET',
        'Enhanced DICOM LUT and real-world value transformations require a dedicated presentation implementation. PATIENT-SECRET',
        'Unsupported or invalid DICOM presentation: PATIENT-SECRET', 'Decoder defect']) {
        const result = safeCorpusFailure(new Error(message));
        assert.equal(result.status, 'failed');
        assert.equal(result.reasonCode, 'unclassified-viewer-error');
        assert.ok(!JSON.stringify(result).includes('PATIENT-SECRET'));
    }
});

test('frame navigation retains its current classified error event through a generic SDK rejection', () => {
    const invalid = safeCorpusFailure(new Error('Invalid DICOM RLE frame: segment offsets are not valid increasing byte boundaries.'));
    const wrapper = new Error('The requested frame could not be displayed.');
    const chosen = safeCorpusOperationFailure(wrapper, 'setFrame', invalid);
    assert.equal(chosen.status, 'invalid');
    assert.notEqual(chosen, invalid);
    for (const [error, stage, event] of [[wrapper, 'setFrame', null], [wrapper, 'open', invalid],
        [new Error('PATIENT-SECRET'), 'setFrame', invalid], [wrapper, 'setFrame', safeCorpusFailure(new Error('PATIENT-SECRET'))]]) {
        const result = safeCorpusOperationFailure(error, stage, event);
        assert.equal(result.status, 'failed');
        assert.ok(!JSON.stringify(result).includes('PATIENT-SECRET'));
    }
});

test('generated browser host uses the tested classifier without a separate copy', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'easi-view-corpus-classifier-'));
    try {
        await writeCorpusHost({ directory });
        const code = await readFile(resolve(directory, 'host.js'), 'utf8');
        assert.ok(code.startsWith('const safeCorpusFailure = ' + safeCorpusFailure.toString() + ';\n'));
        assert.ok(code.includes('const safeOperationFailure = ' + safeCorpusOperationFailure.toString() + ';\n'));
        assert.ok(code.includes('operation.frameFailure'));
        assert.ok(!code.includes('export function'));
    } finally { await rm(directory, { recursive: true, force: true }); }
});
