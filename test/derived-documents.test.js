import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importSr, importGsps, exportDerivedResults, importDerivedResults } from '../src/derived/index.js';
import { srFixture, gspsFixture, parseFixture, resolver, j, sq } from './derived-fixtures.js';

test('NUM/SCOORD SR imports coded values and image-edge polylines with exact original source references', async () => {
    const f = srFixture(), result = await importSr(await parseFixture(f.metadata), { resolveSource: resolver(f.sources) });
    assert.equal(result.profile, 'by-value-num-scoord-sr-v1'); assert.equal(result.measurements[0].value, 5.25);
    assert.equal(result.measurements[0].unit.scheme, 'UCUM'); assert.equal(result.measurements[0].unit.value, 'mm');
    assert.deepEqual(result.measurements[0].graphic.points, [{ x: 0, y: 0 }, { x: 8, y: 6 }]);
    assert.equal(result.measurements[0].image.sopUid, f.sources[0].sopUid); assert.equal(result.measurements[0].image.frameNumber, 1);
    assert.equal(JSON.stringify(result).includes('SYNTHETIC^DERIVED'), false); assert.equal(JSON.stringify(result).includes('SYNTHETIC-ONLY'), false);
});

const srCases = [
    ['TID template', m => { m['0040A504'] = sq({ '0040DB00': j('CS', 'DCMR'), '0040DB06': j('CS', '1500') }); }],
    ['by-reference item', m => { m['0040A730'].Value[0]['0040DB73'] = j('UL', 1); }],
    ['unsupported unit', m => { m['0040A730'].Value[0]['0040A300'].Value[0]['004008EA'].Value[0]['00080100'] = j('SH', 'mg'); }],
    ['SCOORD3D', m => { m['0040A730'].Value[0]['0040A730'].Value[0]['0040A040'] = j('CS', 'SCOORD3D'); }],
    ['tiled origin', m => { m['0040A730'].Value[0]['0040A730'].Value[0]['00480301'] = j('CS', 'VOLUME'); }],
    ['alternate numeric float', m => { m['0040A730'].Value[0]['0040A300'].Value[0]['0040A161'] = j('FD', 5.25); }],
    ['wrong relationship', m => { m['0040A730'].Value[0]['0040A730'].Value[0]['0040A010'] = j('CS', 'CONTAINS'); }],
    ['out of bounds', m => { m['0040A730'].Value[0]['0040A730'].Value[0]['00700022'] = j('FL', 0, 0, 9, 6); }]
];
for (const [name, mutate] of srCases) test(`SR rejects ${name} rather than claiming generic template support`, async () => {
    const f = srFixture(); mutate(f.metadata); await assert.rejects(importSr(await parseFixture(f.metadata), { resolveSource: resolver(f.sources) }), /Unsupported derived object/);
});

test('GSPS uses image-edge graphics and one-based displayed-area indices while presentation polarity replaces MONOCHROME1', async () => {
    const f = gspsFixture(); f.sources[0].photometric = 'MONOCHROME1';
    const result = await importGsps(await parseFixture(f.metadata), { resolveSource: resolver(f.sources) });
    assert.equal(result.profile, 'single-frame-pixel-gsps-v1'); assert.deepEqual(result.displayedArea.topLeft, [1, 1]);
    assert.deepEqual(result.graphics[0].points, [{ x: 0, y: 0 }, { x: 8, y: 6 }]);
    assert.deepEqual(result.graphics[1].controlPoints, [{ x: 1, y: 1 }, { x: 7, y: 5 }]);
    assert.deepEqual(result.window, { center: 40, width: 400, voiFunction: 'LINEAR' });
    assert.equal(result.presentationInvert, false); assert.equal(result.layers[0].grayValue, 65535);
    f.metadata['20500020'] = j('CS', 'INVERSE');
    assert.equal((await importGsps(await parseFixture(f.metadata), { resolveSource: resolver(f.sources) })).presentationInvert, true);
    assert.deepEqual([...f.sources[0].samples].slice(0, 4), [10, 11, 12, 13]);
});

test('GSPS accepts matching explicit rescale while an absent PS transform never falls back to source rescale', async () => {
    const f = gspsFixture(); f.sources[0].slope = 2; f.sources[0].intercept = -100;
    await assert.rejects(importGsps(await parseFixture(f.metadata), { resolveSource: resolver(f.sources) }), /modality transform differs/);
    f.metadata['00281053'] = j('DS', 2); f.metadata['00281052'] = j('DS', -100);
    assert.equal((await importGsps(await parseFixture(f.metadata), { resolveSource: resolver(f.sources) })).window.center, 40);
});

const gspsCases = [
    ['rotated source', m => { m['00700042'] = j('US', 90); }], ['flipped source', m => { m['00700041'] = j('CS', 'Y'); }],
    ['display-relative graphics', m => { m['00700001'].Value[0]['00700009'].Value[0]['00700005'] = j('CS', 'DISPLAY'); }],
    ['compound graphics', m => { m['00700209'] = sq({}); }], ['free text', m => { m['00700001'].Value[0]['00700008'] = sq({}); }],
    ['crop', m => { m['0070005A'].Value[0]['00700052'] = j('SL', 2, 2); }],
    ['zero-based displayed area', m => { m['0070005A'].Value[0]['00700052'] = j('SL', 0, 0); }],
    ['different physical calibration', m => { m['0070005A'].Value[0]['00700101'] = j('DS', 1, 1); }],
    ['filled ellipse', m => { m['00700001'].Value[0]['00700009'].Value[1]['00700024'] = j('CS', 'Y'); }],
    ['slanted ellipse', m => { m['00700001'].Value[0]['00700009'].Value[1]['00700022'] = j('FL', 1, 2, 7, 4, 4, 1, 4, 5); }],
    ['VOI LUT', m => { m['00283110'].Value[0]['00283010'] = sq({}); }],
    ['shutter', m => { m['00181622'] = j('US', 0); }],
    ['mask subtraction', m => { m['00286100'] = sq({ '00286101': j('CS', 'AVG_SUB') }); }],
    ['bitmap overlay activation', m => { m['60001001'] = j('CS', 'MEASURE'); }],
    ['wrong graphic count', m => { m['00700001'].Value[0]['00700009'].Value[0]['00700021'] = j('US', 3); }]
];
for (const [name, mutate] of gspsCases) test(`GSPS rejects ${name}`, async () => {
    const f = gspsFixture(); mutate(f.metadata); await assert.rejects(importGsps(await parseFixture(f.metadata), { resolveSource: resolver(f.sources) }), /Unsupported derived object/);
});

test('restricted SR/GSPS result JSON roundtrips and rejects patient/host fields or changed graphic semantics', async () => {
    const sr = srFixture(), gsps = gspsFixture();
    const documents = [await importSr(await parseFixture(sr.metadata), { resolveSource: resolver(sr.sources) }),
        await importGsps(await parseFixture(gsps.metadata), { resolveSource: resolver(gsps.sources) })];
    const saved = exportDerivedResults(documents), restored = importDerivedResults(saved);
    assert.deepEqual(restored.documents, documents); assert.equal(restored.frameNumberBase, 1);
    for (const mutate of [model => { model.documents[0].patientName = 'forbidden'; }, model => { model.documents[0].measurements[0].hostUrl = 'forbidden'; },
        model => { model.documents[0].measurements[0].image.frameNumber = 0; }, model => { model.documents[1].presentationInvert = true; }]) {
        const model = structuredClone(restored); mutate(model); assert.throws(() => importDerivedResults(model));
    }
    assert.throws(() => exportDerivedResults(documents, { maxBytes: 10 }), /byte budget/);
    assert.throws(() => importDerivedResults(saved, { maxBytes: 10 }), /byte budget/);
    assert.throws(() => exportDerivedResults([documents[0], documents[0]]), /duplicate result/);
});

test('canceled document resolution publishes no result or later measurement', async () => {
    const f = srFixture(), controller = new AbortController(); let done;
    const pending = importSr(await parseFixture(f.metadata), { signal: controller.signal, resolveSource: () => new Promise(resolve => { done = resolve; }) });
    await Promise.resolve(); controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); done(f.sources[0]);
});
