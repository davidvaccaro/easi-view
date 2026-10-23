import { MAX_DERIVED_BYTES, MAX_DERIVED_FRAMES, attribute, text, numbers, scalar, integer, uid, one, sequence, code,
    geometry, reference, resolveReference, assertGrid, validateStructure, rejectTags, checkSignal, fail } from './common.js';

export const SEGMENTATION_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.66.4';
const NATIVE = new Set(['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']);
let nextId = 1;

function segment(set) {
    const number = integer(scalar(set, '00620004'), 1, 65535), label = text(set, '00620005'), algorithmType = text(set, '00620008');
    if (!['MANUAL', 'AUTOMATIC', 'SEMIAUTOMATIC'].includes(algorithmType)) fail('segment algorithm type is unsupported');
    const algorithmName = text(set, '00620009', { required: algorithmType !== 'MANUAL' });
    const recommendedCielab = numbers(set, '0062000D', { required: false, maximum: 3 });
    if (recommendedCielab.length && (recommendedCielab.length !== 3 || recommendedCielab.some(value => !Number.isInteger(value) || value < 0 || value > 65535))) fail('segment display CIELab is invalid');
    return { number, label, algorithmType, ...(algorithmName ? { algorithmName } : {}), category: code(one(set, '00620003')),
        type: code(one(set, '0062000F')), ...(recommendedCielab.length ? { recommendedCielab } : {}) };
}

/** Native binary/fractional SEG with one exact source-frame grid per SEG frame. */
export async function importSeg(instance, { resolveSource, signal, maxBytes = MAX_DERIVED_BYTES, consumePixelData = false } = {}) {
    checkSignal(signal); integer(maxBytes, 1, MAX_DERIVED_BYTES);
    if (typeof consumePixelData !== 'boolean') fail('consumePixelData must be explicit boolean');
    const set = instance?.dataSet; validateStructure(set);
    if (text(set, '00080016') !== SEGMENTATION_SOP_CLASS) fail('Segmentation Storage SOP Class required');
    rejectTags(set, ['7FE00008', '7FE00009', '00287FE0', '00409096', '20500010']);
    const sopUid = uid(text(set, '00080018')), frameOfReferenceUid = uid(text(set, '00200052'));
    const rows = integer(scalar(set, '00280010'), 1, 8192), columns = integer(scalar(set, '00280011'), 1, 8192),
        count = integer(scalar(set, '00280008'), 1, MAX_DERIVED_FRAMES), pixels = rows * columns;
    if (pixels > 16 * 1024 * 1024 || pixels * count > maxBytes) fail('expanded SEG masks exceed their byte budget');
    const segmentationType = text(set, '00620001'), binary = segmentationType === 'BINARY';
    if (!binary && segmentationType !== 'FRACTIONAL') fail('only BINARY or FRACTIONAL SEG is supported');
    const bits = binary ? 1 : 8;
    if (scalar(set, '00280002') !== 1 || text(set, '00280004') !== 'MONOCHROME2' || scalar(set, '00280103') !== 0 ||
        scalar(set, '00280100') !== bits || scalar(set, '00280101') !== bits || scalar(set, '00280102') !== bits - 1) fail('SEG stored-pixel profile is inconsistent');
    const fractionalType = binary ? null : text(set, '00620010'), maximumFractionalValue = binary ? 1 : integer(scalar(set, '0062000E'), 1, 255);
    if (!binary && !['PROBABILITY', 'OCCUPANCY'].includes(fractionalType)) fail('fractional SEG semantics are unsupported');
    const segments = sequence(set, '00620002', { maximum: 256 }).map(segment), segmentMap = new Map(segments.map(value => [value.number, value]));
    if (segmentMap.size !== segments.length) fail('segment numbers must be unique');
    const pixel = attribute(set, '7FE00010'), syntax = pixel?.transferSyntax?.ID ?? instance.metaSet?.transferSyntax?.ID;
    if (!pixel || !NATIVE.has(syntax) || pixel.items?.length || !['OB', 'OW'].includes(pixel.vr?.ID ?? pixel.tag?.VR?.ID)) fail('native materialized SEG Pixel Data required');
    const data = pixel.access(); if (!(data instanceof Uint8Array)) fail('materialized SEG Pixel Data required');
    const used = Math.ceil(pixels * count * bits / 8), length = used + used % 2;
    if (data.length !== length) fail('SEG Pixel Data has truncated or excess end padding');
    const bigEndianWords = syntax === '1.2.840.10008.1.2.2' && (pixel.vr?.ID ?? pixel.tag?.VR?.ID) === 'OW';
    const byteAt = index => data[bigEndianWords ? index ^ 1 : index];
    const shared = one(set, '52009229', { required: false }) ?? null, frames = sequence(set, '52009230');
    if (frames.length !== count) fail('per-frame group count differs from Number of Frames');
    const overlays = [], bindings = new Set();
    for (let frameIndex = 0; frameIndex < count; frameIndex++) {
        checkSignal(signal);
        const group = frames[frameIndex], ownSegment = one(group, '0062000A', { required: false }), sharedSegment = one(shared, '0062000A', { required: false });
        if (ownSegment && sharedSegment) fail('segment identification occurs both shared and per-frame');
        const segmentNumber = integer(scalar(ownSegment ?? sharedSegment, '0062000B'), 1, 65535);
        if (!segmentMap.has(segmentNumber)) fail('frame references an undefined segment');
        const derivation = one(group, '00089124'), source = one(derivation, '00082112');
        if (text(source, '0028135A') !== 'YES') fail('exact-grid SEG requires Spatial Locations Preserved YES');
        const ref = reference(source), resolved = await resolveReference(ref, resolveSource, signal);
        const grid = { rows, columns, frameOfReferenceUid, ...geometry(group, shared) }; assertGrid(grid, resolved.frame);
        const key = `${segmentNumber}/${ref.sopUid}/${ref.frameNumber}`;
        if (bindings.has(key)) fail('duplicate segment/source-frame binding'); bindings.add(key);
        const values = new Uint8Array(pixels);
        for (let start = 0; start < pixels; start += 65536) {
            checkSignal(signal);
            for (let offset = start; offset < Math.min(pixels, start + 65536); offset++) {
                const index = frameIndex * pixels + offset;
                const value = binary ? byteAt(Math.floor(index / 8)) >>> (index % 8) & 1 : byteAt(index);
                if (value > maximumFractionalValue) fail('fractional pixel exceeds Maximum Fractional Value'); values[offset] = value;
            }
            if (start + 65536 < pixels) await new Promise(resolve => setTimeout(resolve, 0));
        }
        overlays.push({ id: globalThis.crypto?.randomUUID?.() ?? `seg-${nextId++}`, image: resolved.image, kind: binary ? 'binary' : 'fractional', values,
            maximum: maximumFractionalValue, fractionalType, segment: segmentMap.get(segmentNumber), geometry: grid, source: 'seg', opacity: 0.5, color: [0, 200, 160] });
    }
    checkSignal(signal);
    if (consumePixelData) pixel.clear();
    return { profile: 'native-exact-grid-seg-v1', sopUid, segmentationType, fractionalType, maximumFractionalValue, frameOfReferenceUid,
        segments, overlays, bytes: pixels * count, ignoredEndPaddingBits: length * 8 - pixels * count * bits };
}
