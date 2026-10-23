import { direction, checkSignal, reconstructionError } from './geometry.js';
import { yieldReconstruction } from './Volume.js';
import { normalizePlane, planePoint, samplingOptions, outputBudget, MAX_RECONSTRUCTION_OUTPUT_BYTES, MAX_RECONSTRUCTION_SAMPLES,
    addProjection, projectionAccumulator } from './reslice.js';

export const MAX_RAY_STEPS = 4096;
export function transferColor(callback, value) {
    const color = callback(value);
    if (!(Array.isArray(color) || color instanceof Float32Array || color instanceof Float64Array) || ![3, 4].includes(color.length) ||
        [...color].some(channel => !Number.isFinite(channel) || channel < 0 || channel > 1)) {
        throw reconstructionError('transfer function must return normalized RGB or RGBA channels');
    }
    return [color[0], color[1], color[2], color.length === 4 ? color[3] : 1];
}
export function writeColor(output, index, color) {
    for (let channel = 0; channel < 4; channel++) output[index * 4 + channel] = Math.round(color[channel] * 255);
}

/** Parallel patient-space rays; explicit sampling interval and color transfer. */
export async function raycast(volume, inputPlane, { signal, rayDirection, nearMm, farMm, stepMm, transferFunction,
    mode = 'composite', interpolation = 'trilinear', domain = 'modality', terminationAlpha = 0.999,
    maxBytes = MAX_RECONSTRUCTION_OUTPUT_BYTES } = {}) {
    checkSignal(signal); volume._assertActive();
    const plane = normalizePlane(inputPlane), suppliedDirection = direction(rayDirection ?? plane.normal),
        directionVector = suppliedDirection.map(value => value / Math.hypot(...suppliedDirection)), sampling = samplingOptions(interpolation, domain);
    if (typeof transferFunction !== 'function' || !['composite', 'mip', 'minip', 'mean'].includes(mode) ||
        ![nearMm, farMm, stepMm].every(Number.isFinite) || nearMm < 0 || farMm < nearMm || farMm > 1e6 || stepMm <= 0 ||
        !Number.isFinite(terminationAlpha) || terminationAlpha <= 0 || terminationAlpha > 1) throw reconstructionError('explicit ray interval, transfer function and projection are required');
    const steps = Math.floor((farMm - nearMm) / stepMm) + 1, pixels = plane.rows * plane.columns;
    if (!Number.isSafeInteger(steps) || steps > MAX_RAY_STEPS || pixels * steps > MAX_RECONSTRUCTION_SAMPLES) throw reconstructionError('ray samples exceed the operation budget');
    outputBudget(pixels * 4, maxBytes);
    const rgba = new Uint8ClampedArray(pixels * 4);
    let work = 0;
    for (let row = 0; row < plane.rows; row++) {
        checkSignal(signal); volume._assertActive();
        for (let column = 0; column < plane.columns; column++) {
            const origin = planePoint(plane, column, row), accumulator = projectionAccumulator(mode);
            let red = 0, green = 0, blue = 0, alpha = 0;
            for (let step = 0; step < steps; step++) {
                const distance = nearMm + step * stepMm;
                const point = origin.map((value, axis) => value + directionVector[axis] * distance);
                const value = volume.samplePatient(point, sampling);
                if (!Number.isFinite(value)) continue;
                if (mode !== 'composite') { addProjection(accumulator, value, mode); continue; }
                const color = transferColor(transferFunction, value), opacity = (1 - alpha) * color[3];
                red += opacity * color[0]; green += opacity * color[1]; blue += opacity * color[2]; alpha += opacity;
                if (alpha >= terminationAlpha) break;
            }
            const index = row * plane.columns + column;
            if (mode === 'composite' && alpha > 0) writeColor(rgba, index, [red / alpha, green / alpha, blue / alpha, alpha]);
            else if (mode !== 'composite' && accumulator.count) writeColor(rgba, index, transferColor(transferFunction, accumulator.value));
            work += steps;
            if (work >= 16384) { work = 0; await yieldReconstruction(); checkSignal(signal); volume._assertActive(); }
        }
    }
    await yieldReconstruction(); checkSignal(signal); volume._assertActive();
    return { rows: plane.rows, columns: plane.columns, rgba, bytes: rgba.byteLength, plane, steps, stepMm, mode,
        frameOfReferenceUid: volume.geometry.frameOfReferenceUid };
}
