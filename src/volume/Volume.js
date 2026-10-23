import { evaluateModality } from '../data/presentation-math.js';
import { MAX_VOLUME_BYTES, validateVolumeGeometry, frameGeometry, compatibleFrameScope, voxelToPatient, patientToVoxel, vector, checkSignal, reconstructionError } from './geometry.js';

export const yieldReconstruction = () => new Promise(resolve => setTimeout(resolve, 0));
const CONSTRUCTION = Symbol('owned-volume');
function observe(callback, event) {
    try { const result = callback?.(event); if (result?.then) Promise.resolve(result).catch(() => {}); } catch {}
}
function awaitFrame(request, signal) {
    checkSignal(signal);
    if (!signal) return Promise.resolve(request());
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true; signal.removeEventListener('abort', aborted); callback(value);
        };
        const aborted = () => finish(reject, new DOMException('Reconstruction was canceled.', 'AbortError'));
        signal.addEventListener('abort', aborted, { once: true });
        try { Promise.resolve(request()).then(frame => finish(resolve, frame), error => finish(reject, error)); }
        catch (error) { finish(reject, error); }
        if (signal.aborted) aborted();
    });
}
function scalarProfile(frame, metadataOnly = false, tables) {
    const lut = frame.modalityLut;
    if (lut && (!Number.isInteger(lut.count) || lut.count < 1 || lut.count > 65536 || ![8, 16].includes(lut.bits) || !Number.isSafeInteger(lut.firstMapped) ||
        (metadataOnly && lut.pending ? lut.entries != null : lut.pending || !(lut.entries instanceof Uint16Array) || lut.entries.length !== lut.count))) {
        throw reconstructionError('a complete, validated modality LUT is required');
    }
    if (lut && !lut.pending && tables?.get(lut.entries) !== lut.bits) {
        if (lut.bits === 8 && lut.entries.some(value => value > 255)) throw reconstructionError('modality LUT entries exceed declared precision');
        tables?.set(lut.entries, lut.bits);
    }
    const slope = frame.slope ?? 1, intercept = frame.intercept ?? 0;
    if (!Number.isFinite(slope) || slope === 0 || !Number.isFinite(intercept)) throw reconstructionError('rescale is invalid');
    if (lut && (slope !== 1 || intercept !== 0)) throw reconstructionError('modality LUT conflicts with rescale');
    const padding = frame.padding;
    if (padding != null && (!Number.isSafeInteger(padding.value) || !Number.isSafeInteger(padding.limit))) throw reconstructionError('pixel padding range is invalid');
    return { slope, intercept, lut, padding: padding ? [Math.min(padding.value, padding.limit), Math.max(padding.value, padding.limit)] : null };
}
function samePresentation(a, actual, tables) {
    const b = scalarProfile(actual, false, tables);
    if (a.slope !== b.slope || a.intercept !== b.intercept || JSON.stringify(a.padding) !== JSON.stringify(b.padding) || Boolean(a.lut) !== Boolean(b.lut)) return false;
    if (!a.lut) return true;
    return ['count', 'firstMapped', 'bits'].every(key => a.lut[key] === b.lut[key]) &&
        (a.lut.pending || a.lut.entries === b.lut.entries || a.lut.entries.every((value, index) => value === b.lut.entries[index]));
}

/** Owned stored samples, separate Float64 modality values, and padding validity. */
export class Volume {
    constructor(token, geometry) {
        if (token !== CONSTRUCTION) throw new TypeError('Use Volume.fromSeries to construct a validated volume.');
        this.geometry = geometry;
        this.storedSamples = geometry.signed ? new Int16Array(geometry.voxelCount) : new Uint16Array(geometry.voxelCount);
        this.modalityValues = new Float64Array(geometry.voxelCount);
        this.modalityValues.fill(NaN);
        this.valid = new Uint8Array(geometry.voxelCount);
        this.disposed = false;
    }
    get bytes() { return this.disposed ? 0 : this.storedSamples.byteLength + this.modalityValues.byteLength + this.valid.byteLength; }
    _assertActive() { if (this.disposed) throw reconstructionError('volume is disposed'); }

    static async fromSeries(series, { signal, getFrame, onProgress, maxBytes = MAX_VOLUME_BYTES } = {}) {
        checkSignal(signal);
        if (!series || getFrame != null && typeof getFrame !== 'function' || onProgress != null && typeof onProgress !== 'function' ||
            getFrame == null && typeof series.getFrame !== 'function') throw reconstructionError('a series frame provider is required');
        const sourceFrames = series.frames, geometry = validateVolumeGeometry(sourceFrames, { maxBytes });
        // Snapshot small descriptors before yielding. Host navigation/mutation
        // cannot redefine the affine after its validation. No decoded frames are held.
        const tables = new WeakMap();
        const descriptors = geometry.sourceIndices.map(index => ({ index, metadata: frameGeometry(sourceFrames[index]),
            presentation: scalarProfile(sourceFrames[index], true, tables) }));
        checkSignal(signal);
        const volume = new Volume(CONSTRUCTION, geometry), count = geometry.rows * geometry.columns;
        let actualFamily = null, actualSemanticScope = null;
        try {
            for (let slice = 0; slice < geometry.depth; slice++) {
                checkSignal(signal);
                const { index, metadata, presentation } = descriptors[slice];
                let frame = await awaitFrame(() => getFrame ? getFrame(index, { signal }) : series.getFrame(index, { signal }), signal);
                checkSignal(signal);
                const actual = frameGeometry(frame);
                if (actual.pixelSignature !== metadata.pixelSignature || !compatibleFrameScope(metadata.scope, actual.scope) ||
                    actual.sopUid !== metadata.sopUid || actual.frameIndex !== metadata.frameIndex ||
                    [...actual.position, ...actual.x, ...actual.y, ...actual.spacing].some((value, component) =>
                        Math.abs(value - [...metadata.position, ...metadata.x, ...metadata.y, ...metadata.spacing][component]) > 0.00001) ||
                    !samePresentation(presentation, frame, tables)) throw reconstructionError('retrieved frame identity, geometry or modality transform differs from its descriptor');
                if (actualFamily != null && actualFamily !== actual.scope.key) throw reconstructionError('retrieved frames reveal different temporal, echo or acquisition families');
                actualFamily = actual.scope.key;
                actualSemanticScope = actualSemanticScope == null ? actual.scope.semanticScope :
                    actualSemanticScope === actual.scope.semanticScope ? actualSemanticScope : 'same-series-only';
                if (actual.declaredSpacing != null && Math.abs(actual.declaredSpacing - geometry.sliceDistanceMm) > Math.max(0.0001, geometry.sliceDistanceMm * 0.001)) {
                    throw reconstructionError('retrieved slice spacing differs from the supplied lattice');
                }
                if (!(frame.samples instanceof Uint8Array || frame.samples instanceof Uint16Array || frame.samples instanceof Int16Array) ||
                    frame.samples.length !== count || geometry.signed !== (frame.samples instanceof Int16Array)) {
                    throw reconstructionError('retrieved scalar samples do not match the volume profile');
                }
                const profile = scalarProfile(frame, false, tables), minimum = geometry.signed ? -(2 ** (geometry.bitsStored - 1)) : 0;
                const maximum = geometry.signed ? 2 ** (geometry.bitsStored - 1) - 1 : 2 ** geometry.bitsStored - 1;
                const offset = slice * count;
                for (let start = 0; start < count; start += 65536) {
                    checkSignal(signal);
                    const end = Math.min(count, start + 65536);
                    for (let pixel = start; pixel < end; pixel++) {
                        const stored = frame.samples[pixel];
                        if (stored < minimum || stored > maximum) throw reconstructionError('stored sample exceeds Bits Stored');
                        volume.storedSamples[offset + pixel] = stored;
                        if (profile.padding && stored >= profile.padding[0] && stored <= profile.padding[1]) continue;
                        volume.modalityValues[offset + pixel] = evaluateModality(stored, frame);
                        volume.valid[offset + pixel] = 1;
                    }
                    if (end < count) { await yieldReconstruction(); checkSignal(signal); }
                }
                frame = null; // Do not retain decoded frames or their presentation tables.
                observe(onProgress, { completed: slice + 1, total: geometry.depth, bytes: volume.bytes });
                await yieldReconstruction(); checkSignal(signal);
            }
            volume.geometry = Object.freeze({ ...geometry, semanticScope: actualSemanticScope });
            return volume;
        } catch (error) { volume.dispose(); throw error; }
    }

    voxelToPatient(voxel) { this._assertActive(); return voxelToPatient(this.geometry, voxel); }
    patientToVoxel(patient) { this._assertActive(); return patientToVoxel(this.geometry, patient); }
    storedAt(x, y, z) {
        this._assertActive();
        if (![x, y, z].every(Number.isInteger) || x < 0 || y < 0 || z < 0 || x >= this.geometry.columns || y >= this.geometry.rows || z >= this.geometry.depth) {
            throw reconstructionError('stored voxel index is outside the volume');
        }
        return this.storedSamples[(z * this.geometry.rows + y) * this.geometry.columns + x];
    }
    sampleVoxel(voxel, { interpolation = 'trilinear', domain = 'modality' } = {}) {
        this._assertActive();
        let [x, y, z] = vector(voxel);
        const g = this.geometry;
        if (!['nearest', 'trilinear'].includes(interpolation) || !['stored', 'modality'].includes(domain)) throw reconstructionError('sampling mode is unsupported');
        // No edge extrapolation or renormalization across padding holes.
        if (x < -1e-8 || y < -1e-8 || z < -1e-8 || x > g.columns - 1 + 1e-8 || y > g.rows - 1 + 1e-8 || z > g.depth - 1 + 1e-8) return NaN;
        x = Math.max(0, Math.min(g.columns - 1, x)); y = Math.max(0, Math.min(g.rows - 1, y)); z = Math.max(0, Math.min(g.depth - 1, z));
        const values = domain === 'stored' ? this.storedSamples : this.modalityValues;
        if (interpolation === 'nearest') {
            const index = (Math.round(z) * g.rows + Math.round(y)) * g.columns + Math.round(x);
            return this.valid[index] ? values[index] : NaN;
        }
        const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z), x1 = Math.min(g.columns - 1, x0 + 1),
            y1 = Math.min(g.rows - 1, y0 + 1), z1 = Math.min(g.depth - 1, z0 + 1), xf = x - x0, yf = y - y0, zf = z - z0;
        let value = 0;
        for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
            const weight = (dx ? xf : 1 - xf) * (dy ? yf : 1 - yf) * (dz ? zf : 1 - zf);
            if (!weight) continue;
            const index = ((dz ? z1 : z0) * g.rows + (dy ? y1 : y0)) * g.columns + (dx ? x1 : x0);
            if (!this.valid[index]) return NaN;
            value += values[index] * weight;
        }
        if (!Number.isFinite(value)) throw reconstructionError('interpolated value exceeds numeric range');
        return value;
    }
    samplePatient(patient, options) { return this.sampleVoxel(this.patientToVoxel(patient), options); }
    dispose() {
        if (this.disposed) return;
        this.storedSamples = null; this.modalityValues = null; this.valid = null; this.disposed = true;
    }
}
