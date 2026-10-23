import { orientation, vector, reconstructionError, checkSignal } from './geometry.js';
import { yieldReconstruction } from './Volume.js';

export const MAX_RECONSTRUCTION_OUTPUT_BYTES = 32 * 1024 * 1024;
export const MAX_RECONSTRUCTION_SAMPLES = 16 * 1024 * 1024;
export const MAX_SLAB_SAMPLES = 1024;
function integer(value, minimum, maximum) { return Number.isSafeInteger(value) && value >= minimum && value <= maximum; }
export function outputBudget(bytes, maxBytes = MAX_RECONSTRUCTION_OUTPUT_BYTES) {
    if (!integer(maxBytes, 1, MAX_RECONSTRUCTION_OUTPUT_BYTES) || !Number.isSafeInteger(bytes) || bytes > maxBytes) throw reconstructionError('derived output exceeds its byte budget');
}
export function normalizePlane(plane) {
    if (!plane || !integer(plane.rows, 1, 4096) || !integer(plane.columns, 1, 4096)) throw reconstructionError('derived plane dimensions are invalid');
    const origin = vector(plane.origin), spacing = vector(plane.pixelSpacing, 2), o = orientation(plane.orientation);
    if (spacing.some(value => value <= 0 || value > 10000)) throw reconstructionError('derived plane needs physical row/column spacing');
    return Object.freeze({ rows: plane.rows, columns: plane.columns, origin: Object.freeze(origin),
        pixelSpacing: Object.freeze(spacing), orientation: Object.freeze([...o.x, ...o.y]),
        basisX: Object.freeze(o.x.map(value => value * spacing[1])), basisY: Object.freeze(o.y.map(value => value * spacing[0])),
        normal: Object.freeze(o.normal) });
}
export function planePoint(plane, column, row, normalOffsetMm = 0) {
    return plane.origin.map((value, axis) => value + plane.basisX[axis] * column + plane.basisY[axis] * row + plane.normal[axis] * normalOffsetMm);
}
export function samplingOptions(interpolation = 'trilinear', domain = 'modality') {
    if (!['nearest', 'trilinear'].includes(interpolation) || !['stored', 'modality'].includes(domain)) throw reconstructionError('derived sampling mode is unsupported');
    return { interpolation, domain };
}
export function addProjection(accumulator, value, projection) {
    if (!Number.isFinite(value)) return;
    accumulator.count++;
    if (projection === 'mip') accumulator.value = Math.max(accumulator.value, value);
    else if (projection === 'minip') accumulator.value = Math.min(accumulator.value, value);
    else {
        // Incremental weighted mean avoids overflow in the sum of finite values.
        accumulator.value = accumulator.value * ((accumulator.count - 1) / accumulator.count) + value / accumulator.count;
        if (!Number.isFinite(accumulator.value)) throw reconstructionError('projection exceeds numeric range');
    }
}
export function projectionAccumulator(projection) { return { count: 0, value: projection === 'mip' ? -Infinity : projection === 'minip' ? Infinity : 0 }; }

/** First output pixel center is plane.origin; slab samples include both endpoints. */
export async function reslice(volume, inputPlane, { signal, interpolation = 'trilinear', domain = 'modality', projection = 'slice',
    thicknessMm = 0, samples = 1, maxBytes = MAX_RECONSTRUCTION_OUTPUT_BYTES } = {}) {
    checkSignal(signal); volume._assertActive();
    const plane = normalizePlane(inputPlane), mode = samplingOptions(interpolation, domain), pixels = plane.rows * plane.columns;
    if (!['slice', 'mip', 'minip', 'mean'].includes(projection) || !Number.isFinite(thicknessMm) || thicknessMm < 0 || thicknessMm > 1e6 ||
        !integer(samples, 1, MAX_SLAB_SAMPLES) || projection === 'slice' && (samples !== 1 || thicknessMm !== 0) ||
        projection !== 'slice' && (samples === 1 ? thicknessMm !== 0 : thicknessMm <= 0) || pixels * samples > MAX_RECONSTRUCTION_SAMPLES) {
        throw reconstructionError('slab thickness, sample count or projection is invalid');
    }
    outputBudget(pixels * 9, maxBytes);
    const values = new Float64Array(pixels), valid = new Uint8Array(pixels); values.fill(NaN);
    let work = 0;
    for (let row = 0; row < plane.rows; row++) {
        checkSignal(signal); volume._assertActive();
        for (let column = 0; column < plane.columns; column++) {
            const index = row * plane.columns + column;
            if (projection === 'slice') {
                const value = volume.samplePatient(planePoint(plane, column, row), mode);
                if (Number.isFinite(value)) { values[index] = value; valid[index] = 1; }
            } else {
                const accumulator = projectionAccumulator(projection);
                for (let sample = 0; sample < samples; sample++) {
                    const offset = samples === 1 ? 0 : -thicknessMm / 2 + thicknessMm * sample / (samples - 1);
                    addProjection(accumulator, volume.samplePatient(planePoint(plane, column, row, offset), mode), projection);
                }
                if (accumulator.count) { values[index] = accumulator.value; valid[index] = 1; }
            }
            work += samples;
            if (work >= 16384) { work = 0; await yieldReconstruction(); checkSignal(signal); volume._assertActive(); }
        }
    }
    await yieldReconstruction(); checkSignal(signal); volume._assertActive();
    return { rows: plane.rows, columns: plane.columns, values, valid, plane, domain,
        unit: domain === 'modality' ? volume.geometry.unit : 'stored', projection, thicknessMm, samples,
        frameOfReferenceUid: volume.geometry.frameOfReferenceUid, bytes: values.byteLength + valid.byteLength };
}
