import { frameWorldCenter } from '../runtime/workspace.js';

const MONOCHROME = new Set(['MONOCHROME1', 'MONOCHROME2']);
const fields = ['modality', 'photometric', 'unit', 'rows', 'columns'];
const acquisitionFields = ['effectiveEchoTime', 'temporalPositionIndex', 'acquisitionNumber', 'acquisitionContrast', 'complexImageComponent'];
function sameValue(frames, getter) {
    const value = getter(frames[0]);
    return frames.every(frame => getter(frame) === value) ? value ?? null : null;
}
const boundedText = (value, limit = 64) => typeof value === 'string' && value.length <= limit && !/[\x00-\x1f\x7f]/u.test(value) ? value : null;
function geometry(frame) {
    return frameWorldCenter(frame) !== null;
}

/** Matching uses normalized metadata; display snapshots, pixels and source IDs are absent. */
export function describeReadingSeries(series, index, role = 'unassigned') {
    if (!series || series.disposed || !Array.isArray(series.frames) || !series.frames.length || series.frames.length > 10000 ||
        !Number.isInteger(index) || index < 0 || index >= 128 || !['unassigned', 'current', 'prior'].includes(role)) throw new TypeError('Choose an available reading stack.');
    const frames = series.frames;
    const dimensionsValid = frames.every(frame => frame.classicDimensions?.invalid !== true && frame.classicDimensions?.spatialEligible !== false &&
        frame.dimensions?.invalid !== true && frame.syncDimensions?.invalid !== true && Number.isInteger(frame.frameIndex) && frame.frameIndex >= 0);
    const result = { index, role, frameCount: frames.length,
        description: boundedText(series.description, 256),
        geometryKnown: dimensionsValid && frames.every(geometry), dimensionsValid };
    for (const field of fields) result[field] = sameValue(frames, frame => frame[field] ?? (field === 'modality' ? series.modality : null));
    for (const field of acquisitionFields) result[field] = sameValue(frames, frame => (frame.dimensions ?? frame.classicDimensions)?.[field] ?? null);
    for (const field of ['modality', 'photometric', 'unit', 'acquisitionContrast', 'complexImageComponent']) result[field] = boundedText(result[field]);
    // A color stack never qualifies for grayscale presets, even if an external
    // source incorrectly supplied a scalar unit alongside it.
    if (!MONOCHROME.has(result.photometric)) result.unit = null;
    return Object.freeze(result);
}
