import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCine, nextCineFrame, frameAtTime, readSpecialtyMetadata } from '../src/specialties/index.js';
import { metadata, cineFixture, j } from './specialties-fixtures.js';

test('cine preserves one-based trim, original indices, acquisition delay and looping dwell', async () => {
    const plan = normalizeCine(await metadata(cineFixture()));
    assert.deepEqual(plan.sequence, [1, 2, 3]); assert.deepEqual(plan.acquisitionTimesMs, [7, 27, 47, 67, 87]);
    assert.deepEqual(plan.durationsMs, [20, 20, 20]); assert.equal(plan.cycleDurationMs, 60);
    assert.deepEqual(nextCineFrame(plan, 2), { frameIndex: 3, durationMs: 20, nextSequenceIndex: 0 });
    assert.equal(frameAtTime(plan, 20).frameIndex, 2); assert.equal(frameAtTime(plan, 59).frameIndex, 3); assert.equal(frameAtTime(plan, 60).frameIndex, 1);
    assert.equal(plan.physiologicalPhase, null); assert.throws(() => plan.sequence.push(99));
});
test('sweep follows reversible edge intervals without repeating terminal endpoints', async () => {
    const plan = normalizeCine(await metadata(cineFixture({ '00181244': j('US', 1), '00280009': j('AT', '00181065'), '00181065': j('DS', 0, 10, 30, 50, 70) })));
    assert.deepEqual(plan.sequence, [1, 2, 3, 2]); assert.deepEqual(plan.durationsMs, [30, 50, 50, 30]);
    assert.deepEqual(plan.acquisitionTimesMs, [7, 17, 47, 97, 167]); assert.equal(frameAtTime(plan, 80).frameIndex, 3);
});
test('variable-time loop closure explicitly repeats final trimmed interval', async () => {
    const plan = normalizeCine(await metadata(cineFixture({ '00280009': j('AT', '00181065'), '00181065': j('DS', 0, 10, 30, 50, 70) })));
    assert.deepEqual(plan.durationsMs, [30, 50, 50]); assert.equal(plan.closurePolicy, 'repeat-last-interval');
});
test('manual and recommended playback rates do not rewrite acquisition times', async () => {
    const instance = await metadata(cineFixture({ '00082144': j('IS', 10) }));
    const recommended = normalizeCine(instance), manual = normalizeCine(instance, { manualRateFps: 25 });
    assert.equal(recommended.timing, 'recommended-display-rate'); assert.deepEqual(recommended.durationsMs, [100, 100, 100]);
    assert.equal(manual.timing, 'manual'); assert.deepEqual(manual.durationsMs, [40, 40, 40]); assert.deepEqual(manual.acquisitionTimesMs, [7, 27, 47, 67, 87]);
});
test('timing-free multi-frame cine requires explicit manual timing; single frame is static', async () => {
    const raw = cineFixture(); delete raw['00280009']; delete raw['00181063'];
    const instance = await metadata(raw); assert.throws(() => normalizeCine(instance), /timing is required/);
    assert.equal(normalizeCine(instance, { manualFrameTimeMs: 33 }).timing, 'manual');
    const single = normalizeCine(await metadata(cineFixture({ '00280008': j('IS', 1), '00082142': j('IS', 1), '00082143': j('IS', 1), '00181063': j('DS', 0) })));
    assert.equal(single.cycleDurationMs, 0); assert.equal(frameAtTime(single, 10000).frameIndex, 0);
});
for (const [name, overrides] of [
    ['nonzero first vector delta', { '00280009': j('AT', '00181065'), '00181065': j('DS', 1, 10, 20, 30, 40) }],
    ['short vector', { '00280009': j('AT', '00181065'), '00181065': j('DS', 0, 10) }],
    ['negative fixed timing', { '00181063': j('DS', -10) }], ['missing pointed timing', { '00280009': j('AT', '00181065') }],
    ['unsupported ECG increment', { '00280009': j('AT', '00181060') }], ['reversed trim', { '00082142': j('IS', 4), '00082143': j('IS', 2) }],
    ['unsupported sequencing', { '00181244': j('US', 2) }], ['zero display rate', { '00082144': j('IS', 0) }], ['excess frames', { '00280008': j('IS', 4097) }]
]) test(`cine rejects ${name}`, async () => { const instance = await metadata(cineFixture(overrides)); assert.throws(() => normalizeCine(instance), /Unsupported/); });
test('cine validates manual options and playback bounds', async () => {
    const instance = await metadata(cineFixture()), plan = normalizeCine(instance);
    assert.throws(() => normalizeCine(instance, { manualFrameTimeMs: 10, manualRateFps: 20 }), /choose one/);
    assert.throws(() => normalizeCine(instance, { manualFrameTimeMs: Infinity }), /invalid/);
    assert.throws(() => frameAtTime(plan, -1), /invalid/); assert.throws(() => nextCineFrame(plan, 99), /integer/);
});
test('metadata-only reader excludes inline pixel bytes and never dereferences BulkDataURI', async () => {
    let requested = 0; const original = globalThis.fetch; globalThis.fetch = () => { requested++; throw new Error('unexpected network'); };
    try {
        const instance = await readSpecialtyMetadata({ ...cineFixture(), '7FE00010': { vr: 'OB', BulkDataURI: 'https://example.invalid/pixels' } });
        assert.equal(normalizeCine(instance).frameCount, 5); assert.equal(requested, 0);
        await assert.rejects(readSpecialtyMetadata({ ...cineFixture(), '7FE00010': { vr: 'OB', InlineBinary: 'AA==' } }), /inline binary/);
        await assert.rejects(readSpecialtyMetadata({ ...cineFixture(), toJSON() { return { '7FE00010': { vr: 'OB', InlineBinary: 'AA==' } }; } }), /finite JSON/);
        await assert.rejects(readSpecialtyMetadata(cineFixture(), { maxBytes: 16 }), /budget/);
        const controller = new AbortController(); controller.abort(); await assert.rejects(readSpecialtyMetadata(cineFixture(), { signal: controller.signal }), { name: 'AbortError' });
    } finally { globalThis.fetch = original; }
});
