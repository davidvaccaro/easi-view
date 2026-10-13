import test from 'node:test';
import assert from 'node:assert/strict';
import { collectDroppedFiles, isImageCandidate } from '../src/ui/drop-files.js';

function file(name, size = 10) { return { name, size }; }
function fileEntry(name, size = 10) {
    return { isFile: true, file(resolve) { queueMicrotask(() => resolve(file(name, size))); } };
}
function directoryEntry(batches, onRead = () => {}) {
    return {
        isDirectory: true,
        createReader() {
            let index = 0;
            return { readEntries(resolve) { onRead(); queueMicrotask(() => resolve(batches[index++] ?? [])); } };
        }
    };
}

test('folder drop exhausts directory-reader batches beyond the first 100 entries', async () => {
    let reads = 0;
    const first = Array.from({ length: 100 }, (_, index) => fileEntry(`${index}.dcm`));
    const folder = directoryEntry([first, [fileEntry('100.dcm')], []], () => reads++);
    const files = await collectDroppedFiles({ items: [{ kind: 'file', webkitGetAsEntry: () => folder }] });
    assert.equal(files.length, 101);
    assert.equal(files[100].name, '100.dcm');
    assert.equal(reads, 3);
});

test('folder drop recurses through nested directories and filters non-image bookkeeping', async () => {
    const nested = directoryEntry([[fileEntry('inside.dcm'), fileEntry('THUMBS.DB')], []]);
    const parent = directoryEntry([[fileEntry('.DS_Store'), nested], [fileEntry('DICOMDIR'), fileEntry('root.dcm')], []]);
    const files = await collectDroppedFiles({ items: [{ getAsEntry: () => parent }] });
    assert.deepEqual(files.map(({ name }) => name), ['inside.dcm', 'root.dcm']);
    assert.equal(isImageCandidate(file('desktop.ini')), false);
    assert.equal(isImageCandidate(file('100001')), true);
});

test('drop captures entry handles synchronously and ignores text items', async () => {
    let readable = true;
    const items = [
        { kind: 'string', webkitGetAsEntry() { throw new Error('Text entries must not be opened.'); } },
        { kind: 'file', webkitGetAsEntry() { assert.equal(readable, true); return fileEntry('image.dcm'); } }
    ];
    const selection = collectDroppedFiles({ items });
    readable = false;
    assert.equal((await selection)[0].name, 'image.dcm');
});

test('ordinary file drops fall back to FileList when entry APIs are unavailable', async () => {
    const selected = file('native.dcm');
    const files = await collectDroppedFiles({ items: [{ kind: 'file' }], files: [selected, file('DicomDir')] });
    assert.deepEqual(files, [selected]);
});

test('folder import checks the aggregate source byte budget before parsing pixels', async () => {
    const folder = directoryEntry([[fileEntry('one.dcm', 12), fileEntry('two.dcm', 12)], []]);
    await assert.rejects(collectDroppedFiles({ items: [{ getAsEntry: () => folder }] }, { maximumBytes: 20 }), /source limit/);
    const files = await collectDroppedFiles({ files: [file('boundary.dcm', 20)] }, { maximumBytes: 20 });
    assert.equal(files.length, 1);
});

test('superseding or disposing a drop cancels traversal and returns no late files', async () => {
    let current = true;
    const entry = { isFile: true, file(resolve) { current = false; queueMicrotask(() => resolve(file('late.dcm'))); } };
    await assert.rejects(collectDroppedFiles({ items: [{ getAsEntry: () => entry }] }, { isCurrent: () => current }), { name: 'AbortError' });
    await assert.rejects(collectDroppedFiles({ files: [file('image.dcm')] }, { isCurrent: () => false }), { name: 'AbortError' });
});

test('file-system read failures reach the caller as actionable errors', async () => {
    const failure = new Error('The selected directory cannot be read.');
    const folder = { isDirectory: true, createReader() { return { readEntries(resolve, reject) { reject(failure); } }; } };
    await assert.rejects(collectDroppedFiles({ items: [{ getAsEntry: () => folder }] }), failure);
});
