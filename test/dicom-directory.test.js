import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocalMedia, MAX_DIRECTORY_BYTES, MAX_DIRECTORY_RECORDS } from '../src/catalog/DicomDirectory.js';
import { setLocalRelativePath } from '../src/catalog/local-paths.js';
import { createDicomdirFixture, createDicomdirMedia, mediaFixtureFiles } from './dicomdir-fixtures.js';

function directory(bytes, path = 'MEDIA/DICOMDIR') {
    const file = new File([bytes], path.split('/').at(-1));
    setLocalRelativePath(file, path);
    return file;
}
function leaf(overrides = {}) { return { type: 'IMAGE', fileId: ['IMAGES', 'IM000001'], sopUid: '2.25.100.1', ...overrides }; }
function tree(leaves = [leaf()], overrides = {}) {
    return [{ type: 'PATIENT', patientId: 'SYNTHETIC-1', patientName: 'SYNTHETIC^ONE',
        children: [{ type: 'STUDY', studyUid: '2.25.100',
            children: [{ type: 'SERIES', seriesUid: '2.25.100.2', children: leaves }] }], ...overrides }];
}
function image(path = 'MEDIA/IMAGES/IM000001') {
    const file = new File([new Uint8Array([1, 2])], path.split('/').at(-1));
    setLocalRelativePath(file, path);
    return file;
}
function tagOffset(bytes, id, start = 132, end = bytes.length) {
    const group = parseInt(id.slice(0, 4), 16), element = parseInt(id.slice(4), 16), data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = start; offset + 8 <= end; offset += 2) if (data.getUint16(offset, true) === group && data.getUint16(offset + 2, true) === element) return offset;
    throw new Error('Synthetic tag is missing.');
}
function withUint(bytes, id, value, size = 4) {
    bytes = bytes.slice(); const offset = tagOffset(bytes, id), view = new DataView(bytes.buffer);
    if (size === 4) view.setUint32(offset + 8, value, true); else view.setUint16(offset + 8, value, true);
    return bytes;
}
async function rejectsDirectory(bytes, pattern = /DICOMDIR/u) {
    await assert.rejects(resolveLocalMedia([directory(bytes), image()]), error => error.code === 'dicomdir-invalid' && pattern.test(error.message));
}
function recordOffsets(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), sequence = tagOffset(bytes, '00041220');
    const end = sequence + 12 + view.getUint32(sequence + 8, true), offsets = [];
    for (let offset = sequence + 12; offset < end;) {
        assert.equal(view.getUint16(offset, true), 0xfffe);
        assert.equal(view.getUint16(offset + 2, true), 0xe000);
        const length = view.getUint32(offset + 4, true);
        assert.notEqual(length, 0xffffffff, 'This fixture helper expects defined-length records.');
        offsets.push(offset); offset += 8 + length;
    }
    return offsets;
}
const ROOT_LINK_WARNING = 'The DICOMDIR last-root pointer was inconsistent. Verified forward directory links were used.';

test('a complete generated DICOMDIR resolves only referenced images and retains independent hierarchy expectations', async () => {
    const media = createDicomdirMedia(), files = mediaFixtureFiles(media), events = [];
    const result = await resolveLocalMedia(files, { onProgress: event => events.push(event) });
    assert.equal(result.files.length, 4);
    assert.equal(result.report.referenced, 4);
    assert.equal(result.report.resolved, 4);
    assert.equal(result.report.unreferenced, 1);
    assert.equal(result.report.mode, 'dicomdir');
    assert.equal(result.references.get(files[1]).patientId, 'MEDIA_ALPHA');
    assert.equal(result.references.get(files[1]).studyUid, media.expected.currentStudyUid);
    assert.equal(result.references.get(files[1]).seriesUid, media.expected.currentSeriesUid);
    assert.equal(result.references.get(files[1]).sopUid, media.images[0].sopUid);
    assert.ok(Object.isFrozen(result.report));
    assert.ok(Object.isFrozen(result.references.get(files[1])));
    for (const event of events) {
        assert.ok(Object.isFrozen(event));
        assert.doesNotMatch(JSON.stringify(event), /SYNTHETIC|ALPHA|IMAGES|2\.25/u);
    }
    assert.deepEqual(events.at(-1), { phase: 'media', completed: 1, total: 1, directories: 1, referenced: 4, resolved: 4, missing: 0, ambiguous: 0, invalid: 0 });
});

test('directory records from different patients keep their own hierarchy', async () => {
    const media = createDicomdirMedia({ multiPatient: true }), result = await resolveLocalMedia(mediaFixtureFiles(media));
    assert.equal(result.files.length, 5);
    assert.equal([...result.references.values()].filter(record => record.patientId === 'MEDIA_ALPHA').length, 4);
    assert.equal([...result.references.values()].filter(record => record.patientId === 'MEDIA_BETA').length, 1);
});

for (const options of [
    { undefinedLengthItems: true }, { undefinedLengthSequence: true },
    { undefinedLengthItems: true, undefinedLengthSequence: true },
    { iconSequence: true }, { iconSequence: true, undefinedLengthItems: true },
    { iconSequence: true, undefinedLengthItems: true, undefinedLengthSequence: true }
]) {
    test(`EASI parses record offsets across legal sequence/item boundaries and nested icons ${JSON.stringify(options)}`, async () => {
        const records = [...tree(), ...tree([leaf({ fileId: ['IMAGES', 'IM000002'], sopUid: '2.25.101.2' })], { patientId: 'SYNTHETIC-2' })];
        const first = image(), second = image('MEDIA/IMAGES/IM000002');
        const result = await resolveLocalMedia([directory(createDicomdirFixture(records, options)), first, second]);
        assert.deepEqual(result.files, [first, second]);
        assert.equal(result.references.get(first).patientId, 'SYNTHETIC-1');
        assert.equal(result.references.get(second).patientId, 'SYNTHETIC-2');
        assert.equal(result.report.resolved, 2);
    });
}

test('indexing does not read referenced images or unreferenced files', async () => {
    const files = mediaFixtureFiles(createDicomdirMedia());
    for (const file of files.slice(1)) Object.defineProperty(file, 'stream', { value: () => { throw new Error('Pixels must not be read.'); } });
    assert.equal((await resolveLocalMedia(files)).files.length, 4);
});

test('a missing reference yields a partial count report and does not import an unrelated decoy', async () => {
    const result = await resolveLocalMedia(mediaFixtureFiles(createDicomdirMedia({ missingReference: true })));
    assert.equal(result.report.missing, 1);
    assert.equal(result.report.resolved, 3);
    assert.equal(result.report.unreferenced, 1);
    assert.match(result.report.warnings.join(' '), /complete media folder/u);
});

test('choosing only DICOMDIR reports all absent references without scanning other folders', async () => {
    const media = createDicomdirMedia(), result = await resolveLocalMedia([mediaFixtureFiles(media)[0]]);
    assert.equal(result.files.length, 0);
    assert.equal(result.report.missing, 4);
});

test('a unique case-insensitive fallback is explicit and still resolves relative to DICOMDIR', async () => {
    const result = await resolveLocalMedia(mediaFixtureFiles(createDicomdirMedia({ caseVariant: true })));
    assert.equal(result.report.resolved, 4);
    assert.match(result.report.warnings.join(' '), /case-insensitive/u);
});

test('exact path wins over a differently cased alternate, while duplicate exact paths are ambiguous', async () => {
    const bytes = createDicomdirFixture(tree()), exact = image(), other = image('MEDIA/images/im000001');
    const found = await resolveLocalMedia([directory(bytes), exact, other]);
    assert.deepEqual(found.files, [exact]);
    assert.equal(found.report.warnings.length, 0);
    const duplicate = image();
    const ambiguous = await resolveLocalMedia([directory(bytes), exact, duplicate]);
    assert.equal(ambiguous.report.ambiguous, 1);
    assert.equal(ambiguous.files.length, 0);
});

test('case-folded collisions are ambiguous rather than guessed', async () => {
    const bytes = createDicomdirFixture(tree());
    const result = await resolveLocalMedia([directory(bytes), image('MEDIA/images/im000001'), image('MEDIA/Images/Im000001')]);
    assert.equal(result.report.ambiguous, 1);
    assert.equal(result.report.resolved, 0);
});

test('two discs with the same internal File ID resolve inside their own granted roots', async () => {
    const bytes = createDicomdirFixture(tree()), first = image('DISC1/IMAGES/IM000001'), second = image('DISC2/IMAGES/IM000001');
    const result = await resolveLocalMedia([directory(bytes, 'DISC1/DICOMDIR'), first, directory(bytes, 'DISC2/DICOMDIR'), second]);
    assert.deepEqual(result.files, [first, second]);
    assert.equal(result.report.directories, 2);
});

for (const fileId of [['..', 'IM000001'], ['.', 'IM000001'], ['/private'], ['C:', 'PRIVATE'], ['https:', 'SECRET'], ['IMAGES/PRIVATE'], ['IMAGES', ''], Array(9).fill('A')]) {
    test(`unsafe File ID components never escape local media (${JSON.stringify(fileId)})`, async () => {
        const result = await resolveLocalMedia([directory(createDicomdirFixture(tree([leaf({ fileId })]))), image()]);
        assert.equal(result.report.invalid, 1);
        assert.equal(result.report.resolved, 0);
    });
}

test('safe nonstandard filenames are accepted with an explicit warning', async () => {
    const result = await resolveLocalMedia([directory(createDicomdirFixture(tree([leaf({ fileId: ['images', 'scan.dcm'] })]))), image('MEDIA/images/scan.dcm')]);
    assert.equal(result.report.resolved, 1);
    assert.match(result.report.warnings.join(' '), /nonstandard/u);
});

test('NUL characters in File IDs cannot disappear as generic text padding', async () => {
    for (const fileId of [['IMAGES', 'PRIV\0ATE'], ['IMAGES', 'PRIVATE\0']]) {
        const result = await resolveLocalMedia([directory(createDicomdirFixture(tree([leaf({ fileId })]))), image()]);
        assert.equal(result.report.invalid, 1);
        assert.equal(result.files.length, 0);
    }
});

test('a duplicate reference rejects both identities instead of first-reference-wins', async () => {
    const result = await resolveLocalMedia([directory(createDicomdirFixture(tree([leaf(), leaf({ sopUid: '2.25.101.2' })]))), image()]);
    assert.equal(result.report.referenced, 2);
    assert.equal(result.report.resolved, 0);
    assert.equal(result.report.invalid, 2);
});

test('referencing DICOMDIR as an image is rejected', async () => {
    const result = await resolveLocalMedia([directory(createDicomdirFixture(tree([leaf({ fileId: ['DICOMDIR'] })])))]);
    assert.equal(result.report.invalid, 1);
    assert.equal(result.report.resolved, 0);
});

test('inactive records remain traversable but neither they nor their child images are imported', async () => {
    const inactiveLeaf = leaf({ active: false }), activeLeaf = leaf({ fileId: ['IMAGES', 'IM000002'], sopUid: '2.25.100.2' });
    const result = await resolveLocalMedia([directory(createDicomdirFixture(tree([inactiveLeaf, activeLeaf]))), image(), image('MEDIA/IMAGES/IM000002')]);
    assert.equal(result.report.inactive, 1);
    assert.equal(result.report.referenced, 1);
    assert.equal(result.report.resolved, 1);
    const inactiveParent = await resolveLocalMedia([directory(createDicomdirFixture(tree([leaf()], { active: false }))), image()]);
    assert.equal(inactiveParent.report.inactive, 1);
    assert.equal(inactiveParent.report.referenced, 0);
});

test('reserved nonzero in-use flags are interpreted as active as prescribed by the standard', async () => {
    const result = await resolveLocalMedia([directory(withUint(createDicomdirFixture(tree()), '00041410', 1, 2)), image()]);
    assert.equal(result.report.resolved, 1);
    assert.match(result.report.warnings.join(' '), /reserved nonzero/u);
});

test('non-image file references are reported separately and are not claimed as viewable images', async () => {
    const result = await resolveLocalMedia([directory(createDicomdirFixture(tree([leaf({ type: 'SR DOCUMENT' })]))), image()]);
    assert.equal(result.report.referenced, 1);
    assert.equal(result.report.unsupported, 1);
    assert.equal(result.files.length, 0);
});

test('a valid empty directory is an empty index rather than a broad folder scan', async () => {
    const result = await resolveLocalMedia([directory(createDicomdirFixture([])), image()]);
    assert.equal(result.files.length, 0);
    assert.equal(result.report.unreferenced, 1);
});

test('zero root offsets never guess a physical record ordering', async () => {
    await rejectsDirectory(createDicomdirFixture(tree(), { firstRootOffset: 0, lastRootOffset: 0 }), /root links/u);
});

test('dangling, cyclic, and shared-child traversal offsets are rejected', async () => {
    const bytes = createDicomdirFixture(tree()), first = new DataView(bytes.buffer).getUint32(tagOffset(bytes, '00041200') + 8, true);
    await rejectsDirectory(createDicomdirFixture(tree(), { firstRootOffset: 1 }), /outside/u);
    await rejectsDirectory(createDicomdirFixture(tree(), { links: { 0: { next: first } } }), /cyclic/u);
    await rejectsDirectory(createDicomdirFixture(tree(), { links: { 1: { child: first } } }), /cyclic/u);
});

for (const value of [0, 1, 0xffffffff]) {
    test(`a valid forward root chain tolerates unused last-root offset ${value} with a warning`, async () => {
        const file = image(), decoy = image('MEDIA/UNLISTED/IM000001');
        const result = await resolveLocalMedia([directory(createDicomdirFixture(tree(), { lastRootOffset: value })), file, decoy]);
        assert.deepEqual(result.files, [file]);
        assert.equal(result.references.get(file).patientId, 'SYNTHETIC-1');
        assert.equal(result.report.referenced, 1);
        assert.equal(result.report.resolved, 1);
        assert.equal(result.report.unreferenced, 1);
        assert.deepEqual(result.report.warnings, [ROOT_LINK_WARNING]);
    });
}

for (const [index, name] of [[1, 'STUDY'], [2, 'SERIES'], [3, 'IMAGE']]) {
    test(`a last-root pointer to a visited ${name} never reparents that record`, async () => {
        const bytes = createDicomdirFixture(tree()), offsets = recordOffsets(bytes), file = image();
        const result = await resolveLocalMedia([directory(withUint(bytes, '00041202', offsets[index])), file]);
        assert.deepEqual(result.files, [file]);
        assert.equal(result.references.get(file).patientId, 'SYNTHETIC-1');
        assert.equal(result.references.get(file).studyUid, '2.25.100');
        assert.equal(result.references.get(file).seriesUid, '2.25.100.2');
        assert.deepEqual(result.report.warnings, [ROOT_LINK_WARNING]);
    });
}

test('a stale last-root pointer to an earlier visited patient preserves both linked patient identities', async () => {
    const records = [...tree(), ...tree([leaf({ fileId: ['IMAGES', 'IM000002'], sopUid: '2.25.101.2' })], { patientId: 'SYNTHETIC-2' })];
    const bytes = createDicomdirFixture(records), offsets = recordOffsets(bytes), first = image(), second = image('MEDIA/IMAGES/IM000002');
    const result = await resolveLocalMedia([directory(withUint(bytes, '00041202', offsets[0])), first, second]);
    assert.deepEqual(result.files, [first, second]);
    assert.equal(result.references.get(first).patientId, 'SYNTHETIC-1');
    assert.equal(result.references.get(second).patientId, 'SYNTHETIC-2');
    assert.equal(result.report.resolved, 2);
    assert.deepEqual(result.report.warnings, [ROOT_LINK_WARNING]);
});

for (const target of ['detached-patient', 'outside', 'zero', 'visited-image']) {
    test(`a mismatched last-root pointer (${target}) cannot hide an unlinked active patient`, async () => {
        const records = [...tree(), ...tree([leaf({ fileId: ['IMAGES', 'IM000002'], sopUid: '2.25.101.2' })], { patientId: 'SYNTHETIC-2' })];
        const bytes = createDicomdirFixture(records, { links: { 0: { next: 0 } } }), offsets = recordOffsets(bytes);
        const targetOffset = target === 'detached-patient' ? offsets[4] : target === 'visited-image' ? offsets[3] : target === 'zero' ? 0 : 1;
        await rejectsDirectory(withUint(bytes, '00041202', targetOffset), /root chain is incomplete: active root records are unlinked/u);
    });
}

test('a reserved nonzero record flag still makes a detached patient active for the ambiguity guard', async () => {
    const records = [...tree(), ...tree([leaf({ sopUid: '2.25.101.2' })], { patientId: 'SYNTHETIC-2' })];
    const bytes = createDicomdirFixture(records, { links: { 0: { next: 0 } }, lastRootOffset: 1 }), offsets = recordOffsets(bytes);
    const flag = tagOffset(bytes, '00041410', offsets[4] + 8, offsets[5]);
    new DataView(bytes.buffer).setUint16(flag + 8, 1, true);
    await rejectsDirectory(bytes, /root chain is incomplete: active root records are unlinked/u);
});

test('an inactive detached patient is ignored while a mismatched last-root pointer is reported', async () => {
    const records = [...tree(), ...tree([leaf({ fileId: ['IMAGES', 'IM000002'], sopUid: '2.25.101.2' })], { patientId: 'SYNTHETIC-2', active: false })];
    const file = image(), other = image('MEDIA/IMAGES/IM000002');
    const result = await resolveLocalMedia([directory(createDicomdirFixture(records, { links: { 0: { next: 0 } }, lastRootOffset: 1 })), file, other]);
    assert.deepEqual(result.files, [file]);
    assert.equal(result.references.has(other), false);
    assert.equal(result.report.resolved, 1);
    assert.equal(result.report.unreferenced, 1);
    assert.ok(result.report.warnings.includes(ROOT_LINK_WARNING));
    assert.match(result.report.warnings.join(' '), /Unlinked/u);
});

test('a nonzero root offset cannot turn an empty directory into a recoverable index', async () => {
    await rejectsDirectory(createDicomdirFixture([], { firstRootOffset: 1 }));
    await rejectsDirectory(createDicomdirFixture([], { lastRootOffset: 1 }));
});

test('missing and malformed last-root attributes remain fatal rather than triggering recovery', async () => {
    const missing = createDicomdirFixture(tree()), missingOffset = tagOffset(missing, '00041202');
    new DataView(missing.buffer).setUint16(missingOffset + 2, 0x1204, true);
    await rejectsDirectory(missing, /missing or invalid directory offset/u);
    const malformed = createDicomdirFixture(tree()), malformedOffset = tagOffset(malformed, '00041202');
    new DataView(malformed.buffer).setUint16(malformedOffset + 6, 2, true);
    const shortened = new Uint8Array(malformed.length - 2);
    shortened.set(malformed.subarray(0, malformedOffset + 10));
    shortened.set(malformed.subarray(malformedOffset + 12), malformedOffset + 10);
    await rejectsDirectory(shortened, /missing or invalid directory offset/u);
});

test('a nonsensical patient hierarchy is rejected rather than relabeling its image', async () => {
    await rejectsDirectory(createDicomdirFixture([leaf()]), /hierarchy/u);
    await rejectsDirectory(createDicomdirFixture([{ type: 'PATIENT', children: [leaf()] }]), /hierarchy/u);
});

test('legacy unlinked physical records are ignored explicitly', async () => {
    const records = [...tree(), ...tree([leaf({ sopUid: '2.25.101.1' })], { patientId: 'SECOND' })];
    const bytes = createDicomdirFixture(records);
    const first = new DataView(bytes.buffer).getUint32(tagOffset(bytes, '00041200') + 8, true);
    const result = await resolveLocalMedia([directory(createDicomdirFixture(records, { lastRootOffset: first, links: { 0: { next: 0 } } })), image()]);
    assert.equal(result.report.resolved, 1);
    assert.match(result.report.warnings.join(' '), /Unlinked/u);
});

test('invalid SOP/transfer-syntax identity skips that reference', async () => {
    for (const override of [{ sopUid: 'no-uid' }, { sopClassUid: '' }, { transferSyntaxUid: '0.01.2' }]) {
        const result = await resolveLocalMedia([directory(createDicomdirFixture(tree([leaf(override)]))), image()]);
        assert.equal(result.report.invalid, 1);
        assert.equal(result.files.length, 0);
    }
});

test('the actual referenced image extension never filters an authoritative reference', async () => {
    const result = await resolveLocalMedia([directory(createDicomdirFixture(tree([leaf({ fileId: ['IMAGES', 'scan.txt'] })]))), image('MEDIA/IMAGES/scan.txt')]);
    assert.equal(result.report.resolved, 1);
});

test('without DICOMDIR every file extension remains eligible for content-based indexing', async () => {
    const files = ['scan.dcm', 'IM000001', 'scan.ima', 'image.jpeg', 'scan.txt', 'README.TXT', '.DS_Store', 'thumbs.db', 'desktop.ini'].map(name => image(`MEDIA/${name}`));
    const result = await resolveLocalMedia(files);
    assert.deepEqual(result.files, files.slice(0, 6));
    assert.equal(result.report.mode, 'files');
    assert.equal(result.references.size, 0);
});

test('ordinary file imports preserve exact-File multiplicity for catalog duplicate reporting', async () => {
    const file = image();
    const result = await resolveLocalMedia([file, file]);
    assert.deepEqual(result.files, [file, file]);
});

test('malformed Part 10 and a declared inconsistent file-set fail without a fallback scan', async () => {
    await rejectsDirectory(new Uint8Array(160));
    await rejectsDirectory(createDicomdirFixture(tree()).slice(0, -3));
    await rejectsDirectory(withUint(createDicomdirFixture(tree()), '00041212', 65535, 2), /inconsistent/u);
    const bytes = createDicomdirFixture(tree());
    const offset = tagOffset(bytes, '00020002'); bytes[offset + 8] = 88;
    await rejectsDirectory(bytes, /Media Storage Directory/u);
});

test('oversized indexes and excessive input counts are rejected before opening a stream', async () => {
    let opened = false;
    const oversized = { name: 'DICOMDIR', size: MAX_DIRECTORY_BYTES + 1, stream() { opened = true; throw new Error('Do not open.'); } };
    await assert.rejects(resolveLocalMedia([oversized]), /16 MiB/u);
    assert.equal(opened, false);
    const file = image();
    await assert.rejects(resolveLocalMedia(Array(30001).fill(file)), error => error.code === 'file-limit');
});

test('directory record count is bounded independently of image count', async () => {
    const records = Array.from({ length: MAX_DIRECTORY_RECORDS + 1 }, () => ({ type: 'PRIVATE' }));
    await rejectsDirectory(createDicomdirFixture(records), /30,000-record/u);
});

test('cancellation unblocks pending directory reads and releases their stream lock', async () => {
    let source, canceled = false, opened;
    const didOpen = new Promise(resolve => { opened = resolve; });
    const file = { name: 'DICOMDIR', size: 200,
        stream() { source = new ReadableStream({ start() { opened(); }, pull() { return new Promise(() => {}); }, cancel() { canceled = true; } }); return source; } };
    const controller = new AbortController(), pending = resolveLocalMedia([file], { signal: controller.signal });
    await didOpen;
    controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.equal(canceled, true);
    assert.equal(source.locked, false);
});

test('canceling a completed progress callback cannot commit a resolved result', async () => {
    const controller = new AbortController();
    await assert.rejects(resolveLocalMedia(mediaFixtureFiles(createDicomdirMedia()), {
        signal: controller.signal, onProgress: event => { if (event.completed === 1) controller.abort(); }
    }), error => error.name === 'AbortError');
});

test('pre-abort and invalid callback/signal fail before reading', async () => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(resolveLocalMedia([], { signal: controller.signal }), error => error.name === 'AbortError');
    await assert.rejects(resolveLocalMedia([], { onProgress: true }), /callback/u);
    await assert.rejects(resolveLocalMedia([], { signal: {} }), /AbortSignal/u);
});
