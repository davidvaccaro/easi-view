import test from 'node:test';
import assert from 'node:assert/strict';
import { Tag } from '@xinonix/easi-js';
import { createXaSubtraction } from '../src/specialties/index.js';
import { validateClassicXaProfile } from '../src/data/xa-profile.js';
import { parseNative, xaFixture, j, sq } from './specialties-fixtures.js';

for (const syntax of ['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']) for (const bits of [8, 16]) test(`AVG_SUB native ${bits}-bit ${syntax} produces independent signed differences`, async () => {
    const instance = await parseNative(xaFixture({ bits }), syntax), original = instance.dataSet.find(Tag.find('7FE00010')).access().slice();
    const source = await createXaSubtraction(instance), result = await source.subtract(2);
    assert.deepEqual([...result.values], [11, 9, 27]); assert.deepEqual([...(await source.subtract(3)).values], [6, -1, 12]);
    assert.equal(result.unit, 'stored-intensity difference'); assert.equal(result.relationshipSign, -1);
    assert.deepEqual([...source.storedFrame(0)], [2, 4, 6]); source.storedFrame(0).fill(999); assert.equal(source.storedFrame(0)[0], 2);
    assert.deepEqual(instance.dataSet.find(Tag.find('7FE00010')).access(), original); assert.ok(source.bytes > 0);
    source.dispose(); assert.equal(source.bytes, 0); assert.throws(() => source.storedFrame(0), /disposed/); await assert.rejects(source.subtract(2), /disposed/);
});
test('AVG_SUB masks unused stored bits and keeps relationship sign independent from inversion', async () => {
    const instance = await parseNative(xaFixture({ bits: 16, bitsStored: 12, frames: [[0xF002, 0xF004, 0xF006], [6, 8, 10], [10, 20, 30], [20, 10, 40], [0, 0, 0]] }));
    const source = await createXaSubtraction(instance); assert.deepEqual([...(await source.subtract(2)).values], [11, 9, 27]); source.dispose();
});
test('8-bit BE OW packs frame pixels continuously across odd frame boundaries', async () => {
    const raw = xaFixture(); raw['7FE00010'].vr = 'OW';
    const source = await createXaSubtraction(await parseNative(raw, '1.2.840.10008.1.2.2'));
    assert.deepEqual([...(await source.subtract(2)).values], [11, 9, 27]); source.dispose();
});
test('subtraction rejects truncated or frame-padded native pixel data', async () => {
    for (const length of [4, 20]) {
        const raw = xaFixture(); raw['7FE00010'] = { vr: 'OB', InlineBinary: Buffer.alloc(length).toString('base64') };
        await assert.rejects(createXaSubtraction(await parseNative(raw)), /complete bounded native/);
    }
});
test('missing contrast averaging defaults to one and missing ranges end at last valid start', async () => {
    const raw = xaFixture(); raw['00286100'] = sq({ '00286101': j('CS', 'AVG_SUB'), '00286110': j('US', 1, 2) });
    const source = await createXaSubtraction(await parseNative(raw));
    assert.deepEqual(source.metadata.applicableRanges, [0, 4]); assert.deepEqual([...(await source.subtract(4)).values], [-4, -6, -8]); source.dispose();
});
test('active subtraction remains rejected by the main viewer XA guard', async () => {
    const instance = await parseNative(xaFixture());
    assert.throws(() => validateClassicXaProfile(instance.dataSet, { samplesPerPixel: 1, photometric: 'MONOCHROME2', bitsAllocated: 8, bitsStored: 8,
        highBit: 7, signed: false, slope: 1, intercept: 0, frameCount: 5, frameTime: 33, littleEndian: true }), /subtraction is not supported/);
});
for (const [name, mutate] of [
    ['TID', raw => raw['00286100'].Value[0]['00286101'] = j('CS', 'TID')],
    ['fractional shift', raw => raw['00286100'].Value[0]['00286114'] = j('FL', 0.5, 0)],
    ['duplicate mask', raw => raw['00286100'].Value[0]['00286110'] = j('US', 1, 1)],
    ['range beyond averaging', raw => raw['00286100'].Value[0]['00286102'] = j('US', 3, 5)],
    ['overlapping ranges', raw => raw['00286100'].Value[0]['00286102'] = j('US', 2, 3, 3, 4)],
    ['LOG relationship', raw => raw['00281040'] = j('CS', 'LOG')], ['nonidentity rescale', raw => raw['00281053'] = j('DS', 2)],
    ['padding', raw => raw['00280120'] = j('US', 0)], ['intensity LUT', raw => raw['00289422'] = sq({})],
    ['enhanced SOP', raw => raw['00080016'] = j('UI', '1.2.840.10008.5.1.4.1.1.12.1.1')]
]) test(`AVG_SUB rejects ${name}`, async () => { const raw = xaFixture(); mutate(raw); await assert.rejects(createXaSubtraction(await parseNative(raw)), /Unsupported/); });
test('subtraction enforces byte budgets and cancels copying without mutating input', async () => {
    const instance = await parseNative(xaFixture()); await assert.rejects(createXaSubtraction(instance, { maxBytes: 64 }), /budget/);
    const frames = Array.from({ length: 5 }, (_, index) => Array(512 * 256).fill(index + 1));
    const large = await parseNative(xaFixture({ rows: 512, columns: 256, frames })), controller = new AbortController();
    const loading = createXaSubtraction(large, { signal: controller.signal }); queueMicrotask(() => controller.abort());
    await assert.rejects(loading, { name: 'AbortError' });
    const source = await createXaSubtraction(large), cancel = new AbortController();
    const derived = source.subtract(2, { signal: cancel.signal }); queueMicrotask(() => cancel.abort()); await assert.rejects(derived, { name: 'AbortError' });
    const pending = source.subtract(2); source.dispose(); await assert.rejects(pending, /disposed/);
});
