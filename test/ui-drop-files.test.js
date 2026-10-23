import test from 'node:test';
import assert from 'node:assert/strict';
import { collectDroppedFiles, isImageCandidate } from '../src/ui/drop-files.js';
import { getLocalRelativePath } from '../src/catalog/local-paths.js';

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

test('media folder drops retain DICOMDIR and nested relative paths only when requested', async () => {
    const image = Object.assign(fileEntry('IM000001'), { name: 'IM000001' });
    const nested = Object.assign(directoryEntry([[image], []]), { name: 'IMAGES' });
    const directory = Object.assign(fileEntry('DICOMDIR'), { name: 'DICOMDIR' });
    const folder = Object.assign(directoryEntry([[directory, nested], []]), { name: 'DISC' });
    const transfer = { items: [{ getAsEntry: () => folder }] };
    const files = await collectDroppedFiles(transfer, { includeDicomdir: true });
    assert.deepEqual(files.map(file => file.name), ['DICOMDIR', 'IM000001']);
    assert.deepEqual(files.map(getLocalRelativePath), ['DISC/DICOMDIR', 'DISC/IMAGES/IM000001']);
    assert.equal(files[1].webkitRelativePath, undefined);
    await assert.rejects(collectDroppedFiles(transfer, { includeDicomdir: true, maximumFiles: 1 }), /at most 1 files/);
});

test('folder import checks the aggregate source byte budget before parsing pixels', async () => {
    const folder = directoryEntry([[fileEntry('one.dcm', 12), fileEntry('two.dcm', 12)], []]);
    await assert.rejects(collectDroppedFiles({ items: [{ getAsEntry: () => folder }] }, { maximumBytes: 20 }), /source limit/);
    const files = await collectDroppedFiles({ files: [file('boundary.dcm', 20)] }, { maximumBytes: 20 });
    assert.equal(files.length, 1);
});

test('local catalog traversal bounds candidate files across directory batches and fallback selections', async () => {
    const folder = directoryEntry([[fileEntry('.DS_Store'), fileEntry('one')], [fileEntry('two.ima'), fileEntry('three')], []]);
    await assert.rejects(collectDroppedFiles({ items: [{ getAsEntry: () => folder }] }, { maximumFiles: 2 }), /at most 2 files/);
    const selected = [file('one'), file('two.ima')];
    assert.deepEqual(await collectDroppedFiles({ files: selected }, { maximumFiles: 2 }), selected);
    await assert.rejects(collectDroppedFiles({ files: [...selected, file('three')] }, { maximumFiles: 2 }), /at most 2 files/);
    for (const maximumFiles of [0, -1, 1.5, Infinity, 30001]) {
        await assert.rejects(collectDroppedFiles({ files: [] }, { maximumFiles }), /selection limit/);
    }
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
