import test from 'node:test';
import assert from 'node:assert/strict';
import EASI from '@xinonix/easi-js';
import { createDicomFixture } from '../src/data/synthetic.js';
import { loadFiles } from '../src/data/sources.js';
import { loadArchiveSeries } from '../src/data/archive-source.js';
import { resolveFrameTiming, nativePlaybackAvailable, nativePlaybackInterval } from '../src/data/frame-timing.js';

const vector = [0, 33, 55, 12], offsets = [0, 33, 88, 100], intervals = [33, 55, 12, null];
const study = '2.25.830', series = '2.25.830.1', sop = '2.25.830.1.1';
function pointer(ids, littleEndian = true) {
    const bytes = new Uint8Array(ids.length * 4), view = new DataView(bytes.buffer);
    ids.forEach((id, index) => {
        view.setUint16(index * 4, parseInt(id.slice(0, 4), 16), littleEndian);
        view.setUint16(index * 4 + 2, parseInt(id.slice(4), 16), littleEndian);
    });
    return bytes;
}

function fixture({ transferSyntax = '1.2.840.10008.1.2.1', frameCount = 4, frameVector = vector,
    frameTime = null, modality = 'US', sopClass = '1.2.840.10008.5.1.4.1.1.3.1',
    selected = frameVector == null ? frameTime == null ? null : ['00181063'] : ['00181065'] } = {}) {
    return createDicomFixture({ modality, sopClass, sopUid: sop, seriesUid: series,
        transferSyntax, frames: frameCount, rows: 2, columns: 2, values: Array.from({ length: frameCount * 4 }, (_, index) => index),
        extraAttributes: { '0020000D': ['UI', study], '00181063': frameTime == null ? null : ['DS', frameTime],
            '00181065': frameVector == null ? null : ['DS', frameVector],
            '00280009': selected == null ? null : ['AT', pointer(selected, transferSyntax !== '1.2.840.10008.1.2.2')] } });
}

async function dataSet(options) {
    return (await EASI.pipelineBuilder().fromByteStream().ofDicomData().toInstances().build()
        .process({ source: fixture(options) })).first().dataSet;
}

for (const transferSyntax of ['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']) {
    test(`Frame Time Vector preserves acquisition offsets and next-frame intervals in ${transferSyntax}`, async () => {
        const set = await dataSet({ transferSyntax });
        const timing = resolveFrameTiming(set, 4, { littleEndian: transferSyntax !== '1.2.840.10008.1.2.2' });
        assert.equal(timing.mode, 'vector'); assert.equal(timing.frameTime, null);
        assert.deepEqual(timing.frames.map(frame => frame.acquisitionOffsetMs), offsets);
        assert.deepEqual(timing.frames.map(frame => frame.nextIntervalMs), intervals);
        const sources = await loadFiles([new File([fixture({ transferSyntax })], 'synthetic-vector-us.dcm')]);
        try {
            assert.equal(nativePlaybackAvailable(sources[0].frames), true);
            assert.deepEqual(sources[0].frames.map((_, index) => nativePlaybackInterval(sources[0].frames, index)), intervals);
            const selected = await sources[0].getFrame(2);
            assert.equal(selected.timingMode, 'vector'); assert.equal(selected.acquisitionOffsetMs, 88);
            assert.equal(selected.nextIntervalMs, 12); assert.equal(selected.frameTime, null);
            assert.deepEqual([...selected.samples], [8, 9, 10, 11]);
        } finally { sources.forEach(source => source.dispose()); }
    });
}

test('fixed timing supports a recorded loop while absent timing does not manufacture50ms', async () => {
    const fixed = await loadFiles([new File([fixture({ frameVector: null, frameTime: 25 })], 'synthetic-fixed.dcm')]);
    try {
        assert.equal(nativePlaybackAvailable(fixed[0].frames), true);
        assert.equal(nativePlaybackInterval(fixed[0].frames, 3), 25);
        assert.deepEqual(fixed[0].frames.map(frame => frame.acquisitionOffsetMs), [0, 25, 50, 75]);
    } finally { fixed.forEach(source => source.dispose()); }
    const absent = await loadFiles([new File([fixture({ frameVector: null })], 'synthetic-untimed.dcm')]);
    try {
        assert.equal(nativePlaybackAvailable(absent[0].frames), false);
        assert.ok(absent[0].frames.every(frame => frame.frameTime === null && frame.timingMode === 'none' && frame.acquisitionOffsetMs === null));
    } finally { absent.forEach(source => source.dispose()); }
});

test('Frame Increment Pointer selects one declared clock when both optional timing attributes exist', async () => {
    const fixed = resolveFrameTiming(await dataSet({ frameTime: 25, selected: ['00181063'] }), 4);
    const variable = resolveFrameTiming(await dataSet({ frameTime: 25, selected: ['00181065'] }), 4);
    assert.equal(fixed.mode, 'fixed'); assert.equal(fixed.frameTime, 25);
    assert.deepEqual(fixed.frames.map(frame => frame.nextIntervalMs), [25, 25, 25, 25]);
    assert.equal(variable.mode, 'vector'); assert.equal(variable.frameTime, null);
    assert.deepEqual(variable.frames.map(frame => frame.nextIntervalMs), intervals);
});

test('a valid selected fixed clock ignores malformed unused Frame Time Vector values', async () => {
    for (const frameVector of [[80, 10, 20, 30], [0, 10], [0, 10, 'NaN', 30]]) {
        const timing = resolveFrameTiming(await dataSet({ frameTime: 25, frameVector, selected: ['00181063'] }), 4);
        assert.equal(timing.mode, 'fixed');
        assert.deepEqual(timing.frames.map(frame => frame.nextIntervalMs), [25, 25, 25, 25]);
        const sources = await loadFiles([new File([fixture({ frameTime: 25, frameVector, selected: ['00181063'] })], 'synthetic-unused-vector.dcm')]);
        try {
            assert.equal(nativePlaybackAvailable(sources[0].frames), true);
            assert.deepEqual(sources[0].frames[0].timingWarnings, []);
        } finally { sources.forEach(source => source.dispose()); }
    }
});

test('a valid selected vector clock ignores malformed unused fixed clock values', async () => {
    for (const frameTime of [0, [25, 50], 'NaN']) {
        const timing = resolveFrameTiming(await dataSet({ frameTime, selected: ['00181065'] }), 4);
        assert.equal(timing.mode, 'vector');
        assert.deepEqual(timing.frames.map(frame => frame.acquisitionOffsetMs), offsets);
    }
});

for (const sopClass of ['1.2.840.10008.5.1.4.1.1.3.1', '1.2.840.10008.5.1.4.1.1.6', '1.2.840.10008.5.1.4.1.1.6.1']) {
    test(`malformed selected US timing keeps pixels navigable without a recorded clock (${sopClass})`, async () => {
        const options = { sopClass, frameVector: [80, 33, 55, 12] };
        const set = await dataSet(options);
        assert.throws(() => resolveFrameTiming(set, 4), /Frame Time Vector/);
        const sources = await loadFiles([new File([fixture(options)], 'synthetic-invalid-us-clock.dcm')]);
        try {
            assert.equal(nativePlaybackAvailable(sources[0].frames), false);
            for (const index of [0, 3]) {
                const frame = await sources[0].getFrame(index);
                assert.equal(frame.timingMode, 'none');
                assert.equal(frame.frameTime, null);
                assert.equal(frame.acquisitionOffsetMs, null);
                assert.equal(frame.nextIntervalMs, null);
                assert.deepEqual([...frame.samples], Array.from({ length: 4 }, (_, offset) => index * 4 + offset));
                assert.deepEqual(frame.timingWarnings, ['Ignored invalid declared cine timing. Recorded playback and acquisition timing are unavailable; use manual frame navigation or a manually chosen FPS.']);
                assert.deepEqual(frame.geometryWarnings, []);
            }
            const saved = sources[0].getAttributes(0);
            assert.equal(saved.rows.find(row => row.tag === '(0018,1065)').value, '80\\33\\55\\12');
        } finally { sources.forEach(source => source.dispose()); }
    });
}

for (const [modality, sopClass] of [['CT', '1.2.840.10008.5.1.4.1.1.2'], ['MR', '1.2.840.10008.5.1.4.1.1.4'], ['CT', '1.2.840.10008.5.1.4.1.1.2.1']]) {
    test(`non-US malformed recorded timing remains rejected (${sopClass})`, async () => {
        await assert.rejects(loadFiles([new File([fixture({ modality, sopClass, frameVector: [80, 33, 55, 12] })], 'synthetic-strict-clock.dcm')]), /Frame Time Vector/);
    });
}

test('single-frame declared Frame Time zero is valid without a playback interval', async () => {
    const timing = resolveFrameTiming(await dataSet({ frameCount: 1, frameVector: null, frameTime: 0 }), 1);
    assert.equal(timing.frameTime, 0);
    assert.deepEqual(timing.frames[0], { frameIndex: 0, timingMode: 'fixed', acquisitionOffsetMs: 0, nextIntervalMs: null });
});

test('reordered, nonconsecutive and cross-instance descriptors cannot use the recorded clock', () => {
    const frames = intervals.map((nextIntervalMs, frameIndex) => ({ sopUid: sop, frameIndex, timingMode: 'vector', nextIntervalMs }));
    assert.equal(nativePlaybackAvailable(frames), true);
    assert.equal(nativePlaybackAvailable([frames[1], frames[0], frames[2], frames[3]]), false);
    assert.equal(nativePlaybackAvailable([frames[0], frames[2]]), false);
    assert.equal(nativePlaybackAvailable([frames[0], { ...frames[1], sopUid: '2.25.999' }]), false);
    assert.equal(nativePlaybackAvailable([frames[0]]), false);
    assert.equal(nativePlaybackInterval(frames, 3), null);
    assert.equal(nativePlaybackInterval(frames, -1), null);
    assert.equal(nativePlaybackInterval(frames, 0.5), null);
    assert.equal(nativePlaybackAvailable([{ ...frames[0], nextIntervalMs: 2147483648 }, frames[1]]), false);
});

function metadata() {
    const entry = (vr, ...Value) => ({ vr, Value });
    return { '00080016': entry('UI', '1.2.840.10008.5.1.4.1.1.3.1'), '00080018': entry('UI', sop),
        '00080060': entry('CS', 'US'), '0020000D': entry('UI', study), '0020000E': entry('UI', series),
        '00200032': entry('DS', 0, 0, 0), '00200037': entry('DS', 1, 0, 0, 0, 1, 0), '00280030': entry('DS', 0.75, 0.75),
        '00280002': entry('US', 1), '00280004': entry('CS', 'MONOCHROME2'), '00280008': entry('IS', 4),
        '00280009': entry('AT', '00181065'), '00181065': entry('DS', ...vector),
        '00280010': entry('US', 2), '00280011': entry('US', 2), '00280100': entry('US', 16),
        '00280101': entry('US', 16), '00280102': entry('US', 15), '00280103': entry('US', 0) };
}

test('DICOM JSON metadata and lazy archive retrieval preserve the same native variable clock', async () => {
    const result = await EASI.pipelineBuilder().fromByteStream().ofDicomMetadata().toInstances().build()
        .process({ source: new TextEncoder().encode(JSON.stringify([metadata()])) });
    const timing = resolveFrameTiming(result.first().dataSet, 4);
    assert.deepEqual(timing.frames.map(frame => frame.acquisitionOffsetMs), offsets);
    let requests = 0;
    const sources = await loadArchiveSeries({ async getSeriesMetadata() { return result.toArray(); }, async retrieveInstance() {
        requests++; return new Response(fixture(), { headers: { 'content-type': 'application/dicom' } });
    } }, study, series);
    try {
        assert.equal(requests, 0); assert.equal(nativePlaybackAvailable(sources[0].frames), true);
        const frame = await sources[0].getFrame(1);
        assert.equal(frame.timingMode, 'vector'); assert.equal(frame.acquisitionOffsetMs, 33); assert.equal(frame.nextIntervalMs, 55);
        await sources[0].getFrame(3); assert.equal(requests, 1);
    } finally { sources.forEach(source => source.dispose()); }
});

for (const [label, options] of [
    ['wrong count', { frameVector: [0, 10, 20] }], ['nonzero first delta', { frameVector: [1, 10, 20, 30] }],
    ['negative delta', { frameVector: [0, 10, -1, 30] }], ['zero subsequent delta', { frameVector: [0, 10, 0, 30] }],
    ['missing vector pointer', { selected: null }], ['ambiguous pointer', { frameTime: 25, selected: ['00181063', '00181065'] }],
    ['missing selected fixed time', { selected: ['00181063'] }], ['zero multiframe fixed time', { frameVector: null, frameTime: 0 }],
    ['multiple fixed values', { frameVector: null, frameTime: [25, 50] }], ['nonfinite delta', { frameVector: [0, 10, 'NaN', 30] }],
    ['JavaScript numeric syntax', { frameVector: [0, 10, '0x10', 30] }], ['excessive aggregate duration', { frameVector: [0, 1e20, 1e20, 1e20] }]
]) {
    test(`invalid recorded timing rejects: ${label}`, async () => {
        const set = await dataSet(options);
        assert.throws(() => resolveFrameTiming(set, 4), /frame timing metadata|Frame Time Vector/);
    });
}
