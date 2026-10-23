import { vector, dot, cross, checkSignal, reconstructionError } from './geometry.js';
import { yieldReconstruction } from './Volume.js';
import { normalizePlane, planePoint, samplingOptions, outputBudget, MAX_RECONSTRUCTION_OUTPUT_BYTES, MAX_RECONSTRUCTION_SAMPLES } from './reslice.js';
import { transferColor, writeColor } from './raycast.js';

/** Explicit row-major matrix maps base patient coordinates to overlay coordinates. */
export function validateRigidRegistration(registration, baseUid, overlayUid) {
    const matrix = registration?.matrix;
    if (!registration || !(Array.isArray(matrix) || matrix instanceof Float64Array || matrix instanceof Float32Array) || matrix.length !== 16 ||
        [...matrix].some(value => !Number.isFinite(value) || Math.abs(value) > 1e9) ||
        [matrix[12], matrix[13], matrix[14], matrix[15] - 1].some(value => Math.abs(value) > 1e-9)) {
        throw reconstructionError('an explicit homogeneous rigid registration matrix is required');
    }
    const x = [matrix[0], matrix[4], matrix[8]], y = [matrix[1], matrix[5], matrix[9]], z = [matrix[2], matrix[6], matrix[10]];
    if ([x, y, z].some(axis => Math.abs(dot(axis, axis) - 1) > 0.000001) ||
        [dot(x, y), dot(y, z), dot(z, x), dot(x, cross(y, z)) - 1].some(value => Math.abs(value) > 0.000001)) {
        throw reconstructionError('registration must be a rigid rotation and translation, without reflection or scale');
    }
    for (const [key, uid] of [['fromFrameOfReferenceUid', baseUid], ['toFrameOfReferenceUid', overlayUid]]) {
        if (registration[key] != null && registration[key] !== uid || baseUid !== overlayUid && registration[key] !== uid) {
            throw reconstructionError('registration Frame of Reference identifiers must match both volumes');
        }
    }
    return Object.freeze([...matrix]);
}
function transform(matrix, point) {
    const p = vector(point);
    return [matrix[0] * p[0] + matrix[1] * p[1] + matrix[2] * p[2] + matrix[3],
        matrix[4] * p[0] + matrix[5] * p[1] + matrix[6] * p[2] + matrix[7],
        matrix[8] * p[0] + matrix[9] * p[1] + matrix[10] * p[2] + matrix[11]];
}

export class RegisteredFusion {
    constructor(base, overlay, { registration } = {}) {
        base._assertActive(); overlay._assertActive();
        this.registration = validateRigidRegistration(registration, base.geometry.frameOfReferenceUid, overlay.geometry.frameOfReferenceUid);
        this.base = base; this.overlay = overlay; this.disposed = false;
    }
    _assertActive() {
        if (this.disposed) throw reconstructionError('fusion is disposed');
        this.base._assertActive(); this.overlay._assertActive();
    }
    samplePatient(patient, options) {
        this._assertActive();
        return { base: this.base.samplePatient(patient, options), overlay: this.overlay.samplePatient(transform(this.registration, patient), options) };
    }
    dispose() { this.base = null; this.overlay = null; this.disposed = true; }
}
export function createFusion(base, overlay, options) { return new RegisteredFusion(base, overlay, options); }

/** Independent scalar values stay separate; only explicit display colors blend. */
export async function renderFusion(fusion, inputPlane, { signal, mode = 'alpha', alpha = 0.5, checkerSize = 16,
    baseTransferFunction, overlayTransferFunction, interpolation = 'trilinear', domain = 'modality',
    maxBytes = MAX_RECONSTRUCTION_OUTPUT_BYTES } = {}) {
    checkSignal(signal); fusion._assertActive();
    const plane = normalizePlane(inputPlane), sampling = samplingOptions(interpolation, domain), pixels = plane.rows * plane.columns;
    if (!['alpha', 'checkerboard'].includes(mode) || typeof baseTransferFunction !== 'function' || typeof overlayTransferFunction !== 'function' ||
        !Number.isFinite(alpha) || alpha < 0 || alpha > 1 || !Number.isSafeInteger(checkerSize) || checkerSize < 1 || checkerSize > 4096 ||
        pixels * 2 > MAX_RECONSTRUCTION_SAMPLES) throw reconstructionError('fusion mode, transfer functions or blend controls are invalid');
    outputBudget(pixels * 22, maxBytes);
    const baseValues = new Float64Array(pixels), overlayValues = new Float64Array(pixels), baseValid = new Uint8Array(pixels), overlayValid = new Uint8Array(pixels);
    baseValues.fill(NaN); overlayValues.fill(NaN);
    const rgba = new Uint8ClampedArray(pixels * 4);
    let work = 0;
    for (let row = 0; row < plane.rows; row++) {
        checkSignal(signal); fusion._assertActive();
        for (let column = 0; column < plane.columns; column++) {
            const index = row * plane.columns + column, pair = fusion.samplePatient(planePoint(plane, column, row), sampling);
            if (Number.isFinite(pair.base)) { baseValues[index] = pair.base; baseValid[index] = 1; }
            if (Number.isFinite(pair.overlay)) { overlayValues[index] = pair.overlay; overlayValid[index] = 1; }
            const baseColor = baseValid[index] ? transferColor(baseTransferFunction, pair.base) : [0, 0, 0, 0];
            const overlayColor = overlayValid[index] ? transferColor(overlayTransferFunction, pair.overlay) : [0, 0, 0, 0];
            if (mode === 'checkerboard') writeColor(rgba, index, (Math.floor(row / checkerSize) + Math.floor(column / checkerSize)) % 2 ? overlayColor : baseColor);
            else {
                const oa = overlayColor[3] * alpha, ba = baseColor[3] * (1 - oa), opacity = oa + ba;
                if (opacity) writeColor(rgba, index, [(overlayColor[0] * oa + baseColor[0] * ba) / opacity,
                    (overlayColor[1] * oa + baseColor[1] * ba) / opacity, (overlayColor[2] * oa + baseColor[2] * ba) / opacity, opacity]);
            }
            if (++work >= 8192) { work = 0; await yieldReconstruction(); checkSignal(signal); fusion._assertActive(); }
        }
    }
    await yieldReconstruction(); checkSignal(signal); fusion._assertActive();
    return { rows: plane.rows, columns: plane.columns, rgba, baseValues, overlayValues, baseValid, overlayValid, plane,
        baseUnit: domain === 'modality' ? fusion.base.geometry.unit : 'stored', overlayUnit: domain === 'modality' ? fusion.overlay.geometry.unit : 'stored',
        domain, mode, bytes: pixels * 22, frameOfReferenceUid: fusion.base.geometry.frameOfReferenceUid };
}
