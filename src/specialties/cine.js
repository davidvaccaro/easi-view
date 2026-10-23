import { dataSet, attribute, scalar, numbers, pointer, integer, fail, frozenArray, MAX_SPECIALTY_FRAMES } from './common.js';

/** Playback scheduling, not ECG phase detection or synchronization. */
export function normalizeCine(input, { manualFrameTimeMs, manualRateFps } = {}) {
    const set = dataSet(input), frameCount = integer(scalar(set, '00280008'), 1, MAX_SPECIALTY_FRAMES);
    if (manualFrameTimeMs != null && manualRateFps != null) fail('choose one manual playback timing override');
    const positive = value => Number.isFinite(value) && value > 0 && value <= 60000;
    if (manualFrameTimeMs != null && !positive(manualFrameTimeMs) || manualRateFps != null && (!Number.isFinite(manualRateFps) || manualRateFps <= 0 || manualRateFps > 1000)) fail('manual playback timing is invalid');
    const start = integer(scalar(set, '00082142', { required: false }) ?? 1, 1, frameCount) - 1;
    const end = integer(scalar(set, '00082143', { required: false }) ?? frameCount, 1, frameCount) - 1;
    if (end < start) fail('cine trim range is reversed');
    const sequencing = scalar(set, '00181244', { required: false }) ?? 0;
    if (![0, 1].includes(sequencing)) fail('cine sequencing must be loop or sweep');
    const increment = pointer(set), fixed = scalar(set, '00181063', { required: false });
    const vector = numbers(set, '00181065', { required: false, maximum: MAX_SPECIALTY_FRAMES });
    const delay = scalar(set, '00181066', { required: false }) ?? 0;
    if (!Number.isFinite(delay) || delay < 0 || delay > 86400000 || fixed != null && (fixed < 0 || fixed > 60000 || frameCount > 1 && fixed === 0)) fail('declared acquisition timing is invalid');
    if (vector.length && (vector.length !== frameCount || vector[0] !== 0 || vector.slice(1).some(value => !positive(value)))) fail('Frame Time Vector must contain zero followed by positive frame increments');
    if (increment != null && !['00181063', '00181065'].includes(increment)) fail('only Frame Time or Frame Time Vector acquisition timing is supported');
    if (increment === '00181063' && fixed == null || increment === '00181065' && !vector.length) fail('Frame Increment Pointer lacks its timing values');
    if (frameCount > 1 && increment == null && (fixed != null || vector.length)) fail('acquisition timing requires its Frame Increment Pointer');
    if (attribute(set, '003A0300')?.items?.length) fail('multiplexed audio playback is unsupported');
    let acquisitionTimes = null;
    if (increment === '00181063') acquisitionTimes = Array.from({ length: frameCount }, (_, index) => delay + fixed * index);
    else if (increment === '00181065') { let time = delay; acquisitionTimes = vector.map(value => time += value); }
    const recommended = scalar(set, '00082144', { required: false });
    if (recommended != null && (!Number.isFinite(recommended) || recommended <= 0 || recommended > 1000)) fail('Recommended Display Frame Rate is invalid');
    const manual = manualFrameTimeMs ?? (manualRateFps == null ? null : 1000 / manualRateFps);
    const displayStep = manual ?? (recommended == null ? null : 1000 / recommended);
    if (frameCount > 1 && displayStep == null && !acquisitionTimes) fail('declared or explicit manual cine timing is required');
    const sequence = [];
    for (let index = start; index <= end; index++) sequence.push(index);
    if (sequencing === 1) for (let index = end - 1; index > start; index--) sequence.push(index);
    const durations = sequence.map((frameIndex, index) => {
        if (sequence.length === 1) return 0;
        if (displayStep != null) return displayStep;
        const next = sequence[(index + 1) % sequence.length];
        // Loop closure has no transmitted acquisition interval. Repeat the
        // last in-trim interval as an explicit playback convention.
        return next < frameIndex && sequencing === 0 ? acquisitionTimes[end] - acquisitionTimes[end - 1] : Math.abs(acquisitionTimes[next] - acquisitionTimes[frameIndex]);
    });
    let total = 0;
    const starts = durations.map(duration => { const value = total; total += duration; return value; });
    if (!Number.isFinite(total) || total > 7 * 86400000) fail('cine cycle duration exceeds its limit');
    return Object.freeze({ profile: 'cine-trim-timing-v1', frameCount, startFrameIndex: start, stopFrameIndex: end,
        sequencing: sequencing === 1 ? 'sweep' : 'loop', timing: manual != null ? 'manual' : recommended != null ? 'recommended-display-rate' : increment === '00181065' ? 'frame-time-vector' : 'frame-time',
        acquisitionTimesMs: acquisitionTimes == null ? null : frozenArray(acquisitionTimes), sequence: frozenArray(sequence), durationsMs: frozenArray(durations),
        startsMs: frozenArray(starts), cycleDurationMs: total, closurePolicy: 'repeat-last-interval', physiologicalPhase: null });
}

export function nextCineFrame(plan, sequenceIndex = 0) {
    if (plan?.profile !== 'cine-trim-timing-v1') fail('a normalized cine plan is required');
    integer(sequenceIndex, 0, plan.sequence.length - 1);
    return { frameIndex: plan.sequence[sequenceIndex], durationMs: plan.durationsMs[sequenceIndex], nextSequenceIndex: (sequenceIndex + 1) % plan.sequence.length };
}
export function frameAtTime(plan, elapsedMs) {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > Number.MAX_SAFE_INTEGER) fail('playback elapsed time is invalid');
    if (plan?.profile !== 'cine-trim-timing-v1') fail('a normalized cine plan is required');
    if (!plan.cycleDurationMs) return { ...nextCineFrame(plan, 0), sequenceIndex: 0, elapsedInFrameMs: 0 };
    const time = elapsedMs % plan.cycleDurationMs;
    let low = 0, high = plan.startsMs.length;
    while (low + 1 < high) { const middle = Math.floor((low + high) / 2); if (plan.startsMs[middle] <= time) low = middle; else high = middle; }
    return { ...nextCineFrame(plan, low), sequenceIndex: low, elapsedInFrameMs: time - plan.startsMs[low] };
}
