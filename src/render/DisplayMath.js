/** Display math is a CPU reference for the GPU shader, using DICOM C.11.2. */
export function normalizeWindow(center, width, voiFunction = 'LINEAR') {
    if (!Number.isFinite(center) || !Number.isFinite(width)) {
        throw new TypeError('Window center and width must be finite numbers.');
    }
    const minimum = voiFunction === 'LINEAR_EXACT' ? Number.EPSILON : 1;
    return { center, width: Math.max(minimum, width) };
}

export function windowValue(value, center, width, voiFunction = 'LINEAR') {
    const window = normalizeWindow(center, width, voiFunction);
    return evaluateWindow(value, window.center, window.width, voiFunction);
}

function evaluateWindow(value, center, width, voiFunction) {
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
    if (frame.samples.length !== frame.rows * frame.columns) {
        throw new RangeError('The number of stored samples does not match the frame dimensions.');
    }
    if (!['MONOCHROME1', 'MONOCHROME2'].includes(frame.photometric)) {
        throw new TypeError('This renderer supports MONOCHROME1 and MONOCHROME2 scalar frames.');
    }
    if (!Number.isFinite(frame.slope ?? 1) || !Number.isFinite(frame.intercept ?? 0)) {
        throw new TypeError('Frame rescale values must be finite.');
    }
    if (frame.voiFunction && !['LINEAR', 'LINEAR_EXACT'].includes(frame.voiFunction)) {
        throw new TypeError(`Unsupported VOI function: ${frame.voiFunction}.`);
    }
    return frame;
}

export function renderScalarToRgba(frame, state = frame.window) {
    validateFrame(frame);
    const center = state?.center ?? frame.window?.center ?? 0;
    const width = state?.width ?? frame.window?.width ?? 1;
    const window = normalizeWindow(center, width, frame.voiFunction);
    const inverted = (frame.photometric === 'MONOCHROME1') !== Boolean(state?.invert);
    const rgba = new Uint8ClampedArray(frame.samples.length * 4);
    const padding = paddingRange(frame);
    const slope = frame.slope ?? 1;
    const intercept = frame.intercept ?? 0;
    for (let index = 0; index < frame.samples.length; index++) {
        const stored = frame.samples[index];
        const padded = padding !== null && stored >= padding.min && stored <= padding.max;
        let level = evaluateWindow(stored * slope + intercept, window.center, window.width, frame.voiFunction);
        if (inverted) level = 1 - level;
        const gray = padded ? 0 : Math.round(level * 255);
        rgba[index * 4] = gray;
        rgba[index * 4 + 1] = gray;
        rgba[index * 4 + 2] = gray;
        rgba[index * 4 + 3] = 255;
    }
    return rgba;
}

/** Image coordinates have their origin at the top-left edge, not pixel center. */
export function probe(frame, x, y) {
    if (!frame || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    const column = Math.floor(x);
    const row = Math.floor(y);
    if (column < 0 || row < 0 || column >= frame.columns || row >= frame.rows) return null;
    const stored = frame.samples[row * frame.columns + column];
    return {
        x: column,
        y: row,
        stored,
        rescaled: stored * (frame.slope ?? 1) + (frame.intercept ?? 0),
        unit: frame.unit ?? '',
        padding: isPadding(frame, stored)
    };
}

export function validPixelSpacing(spacing) {
    return Array.isArray(spacing) && spacing.length === 2
        && spacing.every(value => Number.isFinite(value) && value > 0);
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
