// Pure stored-sample presentation math; no DICOM parser/model initialization.
export const MAX_LUT_ENTRIES = 65536;
export const MAX_PALETTE_PIXELS = 16 * 1024 * 1024;
const VOI_FUNCTIONS = new Set(['LINEAR', 'LINEAR_EXACT', 'SIGMOID']);
function invalid(message) { throw new Error(`Unsupported or invalid DICOM presentation: ${message}.`); }

function lookup(value, lut) {
    if (!Number.isSafeInteger(value)) invalid('LUT input must be an integer');
    if (lut.pending || !(lut.entries instanceof Uint16Array) || lut.entries.length !== lut.count) invalid('selected LUT data is unavailable');
    const index = Math.max(0, Math.min(lut.count - 1, value - lut.firstMapped));
    return lut.entries[index];
}

/** Preserve stored samples; modality evaluation produces a separate numeric value. */
export function evaluateModality(stored, presentation = {}) {
    if (!Number.isFinite(stored)) invalid('stored sample is not finite');
    if (presentation.modalityLut) return lookup(stored, presentation.modalityLut);
    const slope = presentation.slope ?? 1, intercept = presentation.intercept ?? 0;
    if (!Number.isFinite(slope) || slope === 0 || !Number.isFinite(intercept)) invalid('rescale values are invalid');
    const result = stored * slope + intercept;
    if (!Number.isFinite(result)) invalid('the modality value is not finite');
    return result;
}

/** Validate supplied VOI parameters without silently replacing invalid widths. */
export function normalizeVoi(center, width, voiFunction = 'LINEAR') {
    if (!VOI_FUNCTIONS.has(voiFunction) || !Number.isFinite(center) || !Number.isFinite(width) ||
        width < (voiFunction === 'LINEAR' ? 1 : Number.MIN_VALUE)) invalid('window values or VOI function are invalid');
    return { center, width, voiFunction };
}

/** CPU reference for modality -> selected VOI -> final polarity. Values remain in [0,1]. */
export function storedToDisplay(stored, presentation = {}, options = {}) {
    const modality = evaluateModality(stored, presentation);
    const mode = options.voiMode ?? presentation.voiMode ?? (presentation.voiLut ? 'lut' : 'window');
    let level;
    if (mode === 'lut') {
        if (!presentation.voiLut) invalid('no VOI LUT is available');
        level = lookup(modality, presentation.voiLut) / (2 ** presentation.voiLut.bits - 1);
    } else if (mode === 'window') {
        const supplied = options.window ?? presentation.window;
        if (!supplied) invalid('a window must be selected for scalar display');
        const { center, width, voiFunction } = normalizeVoi(supplied.center, supplied.width, supplied.voiFunction ?? presentation.voiFunction ?? 'LINEAR');
        if (voiFunction === 'SIGMOID') level = 1 / (1 + Math.exp(-4 * ((modality - center) / width)));
        else if (voiFunction === 'LINEAR_EXACT') level = Math.max(0, Math.min(1, (modality - center) / width + 0.5));
        else level = width === 1 ? Number(modality > center - 0.5) : Math.max(0, Math.min(1, (modality - (center - 0.5)) / (width - 1) + 0.5));
    } else invalid('the selected VOI mode is unsupported');
    return Boolean(presentation.presentationInvert) !== Boolean(options.invert) ? 1 - level : level;
}

/** Convert only display samples; callers retain the original palette indices. */
export function paletteToRgb(indices, palette) {
    if (!(indices instanceof Uint8Array || indices instanceof Uint16Array || indices instanceof Int16Array) || !palette ||
        indices.length > MAX_PALETTE_PIXELS || !Number.isInteger(palette.count) || palette.count < 1 || palette.count > MAX_LUT_ENTRIES ||
        !Number.isInteger(palette.firstMapped) || ![8, 16].includes(palette.bits) ||
        palette.pending || ![palette.red, palette.green, palette.blue].every(channel => channel instanceof Uint16Array && channel.length === palette.count)) {
        invalid('palette indices or selected RGB table data are unavailable');
    }
    const rgb = new Uint8Array(indices.length * 3);
    const maximum = 2 ** palette.bits - 1;
    for (let index = 0; index < indices.length; index++) {
        const entry = Math.max(0, Math.min(palette.count - 1, indices[index] - palette.firstMapped));
        rgb[index * 3] = Math.round(palette.red[entry] * 255 / maximum);
        rgb[index * 3 + 1] = Math.round(palette.green[entry] * 255 / maximum);
        rgb[index * 3 + 2] = Math.round(palette.blue[entry] * 255 / maximum);
    }
    return rgb;
}
