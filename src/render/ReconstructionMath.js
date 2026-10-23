import { normalizeVoi, storedToDisplay } from '../data/presentation-math.js';
import { voxelToPatient, dot, orientation, vector, checkSignal, reconstructionError } from '../volume/geometry.js';
import { normalizePlane, planePoint, MAX_RECONSTRUCTION_SAMPLES } from '../volume/reslice.js';
import { yieldReconstruction } from '../volume/Volume.js';

export const MAX_WORKSPACE_DERIVED_BYTES = 8 * 1024 * 1024;
export const MAX_WORKSPACE_GRID = 256;

/** Bounds of the valid voxel-center lattice, including regular gantry shear. */
export function patientBounds(geometry) {
    if (!geometry || !['rows', 'columns', 'depth'].every(key => Number.isSafeInteger(geometry[key]) && geometry[key] >= 1)) throw reconstructionError('validated volume dimensions are required');
    const corners = [];
    for (const z of [0, geometry.depth - 1]) for (const y of [0, geometry.rows - 1]) for (const x of [0, geometry.columns - 1]) corners.push(voxelToPatient(geometry, [x, y, z]));
    const minimum = [0, 1, 2].map(axis => Math.min(...corners.map(point => point[axis])));
    const maximum = [0, 1, 2].map(axis => Math.max(...corners.map(point => point[axis])));
    return { corners, minimum, maximum, center: minimum.map((value, axis) => (value + maximum[axis]) / 2) };
}

export function patientBasis(view, yawDeg = 0, pitchDeg = 0) {
    if (!Number.isFinite(yawDeg) || !Number.isFinite(pitchDeg) || Math.abs(yawDeg) > 180 || Math.abs(pitchDeg) > 90) throw reconstructionError('oblique angles exceed their bounded range');
    if (view === 'axial') return [1, 0, 0, 0, 1, 0];
    if (view === 'coronal') return [1, 0, 0, 0, 0, -1];
    if (view === 'sagittal') return [0, 1, 0, 0, 0, -1];
    if (view !== 'oblique') throw reconstructionError('a known patient-space view is required');
    const yaw = yawDeg * Math.PI / 180, pitch = pitchDeg * Math.PI / 180;
    return [Math.cos(yaw) * Math.cos(pitch), Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), -Math.sin(yaw), Math.cos(yaw), 0];
}
function projected(corners, axis) {
    const values = corners.map(point => dot(point, axis));
    return { minimum: Math.min(...values), maximum: Math.max(...values) };
}

/** Square physical pixels fitted to all eight center corners, with explicit LPS axes. */
export function createPatientPlane(geometry, { view = 'axial', position = 0.5, yawDeg = 0, pitchDeg = 0, maximumSize = 192 } = {}) {
    if (!Number.isFinite(position) || position < 0 || position > 1 || !Number.isInteger(maximumSize) || maximumSize < 2 || maximumSize > MAX_WORKSPACE_GRID) throw reconstructionError('plane position or output resolution is invalid');
    const bounds = patientBounds(geometry), basis = orientation(patientBasis(view, yawDeg, pitchDeg));
    const u = projected(bounds.corners, basis.x), v = projected(bounds.corners, basis.y), n = projected(bounds.corners, basis.normal);
    const width = u.maximum - u.minimum, height = v.maximum - v.minimum;
    const spacing = Math.max(width, height) / (maximumSize - 1) || 1;
    // A subpixel extent needs one centered sample, rather than two samples both outside the lattice.
    const size = extent => extent < spacing * (1 - 1e-10) ? 1 : Math.min(maximumSize, Math.ceil(extent / spacing - 1e-10) + 1);
    const columns = size(width), rows = size(height), normalCoordinate = n.minimum + position * (n.maximum - n.minimum);
    const left = (u.minimum + u.maximum - (columns - 1) * spacing) / 2;
    const top = (v.minimum + v.maximum - (rows - 1) * spacing) / 2;
    const origin = [0, 1, 2].map(axis => left * basis.x[axis] + top * basis.y[axis] + normalCoordinate * basis.normal[axis]);
    return normalizePlane({ rows, columns, origin, orientation: [...basis.x, ...basis.y], pixelSpacing: [spacing, spacing] });
}

/** Move the ray camera to the front of the bounded lattice; cap work before rendering. */
export function raySamplingPlan(geometry, inputPlane) {
    const plane = normalizePlane(inputPlane), range = projected(patientBounds(geometry).corners, plane.normal);
    const offset = range.minimum - dot(plane.origin, plane.normal), origin = plane.origin.map((value, axis) => value + offset * plane.normal[axis]);
    const camera = normalizePlane({ ...plane, origin }), distance = Math.max(0, range.maximum - range.minimum);
    const nativeStep = Math.min(...[geometry.basisX, geometry.basisY, geometry.basisZ].map(axis => Math.hypot(...vector(axis)))) / 2;
    if (!Number.isFinite(nativeStep) || nativeStep <= 0) throw reconstructionError('a nondegenerate sampling interval is required');
    const ceiling = Math.min(4096, Math.floor(MAX_RECONSTRUCTION_SAMPLES / (plane.rows * plane.columns)));
    if (ceiling < 2 && distance > 0) throw reconstructionError('ray sampling exceeds its work budget');
    const steps = distance === 0 ? 1 : Math.max(2, Math.min(ceiling, Math.ceil(distance / nativeStep) + 1));
    const stepMm = distance === 0 ? 1 : distance / (steps - 1);
    return { plane: camera, nearMm: 0, farMm: distance, stepMm, steps };
}

export function derivedWindow(value, voiFunction = 'LINEAR') {
    if (!value || typeof value !== 'object') throw reconstructionError('choose an explicit modality window');
    return normalizeVoi(value.center, value.width, value.voiFunction ?? voiFunction);
}

/** Derived values are already modality values: no source rescale or Modality LUT is reapplied. */
export function displayTransfer(window, { color = 'grayscale', opacity = 1, rampOpacity = false, invert = false, presentationInvert = false } = {}) {
    const selected = derivedWindow(window);
    if (!['grayscale', 'warm'].includes(color) || !Number.isFinite(opacity) || opacity < 0 || opacity > 1 || typeof rampOpacity !== 'boolean' || typeof invert !== 'boolean' || typeof presentationInvert !== 'boolean') throw reconstructionError('display transfer settings are invalid');
    const presentation = { slope: 1, intercept: 0, window: selected, voiFunction: selected.voiFunction, presentationInvert };
    return value => {
        const level = storedToDisplay(value, presentation, { invert, voiMode: 'window' });
        return color === 'warm' ? [level, level * 0.6, level * 0.2, opacity * (rampOpacity ? level : 1)] : [level, level, level, opacity * (rampOpacity ? level : 1)];
    };
}

export async function derivedToRgba(image, window, { signal, invert = false, presentationInvert = false } = {}) {
    if (!image || !(image.values instanceof Float64Array) || !(image.valid instanceof Uint8Array) || image.values.length !== image.rows * image.columns ||
        image.valid.length !== image.values.length || image.rows > MAX_WORKSPACE_GRID || image.columns > MAX_WORKSPACE_GRID || image.rows < 1 || image.columns < 1) throw reconstructionError('bounded Float64 derived values and validity are required');
    checkSignal(signal); const transfer = displayTransfer(window, { invert, presentationInvert }), rgba = new Uint8ClampedArray(image.values.length * 4);
    for (let start = 0; start < image.values.length; start += 8192) {
        checkSignal(signal);
        const end = Math.min(image.values.length, start + 8192);
        for (let index = start; index < end; index++) {
            if (!image.valid[index]) continue;
            if (!Number.isFinite(image.values[index])) throw reconstructionError('a valid derived sample must be finite');
            const level = Math.round(transfer(image.values[index])[0] * 255);
            rgba[index * 4] = level; rgba[index * 4 + 1] = level; rgba[index * 4 + 2] = level; rgba[index * 4 + 3] = 255;
        }
        if (end < image.values.length) await yieldReconstruction();
    }
    checkSignal(signal); return rgba;
}

/** Explicit probe of a derived result. Ray colors never claim a single-voxel scalar. */
export function probeDerived(image, column, row) {
    if (!image || !Number.isFinite(column) || !Number.isFinite(row)) return null;
    const x = Math.floor(column), y = Math.floor(row);
    if (x < 0 || y < 0 || x >= image.columns || y >= image.rows) return null;
    const index = y * image.columns + x;
    if (image.values) return { kind: 'derived-modality', projection: image.projection, value: image.valid[index] ? image.values[index] : null, unit: image.unit,
        patient: planePoint(image.plane, x, y) };
    if (image.baseValues) return { kind: 'derived-fusion', base: image.baseValid[index] ? image.baseValues[index] : null,
        overlay: image.overlayValid[index] ? image.overlayValues[index] : null, baseUnit: image.baseUnit, overlayUnit: image.overlayUnit, patient: planePoint(image.plane, x, y) };
    return { kind: 'parallel-ray-color', mode: image.mode, rgba: Array.from(image.rgba.subarray(index * 4, index * 4 + 4)) };
}

/** Map a centered object-fit:contain canvas box to its actual displayed pixel content. */
export function derivedCanvasPoint(rectangle, image, clientX, clientY) {
    if (!rectangle || !image || ![rectangle.left, rectangle.top, rectangle.width, rectangle.height, clientX, clientY].every(Number.isFinite) ||
        rectangle.width <= 0 || rectangle.height <= 0 || !Number.isInteger(image.columns) || !Number.isInteger(image.rows) || image.columns <= 0 || image.rows <= 0) return null;
    const scale = Math.min(rectangle.width / image.columns, rectangle.height / image.rows);
    const left = rectangle.left + (rectangle.width - image.columns * scale) / 2, top = rectangle.top + (rectangle.height - image.rows * scale) / 2;
    const column = (clientX - left) / scale, row = (clientY - top) / scale;
    return column < 0 || row < 0 || column >= image.columns || row >= image.rows ? null : { column, row };
}
