import { createCompressedDicom, createEncapsulatedDicom } from './compressed-fixtures.js';

const LONG_VR = new Set(['OB', 'OW', 'OD', 'OF', 'OL', 'OV', 'SQ', 'UC', 'UR', 'UN', 'UT']);
function concat(parts) {
    const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0; for (const part of parts) { output.set(part, offset); offset += part.length; } return output;
}

/** A valid comment segment changes codestream parity without changing pixels. */
export function oddJpegFrame(frame) {
    if (frame[0] !== 255 || frame[1] !== 216 || frame.at(-2) !== 255 || frame.at(-1) !== 217) throw new Error('Use a generated JPEG codestream.');
    return frame.length % 2 ? frame.slice() : concat([frame.subarray(0, 2), Uint8Array.of(255, 254, 0, 3, 42), frame.subarray(2)]);
}

/** Change only final NULL alignment bytes in generated explicit-LE fixtures. */
export function withJpegAlignmentByte(bytes, padding = 17) {
    if (!Number.isInteger(padding) || padding < 0 || padding > 255) throw new Error('Use one alignment byte.');
    const result = bytes.slice(), view = new DataView(result.buffer, result.byteOffset, result.byteLength);
    let offset = 132;
    while (offset + 12 <= result.length) {
        const group = view.getUint16(offset, true), element = view.getUint16(offset + 2, true);
        if (group === 0x7fe0 && element === 0x0010) break;
        const header = LONG_VR.has(String.fromCharCode(result[offset + 4], result[offset + 5])) ? 12 : 8;
        const length = header === 12 ? view.getUint32(offset + 8, true) : view.getUint16(offset + 6, true);
        if (length === 0xffffffff) throw new Error('Use generated defined-length metadata.');
        offset += header + length;
    }
    if (offset + 12 > result.length || view.getUint32(offset + 8, true) !== 0xffffffff) throw new Error('Generated encapsulated Pixel Data is missing.');
    offset += 12;
    const paddingOffsets = [];
    // The first Item is the Basic Offset Table, rather than a frame fragment.
    offset += 8 + view.getUint32(offset + 4, true);
    while (offset + 8 <= result.length) {
        const tag = view.getUint16(offset + 2, true), length = view.getUint32(offset + 4, true);
        if (tag === 0xe0dd) break;
        if (view.getUint16(offset, true) !== 0xfffe || tag !== 0xe000 || length % 2 || offset + 8 + length > result.length) throw new Error('Invalid generated fragment.');
        const end = offset + 8 + length;
        if (length >= 4 && result[end - 3] === 255 && result[end - 2] === 217 && result[end - 1] === 0) {
            result[end - 1] = padding; paddingOffsets.push(end - 1);
        }
        offset = end;
    }
    if (!paddingOffsets.length) throw new Error('Generated odd JPEG frames need final alignment bytes.');
    return { bytes: result, paddingOffsets };
}

/** Independent generated rasters, valid odd JPEG frames and one unusual pad. */
export async function createJpegAlignmentFixture(options = {}, padding = 17) {
    const generated = await createCompressedDicom({ codec: 'jpeg-lossless', ...options });
    const frames = generated.frames.map(oddJpegFrame), samples = generated.metadata.samplesPerPixel;
    const canonicalBytes = createEncapsulatedDicom(frames, { ...options, ...generated.metadata,
        modality: options.modality ?? 'OT', sopClass: options.sopClass ?? '1.2.840.10008.5.1.4.1.1.7',
        extraAttributes: { '00280002': ['US', samples], '00280006': samples === 3 ? ['US', generated.metadata.planarConfiguration] : null,
            '00281054': null, '00281050': null, '00281051': null, ...options.extraAttributes } });
    return { ...generated, frames, canonicalBytes, ...withJpegAlignmentByte(canonicalBytes, padding) };
}
