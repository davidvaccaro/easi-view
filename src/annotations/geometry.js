export const ANNOTATION_TOOLS = Object.freeze(['length', 'angle', 'rectangle', 'ellipse', 'polygon']);
export const MAX_POLYGON_POINTS = 128;
export const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;
const EPSILON = 1e-9;

export function annotationError(message) { return new Error(`Invalid annotation: ${message}.`); }
export function plainObject(value) {
    return value != null && typeof value === 'object' &&
        (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
export function exactKeys(value, allowed) {
    if (!plainObject(value) || Object.keys(value).some(key => !allowed.includes(key))) throw annotationError('unsupported fields or object shape');
}
export function imageDimensions(image) {
    if (!Number.isSafeInteger(image?.rows) || !Number.isSafeInteger(image?.columns) ||
        image.rows < 1 || image.columns < 1 || image.rows > 8192 || image.columns > 8192 || image.rows * image.columns > MAX_IMAGE_PIXELS) {
        throw annotationError('unsupported image dimensions');
    }
    return { rows: image.rows, columns: image.columns };
}
function point(value, dimensions) {
    exactKeys(value, ['x', 'y']);
    if (!Number.isFinite(value.x) || !Number.isFinite(value.y) || value.x < 0 || value.y < 0 ||
        value.x > dimensions.columns || value.y > dimensions.rows) throw annotationError('point is outside the image');
    return { x: value.x === 0 ? 0 : value.x, y: value.y === 0 ? 0 : value.y };
}
function cross(a, b, c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }
function onSegment(a, b, p) {
    return Math.abs(cross(a, b, p)) <= EPSILON && p.x >= Math.min(a.x, b.x) - EPSILON && p.x <= Math.max(a.x, b.x) + EPSILON &&
        p.y >= Math.min(a.y, b.y) - EPSILON && p.y <= Math.max(a.y, b.y) + EPSILON;
}
function intersects(a, b, c, d) {
    const first = cross(a, b, c), second = cross(a, b, d), third = cross(c, d, a), fourth = cross(c, d, b);
    return (first > EPSILON && second < -EPSILON || first < -EPSILON && second > EPSILON) &&
        (third > EPSILON && fourth < -EPSILON || third < -EPSILON && fourth > EPSILON) ||
        onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}
export function polygonArea(points) {
    let twice = 0;
    for (let index = 0; index < points.length; index++) {
        const next = points[(index + 1) % points.length];
        twice += points[index].x * next.y - next.x * points[index].y;
    }
    return Math.abs(twice) / 2;
}

/** Continuous image-edge coordinates: a pixel center is (column+.5,row+.5). */
export function validateShape(tool, rawPoints, image) {
    const dimensions = imageDimensions(image);
    if (!ANNOTATION_TOOLS.includes(tool) || !Array.isArray(rawPoints) ||
        (tool === 'polygon' ? rawPoints.length < 3 || rawPoints.length > MAX_POLYGON_POINTS : rawPoints.length !== (tool === 'angle' ? 3 : 2))) {
        throw annotationError('tool or point count is unsupported');
    }
    const points = rawPoints.map(value => point(value, dimensions));
    for (let first = 0; first < points.length; first++) for (let second = first + 1; second < points.length; second++) {
        if (Math.hypot(points[first].x - points[second].x, points[first].y - points[second].y) <= EPSILON) throw annotationError('duplicate or degenerate points');
    }
    if (['rectangle', 'ellipse'].includes(tool) &&
        (Math.abs(points[1].x - points[0].x) <= EPSILON || Math.abs(points[1].y - points[0].y) <= EPSILON)) {
        throw annotationError('ROI width and height must be positive');
    }
    if (tool === 'polygon') {
        if (polygonArea(points) <= EPSILON) throw annotationError('polygon area is degenerate');
        for (let first = 0; first < points.length; first++) {
            const previous = points[(first + points.length - 1) % points.length], current = points[first], next = points[(first + 1) % points.length];
            if (Math.abs(cross(previous, current, next)) <= EPSILON &&
                (previous.x - current.x) * (next.x - current.x) + (previous.y - current.y) * (next.y - current.y) > 0) {
                throw annotationError('polygon adjacent edges overlap');
            }
            for (let second = first + 1; second < points.length; second++) {
                if (second === first + 1 || first === 0 && second === points.length - 1) continue;
                if (intersects(points[first], points[(first + 1) % points.length], points[second], points[(second + 1) % points.length])) {
                    throw annotationError('polygon edges intersect or touch');
                }
            }
        }
    }
    return points;
}

export function calibration(frame) {
    const spacing = frame.pixelSpacing;
    if (spacing == null) return { calibrated: false, source: 'pixel-grid', rowSpacing: 1, columnSpacing: 1, lengthUnit: 'px', areaUnit: 'px2' };
    if (!Array.isArray(spacing) || spacing.length !== 2 || spacing.some(value => !Number.isFinite(value) || value <= 0)) {
        throw annotationError('Pixel Spacing must contain positive row and column distances');
    }
    return { calibrated: true, source: 'dicom-pixel-spacing', rowSpacing: spacing[0], columnSpacing: spacing[1], lengthUnit: 'mm', areaUnit: 'mm2' };
}
export function bounds(points) {
    return { minX: Math.min(...points.map(p => p.x)), minY: Math.min(...points.map(p => p.y)),
        maxX: Math.max(...points.map(p => p.x)), maxY: Math.max(...points.map(p => p.y)) };
}

export function measureGeometry(tool, rawPoints, frame) {
    const points = validateShape(tool, rawPoints, frame), scale = calibration(frame);
    if (tool === 'length') {
        const length = Math.hypot((points[1].x - points[0].x) * scale.columnSpacing, (points[1].y - points[0].y) * scale.rowSpacing);
        if (!Number.isFinite(length)) throw annotationError('measurement exceeds the numeric range');
        return { kind: 'length', value: length, unit: scale.lengthUnit, calibrated: scale.calibrated, calibrationSource: scale.source };
    }
    if (tool === 'angle') {
        const a = [(points[0].x - points[1].x) * scale.columnSpacing, (points[0].y - points[1].y) * scale.rowSpacing];
        const b = [(points[2].x - points[1].x) * scale.columnSpacing, (points[2].y - points[1].y) * scale.rowSpacing];
        const aLength = Math.hypot(...a), bLength = Math.hypot(...b);
        if (!Number.isFinite(aLength) || !Number.isFinite(bLength) || !aLength || !bLength) throw annotationError('angle arms are degenerate');
        const cosine = a[0] / aLength * (b[0] / bLength) + a[1] / aLength * (b[1] / bLength);
        return { kind: 'angle', value: Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI,
            unit: 'deg', calibrated: scale.calibrated, calibrationSource: scale.source };
    }
    const box = bounds(points);
    const areaPixels = tool === 'polygon' ? polygonArea(points) : (box.maxX - box.minX) * (box.maxY - box.minY) * (tool === 'ellipse' ? Math.PI / 4 : 1);
    const area = areaPixels * scale.rowSpacing * scale.columnSpacing;
    if (!Number.isFinite(area)) throw annotationError('measurement exceeds the numeric range');
    return { kind: 'area', value: area, unit: scale.areaUnit, calibrated: scale.calibrated,
        calibrationSource: scale.source, pixelArea: areaPixels, bounds: box };
}

function patientGeometry(frame) {
    if (!Array.isArray(frame.orientation) || frame.orientation.length !== 6 || !Array.isArray(frame.position) || frame.position.length !== 3 ||
        ![...frame.orientation, ...frame.position].every(Number.isFinite) || frame.pixelSpacing == null) return null;
    const scale = calibration(frame), x = frame.orientation.slice(0, 3), y = frame.orientation.slice(3);
    const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
    if (Math.abs(Math.hypot(...x) - 1) > 0.001 || Math.abs(Math.hypot(...y) - 1) > 0.001 || Math.abs(dot(x, y)) > 0.001) {
        throw annotationError('patient orientation must be orthonormal');
    }
    return { scale, x, y, dot };
}

export function imageToPatient(point, frame) {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) throw annotationError('image coordinate must be finite');
    const geometry = patientGeometry(frame);
    if (!geometry) return null;
    const result = frame.position.map((value, index) => value + geometry.x[index] * (point.x - 0.5) * geometry.scale.columnSpacing +
        geometry.y[index] * (point.y - 0.5) * geometry.scale.rowSpacing);
    if (!result.every(Number.isFinite)) throw annotationError('patient coordinate exceeds the numeric range');
    return result;
}

export function patientToImage(patient, frame, { planeToleranceMm = 0.01 } = {}) {
    if (!Array.isArray(patient) || patient.length !== 3 || !patient.every(Number.isFinite) || !Number.isFinite(planeToleranceMm) || planeToleranceMm < 0) {
        throw annotationError('patient coordinate or plane tolerance is invalid');
    }
    const geometry = patientGeometry(frame);
    if (!geometry) return null;
    const delta = patient.map((value, index) => value - frame.position[index]);
    const normal = [geometry.x[1] * geometry.y[2] - geometry.x[2] * geometry.y[1],
        geometry.x[2] * geometry.y[0] - geometry.x[0] * geometry.y[2], geometry.x[0] * geometry.y[1] - geometry.x[1] * geometry.y[0]];
    const distanceMm = geometry.dot(delta, normal) / Math.hypot(...normal);
    if (!Number.isFinite(distanceMm)) throw annotationError('patient coordinate exceeds the numeric range');
    if (Math.abs(distanceMm) > planeToleranceMm) return null;
    // A Gram solve preserves inverses for valid rounded direction cosines.
    const xx = geometry.dot(geometry.x, geometry.x), yy = geometry.dot(geometry.y, geometry.y), xy = geometry.dot(geometry.x, geometry.y);
    const a = geometry.dot(delta, geometry.x), b = geometry.dot(delta, geometry.y), determinant = xx * yy - xy * xy;
    const x = (a * yy - b * xy) / determinant / geometry.scale.columnSpacing + 0.5;
    const y = (b * xx - a * xy) / determinant / geometry.scale.rowSpacing + 0.5;
    if (![x, y].every(Number.isFinite)) throw annotationError('image coordinate exceeds the numeric range');
    return { x, y, distanceMm };
}

/** Versioned equality hint, not a security hash or a replacement for SOP/frame scope. */
export function geometryFingerprint(frame) {
    const dimensions = imageDimensions(frame), spacing = frame.pixelSpacing == null ? null : calibration(frame);
    const vector = (value, count) => {
        if (value == null) return null;
        if (!Array.isArray(value) || value.length !== count || !value.every(Number.isFinite)) throw annotationError('geometry vector is invalid');
        return value.map(component => component === 0 ? 0 : component);
    };
    const canonical = JSON.stringify([dimensions.rows, dimensions.columns, spacing ? [spacing.rowSpacing, spacing.columnSpacing] : null,
        vector(frame.orientation, 6), vector(frame.position, 3)]);
    let hash = 2166136261;
    for (let index = 0; index < canonical.length; index++) hash = Math.imul(hash ^ canonical.charCodeAt(index), 16777619);
    return `g1-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
