import { evaluateModality } from '../data/presentation-math.js';
import { annotationError, imageDimensions, validateShape, bounds, calibration, measureGeometry, MAX_POLYGON_POINTS } from './geometry.js';
import { normalizeAnnotation, assertAnnotationFrame } from './model.js';

const EPSILON = 1e-9;
const ROIS = new Set(['rectangle', 'ellipse', 'polygon']);

class Moments {
    constructor() { this.count = 0; this.mean = 0; this.m2 = 0; this.min = Infinity; this.max = -Infinity; }
    add(value) {
        this.count++;
        const delta = value - this.mean;
        this.mean += delta / this.count;
        this.m2 += delta * (value - this.mean);
        this.min = Math.min(this.min, value); this.max = Math.max(this.max, value);
        if (![this.mean, this.m2].every(Number.isFinite)) throw annotationError('ROI statistics exceed the numeric range');
    }
    snapshot() {
        return { count: this.count, mean: this.count ? this.mean : null,
            stdDev: this.count ? Math.sqrt(Math.max(0, this.m2 / this.count)) : null,
            min: this.count ? this.min : null, max: this.count ? this.max : null };
    }
}

function paddingRange(frame) {
    if (frame.padding == null) return null;
    const { value, limit = value } = frame.padding;
    if (!Number.isFinite(value) || !Number.isFinite(limit)) throw annotationError('pixel padding metadata is invalid');
    return { min: Math.min(value, limit), max: Math.max(value, limit) };
}

/** Iterate included pixel centers without allocating a raster mask or copied ROI. */
function visitRoi(tool, points, frame, visit) {
    const box = bounds(points);
    const firstRow = Math.max(0, Math.ceil(box.minY - 0.5 - EPSILON));
    const lastRow = Math.min(frame.rows - 1, Math.floor(box.maxY - 0.5 + EPSILON));
    const visitSpan = (row, left, right) => {
        const first = Math.max(0, Math.ceil(left - 0.5 - EPSILON));
        const last = Math.min(frame.columns - 1, Math.floor(right - 0.5 + EPSILON));
        for (let column = first; column <= last; column++) visit(row * frame.columns + column);
    };
    if (tool === 'rectangle') {
        for (let row = firstRow; row <= lastRow; row++) visitSpan(row, box.minX, box.maxX);
        return;
    }
    if (tool === 'ellipse') {
        const cx = (box.minX + box.maxX) / 2, cy = (box.minY + box.maxY) / 2;
        const rx = (box.maxX - box.minX) / 2, ry = (box.maxY - box.minY) / 2;
        for (let row = firstRow; row <= lastRow; row++) {
            const dy = (row + 0.5 - cy) / ry;
            if (dy * dy > 1 + EPSILON) continue;
            const dx = rx * Math.sqrt(Math.max(0, 1 - dy * dy));
            visitSpan(row, cx - dx, cx + dx);
        }
        return;
    }
    // Bounded scanline scratch storage depends only on vertex count (<=128),
    // never on ROI/image area. Half-open crossings handle vertex parity; closed
    // horizontal edges/vertices are merged as boundary spans without duplicates.
    const crossings = new Float64Array(MAX_POLYGON_POINTS);
    const spans = new Float64Array(MAX_POLYGON_POINTS * 6);
    for (let row = firstRow; row <= lastRow; row++) {
        const y = row + 0.5;
        let crossingCount = 0, spanCount = 0;
        const addSpan = (left, right) => { spans[spanCount * 2] = left; spans[spanCount * 2 + 1] = right; spanCount++; };
        for (let index = 0; index < points.length; index++) {
            const a = points[index], b = points[(index + 1) % points.length];
            if (Math.abs(a.y - y) <= EPSILON) addSpan(a.x, a.x);
            if (Math.abs(a.y - b.y) <= EPSILON) {
                if (Math.abs(a.y - y) <= EPSILON) addSpan(Math.min(a.x, b.x), Math.max(a.x, b.x));
            } else if ((a.y > y) !== (b.y > y)) crossings[crossingCount++] = a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y);
        }
        if (crossingCount % 2) throw annotationError('polygon scanline has ambiguous crossings');
        crossings.subarray(0, crossingCount).sort();
        for (let index = 0; index < crossingCount; index += 2) addSpan(crossings[index], crossings[index + 1]);
        for (let index = 1; index < spanCount; index++) {
            const left = spans[index * 2], right = spans[index * 2 + 1];
            let position = index;
            while (position > 0 && spans[(position - 1) * 2] > left) {
                spans[position * 2] = spans[(position - 1) * 2]; spans[position * 2 + 1] = spans[(position - 1) * 2 + 1]; position--;
            }
            spans[position * 2] = left; spans[position * 2 + 1] = right;
        }
        let left = null, right = null;
        for (let index = 0; index < spanCount; index++) {
            if (left === null) { left = spans[index * 2]; right = spans[index * 2 + 1]; }
            else if (spans[index * 2] <= right + EPSILON) right = Math.max(right, spans[index * 2 + 1]);
            else { visitSpan(row, left, right); left = spans[index * 2]; right = spans[index * 2 + 1]; }
        }
        if (left !== null) visitSpan(row, left, right);
    }
}

/** Population statistics over original stored/modality values; display VOI never participates. */
export function roiStatistics(tool, rawPoints, frame) {
    imageDimensions(frame);
    if (!ROIS.has(tool)) throw annotationError('statistics require a closed ROI tool');
    const points = validateShape(tool, rawPoints, frame);
    const samples = frame.samples;
    const color = ['RGB', 'PALETTE COLOR'].includes(frame.photometric);
    if (!['MONOCHROME1', 'MONOCHROME2', 'RGB', 'PALETTE COLOR'].includes(frame.photometric) ||
        !(samples instanceof Int16Array || samples instanceof Uint16Array || samples instanceof Uint8Array) ||
        samples.length !== frame.rows * frame.columns * (frame.photometric === 'RGB' ? 3 : 1)) {
        throw annotationError('original pixel samples do not match the image profile');
    }
    const padding = paddingRange(frame), stored = new Moments(), modality = new Moments();
    let sampledPixelCount = 0, excludedPadding = 0, pixelCount = 0;
    visitRoi(tool, points, frame, index => {
        sampledPixelCount++;
        const value = samples[index];
        if (frame.photometric !== 'RGB' && padding && value >= padding.min && value <= padding.max) { excludedPadding++; return; }
        pixelCount++;
        if (color) return;
        stored.add(value); modality.add(evaluateModality(value, frame));
    });
    const scale = calibration(frame);
    const sampledArea = pixelCount * scale.rowSpacing * scale.columnSpacing;
    if (!Number.isFinite(sampledArea)) throw annotationError('sampled area exceeds the numeric range');
    return { status: color ? 'color-intensity-unavailable' : pixelCount ? 'ok' : 'empty',
        representation: frame.photometric === 'RGB' ? 'RGB' : frame.photometric === 'PALETTE COLOR' ? 'palette' : 'scalar',
        pixelCount, sampledPixelCount, excludedPadding, sampledArea, areaUnit: scale.areaUnit,
        stored: color ? null : stored.snapshot(), modality: color ? null : modality.snapshot(),
        unit: color ? null : frame.unit ?? '', varianceDefinition: 'population' };
}

export function measureAnnotation(input, frame, { statistics = true } = {}) {
    if (typeof statistics !== 'boolean') throw annotationError('statistics option must be boolean');
    const annotation = normalizeAnnotation(input);
    assertAnnotationFrame(annotation, frame);
    return { id: annotation.id, geometry: measureGeometry(annotation.tool, annotation.points, frame),
        statistics: statistics && ROIS.has(annotation.tool) ? roiStatistics(annotation.tool, annotation.points, frame) : null };
}
