import { validateWorkflowPlan } from './workflow-protocol.js';
import { frameAtPosition, resolveViewCandidates, sharedViewSelections, viewSelectionLabel, viewSelectionReason } from './ViewSelection.js';

const copy = value => JSON.parse(JSON.stringify(value));
const fail = message => { throw new Error(message); };
const canceled = () => new DOMException('The assistant task was canceled.', 'AbortError');
const label = value => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 180);
const signature = context => JSON.stringify(context, function (key, value) {
    if (context.playing && key === 'frame') return null;
    // Native cine may change each frame's automatic window. Explicit window
    // edits still change windowOverride or the retained numeric window, and
    // manual transforms, source changes and annotations remain significant.
    if (context.playing && key === 'window' && this?.windowOverride === false) return null;
    return value;
});
const snapshotSignature = (context, mode) => JSON.stringify([mode, signature(context)]);
const freshContext = context => ({...context, activeViewport: 0, layout: 1, playing: false, tool: 'window',
    panes: [{slot: 0, series: null, frame: null, window: null, windowOverride: false, transform: {}, studyId: null}],
    synchronization: {slice: false, window: false, camera: false}});
const studyKey = study => String(study.date ?? '') + String(study.time ?? '');
const hasStudyDate = study => {
    if (!/^\d{8}$/u.test(String(study?.date ?? ''))) return false;
    const date = String(study.date), year = Number(date.slice(0, 4)), month = Number(date.slice(4, 6)), day = Number(date.slice(6, 8));
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return year >= 1000 && parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
};
const comparableTime = study => {
    const value = String(study?.time ?? '');
    const match = /^([01]\d|2[0-3])([0-5]\d)([0-5]\d|60)(?:\.(\d{1,6}))?$/u.exec(value);
    return match ? match[1] + match[2] + match[3] + (match[4] ?? '').padEnd(6, '0') : null;
};
const mostRecentRecorded = source => {
    const dated = source.filter(hasStudyDate);
    if (!dated.length) return [];
    const lastDate = dated.reduce((date, study) => study.date > date ? study.date : date, dated[0].date);
    const day = dated.filter(study => study.date === lastDate), times = day.map(comparableTime);
    // A missing/partial time on the same date can be either earlier or later.
    if (times.some(time => time === null)) return day;
    const latest = times.reduce((time, value) => value > time ? value : time, times[0]);
    return day.filter((study, index) => times[index] === latest);
};
const recordedBefore = (study, active) => {
    if (!hasStudyDate(study) || !hasStudyDate(active)) return false;
    if (study.date !== active.date) return study.date < active.date;
    const time = comparableTime(study), activeTime = comparableTime(active);
    return time !== null && activeTime !== null && time < activeTime;
};
const mostRecent = studies => {
    const ordered = [...studies].sort((a, b) => studyKey(b).localeCompare(studyKey(a)));
    return ordered.length ? ordered.filter(study => studyKey(study) === studyKey(ordered[0])) : [];
};
const selectionLabel = series => 'Series ' + (series.number ?? '—') + ' · ' + label(series.description || series.modality || 'Image series') + ' · ' + (series.frameCount ?? '?') + ' images';

// A paired CT window task selects one stack for both panes. The language
// model supplies criteria; eligibility and any ambiguity are resolved locally.
function pairedCtSelections(plan) {
    const windows = plan.actions.flatMap((action, index) => action.type === 'window' && ['lung', 'soft-tissue'].includes(action.preset) ? [{...action, index}] : []);
    if (windows.length !== 2 || new Set(windows.map(item => item.preset)).size !== 2 || windows[0].viewport === windows[1].viewport) return new Map();
    const indices = windows.map(window => {
        let selected = -1;
        for (let index = 0; index < window.index; index++) if (plan.actions[index].type === 'select-series' && plan.actions[index].viewport === window.viewport) selected = index;
        return selected;
    });
    if (indices.some(index => index < 0)) return new Map();
    const selectors = indices.map(index => plan.actions[index].selector);
    if (selectors.some(selector => selector.study === 'displayed' || selector.seriesNumber != null || selector.modality !== 'CT' || selector.plane !== 'axial') || JSON.stringify(selectors[0]) !== JSON.stringify(selectors[1])) return new Map();
    return new Map(indices.map(index => [index, 'ct-pair-' + Math.min(...indices)]));
}
const SPECIAL_CT_RECONSTRUCTIONS = new Set(['reformatted', 'projection', 'virtual-unenhanced', 'material-map']);
const ctSelectionReason = series => [
    'CT with recorded axial orientation',
    series.workflow?.derivation === 'original' && 'original image type',
    series.workflow?.reconstruction === 'axial' && 'axial reconstruction',
    series.workflow?.reconstruction === 'unknown' && 'reconstruction type unspecified',
    'HU calibration checked when opened'
].filter(Boolean).join('; ');

/** A local-only action broker. No catalog, identifiers, labels or image data
 * enter the planning request. Plans never contain executable code or URLs. */
export class WorkflowBroker {
    #context; #apply; #restore; #operation = null; #undo = null; #disposed = false;
    constructor({ getContext, apply, restore } = {}) {
        if ([getContext, apply, restore].some(value => typeof value !== 'function')) throw new TypeError('Provide local viewer workflow callbacks.');
        this.#context = getContext; this.#apply = apply; this.#restore = restore;
    }
    isExecuting() { return this.#operation != null; }
    getSnapshot({mode = 'continue'} = {}) {
        if (this.#disposed) fail('The viewer has closed.');
        if (!['fresh', 'continue'].includes(mode)) fail('Choose whether to start from the study or continue the current view.');
        const context = copy(this.#context());
        return { context, mode, signature: snapshotSignature(context, mode) };
    }
    #check(snapshot) {
        if (this.#disposed || !snapshot?.context || !['fresh', 'continue'].includes(snapshot.mode) ||
            snapshot.signature !== snapshotSignature(snapshot.context, snapshot.mode) || snapshot.signature !== snapshotSignature(this.#context(), snapshot.mode)) {
            fail('The viewing session changed. Review the task again.');
        }
    }
    #candidates(selector, context, options = {}) {
        const all = context.studies ?? [];
        const active = all.find(study => study.id === context.currentStudyId) ?? all.find(study => study.id === context.panes?.find(pane => pane.slot === context.activeViewport)?.studyId);
        if (selector.study === 'displayed') {
            const displayed = context.panes?.find(pane => pane.slot === context.activeViewport)?.series;
            if (!displayed) return [];
            return this.#filter([displayed], selector, options);
        }
        let studies = all.filter(study => !selector.modality || study.series.some(series => series.modality === selector.modality));
        if (selector.study === 'active' && active) studies = studies.filter(study => study.id === active.id);
        if (selector.study === 'latest') studies = options.conceptual ? mostRecentRecorded(studies) : mostRecent(studies);
        if (selector.study === 'selected-prior') studies = studies.filter(study => study.id === context.comparisonStudyId);
        if (selector.study === 'prior') {
            const earlier = studies.filter(study => active && study.id !== active.id && (options.conceptual ? recordedBefore(study, active) : studyKey(study) && studyKey(study) < studyKey(active)));
            studies = options.conceptual ? mostRecentRecorded(earlier) : mostRecent(earlier);
        }
        return this.#filter(studies.flatMap(study => study.series.map(series => ({ ...series, studyId: study.id, studyDescription: study.description }))), selector, options);
    }
    #filter(candidates, selector, options = {}) {
        return candidates.filter(series => {
            if (['unsupported', 'unavailable', 'error'].includes(series.status)) return false;
            if (selector.modality && series.modality !== selector.modality) return false;
            if (selector.seriesNumber != null && series.number !== selector.seriesNumber) return false;
            if (selector.plane && series.workflow?.plane !== selector.plane) return false;
            if (selector.contrast && series.workflow?.contrast !== selector.contrast) return false;
            if (!options.conceptual && selector.seriesNumber == null && selector.study !== 'displayed' && series.workflow?.localizer === true) return false;
            if (!options.conceptual && selector.seriesNumber == null && selector.study !== 'displayed' && series.workflow?.derivation === 'derived') return false;
            if (selector.bodyPart) {
                const part = String(series.workflow?.bodyPart ?? '').toLowerCase();
                const words = label(series.description).toLowerCase();
                const aliases = { chest: /\b(chest|thorax|thoracic)\b/, abdomen: /\b(abdomen|abdominal|abd|liver)\b/,
                    pelvis: /\b(pelvis|pelvic)\b/, head: /\b(head|brain|cranial)\b/, spine: /\b(spine|spinal|cervical|lumbar)\b/, liver: /\b(liver|hepatic)\b/ };
                if (part !== selector.bodyPart && !(selector.bodyPart === 'liver' && part === 'abdomen') && !aliases[selector.bodyPart].test(words)) return false;
            }
            return true;
        });
    }
    #resolve(input, snapshot, chosen = []) {
        const validated = validateWorkflowPlan(input), context = snapshot.mode === 'fresh' ? freshContext(snapshot.context) : snapshot.context;
        let activeViewport = context.activeViewport, proposedLayout = context.layout;
        const retainedPanes = new Map();
        const plan = { ...validated, actions: validated.actions.map((action, index) => {
            if (action.type === 'layout') {
                proposedLayout = action.count;
                if (activeViewport >= proposedLayout) {
                    if (snapshot.mode === 'continue') {
                        const pane = context.panes.find(pane => pane.slot === activeViewport);
                        if (!pane) fail('The previously active pane is unavailable. Review this task again.');
                        retainedPanes.set(index, pane);
                    }
                    activeViewport = 0;
                }
                return action;
            }
            if (action.viewport !== 'active') return action;
            if (!Number.isSafeInteger(activeViewport) || activeViewport < 0 || activeViewport >= proposedLayout) fail('Choose an active pane before reviewing this task.');
            return { ...action, viewport: activeViewport };
        }) };
        if (!Array.isArray(chosen) || chosen.length > 12 || chosen.some(id => typeof id !== 'string') || new Set(chosen).size !== chosen.length) fail('Choose one available series for each step.');
        if (plan.status !== 'ready') return { status: plan.status, message: plan.question ?? plan.summary, actions: [], choices: [], resolved: [] };
        if (snapshot.mode === 'fresh' && (!plan.actions.some(action => ['select-view', 'select-series', 'last-measurement'].includes(action.type)) ||
            plan.actions.some(action => ['select-view', 'select-series'].includes(action.type) && action.selector.study === 'displayed'))) {
            return {status: 'clarify', message: 'A new task starts from the current study without carrying over a displayed image. Include a viewing goal, or choose Continue current view to adjust an existing pane.', actions: [], choices: [], resolved: []};
        }
        let layout = context.layout, pending = false;
        const paired = pairedCtSelections(plan), conceptualGroups = sharedViewSelections(plan), shared = new Map();
        const choices = [], resolved = [], actions = [], used = new Set(), pendingPanes = new Set(), seriesByPane = new Map((context.panes ?? []).map(pane => [pane.slot, pane.series]));
        if (snapshot.mode === 'fresh') {
            resolved.push({action: {type: 'prepare-fresh-view'}, binding: null});
            actions.push({label: 'Start with one clean pane from the current study; keep imported studies and measurements'});
        }
        // Existing linked windows/positions must not overwrite another requested
        // presentation while a new conceptual task is being arranged. This
        // local preparation is visible in review and restored by the same Undo.
        const conceptualTask = retainedPanes.size > 0 || plan.actions.some(action => action.type === 'select-view' || action.type === 'position');
        const multiplePanes = context.layout > 1 || plan.actions.some(action => action.type === 'layout' && action.count > 1) ||
            new Set(plan.actions.flatMap(action => Number.isSafeInteger(action.viewport) ? [action.viewport] : [])).size > 1;
        const first = plan.actions[0], alreadyUnlinked = first?.type === 'synchronize' && !first.slice && !first.window && !first.camera;
        if (conceptualTask && multiplePanes && !alreadyUnlinked && Object.values(context.synchronization ?? {}).some(value => value === true)) {
            resolved.push({action: {type: 'synchronize', slice: false, window: false, camera: false}, binding: null});
            actions.push({label: 'Temporarily unlink panes while arranging the requested views'});
        }
        for (const [index, proposed] of plan.actions.entries()) {
            let action = proposed;
            let binding = null, description;
            if (action.type === 'layout') { layout = action.count; for (const slot of seriesByPane.keys()) if (slot >= layout) seriesByPane.delete(slot); description = 'Arrange ' + layout + (layout === 1 ? ' pane' : ' panes'); }
            else if (action.viewport != null && action.viewport >= layout) fail('The task refers to a pane outside its proposed layout.');
            if (action.type === 'select-series' || action.type === 'select-view') {
                const conceptual = action.type === 'select-view';
                const pair = paired.get(index), groupKey = conceptual ? conceptualGroups.get(index) : pair, existing = groupKey ? shared.get(groupKey) : null;
                let candidates = this.#candidates(action.selector, context, {conceptual});
                const selection = conceptual ? resolveViewCandidates(candidates, action.selector, context.preferences) : null;
                if (selection) candidates = selection.candidates;
                if (pair) candidates = candidates.filter(series => !SPECIAL_CT_RECONSTRUCTIONS.has(series.workflow?.reconstruction));
                if (!candidates.length) return { status: 'clarify', message: selection?.reason ?? (pair ? 'No suitable axial CT stack has the requested recorded metadata. Scouts, derived series, projections, reformats, virtual-unenhanced and material maps are excluded from this general window comparison. Choose another study or request an exact series explicitly.' : 'No series has the requested metadata. Open the intended study, choose another criterion, or specify its series number. Missing contrast or orientation metadata is not treated as a match.'), actions: [], choices: [], resolved: [] };
                const withReason = candidate => conceptual ? {...candidate, selectionReason: viewSelectionReason(candidate, selection)} : pair ? {...candidate, selectionReason: ctSelectionReason(candidate)} : candidate;
                const describe = candidate => conceptual ? viewSelectionLabel(candidate) : selectionLabel(candidate);
                if (existing) {
                    binding = existing.binding;
                    if (!binding) { pending = true; pendingPanes.add(action.viewport); }
                } else if (candidates.length === 1) binding = withReason(candidates[0]);
                else {
                    if (candidates.length > 64) return { status: 'clarify', message: conceptual ? 'Too many image stacks match. Add an orientation, reconstruction family, recorded energy, kernel or thickness criterion.' : 'Too many series match. Add a modality, orientation, body region or series number.', actions: [], choices: [], resolved: [] };
                    const group = groupKey ?? 'step-' + index, multipleStudies = new Set(candidates.map(series => series.studyId)).size > 1;
                    const options = candidates.map((series, ordinal) => ({ id: group + '-candidate-' + ordinal, group,
                        label: describe(series) + (multipleStudies && series.studyDescription ? ' · ' + label(series.studyDescription) : '') + (conceptual ? ' · ' + viewSelectionReason(series, selection) : pair ? ' · ' + ctSelectionReason(series) : ''), series }));
                    choices.push(...options.map(({ series, ...choice }) => choice));
                    const selected = options.filter(option => chosen.includes(option.id));
                    if (selected.length > 1) fail('Choose only one series for each step.');
                    if (selected.length) { binding = withReason(selected[0].series); used.add(selected[0].id); } else { pending = true; pendingPanes.add(action.viewport); }
                }
                if (groupKey && !existing) shared.set(groupKey, {binding});
                description = 'Pane ' + String.fromCharCode(65 + action.viewport) + ': ' + (binding ? describe(binding) + (pair || conceptual && binding.selectionReason ? ' · ' + binding.selectionReason : '') : pair ? 'choose one axial CT stack for both windows' : conceptual ? 'choose one matching image stack' : 'choose a matching series');
                if (binding) { seriesByPane.set(action.viewport, binding); pendingPanes.delete(action.viewport); }
                if (conceptual) action = {type: 'select-series', viewport: action.viewport, selector: {study: action.selector.study, modality: action.selector.modality, plane: action.selector.plane, contrast: action.selector.contrast, bodyPart: action.selector.bodyPart, seriesNumber: null}};
            } else if (action.type === 'window') {
                const series = seriesByPane.get(action.viewport);
                if (!pendingPanes.has(action.viewport) && !series) fail('Display an image before applying a window.');
                if (!pendingPanes.has(action.viewport) && action.preset !== 'default' && series?.modality && series.modality !== 'CT') fail('CT window presets require a CT series.');
                description = 'Pane ' + String.fromCharCode(65 + action.viewport) + ': ' + action.preset + ' window';
            } else if (action.type === 'synchronize') description = 'Link ' + [action.slice && 'compatible slices', action.window && 'window settings', action.camera && 'view transforms'].filter(Boolean).join(', ') + (action.slice || action.window || action.camera ? '' : 'off');
            else if (action.type === 'frame' || action.type === 'position') {
                const series = seriesByPane.get(action.viewport);
                if (!pendingPanes.has(action.viewport) && !series) fail('Display an image before selecting a frame.');
                if (action.type === 'position') {
                    const position = action.position;
                    if (!pendingPanes.has(action.viewport)) action = {type: 'frame', viewport: action.viewport, frame: frameAtPosition(position, series?.frameCount)};
                    description = 'Pane ' + String.fromCharCode(65 + action.viewport) + ': ' + position + ' navigable image' + (action.type === 'frame' ? ' (' + action.frame + ' of ' + series.frameCount + ')' : ' after image-stack selection');
                } else {
                    if (!pendingPanes.has(action.viewport) && series?.frameCount && action.frame > series.frameCount) fail('The requested image is outside the selected series.');
                    description = 'Pane ' + String.fromCharCode(65 + action.viewport) + ': image ' + action.frame;
                }
            } else if (action.type === 'cine') description = (action.playing ? 'Play' : 'Pause') + ' pane ' + String.fromCharCode(65 + action.viewport);
            else if (action.type === 'tool') description = 'Activate ' + action.tool + ' tool';
            else if (action.type === 'reset') description = 'Reset pane ' + String.fromCharCode(65 + action.viewport);
            else if (action.type === 'last-measurement') {
                binding = context.measurements?.at(-1);
                if (!binding) return { status: 'clarify', message: 'There is no existing measurement in this patient workspace. Draw a measurement first.', actions: [], choices: [], resolved: [] };
                description = 'Return to the image with the last existing measurement';
                seriesByPane.set(action.viewport, binding.series); pendingPanes.delete(action.viewport);
            }
            resolved.push({ action, binding }); actions.push({ label: description });
            if (retainedPanes.has(index)) {
                const pane = retainedPanes.get(index);
                resolved.push({action: {type: 'retain-active-view', viewport: 0}, binding: pane});
                actions.push({label: pane.series ? 'Keep the previously active image in pane A, including its position and viewing settings' : 'Keep the previously active empty view in pane A'});
                seriesByPane.set(0, pane.series); pendingPanes.delete(0);
            }
        }
        if (chosen.some(id => !used.has(id))) fail('The chosen series is no longer part of this reviewed task.');
        return { status: pending ? 'clarify' : 'ready', message: pending ? paired.size ? 'Several suitable CT reconstructions match. Choose one here; that exact image stack will be used for both windows. Metadata does not identify one uniquely correct reconstruction.' : conceptualGroups.size ? 'Several image stacks match the requested technical criteria. Choose one for each distinct request; identical requests share the same stack across panes. No clinical ranking was inferred.' : 'Choose a series for each highlighted step. Metadata alone cannot determine a primary series.' : plan.summary, actions, choices, resolved };
    }
    preview(plan, snapshot, choices = []) { this.#check(snapshot); const { resolved, ...result } = this.#resolve(plan, snapshot, choices); return copy(result); }
    async execute(plan, snapshot, choices = [], { signal, onProgress = () => {} } = {}) {
        if (this.#operation) fail('An assistant task is already running.');
        this.#check(snapshot);
        const resolved = this.#resolve(plan, snapshot, choices);
        if (resolved.status !== 'ready') fail(resolved.message);
        const controller = new AbortController(), abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
        const operation = { controller, snapshot }; this.#operation = operation; this.#undo = null;
        let changed = false; const notices = new Set();
        const check = () => {
            if (controller.signal.aborted || this.#disposed) throw canceled();
            if (this.#context().patientId !== snapshot.context.patientId) fail('The active patient changed. The assistant task stopped.');
        };
        try {
            for (const [index, step] of resolved.resolved.entries()) {
                check(); onProgress({ index: index + 1, total: resolved.actions.length, label: resolved.actions[index].label, message: resolved.actions[index].label }); check();
                changed = true; const result = await this.#apply(step.action, step.binding, { signal: controller.signal }); check();
                for (const notice of result?.notices ?? []) notices.add(label(notice));
            }
            this.#undo = { snapshot, after: signature(this.#context()) };
            return { message: 'Completed ' + resolved.actions.length + ' viewer steps. Measurements and source image data were not changed.' + (notices.size ? ' ' + [...notices].join(' ') : ''), canUndo: true };
        } catch (error) {
            // Restore through the viewer's own source APIs, never retain decoded
            // buffers or overwrite a different patient's workspace.
            if (changed && !operation.external && !this.#disposed && this.#context().patientId === snapshot.context.patientId) {
                const rollback = new AbortController(); operation.controller = rollback;
                try { await this.#restore(snapshot.context, { signal: rollback.signal }); }
                catch {
                    if (operation.external || this.#disposed || this.#context().patientId !== snapshot.context.patientId) throw canceled();
                    fail('The task stopped. Some view changes could not be restored; use the Session library to reopen the intended images.');
                }
            }
            throw error;
        } finally { signal?.removeEventListener('abort', abort); if (this.#operation === operation) this.#operation = null; }
    }
    async undo() {
        if (this.#operation || !this.#undo) fail('There is no completed assistant task to undo.');
        const undo = this.#undo;
        if (signature(this.#context()) !== undo.after) { this.#undo = null; fail('The view changed after the assistant task. Undo was cleared to preserve your changes.'); }
        this.#undo = null;
        const operation = { controller: new AbortController() }; this.#operation = operation;
        try { await this.#restore(undo.snapshot.context, { signal: operation.controller.signal });
            if (operation.controller.signal.aborted || this.#disposed) throw canceled();
            return { message: 'Previous view restored.', canUndo: false }; }
        finally { if (this.#operation === operation) this.#operation = null; }
    }
    cancel() { this.#operation?.controller.abort(); }
    interrupt() { this.#undo = null; if (this.#operation) { this.#operation.external = true; this.#operation.controller.abort(); } }
    dispose() { this.cancel(); this.#disposed = true; this.#undo = null; }
}
