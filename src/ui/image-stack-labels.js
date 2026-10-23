const MAX_LABEL_LENGTH = 24;
const SEPARATOR = ' · ';

function consistent(frames, describe) {
    if (!frames.length) return null;
    const first = describe(frames[0]);
    return first != null && frames.every(frame => describe(frame) === first) ? first : null;
}

function plane(frame) {
    const v = frame.orientation;
    if (!Array.isArray(v) || v.length !== 6 || !v.every(Number.isFinite)) return null;
    const [a, b, c, d, e, f] = v;
    if (Math.abs(Math.hypot(a, b, c) - 1) > 0.001 || Math.abs(Math.hypot(d, e, f) - 1) > 0.001 ||
        Math.abs(a * d + b * e + c * f) > 0.001) return null;
    const normal = [b * f - c * e, c * d - a * f, a * e - b * d];
    const length = Math.hypot(...normal);
    const axis = normal.findIndex(value => Math.abs(value / length) >= 0.999);
    return ['Sagittal', 'Coronal', 'Axial'][axis] ?? 'Oblique';
}

function dimensions(frame) {
    const value = frame.dimensions ?? frame.classicDimensions;
    return value && !value.invalid ? value : {};
}

function numberLabel(value, prefix, { integer = false, min = 0, suffix = '' } = {}) {
    if (!Number.isFinite(value) || value < min || integer && !Number.isSafeInteger(value)) return null;
    return `${prefix}${value}${suffix}`;
}

function echo(frame) {
    const d = dimensions(frame), numbers = d.echoNumbers;
    if (Array.isArray(numbers) && numbers.length > 1) return null;
    const number = Array.isArray(numbers) && numbers.length === 1 ? numbers[0] : d.echoNumber;
    return numberLabel(number, 'Echo ', { integer: true, min: 1 }) ??
        numberLabel(d.effectiveEchoTime, 'TE ', { suffix: 'ms' });
}

function matrix(frame) {
    return Number.isSafeInteger(frame.rows) && frame.rows > 0 && Number.isSafeInteger(frame.columns) && frame.columns > 0
        ? `${frame.columns}×${frame.rows}` : null;
}

/** Short display names from parsed descriptors only; never infer a clinical sequence. */
export function describeImageStacks(stacks) {
    const descriptions = stacks.map(stack => {
        const frames = stack.frames;
        return [consistent(frames, plane), consistent(frames, echo),
            consistent(frames, frame => numberLabel(dimensions(frame).temporalPositionIndex, 'Time ', { integer: true, min: 1 })),
            consistent(frames, frame => numberLabel(dimensions(frame).diffusionBValue, 'b=')), consistent(frames, matrix)];
    });
    const useful = descriptions[0]?.map((_, index) => stacks.length === 1 || new Set(descriptions.map(values => values[index])).size > 1) ?? [];
    const labels = descriptions.map(values => {
        let label = '';
        for (const [index, term] of values.entries()) {
            if (!term || !useful[index]) continue;
            const next = label ? `${label}${SEPARATOR}${term}` : term;
            if (next.length <= MAX_LABEL_LENGTH) label = next;
        }
        return label;
    });
    const counts = new Map();
    for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
    return stacks.map((stack, index) => {
        let label = labels[index];
        if (!label) label = `Stack ${index + 1}`;
        else if (counts.get(label) > 1) {
            const suffix = ` #${index + 1}`;
            label = `${label.slice(0, MAX_LABEL_LENGTH - suffix.length).trimEnd()}${suffix}`;
        }
        return { id: String(index), label, frameCount: stack.frames.length };
    });
}
