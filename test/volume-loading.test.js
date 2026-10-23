import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Volume } from '../src/volume/index.js';
import { createVolumeSeries, createAxialSeries } from './volume-fixtures.js';
import { loadFiles } from '../src/data/sources.js';
import { createDicomFixture } from '../src/data/synthetic.js';

for (const syntax of ['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']) test(`published EASI pipeline/source frames construct a scoped volume (${syntax})`, async () => {
    const files = [2, 0, 1].map(z => {
        const bytes = createDicomFixture({ rows: 2, columns: 2, transferSyntax: syntax, sopUid: `2.25.910.${z + 1}`, seriesUid: '2.25.910',
            pixelSpacing: [2, 3], position: [0, 0, z * 2], values: [1 + 100 * z, 2 + 100 * z, 11 + 100 * z, 12 + 100 * z],
            extraAttributes: { '00200052': ['UI', '2.25.911'], '00180088': ['DS', 2], '00080008': ['CS', ['ORIGINAL', 'PRIMARY', 'AXIAL']],
                '00200012': ['IS', 1] } });
        return { size: bytes.length, stream: () => new Blob([bytes]).stream() };
    });
    const sources = await loadFiles(files); let volume;
    try {
        assert.equal(sources.length, 1); volume = await Volume.fromSeries(sources[0]);
        assert.equal(volume.geometry.semanticScope, 'classic-exposed-dimensions');
        assert.deepEqual([...volume.storedSamples], [1, 2, 11, 12, 101, 102, 111, 112, 201, 202, 211, 212]);
        assert.equal(volume.samplePatient([1.5, 1, 1]), 56.5);
    } finally { volume?.dispose(); sources.forEach(source => source.dispose()); }
});

test('volume construction requests one frame at a time in validated spatial order and owns exact original samples', async () => {
    const series = createVolumeSeries(), signal = new AbortController().signal, events = [];
    let active = 0, maximum = 0;
    const volume = await Volume.fromSeries(series, { signal,
        getFrame: async (index, options) => { assert.equal(options.signal, signal); active++; maximum = Math.max(maximum, active);
            await new Promise(resolve => setTimeout(resolve, 1)); active--; return series.getFrame(index, options); },
        onProgress: event => events.push(event) });
    try {
        assert.equal(maximum, 1); assert.deepEqual(series.requests.map(request => request.index), [2, 0, 1]);
        assert.deepEqual(events.map(event => event.completed), [1, 2, 3]);
        assert.equal(volume.bytes, 396); assert.equal(volume.storedAt(0, 0, 0), 190);
        assert.equal(volume.modalityValues[0], 190);
        series.actual[2].samples[0] = 65000;
        assert.equal(volume.storedAt(0, 0, 0), 190); assert.equal(volume.modalityValues[0], 190);
        assert.equal(Object.values(volume).includes(series), false);
        assert.equal(Object.values(volume).some(value => value === series.frames || value === series.actual[0]), false);
    } finally { volume.dispose(); }
});

test('per-frame rescale stays in Float64 modality values and original signed values remain separate', async () => {
    const series = createAxialSeries({ signed: true, slopes: [1, 2, 3], intercepts: [-10, 5, 100], field: (x, y, z) => -2 + x + 10 * y + 20 * z });
    const volume = await Volume.fromSeries(series);
    try {
        assert.equal(volume.storedAt(0, 0, 0), -2); assert.equal(volume.storedAt(0, 0, 1), 18); assert.equal(volume.storedAt(0, 0, 2), 38);
        assert.deepEqual([volume.modalityValues[0], volume.modalityValues[4], volume.modalityValues[8]], [-12, 41, 214]);
        assert.ok(volume.modalityValues instanceof Float64Array); assert.ok(volume.storedSamples instanceof Int16Array);
    } finally { volume.dispose(); }
});

test('modality LUT values and padding masks do not overwrite original integers, including pending archive LUT descriptors', async () => {
    const series = createAxialSeries({ signed: true, field: (x, y, z) => -2 + x + y + z, padding: { value: -2, limit: -1 } });
    const lut = { count: 5, firstMapped: -2, bits: 16, entries: Uint16Array.from([100, 200, 300, 400, 500]), pending: false };
    for (const frame of series.actual) frame.modalityLut = lut;
    for (const frame of series.frames) frame.modalityLut = { count: 5, firstMapped: -2, bits: 16, entries: null, pending: true };
    const volume = await Volume.fromSeries(series);
    try {
        assert.equal(volume.storedAt(0, 0, 0), -2); assert.equal(volume.valid[0], 0); assert.ok(Number.isNaN(volume.modalityValues[0]));
        assert.equal(volume.storedAt(1, 1, 0), 0); assert.equal(volume.modalityValues[3], 300);
        assert.equal(volume.modalityValues[11], 500); assert.equal(volume.valid[11], 1);
    } finally { volume.dispose(); }
});

test('invalid budget and geometry never request pixels', async () => {
    const series = createVolumeSeries();
    await assert.rejects(Volume.fromSeries(series, { maxBytes: 395 }), /byte budget/);
    series.frames[1].frameOfReferenceUid = '1.2.999';
    await assert.rejects(Volume.fromSeries(series), /Frame of Reference/); assert.equal(series.requests.length, 0);
});

test('invalid LUT precision/rescale conflicts reject before pixels and Float64 avoids a Float32 rescale cancellation error', async () => {
    for (const variant of ['precision', 'rescale']) {
        const series = createAxialSeries();
        for (const frame of series.frames) {
            frame.modalityLut = { count: 2, firstMapped: 0, bits: 8, entries: Uint16Array.from(variant === 'precision' ? [0, 500] : [0, 255]), pending: false };
            if (variant === 'rescale') frame.slope = 2;
        }
        await assert.rejects(Volume.fromSeries(series), /precision|conflicts with rescale/); assert.equal(series.requests.length, 0);
    }
    const volume = await Volume.fromSeries(createAxialSeries({ field: () => 1, slopes: [16777217, 16777217, 16777217], intercepts: [-16777216, -16777216, -16777216] }));
    assert.ok([...volume.modalityValues].every(value => value === 1)); volume.dispose();
});

test('missing archive scope can be enriched only when all retrieved families agree and metadata-supplied values match', async () => {
    const series = createVolumeSeries();
    for (const frame of series.actual) frame.classicDimensions = { semanticScope: 'classic-exposed-dimensions', temporalPositionIndex: 1, echoNumbers: [2] };
    const volume = await Volume.fromSeries(series);
    assert.equal(volume.geometry.semanticScope, 'classic-exposed-dimensions'); volume.dispose();
    series.actual[1].classicDimensions.echoNumbers = [3];
    await assert.rejects(Volume.fromSeries(series), /different temporal, echo/);
    series.actual[1].classicDimensions.echoNumbers = [2];
    for (const frame of series.frames) frame.classicDimensions = { temporalPositionIndex: 2 };
    await assert.rejects(Volume.fromSeries(series), /differs from its descriptor/);
});

test('cancellation after progress requests no further frame; host observer failures are isolated', async () => {
    const series = createVolumeSeries(), controller = new AbortController();
    await assert.rejects(Volume.fromSeries(series, { signal: controller.signal, onProgress: () => { controller.abort(); throw new Error('observer failed'); } }), { name: 'AbortError' });
    assert.deepEqual(series.requests.map(request => request.index), [2]);
    const volume = await Volume.fromSeries(series, { onProgress: () => Promise.reject(new Error('observer rejected')) }); volume.dispose();
    await new Promise(resolve => setTimeout(resolve, 0));
});

test('cancellation while a broker frame is pending rejects promptly and ignores a late completion', async () => {
    const series = createVolumeSeries(), controller = new AbortController(); let complete, requests = 0;
    const promise = Volume.fromSeries(series, { signal: controller.signal, getFrame: () => { requests++; return new Promise(resolve => { complete = resolve; }); } });
    controller.abort(); await assert.rejects(promise, { name: 'AbortError' });
    complete(series.actual[2]); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(requests, 1);
});

test('descriptor mutation during progress cannot change the validated affine or accept a different later frame', async () => {
    const series = createVolumeSeries(); let changed = false;
    await assert.rejects(Volume.fromSeries(series, { onProgress: () => {
        if (changed) return; changed = true;
        series.frames[0].position[0] += 10; series.actual[0].position[0] += 10;
    } }), /differs from its descriptor/);
    assert.deepEqual(series.requests.map(request => request.index), [2, 0]);
});

test('stored range validation examines actual samples after matching metadata, rather than allowing integer truncation', async () => {
    const series = createVolumeSeries();
    for (const frame of [...series.frames, ...series.actual]) { frame.bitsStored = 8; frame.highBit = 7; }
    series.actual[2].samples[0] = 300;
    await assert.rejects(Volume.fromSeries(series), /stored sample exceeds Bits Stored/);
    assert.deepEqual(series.requests.map(request => request.index), [2]);
});

for (const [name, mutate] of [
    ['identity', frame => { frame.sopUid = '1.2.777'; }], ['geometry', frame => { frame.position[0] += 1; }],
    ['rescale', frame => { frame.slope = 2; }], ['samples', frame => { frame.samples = new Uint16Array(1); }],
    ['signedness', frame => { frame.samples = new Int16Array(frame.samples); }], ['stored range', frame => { frame.samples[0] = 300; frame.bitsStored = 8; frame.highBit = 7; }]
]) test(`retrieved frame ${name} mismatch rejects without requesting later slices`, async () => {
    const series = createVolumeSeries(), frame = { ...series.actual[2], position: [...series.actual[2].position] }; mutate(frame);
    let requests = 0;
    await assert.rejects(Volume.fromSeries(series, { getFrame: () => { requests++; return frame; } }), /Unsupported reconstruction/);
    assert.equal(requests, 1);
});

test('disposal releases all owned slabs and prohibits sampling while leaving source lifetimes with the host', async () => {
    const series = createVolumeSeries(), volume = await Volume.fromSeries(series); volume.dispose(); volume.dispose();
    assert.equal(volume.bytes, 0); assert.equal(volume.storedSamples, null); assert.equal(volume.modalityValues, null); assert.equal(volume.valid, null);
    assert.throws(() => volume.samplePatient([10, 20, 30]), /disposed/);
    assert.ok(series.actual.every(frame => frame.samples.byteLength > 0));
});
