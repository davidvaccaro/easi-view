import test from 'node:test';
import assert from 'node:assert/strict';
import { ReconstructionWorkspace } from '../src/ui/ReconstructionWorkspace.js';
import { reconstructionSeries, reconstructionDom } from './reconstruction-ui-fixtures.js';
import { identityRegistration } from './volume-fixtures.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(series = [reconstructionSeries()], hooks = {}) {
    const dom = reconstructionDom(), changes = [], errors = [];
    const workspace = new ReconstructionWorkspace(dom.root, { getSeries: index => series[index], getSeriesCount: () => series.length,
        getFrame: (source, index, options) => source.getFrame(index, options), onChange: state => { changes.push(state); return hooks.onChange?.(state); }, onError: error => { errors.push(error); return hooks.onError?.(error); } });
    return { ...dom, workspace, series, changes, errors };
}
const center = f => f.workspace.probe(0, 1, 1);

test('explicit reconstruction assembles sequentially, produces four quantitative views, and exposes only operational state', async () => {
    const f = fixture(); assert.equal(f.series[0].requests.length, 0); assert.equal(f.workspace.getState().open, false);
    try {
        const opened = await f.workspace.open({ seriesIndex: 0 }); assert.equal(opened.ready, true); assert.equal(opened.busy, false); assert.equal(opened.viewCount, 4);
        assert.deepEqual(f.series[0].requests.map(item => item.index), [0, 1, 2]);
        assert.equal(opened.volumeBytes, 132); assert.deepEqual(opened.dimensions, [2, 2, 3]);
        await f.workspace.configure({ maximumSize: 2 }); assert.deepEqual(center(f), { kind: 'derived-modality', projection: 'slice', value: 111, unit: 'HU', patient: [1, 1, 1] });
        assert.ok(f.canvases().every(canvas => canvas.context.image.length === canvas.width * canvas.height * 4));
        assert.ok(!/1\.2\.|patient|sopUid|seriesUid|frameOfReferenceUid|samples|rgba|position|window/.test(JSON.stringify(f.changes)));
        assert.ok(f.changes.every(state => state.volumeBytes <= state.volumeBudget && state.derivedBytes <= state.derivedBudget));
    } finally { await f.workspace.dispose(); }
    assert.equal(f.workspace.getState().volumeBytes, 0); assert.equal(f.workspace.getState().derivedBytes, 0); assert.equal(f.root.children.length, 0);
});

test('missing geometry/FoR, unsupported output options, or pre-canceled opens fail before source acquisition', async () => {
    const source = reconstructionSeries(); source.frames.forEach(frame => delete frame.frameOfReferenceUid); const f = fixture([source]);
    assert.throws(() => f.workspace.open({ seriesIndex: 0 }), /Frame of Reference/); assert.equal(source.requests.length, 0); assert.equal(f.workspace.getState().open, false);
    assert.throws(() => f.workspace.open({ seriesIndex: 0, maxBytes: 129 * 1024 * 1024 }), /128MiB/);
    assert.throws(() => f.workspace.open({ seriesIndex: 0, unknown: true }), TypeError);
    const controller = new AbortController(); controller.abort(); assert.throws(() => f.workspace.open({ seriesIndex: 0, signal: controller.signal }), { name: 'AbortError' });
    await f.workspace.dispose();
});

test('replacement validation/retrieval failure preserves the last successful volume and every derived canvas', async () => {
    const good = reconstructionSeries(), bad = reconstructionSeries({ uid: '1.2.4' }); bad.actual[0].position = [100, 0, 0];
    const f = fixture([good, bad]);
    try {
        await f.workspace.open({ seriesIndex: 0 }); await f.workspace.configure({ maximumSize: 2 });
        const before = center(f), pixels = f.canvases().map(canvas => [...canvas.context.image]);
        await assert.rejects(f.workspace.open({ seriesIndex: 1 }), /retrieved frame identity/);
        assert.deepEqual(center(f), before); assert.deepEqual(f.canvases().map(canvas => [...canvas.context.image]), pixels);
        assert.equal(f.workspace.getState().volumeBytes, 132); assert.equal(f.workspace.getState().viewCount, 4); assert.equal(f.workspace.getState().busy, false);
        assert.throws(() => f.workspace.configure({ projection: 'unsupported' }), /bounds/);
        assert.deepEqual(center(f), before);
    } finally { await f.workspace.dispose(); }
});

test('close cancels a non-cooperative frame provider promptly and ignores its late result without restoring buffers', async () => {
    const source = reconstructionSeries(); let finish, requestedSignal;
    source.getFrame = (_index, { signal }) => { requestedSignal = signal; return new Promise(resolve => finish = resolve); };
    const f = fixture([source]); const pending = f.workspace.open({ seriesIndex: 0 }), rejected = assert.rejects(pending, { name: 'AbortError' });
    await tick(); assert.ok(f.workspace.getState().pendingVolumeBytes > 0); const done = f.workspace.close(); assert.equal(requestedSignal.aborted, true);
    await rejected; await done; assert.equal(f.workspace.getState().volumeBytes, 0); assert.equal(f.workspace.getState().derivedBytes, 0);
    finish(source.actual[0]); await tick(); assert.equal(f.workspace.getState().ready, false); assert.equal(f.workspace.getState().open, false);
    await f.workspace.dispose();
});

test('rapid view patches cancel stale render generations and retain the latest combined controls', async () => {
    const f = fixture();
    try {
        await f.workspace.open({ seriesIndex: 0 });
        const first = f.workspace.configure({ yawDeg: 20 }), rejected = assert.rejects(first, { name: 'AbortError' });
        const final = await f.workspace.configure({ pitchDeg: 30, maximumSize: 2 }); await rejected;
        assert.equal(final.busy, false); assert.equal(f.workspace.getState().viewCount, 4);
        const ranges = f.controls().filter(input => input.type === 'range');
        assert.equal(ranges[4].value, '20'); assert.equal(ranges[5].value, '30');
    } finally { await f.workspace.dispose(); }
});

test('fusion requires explicit rigid identity and keeps modalities separate; alpha/checkerboard are display operations', async () => {
    const base = reconstructionSeries(), overlay = reconstructionSeries({ uid: '1.2.4', frameOfReferenceUid: '1.2.10', modality: 'PT', unit: 'SUV' });
    const f = fixture([base, overlay]);
    try {
        await f.workspace.open({ seriesIndex: 0 }); await f.workspace.configure({ maximumSize: 2 });
        assert.throws(() => f.workspace.setFusion({ seriesIndex: 1, registration: identityRegistration }), /identifiers must match/);
        assert.equal(overlay.requests.length, 0);
        await f.workspace.setFusion({ seriesIndex: 1, registration: { ...identityRegistration, fromFrameOfReferenceUid: '1.2.9', toFrameOfReferenceUid: '1.2.10' } });
        assert.deepEqual(f.workspace.probe(3, 1, 1), { kind: 'derived-fusion', base: 111, overlay: 111, baseUnit: 'HU', overlayUnit: 'SUV', patient: [1, 1, 1] });
        await f.workspace.configure({ fusionAlpha: 0 }); assert.deepEqual(f.canvases()[3].context.image, f.canvases()[0].context.image);
        await f.workspace.configure({ fusionMode: 'checkerboard' }); assert.equal(f.workspace.getState().volumeCount, 2);
        assert.equal(f.workspace.getState().volumeBytes, 264); assert.equal(f.workspace.getState().fourth, 'fusion');
        assert.throws(() => f.workspace.setFusion({ seriesIndex: 1, registration: { matrix: new Array(16).fill(0) } }), /rigid registration/);
    } finally { await f.workspace.dispose(); }
});

test('combined base/overlay/replacement admission happens before pixel acquisition and retains a successful overlay', async () => {
    const sources = [reconstructionSeries(), reconstructionSeries({ uid: '1.2.4' })], f = fixture(sources);
    try {
        await f.workspace.open({ seriesIndex: 0, maxBytes: 300 }); await f.workspace.configure({ maximumSize: 2 });
        await f.workspace.setFusion({ seriesIndex: 1, registration: identityRegistration }); const count = sources[1].requests.length, before = f.workspace.probe(3, 1, 1);
        assert.throws(() => f.workspace.setFusion({ seriesIndex: 1, registration: identityRegistration }), /byte budget/);
        assert.throws(() => f.workspace.open({ seriesIndex: 0, maxBytes: 300 }), /byte budget/);
        assert.equal(sources[1].requests.length, count); assert.deepEqual(f.workspace.probe(3, 1, 1), before);
        assert.ok(f.changes.every(state => state.volumeBytes <= 300));
    } finally { await f.workspace.dispose(); }
});

test('derived replacement admission counts visible rollback arrays, canvases, new arrays and ImageData scratch', async () => {
    const options = { rows: 3, columns: 3, depth: 3, order: [0, 1, 2] }, f = fixture([reconstructionSeries(options), reconstructionSeries({ ...options, uid: '1.2.4' })]);
    try {
        await f.workspace.open({ seriesIndex: 0 }); await f.workspace.setFusion({ seriesIndex: 1, registration: identityRegistration });
        await f.workspace.configure({ maximumSize: 256 }); const pixels = f.canvases().map(canvas => [...canvas.context.image]);
        await assert.rejects(f.workspace.configure({ fusionAlpha: 0 }), /8MiB/);
        assert.deepEqual(f.canvases().map(canvas => [...canvas.context.image]), pixels); assert.equal(f.workspace.getState().maximumSize, 256);
        await f.workspace.configure({ maximumSize: 192 }); assert.equal(f.workspace.getState().maximumSize, 192);
        assert.ok(f.changes.every(state => state.derivedBytes <= 8 * 1024 * 1024));
    } finally { await f.workspace.dispose(); }
});

test('Canvas2D rejection rolls all panels back and does not publish a mismatched quantitative frame', async () => {
    const f = fixture();
    try {
        await f.workspace.open({ seriesIndex: 0 }); await f.workspace.configure({ maximumSize: 2 });
        const before = center(f), pixels = f.canvases().map(canvas => [...canvas.context.image]); f.canvases()[2].context.rejectNext = true;
        await assert.rejects(f.workspace.configure({ axialPosition: 0 }), /Canvas2D/);
        assert.deepEqual(center(f), before); assert.deepEqual(f.canvases().map(canvas => [...canvas.context.image]), pixels);
        assert.equal(f.workspace.getState().volumeBytes, 132);
    } finally { await f.workspace.dispose(); }
});

test('parallel3D results probe color rather than a fabricated voxel, while signed rescale remains Float64', async () => {
    const f = fixture([reconstructionSeries({ signed: true, field: () => 1, slopes: [16777217, 16777217, 16777217], intercepts: [0.25, 0.25, 0.25] })]);
    try {
        await f.workspace.open({ seriesIndex: 0, window: { center: 16777217.25, width: 2, voiFunction: 'LINEAR_EXACT' } });
        await f.workspace.configure({ maximumSize: 2 }); assert.equal(center(f).value, 16777217.25);
        assert.equal(f.canvases()[0].context.image[0], 128);
        await f.workspace.configure({ fourth: '3d', opacity: 0.2, color: 'warm' }); const probe = f.workspace.probe(3, 1, 1);
        assert.equal(probe.kind, 'parallel-ray-color'); assert.equal(probe.mode, 'composite'); assert.equal(probe.rgba.length, 4);
        assert.ok(!Object.hasOwn(probe, 'value')); assert.ok(f.series[0].actual.every(frame => frame.samples.every(value => value === 1)));
    } finally { await f.workspace.dispose(); }
});

test('host source failures are sanitized and observer failures cannot change committed reconstruction', async () => {
    const broken = reconstructionSeries(); broken.getFrame = async () => { throw new Error('secret patient body and credential https://private.invalid'); };
    const f = fixture([broken], { onError: () => Promise.reject(new Error('Ignored observer.')) });
    await assert.rejects(f.workspace.open({ seriesIndex: 0 }), error => !/secret|patient body|credential|private/.test(error.message));
    assert.equal(f.workspace.getState().volumeBytes, 0); assert.equal(f.errors.length, 1); await f.workspace.dispose(); await tick();
    const dom = reconstructionDom(), source = reconstructionSeries(), workspace = new ReconstructionWorkspace(dom.root, { getSeries: () => source, getSeriesCount: () => 1,
        getFrame: (...args) => source.getFrame(args[1], args[2]), onChange: () => Promise.reject(new Error('Ignored state observer.')) });
    await workspace.open({ seriesIndex: 0 }); assert.equal(workspace.getState().ready, true); await workspace.dispose(); await tick();
});

test('progress-observer close cancels assembly and disposal clears references without closing the host source', async () => {
    let close, f; f = fixture(undefined, { onChange: state => { if (state.progress?.completed === 1 && !close) close = f.workspace.close(); } });
    await assert.rejects(f.workspace.open({ seriesIndex: 0 }), { name: 'AbortError' }); await close;
    assert.equal(f.workspace.getState().volumeBytes, 0); assert.equal(f.workspace.getState().derivedBytes, 0);
    await f.workspace.dispose(); assert.equal(f.workspace.getState().disposed, true); assert.equal(f.series[0].actual[0].samples.length, 4);
    assert.throws(() => f.workspace.configure({}), /disposed/);
});

test('a current operation canceled before its queued start clears busy/reservations and never requests a frame', async () => {
    const f = fixture(), controller = new AbortController();
    const pending = f.workspace.open({ seriesIndex: 0, signal: controller.signal }), rejected = assert.rejects(pending, { name: 'AbortError' }); controller.abort();
    await rejected; assert.equal(f.workspace.getState().busy, false); assert.equal(f.workspace.getState().volumeBytes, 0); assert.equal(f.series[0].requests.length, 0);
    await f.workspace.dispose();
});

test('modal opening preserves original focus/inert state through replacement and restores it on close', async () => {
    const dom = reconstructionDom(), button = dom.document.createElement('button'), previouslyInert = dom.document.createElement('aside'); previouslyInert.inert = true; button.inert = false;
    dom.root.append(button, previouslyInert); button.focus(); const source = reconstructionSeries();
    const workspace = new ReconstructionWorkspace(dom.root, { getSeries: () => source, getSeriesCount: () => 1, getFrame: (_series, index, options) => source.getFrame(index, options) });
    await workspace.open({ seriesIndex: 0 }); assert.equal(button.inert, true); assert.equal(previouslyInert.inert, true);
    await workspace.open({ seriesIndex: 0 }); await workspace.close();
    assert.equal(button.inert, false); assert.equal(previouslyInert.inert, true); assert.equal(dom.document.activeElement, button);
    await workspace.dispose();
});

test('explicit modality window works without a source default, and source MONOCHROME1 polarity survives reconfiguration', async () => {
    const source = reconstructionSeries({ window: null }); for (const frame of [...source.frames, ...source.actual]) { frame.photometric = 'MONOCHROME1'; frame.presentationInvert = true; }
    const f = fixture([source]);
    try {
        await assert.rejects(f.workspace.open({ seriesIndex: 0 }), /explicit modality window/); assert.equal(f.workspace.getState().volumeBytes, 0);
        await f.workspace.open({ seriesIndex: 0, window: { center: 150, width: 300, voiFunction: 'LINEAR_EXACT' } });
        await f.workspace.configure({ maximumSize: 2 }); assert.equal(f.canvases()[0].context.image[0], 170); assert.equal(center(f).value, 111);
        await f.workspace.configure({ invert: true }); assert.equal(f.canvases()[0].context.image[0], 85); assert.equal(center(f).value, 111);
    } finally { await f.workspace.dispose(); }
});

test('aspect-changing canvas replacement never allocates a wide-new by tall-old intermediate backing', async () => {
    const tall = reconstructionSeries({ rows: 256, columns: 2, depth: 2 }), wide = reconstructionSeries({ rows: 2, columns: 256, depth: 2, uid: '1.2.4' });
    const f = fixture([tall, wide]);
    try {
        await f.workspace.open({ seriesIndex: 0 }); const axial = f.canvases()[0], previousBytes = axial.width * axial.height * 4; axial.backingPeak = previousBytes;
        await f.workspace.open({ seriesIndex: 1 }); const replacementBytes = axial.width * axial.height * 4;
        assert.equal(axial.backingPeak, Math.max(previousBytes, replacementBytes)); assert.ok(axial.width > axial.height);
    } finally { await f.workspace.dispose(); }
});

test('legal SDK custom resolutions have one bounded selected option instead of a blank UI selection', async () => {
    const f = fixture();
    try {
        await f.workspace.open({ seriesIndex: 0 }); await f.workspace.configure({ maximumSize: 16 });
        const control = f.controls().find(item => item.tagName === 'SELECT' && item.children.some(option => option.value === '128'));
        assert.equal(control.value, '16'); assert.equal(control.children.length, 4); assert.equal(control.children.at(-1).value, '16');
        await f.workspace.configure({ maximumSize: 8 }); assert.equal(control.children.length, 4); assert.equal(control.children.at(-1).value, '8');
        await f.workspace.configure({ maximumSize: 128 }); assert.equal(control.children.length, 3); assert.equal(control.value, '128');
    } finally { await f.workspace.dispose(); }
});
