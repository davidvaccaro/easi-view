import test from 'node:test';
import assert from 'node:assert/strict';
import EASI from '@xinonix/easi-js';
import { createDicomFixture } from '../src/data/synthetic.js';
import { loadArchiveSeries } from '../src/data/archive-source.js';

const study = '1.2.826.0.1.3680043.10.543.900.1';
const series = '1.2.3.4', sop = '1.2.3.5';
async function client({ signed = false, retrieve, extraAttributes = {} } = {}) {
    const source = createDicomFixture({ seriesUid: series, sopUid: sop, frames: 3, rows: 2, columns: 2,
        bitsStored: 12, highBit: 11, signed, values: Array.from({ length: 12 }, (_, index) => index),
        slope: 2, intercept: -10, extraAttributes });
    const parsed = await EASI.pipelineBuilder().fromByteStream().ofDicomData().toInstances().build().process({ source });
    const calls = [];
    return { calls, retrievalMode: 'frame',
        async getSeriesMetadata() { return parsed.toArray(); },
        async retrieveInstance() { throw new Error('Complete instance retrieval is forbidden in this test.'); },
        async retrieveNativeFrame(requestStudy, requestSeries, requestSop, originalFrame, size, options) {
            calls.push(originalFrame);
            assert.deepEqual([requestStudy, requestSeries, requestSop, size], [study, series, sop, 8]);
            if (retrieve) return retrieve(originalFrame, options.signal);
            const bytes = new Uint8Array(8), view = new DataView(bytes.buffer);
            for (let index = 0; index < 4; index++) view.setUint16(index * 2, signed ? 4095 - index : originalFrame * 10 + index, true);
            return bytes;
        }
    };
}

test('explicit native frame retrieval requests only selected original frames and reuses the decoded LRU', async () => {
    const archive = await client(); const stacks = await loadArchiveSeries(archive, study, series);
    try {
        assert.equal(archive.calls.length, 0);
        const last = await stacks[0].getFrame(2);
        assert.deepEqual([...last.samples], [30, 31, 32, 33]);
        assert.deepEqual(last.range, { min: 50, max: 56 });
        assert.equal(last.frameIndex, 2); assert.equal(last.transferSyntax, '1.2.840.10008.1.2.1');
        assert.equal(last.sopUid, sop); assert.equal(last.frameTime, 50);
        const first = await stacks[0].getFrame(0); assert.deepEqual([...first.samples], [10, 11, 12, 13]);
        assert.equal(await stacks[0].getFrame(2), last);
        assert.deepEqual(archive.calls, [3, 1]);
        assert.equal(stacks[0].sourceBytes, 0); assert.equal(stacks[0]._session.encoded.bytes, 0);
        assert.equal(stacks[0].cacheBytes, 16);
    } finally { stacks.forEach(stack => stack.dispose()); }
});

test('native selected-frame decoding retains signed Bits Stored and independent rescale values', async () => {
    const archive = await client({ signed: true }); const stacks = await loadArchiveSeries(archive, study, series);
    try {
        const frame = await stacks[0].getFrame(1);
        assert.deepEqual([...frame.samples], [-1, -2, -3, -4]);
        assert.deepEqual(frame.range, { min: -18, max: -12 });
    } finally { stacks.forEach(stack => stack.dispose()); }
});

test('canceling native-frame navigation stops a pending request and never fills either cache', async () => {
    let started, canceled = false;
    const began = new Promise(resolve => { started = resolve; });
    const archive = await client({ retrieve: (_frame, signal) => new Promise((resolve, reject) => {
        started(); signal.addEventListener('abort', () => { canceled = true; reject(new DOMException('canceled', 'AbortError')); }, { once: true });
    }) });
    const stacks = await loadArchiveSeries(archive, study, series), controller = new AbortController();
    try {
        const pending = stacks[0].getFrame(0, { signal: controller.signal });
        await began; controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
        assert.equal(canceled, true); assert.equal(stacks[0].cacheBytes, 0); assert.equal(stacks[0].sourceBytes, 0);
    } finally { stacks.forEach(stack => stack.dispose()); }
});

test('invalid selected-frame byte count fails without retrying a complete instance or retaining samples', async () => {
    const archive = await client({ retrieve: async () => new Uint8Array(7) });
    const stacks = await loadArchiveSeries(archive, study, series);
    try {
        await assert.rejects(stacks[0].getFrame(0), /byte length/i);
        assert.deepEqual(archive.calls, [1]); assert.equal(stacks[0].cacheBytes, 0);
    } finally { stacks.forEach(stack => stack.dispose()); }
});
