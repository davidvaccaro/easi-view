// Independent analytic patient-space field: f(p)=2*p.x+4*p.y+3*p.z.
// x=[0,3,0], y=[-2,0,0], z=[1,1,4]; origin=[10,20,30].
export function createVolumeSeries({ order = [1, 2, 0], rows = 3, columns = 4, depth = 3, signed = false,
    slopes = null, intercepts = null, padding = null, field = null, origin = [10, 20, 30],
    basisZ = [1, 1, 4], orientation = [0, 1, 0, -1, 0, 0], pixelSpacing = [2, 3], frameOfReferenceUid = '1.2.9', unit = 'HU' } = {}) {
    if (order.length !== depth) order = Array.from({ length: depth }, (_, index) => index);
    const all = Array.from({ length: depth }, (_, z) => {
        const position = origin.map((value, axis) => value + basisZ[axis] * z);
        const samples = signed ? new Int16Array(rows * columns) : new Uint16Array(rows * columns);
        for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
            const p = position.map((value, axis) => value + orientation[axis] * x * pixelSpacing[1] + orientation[axis + 3] * y * pixelSpacing[0]);
            samples[y * columns + x] = field ? field(x, y, z, p) : 2 * p[0] + 4 * p[1] + 3 * p[2];
        }
        return { rows, columns, bitsAllocated: 16, bitsStored: 16, highBit: 15, signed, photometric: 'MONOCHROME2', samplesPerPixel: 1,
            sopUid: `1.2.3.${100 + z}`, seriesUid: '1.2.3', frameOfReferenceUid, modality: 'CT', unit, frameIndex: 0,
            position, orientation: [...orientation], pixelSpacing: [...pixelSpacing], slope: slopes?.[z] ?? 1, intercept: intercepts?.[z] ?? 0,
            padding, samples };
    });
    const frames = order.map(index => { const { samples, ...metadata } = all[index]; return structuredClone(metadata); });
    const requests = [];
    return { frames, requests, actual: order.map(index => all[index]),
        async getFrame(index, { signal } = {}) { requests.push({ index, signal }); return this.actual[index]; } };
}
export function createAxialSeries(options = {}) {
    return createVolumeSeries({ rows: 2, columns: 2, depth: 3, order: [0, 1, 2],
        origin: [0, 0, 0], orientation: [1, 0, 0, 0, 1, 0], pixelSpacing: [1, 1], basisZ: [0, 0, 1],
        field: (x, y, z) => x + 10 * y + 100 * z, ...options });
}
export const identityRegistration = { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
