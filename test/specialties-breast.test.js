import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBreastImage, createBreastLayout } from '../src/specialties/index.js';
import { metadata, parseNative, breastFixture, j, c, sq } from './specialties-fixtures.js';

test('four-view breast layout uses explicit laterality and coded views without auto-flips', async () => {
    const images = [];
    for (const [index, laterality, view] of [[1, 'L', 'MLO'], [2, 'R', 'CC'], [3, 'L', 'CC'], [4, 'R', 'MLO']]) images.push(normalizeBreastImage(await metadata(breastFixture({ laterality, view, sopUid: `2.25.830.${index}` }))));
    const layout = createBreastLayout(images);
    assert.deepEqual(layout.slots.map(slot => slot.key), ['R-CC', 'L-CC', 'R-MLO', 'L-MLO']);
    assert.deepEqual(layout.slots.map(slot => slot.image.sopUid), ['2.25.830.2', '2.25.830.3', '2.25.830.4', '2.25.830.1']);
    assert.ok(layout.slots.every(slot => slot.status === 'ready')); assert.equal(layout.orientationPolicy, 'source-unchanged');
    assert.ok(images.every(image => image.orientationTransform === null));
});
test('legacy SRT coded views and native EASI sequence parsing match current SCT descriptors', async () => {
    const legacy = normalizeBreastImage(await parseNative(breastFixture({ scheme: 'SRT', view: 'MLO' }))), current = normalizeBreastImage(await metadata(breastFixture({ view: 'MLO' })));
    assert.equal(legacy.view, current.view); assert.equal(legacy.viewCode.value, 'R-10226');
});
test('duplicates remain ambiguous and missing views remain explicit', async () => {
    const a = normalizeBreastImage(await metadata(breastFixture())), b = normalizeBreastImage(await metadata(breastFixture({ sopUid: '2.25.831' })));
    const layout = createBreastLayout([a, b]); assert.equal(layout.slots[0].status, 'ambiguous'); assert.equal(layout.slots[0].image, null);
    assert.equal(layout.slots[0].candidates.length, 2); assert.equal(layout.slots[1].status, 'missing'); assert.throws(() => createBreastLayout([a, a]), /duplicate/);
});
for (const [name, options, reason] of [
    ['spot compression', { modifiers: [c('399055006', 'SCT', 'Spot Compression')] }, 'modified-view'],
    ['bilateral', { laterality: 'B' }, 'bilateral-view'], ['partial', { '00281350': j('CS', 'YES') }, 'partial-view'],
    ['unknown full extent', { '00281350': undefined }, 'unverified-full-view'],
    ['processing-only image', { '00080016': j('UI', '1.2.840.10008.5.1.4.1.1.1.2.1'), '00080068': j('CS', 'FOR PROCESSING') }, 'processing-image'],
    ['unrecognized coded projection', { '00540220': sq(c('399260004', 'SCT', 'medio-lateral')) }, 'unsupported-view']
]) test(`breast layout leaves ${name} unassigned`, async () => {
    const raw = breastFixture(options); for (const key of Object.keys(raw)) if (raw[key] === undefined) delete raw[key];
    const image = normalizeBreastImage(await metadata(raw)); assert.equal(image.eligible, false); assert.equal(image.reason, reason);
    assert.equal(createBreastLayout([image]).unassigned[0].reason, reason);
});
for (const [name, overrides] of [
    ['conflicting laterality', { '00200060': j('CS', 'L') }], ['missing laterality', { '00200062': undefined }],
    ['tomosynthesis frames', { '00280008': j('IS', 20) }], ['non-mammographic class', { '00080016': j('UI', '1.2.840.10008.5.1.4.1.1.2') }],
    ['unverified coded anatomical laterality', { '00082228': sq({ '00082230': sq(c('24028007', 'SCT', 'Right')) }) }]
]) test(`breast classification rejects ${name}`, async () => { const raw = breastFixture(overrides); for (const key of Object.keys(raw)) if (raw[key] === undefined) delete raw[key]; const instance = await metadata(raw); assert.throws(() => normalizeBreastImage(instance), /Unsupported/); });
test('breast layouts cannot silently combine studies or classify by free-text meaning', async () => {
    const a = normalizeBreastImage(await metadata(breastFixture())), b = normalizeBreastImage(await metadata(breastFixture({ sopUid: '2.25.832', '0020000D': j('UI', '2.25.900') })));
    assert.throws(() => createBreastLayout([a, b]), /one explicit Study/);
    const unknown = normalizeBreastImage(await metadata(breastFixture({ '00540220': sq(c('UNKNOWN', '99LOCAL', 'CC')) }))); assert.equal(unknown.view, null);
    assert.equal(JSON.stringify(createBreastLayout([a])).includes('Patient'), false);
});
