import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFiles } from '../src/data/sources.js';
import { createCompressedDicom } from './compressed-fixtures.js';
import { jpegBaselineHeader, decodeJpegBaseline } from '../src/data/compressed.js';

async function open(options) {
    const fixture = await createCompressedDicom(options);
    const series = await loadFiles([new File([fixture.bytes], 'synthetic-compressed.dcm')]);
    return { fixture, series };
}

for (const codec of ['rle', 'jpeg-lossless', 'jpeg-ls', 'jpeg2000']) {
    for (const signed of [false, true]) test(`${codec} preserves exact stored 16-bit multiframe samples (${signed ? 'signed' : 'unsigned'})`, async () => {
        const rows = 64, columns = 64;
        const values = Array.from({length:rows*columns}, (_, index) => signed ? index % 65536 - 2048 : index % 65536);
        const second = values.map(value => value + 100);
        const { fixture, series } = await open({codec, rows, columns, signed, bitsAllocated:16, frameSamples:[values,second]});
        try {
            assert.equal(series[0].frames.length,2);
            assert.equal(series[0].cacheBytes,0);
            const last = await series[0].getFrame(1);
            assert.deepEqual([...last.samples],fixture.expectedSamples[1]);
            assert.equal(last.samples.constructor,signed ? Int16Array : Uint16Array);
            const first = await series[0].getFrame(0);
            assert.deepEqual([...first.samples],fixture.expectedSamples[0]);
            assert.equal(await series[0].getFrame(1),last);
            assert.equal(series[0].cacheBytes,rows*columns*4);
            const index = [...series[0]._records.values()][0].encapsulated;
            assert.ok(index);
            series[0].dispose();
            assert.equal(index.frames.length,0);
            assert.equal(series[0].cacheBytes,0);
        } finally { series.forEach(stack => stack.dispose()); }
    });
}

test('fragmented JPEG Baseline grayscale frames decode lazily with exact constant references', async () => {
    const {series} = await open({codec:'jpeg', rows:16, columns:16, fragmentsPerFrame:3,
        frameSamples:[Array(256).fill(36),Array(256).fill(204)]});
    try {
        assert.ok([...(await series[0].getFrame(0)).samples].every(value => Math.abs(value-36)<=1));
        assert.ok([...(await series[0].getFrame(1)).samples].every(value => Math.abs(value-204)<=1));
    } finally { series.forEach(stack => stack.dispose()); }
});

for (const codec of ['rle','jpeg','jpeg-lossless','jpeg-ls','jpeg2000']) test(`${codec} color produces canonical RGB without scalar windowing`, async () => {
    const rows=64, columns=64;
    const values=Array.from({length:rows*columns}, () => [90,120,160]).flat();
    const {series} = await open({codec, rows, columns, samplesPerPixel:3, bitsAllocated:8, frameSamples:[values]});
    try {
        const frame = await series[0].getFrame(0);
        assert.equal(frame.photometric,'RGB'); assert.equal(frame.window,null); assert.equal(frame.range,null);
        if(codec==='jpeg') assert.ok([...frame.samples].every((value,index)=>Math.abs(value-values[index])<=2));
        else assert.deepEqual([...frame.samples],values);
    } finally { series.forEach(stack => stack.dispose()); }
});

test('decoder rejects JPEG codestream geometry mismatches before pixel allocation', async () => {
    const {series} = await open({codec:'jpeg', rows:8, columns:8, metadataOverrides:{columns:9}});
    try { await assert.rejects(series[0].getFrame(0),/codestream dimensions/); assert.equal(series[0].cacheBytes,0); }
    finally { series.forEach(stack => stack.dispose()); }
});

test('baseline header rejects other JPEG processes and truncated segments', () => {
    assert.throws(()=>jpegBaselineHeader(new Uint8Array([255,216,255,192,0,20,8])),/Truncated/);
    assert.throws(()=>jpegBaselineHeader(new Uint8Array([255,216,255,194,0,8,8,0,1,0,1,0])),/Baseline/);
});

test('JPEG Adobe transforms and embedded ICC cannot silently override DICOM color metadata', async () => {
    const fixture = await createCompressedDicom({codec:'jpeg',samplesPerPixel:3,rows:8,columns:8});
    const encoded = fixture.frames[0];
    const prepend = payload => {
        const result = new Uint8Array(encoded.length + payload.length);
        result.set(encoded.subarray(0,2)); result.set(payload,2); result.set(encoded.subarray(2),2+payload.length);
        return result;
    };
    const adobe = Uint8Array.from([255,238,0,14,65,100,111,98,101,0,100,0,0,0,0,1]);
    const metadata = {...fixture.metadata,photometric:'RGB',encodedPhotometric:'RGB'};
    assert.throws(()=>decodeJpegBaseline(prepend(adobe),metadata),/color transform/);
    adobe[15]=0;
    assert.throws(()=>decodeJpegBaseline(prepend(adobe),{...metadata,encodedPhotometric:'YBR_FULL'}),/color transform/);
    const icc = Uint8Array.from([255,226,0,15,...new TextEncoder().encode('ICC_PROFILE'),0,1]);
    assert.throws(()=>decodeJpegBaseline(prepend(icc),metadata),/ICC profile/);
});
