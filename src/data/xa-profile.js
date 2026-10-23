import { Tag } from '@xinonix/easi-js';
import { resolveFrameTiming } from './frame-timing.js';

export const CLASSIC_XA_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.12.1';
export const CLASSIC_RF_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.12.2';

function value(set, id) { return set.value(Tag.find(id), null); }

function textValues(set, id) {
    const raw = value(set, id);
    if (raw == null) return [];
    const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split('\\') : [raw];
    if (values.some(item => item != null && typeof item !== 'string')) {
        throw new Error('Invalid classic XA presentation metadata.');
    }
    return values.filter(item => item != null).map(item => item.trim()).filter(Boolean);
}

function frameIncrementPointer(set, littleEndian, profile) {
    const attribute = set.find(Tag.find('00280009'));
    if (!attribute) return null;
    const raw = attribute.value;
    if (ArrayBuffer.isView(raw)) {
        // Native AT values are group/element words in the dataset's byte order.
        if (raw.byteLength !== 4) throw new Error(`${profile} requires one Frame Increment Pointer referencing Frame Time (0018,1063) or Frame Time Vector (0018,1065).`);
        const bytes = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        return bytes.getUint16(0, littleEndian).toString(16).padStart(4, '0') +
            bytes.getUint16(2, littleEndian).toString(16).padStart(4, '0');
    }
    const entries = Array.isArray(raw) ? raw : [raw];
    if (entries.length !== 1 || typeof entries[0] !== 'string' || !/^[0-9a-fA-F]{8}$/.test(entries[0])) {
        throw new Error(`${profile} requires one Frame Increment Pointer referencing Frame Time (0018,1063) or Frame Time Vector (0018,1065).`);
    }
    return entries[0].toUpperCase();
}

/** Classic XA/RF: scalar native viewing, selected recorded clock, and no active subtraction. */
export function validateClassicXrayProfile(set, metadata) {
    const { samplesPerPixel, photometric, bitsAllocated, bitsStored, highBit, signed,
        slope, intercept, frameCount, littleEndian } = metadata;
    const profile = metadata.sopClass === CLASSIC_RF_SOP_CLASS ? 'Classic RF' : 'Classic XA';
    if (samplesPerPixel !== 1 || photometric !== 'MONOCHROME2' || signed ||
        ![8, 16].includes(bitsAllocated) || ![8, 10, 12, 16].includes(bitsStored) || highBit !== bitsStored - 1) {
        throw new Error(`${profile} requires unsigned MONOCHROME2 pixels with one sample, Bits Stored 8, 10, 12 or 16, and High Bit equal to Bits Stored minus one.`);
    }
    if (slope !== 1 || intercept !== 0 || textValues(set, '00281054').some(type => type !== 'US')) {
        throw new Error(`This ${profile.toLowerCase()} profile does not support nonidentity modality rescale or quantitative rescale units.`);
    }
    const relationship = textValues(set, '00281040');
    if (relationship.length !== 1 || !['LIN', 'DISP'].includes(relationship[0])) {
        throw new Error(`This ${profile.toLowerCase()} profile requires Pixel Intensity Relationship LIN or DISP; LOG images need a dedicated LUT implementation.`);
    }
    // Relationship and its sign describe beam physics, not a display inversion or log operation.
    const modes = textValues(set, '00281090');
    if (modes.includes('SUB')) throw new Error(`${profile} mask subtraction is not supported. Open native, unsubtracted image frames.`);
    if (modes.some(mode => mode !== 'NAT')) throw new Error(`This ${profile.toLowerCase()} profile supports native (NAT) viewing only.`);
    const mask = set.find(Tag.find('00286100'));
    if (mask) {
        if (!Array.isArray(mask.items)) throw new Error(`Invalid ${profile.toLowerCase()} mask subtraction metadata.`);
        for (const item of mask.items) {
            const operations = textValues(item, '00286101');
            if (operations.length !== 1 || operations[0] !== 'NONE') {
                throw new Error(`${profile} mask subtraction is not supported. Mask operations must be NONE for native viewing.`);
            }
            // A NONE operation does not use Mask Frame Numbers, shifts, averaging or TID offsets.
        }
    }
    if (textValues(set, '00181600').length && !metadata.displayShutter || set.has(Tag.find('00189472'))) {
        throw new Error(`${profile} display shutters require the verified circular display-shutter profile.`);
    }
    if (set.has(Tag.find('00289422'))) {
        throw new Error(`${profile} Pixel Intensity Relationship LUTs are not supported by this profile.`);
    }
    if (set.has(Tag.find('00283000'))) throw new Error(`${profile} Modality LUTs require a dedicated intensity profile.`);
    if (set.has(Tag.find('0028000A'))) throw new Error(`${profile} additional frame-dimension pointers require a dedicated geometry profile.`);
    const pointer = frameIncrementPointer(set, littleEndian, profile);
    if ((frameCount > 1 && !['00181063', '00181065'].includes(pointer)) || (pointer !== null && !['00181063', '00181065'].includes(pointer))) {
        throw new Error(`${profile} requires one Frame Increment Pointer referencing Frame Time (0018,1063) or Frame Time Vector (0018,1065).`);
    }
    // Only the selected clock defines playback. An unused optional clock is not
    // repaired or used as a substitute when its selected counterpart is invalid.
    if (pointer === '00181065') return resolveFrameTiming(set, frameCount, { littleEndian });
    const declaredTime = value(set, '00181063');
    if ((Array.isArray(declaredTime) && declaredTime.length > 1) ||
        (typeof declaredTime === 'string' && declaredTime.includes('\\'))) {
        throw new Error(`${profile} Frame Time must contain one fixed timing value.`);
    }
    const components = Array.isArray(declaredTime) ? declaredTime : [declaredTime];
    const rawTime = components[0];
    const frameTime = rawTime == null || typeof rawTime === 'string' && !rawTime.trim() ? null : Number(rawTime);
    if ((frameCount > 1 || pointer !== null) && frameTime == null) {
        throw new Error(`${profile} cine requires a declared positive Frame Time; its timing cannot be inferred.`);
    }
    if (frameTime != null && (!Number.isFinite(frameTime) || frameTime < 0 || (frameCount > 1 && frameTime === 0))) {
        throw new Error(`${profile} cine requires positive Frame Time; zero is valid only for a single frame.`);
    }
    return resolveFrameTiming(set, frameCount, { littleEndian });
}

export const validateClassicXaProfile = validateClassicXrayProfile;
