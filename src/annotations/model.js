import { annotationError, exactKeys, imageDimensions, validateShape, geometryFingerprint } from './geometry.js';

function uid(value) {
    if (typeof value !== 'string' || value.length > 64 || !/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*$/.test(value)) throw annotationError('a valid DICOM UID is required');
    return value;
}

// Some local files retain non-significant leading zeroes in their Series UID.
// Keep that exact source spelling for annotation matching; do not repair UIDs.
function seriesReference(value) {
    if (typeof value !== 'string' || value.length > 64 || !/^[0-9]+(?:\.[0-9]+)*(?![\s\S])/u.test(value)) {
        throw annotationError('a bounded numeric source Series Instance UID reference is required');
    }
    return value;
}
export function annotationId(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)) throw annotationError('annotation id is invalid');
    return value;
}

export function normalizeImageReference(image) {
    exactKeys(image, ['sopUid', 'frameNumber', 'rows', 'columns', 'seriesUid', 'frameOfReferenceUid', 'geometryFingerprint']);
    const dimensions = imageDimensions(image);
    if (!Number.isSafeInteger(image.frameNumber) || image.frameNumber < 1 || image.frameNumber > 4096) throw annotationError('original frame number must be one-based');
    const result = { sopUid: uid(image.sopUid), frameNumber: image.frameNumber, ...dimensions };
    if (Object.hasOwn(image, 'seriesUid')) result.seriesUid = seriesReference(image.seriesUid);
    if (Object.hasOwn(image, 'frameOfReferenceUid')) result.frameOfReferenceUid = uid(image.frameOfReferenceUid);
    if (Object.hasOwn(image, 'geometryFingerprint')) {
        if (typeof image.geometryFingerprint !== 'string' || !/^g1-[0-9a-f]{8}$/.test(image.geometryFingerprint)) throw annotationError('geometry fingerprint is invalid');
        result.geometryFingerprint = image.geometryFingerprint;
    }
    return result;
}

export function createImageReference(frame, options = {}) {
    exactKeys(options, ['sopUid', 'seriesUid', 'frameOfReferenceUid', 'frameNumber', 'includeGeometryFingerprint']);
    if (options.includeGeometryFingerprint != null && typeof options.includeGeometryFingerprint !== 'boolean') throw annotationError('fingerprint option must be boolean');
    if (!Number.isSafeInteger(frame?.frameIndex) || frame.frameIndex < 0 || frame.frameIndex >= 4096) throw annotationError('an original zero-based frameIndex is required');
    if (options.frameNumber != null && options.frameNumber !== frame.frameIndex + 1) throw annotationError('frame number conflicts with original frameIndex');
    for (const key of ['sopUid', 'seriesUid', 'frameOfReferenceUid']) {
        if (options[key] != null && frame[key] != null && options[key] !== frame[key]) throw annotationError('reference UID conflicts with the source frame');
    }
    const image = { sopUid: options.sopUid ?? frame.sopUid, frameNumber: frame.frameIndex + 1, rows: frame.rows, columns: frame.columns };
    for (const key of ['seriesUid', 'frameOfReferenceUid']) if (options[key] ?? frame[key]) image[key] = options[key] ?? frame[key];
    if (options.includeGeometryFingerprint !== false) image.geometryFingerprint = geometryFingerprint(frame);
    return normalizeImageReference(image);
}

export function imageKey(image) { return `${image.sopUid}/${image.frameNumber}`; }

export function compatibleImageReferences(first, second) {
    if (imageKey(first) !== imageKey(second) || first.rows !== second.rows || first.columns !== second.columns) return false;
    return ['seriesUid', 'frameOfReferenceUid', 'geometryFingerprint'].every(key => first[key] == null || second[key] == null || first[key] === second[key]);
}

export function normalizeAnnotation(input) {
    exactKeys(input, ['id', 'tool', 'image', 'points']);
    const image = normalizeImageReference(input.image);
    const points = validateShape(input.tool, input.points, image);
    return { id: annotationId(input.id), tool: input.tool, image, points };
}

export function assertAnnotationFrame(annotation, frame) {
    const actual = createImageReference(frame, { includeGeometryFingerprint: annotation.image.geometryFingerprint != null });
    if (!compatibleImageReferences(annotation.image, actual) ||
        ['seriesUid', 'frameOfReferenceUid', 'geometryFingerprint'].some(key => annotation.image[key] != null && annotation.image[key] !== actual[key])) {
        throw annotationError('annotation does not belong to this SOP, original frame or geometry');
    }
}

export function annotationHandles(annotation) {
    const normalized = normalizeAnnotation(annotation);
    return normalized.points.map((point, index) => ({ index, ...point }));
}

export function moveAnnotationHandle(annotation, index, point) {
    const normalized = normalizeAnnotation(annotation);
    if (!Number.isInteger(index) || index < 0 || index >= normalized.points.length) throw annotationError('handle index is invalid');
    normalized.points[index] = point;
    return normalizeAnnotation(normalized);
}

export function translateAnnotation(annotation, dx, dy) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw annotationError('translation must be finite');
    const normalized = normalizeAnnotation(annotation);
    return normalizeAnnotation({ ...normalized, points: normalized.points.map(point => ({ x: point.x + dx, y: point.y + dy })) });
}
