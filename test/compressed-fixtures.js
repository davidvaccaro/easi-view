import jpeg from 'jpeg-js';
import codecs from 'dcmjs-codecs';
import { createDicomFixture } from '../src/data/synthetic.js';

// Test-only encoders. Every raster and identifier is synthetic; no binary corpus
// or production decoder is used to define the expected original sample values.
export const COMPRESSED_FIXTURE_SYNTAXES = Object.freeze({
    rle: '1.2.840.10008.1.2.5', jpeg: '1.2.840.10008.1.2.4.50', 'jpeg-extended': '1.2.840.10008.1.2.4.51',
    'jpeg-lossless': '1.2.840.10008.1.2.4.70',
    'jpeg-ls': '1.2.840.10008.1.2.4.80', 'jpeg-ls-near': '1.2.840.10008.1.2.4.81',
    jpeg2000: '1.2.840.10008.1.2.4.90', 'jpeg2000-lossy': '1.2.840.10008.1.2.4.91'
});
const LONG_VR = new Set(['OB', 'OW', 'OD', 'OF', 'OL', 'OV', 'SQ', 'UC', 'UR', 'UN', 'UT']);
let nativeReady;

function concat(parts) {
    const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) { output.set(part, offset); offset += part.length; }
    return output;
}

/**
 * Independent sequential SOF1 fixture encoder for constant monochrome 8x8 blocks.
 * The pinned upstream encoder rejects lossy12 input. For these invented rasters,
 * DCT DC = 8 * (sample - midpoint), every AC coefficient is zero, and each scan
 * codes a DC difference plus AC EOB. No decoder output defines the reference.
 */
export function encodeExtendedJpegDcFrame(samples, options, { quantization = 1, restartInterval = 0, omitAcEob = false } = {}) {
    const { rows, columns, bitsStored: precision, samplesPerPixel = 1, signed = false } = options;
    if (![8, 12].includes(precision) || signed || samplesPerPixel !== 1
        || !Number.isInteger(rows) || !Number.isInteger(columns) || rows < 8 || columns < 8
        || rows > 65535 || columns > 65535 || rows % 8 || columns % 8
        || samples.length !== rows * columns || !Number.isInteger(quantization) || quantization < 1 || quantization > 255
        || !Number.isInteger(restartInterval) || restartInterval < 0 || restartInterval > 65535
        || typeof omitAcEob !== 'boolean') {
        throw new Error('Synthetic Extended JPEG requires unsigned8/12 constant8x8 monochrome blocks.');
    }
    const midpoint = 2 ** (precision - 1), maximum = 2 ** precision - 1;
    const dcValues = [];
    for (let row = 0; row < rows; row += 8) for (let column = 0; column < columns; column += 8) {
        const sample = samples[row * columns + column];
        if (!Number.isInteger(sample) || sample < 0 || sample > maximum) throw new Error('Synthetic sample is outside its declared precision.');
        for (let y = row; y < row + 8; y++) for (let x = column; x < column + 8; x++) {
            if (samples[y * columns + x] !== sample) throw new Error('Synthetic Extended JPEG requires constant8x8 blocks.');
        }
        dcValues.push(Math.round(8 * (sample - midpoint) / quantization));
    }
    const output = [255, 216];
    const segment = (marker, payload) => output.push(255, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255, ...payload);
    segment(219, [0, ...Array(64).fill(quantization)]);
    const dcCounts = Array(16).fill(0); dcCounts[4] = precision + 4;
    const acCounts = Array(16).fill(0); acCounts[0] = 1;
    segment(196, [0, ...dcCounts, ...Array.from({ length: precision + 4 }, (_, index) => index), 16, ...acCounts, 0]);
    segment(193, [precision, rows >> 8, rows & 255, columns >> 8, columns & 255, 1, 1, 17, 0]);
    if (restartInterval) segment(221, [restartInterval >> 8, restartInterval & 255]);
    segment(218, [1, 1, 0, 0, 63, 0]);
    let accumulator = 0, bitCount = 0, previousDc = 0;
    const bits = (value, count) => {
        for (let bit = count - 1; bit >= 0; bit--) {
            accumulator = accumulator * 2 + ((value >> bit) & 1);
            if (++bitCount === 8) {
                output.push(accumulator); if (accumulator === 255) output.push(0);
                accumulator = 0; bitCount = 0;
            }
        }
    };
    let restart = 0;
    for (let index = 0; index < dcValues.length; index++) {
        const dc = dcValues[index];
        const difference = dc - previousDc; previousDc = dc;
        const category = difference ? Math.floor(Math.log2(Math.abs(difference))) + 1 : 0;
        if (category > precision + 3) throw new Error('Synthetic Extended JPEG DC category is outside the process bounds.');
        bits(category, 5);
        if (category) bits(difference < 0 ? difference + 2 ** category - 1 : difference, category);
        // omitAcEob deliberately creates a malformed DC-only scan for tests.
        if (!omitAcEob) bits(0, 1); // The only AC symbol is EOB.
        if (restartInterval && (index + 1) % restartInterval === 0 && index + 1 < dcValues.length) {
            if (bitCount) bits(2 ** (8 - bitCount) - 1, 8 - bitCount);
            output.push(255, 208 + restart++ % 8);
            previousDc = 0;
        }
    }
    if (bitCount) bits(2 ** (8 - bitCount) - 1, 8 - bitCount);
    output.push(255, 217);
    return Uint8Array.from(output);
}

function item(payload, tag = 0xe000) {
    const bytes = new Uint8Array(8 + payload.length), view = new DataView(bytes.buffer);
    view.setUint16(0, 0xfffe, true); view.setUint16(2, tag, true); view.setUint32(4, payload.length, true);
    bytes.set(payload, 8); return bytes;
}

function longElement(group, element, vr, payload, length = payload.length) {
    const header = new Uint8Array(12), view = new DataView(header.buffer);
    view.setUint16(0, group, true); view.setUint16(2, element, true);
    header.set(new TextEncoder().encode(vr), 4); view.setUint32(8, length, true);
    return concat([header, payload]);
}

/** Original interleaved samples packed into independent DICOM native bytes. */
export function packFixtureSamples(samples, options) {
    const { bitsAllocated = 8, bitsStored = bitsAllocated, highBit = bitsStored - 1, signed = false } = options;
    if (![8, 16].includes(bitsAllocated) || bitsStored < 1 || bitsStored > bitsAllocated ||
        highBit < bitsStored - 1 || highBit >= bitsAllocated) throw new Error('Invalid synthetic sample precision.');
    const bytes = new Uint8Array(samples.length * bitsAllocated / 8), view = new DataView(bytes.buffer);
    const min = signed ? -(2 ** (bitsStored - 1)) : 0, max = signed ? 2 ** (bitsStored - 1) - 1 : 2 ** bitsStored - 1;
    for (let index = 0; index < samples.length; index++) {
        const value = samples[index];
        if (!Number.isInteger(value) || value < min || value > max) throw new Error('Synthetic sample is outside its declared precision.');
        const packed = (value < 0 ? value + 2 ** bitsStored : value) * 2 ** (highBit + 1 - bitsStored);
        if (bitsAllocated === 8) bytes[index] = packed;
        else view.setUint16(index * 2, packed, true);
    }
    return bytes;
}

// PackBits packets stop at each row boundary. Both literal and repeated runs are
// generated, with no-op-free trailing zero pad only after all row samples.
function packBitsRow(row) {
    const result = [];
    let index = 0;
    while (index < row.length) {
        let repeat = 1;
        while (repeat < 128 && index + repeat < row.length && row[index + repeat] === row[index]) repeat++;
        if (repeat >= 2) { result.push(257 - repeat, row[index]); index += repeat; continue; }
        const start = index++;
        while (index - start < 128 && index < row.length) {
            if (index + 1 < row.length && row[index] === row[index + 1]) break;
            index++;
        }
        result.push(index - start - 1, ...row.subarray(start, index));
    }
    return new Uint8Array(result);
}

/** Independent row-wise RLE encoder, MSB planes first, then color component. */
export function encodeRleFrame(samples, options) {
    const { rows, columns, samplesPerPixel = 1, bitsAllocated = 8 } = options;
    if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(columns) || columns < 1 ||
        samples.length !== rows * columns * samplesPerPixel) throw new Error('Synthetic RLE dimensions disagree.');
    const packed = packFixtureSamples(samples, options), bytesPerSample = bitsAllocated / 8;
    const segments = [];
    for (let component = 0; component < samplesPerPixel; component++) {
        for (let byte = bytesPerSample - 1; byte >= 0; byte--) {
            const rowsEncoded = [];
            for (let row = 0; row < rows; row++) {
                const values = new Uint8Array(columns);
                for (let column = 0; column < columns; column++) {
                    values[column] = packed[((row * columns + column) * samplesPerPixel + component) * bytesPerSample + byte];
                }
                rowsEncoded.push(packBitsRow(values));
            }
            let segment = concat(rowsEncoded);
            if (segment.length % 2) segment = concat([segment, new Uint8Array(1)]);
            segments.push(segment);
        }
    }
    if (segments.length > 15) throw new Error('Synthetic RLE has too many segments.');
    const header = new Uint8Array(64), view = new DataView(header.buffer);
    view.setUint32(0, segments.length, true); let offset = 64;
    segments.forEach((segment, index) => { view.setUint32(4 + index * 4, offset, true); offset += segment.length; });
    return concat([header, ...segments]);
}

function fragmentFrame(frame, count) {
    if (!(frame instanceof Uint8Array) || !frame.length || !Number.isInteger(count) || count < 1 || count * 2 > frame.length + 1) {
        throw new Error('Invalid synthetic encapsulated fragment request.');
    }
    const fragments = []; let start = 0;
    for (let index = 0; index < count; index++) {
        // Every interior split has even length. Padding is permitted only after
        // the codestream, never between two pieces of the same JPEG frame.
        const remaining = count - index;
        const length = remaining === 1 ? frame.length - start : Math.max(2, Math.floor((frame.length - start) / remaining / 2) * 2);
        let fragment = frame.subarray(start, start + length); start += length;
        if (fragment.length % 2) fragment = concat([fragment, new Uint8Array(1)]);
        fragments.push(fragment);
    }
    return fragments;
}

function encapsulation(frames, options = {}) {
    const { bot = true, fragmentsPerFrame = 1 } = options;
    const fragments = frames.map((frame, index) => fragmentFrame(frame,
        Array.isArray(fragmentsPerFrame) ? fragmentsPerFrame[index] : fragmentsPerFrame));
    const offsets = [], lengths = []; let offset = 0;
    for (let index = 0; index < frames.length; index++) {
        offsets.push(offset); lengths.push(frames[index].length);
        for (const fragment of fragments[index]) offset += 8 + fragment.length;
    }
    const table = new Uint8Array(bot ? frames.length * 4 : 0), view = new DataView(table.buffer);
    if (bot) offsets.forEach((entry, index) => view.setUint32(index * 4, entry, true));
    return { bytes: concat([item(table), ...fragments.flat().map(fragment => item(fragment)), item(new Uint8Array(), 0xe0dd)]), offsets, lengths, fragments };
}

/** Pixel Data value: BOT + even-length fragment items + sequence delimiter. */
export function encapsulatePixelData(frames, options = {}) { return encapsulation(frames, options).bytes; }

function uint64(values) {
    const bytes = new Uint8Array(values.length * 8), view = new DataView(bytes.buffer);
    values.forEach((value, index) => view.setBigUint64(index * 8, BigInt(value), true)); return bytes;
}

/** Part 10 writer for arbitrary pre-encoded synthetic frames, including bad fixtures. */
export function createEncapsulatedDicom(frames, options = {}) {
    if (!frames.length) throw new Error('A compressed fixture needs at least one frame.');
    const metadata = createDicomFixture({ ...options, frames: options.frames ?? frames.length,
        transferSyntax: options.transferSyntax ?? COMPRESSED_FIXTURE_SYNTAXES.rle, rawPixelBytes: new Uint8Array() });
    const view = new DataView(metadata.buffer, metadata.byteOffset, metadata.byteLength); let offset = 132;
    while (offset + 8 <= metadata.length) {
        const group = view.getUint16(offset, true), element = view.getUint16(offset + 2, true);
        if (group === 0x7fe0 && element === 0x0010) break;
        const vr = String.fromCharCode(metadata[offset + 4], metadata[offset + 5]);
        const header = LONG_VR.has(vr) ? 12 : 8;
        const length = header === 12 ? view.getUint32(offset + 8, true) : view.getUint16(offset + 6, true);
        if (length === 0xffffffff) throw new Error('Synthetic metadata must have defined lengths.');
        offset += header + length;
    }
    if (offset + 8 > metadata.length) throw new Error('Synthetic metadata is missing Pixel Data.');
    const encoded = encapsulation(frames, { bot: options.extendedOffsets ? false : options.bot,
        fragmentsPerFrame: options.fragmentsPerFrame ?? 1 });
    const extended = options.extendedOffsets ? [
        longElement(0x7fe0, 0x0001, 'OV', uint64(encoded.offsets)),
        longElement(0x7fe0, 0x0002, 'OV', uint64(encoded.lengths))
    ] : [];
    return concat([metadata.subarray(0, offset), ...extended,
        longElement(0x7fe0, 0x0010, 'OB', encoded.bytes, 0xffffffff)]);
}

async function nativeEncode(samples, options, codec, encoderOptions = {}) {
    const { NativeCodecs, Context } = codecs;
    nativeReady ??= NativeCodecs.initializeAsync({ logCodecsInfo: false, logCodecsTrace: false });
    await nativeReady;
    const context = new Context({ width: options.columns, height: options.rows,
        // CharLS's upstream encoder takes SOF precision from this field; the
        // Part 10 still declares an 8/16-bit native container independently.
        bitsAllocated: codec === 'jpeg-ls' || codec === 'jpeg-ls-near' ? options.bitsStored : options.bitsAllocated,
        bitsStored: options.bitsStored,
        samplesPerPixel: options.samplesPerPixel, pixelRepresentation: options.signed ? 1 : 0,
        planarConfiguration: 0, photometricInterpretation: options.samplesPerPixel === 3 ? 'RGB' : 'MONOCHROME2',
        decodedBuffer: packFixtureSamples(samples, options) });
    let encoded;
    if (codec === 'jpeg') encoded = NativeCodecs.encodeJpeg(context, { lossy: true, quality: 100, sampleFactor: 0 });
    else if (codec === 'jpeg-lossless') encoded = NativeCodecs.encodeJpeg(context, { lossy: false, predictor: encoderOptions.predictor ?? 1 });
    else if (codec === 'jpeg-ls' || codec === 'jpeg-ls-near') encoded = NativeCodecs.encodeJpegLs(context,
        { lossy: codec === 'jpeg-ls-near', allowedLossyError: encoderOptions.allowedLossyError ?? 2 });
    else if (codec === 'jpeg2000' || codec === 'jpeg2000-lossy') encoded = NativeCodecs.encodeJpeg2000(context,
        { lossy: codec === 'jpeg2000-lossy', rate: encoderOptions.rate ?? 1,
            allowMct: ['YBR_RCT', 'YBR_ICT'].includes(options.photometric) ? 1 : 0 });
    else throw new Error('Unknown synthetic native encoder.');
    return new Uint8Array(encoded.getEncodedBuffer());
}

/** Async, deterministic test-only synthetic compressed Part 10 generator. */
export async function createCompressedDicom(options = {}) {
    const codec = options.codec ?? 'rle', samplesPerPixel = options.samplesPerPixel ?? 1;
    if (!Object.hasOwn(COMPRESSED_FIXTURE_SYNTAXES, codec)) throw new Error('Choose a declared synthetic codec.');
    const bitsAllocated = options.bitsAllocated ?? (codec === 'jpeg' || samplesPerPixel === 3 ? 8 : 16);
    const bitsStored = options.bitsStored ?? (codec === 'jpeg-extended' ? 12 : bitsAllocated);
    const metadata = { rows: options.rows ?? 8, columns: options.columns ?? 8, bitsAllocated,
        bitsStored, highBit: options.highBit ?? bitsStored - 1,
        signed: options.signed ?? false, samplesPerPixel, planarConfiguration: options.planarConfiguration ?? 0,
        photometric: options.photometric ?? (samplesPerPixel === 3 ? codec === 'jpeg' ? 'YBR_FULL' : 'RGB' : 'MONOCHROME2') };
    const expectedSamples = (options.frameSamples ?? [Array(metadata.rows * metadata.columns * samplesPerPixel).fill(80)]).map(samples => Array.from(samples));
    const frames = [];
    for (const samples of expectedSamples) {
        if (samples.length !== metadata.rows * metadata.columns * samplesPerPixel) throw new Error('Synthetic compressed dimensions and samples disagree.');
        if (codec === 'rle') frames.push(encodeRleFrame(samples, metadata));
        else if (codec === 'jpeg-extended') frames.push(encodeExtendedJpegDcFrame(samples, metadata, options.encoderOptions));
        else if (codec === 'jpeg' && samplesPerPixel === 3) {
            const rgba = new Uint8Array(metadata.rows * metadata.columns * 4);
            for (let index = 0; index < samples.length / 3; index++) { rgba.set(samples.slice(index * 3, index * 3 + 3), index * 4); rgba[index * 4 + 3] = 255; }
            frames.push(new Uint8Array(jpeg.encode({ width: metadata.columns, height: metadata.rows, data: rgba }, 100).data));
        } else frames.push(await nativeEncode(samples, metadata, codec, options.encoderOptions));
    }
    const dicomMetadata = { ...metadata, ...options.metadataOverrides };
    const extraAttributes = { '00280002': ['US', dicomMetadata.samplesPerPixel],
        '00280006': dicomMetadata.samplesPerPixel === 3 ? ['US', dicomMetadata.planarConfiguration] : null,
        '00281054': null, '00281050': null, '00281051': null, ...options.extraAttributes };
    const bytes = createEncapsulatedDicom(frames, { ...options, ...dicomMetadata,
        frames: options.metadataOverrides?.frames ?? frames.length,
        transferSyntax: options.transferSyntax ?? COMPRESSED_FIXTURE_SYNTAXES[codec],
        modality: options.modality ?? 'OT', sopClass: options.sopClass ?? '1.2.840.10008.5.1.4.1.1.7',
        description: `Synthetic ${codec} fixture`, extraAttributes });
    return { bytes, frames, expectedSamples, metadata: { ...dicomMetadata, frameCount: frames.length,
        transferSyntax: options.transferSyntax ?? COMPRESSED_FIXTURE_SYNTAXES[codec] } };
}
