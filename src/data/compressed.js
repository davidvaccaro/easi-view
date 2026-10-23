import decodeJpeg from 'jpeg-js/lib/decoder.js';
import { decodeNative } from './native.js';
import { decodeRleFrame } from './rle.js';
import { PHILIPS_PRIVATE_CT_SYNTAX, PHILIPS_PRIVATE_PIXEL_PROFILE } from './philips-private.js';

export const COMPRESSED_SYNTAXES = new Set([
    '1.2.840.10008.1.2.4.50', '1.2.840.10008.1.2.4.51', '1.2.840.10008.1.2.4.57', '1.2.840.10008.1.2.4.70',
    '1.2.840.10008.1.2.4.80', '1.2.840.10008.1.2.4.81',
    '1.2.840.10008.1.2.4.90', '1.2.840.10008.1.2.4.91', '1.2.840.10008.1.2.5'
]);

/** Read the baseline frame header before allowing a decoder to allocate pixels. */
export function jpegBaselineHeader(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) {
        throw new Error('Invalid JPEG Baseline frame.');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 2, header = null, adobeTransform = null, icc = false, markers = 0;
    while (offset < bytes.length && ++markers <= 4096) {
        if (bytes[offset++] !== 255) throw new Error('Invalid JPEG marker boundary.');
        while (bytes[offset] === 255) offset++;
        const marker = bytes[offset++];
        if (marker === 217 || marker === 0 || marker === 216 || offset + 2 > bytes.length) break;
        const length = view.getUint16(offset);
        if (length < 2 || offset + length > bytes.length) throw new Error('Truncated JPEG frame header.');
        if (marker === 218) {
            if (header) return { ...header, adobeTransform, icc };
            break;
        }
        if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
            if (header || marker !== 192 || length < 8) throw new Error('The codestream is not an 8-bit JPEG Baseline frame.');
            const components = bytes[offset + 7];
            if (length !== 8 + 3 * components) throw new Error('Invalid JPEG frame components.');
            header = { precision: bytes[offset + 2], rows: view.getUint16(offset + 3), columns: view.getUint16(offset + 5), components };
        }
        const startsWith = text => length >= text.length + 2 && [...text].every((char,index) => bytes[offset + 2 + index] === char.charCodeAt(0));
        if (marker === 238 && startsWith('Adobe')) {
            if (length < 14 || adobeTransform !== null) throw new Error('Invalid JPEG Adobe color marker.');
            adobeTransform = bytes[offset + 13];
        }
        if (marker === 226 && startsWith('ICC_PROFILE')) icc = true;
        offset += length;
    }
    throw new Error('JPEG Baseline frame header is missing.');
}

export function decodeJpegBaseline(bytes, metadata) {
    const header = jpegBaselineHeader(bytes);
    if (header.precision !== 8 || header.rows !== metadata.rows || header.columns !== metadata.columns ||
        header.components !== metadata.samplesPerPixel || metadata.bitsAllocated !== 8 || metadata.bitsStored !== 8 ||
        metadata.highBit !== 7 || metadata.signed || ![1, 3].includes(header.components)) {
        throw new Error('JPEG Baseline codestream dimensions, components or precision do not match the DICOM metadata.');
    }
    const photometric = metadata.encodedPhotometric ?? metadata.photometric;
    if (header.icc || (header.adobeTransform !== null && (header.components !== 3 ||
        header.adobeTransform !== (photometric.startsWith('YBR') ? 1 : 0)))) {
        throw new Error('JPEG embedded color transform or ICC profile is unsupported or conflicts with DICOM photometric metadata.');
    }
    const decoded = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: false, tolerantDecoding: false,
        colorTransform: photometric.startsWith('YBR'), maxResolutionInMP: 16, maxMemoryUsageInMB: 256 });
    if (decoded.width !== header.columns || decoded.height !== header.rows || decoded.data.length !== header.rows * header.columns * 3) {
        throw new Error('JPEG decoder output does not match the expected frame.');
    }
    if (header.components === 3) return decoded.data;
    const samples = new Uint8Array(header.rows * header.columns);
    for (let index = 0; index < samples.length; index++) samples[index] = decoded.data[index * 3];
    return samples;
}

/** A source record retains encoded pixels; only the requested frame is assembled. */
export function encodedFrame(record, frameIndex) {
    if (record.encapsulated) return record.encapsulated.getFrame(frameIndex);
    const common = record.common;
    const channels = common.samplesPerPixel ?? 1;
    const bytes = common.rows * common.columns * common.bitsAllocated / 8 * channels;
    const length = common.encodedPhotometric === 'YBR_FULL_422' ? bytes * 2 / 3 : bytes;
    return record.bytes.subarray(frameIndex * length, (frameIndex + 1) * length);
}

function convertYbr(bytes, metadata) {
    const count = metadata.rows * metadata.columns;
    const result = new Uint8Array(count * 3);
    const partial = metadata.encodedPhotometric === 'YBR_FULL_422';
    if (bytes.length !== count * (partial ? 2 : 3)) throw new Error('Invalid native YBR frame length.');
    const clamp = value => Math.max(0, Math.min(255, Math.round(value)));
    for (let pixel = 0; pixel < count; pixel++) {
        let y, cb, cr;
        if (partial) {
            const base = Math.floor(pixel / 2) * 4;
            y = bytes[base + pixel % 2]; cb = bytes[base + 2]; cr = bytes[base + 3];
        } else if (metadata.planarConfiguration === 1) {
            y = bytes[pixel]; cb = bytes[count + pixel]; cr = bytes[2 * count + pixel];
        } else {
            y = bytes[pixel * 3]; cb = bytes[pixel * 3 + 1]; cr = bytes[pixel * 3 + 2];
        }
        result[pixel * 3] = clamp(y + 1.402 * (cr - 128));
        result[pixel * 3 + 1] = clamp(y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128));
        result[pixel * 3 + 2] = clamp(y + 1.772 * (cb - 128));
    }
    return result;
}

/** Dispatch only declared profiles, retaining scalar stored samples for rendering. */
export async function decodeFrame(bytes, metadata) {
    const syntax = metadata.transferSyntax;
    let native = bytes;
    let decodedMetadata = metadata;
    if (syntax === PHILIPS_PRIVATE_CT_SYNTAX || metadata.pixelDecodingProfile != null) {
        if (syntax !== PHILIPS_PRIVATE_CT_SYNTAX || metadata.pixelDecodingProfile !== PHILIPS_PRIVATE_PIXEL_PROFILE ||
            metadata.photometric !== 'MONOCHROME2' || metadata.encodedPhotometric !== 'MONOCHROME2' || metadata.samplesPerPixel !== 1 ||
            metadata.bitsAllocated !== 16 || metadata.bitsStored !== 12 || metadata.highBit !== 11 || metadata.signed !== false || metadata.littleEndian !== true ||
            !Number.isInteger(metadata.rows) || metadata.rows < 1 || metadata.rows > 8192 || !Number.isInteger(metadata.columns) || metadata.columns < 1 || metadata.columns > 8192 ||
            metadata.rows * metadata.columns > 16 * 1024 * 1024 || !(bytes instanceof Uint8Array) || bytes.byteLength !== metadata.rows * metadata.columns * 2) {
            throw new Error('Philips private CT decoding requires verified canonical native16 LE storage and its exact private transfer syntax.');
        }
        // These bytes were expanded and bounded once by normalizeInstance;
        // the original private UID remains attached to the frame and inspector.
    } else if (syntax === '1.2.840.10008.1.2.5') {
        native = decodeRleFrame(bytes, { ...metadata, photometric: metadata.encodedPhotometric ?? metadata.photometric });
        decodedMetadata = { ...metadata, littleEndian: true, planarConfiguration: 0 };
        if (metadata.encodedPhotometric?.startsWith('YBR')) native = convertYbr(native, decodedMetadata);
    } else if (syntax === '1.2.840.10008.1.2.4.50') {
        native = decodeJpegBaseline(bytes, metadata);
        decodedMetadata = { ...metadata, littleEndian: true, planarConfiguration: metadata.photometric === 'RGB' ? 0 : null };
    } else if (COMPRESSED_SYNTAXES.has(syntax)) {
        const { decodeWasmFrame } = await import('./wasm-codecs.js');
        const result = await decodeWasmFrame(bytes, metadata);
        native = result.bytes;
        decodedMetadata = { ...metadata, ...result.metadataOverrides };
        if (metadata.encodingWarnings || result.metadataOverrides.encodingWarnings) {
            decodedMetadata.encodingWarnings = [...new Set([...(metadata.encodingWarnings ?? []), ...(result.metadataOverrides.encodingWarnings ?? [])])];
        }
        if (decodedMetadata.photometric === 'YBR_FULL') {
            // The verified JPEG2000 MCT0 profile preserves Y/Cb/Cr components.
            // Convert with the same owned full-range equations as native/RLE.
            native = convertYbr(native, { ...decodedMetadata, encodedPhotometric: 'YBR_FULL' });
            decodedMetadata = { ...decodedMetadata, photometric: 'RGB', planarConfiguration: 0 };
        }
    } else if (metadata.encodedPhotometric?.startsWith('YBR')) {
        native = convertYbr(native, metadata);
        decodedMetadata = { ...metadata, planarConfiguration: 0 };
    }
    const frame = decodeNative(native, decodedMetadata);
    if (decodedMetadata.encodingWarnings) frame.encodingWarnings = [...new Set(decodedMetadata.encodingWarnings)];
    if (decodedMetadata.bitsStored !== metadata.bitsStored || decodedMetadata.highBit !== metadata.highBit) {
        frame.bitsStored = decodedMetadata.bitsStored; frame.highBit = decodedMetadata.highBit;
    }
    return frame;
}
