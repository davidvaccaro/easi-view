import { WorkflowBroker } from '../ai/WorkflowBroker.js';
import { aggregateWorkflow, workflowFromMetadata, normalizeWorkflow } from '../catalog/workflow.js';
import { normalizeWorkflowPreferences } from '../ai/AiClient.js';

const PRESETS = Object.freeze({ lung: { center: -600, width: 1500 }, 'soft-tissue': { center: 40, width: 400 }, bone: { center: 500, width: 2000 }, brain: { center: 40, width: 80 } });
const check = signal => { if (signal?.aborted) throw new DOMException('The assistant task was canceled.', 'AbortError'); };

/** Binds reviewed local actions to owned viewer APIs. This module has no
 * transport and never exports the patient catalog to a model. */
export function createViewerWorkflow({ getViewer, getCatalog, getRoles, getLoaded, getOrigin, getStackIndex, getMeasurements,
    getFrame, getAnnotationRevision, restoreTransform, selectAnnotation, workflowPreferences, getWindowOverride } = {}) {
    const preferences = normalizeWorkflowPreferences(workflowPreferences);
    const identifiers = new WeakMap(); let sequence = 0;
    const idFor = series => { if (!identifiers.has(series)) identifiers.set(series, 'working-stack-' + ++sequence); return identifiers.get(series); };
    function loadedDescriptor(series) {
        const origin = getOrigin(series), first = series.frames[0];
        // Each frame participates. A missing or conflicting recorded field must
        // not inherit a more confident classification from the first frame.
        const supplied = series.frames.map(frame => frame.workflow ?? series.workflow ?? workflowFromMetadata({
            imageOrientation: frame.orientation, bodyPartExamined: frame.bodyPartExamined,
            imageType: frame.imageType ?? frame.classicDimensions?.imageType
        }));
        const workflow = aggregateWorkflow(supplied);
        const stackIndex = origin ? getStackIndex(series, origin) : 0;
        return { id: origin ? origin.seriesId + '::stack:' + stackIndex : idFor(series), loadedId: idFor(series), catalogId: origin?.seriesId ?? null,
            studyId: origin?.studyId ?? 'working-study', stackIndex,
            modality: series.modality ?? first?.modality ?? '', number: first?.seriesNumber ?? null,
            description: series.description ?? series.label ?? '', frameCount: series.frames.length, workflow, status: 'loaded' };
    }
    function context() {
        const viewer = getViewer(); if (!viewer) throw new Error('The viewer is starting.');
        const workspace = viewer.getWorkspaceState(), state = viewer.getState(), loaded = getLoaded(), roles = getRoles(), catalog = getCatalog();
        const descriptors = loaded.map(loadedDescriptor), active = descriptors[workspace.viewports.find(pane => pane.slot === workspace.activeViewport)?.seriesIndex];
        const patientId = roles.activePatientId ?? roles.patientId ?? getOrigin(loaded[workspace.viewports[workspace.activeViewport]?.seriesIndex])?.patientId ?? (loaded.length ? 'working-patient' : null);
        const patient = catalog.patients.find(item => item.id === patientId);
        let studies = patient?.studies.map(study => ({ id: study.id, date: study.studyDate, time: study.studyTime, description: study.description,
            series: study.series.flatMap(series => {
                const groups = series.stackGroups?.length ? series.stackGroups : [null];
                return groups.map((group, stackIndex) => {
                    const loaded = descriptors.find(item => item.catalogId === series.id && item.stackIndex === stackIndex);
                    return { id: series.id + '::stack:' + stackIndex, catalogId: series.id, studyId: study.id, stackIndex,
                        modality: series.modality, number: series.seriesNumber,
                        description: series.description + (groups.length > 1 ? ' · Image stack ' + (stackIndex + 1) + (group?.label ? ': ' + group.label : '') : ''),
                        frameCount: group?.frameCount ?? series.frameCount ?? series.instanceCount,
                        workflow: loaded?.workflow ?? normalizeWorkflow(series.workflow), status: series.status };
                });
            }) })) ?? [];
        if (!studies.length && descriptors.length) studies = [{ id: 'working-study', date: '', time: '', description: 'Displayed images', series: descriptors }];
        const measurements = getMeasurements().flatMap(annotation => {
            for (const [index, series] of loaded.entries()) {
                const frame = series.frames.findIndex(item => item.sopUid === annotation.image.sopUid && (item.frameIndex ?? 0) + 1 === annotation.image.frameNumber);
                if (frame >= 0) return [{ id: annotation.id, series: descriptors[index], frame }];
            }
            return [];
        });
        return { patientId, preferences: { ...preferences }, currentStudyId: roles.currentStudyId ?? active?.studyId ?? null,
            comparisonStudyId: roles.comparisonStudyId ?? null, activeViewport: workspace.activeViewport, layout: workspace.layout,
            studies, tool: state.tool, playing: state.playing, annotationRevision: getAnnotationRevision(),
            panes: workspace.viewports.map(pane => ({ slot: pane.slot, series: descriptors[pane.seriesIndex] ?? null, frame: pane.frameIndex,
                window: pane.window, windowOverride: typeof getWindowOverride === 'function' ? getWindowOverride(pane.slot) === true : null,
                transform: pane.transform, studyId: descriptors[pane.seriesIndex]?.studyId ?? null })),
            synchronization: workspace.synchronization, measurements };
    }
    async function open(series, viewport, signal) {
        check(signal); const viewer = getViewer();
        if (series.catalogId) await viewer.openSessionSeries(series.catalogId, { viewport, stackIndex: series.stackIndex ?? 0, signal });
        else {
            const index = getLoaded().findIndex(item => idFor(item) === series.loadedId);
            if (index < 0) throw new Error('The selected working image is no longer available.');
            await viewer.assignViewportSeries(viewport, index);
        }
        check(signal); viewer.setActiveViewport(viewport);
    }
    async function frame(index, viewport, signal) {
        const viewer = getViewer(); viewer.setActiveViewport(viewport); check(signal); await viewer.setFrame(index); check(signal);
    }
    async function apply(action, binding, { signal }) {
        check(signal); const viewer = getViewer();
        if (action.type === 'prepare-fresh-view') {
            viewer.pause();
            await viewer.setSynchronization({slice: false, window: false, camera: false}); check(signal);
            await viewer.setLayout(1); check(signal);
            await viewer.clearViewport(0); check(signal);
            viewer.setActiveViewport(0); viewer.setTool('window');
            return;
        }
        if (action.type === 'retain-active-view') {
            if (!binding.series) { await viewer.clearViewport(action.viewport); check(signal); return; }
            await open(binding.series, action.viewport, signal);
            // Reusing a viewport/source can retain a later explicit override.
            // Restore automatic presentation before seeking the captured frame.
            if (binding.windowOverride === false) viewer.reset();
            if (binding.frame != null) await frame(binding.frame, action.viewport, signal);
            check(signal);
            if (binding.window && binding.windowOverride !== false) viewer.setWindow(binding.window);
            restoreTransform(action.viewport, binding.transform); check(signal);
            return;
        }
        if (action.type === 'layout') { await viewer.setLayout(action.count); check(signal); return; }
        if (action.type === 'select-series') return open(binding, action.viewport, signal);
        if (action.viewport != null) viewer.setActiveViewport(action.viewport);
        if (action.type === 'window') {
            const original = getFrame(action.viewport);
            if (!original) throw new Error('Display an image before applying a window.');
            if (action.preset === 'default') viewer.reset();
            else {
                if (original.modality !== 'CT' || original.unit !== 'HU' || !['MONOCHROME1', 'MONOCHROME2'].includes(original.photometric)) throw new Error('These CT presets require original calibrated HU values.');
                viewer.setWindow(PRESETS[action.preset]);
            }
        } else if (action.type === 'synchronize') {
            const result = await viewer.setSynchronization({ slice: action.slice, window: action.window, camera: action.camera });
            check(signal);
            const unmatched = result?.lastSync?.filter(item => item.matched === false).length ?? 0;
            if (unmatched) return { notices: [unmatched + (unmatched === 1 ? ' pane remains' : ' panes remain') + ' unlinked: compatible patient geometry or image presentation was unavailable. No registration was inferred.'] };
            // Existing geometry validation intentionally leaves incompatible
            // examinations unmatched rather than manufacturing registration.
        } else if (action.type === 'frame') await frame(action.frame - 1, action.viewport, signal);
        else if (action.type === 'cine') action.playing ? viewer.play() : viewer.pause();
        else if (action.type === 'tool') viewer.setTool(action.tool === 'length' ? 'distance' : action.tool);
        else if (action.type === 'reset') viewer.reset();
        else if (action.type === 'last-measurement') {
            await open(binding.series, action.viewport, signal); await frame(binding.frame, action.viewport, signal); selectAnnotation(binding.id);
        }
        check(signal);
    }
    async function restore(snapshot, { signal } = {}) {
        const viewer = getViewer();
        const ensure = () => { check(signal); if (context().patientId !== snapshot.patientId) throw new Error('The patient workspace changed.'); };
        ensure(); viewer.pause();
        await viewer.setSynchronization({ slice: false, window: false, camera: false }); ensure();
        await viewer.setLayout(snapshot.layout); ensure();
        for (const pane of snapshot.panes) {
            ensure();
            if (!pane.series) { await viewer.clearViewport(pane.slot); ensure(); continue; }
            await open(pane.series, pane.slot, signal); ensure();
            if (pane.windowOverride === false) viewer.reset();
            if (pane.frame != null) await frame(pane.frame, pane.slot, signal); ensure();
            if (pane.window && pane.windowOverride !== false) viewer.setWindow(pane.window);
            restoreTransform(pane.slot, pane.transform);
        }
        ensure(); viewer.setActiveViewport(snapshot.activeViewport);
        viewer.setTool(snapshot.tool);
        await viewer.setSynchronization(snapshot.synchronization); ensure();
        if (snapshot.playing) viewer.play();
    }
    return new WorkflowBroker({ getContext: context, apply, restore });
}
