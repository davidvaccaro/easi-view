import { SC_WORD_SOP_CLASS, resolveScWordSpatialFrames } from './sc-word-spatial.js';
import EASI, { Tag } from '@xinonix/easi-js';
import { workflowFromMetadata, workflowTechnicalMetadata } from '../catalog/workflow.js';
import { makeDemoFiles } from './synthetic.js';
import { defaultWindow, nativeFrameByteLength } from './native.js';
import { FrameCache } from '../runtime/frame-cache.js';
import { NativeDecoder, abortError, checkAbort } from '../runtime/native-decoder.js';
import { CLASSIC_XA_SOP_CLASS, CLASSIC_RF_SOP_CLASS, validateClassicXrayProfile } from './xa-profile.js';
import { beginMeasure } from '../runtime/performance.js';
import { COMPRESSED_SYNTAXES, encodedFrame } from './compressed.js';
import { indexEncapsulatedFrames, pixelEncodingError } from './encapsulated.js';
import { ENHANCED_SOP_CLASSES, resolveEnhancedFrames, partitionEnhancedFrames } from './enhanced.js';
import { normalizePresentation } from './presentation.js';
import { resolveFrameTiming } from './frame-timing.js';
import { CLASSIC_PET_SOP_CLASS, classicPetUnit, resolveClassicDimensions, classicNavigationKey } from './classic-dimensions.js';
import { createAttributeSnapshot, getAttributeVR, MAX_ATTRIBUTE_BYTES, MAX_SESSION_ATTRIBUTE_BYTES } from './attributes.js';
import { normalizeCircularShutter } from './display-shutter.js';
import { PHILIPS_PRIVATE_CT_SYNTAX, resolvePhilipsPrivateProfile, decodePhilipsRle1 } from './philips-private.js';

export { makeDemoFiles } from './synthetic.js';
export const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_FRAME_PIXELS = 16 * 1024 * 1024;
const NATIVE_SYNTAXES = new Set(['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']);
const CLASSIC_US_CLASSES = new Set(['1.2.840.10008.5.1.4.1.1.3.1', '1.2.840.10008.5.1.4.1.1.6', '1.2.840.10008.5.1.4.1.1.6.1']);
const SC_TRUE_COLOR_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.7.4';
const SC_TRUE_COLOR_RGB_SYNTAXES = new Set([...NATIVE_SYNTAXES, '1.2.840.10008.1.2.5',
    '1.2.840.10008.1.2.4.57', '1.2.840.10008.1.2.4.70', '1.2.840.10008.1.2.4.80']);
const INVALID_US_TIMING_WARNING = 'Ignored invalid declared cine timing. Recorded playback and acquisition timing are unavailable; use manual frame navigation or a manually chosen FPS.';
const IMAGE_CLASSES = new Set([
    '1.2.840.10008.5.1.4.1.1.1', '1.2.840.10008.5.1.4.1.1.1.1', '1.2.840.10008.5.1.4.1.1.1.1.1',
    '1.2.840.10008.5.1.4.1.1.2', '1.2.840.10008.5.1.4.1.1.4', '1.2.840.10008.5.1.4.1.1.6', '1.2.840.10008.5.1.4.1.1.6.1',
    '1.2.840.10008.5.1.4.1.1.3.1', '1.2.840.10008.5.1.4.1.1.7',
    '1.2.840.10008.5.1.4.1.1.7.2', '1.2.840.10008.5.1.4.1.1.7.3', SC_TRUE_COLOR_SOP_CLASS,
    CLASSIC_XA_SOP_CLASS, CLASSIC_RF_SOP_CLASS, CLASSIC_PET_SOP_CLASS
]);

function value(set, id, fallback = null) {
    return set?.value(Tag.find(id), fallback) ?? fallback;
}

// TM values materialize as Date objects in EASI; workflow evidence validates
// their original bounded text rather than inventing a date or time zone.
function workflowTime(set, id) {
    const data = set?.find(Tag.find(id))?.data;
    if (data instanceof Uint8Array) return data.byteLength <= 32 ? new TextDecoder().decode(data).replace(/\0+$/gu, '').trim() : '';
    const raw = value(set, id, '');
    return typeof raw === 'string' ? raw : Array.isArray(raw) && raw.length === 1 && typeof raw[0] === 'string' ? raw[0] : '';
}

function numbers(raw) {
    // EASI's DICOM JSON adapter preserves Value arrays rather than DS/IS byte strings.
    if (Array.isArray(raw)) raw = raw.map(component => component == null ? '' : String(component)).join('\\');
    if (raw == null || (typeof raw === 'string' && raw.trim() === '')) return [];
    if (typeof raw === 'number' && Number.isFinite(raw)) return [raw];
    if (typeof raw !== 'string') throw new Error('The DICOM numeric metadata has an unsupported encoding.');
    const components = raw.split('\\').map(component => component.trim());
    // Empty components and JavaScript-only forms (such as hexadecimal) are not DICOM numbers.
    if (components.some(component => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(component))) {
        throw new Error('The DICOM numeric metadata contains invalid values.');
    }
    const result = components.map(Number);
    if (!result.every(Number.isFinite)) throw new Error('The DICOM numeric metadata contains invalid values.');
    return result;
}

function number(set, id, fallback) {
    return numbers(value(set, id))[0] ?? fallback;
}

function vector(set, id, count, warnings, validate = () => true, expected = 'finite numeric values') {
    const raw = value(set, id);
    // An empty optional vector carries no geometry, including a list of only blank components.
    if (raw == null || (typeof raw === 'string' && raw.split('\\').every(component => component.trim() === '')) ||
        (Array.isArray(raw) && raw.every(component => component == null || String(component).trim() === ''))) return null;
    try {
        const result = numbers(raw);
        if (result.length === count && validate(result)) return result;
    } catch { /* Unusable optional geometry does not prevent a native 2D preview. */ }
    const tag = Tag.find(id);
    warnings.push(`Ignored ${tag.Name} ${tag.Tag}: expected ${count} ${expected}.`);
    return null;
}

function has(set, id) { return set?.has(Tag.find(id)) === true; }

function integer(set, id, fallback, min, max) {
    const result = number(set, id, fallback);
    if (!Number.isInteger(result) || result < min || result > max) throw new Error('Invalid native image dimensions or pixel metadata.');
    return result;
}

/** Normalize a completed EASI instance without producing display-ready RGBA pixels. */
export function normalizeInstance(instance, { metadataOnly = false, maxPixelBytes = MAX_SOURCE_BYTES } = {}) {
    if (!Number.isSafeInteger(maxPixelBytes) || maxPixelBytes < 0 || maxPixelBytes > MAX_SOURCE_BYTES) throw new Error('Use a bounded retained pixel byte limit.');
    const set = instance.dataSet;
    if (!set) throw new Error('The source does not contain a DICOM image dataset.');
    // EASI's dataset target attaches its resolved transfer syntax to attributes.
    const pixelAttribute = set.find(Tag.find('7FE00010'));
    const syntax = String(value(instance.metaSet, '00020010', pixelAttribute?.transferSyntax?.ID ?? ''));
    const compressed = COMPRESSED_SYNTAXES.has(syntax);
    const privateSyntax = syntax === PHILIPS_PRIVATE_CT_SYNTAX;
    if (!metadataOnly && !NATIVE_SYNTAXES.has(syntax) && !compressed && !privateSyntax) {
        throw pixelEncodingError('This DICOM transfer syntax does not have a verified pixel decoder.');
    }
    const sopClass = String(value(set, '00080016', ''));
    const privateProfile = privateSyntax ? resolvePhilipsPrivateProfile(set, { transferSyntax: syntax, sopClass, metadataOnly }) : null;
    const enhanced = ENHANCED_SOP_CLASSES.has(sopClass);
    const scSpatial = sopClass === SC_WORD_SOP_CLASS && (has(set, '52009229') || has(set, '52009230'));
    if (!IMAGE_CLASSES.has(sopClass) && !enhanced) throw new Error('This DICOM object type is outside the 2D image profile supported by this alpha.');
    const classicXa = sopClass === CLASSIC_XA_SOP_CLASS;
    const classicRf = sopClass === CLASSIC_RF_SOP_CLASS;
    const classicXray = classicXa || classicRf;
    if (classicRf && String(value(set, '00080060', '')) !== 'RF') throw new Error('Classic RF requires modality RF.');
    const classicPet = sopClass === CLASSIC_PET_SOP_CLASS;
    if (!enhanced && !scSpatial && (has(set, '52009229') || has(set, '52009230'))) {
        throw new Error('Enhanced shared/per-frame functional groups need a dedicated geometry implementation and are not supported by this alpha.');
    }
    if (enhanced && (has(set, '00283000') || has(set, '00283010'))) throw new Error('Enhanced CT/MR LUT presentation must be supplied in the applicable functional groups.');
    const rows = integer(set, '00280010', 0, 1, 8192);
    const columns = integer(set, '00280011', 0, 1, 8192);
    if (rows * columns > MAX_FRAME_PIXELS) throw new Error('The frame exceeds the 16-megapixel alpha limit.');
    const samplesPerPixel = integer(set, '00280002', 0, 1, 4);
    const encodedPhotometric = String(value(set, '00280004', ''));
    const ybr = ['YBR_FULL', 'YBR_FULL_422', 'YBR_RCT', 'YBR_ICT'].includes(encodedPhotometric);
    if (['YBR_RCT', 'YBR_ICT'].includes(encodedPhotometric) && !metadataOnly && !['1.2.840.10008.1.2.4.90', '1.2.840.10008.1.2.4.91'].includes(syntax)) {
        throw new Error('YBR_RCT/ICT require the corresponding verified JPEG2000 profile.');
    }
    const photometric = ybr ? 'RGB' : encodedPhotometric;
    const rgb = photometric === 'RGB';
    const palette = photometric === 'PALETTE COLOR';
    if ((rgb && samplesPerPixel !== 3) || (!rgb && (samplesPerPixel !== 1 || !['MONOCHROME1', 'MONOCHROME2', 'PALETTE COLOR'].includes(photometric)))) {
        throw new Error('This alpha requires a supported scalar/palette image with one sample per pixel or RGB with three samples per pixel.');
    }
    if (palette && compressed && syntax !== '1.2.840.10008.1.2.5' && !metadataOnly) throw pixelEncodingError('Compressed palette indices require native retrieval or the verified RLE profile.');
    const planarConfiguration = rgb ? integer(set, '00280006', -1, 0, 1) : null;
    if (ybr && encodedPhotometric === 'YBR_FULL_422' && !compressed && !metadataOnly && (columns % 2 || planarConfiguration !== 0)) {
        throw new Error('Native YBR_FULL_422 requires even columns and interleaved components.');
    }
    if (syntax === '1.2.840.10008.1.2.5' && encodedPhotometric === 'YBR_FULL_422') throw new Error('RLE YBR_FULL_422 is not a supported color profile.');
    const bitsAllocated = integer(set, '00280100', 0, 8, 16);
    const bitsStored = integer(set, '00280101', 0, 1, bitsAllocated);
    const highBit = integer(set, '00280102', -1, bitsStored - 1, bitsAllocated - 1);
    if (![8, 16].includes(bitsAllocated)) throw new Error('This alpha supports 8-bit and 16-bit native pixels.');
    const signed = integer(set, '00280103', -1, 0, 1) === 1;
    if (compressed && (highBit !== bitsStored - 1 || (syntax === '1.2.840.10008.1.2.4.50' && (bitsAllocated !== 8 || bitsStored !== 8 || signed)))) {
        throw new Error('The compressed pixel bit layout does not match its supported codec profile.');
    }
    if (syntax === '1.2.840.10008.1.2.4.51' && (samplesPerPixel !== 1 || signed ||
        !['MONOCHROME1', 'MONOCHROME2'].includes(encodedPhotometric) || ![8, 12].includes(bitsStored) ||
        bitsStored === 12 && bitsAllocated !== 16)) {
        throw new Error('JPEG Extended requires the verified unsigned 8-bit or 12-bit monochrome pixel profile.');
    }
    if (rgb && (bitsAllocated !== 8 || bitsStored !== 8 || highBit !== 7 || signed)) {
        throw new Error('This alpha supports native RGB only with unsigned 8-bit channels, Bits Stored 8 and High Bit 7.');
    }
    // PS3.3 A.8.5.4: qualify the interleaved RGB lossless profile separately
    // from true-color SC color transforms and video transfer syntaxes.
    if (sopClass === SC_TRUE_COLOR_SOP_CLASS && (encodedPhotometric !== 'RGB' || samplesPerPixel !== 3 ||
        planarConfiguration !== 0 || bitsAllocated !== 8 || bitsStored !== 8 || highBit !== 7 || signed ||
        !metadataOnly && !SC_TRUE_COLOR_RGB_SYNTAXES.has(syntax))) {
        throw new Error('Multi-frame True Color Secondary Capture requires the verified interleaved unsigned 8-bit RGB native, RLE, JPEG Lossless or lossless JPEG-LS profile.');
    }
    const frameCount = integer(set, '00280008', 1, 1, 4096);
    const slope = enhanced ? 1 : number(set, '00281053', 1);
    const intercept = enhanced ? 0 : number(set, '00281052', 0);
    if (!Number.isFinite(slope) || slope === 0 || !Number.isFinite(intercept)) throw new Error('Invalid pixel rescale transform.');
    let petUnit = null;
    if (classicPet) {
        for (const id of ['00280010', '00280011', '00280002', '00280100', '00280101', '00280102', '00280103']) {
            const attr = set.find(Tag.find(id));
            if (getAttributeVR(attr) !== 'US' || (attr.transferSyntax?.ID !== '0' ? attr.access().byteLength !== 2 :
                Array.isArray(attr.value) && attr.value.length !== 1)) throw new Error('Classic PET requires scalar US image pixel metadata.');
        }
        if (samplesPerPixel !== 1 || encodedPhotometric !== 'MONOCHROME2' || bitsAllocated !== 16 || bitsStored !== 16 || highBit !== 15 ||
            frameCount !== 1 || numbers(value(set, '00280008')).length > 1 || String(value(set, '00080060', '')) !== 'PT') {
            throw new Error('Classic PET requires single-frame MONOCHROME2 16-bit stored samples and modality PT.');
        }
        if (getAttributeVR(set.find(Tag.find('00281053'))) !== 'DS' || getAttributeVR(set.find(Tag.find('00281052'))) !== 'DS' ||
            numbers(value(set, '00281053')).length !== 1 || numbers(value(set, '00281052')).length !== 1 || slope <= 0 || intercept !== 0 || has(set, '00283000')) {
            throw new Error('Classic PET requires one positive Rescale Slope, a zero Rescale Intercept, and no Modality LUT.');
        }
        petUnit = classicPetUnit(set);
    }
    if ((rgb || palette) && (slope !== 1 || intercept !== 0 || has(set, '00280120') || has(set, '00280121'))) {
        throw new Error('RGB/palette color does not support scalar rescale or pixel padding transforms.');
    }
    if ((rgb || palette) && ['00282000', '00282002'].some(id => {
        const profile = value(set, id);
        return ArrayBuffer.isView(profile) ? profile.byteLength > 0 : profile != null && String(profile).trim() !== '';
    })) {
        throw new Error('RGB ICC profiles and declared color spaces require a color-management implementation and are not supported by this alpha.');
    }
    const presentationSet = enhanced ? { find: tag => ['20500020', '20500010', '00409096'].includes(tag.ID) ? set.find(tag) : undefined } : set;
    const presentation = normalizePresentation(presentationSet, { signed, littleEndian: syntax !== '1.2.840.10008.1.2.2',
        photometric, slope, intercept, bitsStored, metadataOnly });
    const geometryWarnings = [];
    const pixelSpacing = enhanced ? null : vector(set, '00280030', 2, geometryWarnings,
        values => values.every(v => v > 0), 'positive finite values');
    const pixelAspectRatio = vector(set, '00280034', 2, geometryWarnings,
        values => values.every(v => Number.isSafeInteger(v) && v > 0), 'positive integer values');
    const orientation = enhanced ? null : vector(set, '00200037', 6, geometryWarnings, values => {
        const a = values.slice(0, 3);
        const b = values.slice(3);
        return Math.abs(Math.hypot(...a) - 1) <= 0.001 && Math.abs(Math.hypot(...b) - 1) <= 0.001 &&
            Math.abs(a.reduce((sum, v, i) => sum + v * b[i], 0)) <= 0.001;
    }, 'finite values forming orthonormal direction cosines');
    const position = enhanced ? null : vector(set, '00200032', 3, geometryWarnings);
    const littleEndian = syntax !== '1.2.840.10008.1.2.2';
    const paddingAttribute = set.find(Tag.find('00280120'));
    if (!paddingAttribute && has(set, '00280121')) throw new Error('Pixel Padding Range Limit requires a Pixel Padding Value.');
    let padding = null;
    if (paddingAttribute && !metadataOnly) {
        const readPadding = attr => {
            const bytes = attr.access();
            if (bytes.byteLength !== 2) throw new Error('Invalid pixel padding metadata.');
            const view = new DataView(bytes.buffer, bytes.byteOffset, 2);
            return signed ? view.getInt16(0, littleEndian) : view.getUint16(0, littleEndian);
        };
        const paddingValue = readPadding(paddingAttribute);
        padding = { value: paddingValue, limit: has(set, '00280121') ? readPadding(set.find(Tag.find('00280121'))) : paddingValue };
    }
    const displayShutter = classicXray ? normalizeCircularShutter(set, { rows, columns, photometric, pixelSpacing, pixelAspectRatio }) : null;
    let frameTime = null;
    const timingWarnings = [];
    let timing;
    try {
        timing = classicXray ? validateClassicXrayProfile(set, { sopClass, samplesPerPixel, photometric, bitsAllocated, bitsStored, highBit, signed,
            slope, intercept, frameCount, littleEndian, displayShutter }) : resolveFrameTiming(set, frameCount, { littleEndian });
    } catch (error) {
        if (!CLASSIC_US_CLASSES.has(sopClass)) throw error;
        // Invalid declared US timing cannot define acquisition time or recorded
        // playback. Keep valid pixels navigable without repairing the source clock.
        timingWarnings.push(INVALID_US_TIMING_WARNING);
        timing = { mode: 'none', frameTime: null,
            frames: Array.from({ length: frameCount }, (_, frameIndex) => ({
                frameIndex, timingMode: 'none', acquisitionOffsetMs: null, nextIntervalMs: null
            })) };
    }
    if (!enhanced) frameTime = timing.frameTime;
    const pixels = set.find(Tag.find('7FE00010'));
    const privatePayload = privateProfile ? set.find(Tag.find(privateProfile.payloadTag)) : null;
    if (!metadataOnly && !privateProfile && (!pixels || (!compressed && pixels.valueLength === 0xFFFFFFFF) || (compressed && pixels.valueLength !== 0xFFFFFFFF) || !pixels.isComplete)) throw new Error('Pixel Data encoding does not match its transfer syntax, or is missing or incomplete.');
    const nativeBytes = nativeFrameByteLength({ rows, columns, bitsAllocated, samplesPerPixel, photometric }) * frameCount;
    const expectedBytes = !compressed && encodedPhotometric === 'YBR_FULL_422' ? nativeBytes * 2 / 3 : nativeBytes;
    const encoded = metadataOnly ? null : privateProfile ? privatePayload.access() : pixels.access();
    if (!metadataOnly && !compressed && expectedBytes > maxPixelBytes) throw new Error('The retained pixel data exceeds the 256 MiB source limit. Load a smaller series.');
    if (!metadataOnly && !compressed && !privateProfile && (expectedBytes > MAX_SOURCE_BYTES || encoded.byteLength < expectedBytes || encoded.byteLength > expectedBytes + (expectedBytes % 2))) {
        throw new Error('The native Pixel Data length does not match its frame count and dimensions.');
    }
    const uid = String(value(set, '00080018', ''));
    const seriesUid = String(value(set, '0020000E', ''));
    const studyUid = String(value(set, '0020000D', ''));
    if (!uid || !seriesUid) throw new Error('The DICOM image is missing a SOP or Series Instance UID.');
    let frameOfReferenceUid = value(set, '00200052');
    if (Array.isArray(frameOfReferenceUid)) {
        if (frameOfReferenceUid.length > 1) throw new Error('Invalid Frame of Reference UID.');
        frameOfReferenceUid = frameOfReferenceUid[0] ?? null;
    }
    if (frameOfReferenceUid != null && typeof frameOfReferenceUid !== 'string') throw new Error('Invalid Frame of Reference UID.');
    frameOfReferenceUid = frameOfReferenceUid?.trim() || null;
    if (frameOfReferenceUid && (frameOfReferenceUid.length > 64 || !/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))+$/u.test(frameOfReferenceUid))) throw new Error('Invalid Frame of Reference UID.');
    const modality = String(value(set, '00080060', 'OT'));
    const rescaleType = String(value(set, '00281054', ''));
    const rawImageType = value(set, '00080008', '');
    const imageType = Array.isArray(rawImageType) ? rawImageType.map(String) : String(rawImageType).split('\\');
    const conventionalCt = modality === 'CT' && sopClass === '1.2.840.10008.5.1.4.1.1.2' &&
        imageType[0] === 'ORIGINAL' && imageType[2] === 'AXIAL' && !has(set, '00189361');
    const classicDimensions = enhanced ? null : resolveClassicDimensions(set, { modality, littleEndian, sopClass });
    if (classicDimensions?.invalid) geometryWarnings.push('Optional acquisition dimensions are invalid; spatial linking and reconstruction are unavailable.');
    const common = {
        sopUid: uid, seriesUid, studyUid, modality, frameOfReferenceUid, classicDimensions, syncDimensions: classicDimensions,
        workflow: workflowFromMetadata({ imageOrientation: orientation, imageType, modality, seriesDescription: String(value(set, '0008103E', '')),
            ...workflowTechnicalMetadata(id => set.find(Tag.find(id)), { littleEndian }), bodyPartExamined: String(value(set, '00180015', '')),
            contrastBolusAgent: String(value(set, '00180010', '')), contrastBolusRoute: String(value(set, '00181040', '')),
            contrastBolusStartTime: workflowTime(set, '00181042'), contrastBolusStopTime: workflowTime(set, '00181043') }),
        declaredSpacingBetweenSlices: classicDimensions?.declaredSpacingBetweenSlices ?? null,
        rows, columns, bitsAllocated, bitsStored, highBit, signed, littleEndian, slope, intercept, samplesPerPixel, planarConfiguration,
        photometric, encodedPhotometric, transferSyntax: syntax, pixelSpacing, pixelAspectRatio, orientation, position, geometryWarnings, timingWarnings, padding, frameTime, displayShutter,
        ...presentation,
        unit: petUnit ?? (enhanced || rgb || palette ? '' : presentation.unit === 'US' ? '' : presentation.unit || (!rescaleType && conventionalCt ? 'HU' : ''))
    };
    if (privateProfile) common.pixelDecodingProfile = privateProfile.pixelDecodingProfile;
    const enhancedFrames = enhanced ? resolveEnhancedFrames(instance, common, { presentationNormalizer: normalizePresentation, metadataOnly })
        : scSpatial ? resolveScWordSpatialFrames(instance, common, { frameCount, frameTiming: timing.frames }) : null;
    if (enhanced && (rgb || palette)) throw new Error('Enhanced CT/MR currently requires a verified monochrome pixel profile.');
    let encapsulated = null;
    if (!metadataOnly && compressed) {
        const attributeBytes = id => set.find(Tag.find(id))?.access();
        encapsulated = indexEncapsulatedFrames(pixels, { frameCount, syntax,
            extendedOffsets: attributeBytes('7FE00001'), extendedLengths: attributeBytes('7FE00002'), maxBytes: MAX_SOURCE_BYTES });
        if (encapsulated.encodingWarnings.length) common.encodingWarnings = [...new Set([...(common.encodingWarnings ?? []), ...encapsulated.encodingWarnings])];
    }
    let bytes = metadataOnly ? null : privateProfile ? decodePhilipsRle1(encoded, privateProfile, { maxBytes: expectedBytes })
        : encapsulated ? encapsulated.bytes : encoded.slice(0, expectedBytes);
    if (privateProfile && !metadataOnly && bytes.byteLength !== expectedBytes) throw new Error('Invalid Philips PMSCT_RLE1 data: canonical native length differs from the image dimensions.');
    if (!metadataOnly && bytes.byteLength > maxPixelBytes) {
        encapsulated?.dispose();
        throw new Error('The retained pixel data exceeds the 256 MiB source limit. Load a smaller series.');
    }
    if (!metadataOnly && !compressed && bitsAllocated === 8 && !littleEndian && (pixels.vr?.ID ?? pixels.tag.VR.ID) === 'OW') {
        // OW words obey syntax byte order, including pairs spanning odd-sized frames.
        // Unswap before trimming final padding and slicing individual frames.
        for (let index = 0; index < expectedBytes; index++) bytes[index] = encoded[index ^ 1];
    }
    // The emitted instance has been consumed; release EASI's growable pixel backing store.
    if (!metadataOnly) (privatePayload ?? pixels).clear();
    return {
        uid, seriesUid, studyUid, sopClass, modality, description: String(value(set, '0008103E', `${modality} series`)),
        instanceNumber: number(set, '00200013', 0), frameCount, bytes, encapsulated, common, enhancedFrames, frameTiming: timing.frames
    };
}

export function geometryKey(metadata) {
    return [metadata.rows, metadata.columns, metadata.photometric === 'RGB' ? 'rgb' : metadata.photometric === 'PALETTE COLOR' ? 'palette' : 'scalar', metadata.pixelSpacing?.join(',') ?? '',
        metadata.pixelAspectRatio ? metadata.pixelAspectRatio[0] / metadata.pixelAspectRatio[1] : '',
        metadata.orientation?.map(v => v.toFixed(4)).join(',') ?? '', metadata.position ? 'positioned' : 'unpositioned', metadata.frameOfReferenceUid ?? ''].join('|');
}

/** Resolve navigable groups while keeping each descriptor's encoded frame index. */
export function recordFrameGroups(record) {
    if (!record.enhancedFrames) return [{ key: `${geometryKey(record.common)}|classic:${classicNavigationKey(record.common.classicDimensions, record.uid)}`, common: record.common,
        frames: Array.from({ length: record.frameCount }, (_, frameIndex) => ({ frameIndex, overrides: record.frameTiming?.[frameIndex] ?? {}, dimensions: null })) }];
    if (record.enhancedFrames.every(frame => frame.dimensions.semanticScope === 'encoded-2d-projection')) {
        // Rotating sampled projections are one encoded sequence, rather than
        // parallel-plane stacks. Keep the source's frame numbering and clock.
        return [{ key: `encoded-2d-projection:${record.uid}`, common: { ...record.common, ...record.enhancedFrames[0].overrides },
            frames: [...record.enhancedFrames] }];
    }
    const result = [];
    for (const partition of partitionEnhancedFrames(record.enhancedFrames)) {
        const groups = new Map();
        for (const frame of partition.frames) {
            const metadata = { ...record.common, ...frame.overrides };
            const scoped = frame.dimensions.indices.length ? '' : frame.dimensions.concatenationUid ?? record.uid;
            const key = `${geometryKey(metadata)}|enhanced:${partition.key}|scope:${scoped}`;
            if (!groups.has(key)) groups.set(key, { key, common: metadata, frames: [] });
            groups.get(key).frames.push(frame);
        }
        result.push(...groups.values());
    }
    return result;
}

function projection(frame) {
    if (!frame.orientation || !frame.position) return null;
    const [a, b, c, d, e, f] = frame.orientation;
    const normal = [b * f - c * e, c * d - a * f, a * e - b * d];
    return normal.reduce((sum, value, i) => sum + value * frame.position[i], 0);
}

export function sortFrames(frames) {
    const geometric = frames.every(frame => frame.dimensions?.semanticScope !== 'encoded-2d-projection' && projection(frame) != null);
    frames.sort((a, b) => {
        if (geometric) {
            const difference = projection(a) - projection(b);
            if (Math.abs(difference) > 0.00001) return difference;
        }
        return a.instanceNumber - b.instanceNumber || a.frameIndex - b.frameIndex || a.id.localeCompare(b.id);
    });
    return frames;
}

export class Series {
    constructor(record, session, group = recordFrameGroups(record)[0]) {
        this.id = `${record.seriesUid}|${group.key}`;
        this.description = record.description;
        this.modality = record.modality;
        this.frames = [];
        this.disposed = false;
        this._abortController = new AbortController();
        this._session = session;
        this._records = new Map();
    }

    append(record, group = recordFrameGroups(record)[0]) {
        if (this._records.has(record.uid)) return;
        this._records.set(record.uid, record);
        this._session.retainRecord(record, this);
        for (const frame of group.frames) {
            this.frames.push({ ...record.common, ...frame.overrides, dimensions: frame.dimensions,
                id: `${this.id}/${record.uid}/${frame.frameIndex}`, instanceNumber: record.instanceNumber, frameIndex: frame.frameIndex, _record: record });
        }
        sortFrames(this.frames);
    }

    getAttributes(index) {
        if (this.disposed) throw new Error('This series has been disposed.');
        const descriptor = this.frames[index];
        if (!Number.isInteger(index) || !descriptor) throw new Error('Select an available frame.');
        return descriptor._record.attributes ?? null;
    }

    async getFrame(index, { signal, onMeasure = this._session.onMeasure } = {}) {
        checkAbort(signal);
        if (this.disposed) throw new Error('This series has been disposed.');
        const descriptor = this.frames[index];
        if (!descriptor) throw new Error('Select an available frame.');
        const measureSignal = typeof onMeasure === 'function'
            ? signal ? AbortSignal.any([signal, this._abortController.signal]) : this._abortController.signal : signal;
        const frameMeasurement = beginMeasure(onMeasure, 'frame', { signal: measureSignal });
        const cached = this._session.cache.get(descriptor.id);
        if (cached) {
            frameMeasurement('success', { ...this._session.measureDetails(), decodedBytes: cached.samples.byteLength,
                decodedCacheHit: true, encodedCacheHit: false });
            return cached;
        }
        const record = descriptor._record;
        const input = encodedFrame(record, descriptor.frameIndex);
        const frameBytes = input.byteLength;
        const { _record, ...metadata } = descriptor;
        const controller = new AbortController();
        const abort = () => controller.abort();
        const lifetime = this._abortController.signal;
        signal?.addEventListener('abort', abort, { once: true });
        lifetime.addEventListener('abort', abort, { once: true });
        let decoded;
        const decodeMeasurement = beginMeasure(onMeasure, 'decode', { signal: controller.signal });
        try {
            checkAbort(signal);
            checkAbort(lifetime);
            decoded = await this._session.decoder.decode(input, metadata, { signal: controller.signal });
            checkAbort(signal);
            if (this.disposed) throw abortError();
            decodeMeasurement('success', { ...this._session.measureDetails(), bytes: frameBytes, decodedBytes: decoded.samples.byteLength });
        } catch (error) {
            const status = error.name === 'AbortError' ? 'canceled' : 'error';
            decodeMeasurement(status);
            frameMeasurement(status);
            throw error;
        } finally {
            signal?.removeEventListener('abort', abort);
            lifetime.removeEventListener('abort', abort);
        }
        checkAbort(signal);
        if (this.disposed) throw abortError();
        const frame = { ...metadata, ...decoded, window: ['RGB', 'PALETTE COLOR'].includes(descriptor.photometric) ? null : descriptor.window ?? defaultWindow(decoded.range, descriptor.voiFunction) };
        this._session.cache.set(frame.id, frame);
        frameMeasurement('success', { ...this._session.measureDetails(), bytes: frameBytes, decodedBytes: frame.samples.byteLength,
            decodedCacheHit: false, encodedCacheHit: true });
        return frame;
    }

    get cacheBytes() { return this._session.cache.bytes; }
    get sourceBytes() {
        if (this.disposed) return 0;
        let bytes = 0;
        for (const record of this._records.values()) if (this._session.recordOwners.get(record)?.values().next().value === this) bytes += record.bytes.byteLength;
        return bytes;
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this._abortController.abort();
        for (const frame of this.frames) this._session.cache.delete(frame.id);
        for (const record of this._records.values()) this._session.releaseRecord(record, this);
        this._records.clear();
        this.frames = [];
        this._session.release(this);
    }
}

class SourceSession {
    constructor(options, source = 'files') {
        this.options = options;
        this.source = source;
        this.onMeasure = options.onMeasure;
        this.measure = typeof this.onMeasure === 'function' ? event => this.onMeasure?.({ ...event, source: this.source }) : undefined;
        this.cache = new FrameCache();
        this.decoder = new NativeDecoder();
        this.series = new Map();
        this.recordOwners = new Map();
        this.seen = new WeakSet();
        this.loaded = 0;
        this.total = null;
        this.instances = 0;
        this.attributeBytes = 0;
        this.pixelBytes = 0;
    }

    measureDetails() {
        return { source: this.source, encodedCacheBytes: [...this.recordOwners.keys()].reduce((sum, record) => sum + record.bytes.byteLength, 0),
            decodedCacheBytes: this.cache.bytes };
    }

    retainRecord(record, series) {
        if (!this.recordOwners.has(record)) { this.recordOwners.set(record, new Set()); this.attributeBytes += record.attributes?.bytes ?? 0; this.pixelBytes += record.bytes.byteLength; }
        this.recordOwners.get(record).add(series);
    }

    releaseRecord(record, series) {
        const owners = this.recordOwners.get(record);
        owners?.delete(series);
        if (owners?.size) return;
        this.recordOwners.delete(record);
        this.pixelBytes -= record.bytes.byteLength;
        this.attributeBytes -= record.attributes?.bytes ?? 0;
        record.attributes = null;
        record.bytes = new Uint8Array(0);
        record.encapsulated?.dispose();
        record.encapsulated = null;
    }

    report(phase, message) {
        this.options.onProgress?.({ phase, loaded: this.loaded, total: this.total, message,
            instances: this.instances, frames: [...this.series.values()].reduce((sum, series) => sum + series.frames.length, 0) });
    }

    async accept(result) {
        checkAbort(this.options.signal);
        for (const instance of Array.isArray(result) ? result : [result]) {
            if (!instance?.dataSet || this.seen.has(instance)) continue;
            this.seen.add(instance);
            await this.options.onInstance?.(instance);
            checkAbort(this.options.signal);
            const attributes = createAttributeSnapshot(instance, { maxBytes: Math.min(MAX_ATTRIBUTE_BYTES, MAX_SESSION_ATTRIBUTE_BYTES - this.attributeBytes) });
            const record = normalizeInstance(instance, { maxPixelBytes: MAX_SOURCE_BYTES - this.pixelBytes });
            record.attributes = attributes;
            for (const group of recordFrameGroups(record)) {
                const key = `${record.seriesUid}|${group.key}`;
                let series = this.series.get(key);
                if (!series) { series = new Series(record, this, group); this.series.set(key, series); }
                series.append(record, group);
            }
            this.instances++;
            this.report('parsing', `${this.instances} image instance${this.instances === 1 ? '' : 's'} parsed with EASI JS`);
            await this.options.onSeries?.([...this.series.values()]);
        }
    }

    release(series) {
        this.series.delete(series.id);
        if (this.series.size === 0) { this.cache.clear(); this.decoder.dispose(); this.onMeasure = null; }
    }

    dispose() {
        for (const series of [...this.series.values()]) series.dispose();
        this.cache.clear();
        this.decoder.dispose();
        this.options = {};
        this.onMeasure = null;
    }
}

/** Apply an aggregate byte limit and propagate abort to the underlying reader. */
function boundedStream(stream, session) {
    const reader = stream.getReader();
    const signal = session.options.signal;
    let closed = false;
    let released = false;
    let controller;
    const startedBytes = session.loaded;
    const measurement = beginMeasure(session.measure, 'stream', { signal });
    const release = () => {
        if (released) return;
        released = true;
        signal?.removeEventListener('abort', onAbort);
        try { reader.releaseLock(); } catch { /* A pending read completes after cancellation. */ }
    };
    const cancel = async reason => { try { await reader.cancel(reason); } finally { release(); } };
    const onAbort = () => {
        if (closed) return;
        closed = true;
        controller.error(abortError());
        void cancel(abortError()).catch(() => {});
    };
    return new ReadableStream({
        start(value) {
            controller = value;
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) onAbort();
        },
        async pull() {
            try {
                checkAbort(signal);
                const chunk = await reader.read();
                if (closed) return;
                if (chunk.done) {
                    closed = true; release(); controller.close();
                    measurement('success', { ...session.measureDetails(), bytes: session.loaded - startedBytes });
                    return;
                }
                session.loaded += chunk.value.byteLength;
                if (session.loaded > MAX_SOURCE_BYTES) throw new Error('The input exceeds the 256 MiB source limit. Load a smaller series.');
                session.report('reading', 'Streaming DICOM bytes into EASI JS');
                controller.enqueue(chunk.value);
            } catch (error) {
                measurement(error.name === 'AbortError' ? 'canceled' : 'error', { bytes: session.loaded - startedBytes });
                if (!closed) { closed = true; controller.error(error); }
                await cancel(error);
            }
        },
        async cancel(reason) { closed = true; measurement('canceled', { bytes: session.loaded - startedBytes }); await cancel(reason); }
    }, { highWaterMark: 0 });
}

function pipeline(sourceType) {
    let builder = EASI.pipelineBuilder();
    builder = sourceType === 'file' ? builder.fromFileStream() : builder.fromPartStream();
    return builder.ofDicomData({ includePart10Header: true }).withBulkDataPolicy({ mode: 'materialize', hardSafetyCap: MAX_SOURCE_BYTES + 1 }).toInstances().build();
}

function finalize(session) {
    if (!session.series.size) throw new Error('No supported DICOM image instances were found.');
    session.report('ready', 'Ready · selected frames decoded on demand');
    session.options = {};
    return [...session.series.values()];
}

export async function loadFiles(files, options = {}) {
    const inputs = Array.from(files ?? []);
    checkAbort(options.signal);
    if (!inputs.length) throw new Error('Choose one or more DICOM files.');
    if (inputs.some(file => typeof file?.stream !== 'function' || !Number.isSafeInteger(file.size))) throw new Error('Choose browser File or Blob inputs.');
    const session = new SourceSession(options);
    session.total = inputs.reduce((sum, file) => sum + file.size, 0);
    if (session.total > MAX_SOURCE_BYTES) { session.dispose(); throw new Error('The selected files exceed the 256 MiB source limit. Load a smaller series.'); }
    try {
        for (const file of inputs) {
            checkAbort(options.signal);
            const measurement = beginMeasure(session.measure, 'pipeline', { signal: options.signal });
            const startedBytes = session.loaded;
            const source = { size: file.size, type: 'application/dicom', stream: () => boundedStream(file.stream(), session) };
            try {
                await pipeline('file').process({ source, sourceOptions: { contentType: 'application/dicom', onEmit: result => session.accept(result) } });
                measurement('success', { ...session.measureDetails(), bytes: session.loaded - startedBytes });
            } catch (error) {
                measurement(error.name === 'AbortError' ? 'canceled' : 'error', { bytes: session.loaded - startedBytes });
                throw error;
            }
        }
        checkAbort(options.signal);
        return finalize(session);
    } catch (error) {
        session.dispose();
        throw error;
    }
}

export async function loadUrl(rawUrl, options = {}) {
    checkAbort(options.signal);
    let url;
    try { url = new URL(rawUrl); } catch { throw new Error('Enter an absolute HTTP or HTTPS DICOMweb retrieval URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP or HTTPS retrieval URL without embedded credentials.');
    options.onProgress?.({ phase: 'reading', loaded: 0, total: null, instances: 0, frames: 0,
        message: 'Connecting to the DICOMweb retrieval endpoint' });
    let response;
    const requestMeasurement = beginMeasure(options.onMeasure, 'instance-headers', { signal: options.signal });
    try {
        response = await fetch(url, { signal: options.signal, credentials: 'omit', headers: { Accept: 'multipart/related; type="application/dicom", application/dicom' } });
        requestMeasurement(response.ok ? 'success' : 'error', { source: 'url' });
    } catch (error) {
        requestMeasurement(error.name === 'AbortError' ? 'canceled' : 'error', { source: 'url' });
        checkAbort(options.signal);
        throw new Error('The retrieval request failed. Check HTTPS, the endpoint, and its browser CORS configuration.');
    }
    return loadResponse(response, options);
}

/** Parse an already fetched native DICOM response through the same bounded EASI pipeline. */
export async function loadResponse(response, options = {}) {
    const session = new SourceSession(options, 'url');
    try {
        if (options.signal?.aborted) { await response.body?.cancel(); checkAbort(options.signal); }
        if (!response.ok) { await response.body?.cancel(); throw new Error(`The retrieval endpoint returned HTTP ${response.status}.`); }
        if (!response.body) throw new Error('The endpoint returned no readable response body.');
        const contentType = response.headers.get('content-type') ?? '';
        if (!/^application\/dicom(?:\s*;|$)/i.test(contentType) && !/^multipart\/related(?:\s*;|$)/i.test(contentType)) {
            await response.body.cancel();
            throw new Error('Use a DICOMweb RetrieveInstance/Series/Study URL returning application/dicom or multipart/related; JSON metadata and rendered JPEG endpoints are not image inputs.');
        }
        const total = Number(response.headers.get('content-length'));
        session.total = total > 0 && Number.isSafeInteger(total) ? total : null;
        if (session.total > MAX_SOURCE_BYTES) { await response.body.cancel(); throw new Error('The response exceeds the 256 MiB source limit. Retrieve a smaller series.'); }
        const source = boundedStream(response.body, session);
        const measurement = beginMeasure(session.measure, 'pipeline', { signal: options.signal });
        try {
            await pipeline('part').process({ source, sourceOptions: { contentType, contentLength: session.total, onEmit: result => session.accept(result) } });
            measurement('success', { ...session.measureDetails(), bytes: session.loaded });
        } catch (error) {
            measurement(error.name === 'AbortError' ? 'canceled' : 'error', { bytes: session.loaded });
            if (!source.locked) { try { await source.cancel(); } catch {} }
            throw error;
        }
        checkAbort(options.signal);
        return finalize(session);
    } catch (error) {
        session.dispose();
        throw error;
    }
}

export async function loadDemo(kind = 'ct', options = {}) {
    checkAbort(options.signal);
    const onMeasure = options.onMeasure;
    return loadFiles(makeDemoFiles(kind), { ...options,
        onMeasure: typeof onMeasure === 'function' ? event => onMeasure({ ...event, source: 'demo' }) : undefined });
}
