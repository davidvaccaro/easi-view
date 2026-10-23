import { rejectTags, one, code } from '../derived/common.js';
import { orientation, vector, subtract, dot } from '../volume/geometry.js';
import { dataSet, text, scalar, numbers, pointer, integer, uid, fail, nativeSyntax, nativePixelBytes, unsignedPixelReader,
    boundedOutput, frozenArray, checkSignal, yieldTask, MAX_SPECIALTY_BYTES, MAX_SPECIALTY_FRAMES } from './common.js';

export const RT_DOSE_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.481.2';
const TOKEN = Symbol('owned-dose');

/** Native physical dose grid. Sampling is in the dose FoR, never registered implicitly. */
export class DoseGrid {
    #stored;
    constructor(token, geometry, samples) { if (token !== TOKEN) fail('use DoseGrid.fromInstance'); this.geometry = geometry; this.#stored = samples; this.disposed = false; }
    get bytes() { return this.disposed ? 0 : this.#stored.byteLength; }
    #active() { if (this.disposed) fail('dose grid is disposed'); }

    static async fromInstance(instance, { signal, maxBytes = MAX_SPECIALTY_BYTES } = {}) {
        checkSignal(signal); const set = dataSet(instance);
        if (text(set, '00080016') !== RT_DOSE_SOP_CLASS || text(set, '00080060') !== 'RTDOSE') fail('RT Dose Storage and modality are required');
        const rows = integer(scalar(set, '00280010'), 1, 8192), columns = integer(scalar(set, '00280011'), 1, 8192);
        const depth = integer(scalar(set, '00280008', { required: false }) ?? 1, 1, MAX_SPECIALTY_FRAMES), count = rows * columns * depth;
        const bits = scalar(set, '00280100');
        if (![16, 32].includes(bits) || scalar(set, '00280101') !== bits || scalar(set, '00280102') !== bits - 1 || scalar(set, '00280103') !== 0 ||
            scalar(set, '00280002') !== 1 || text(set, '00280004') !== 'MONOCHROME2' || text(set, '30040004') !== 'PHYSICAL') fail('only unsigned native16/32 PHYSICAL MONOCHROME2 dose is supported');
        const units = text(set, '30040002'), unitCodeSet = one(set, '30040020', { required: false });
        if (!['GY', 'RELATIVE'].includes(units)) fail('Dose Units must be explicit GY or RELATIVE');
        if (unitCodeSet) { const unit = code(unitCodeSet); if (units !== 'GY' || unit.scheme !== 'UCUM' || unit.value !== 'Gy') fail('dose unit code differs from the supported units'); }
        const scaling = scalar(set, '3004000E');
        if (scaling <= 0 || !Number.isFinite(scaling * (2 ** bits - 1))) fail('Dose Grid Scaling must be positive and finite across the stored range');
        const spatialTransform = text(set, '30040005', { required: false });
        if (spatialTransform != null && spatialTransform !== 'NONE') fail('spatially transformed dose requires an explicit registration implementation');
        rejectTags(set, ['00700404', '00283000', '00281052', '00281053', '00409096', '00280120', '00280121', '7FE00008', '7FE00009', '52009229', '52009230']);
        const firstPosition = vector(numbers(set, '00200032')), imageOrientation = numbers(set, '00200037'), basis = orientation(imageOrientation);
        const spacing = vector(numbers(set, '00280030'), 2);
        if (spacing.some(value => value <= 0 || value > 10000)) fail('positive dose Pixel Spacing is required');
        const declared = numbers(set, '3004000C', { required: depth > 1, maximum: MAX_SPECIALTY_FRAMES });
        if (declared.length && declared.length !== depth) fail('Grid Frame Offset Vector length differs from Number of Frames');
        const increment = pointer(set);
        if (depth > 1 && increment !== '3004000C' || increment != null && increment !== '3004000C') fail('dose Frame Increment Pointer must reference Grid Frame Offset Vector');
        let offsets = declared.length ? [...declared] : [0], offsetMode = 'relative';
        if (offsets[0] !== 0) {
            if (imageOrientation.some((value, index) => value !== [1, 0, 0, 0, 1, 0][index]) || offsets[0] !== firstPosition[2]) fail('absolute dose offsets require exact transverse orientation and first patient Z');
            offsets = offsets.map(value => value - firstPosition[2]); offsetMode = 'absolute-patient-z';
        }
        if (offsets.some(value => !Number.isFinite(value) || Math.abs(value) > 1e9)) fail('dose offsets are invalid');
        const direction = depth > 1 ? Math.sign(offsets[1] - offsets[0]) : 1;
        if (!direction || offsets.some((value, index) => index && (value - offsets[index - 1]) * direction <= 0)) fail('dose offsets must be strictly monotonic without duplicate planes');
        const sorted = offsets.map((offset, frameIndex) => ({ offset, frameIndex })).sort((a, b) => a.offset - b.offset);
        boundedOutput(count, bits / 8, maxBytes);
        if (count * bits / 8 + rows * columns * 8 > maxBytes) fail('dose storage and one derived plane exceed the working byte budget');
        const { littleEndian } = nativeSyntax(instance), raw = nativePixelBytes(set, count * bits / 8);
        const read = unsignedPixelReader(set, raw, bits, littleEndian), stored = bits === 16 ? new Uint16Array(count) : new Uint32Array(count);
        try {
            for (let start = 0; start < count; start += 65536) {
                checkSignal(signal); for (let index = start; index < Math.min(count, start + 65536); index++) stored[index] = read(index);
                if (start + 65536 < count) await yieldTask();
            }
            checkSignal(signal);
            return new DoseGrid(TOKEN, Object.freeze({ profile: 'native-physical-dose-v1', rows, columns, depth, bitsAllocated: bits, doseType: 'PHYSICAL', units, scaling,
                doseSummationType: text(set, '3004000A'), sopUid: uid(text(set, '00080018')), seriesUid: uid(text(set, '0020000E')),
                frameOfReferenceUid: uid(text(set, '00200052')), origin: frozenArray(firstPosition), orientation: frozenArray(imageOrientation),
                basisX: frozenArray(basis.x), basisY: frozenArray(basis.y), normal: frozenArray(basis.normal), pixelSpacing: frozenArray(spacing), offsetsMm: frozenArray(offsets),
                sortedOffsetsMm: frozenArray(sorted.map(entry => entry.offset)), sortedFrameIndices: frozenArray(sorted.map(entry => entry.frameIndex)), offsetMode }), stored);
        } catch (error) { stored.fill(0); throw error; }
    }
    storedAt(column, row, frameIndex) {
        this.#active(); const g = this.geometry;
        integer(column, 0, g.columns - 1); integer(row, 0, g.rows - 1); integer(frameIndex, 0, g.depth - 1);
        return this.#stored[(frameIndex * g.rows + row) * g.columns + column];
    }
    doseAt(column, row, frameIndex) { return this.storedAt(column, row, frameIndex) * this.geometry.scaling; }
    gridToPatient({ column, row, frameIndex }) {
        this.#active(); const g = this.geometry; integer(frameIndex, 0, g.depth - 1);
        if (![column, row].every(value => Number.isFinite(value) && Math.abs(value) <= 1e9)) fail('grid coordinates must be finite and bounded');
        return g.origin.map((value, axis) => value + g.basisX[axis] * column * g.pixelSpacing[1] + g.basisY[axis] * row * g.pixelSpacing[0] + g.normal[axis] * g.offsetsMm[frameIndex]);
    }
    patientToGrid(patient) {
        this.#active(); const g = this.geometry, displacement = subtract(vector(patient), g.origin);
        return { column: dot(displacement, g.basisX) / g.pixelSpacing[1], row: dot(displacement, g.basisY) / g.pixelSpacing[0], offsetMm: dot(displacement, g.normal) };
    }
    samplePatient(patient, { interpolation = 'trilinear', frameOfReferenceUid } = {}) {
        this.#active(); const g = this.geometry;
        if (!['nearest', 'trilinear'].includes(interpolation)) fail('dose interpolation is unsupported');
        if (frameOfReferenceUid != null && frameOfReferenceUid !== g.frameOfReferenceUid) fail('patient coordinates belong to a different Frame of Reference');
        let { column: x, row: y, offsetMm: z } = this.patientToGrid(patient);
        const offsets = g.sortedOffsetsMm, tolerance = 1e-8;
        if (x < -tolerance || y < -tolerance || x > g.columns - 1 + tolerance || y > g.rows - 1 + tolerance || z < offsets[0] - tolerance || z > offsets.at(-1) + tolerance) return NaN;
        x = Math.min(g.columns - 1, Math.max(0, x)); y = Math.min(g.rows - 1, Math.max(0, y)); z = Math.min(offsets.at(-1), Math.max(offsets[0], z));
        let lower = 0, high = offsets.length - 1;
        while (lower < high) { const middle = Math.ceil((lower + high) / 2); if (offsets[middle] <= z) lower = middle; else high = middle - 1; }
        const upper = Math.min(offsets.length - 1, lower + 1), fraction = upper === lower ? 0 : (z - offsets[lower]) / (offsets[upper] - offsets[lower]);
        if (interpolation === 'nearest') return this.doseAt(Math.round(x), Math.round(y), g.sortedFrameIndices[fraction > 0.5 ? upper : lower]);
        const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(g.columns - 1, x0 + 1), y1 = Math.min(g.rows - 1, y0 + 1), xf = x - x0, yf = y - y0;
        let result = 0;
        for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
            const weight = (dz ? fraction : 1 - fraction) * (dy ? yf : 1 - yf) * (dx ? xf : 1 - xf);
            if (weight) result += weight * this.doseAt(dx ? x1 : x0, dy ? y1 : y0, g.sortedFrameIndices[dz ? upper : lower]);
        }
        if (!Number.isFinite(result)) fail('sampled dose exceeds the numeric range'); return result;
    }
    async frameValues(frameIndex, { signal } = {}) {
        this.#active(); checkSignal(signal); integer(frameIndex, 0, this.geometry.depth - 1);
        const { rows, columns, scaling } = this.geometry, count = rows * columns, values = new Float64Array(count), offset = frameIndex * count;
        for (let start = 0; start < count; start += 65536) {
            this.#active(); checkSignal(signal); for (let index = start; index < Math.min(count, start + 65536); index++) values[index] = this.#stored[offset + index] * scaling;
            if (start + 65536 < count) await yieldTask();
        }
        this.#active(); checkSignal(signal); return { rows, columns, frameIndex, values, units: this.geometry.units, bytes: values.byteLength };
    }
    dispose() { if (this.disposed) return; this.#stored = null; this.disposed = true; }
}
