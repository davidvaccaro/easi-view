import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransferSyntax } from '@xinonix/easi-js';
import { attribute } from '../src/derived/common.js';
import { readDerivedInstance, importSeg, OverlayStore, renderOverlayRgba } from '../src/derived/index.js';
import { segFixture, parseFixture, writeFixture, independentNativeFixture, resolver, j, sq } from './derived-fixtures.js';

test('published EASI writer/read pipeline handles continuous unaligned native SEG frames without per-frame byte padding', async () => {
    const { metadata, sources } = segFixture(), bytes = await writeFixture(metadata);
    const instance = await readDerivedInstance(bytes), result = await importSeg(instance, { resolveSource: resolver(sources) });
    assert.equal(result.profile, 'native-exact-grid-seg-v1'); assert.equal(result.segments[0].number, 7);
    assert.deepEqual(result.overlays.map(overlay => [...overlay.values]), [[1, 0, 1], [0, 1, 1], [1, 1, 0]]);
    assert.equal(result.ignoredEndPaddingBits, 7); assert.equal(result.bytes, 9);
    assert.deepEqual(result.overlays.map(overlay => overlay.image.frameNumber), [1, 1, 1]);
    assert.equal(result.overlays[0].segment.type.value, 'REGION');
    const store = new OverlayStore(); for (const item of result.overlays) store.add(item);
    const output = await renderOverlayRgba(store.list(result.overlays[0].image), sources[0]);
    assert.deepEqual([...output.rgba], [0, 200, 160, 128, 0, 0, 0, 0, 0, 200, 160, 128]);
    assert.deepEqual([...sources[0].samples], [10, 11, 12]); store.dispose();
});

test('fractional SEG preserves probability quantization and ignores the final even-length pad byte', async () => {
    const { metadata, sources } = segFixture({ fractional: true });
    const result = await importSeg(await parseFixture(metadata), { resolveSource: resolver(sources) });
    assert.equal(result.fractionalType, 'PROBABILITY'); assert.equal(result.maximumFractionalValue, 200);
    assert.deepEqual(result.overlays.map(item => [...item.values]), [[0, 100, 200], [50, 150, 200], [200, 0, 100]]);
    const rgba = await renderOverlayRgba([result.overlays[0]], sources[0], { alphaMode: 'premultiplied' });
    assert.deepEqual([...rgba.rgba], [0, 0, 0, 0, 0, 50, 40, 64, 0, 100, 80, 128]);
});

for (const syntax of ['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']) for (const fractional of [false, true])
test(`independently encoded ${fractional ? 'fractional8' : 'binary1'} Part10 SEG preserves OW words (${syntax})`, async () => {
    const { metadata, sources } = segFixture({ fractional });
    const instance = await readDerivedInstance(new Blob([independentNativeFixture(metadata, syntax)]));
    const imported = await importSeg(instance, { resolveSource: resolver(sources) });
    assert.deepEqual(imported.overlays.map(item => [...item.values]), fractional ? [[0, 100, 200], [50, 150, 200], [200, 0, 100]] : [[1, 0, 1], [0, 1, 1], [1, 1, 0]]);
});

test('explicit big-endian SEG OB octets remain unswapped across continuous binary frames', async () => {
    const { metadata, sources } = segFixture(); metadata['7FE00010'].vr = 'OB';
    const imported = await importSeg(await readDerivedInstance(independentNativeFixture(metadata, '1.2.840.10008.1.2.2')), { resolveSource: resolver(sources) });
    assert.deepEqual(imported.overlays.map(item => [...item.values]), [[1, 0, 1], [0, 1, 1], [1, 1, 0]]);
});

test('referenced original multiframe number binds the actual frame index rather than the SEG index', async () => {
    const { metadata, sources } = segFixture();
    sources[1].frameIndex = 4; metadata['52009230'].Value[1]['00089124'].Value[0]['00082112'].Value[0]['00081160'] = j('IS', 5);
    const result = await importSeg(await parseFixture(metadata), { resolveSource: resolver(sources) });
    assert.equal(result.overlays[1].image.frameNumber, 5);
});

test('absent source frame numbers bind only when host metadata explicitly proves a single-frame instance', async () => {
    const { metadata, sources } = segFixture();
    for (const item of metadata['52009230'].Value) delete item['00089124'].Value[0]['00082112'].Value[0]['00081160'];
    for (const frame of sources) frame.numberOfFrames = 1;
    const resolveSource = (uid, number) => { assert.equal(number, null); return sources.find(frame => frame.sopUid === uid); };
    assert.equal((await importSeg(await parseFixture(metadata), { resolveSource })).overlays[0].image.frameNumber, 1);
    sources[0].numberOfFrames = 2;
    await assert.rejects(importSeg(await parseFixture(metadata), { resolveSource }), /verified single-frame/);
});

for (const [name, mutate] of [
    ['unknown segment', m => { m['52009230'].Value[0]['0062000A'].Value[0]['0062000B'] = j('US', 8); }],
    ['duplicate segments', m => { m['00620002'].Value.push(structuredClone(m['00620002'].Value[0])); }],
    ['missing reference frame', m => { delete m['52009230'].Value[0]['00089124'].Value[0]['00082112'].Value[0]['00081160']; }],
    ['multiple source refs', m => { const derivation = m['52009230'].Value[0]['00089124'].Value[0]; derivation['00082112'].Value.push(structuredClone(derivation['00082112'].Value[0])); }],
    ['transformed locations', m => { m['52009230'].Value[0]['00089124'].Value[0]['00082112'].Value[0]['0028135A'] = j('CS', 'NO'); }],
    ['geometry shifted by a tiny amount', m => { m['52009230'].Value[0]['00209113'].Value[0]['00200032'] = j('DS', 0.0000001, 0, 0); }],
    ['Frame of Reference mismatch', m => { m['00200052'] = j('UI', '2.25.799'); }],
    ['wrong binary layout', m => { m['00280100'] = j('US', 8); }],
    ['unsupported LABELMAP', m => { m['00620001'] = j('CS', 'LABELMAP'); }],
    ['missing segment code', m => { delete m['00620002'].Value[0]['0062000F']; }],
    ['shared/per-frame duplicate geometry', m => { m['52009230'].Value[0]['00209116'] = sq({ '00200037': j('DS', 1, 0, 0, 0, 1, 0) }); }],
    ['wrong per-frame count', m => { m['52009230'].Value.pop(); }],
    ['extra encoded bytes', m => { m['7FE00010'].InlineBinary = Buffer.from([0xF5, 0xFE, 0, 0]).toString('base64'); }]
]) test(`SEG rejects ${name}`, async () => {
    const { metadata, sources } = segFixture(); mutate(metadata);
    await assert.rejects(importSeg(await parseFixture(metadata), { resolveSource: resolver(sources) }), /Unsupported derived object/);
});

test('fractional values above their declared maximum and expanded-mask budget violations reject', async () => {
    const fixture = segFixture({ fractional: true, maximum: 100 });
    await assert.rejects(importSeg(await parseFixture(fixture.metadata), { resolveSource: resolver(fixture.sources) }), /exceeds Maximum/);
    const normal = segFixture(), instance = await parseFixture(normal.metadata); let resolved = 0;
    await assert.rejects(importSeg(instance, { maxBytes: 8, resolveSource: () => { resolved++; } }), /byte budget/); assert.equal(resolved, 0);
});

test('cancellation during source resolution is prompt, never binds a late frame and requests no later source', async () => {
    const fixture = segFixture(), instance = await parseFixture(fixture.metadata), controller = new AbortController(); let resolve, calls = 0;
    const pending = importSeg(instance, { signal: controller.signal, resolveSource: () => { calls++; return new Promise(done => { resolve = done; }); } });
    await Promise.resolve(); controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
    resolve(fixture.sources[0]); await new Promise(done => setTimeout(done, 0)); assert.equal(calls, 1);
});

test('local derived input bounds and cancellation preserve the EASI parser boundary', async () => {
    const bytes = await writeFixture(segFixture().metadata), controller = new AbortController(); controller.abort();
    await assert.rejects(readDerivedInstance(bytes, { maxBytes: bytes.length - 1 }), /byte budget/);
    await assert.rejects(readDerivedInstance(bytes, { signal: controller.signal }), { name: 'AbortError' });
    await assert.rejects(readDerivedInstance('https://example.test/image.dcm'), /local bytes/);
});

test('compressed/short pixel data and unsupported text encodings fail; explicit consumption releases derived raw pixels only', async () => {
    const fixture = segFixture();
    const compressed = await parseFixture(fixture.metadata); attribute(compressed.dataSet, '7FE00010').transferSyntax = TransferSyntax.find('1.2.840.10008.1.2.4.50');
    await assert.rejects(importSeg(compressed, { resolveSource: resolver(fixture.sources) }), /native materialized/);
    const short = await parseFixture(fixture.metadata); attribute(short.dataSet, '7FE00010').clear();
    await assert.rejects(importSeg(short, { resolveSource: resolver(fixture.sources) }), /truncated or excess/);
    const encoded = structuredClone(fixture.metadata); encoded['00080005'] = j('CS', 'ISO_IR 100');
    await assert.rejects(importSeg(await parseFixture(encoded), { resolveSource: resolver(fixture.sources) }), /ASCII or UTF-8/);
    const instance = await parseFixture(fixture.metadata), result = await importSeg(instance, { resolveSource: resolver(fixture.sources), consumePixelData: true });
    assert.equal(attribute(instance.dataSet, '7FE00010').access().length, 0); assert.deepEqual([...result.overlays[0].values], [1, 0, 1]);
    assert.deepEqual([...fixture.sources[0].samples], [10, 11, 12]);
});
