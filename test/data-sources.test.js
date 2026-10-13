import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFiles, loadDemo, loadUrl, makeDemoFiles, MAX_SOURCE_BYTES } from '../src/data/sources.js';
import { createDicomFixture } from '../src/data/synthetic.js';

function file(options = {}) { return new File([createDicomFixture(options)], 'synthetic.dcm', { type: 'application/dicom' }); }

for (const transferSyntax of ['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']) {
    test(`EASI native parsing preserves signed high-bit pixels and metadata (${transferSyntax})`, async () => {
        const series = await loadFiles([file({ transferSyntax, bitsStored: 12, highBit: 14, signed: true,
            values: [-2048, -1, 0, 2047], slope: 2, intercept: -1000 })]);
        try {
            assert.equal(series.length, 1);
            assert.equal(series[0].frames.length, 1);
            assert.equal(series[0].cacheBytes, 0);
            const frame = await series[0].getFrame(0);
            assert.deepEqual([...frame.samples], [-2048, -1, 0, 2047]);
            assert.deepEqual(frame.range, { min: -5096, max: 3094 });
            assert.deepEqual(frame.window, { center: -1000.5, width: 8191 });
            assert.equal(frame.unit, 'HU');
            assert.deepEqual(frame.pixelSpacing, [0.75, 0.75]);
            assert.equal(series[0].cacheBytes, 8);
            assert.equal(await series[0].getFrame(0), frame);
        } finally { series.forEach(s => s.dispose()); }
        await assert.rejects(series[0].getFrame(0), /disposed/);
    });
}

test('a complete first instance is available before the rest of a local stack is parsed', async () => {
    const inputs = [
        file({ sopUid: '1.2.3.1', instanceNumber: 1, position: [0, 0, 20], values: [1, 2, 3, 4] }),
        file({ sopUid: '1.2.3.2', instanceNumber: 99, position: [0, 0, -10], values: [5, 6, 7, 8] })
    ];
    const events = [];
    const series = await loadFiles(inputs, { onSeries: async available => {
        const current = available[0];
        events.push({ count: current.frames.length, value: (await current.getFrame(0)).samples[0] });
    } });
    try {
        assert.deepEqual(events, [{ count: 1, value: 1 }, { count: 2, value: 5 }]);
        assert.deepEqual(series[0].frames.map(f => f.instanceNumber), [99, 1]);
    } finally { series.forEach(s => s.dispose()); }
});

test('different geometry in a series is split into independent consistent stacks', async () => {
    const series = await loadFiles([
        file({ sopUid: '1.2.3.1' }),
        file({ sopUid: '1.2.3.2', orientation: [0, 1, 0, 0, 0, 1] })
    ]);
    assert.equal(series.length, 2);
    series.forEach(s => s.dispose());
});

test('incomplete spatial metadata stays in a separate stack and cannot destabilize geometric sorting', async () => {
    const series = await loadFiles([
        file({ sopUid: '1.2.3.1', position: [0, 0, 20], instanceNumber: 1 }),
        file({ sopUid: '1.2.3.2', position: [0, 0, -10], instanceNumber: 99 }),
        file({ sopUid: '1.2.3.3', instanceNumber: 2, extraAttributes: { '00200032': null } })
    ]);
    try {
        assert.equal(series.length, 2);
        assert.deepEqual(series[0].frames.map(frame => frame.instanceNumber), [99, 1]);
        assert.equal(series[1].frames[0].position, null);
    } finally { series.forEach(s => s.dispose()); }
});

test('cache keys isolate distinct series even when malformed sources reuse a SOP UID', async () => {
    const series = await loadFiles([
        file({ seriesUid: '1.2.3.1', values: [11, 12, 13, 14] }),
        file({ seriesUid: '1.2.3.2', values: [21, 22, 23, 24] })
    ]);
    try {
        assert.notEqual(series[0].frames[0].id, series[1].frames[0].id);
        assert.equal((await series[0].getFrame(0)).samples[0], 11);
        assert.equal((await series[1].getFrame(0)).samples[0], 21);
    } finally { series.forEach(s => s.dispose()); }
});

test('disposing one series cancels its worker work and preserves other series in the session', async () => {
    const series = await loadFiles([
        file({ seriesUid: '1.2.3.1', values: [11, 12, 13, 14] }),
        file({ seriesUid: '1.2.3.2', values: [21, 22, 23, 24] })
    ]);
    const previousWorker = globalThis.Worker;
    const workers = [];
    class FakeWorker {
        constructor() { workers.push(this); }
        postMessage(message) { this.message = message; }
        terminate() { this.terminated = true; }
    }
    globalThis.Worker = FakeWorker;
    try {
        const first = series[0].getFrame(0);
        const firstRejected = assert.rejects(first, { name: 'AbortError' });
        const second = series[1].getFrame(0);
        assert.equal(workers.length, 1);
        series[0].dispose();
        await firstRejected;
        assert.equal(workers[0].terminated, true);
        assert.equal(workers.length, 2);
        // An already queued error from the terminated worker cannot kill its replacement.
        workers[0].onerror();
        assert.equal(workers[1].terminated, undefined);
        workers[1].onmessage({ data: { id: workers[1].message.id, samples: new Uint16Array([21, 22, 23, 24]), range: { min: 21, max: 24 } } });
        assert.equal((await second).samples[0], 21);
        assert.equal(series[1].disposed, false);
    } finally { globalThis.Worker = previousWorker; series.forEach(s => s.dispose()); }
});

test('MONOCHROME1, padding, non-HU rescale and explicit VOI metadata survive normalization', async () => {
    const series = await loadFiles([file({ photometric: 'MONOCHROME1', signed: true, bitsStored: 12,
        values: [-2048, -2047, 0, 100], padding: -2048, paddingLimit: -2047,
        slope: 2, intercept: -1000, rescaleType: 'Z_EFF', voiFunction: 'LINEAR_EXACT', window: { center: -900, width: 200 } })]);
    try {
        const frame = await series[0].getFrame(0);
        assert.equal(frame.photometric, 'MONOCHROME1');
        assert.equal(frame.unit, '');
        assert.deepEqual(frame.padding, { value: -2048, limit: -2047 });
        assert.deepEqual(frame.range, { min: -1000, max: -800 });
        assert.equal(frame.voiFunction, 'LINEAR_EXACT');
    } finally { series.forEach(s => s.dispose()); }
});

test('odd native byte counts allow one DICOM padding byte and no arbitrary extra samples', async () => {
    const series = await loadFiles([file({ rows: 1, columns: 3, bitsAllocated: 8, bitsStored: 8, values: [5, 10, 15] })]);
    try { assert.deepEqual([...(await series[0].getFrame(0)).samples], [5, 10, 15]); }
    finally { series.forEach(s => s.dispose()); }
    await assert.rejects(loadFiles([file({ rows: 1, columns: 3, bitsAllocated: 8, bitsStored: 8, rawPixelBytes: new Uint8Array(6) })]), /length/);
});

const rejectedProfiles = [
    ['compressed pixels', { transferSyntax: '1.2.840.10008.1.2.4.90' }, /uncompressed/],
    ['color', { photometric: 'RGB' }, /MONOCHROME/],
    ['enhanced geometry', { extraAttributes: { '52009230': ['SQ', new Uint8Array()] } }, /functional groups/],
    ['VOI LUT', { extraAttributes: { '00283010': ['SQ', new Uint8Array()] } }, /LUT/],
    ['modality LUT', { extraAttributes: { '00283000': ['SQ', new Uint8Array()] } }, /LUT/],
    ['presentation LUT shape', { extraAttributes: { '20500020': ['CS', 'INVERSE'] } }, /Presentation/],
    ['contradictory presentation polarity', { photometric: 'MONOCHROME1', extraAttributes: { '20500020': ['CS', 'IDENTITY'] } }, /Presentation/],
    ['SIGMOID VOI', { voiFunction: 'SIGMOID' }, /LINEAR/],
    ['missing PixelRepresentation', { extraAttributes: { '00280103': null } }, /pixel metadata/],
    ['orphan padding range', { paddingLimit: 1 }, /requires/],
    ['non-square aspect without spacing', { extraAttributes: { '00280030': null, '00280034': ['IS', '2\\1'] } }, /display-aspect/],
    ['invalid geometry', { orientation: [1, 0, 0, 1, 0, 0] }, /orientation/],
    ['variable frame times', { extraAttributes: { '00181065': ['DS', '0\\40\\60'] } }, /frame-time/]
];
for (const [name, options, expected] of rejectedProfiles) {
    test(`unsupported or invalid profile fails explicitly: ${name}`, async () => {
        await assert.rejects(loadFiles([file(options)]), expected);
    });
}

test('all synthetic demos use real EASI parsing and cine frames decode independently', async () => {
    for (const [kind, frames] of [['ct', 16], ['mr', 12], ['xr', 1], ['us', 24]]) {
        const files = makeDemoFiles(kind);
        const prefix = new Uint8Array(await files[0].slice(128, 132).arrayBuffer());
        assert.equal(new TextDecoder().decode(prefix), 'DICM');
        const series = await loadDemo(kind);
        try {
            assert.equal(series[0].frames.length, frames);
            assert.equal(series[0].cacheBytes, 0);
            const first = await series[0].getFrame(0);
            assert.ok(first.samples.length > 1000);
            if (kind === 'us') {
                const next = await series[0].getFrame(6);
                assert.equal(next.frameTime, 50);
                assert.notDeepEqual(next.samples, first.samples);
            }
        } finally { series.forEach(s => s.dispose()); }
    }
});

test('input budgets and URL validation fail before reading or fetching', async () => {
    let read = false;
    await assert.rejects(loadFiles([{ size: MAX_SOURCE_BYTES + 1, stream: () => { read = true; } }]), /256 MiB/);
    assert.equal(read, false);
    for (const url of ['file:///private/data.dcm', 'https://name:secret@example.test/a', 'relative-url']) {
        await assert.rejects(loadUrl(url), /HTTP|credentials/);
    }
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(loadDemo('ct', { signal: controller.signal }), { name: 'AbortError' });
});

test('canceling a progressive load releases previously emitted series', async () => {
    const controller = new AbortController();
    let emitted;
    await assert.rejects(loadFiles([file(), file({ sopUid: '1.2.3.4' })], {
        signal: controller.signal, onSeries: available => { emitted = available[0]; controller.abort(); }
    }), { name: 'AbortError' });
    assert.equal(emitted.disposed, true);
    assert.equal(emitted.sourceBytes, 0);
    assert.equal(emitted.frames.length, 0);
});

test('DICOMweb multipart emits a decoded first frame before the remaining response arrives', { timeout: 3000 }, async () => {
    const first = createDicomFixture({ sopUid: '1.2.3.10', values: [11, 12, 13, 14] });
    const second = createDicomFixture({ sopUid: '1.2.3.11', position: [0, 0, 2], values: [21, 22, 23, 24] });
    const encoder = new TextEncoder();
    const parts = [
        encoder.encode('--easi-boundary\r\nContent-Type: application/dicom\r\n\r\n'), first,
        encoder.encode('\r\n--easi-boundary\r\nContent-Type: application/dicom\r\n\r\n'), second,
        encoder.encode('\r\n--easi-boundary--\r\n')
    ];
    const join = list => {
        const bytes = new Uint8Array(list.reduce((sum, item) => sum + item.length, 0));
        let offset = 0;
        for (const item of list) { bytes.set(item, offset); offset += item.length; }
        return bytes;
    };
    const chunk1 = join(parts.slice(0, 3));
    const chunk2 = join(parts.slice(3));
    let releaseSecond;
    const firstReady = new Promise(resolve => { releaseSecond = resolve; });
    let remainingSent = false;
    let step = 0;
    const body = new ReadableStream({ async pull(controller) {
        if (step++ === 0) controller.enqueue(chunk1);
        else if (step === 2) { await firstReady; remainingSent = true; controller.enqueue(chunk2); }
        else controller.close();
    } });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(body, { headers: {
        'content-type': 'multipart/related; type="application/dicom"; boundary=easi-boundary',
        'content-length': String(chunk1.length + chunk2.length)
    } });
    const decoded = [];
    let series;
    try {
        series = await loadUrl('https://example.test/dicom-web/studies/1/series/2', { onSeries: async available => {
            if (decoded.length === 0) {
                assert.equal(remainingSent, false);
                decoded.push((await available[0].getFrame(0)).samples[0]);
                releaseSecond();
            }
        } });
        assert.deepEqual(decoded, [11]);
        assert.equal(series[0].frames.length, 2);
        assert.equal(remainingSent, true);
    } finally {
        releaseSecond();
        series?.forEach(s => s.dispose());
        globalThis.fetch = previousFetch;
    }
});
