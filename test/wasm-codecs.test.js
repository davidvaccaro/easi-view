import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import codecs from 'dcmjs-codecs';
import { decodeWasmFrame } from '../src/data/wasm-codecs.js';
import { decodeNative } from '../src/data/native.js';
import { loadFiles } from '../src/data/sources.js';
import { createCompressedDicom } from './compressed-fixtures.js';

// Only synthetic test encoding imports the upstream JavaScript. Production
// loads its standalone binary and uses EASI JS for DICOM parsing.
await codecs.NativeCodecs.initializeAsync();
const moduleBytes = new Uint8Array(await readFile(new URL('../node_modules/dcmjs-codecs/build/dcmjs-native-codecs.wasm', import.meta.url)));
const syntax = suffix => `1.2.840.10008.1.2.4.${suffix}`;
const mono = (suffix, bitsAllocated = 8, bitsStored = bitsAllocated, signed = false) => ({
    rows: 2, columns: 4, bitsAllocated, bitsStored, highBit: bitsStored - 1,
    signed, samplesPerPixel: 1, photometric: 'MONOCHROME2', planarConfiguration: null,
    transferSyntax: syntax(suffix), slope: 1, intercept: 0, padding: null
});

function encode(values, metadata, options = {}) {
    if ([syntax(57), syntax(70)].includes(metadata.transferSyntax) && metadata.bitsStored < 8) {
        return encodeSmallLosslessJpeg(values, metadata);
    }
    // The upstream J2K encoder reads signed8 as unsigned8. Encode signed16
    // values within the signed8 range, then declare the reconstructed SIZ
    // precision as8; reversible QCD bit-plane exponents stay unchanged.
    const signed8J2k = metadata.signed && metadata.bitsStored <= 8 &&
        [syntax(90), syntax(91)].includes(metadata.transferSyntax);
    const j2k = [syntax(90), syntax(91)].includes(metadata.transferSyntax);
    const jls = [syntax(80), syntax(81)].includes(metadata.transferSyntax);
    const canonicalBits = metadata.bitsStored <= 8 ? 8 : 16;
    const encodingBits = signed8J2k ? 16 : jls ? metadata.bitsStored : canonicalBits;
    // JPEG/JPEG-LS encode the declared stored bit patterns. OpenJPEG consumes
    // signed native values, so signed input is sign-extended in its container.
    const ctor = encodingBits <= 8 ? Uint8Array : j2k && metadata.signed ? Int16Array : Uint16Array;
    const samples = new ctor(j2k ? values : values.map(value => value < 0 ? value + 2 ** metadata.bitsStored : value));
    const context = new codecs.Context({ width: metadata.columns, height: metadata.rows,
        bitsAllocated: encodingBits, bitsStored: signed8J2k ? 16 : metadata.bitsStored,
        samplesPerPixel: metadata.samplesPerPixel, pixelRepresentation: metadata.signed ? 1 : 0,
        planarConfiguration: 0, photometricInterpretation: 'RGB' === metadata.photometric ? 'RGB' : metadata.photometric,
        decodedBuffer: new Uint8Array(samples.buffer) });
    const method = [57, 70].some(suffix => metadata.transferSyntax === syntax(suffix)) ? 'encodeJpeg' :
        [80, 81].some(suffix => metadata.transferSyntax === syntax(suffix)) ? 'encodeJpegLs' : 'encodeJpeg2000';
    const result = codecs.NativeCodecs[method](context, { lossy: false, allowedLossyError: 0, allowMct: 0, ...options });
    const encoded = result.getEncodedBuffer();
    if (signed8J2k) encoded[marker(encoded, 81) + 40] = 128 | (metadata.bitsStored - 1);
    return encoded;
}

function encodeSmallLosslessJpeg(values, metadata) {
    // Independent tiny Process14 predictor1 encoder. The upstream encoder
    // always declares precision8 for its byte input, so changing that header
    // would not produce a valid low-precision JPEG initial prediction.
    const precision = metadata.bitsStored;
    const stored = values.map(value => value < 0 ? value + 2 ** precision : value);
    const output = [255, 216];
    const segment = (marker, payload) => output.push(255, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255, ...payload);
    const counts = Array(16).fill(0); counts[3] = precision + 1;
    segment(196, [0, ...counts, ...Array.from({ length: precision + 1 }, (_, index) => index)]);
    segment(195, [precision, metadata.rows >> 8, metadata.rows & 255, metadata.columns >> 8, metadata.columns & 255, 1, 1, 17, 0]);
    segment(218, [1, 1, 0, 1, 0, 0]);
    let accumulator = 0, bitCount = 0;
    const append = (value, count) => {
        for (let bit = count - 1; bit >= 0; bit--) {
            accumulator = accumulator * 2 + ((value >> bit) & 1);
            if (++bitCount === 8) {
                output.push(accumulator); if (accumulator === 255) output.push(0);
                accumulator = 0; bitCount = 0;
            }
        }
    };
    for (let index = 0; index < stored.length; index++) {
        const predictor = index === 0 ? 2 ** (precision - 1) : index % metadata.columns === 0 ? stored[index - metadata.columns] : stored[index - 1];
        const difference = stored[index] - predictor;
        const category = difference === 0 ? 0 : Math.floor(Math.log2(Math.abs(difference))) + 1;
        append(category, 4);
        if (category) append(difference < 0 ? difference + 2 ** category - 1 : difference, category);
    }
    if (bitCount) append(2 ** (8 - bitCount) - 1, 8 - bitCount);
    output.push(255, 217);
    return Uint8Array.from(output);
}

for (const suffix of [57, 70, 80, 81, 90, 91]) {
    for (const signed of [false, true]) for (const precision of [2, 3, 4, 5, 6, 7, 8]) {
        test(`syntax .${suffix} widens ${signed ? 'signed' : 'unsigned'} precision${precision} into DICOM16 without interleaved zeros`, async () => {
            const metadata = mono(suffix, 16, precision, signed);
            const minimum = signed ? -(2 ** (precision - 1)) : 0;
            const maximum = signed ? 2 ** (precision - 1) - 1 : 2 ** precision - 1;
            const expected = signed ? [minimum, -1, 0, maximum, minimum + 1, 0, 1, maximum] :
                [0, 1, maximum - 1, maximum, 1, 0, maximum, maximum - 2];
            const encoded = encode(expected, metadata);
            const result = await decodeWasmFrame(encoded, metadata, { wasmBytes: moduleBytes });
            assert.equal(result.bytes.byteLength, expected.length * 2);
            const decoded = decodeNative(result.bytes, { ...metadata, ...result.metadataOverrides });
            assert.deepEqual([...decoded.samples], expected);
            const view = new DataView(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength);
            for (let index = 0; index < expected.length; index++) {
                assert.equal(result.bytes[index * 2 + 1], 0);
                const pattern = expected[index] < 0 ? expected[index] + 2 ** precision : expected[index];
                assert.equal(view.getUint16(index * 2, true) & (2 ** precision - 1), pattern);
            }
        });
    }
}

function marker(bytes, value) {
    for (let index = 0; index < bytes.length - 1; index++) if (bytes[index] === 255 && bytes[index + 1] === value) return index;
    throw new Error('Synthetic marker missing.');
}

for (const suffix of [57, 70, 80, 81, 90, 91]) {
    for (const signed of [false, true]) {
        test(`syntax .${suffix} preserves independent ${signed ? 'signed' : 'unsigned'} 8-bit samples`, async () => {
            const metadata = mono(suffix, 8, 8, signed);
            const expected = signed ? [-128, -127, -1, 0, 1, 64, 126, 127] : [0, 1, 3, 127, 128, 200, 254, 255];
            const encoded = encode(expected, metadata);
            const result = await decodeWasmFrame(encoded, metadata, { wasmBytes: moduleBytes });
            const decoded = decodeNative(result.bytes, { ...metadata, ...result.metadataOverrides });
            assert.deepEqual(Array.from(decoded.samples), expected);
            assert.equal(result.bytes.byteLength, 8);
            assert.deepEqual(result.metadataOverrides, { littleEndian: true, planarConfiguration: null, photometric: 'MONOCHROME2' });
        });
        test(`syntax .${suffix} preserves independent ${signed ? 'signed' : 'unsigned'} 16-bit samples`, async () => {
            const metadata = mono(suffix, 16, 16, signed);
            const expected = signed ? [-32768, -12345, -1, 0, 1, 12345, 32766, 32767] : [0, 1, 127, 255, 4095, 32768, 65534, 65535];
            const encoded = encode(expected, metadata);
            const result = await decodeWasmFrame(encoded, metadata, { wasmBytes: moduleBytes });
            const decoded = decodeNative(result.bytes, { ...metadata, ...result.metadataOverrides });
            assert.deepEqual(Array.from(decoded.samples), expected);
            const view = new DataView(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength);
            for (let index = 0; index < expected.length; index++) assert.equal(signed ? view.getInt16(index * 2, true) : view.getUint16(index * 2, true), expected[index]);
        });
    }
}

for (const suffix of [57, 70, 80, 81, 90, 91]) {
    test(`syntax .${suffix} preserves signed 12-bit stored values in 16-bit allocation`, async () => {
        const metadata = mono(suffix, 16, 12, true);
        const expected = [-2048, -1024, -1, 0, 1, 1023, 2047, 127];
        const result = await decodeWasmFrame(encode(expected, metadata), metadata, { wasmBytes: moduleBytes });
        assert.deepEqual(Array.from(decodeNative(result.bytes, { ...metadata, ...result.metadataOverrides }).samples), expected);
    });
}

test('a valid JPEG70 precision8 Part10 with DICOM16 allocation retains every constant80 sample', async () => {
    const generated = await createCompressedDicom({ codec: 'jpeg-lossless', rows: 8, columns: 8,
        bitsAllocated: 8, bitsStored: 8, frameSamples: [Array(64).fill(80), Array(64).fill(11)],
        metadataOverrides: { bitsAllocated: 16 } });
    const series = await loadFiles([new File([generated.bytes], 'synthetic-mixed-container.dcm')]);
    try {
        assert.equal(series[0].frames[0].bitsAllocated, 16);
        assert.deepEqual([...(await series[0].getFrame(0)).samples], Array(64).fill(80));
        assert.deepEqual([...(await series[0].getFrame(1)).samples], Array(64).fill(11));
    } finally { series.forEach(stack => stack.dispose()); }
});

test('JPEG-LS NEAR2 in a DICOM16 container preserves the declared stored-sample error bound', async () => {
    const metadata = mono(81, 16, 8);
    const expected = [1, 11, 41, 61, 101, 181, 231, 253];
    const result = await decodeWasmFrame(encode(expected, metadata, { lossy: true, allowedLossyError: 2 }), metadata, { wasmBytes: moduleBytes });
    const samples = decodeNative(result.bytes, { ...metadata, ...result.metadataOverrides }).samples;
    assert.equal(samples.length, expected.length);
    for (let index = 0; index < expected.length; index++) assert.ok(Math.abs(samples[index] - expected[index]) <= 2);
});

const rgbValues = [0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 12, 34, 56, 255, 255, 255, 3, 155, 219, 127, 128, 129];
for (const suffix of [57, 70, 80, 81, 90, 91]) {
    test(`syntax .${suffix} validates and returns interleaved RGB8`, async () => {
        const metadata = { ...mono(suffix), photometric: 'RGB', samplesPerPixel: 3, planarConfiguration: 0 };
        const result = await decodeWasmFrame(encode(rgbValues, metadata), metadata, { wasmBytes: moduleBytes });
        assert.deepEqual(Array.from(result.bytes), rgbValues);
        assert.deepEqual(result.metadataOverrides, { littleEndian: true, planarConfiguration: 0, photometric: 'RGB' });
    });
}

test('JPEG 2000 reversible component transform decodes to RGB exactly once', async () => {
    const metadata = { ...mono(90), photometric: 'RGB', samplesPerPixel: 3, planarConfiguration: 0 };
    const encoded = encode(rgbValues, metadata, { allowMct: 1 });
    const result = await decodeWasmFrame(encoded, { ...metadata, encodedPhotometric: 'YBR_RCT' }, { wasmBytes: moduleBytes });
    assert.deepEqual(Array.from(result.bytes), rgbValues);
    assert.equal(result.metadataOverrides.photometric, 'RGB');
    assert.equal(result.metadataOverrides.planarConfiguration, 0);
    await assert.rejects(decodeWasmFrame(encoded, metadata, { wasmBytes: new Uint8Array() }), /component transform/);
});

test('JPEG 2000 irreversible component transform returns validated RGB8 with documented rounding', async () => {
    const metadata = { ...mono(91), photometric: 'RGB', samplesPerPixel: 3, planarConfiguration: 0 };
    const encoded = encode(rgbValues, metadata, { lossy: true, rate: 1, allowMct: 1 });
    const result = await decodeWasmFrame(encoded, { ...metadata, encodedPhotometric: 'YBR_ICT' }, { wasmBytes: moduleBytes });
    for (let index = 0; index < rgbValues.length; index++) assert.ok(Math.abs(result.bytes[index] - rgbValues[index]) <= 1);
    assert.equal(result.metadataOverrides.photometric, 'RGB');
    await assert.rejects(decodeWasmFrame(encoded, { ...metadata, encodedPhotometric: 'YBR_RCT' }), /component transform/);
    await assert.rejects(decodeWasmFrame(encoded, { ...metadata, encodedPhotometric: 'YBR_ICT', transferSyntax: syntax(90) }), /header/);
});

test('JPEG 2000 final tile part with unspecified length stays bounded by its final EOC', async () => {
    const metadata = mono(90);
    const encoded = encode([0, 1, 2, 3, 4, 5, 6, 7], metadata);
    const sot = marker(encoded, 144);
    const altered = encoded.slice(); altered.fill(0, sot + 6, sot + 10);
    const result = await decodeWasmFrame(altered, metadata, { wasmBytes: moduleBytes });
    assert.deepEqual(Array.from(result.bytes), [0, 1, 2, 3, 4, 5, 6, 7]);
    const invalidTile = encoded.slice(); invalidTile[sot + 5] = 1;
    await assert.rejects(decodeWasmFrame(invalidTile, metadata, { wasmBytes: new Uint8Array() }), /header/);
});

test('Node source loader works without upstream JavaScript runtime registration', async () => {
    const metadata = mono(80);
    const result = await decodeWasmFrame(encode([0, 1, 2, 3, 4, 5, 6, 255], metadata), metadata);
    assert.deepEqual(Array.from(result.bytes), [0, 1, 2, 3, 4, 5, 6, 255]);
});

test('returned bytes own their memory and are unchanged by later decodes', async () => {
    const metadata = mono(80);
    const first = await decodeWasmFrame(encode([0, 1, 2, 3, 4, 5, 6, 7], metadata), metadata, { wasmBytes: moduleBytes });
    const second = await decodeWasmFrame(encode([200, 201, 202, 203, 204, 205, 206, 207], metadata), metadata, { wasmBytes: moduleBytes });
    assert.deepEqual(Array.from(first.bytes), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(Array.from(second.bytes), [200, 201, 202, 203, 204, 205, 206, 207]);
});

test('codestream geometry, components and precision are checked before WASM allocation', async () => {
    for (const suffix of [70, 80, 90]) {
        const metadata = mono(suffix);
        const encoded = encode([0, 1, 2, 3, 4, 5, 6, 7], metadata);
        for (const change of [{ rows: 3 }, { columns: 5 }, { samplesPerPixel: 3, photometric: 'RGB', planarConfiguration: 0 }, { bitsStored: 7, highBit: 6 }]) {
            await assert.rejects(decodeWasmFrame(encoded, { ...metadata, ...change }, { wasmBytes: new Uint8Array() }), /do not match/);
        }
    }
});

test('JPEG 2000 signedness must match its explicit SIZ declaration before WASM allocation', async () => {
    const metadata = mono(90);
    const encoded = encode([0, 1, 2, 3, 4, 5, 6, 7], metadata);
    await assert.rejects(decodeWasmFrame(encoded, { ...metadata, signed: true }, { wasmBytes: new Uint8Array() }), /signedness/);
});

test('frame and WASM byte budgets reject unbounded inputs before allocation', async () => {
    const metadata = mono(70);
    const encoded = encode([0, 1, 2, 3, 4, 5, 6, 7], metadata);
    await assert.rejects(decodeWasmFrame(new Uint8Array(64 * 1024 * 1024 + 1), metadata), /input limit/);
    await assert.rejects(decodeWasmFrame(encoded, { ...metadata, rows: 65535, columns: 65535 }), /header/);
    await assert.rejects(decodeWasmFrame(encoded, metadata, { wasmBytes: new Uint8Array(8 * 1024 * 1024 + 1) }), /module/);
});

test('lossless JPEG selection 1 rejects other predictors and every nonzero point transform', async () => {
    const metadata = mono(70);
    const encoded = encode([0, 1, 2, 3, 4, 5, 6, 7], metadata);
    const sos = marker(encoded, 218);
    const predictor = encoded.slice(); predictor[sos + 7] = 2;
    await assert.rejects(decodeWasmFrame(predictor, metadata, { wasmBytes: new Uint8Array() }), /predictor/);
    const pointTransform = encoded.slice(); pointTransform[sos + 9] = 1;
    await assert.rejects(decodeWasmFrame(pointTransform, metadata, { wasmBytes: new Uint8Array() }), /point transform/);
    const selection14 = mono(57);
    const encodedP2 = encode([0, 1, 2, 3, 4, 5, 6, 7], selection14, { predictor: 2 });
    const result = await decodeWasmFrame(encodedP2, selection14, { wasmBytes: moduleBytes });
    assert.deepEqual(Array.from(result.bytes), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('JPEG-LS lossless UID rejects NEAR and invalid scan transform/interleave declarations', async () => {
    const metadata = mono(80);
    const encoded = encode([0, 1, 2, 3, 4, 5, 6, 7], metadata);
    const sos = marker(encoded, 218);
    for (const change of [[7, 1], [8, 1], [9, 1]]) {
        const altered = encoded.slice(); altered[sos + change[0]] = change[1];
        await assert.rejects(decodeWasmFrame(altered, metadata, { wasmBytes: new Uint8Array() }), /header/);
    }
});

test('JPEG-LS embedded HP transforms reject with a specific profile reason before codec allocation', async () => {
    const metadata = { ...mono(80), photometric: 'RGB', samplesPerPixel: 3, planarConfiguration: 0 };
    const encoded = encode(rgbValues, metadata);
    for (const transform of [1, 2, 3, 255]) {
        const marker = Uint8Array.of(255, 232, 0, 7, 109, 114, 102, 120, transform);
        const input = new Uint8Array(encoded.length + marker.length);
        input.set(encoded.subarray(0, 2)); input.set(marker, 2); input.set(encoded.subarray(2), 2 + marker.length);
        const original = input.slice();
        await assert.rejects(decodeWasmFrame(input, metadata, { wasmBytes: new Uint8Array(1) }),
            error => error.message === 'Embedded HP color transforms require a dedicated decoding profile.');
        assert.deepEqual(input, original, 'A rejected color profile must not change its source codestream.');
    }
});

test('JPEG-LS with an explicit zero HP transform preserves the ordinary decoded RGB samples', async () => {
    const metadata = { ...mono(80), photometric: 'RGB', samplesPerPixel: 3, planarConfiguration: 0 };
    const encoded = encode(rgbValues, metadata), marker = Uint8Array.of(255, 232, 0, 7, 109, 114, 102, 120, 0);
    const input = new Uint8Array(encoded.length + marker.length);
    input.set(encoded.subarray(0, 2)); input.set(marker, 2); input.set(encoded.subarray(2), 2 + marker.length);
    const result = await decodeWasmFrame(input, metadata);
    assert.deepEqual(Array.from(result.bytes), rgbValues);
    assert.deepEqual(result.metadataOverrides, { littleEndian: true, planarConfiguration: 0, photometric: 'RGB' });
});

test('JPEG-LS near-lossless output stays within independently selected NEAR bound', async () => {
    const metadata = mono(81);
    const expected = [1, 11, 41, 61, 101, 181, 231, 253];
    const encoded = encode(expected, metadata, { lossy: true, allowedLossyError: 2 });
    const result = await decodeWasmFrame(encoded, metadata, { wasmBytes: moduleBytes });
    for (let index = 0; index < expected.length; index++) assert.ok(Math.abs(result.bytes[index] - expected[index]) <= 2);
    await assert.rejects(decodeWasmFrame(encoded, { ...metadata, transferSyntax: syntax(80) }), /header/);
});

test('JPEG 2000 lossless UID rejects irreversible coding and mismatched color transforms', async () => {
    const metadata = mono(90);
    const encoded = encode([0, 1, 2, 3, 4, 5, 6, 7], metadata);
    const cod = marker(encoded, 82);
    const irreversible = encoded.slice(); irreversible[cod + 13] = 0;
    await assert.rejects(decodeWasmFrame(irreversible, metadata, { wasmBytes: new Uint8Array() }), /header/);
    const mct = encoded.slice(); mct[cod + 8] = 1;
    await assert.rejects(decodeWasmFrame(mct, metadata, { wasmBytes: new Uint8Array() }), /component transform/);
    const quantized = encoded.slice(); quantized[marker(encoded, 92) + 4] = 65;
    await assert.rejects(decodeWasmFrame(quantized, metadata, { wasmBytes: new Uint8Array() }), /header/);
});

test('malformed frames, trailing instances and unsupported metadata fail explicitly', async () => {
    for (const suffix of [70, 80, 90]) {
        const metadata = mono(suffix);
        const encoded = encode([0, 1, 2, 3, 4, 5, 6, 7], metadata);
        for (const bytes of [new Uint8Array(), encoded.subarray(0, 8), encoded.subarray(0, encoded.length - 2), new Uint8Array([...encoded, ...encoded])]) {
            await assert.rejects(decodeWasmFrame(bytes, metadata, { wasmBytes: new Uint8Array() }), /header|empty/);
        }
        const padded = new Uint8Array([...encoded, 0]);
        assert.equal((await decodeWasmFrame(padded, metadata, { wasmBytes: moduleBytes })).bytes.length, 8);
        for (const change of [{ highBit: 6 }, { signed: 1 }, { bitsAllocated: 32 }, { photometric: 'PALETTE COLOR' }, { transferSyntax: syntax(50) }]) {
            await assert.rejects(decodeWasmFrame(encoded, { ...metadata, ...change }), /header/);
        }
    }
});

test('native decoder exceptions are sanitized and release both C handles', async () => {
    const original = WebAssembly.instantiate;
    let contexts = 0, parameters = 0, releases = 0, parameterReleases = 0;
    WebAssembly.instantiate = async (...args) => {
        const result = await original(...args);
        const api = result.instance.exports;
        const wrapped = { ...api,
            CreateCodecsContext() { contexts++; return api.CreateCodecsContext(); },
            CreateDecoderParameters() { parameters++; return api.CreateDecoderParameters(); },
            ReleaseCodecsContext(pointer) { releases++; return api.ReleaseCodecsContext(pointer); },
            ReleaseDecoderParameters(pointer) { parameterReleases++; return api.ReleaseDecoderParameters(pointer); },
            DecodeJpegLs() { throw new Error('Private frame filename or patient identifier must not escape.'); }
        };
        return { ...result, instance: { exports: wrapped } };
    };
    try {
        const metadata = mono(80);
        await assert.rejects(decodeWasmFrame(encode([0, 1, 2, 3, 4, 5, 6, 7], metadata), metadata,
            { wasmBytes: moduleBytes.slice() }), error => {
            assert.equal(error.message, 'Compressed frame decoding failed or produced an unsupported layout.');
            return true;
        });
        assert.equal(contexts, 1); assert.equal(parameters, 1);
        assert.equal(releases, 1); assert.equal(parameterReleases, 1);
    } finally { WebAssembly.instantiate = original; }
});

test('unexpected native output layout is rejected and released before returning pixels', async () => {
    const original = WebAssembly.instantiate;
    let releases = 0;
    WebAssembly.instantiate = async (...args) => {
        const result = await original(...args);
        const api = result.instance.exports;
        return { ...result, instance: { exports: { ...api,
            GetDecodedBufferSize(pointer) { return api.GetDecodedBufferSize(pointer) + 1; },
            ReleaseCodecsContext(pointer) { releases++; return api.ReleaseCodecsContext(pointer); }
        } } };
    };
    try {
        const metadata = mono(80);
        await assert.rejects(decodeWasmFrame(encode([0, 1, 2, 3, 4, 5, 6, 7], metadata), metadata,
            { wasmBytes: moduleBytes.slice() }), /unsupported layout/);
        assert.equal(releases, 1);
    } finally { WebAssembly.instantiate = original; }
});

test('canonical codec allocation checks reject claimed DICOM-width output before widening', async () => {
    const original = WebAssembly.instantiate;
    let releases = 0;
    WebAssembly.instantiate = async (...args) => {
        const result = await original(...args), api = result.instance.exports;
        return { ...result, instance: { exports: { ...api,
            GetBitsAllocated() { return 16; },
            GetDecodedBufferSize(pointer) { return api.GetDecodedBufferSize(pointer) * 2; },
            ReleaseCodecsContext(pointer) { releases++; return api.ReleaseCodecsContext(pointer); }
        } } };
    };
    try {
        const metadata = mono(70, 16, 8);
        await assert.rejects(decodeWasmFrame(encode([0, 1, 127, 128, 200, 254, 255, 80], metadata), metadata,
            { wasmBytes: moduleBytes.slice() }), /unsupported layout/);
        assert.equal(releases, 1);
    } finally { WebAssembly.instantiate = original; }
});

test('failed native instance is discarded and a subsequent valid frame reloads safely', async () => {
    const original = WebAssembly.instantiate;
    const injected = moduleBytes.slice();
    let creates = 0, releases = 0;
    WebAssembly.instantiate = async (...args) => {
        const result = await original(...args);
        creates++;
        if (creates > 1) return result;
        const api = result.instance.exports;
        return { ...result, instance: { exports: { ...api,
            DecodeJpegLs() { throw new Error('Untrusted native details.'); },
            ReleaseCodecsContext(pointer) { releases++; return api.ReleaseCodecsContext(pointer); }
        } } };
    };
    try {
        const metadata = mono(80);
        const encoded = encode([0, 1, 2, 3, 4, 5, 6, 7], metadata);
        await assert.rejects(decodeWasmFrame(encoded, metadata, { wasmBytes: injected }), /decoding failed/);
        assert.deepEqual(Array.from((await decodeWasmFrame(encoded, metadata, { wasmBytes: injected })).bytes), [0, 1, 2, 3, 4, 5, 6, 7]);
        assert.equal(creates, 2); assert.equal(releases, 1);
    } finally { WebAssembly.instantiate = original; }
});

test('a failed parameter release still releases the context and sanitizes its error', async () => {
    const original = WebAssembly.instantiate;
    let releases = 0;
    WebAssembly.instantiate = async (...args) => {
        const result = await original(...args);
        const api = result.instance.exports;
        return { ...result, instance: { exports: { ...api,
            ReleaseDecoderParameters(pointer) { api.ReleaseDecoderParameters(pointer); throw new Error('Private native diagnostic.'); },
            ReleaseCodecsContext(pointer) { releases++; return api.ReleaseCodecsContext(pointer); }
        } } };
    };
    try {
        const metadata = mono(80);
        await assert.rejects(decodeWasmFrame(encode([0, 1, 2, 3, 4, 5, 6, 7], metadata), metadata,
            { wasmBytes: moduleBytes.slice() }), error => error.message === 'Compressed frame decoder cleanup failed.');
        assert.equal(releases, 1);
    } finally { WebAssembly.instantiate = original; }
});
