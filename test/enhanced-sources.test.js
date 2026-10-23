import test from 'node:test';
import assert from 'node:assert/strict';
import EASI from '@xinonix/easi-js';
import { createDicomFixture } from '../src/data/synthetic.js';
import { loadFiles } from '../src/data/sources.js';
import { loadArchiveSeries } from '../src/data/archive-source.js';
import { createCompressedDicom } from './compressed-fixtures.js';

import { studyUid, seriesUid, sopUid, sopClass, locations, expectedGroups, pixels, binaryAttributes, expectedRange,
    enhancedAttributes as attributes, createEnhancedDicom as native, createEnhancedArchive as archive, fixtureFile as file,
    dicomJson, presentationFixtures } from './enhanced-fixtures.js';
import { storedToDisplay, paletteToRgb } from '../src/data/presentation.js';

for (const transferSyntax of ['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']) {
    test(`local enhanced MR splits temporal/echo partitions and decodes original sorted frame bytes (${transferSyntax})`, async () => {
        const sources = await loadFiles([file(native(attributes(), transferSyntax))]);
        try {
            assert.deepEqual(sources.map(series => series.frames.map(frame => frame.frameIndex)), expectedGroups);
            assert.equal(new Set(sources.map(series => series.id)).size, 4);
            assert.equal(new Set(sources.flatMap(series => series.frames.map(frame => frame.id))).size, 8);
            assert.equal(sources.reduce((sum, series) => sum + series.sourceBytes, 0), 64);
            assert.equal(sources[0]._session.measureDetails().encodedCacheBytes, 64);
            assert.equal(sources[0]._session.recordOwners.size, 1);
            for (const series of sources) for (let frame = 0; frame < series.frames.length; frame++) {
                const decoded = await series.getFrame(frame), encodedIndex = series.frames[frame].frameIndex;
                assert.deepEqual([...decoded.samples], pixels[encodedIndex]);
                assert.deepEqual(decoded.range, expectedRange(encodedIndex));
                assert.equal(decoded.frameIndex, encodedIndex);
                assert.equal(decoded.dimensions.temporalPositionIndex, locations[encodedIndex][0]);
                assert.equal(decoded.dimensions.effectiveEchoTime, locations[encodedIndex][1]);
                assert.equal(decoded.littleEndian, transferSyntax !== '1.2.840.10008.1.2.2');
            }
        } finally { sources.forEach(series => series.dispose()); }
    });
}

test('local enhanced private declarations preserve frame partitioning, stored samples and attribute access', async () => {
    const object = attributes();
    const shared = object['52009229'][1][0];
    shared['20050010'] = ['LO', 'SYNTHETIC_PRIVATE_GROUP'];
    shared['20051010'] = ['SQ', [{ '20050010': ['LO', 'SYNTHETIC_NESTED_GROUP'], '20051001': ['DS', 17] }]];
    for (const frame of object['52009230'][1]) {
        frame['20050010'] = ['LO', 'SYNTHETIC_PRIVATE_GROUP'];
        frame['20051011'] = ['SQ', [{ '20050010': ['LO', 'SYNTHETIC_NESTED_GROUP'], '20051001': ['DS', 23] }]];
    }
    let parsed;
    const sources = await loadFiles([file(native(object))], { onInstance: instance => { parsed = instance; } });
    try {
        assert.deepEqual(sources.map(series => series.frames.map(frame => frame.frameIndex)), expectedGroups);
        for (const series of sources) for (let frameIndex = 0; frameIndex < series.frames.length; frameIndex++) {
            const frame = await series.getFrame(frameIndex);
            assert.deepEqual([...frame.samples], pixels[frame.frameIndex]);
            assert.deepEqual(frame.range, expectedRange(frame.frameIndex));
        }
        const items = parsed.dataSet.attributes.filter(attr => ['52009229', '52009230'].includes(attr.tag.ID))
            .flatMap(attr => attr.items);
        assert.equal(items.length, locations.length + 1);
        assert.ok(items.every(item => item.attributes.some(attr => attr.tag.ID === '20050010'
            && attr.value === 'SYNTHETIC_PRIVATE_GROUP')));
    } finally { sources.forEach(series => series.dispose()); }
});

test('local shared encoded ownership transfers accounting and releases bytes only after the last partition', async () => {
    const sources = await loadFiles([file(native())]), session = sources[0]._session;
    const record = [...sources[0]._records.values()][0];
    const other = await sources[1].getFrame(0);
    sources[0].dispose();
    assert.equal(record.bytes.byteLength, 64);
    assert.equal(session.recordOwners.get(record).size, 3);
    assert.equal(sources.reduce((sum, series) => sum + series.sourceBytes, 0), 64);
    assert.equal(await sources[1].getFrame(0), other);
    sources[1].dispose(); sources[2].dispose();
    assert.deepEqual([...(await sources[3].getFrame(1)).samples], pixels[6]);
    sources[3].dispose();
    assert.equal(record.bytes.byteLength, 0); assert.equal(session.recordOwners.size, 0);
    assert.equal(session.measureDetails().encodedCacheBytes, 0); assert.equal(session.cache.bytes, 0);
    assert.equal(session.decoder.disposed, true);
});

test('disposing a local group cancels its active frame but preserves other groups and their shared input', async () => {
    const sources = await loadFiles([file(native())]), session = sources[0]._session;
    const original = session.decoder.decode.bind(session.decoder);
    session.decoder.decode = (bytes, metadata, options) => metadata.frameIndex === 5 ?
        new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')), { once: true })) :
        original(bytes, metadata, options);
    try {
        const pending = sources[0].getFrame(0), rejected = assert.rejects(pending, { name: 'AbortError' });
        sources[0].dispose(); await rejected;
        assert.deepEqual([...(await sources[1].getFrame(0)).samples], pixels[1]);
        assert.equal(session.decoder.disposed, false); assert.equal(session.measureDetails().encodedCacheBytes, 64);
    } finally { sources.forEach(series => series.dispose()); }
});

for (const transferSyntax of ['1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']) {
    test(`archive enhanced metadata indexes groups without pixels and retains actual frame transforms/syntax (${transferSyntax})`, async () => {
        const client = await archive({ bytes: native(attributes(), transferSyntax) }), sources = await loadArchiveSeries(client, studyUid, seriesUid);
        try {
            assert.deepEqual(sources.map(series => series.frames.map(frame => frame.frameIndex)), expectedGroups);
            assert.equal(client.calls.length, 0); assert.equal(sources.reduce((sum, series) => sum + series.sourceBytes, 0), 0);
            const selected = await sources[0].getFrame(0);
            assert.deepEqual([...selected.samples], pixels[5]); assert.deepEqual(selected.range, expectedRange(5));
            assert.equal(selected.littleEndian, transferSyntax !== '1.2.840.10008.1.2.2');
            assert.equal(sources[0]._session.encoded.entries.size, 1);
            assert.equal(sources.reduce((sum, series) => sum + series.sourceBytes, 0), 64);
            for (const series of sources) await series.getFrame(1);
            assert.equal(client.calls.length, 1);
            sources[0].dispose();
            assert.equal(sources[1]._session.encoded.entries.size, 1);
            assert.deepEqual([...(await sources[3].getFrame(0)).samples], pixels[3]);
            assert.equal(client.calls.length, 1);
        } finally { sources.forEach(series => series.dispose()); }
    });
}

test('encapsulated enhanced ownership transfers one index to archive and disposes it only on final owner release', async () => {
    const fixture = await createCompressedDicom({ codec: 'rle', rows: 2, columns: 2, signed: true, bitsStored: 12,
        sopClass, sopUid, seriesUid, modality: 'MR', frameSamples: pixels, extendedOffsets: true,
        extraAttributes: { '00181063': null, '00280009': null, ...binaryAttributes(attributes()) } });
    const client = await archive({ bytes: fixture.bytes }), sources = await loadArchiveSeries(client, studyUid, seriesUid);
    const session = sources[0]._session;
    try {
        assert.deepEqual([...(await sources[0].getFrame(0)).samples], pixels[5]);
        const owned = [...session.encoded.entries.values()][0], index = owned.encapsulated;
        assert.ok(index); assert.ok(index.bytes.byteLength > 0);
        const encodedBytes = owned.bytes.byteLength;
        assert.equal(session.measureDetails().encodedCacheBytes, encodedBytes);
        assert.equal(sources.reduce((sum, series) => sum + series.sourceBytes, 0), encodedBytes);
        sources[0].dispose(); sources[1].dispose(); sources[2].dispose();
        assert.ok(index.bytes.byteLength > 0);
        assert.deepEqual([...(await sources[3].getFrame(1)).samples], pixels[6]);
        assert.equal(client.calls.length, 1);
        sources[3].dispose();
        assert.equal(index.bytes.byteLength, 0); assert.equal(owned.bytes.byteLength, 0);
        assert.equal(session.encoded.bytes, 0); assert.equal(session.cache.bytes, 0);
    } finally { sources.forEach(series => series.dispose()); }
});

test('local encapsulated enhanced groups share an index until the final group is disposed', async () => {
    const fixture = await createCompressedDicom({ codec: 'rle', rows: 2, columns: 2, signed: true, bitsStored: 12,
        sopClass, sopUid, seriesUid, frameSamples: pixels, extraAttributes: { '00181063': null, '00280009': null, ...binaryAttributes(attributes()) } });
    const sources = await loadFiles([file(fixture.bytes)]), record = [...sources[0]._records.values()][0], index = record.encapsulated;
    try {
        sources[0].dispose();
        assert.ok(index.bytes.byteLength > 0);
        assert.deepEqual([...(await sources[1].getFrame(1)).samples], pixels[4]);
        sources[1].dispose(); sources[2].dispose(); sources[3].dispose();
        assert.equal(index.bytes.byteLength, 0); assert.equal(record.bytes.byteLength, 0);
    } finally { sources.forEach(series => series.dispose()); }
});

for (const [label, change, expected] of [
    ['unselected-frame patient position', object => object['52009230'][1][7]['00209113'][1][0]['00200032'][1][2] = 100, /per-frame geometry/],
    ['temporal identity', object => object['52009230'][1][7]['00209111'][1][0]['00209128'][1] = 3, /frame dimensions/],
    ['rescale slope', object => object['52009230'][1][7]['00289145'][1][0]['00281053'][1] = 9, /per-frame transforms/],
    ['echo identity', object => object['52009230'][1][7]['00189114'][1][0]['00189082'][1] = 11, /inconsistent|frame dimensions/]
]) {
    test(`archive rejects a retrieved ${label} mismatch before retaining pixels`, async () => {
        const altered = attributes(); change(altered);
        const client = await archive({ bytes: native(altered) }), sources = await loadArchiveSeries(client, studyUid, seriesUid);
        try {
            await assert.rejects(sources[0].getFrame(0), expected);
            assert.equal(sources[0]._session.encoded.bytes, 0); assert.equal(sources[0]._session.cache.bytes, 0);
        } finally { sources.forEach(series => series.dispose()); }
    });
}

test('disposing an archive group aborts its retrieval while another partition remains navigable', async () => {
    let attempt = 0;
    const client = await archive({ retrieve(signal) {
        if (++attempt > 1) return new Response(native(), { headers: { 'content-type': 'application/dicom' } });
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')), { once: true }));
    } });
    const sources = await loadArchiveSeries(client, studyUid, seriesUid);
    try {
        const pending = sources[0].getFrame(0), rejected = assert.rejects(pending, { name: 'AbortError' });
        sources[0].dispose(); await rejected;
        assert.deepEqual([...(await sources[1].getFrame(0)).samples], pixels[1]);
        assert.equal(sources[1]._session.disposed, false);
    } finally { sources.forEach(series => series.dispose()); }
});

for (const [kind, fixture] of Object.entries(presentationFixtures())) {
    test(`local ${kind} keeps stored samples and carries its independent presentation reference`, async () => {
        const sources = await loadFiles([file(fixture.bytes)]);
        try {
            for (let index = 0; index < fixture.expectedSamples.length; index++) {
                const frame = await sources[0].getFrame(index);
                assert.deepEqual([...frame.samples], fixture.expectedSamples[index]);
                if (fixture.expectedRgb) {
                    assert.equal(frame.photometric, 'PALETTE COLOR'); assert.equal(frame.samplesPerPixel, 1);
                    assert.equal(frame.window, null);
                    assert.deepEqual([...paletteToRgb(frame.samples, frame.palette)], fixture.expectedRgb[index]);
                } else {
                    frame.samples.forEach((value, sample) => assert.ok(Math.abs(storedToDisplay(value, frame) - fixture.expectedLevels[index][sample]) < 1e-12));
                    if (kind === 'modalityLut') assert.deepEqual(frame.range, { min: 0, max: 400 });
                    if (kind === 'combinedLut') assert.deepEqual(frame.range, { min: 0, max: 3 });
                }
            }
        } finally { sources.forEach(series => series.dispose()); }
    });
}

async function presentationArchive(fixture, metadata = fixture.metadata, bytes = fixture.bytes) {
    const result = await EASI.pipelineBuilder().fromByteStream().ofDicomMetadata().toInstances().build()
        .process({ source: new TextEncoder().encode(JSON.stringify([metadata])) });
    let calls = 0;
    const client = { async getSeriesMetadata() { return result.toArray(); }, async retrieveInstance() {
        calls++; return new Response(bytes, { headers: { 'content-type': 'application/dicom' } });
    } };
    const sources = await loadArchiveSeries(client, '2.25.820', '2.25.820.1');
    return { sources, get calls() { return calls; } };
}

for (const kind of ['combinedLut', 'palette', 'palette16']) {
    test(`archive ${kind} canonical metadata tables match native retrieval and never change original samples`, async () => {
        const fixture = presentationFixtures()[kind], loaded = await presentationArchive(fixture);
        try {
            assert.equal(loaded.calls, 0);
            for (let index = 0; index < fixture.expectedSamples.length; index++) {
                const frame = await loaded.sources[0].getFrame(index);
                assert.deepEqual([...frame.samples], fixture.expectedSamples[index]);
                if (fixture.expectedRgb) assert.deepEqual([...paletteToRgb(frame.samples, frame.palette)], fixture.expectedRgb[index]);
                else frame.samples.forEach((value, sample) => assert.ok(Math.abs(storedToDisplay(value, frame) - fixture.expectedLevels[index][sample]) < 1e-12));
            }
            assert.equal(loaded.calls, 1);
        } finally { loaded.sources.forEach(series => series.dispose()); }
    });
}

test('metadata-only external palette tables remain pending until actual instance retrieval supplies the complete table', async () => {
    const fixture = presentationFixtures().palette;
    const metadata = structuredClone(fixture.metadata);
    for (const tag of ['00281201', '00281202', '00281203']) metadata[tag] = { vr: 'OW', BulkDataURI: 'https://synthetic.invalid/table-not-fetched' };
    const loaded = await presentationArchive(fixture, metadata);
    try {
        const descriptor = loaded.sources[0].frames[0];
        assert.equal(descriptor.palette.pending, true); assert.equal(descriptor.palette.red, null);
        assert.ok(!JSON.stringify(descriptor.palette).includes('synthetic.invalid'));
        const frame = await loaded.sources[0].getFrame(0);
        assert.equal(frame.palette.pending, false);
        assert.deepEqual([...paletteToRgb(frame.samples, frame.palette)], fixture.expectedRgb[0]);
        assert.equal(loaded.calls, 1);
    } finally { loaded.sources.forEach(series => series.dispose()); }
});

test('archive presentation table value mismatch rejects before retaining encoded or decoded caches', async () => {
    const fixture = presentationFixtures().combinedLut, metadata = structuredClone(fixture.metadata);
    const altered = Buffer.from(metadata['00283010'].Value[0]['00283006'].InlineBinary, 'base64');
    altered.writeUInt16LE(65, 2);
    metadata['00283010'].Value[0]['00283006'].InlineBinary = altered.toString('base64');
    const loaded = await presentationArchive(fixture, metadata);
    try {
        await assert.rejects(loaded.sources[0].getFrame(0), /table entries/);
        assert.equal(loaded.sources[0]._session.encoded.bytes, 0); assert.equal(loaded.sources[0]._session.cache.bytes, 0);
    } finally { loaded.sources.forEach(series => series.dispose()); }
});

test('enhanced per-frame SIGMOID presentation is selected without treating rescale as stored pixels', async () => {
    const object = attributes();
    object['52009229'][1][0]['00289132'] = ['SQ', [{ '00281050': ['DS', 0], '00281051': ['DS', 100], '00281056': ['CS', 'SIGMOID'] }]];
    const sources = await loadFiles([file(native(object))]);
    try {
        const frame = await sources[0].getFrame(0);
        assert.equal(frame.frameIndex, 5); assert.equal(frame.voiFunction, 'SIGMOID');
        assert.deepEqual([...frame.samples], pixels[5]);
        for (const value of frame.samples) assert.equal(storedToDisplay(value, frame), 1 / (1 + Math.exp(-4 * ((value * 6 - 600) / 100))));
    } finally { sources.forEach(series => series.dispose()); }
});

test('enhanced shared VOI LUT is supported through the presentation hook while standalone strict extraction stays separate', async () => {
    const object = attributes();
    object['52009229'][1][0]['00289132'] = ['SQ', [{ '00283010': ['SQ', [{
        '00283002': ['SS', [4, -1, 8]], '00283006': ['OW', Uint8Array.of(0, 0, 64, 0, 128, 0, 255, 0)]
    }]] }]];
    const sources = await loadFiles([file(native(object))]);
    try {
        const frame = await sources[0].getFrame(0);
        assert.equal(frame.voiMode, 'lut'); assert.equal(frame.voiLut.firstMapped, -1);
        assert.equal(new Set(sources.flatMap(series => series.frames.map(descriptor => descriptor.voiLut.entries.buffer))).size, 1);
        assert.deepEqual([...frame.voiLut.entries], [0, 64, 128, 255]);
        assert.deepEqual([...frame.samples], pixels[5]);
    } finally { sources.forEach(series => series.dispose()); }
});
