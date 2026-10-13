import { validPixelSpacing } from './DisplayMath.js';

/** Shared affine transform keeps renderer, probes, and measurement overlays aligned. */
export function createImageTransform(frame, state, width, height) {
    const [rowSpacing, columnSpacing] = validPixelSpacing(frame.pixelSpacing) ? frame.pixelSpacing : [1, 1];
    const angle = state.rotation * Math.PI / 180;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const physicalWidth = frame.columns * columnSpacing;
    const physicalHeight = frame.rows * rowSpacing;
    const fittedWidth = Math.abs(cosine) * physicalWidth + Math.abs(sine) * physicalHeight;
    const fittedHeight = Math.abs(sine) * physicalWidth + Math.abs(cosine) * physicalHeight;
    const fit = Math.min(width / fittedWidth, height / fittedHeight);
    const scaleX = fit * state.zoom * columnSpacing * (state.flipX ? -1 : 1);
    const scaleY = fit * state.zoom * rowSpacing * (state.flipY ? -1 : 1);
    const a = cosine * scaleX;
    const b = sine * scaleX;
    const c = -sine * scaleY;
    const d = cosine * scaleY;
    const e = width / 2 + state.panX - a * frame.columns / 2 - c * frame.rows / 2;
    const f = height / 2 + state.panY - b * frame.columns / 2 - d * frame.rows / 2;
    return { a, b, c, d, e, f };
}

export function transformPoint(matrix, x, y) {
    return { x: matrix.a * x + matrix.c * y + matrix.e, y: matrix.b * x + matrix.d * y + matrix.f };
}

export function inverseTransformPoint(matrix, x, y) {
    const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < Number.EPSILON) return null;
    const shiftedX = x - matrix.e;
    const shiftedY = y - matrix.f;
    return {
        x: (matrix.d * shiftedX - matrix.c * shiftedY) / determinant,
        y: (-matrix.b * shiftedX + matrix.a * shiftedY) / determinant
    };
}
