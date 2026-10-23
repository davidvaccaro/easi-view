import { evaluateModality, storedToDisplay, paletteToRgb } from '../data/presentation-math.js';
import { validateCircularShutter, circularShutterOccludes } from '../data/display-shutter.js';

export function isColorFrame(frame) { return ['RGB', 'PALETTE COLOR'].includes(frame?.photometric); }

/** Display math is a CPU reference for the GPU shader, using DICOM C.11.2. */
export function normalizeWindow(center, width, voiFunction = 'LINEAR') {
    if (!Number.isFinite(center) || !Number.isFinite(width)) {
        throw new TypeError('Window center and width must be finite numbers.');
    }
    const minimum = voiFunction === 'LINEAR' ? 1 : Number.MIN_VALUE;
    return { center, width: Math.max(minimum, width) };
}

export function windowValue(value, center, width, voiFunction = 'LINEAR') {
    const window = normalizeWindow(center, width, voiFunction);
    return evaluateWindow(value, window.center, window.width, voiFunction);
}

function evaluateWindow(value, center, width, voiFunction) {
    if (voiFunction === 'SIGMOID') return 1 / (1 + Math.exp(-4 * (value - center) / width));
    if (voiFunction === 'LINEAR_EXACT') {
        return Math.max(0, Math.min(1, (value - center) / width + 0.5));
    }
    if (width === 1) return value <= center - 0.5 ? 0 : 1;
    return Math.max(0, Math.min(1, (value - (center - 0.5)) / (width - 1) + 0.5));
}

export function paddingRange(frame) {
    const value = frame.padding?.value ?? frame.pixelPaddingValue;
    const limit = frame.padding?.limit ?? frame.pixelPaddingRangeLimit ?? value;
    if (!Number.isFinite(value) || !Number.isFinite(limit)) return null;
    return { min: Math.min(value, limit), max: Math.max(value, limit) };
}

export function isPadding(frame, stored) {
    const padding = paddingRange(frame);
    return padding !== null && stored >= padding.min && stored <= padding.max;
}

export function validateFrame(frame) {
    if (!frame || !Number.isInteger(frame.rows) || !Number.isInteger(frame.columns)
        || frame.rows < 1 || frame.columns < 1) {
        throw new TypeError('A frame needs positive integer rows and columns.');
    }
    if (!(frame.samples instanceof Int16Array || frame.samples instanceof Uint16Array
        || frame.samples instanceof Uint8Array)) {
        throw new TypeError('A frame needs an Int16Array, Uint16Array, or Uint8Array of stored samples.');
    }
    const color = frame.photometric === 'RGB';
    if (frame.samples.length !== frame.rows * frame.columns * (color ? 3 : 1)) {
        throw new RangeError('The number of stored samples does not match the frame dimensions.');
    }
    validateCircularShutter(frame);
    for (const table of [frame.modalityLut, frame.voiLut, frame.palette]) {
        if (!table) continue;
        if (table.pending || !Number.isInteger(table.count) || table.count < 1 || table.count > 65536 ||
            !Number.isInteger(table.firstMapped) || ![8,16].includes(table.bits)) throw new TypeError('The display lookup table is invalid or incomplete.');
        for (const entries of table === frame.palette ? [table.red,table.green,table.blue] : [table.entries]) {
            if (!(entries instanceof Uint16Array) || entries.length !== table.count || entries.some(value => value > 2 ** table.bits - 1)) throw new TypeError('The display lookup table entries are invalid.');
        }
    }
    if (frame.voiLut && !frame.modalityLut && (!Number.isInteger(frame.slope ?? 1) || !Number.isInteger(frame.intercept ?? 0))) {
        throw new TypeError('VOI lookup requires integer modality inputs.');
    }
    if (color) {
        if (!(frame.samples instanceof Uint8Array) || (frame.samplesPerPixel ?? 3) !== 3 ||
            (frame.bitsAllocated ?? 8) !== 8 || (frame.bitsStored ?? 8) !== 8 || (frame.highBit ?? 7) !== 7 || frame.signed === true) {
            throw new TypeError('This color renderer requires three unsigned 8-bit RGB samples per pixel.');
        }
        if ((frame.slope ?? 1) !== 1 || (frame.intercept ?? 0) !== 0 || paddingRange(frame)) {
            throw new TypeError('RGB frames cannot use scalar rescale or padding transforms.');
        }
        return frame;
    }
    if (frame.photometric === 'PALETTE COLOR') {
        if ((frame.samplesPerPixel ?? 1) !== 1 || !frame.palette || frame.palette.pending) throw new TypeError('Palette frames require original indices and complete RGB tables.');
        paletteToRgb(frame.samples.subarray(0, 1), frame.palette);
        return frame;
    }
    if (!['MONOCHROME1', 'MONOCHROME2'].includes(frame.photometric)) {
        throw new TypeError('This renderer supports MONOCHROME1 and MONOCHROME2 scalar frames.');
    }
    if (!Number.isFinite(frame.slope ?? 1) || !Number.isFinite(frame.intercept ?? 0)) {
        throw new TypeError('Frame rescale values must be finite.');
    }
    if (frame.voiFunction && !['LINEAR', 'LINEAR_EXACT', 'SIGMOID'].includes(frame.voiFunction)) {
        throw new TypeError(`Unsupported VOI function: ${frame.voiFunction}.`);
    }
    return frame;
}

export function renderScalarToRgba(frame, state = frame.window) {
    validateFrame(frame);
    if (isColorFrame(frame)) throw new TypeError('Color frames require the color rendering profile.');
    const center = state?.center ?? frame.window?.center ?? 0;
    const width = state?.width ?? frame.window?.width ?? 1;
    const window = normalizeWindow(center, width, frame.voiFunction);
    const rgba = new Uint8ClampedArray(frame.samples.length * 4);
    const presentation = { ...frame, presentationInvert: frame.presentationInvert ?? frame.photometric === 'MONOCHROME1' };
    const options = { window, invert: state?.invert, voiMode: state?.voiMode ?? frame.voiMode ?? (frame.voiLut ? 'lut' : 'window') };
    const inverted = Boolean(presentation.presentationInvert) !== Boolean(options.invert);
    const padding = paddingRange(frame);
    const shutter = frame.displayShutter;
    for (let index = 0; index < frame.samples.length; index++) {
        const stored = frame.samples[index];
        const padded = padding !== null && stored >= padding.min && stored <= padding.max;
        let level = options.voiMode === 'lut' ? storedToDisplay(stored, presentation, options)
            : evaluateWindow(evaluateModality(stored, frame), window.center, window.width, frame.voiFunction);
        if (options.voiMode !== 'lut' && inverted) level = 1 - level;
        const occluded = shutter && circularShutterOccludes(shutter, Math.floor(index / frame.columns) + 1, index % frame.columns + 1);
        // Shutter values are final P-values, independent of VOI, polarity,
        // user inversion and padding. Stored samples and probes remain intact.
        const gray = occluded ? Math.round(shutter.presentationValue * 255 / 65535) : padded ? 0 : Math.round(level * 255);
        rgba[index * 4] = gray;
        rgba[index * 4 + 1] = gray;
        rgba[index * 4 + 2] = gray;
        rgba[index * 4 + 3] = 255;
    }
    return rgba;
}

/** RGB channels retain their native intensity; grayscale VOI does not apply. */
export function renderColorToRgba(frame) {
    validateFrame(frame);
    if (!isColorFrame(frame)) throw new TypeError('The color rendering profile requires RGB or palette samples.');
    const samples = frame.photometric === 'PALETTE COLOR' ? paletteToRgb(frame.samples, frame.palette) : frame.samples;
    const rgba = new Uint8ClampedArray(frame.rows * frame.columns * 4);
    for (let pixel = 0; pixel < frame.rows * frame.columns; pixel++) {
        const padded = frame.photometric === 'PALETTE COLOR' && isPadding(frame, frame.samples[pixel]);
        rgba[pixel * 4] = padded ? 0 : samples[pixel * 3];
        rgba[pixel * 4 + 1] = padded ? 0 : samples[pixel * 3 + 1];
        rgba[pixel * 4 + 2] = padded ? 0 : samples[pixel * 3 + 2];
        rgba[pixel * 4 + 3] = 255;
    }
    return rgba;
}

/** Image coordinates have their origin at the top-left edge, not pixel center. */
export function probe(frame, x, y) {
    if (!frame || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    const column = Math.floor(x);
    const row = Math.floor(y);
    if (column < 0 || row < 0 || column >= frame.columns || row >= frame.rows) return null;
    if (frame.photometric === 'RGB') {
        const start = (row * frame.columns + column) * 3;
        const rgb = Array.from(frame.samples.subarray(start, start + 3));
        return { x: column, y: row, stored: rgb, rgb: [...rgb], rescaled: null, unit: 'RGB', padding: false };
    }
    const stored = frame.samples[row * frame.columns + column];
    if (frame.photometric === 'PALETTE COLOR') return {
        x: column, y: row, stored, rgb: [...paletteToRgb(frame.samples.subarray(row * frame.columns + column, row * frame.columns + column + 1), frame.palette)],
        rescaled: null, unit: 'Palette index', padding: isPadding(frame, stored)
    };
    return {
        x: column,
        y: row,
        stored,
        rescaled: evaluateModality(stored, frame),
        unit: frame.unit ?? '',
        padding: isPadding(frame, stored)
    };
}

export function validPixelSpacing(spacing) {
    return Array.isArray(spacing) && spacing.length === 2
        && spacing.every(value => Number.isFinite(value) && value > 0);
}

export function validPixelAspectRatio(ratio) {
    return Array.isArray(ratio) && ratio.length === 2
        && ratio.every(value => Number.isSafeInteger(value) && value > 0);
}

export function measureDistance(points, pixelSpacing) {
    if (!Array.isArray(points) || points.length !== 2
        || points.some(point => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))) {
        throw new TypeError('Distance measurement requires two image-coordinate points.');
    }
    const calibrated = validPixelSpacing(pixelSpacing);
    const [rowSpacing, columnSpacing] = calibrated ? pixelSpacing : [1, 1];
    return {
        value: Math.hypot((points[1].x - points[0].x) * columnSpacing,
            (points[1].y - points[0].y) * rowSpacing),
        unit: calibrated ? 'mm' : 'px',
        calibrated
    };
}
