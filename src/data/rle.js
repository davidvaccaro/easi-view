export const MAX_RLE_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_FRAME_PIXELS = 16 * 1024 * 1024;
const MAX_ENCODED_BYTES = 256 * 1024 * 1024;

function invalid(message) { return new Error(`Invalid DICOM RLE frame: ${message}.`); }

function decodeSegment(encoded, columns, count, output, stride, componentOffset) {
    let source = 0;
    let written = 0;
    while (written < count) {
        if (source >= encoded.byteLength) throw invalid('the segment ends before all samples are decoded');
        const control = encoded[source++];
        if (control === 128) continue; // PackBits -128 is a no-op, not a run prefix.
        const length = control <= 127 ? control + 1 : 257 - control;
        if (length > count - written || length > columns - written % columns) {
            throw invalid('a PackBits run exceeds its output or row boundary');
        }
        if (control <= 127) {
            if (source + length > encoded.byteLength) throw invalid('a literal run is truncated');
            for (let index = 0; index < length; index++) output[(written + index) * stride + componentOffset] = encoded[source + index];
            source += length;
        } else {
            if (source >= encoded.byteLength) throw invalid('a repeated run is truncated');
            const value = encoded[source++];
            for (let index = 0; index < length; index++) output[(written + index) * stride + componentOffset] = value;
        }
        written += length;
    }
    // No extra samples are allowed. A segment can end in no-ops and one zero pad byte.
    while (source < encoded.byteLength && encoded[source] === 128) source++;
    if (source !== encoded.byteLength && !(source === encoded.byteLength - 1 && encoded[source] === 0)) {
        throw invalid('the segment contains extra encoded samples');
    }
}

/**
 * PS3.5 G.2-G.5: reconstruct byte planes into native interleaved pixel bytes.
 * Sixteen-bit samples use little-endian order. RGB output is interleaved even
 * when the compressed dataset declares Planar Configuration 1. No rescale,
 * signed conversion, padding removal or display transform is performed here.
 */
export function decodeRleFrame(encoded, metadata, { maxOutputBytes = MAX_RLE_OUTPUT_BYTES } = {}) {
    if (!(encoded instanceof Uint8Array) || encoded.byteLength < 64 || encoded.byteLength > MAX_ENCODED_BYTES) {
        throw invalid('a bounded Uint8Array with a complete 64-byte header is required');
    }
    const { rows, columns, bitsAllocated, samplesPerPixel = 1 } = metadata;
    const photometric = metadata.photometric ?? (samplesPerPixel === 3 ? 'RGB' : 'MONOCHROME2');
    if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1 ||
        rows > 8192 || columns > 8192 || rows * columns > MAX_FRAME_PIXELS || ![8, 16].includes(bitsAllocated) ||
        ![1, 3].includes(samplesPerPixel) ||
        (samplesPerPixel === 1 ? !['MONOCHROME1', 'MONOCHROME2', 'PALETTE COLOR'].includes(photometric) : !['RGB', 'YBR_FULL'].includes(photometric)) ||
        (samplesPerPixel === 3 && (metadata.signed === true || bitsAllocated !== 8))) {
        throw invalid('only bounded 8/16-bit monochrome or unsigned 8-bit RGB/YBR_FULL byte layouts are supported');
    }
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > MAX_RLE_OUTPUT_BYTES) {
        throw invalid('the decoded-byte budget is invalid');
    }
    const count = rows * columns;
    const sampleBytes = bitsAllocated / 8;
    const stride = samplesPerPixel * sampleBytes;
    const outputLength = count * stride;
    if (outputLength > maxOutputBytes) throw invalid('the decoded frame exceeds its byte budget');
    const header = new DataView(encoded.buffer, encoded.byteOffset, 64);
    const segmentCount = header.getUint32(0, true);
    if (segmentCount !== stride || segmentCount < 1 || segmentCount > 15) throw invalid('the segment count does not match the pixel layout');
    const offsets = [];
    for (let index = 0; index < 15; index++) {
        const offset = header.getUint32((index + 1) * 4, true);
        if (index >= segmentCount) {
            if (offset !== 0) throw invalid('unused segment offsets must be zero');
        } else {
            if ((index === 0 && offset !== 64) || offset < 64 || offset >= encoded.byteLength ||
                offset % 2 !== 0 || (index > 0 && offset <= offsets[index - 1])) {
                throw invalid('segment offsets are not valid increasing byte boundaries');
            }
            offsets.push(offset);
        }
    }
    if (encoded.byteLength % 2 !== 0) throw invalid('compressed segments must have even lengths');
    const output = new Uint8Array(outputLength);
    for (let segment = 0; segment < segmentCount; segment++) {
        const stop = segment + 1 < segmentCount ? offsets[segment + 1] : encoded.byteLength;
        const component = Math.floor(segment / sampleBytes);
        const significantByte = sampleBytes - 1 - segment % sampleBytes;
        decodeSegment(encoded.subarray(offsets[segment], stop), columns, count, output,
            stride, component * sampleBytes + significantByte);
    }
    return output;
}
