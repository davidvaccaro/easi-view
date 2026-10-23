import { AiClient, normalizeAiConfiguration } from '../ai/AiClient.js';
import { AiController } from '../ai/AiController.js';
import {AiWorkflowController} from '../ai/AiWorkflowController.js';
import { aiError, createSeriesFacts, createMeasurementFacts, validateAiRequest } from '../ai/protocol.js';
import { AiAssistPanel } from '../ui/AiAssistPanel.js';

const clone = value => JSON.parse(JSON.stringify(value));
const localLabel = (value, fallback) => typeof value === 'string' && value.trim() ? value.replace(/[\x00-\x1F\x7F]/g, ' ').slice(0, 240) : fallback;
function sourceSnapshot(source) {
    if (!source || typeof source.key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(source.key) || !Number.isSafeInteger(source.index) || source.index < 0 ||
        !Number.isSafeInteger(source.slot) || source.slot < 0 || source.slot > 3) throw aiError('invalid-request', 'The selected image source is unavailable.');
    return { key: source.key, index: source.index, slot: source.slot };
}
function choices(context) {
    if (!Array.isArray(context?.measurements)) return [];
    return context.measurements.slice(0, 64).filter(item => typeof item?.id === 'string' && item.id && item.id.length <= 512 &&
        (typeof item.measure === 'function' || item.geometry)).map(item => ({ id: item.id, label: localLabel(item.label, 'Measurement') }));
}

/** Adapter between viewer-owned image selection and optional AI UI/transport.
 * The only network input is the validated coded-fact projection. Local source
 * references never enter controller requests, external state events or drafts. */
export class AiAssistIntegration {
    #configuration; #getContext; #isSourceAvailable; #navigateEvidence; #onChange; #controller; #panel = null;
    #snapshot = null; #choices = []; #disposed = false; #syncing = false; #lastEvent = '';
    #workflow = null; #workflowBroker = null; #recording = false;
    constructor(root, { configuration, getContext = () => null, isSourceAvailable = () => false, navigateEvidence = () => {}, onChange = () => {}, fetchImpl, workflow } = {}) {
        if ([getContext, isSourceAvailable, navigateEvidence, onChange].some(callback => typeof callback !== 'function')) throw aiError('invalid-request');
        this.#configuration = normalizeAiConfiguration(configuration); this.#getContext = getContext; this.#isSourceAvailable = isSourceAvailable;
        this.#navigateEvidence = navigateEvidence; this.#onChange = onChange;
        const client = this.#configuration.enabled && this.#configuration.configured ? new AiClient(this.#configuration, fetchImpl ? { fetchImpl } : {}) : null;
        this.#controller = new AiController({ client, onChange: () => { if (!this.#disposed && !this.#syncing) this.sync(); } });
        if (workflow && this.#configuration.enabled) {
            this.#workflowBroker = workflow;
            this.#workflow = new AiWorkflowController({client, broker: workflow, onChange: () => { if (!this.#disposed && !this.#syncing) this.sync(); }});
        }
        if (this.#configuration.enabled) this.#panel = new AiAssistPanel(root, {
            getSnapshot: (task, ids) => this.#capture(task, ids),
            onGenerate: snapshot => this.#generate(snapshot), onTestConnection: () => this.#controller.test(),
            onCancel: () => this.cancel(), onSelectionChange: () => this.#clearBinding(false),
            onNavigateEvidence: (id, snapshot) => this.#navigate(snapshot, id), onClose: () => { this.#clearBinding(false); this.#workflow?.clear({preserveUndo: true}); this.#emit(); },
            ...(this.#workflow ? {workflow: {
                onCommand: value => this.#workflow.setCommand(value), onMode: mode => this.#workflow.setMode(mode), onNewRequest: () => this.#workflow.newRequest(), onChoose: id => this.#workflow.choose(id),
                onPlan: () => { this.#clearBinding(false); return this.#workflow.plan(); }, onRun: () => this.#workflow.run(), onUndo: () => this.#workflow.undo(),
                onTranscribe: recording => { this.#clearBinding(false); return this.#workflow.transcribe(recording); }, onCancel: () => this.cancel(),
                onRecordingState: state => { this.#recording = state !== 'idle'; if (!this.#disposed && !this.#syncing) this.sync(); }
            }} : {})
        });
        this.sync();
    }
    #current() { try { return this.#getContext() ?? null; } catch { return null; } }
    #available(snapshot) { try { return this.#isSourceAvailable(snapshot) === true; } catch { return false; } }
    #valid(snapshot, context = this.#current()) {
        return !!snapshot && this.#available(snapshot) && (!context || context.patientKey === snapshot.patientKey && context.revision === snapshot.revision);
    }
    #capture(task, ids) {
        if (this.#disposed || !this.#configuration.enabled || !this.#configuration.configured) return null;
        const context = this.#current();
        if (!context?.frame || typeof context.contextKey !== 'string' || typeof context.patientKey !== 'string') throw aiError('invalid-request', 'Open an image before preparing AI context.');
        const source = sourceSnapshot(context.source);
        let facts = createSeriesFacts(context.frame, { frameCount: context.frameCount, notices: context.notices ?? [],
            sourceBitsStored: context.sourceBitsStored ?? context.frame.bitsStored, sourceBitsAllocated: context.sourceBitsAllocated ?? context.frame.bitsAllocated });
        const measurementIds = [];
        if (task === 'summarize-measurements') {
            if (!Array.isArray(ids) || !ids.length || ids.length > 16 || new Set(ids).size !== ids.length) throw aiError('invalid-request', 'Choose between one and sixteen existing measurements.');
            const eligible = choices(context), selected = ids.map(id => {
                if (!eligible.some(item => item.id === id)) throw aiError('invalid-request', 'A selected measurement is no longer available.');
                const item = context.measurements.find(candidate => candidate.id === id);
                measurementIds.push(id);
                try { return typeof item.measure === 'function' ? item.measure() : { geometry: item.geometry, statistics: item.statistics }; }
                catch { throw aiError('invalid-request', 'A selected measurement could not be prepared.'); }
            });
            // Measurement context is selected quantities, units and calibration,
            // with only these three technical fields needed to explain them.
            facts = facts.filter(fact => ['modality', 'intensity-unit', 'spatial-calibration'].includes(fact.code)).map((fact, index) => ({ ...fact, id: `E${index + 1}` }));
            facts.push(...createMeasurementFacts(selected, { startId: facts.length + 1 }));
        } else if (task !== 'explain-series') throw aiError('invalid-request');
        const request = validateAiRequest({ version: 1, task, facts });
        const captured = { request, contextKey: context.contextKey, patientKey: context.patientKey, revision: context.revision,
            source, label: localLabel(context.label, 'Selected image'), evidence: facts.map(fact => ({ id: fact.id,
                label: fact.group ? `Measurement ${Number(fact.group.slice(1))}` : 'Captured image',
                ...(fact.group ? { measurementId: measurementIds[Number(fact.group.slice(1)) - 1] } : {}) })) };
        if (!this.#available(captured)) throw aiError('invalid-request', 'The selected image source is unavailable.');
        this.#snapshot = captured; this.#choices = choices(context);
        this.#controller.prepare({ request, contextKey: captured.contextKey, revision: captured.revision });
        return captured;
    }
    async #generate(snapshot) {
        if (this.#disposed || snapshot !== this.#snapshot || !this.#valid(snapshot)) {
            this.invalidate(); throw aiError('invalid-request', 'The selected AI context changed. Review the current selection before generating.');
        }
        return this.#controller.generate();
    }
    #navigate(snapshot, id) {
        if (this.#disposed || snapshot !== this.#snapshot || !this.#valid(snapshot) || !snapshot.evidence.some(item => item.id === id)) {
            this.invalidate(); return;
        }
        // Give the viewer a detached local binding; no image metadata or pixels.
        this.#navigateEvidence(clone(snapshot), id);
    }
    #clearBinding(updatePanel = true) {
        this.#snapshot = null; this.#choices = []; this.#controller.clear();
        if (updatePanel) this.#panel?.invalidate();
    }
    #emit() {
        if (this.#disposed) return;
        const state = this.getState(), key = JSON.stringify(state);
        if (key === this.#lastEvent) return;
        this.#lastEvent = key;
        try { this.#onChange(state); } catch { /* Host operational callbacks cannot retain requests. */ }
    }
    sync() {
        if (this.#disposed || this.#syncing) return;
        this.#syncing = true;
        try {
            const context = this.#current();
            if (this.#snapshot && !this.#valid(this.#snapshot, context)) this.#clearBinding(true);
            const state = this.#controller.getState(), pinned = this.#snapshot;
            this.#panel?.update({ configured: this.#configuration.configured, profile: { label: this.#configuration.label, recipient: this.#configuration.recipient, model: this.#configuration.model, baseUrl: this.#configuration.baseUrl, signInUrl: this.#configuration.signInUrl },
                hasImage: !!(pinned || context?.frame), measurements: pinned ? this.#choices : choices(context),
                contextKey: pinned?.contextKey ?? context?.contextKey ?? null, revision: pinned?.revision ?? context?.revision ?? null, ...state,
                workflow: this.#workflow?.getState(), recording: this.#recording });
        } finally { this.#syncing = false; }
        this.#emit();
    }
    getState() {
        const state = this.#controller.getState();
        const workflow = this.#workflow?.getOperationalState();
        return { enabled: this.#configuration.enabled, configured: this.#configuration.configured, open: this.isOpen(), phase: state.phase,
            busy: ['generating', 'testing'].includes(state.phase) || workflow?.busy === true || this.#recording, factCount: this.#snapshot?.request.facts.length ?? 0,
            selectedMeasurementCount: new Set(this.#snapshot?.request.facts.map(fact => fact.group).filter(Boolean) ?? []).size,
            hasDraft: !!state.result && !state.result.connectionTest, errorCode: state.error?.code ?? workflow?.errorCode ?? null,
            ...(workflow ? {workflowMode: workflow.mode, workflowPhase: workflow.phase, plannedActionCount: workflow.actionCount, pendingChoiceCount: workflow.choiceCount, canUndoTask: workflow.canUndo, recording: this.#recording} : {}) };
    }
    getDraft() {
        if (!this.#valid(this.#snapshot)) return null;
        const state = this.#controller.getState();
        if (!state.result || state.result.connectionTest) return null;
        return clone({ ...state.result, facts: this.#snapshot.request.facts });
    }
    open() { if (this.#disposed || !this.#panel) return false; this.sync(); this.#panel.open(); this.#emit(); return true; }
    close() { if (this.#disposed) return; this.#panel?.close(); this.#emit(); }
    isOpen() { return !this.#disposed && this.#panel?.isOpen() === true; }
    cancel() { if (this.#disposed) return; this.#panel?.cancelRecording(); this.#controller.cancel(); this.#workflow?.cancel(); this.#emit(); }
    invalidate() {
        if (this.#disposed) return; this.#clearBinding(true);
        if (this.#workflowBroker?.isExecuting?.() !== true) { this.#panel?.cancelRecording(); this.#workflow?.clear(); }
        this.sync();
    }
    dispose() { if (this.#disposed) return; this.#disposed = true; this.#snapshot = null; this.#choices = []; this.#controller.dispose(); this.#workflow?.dispose(); this.#panel?.dispose(); this.#panel = null; this.#onChange = () => {}; }
}
