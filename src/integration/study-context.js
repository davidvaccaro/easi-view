import { context as normalizeContext, reference as normalizeReference, text } from '../enterprise/contracts.js';
import { isColorFrame } from '../render/DisplayMath.js';

/** A server-verified reference can narrow a viewing context; it never changes an archive address. */
export function referenceWithinScope(input, scope) {
    const requested = normalizeReference(input), permitted = normalizeReference(scope);
    return requested.archiveKey === permitted.archiveKey && requested.studyUid === permitted.studyUid &&
        (!permitted.seriesUid || requested.seriesUid === permitted.seriesUid) && (!permitted.sopUid || requested.sopUid === permitted.sopUid);
}

export function normalizeStudyContext(input, { archiveKey, scope } = {}) {
    const key = text(archiveKey, 64), result = normalizeContext(input);
    if (!result.viewports.length || !result.viewports.some(view => view.slot === result.activeViewport)) throw new TypeError('A study context needs a referenced active pane.');
    if (result.viewports.some(view => view.reference.archiveKey !== key || scope && !referenceWithinScope(view.reference, scope))) {
        throw new Error('The viewing context is outside the configured archive or verified reference scope.');
    }
    return result;
}

/** Explicit export omits local File/Blob panes and never serializes images or source URLs. */
export function exportStudyContext(panes, { archiveKey, archiveClient, activeViewport, getOrigin } = {}) {
    const key = text(archiveKey, 64);
    if (![1, 2, 4].includes(panes?.length) || typeof getOrigin !== 'function' || !archiveClient || typeof archiveClient !== 'object') throw new TypeError('Use an available workspace and configured archive key.');
    const viewports = [];
    for (const pane of panes) {
        const { currentSeries: series, frame, renderedIndex } = pane.view;
        if (!series || !frame) continue;
        const origin = getOrigin(series);
        if (origin?.sourceType !== 'archive') continue;
        if (origin.archiveClient !== archiveClient || series._session?.client && series._session.client !== archiveClient) {
            throw new Error('The viewing context belongs to a different or unavailable archive client.');
        }
        const entry = { slot: pane.slot, reference: { archiveKey: key, studyUid: series.studyUid, seriesUid: series.seriesUid, sopUid: frame.sopUid },
            frameIndex: renderedIndex, originalFrameNumber: frame.frameIndex + 1 };
        if (!isColorFrame(frame)) entry.window = { center: pane.viewport.state.center, width: pane.viewport.state.width };
        viewports.push(entry);
    }
    if (!viewports.length) throw new Error('Open an archive image before exporting its study context.');
    return normalizeStudyContext({ version: 1, layout: panes.length,
        activeViewport: viewports.some(view => view.slot === activeViewport) ? activeViewport : viewports[0].slot, viewports }, { archiveKey: key });
}

/** Select a stack by durable original image identity when provided, never by a guessed enhanced partition. */
export function selectContextFrame(series, view) {
    const ref = normalizeReference(view.reference), original = view.originalFrameNumber;
    if (!Array.isArray(series) || !series.length) throw new Error('The requested study contains no compatible stacks.');
    const candidates = series.filter(stack => stack.studyUid === ref.studyUid && (!ref.seriesUid || stack.seriesUid === ref.seriesUid));
    if (original != null) {
        const matches = [];
        for (const stack of candidates) {
            for (let index = 0; index < stack.frames.length; index++) {
                const frame = stack.frames[index];
                if (frame.sopUid === ref.sopUid && frame.frameIndex + 1 === original) matches.push({ series: stack, index });
            }
        }
        if (matches.length !== 1) throw new Error('The referenced original image/frame is absent or ambiguous.');
        return matches[0];
    }
    const matches = candidates.filter(stack => stack.frames[view.frameIndex] && (!ref.sopUid || stack.frames[view.frameIndex].sopUid === ref.sopUid));
    if (matches.length !== 1 && ref.sopUid) throw new Error('An enhanced or partitioned stack requires an original frame number.');
    if (!matches.length) throw new Error('The requested navigation frame is unavailable.');
    return { series: matches[0], index: view.frameIndex };
}
