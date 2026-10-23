import { createImageReference, normalizeImageReference } from '../annotations/model.js';
import { normalizeVoi } from '../data/presentation-math.js';

const REFERENCE_FIELDS = ['sopUid', 'frameNumber', 'rows', 'columns', 'seriesUid', 'frameOfReferenceUid', 'geometryFingerprint'];

/** Display presentation requires an exact source reference, including absent optional scope. */
export function matchesPresentation(frame, presentation) {
    if (!frame || !presentation?.image) return false;
    try {
        const expected = normalizeImageReference(presentation.image), actual = createImageReference(frame);
        return REFERENCE_FIELDS.every(key => expected[key] === actual[key]);
    } catch { return false; }
}

/** Apply display-only GSPS metadata; preserve samples, modality transforms and patient geometry. */
export function displayFrame(frame, presentation) {
    if (!matchesPresentation(frame, presentation)) return frame;
    if (!['MONOCHROME1', 'MONOCHROME2'].includes(frame.photometric) || frame.modalityLut || typeof presentation.presentationInvert !== 'boolean' ||
        presentation.presentationShape != null && (!['IDENTITY', 'INVERSE'].includes(presentation.presentationShape) ||
            presentation.presentationInvert !== (presentation.presentationShape === 'INVERSE'))) throw new TypeError('Apply a compatible, explicit grayscale presentation polarity.');
    const window = normalizeVoi(presentation.window?.center, presentation.window?.width, presentation.window?.voiFunction ?? 'LINEAR');
    return { ...frame, window, voiFunction: window.voiFunction, voiLut: null, voiMode: 'window', presentationInvert: presentation.presentationInvert };
}
