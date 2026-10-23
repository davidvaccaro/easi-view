import {aiError, AI_ERROR_CODES} from './protocol.js';
import {validateWorkflowRequest} from './workflow-protocol.js';

const clone = value => JSON.parse(JSON.stringify(value));
const requestMode = value => { if (value !== 'fresh' && value !== 'continue') throw aiError('invalid-request', 'Choose a valid request starting point.'); return value; };
const plain = (value, maximum = 500) => typeof value === 'string' ? value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ').slice(0, maximum) : '';
const controlled = error => error?.code && [...AI_ERROR_CODES, 'cancelled', 'busy'].includes(error.code) ? aiError(error.code) : aiError('invalid-request', 'The viewer could not complete this task. Review the current session and try again.');

/** Commands alone reach the model. Captured catalogs and choice bindings stay
 * in the local broker and are never included in requests or operational events. */
export class AiWorkflowController {
    #client; #broker; #onChange; #active = null; #generation = 0; #disposed = false; #snapshot = null;
    #state = {mode: 'fresh', phase: 'idle', command: '', plan: null, preview: null, selectedChoices: [], message: '', error: null, canUndo: false};
    constructor({client = null, broker, onChange = () => {}} = {}) {
        if (!broker || ['getSnapshot', 'preview', 'execute', 'undo', 'cancel'].some(name => typeof broker[name] !== 'function') || typeof onChange !== 'function') throw aiError('invalid-request');
        this.#client = client; this.#broker = broker; this.#onChange = onChange;
    }
    #notify() { if (!this.#disposed) this.#onChange(this.getState()); }
    #set(update) { this.#state = {...this.#state, ...update}; this.#notify(); }
    getState() { return clone({...this.#state, busy: !!this.#active}); }
    getOperationalState() {
        return {mode: this.#state.mode, phase: this.#state.phase, busy: !!this.#active, actionCount: this.#state.plan?.actions.length ?? 0,
            choiceCount: this.#state.preview?.choices.length ?? 0, canUndo: this.#state.canUndo, errorCode: this.#state.error?.code ?? null};
    }
    setCommand(value) {
        if (this.#disposed || this.#active) return;
        const command = typeof value === 'string' ? value.slice(0, 1200) : '';
        if (command === this.#state.command) return;
        this.#snapshot = null; this.#set({command, phase: 'idle', plan: null, preview: null, selectedChoices: [], message: '', error: null});
    }
    setMode(value) {
        if (this.#disposed || this.#active) return;
        const mode = requestMode(value);
        if (mode === this.#state.mode) return;
        this.#snapshot = null; this.#set({mode, phase: 'idle', plan: null, preview: null, selectedChoices: [], message: '', error: null});
    }
    newRequest() {
        if (this.#disposed || this.#active) return;
        this.clear({preserveUndo: true});
    }
    #validateSnapshot(snapshot, mode = this.#state.mode) {
        if (!snapshot || snapshot.mode !== requestMode(mode)) throw aiError('invalid-request', 'The request starting point changed. Plan the task again before running.');
        return snapshot;
    }
    async #job(phase, work) {
        if (this.#disposed || this.#active) throw aiError('busy');
        const generation = ++this.#generation, controller = new AbortController(); this.#active = controller;
        this.#set({phase, ...(phase === 'running' ? {canUndo: false} : {}), error: null, message: phase === 'planning' ? 'Preparing a proposed workflow…' : phase === 'transcribing' ? 'Transcribing your recording…' : phase === 'running' ? 'Running the reviewed steps…' : 'Restoring the previous view…'});
        try { await work(controller.signal, value => { if (!this.#disposed && generation === this.#generation) this.#set(value); }); }
        catch (error) { if (!this.#disposed && generation === this.#generation) this.#set({phase: controller.signal.aborted ? 'cancelled' : 'error', error: controller.signal.aborted ? null : {code: controlled(error).code, message: controlled(error).message}, message: controller.signal.aborted ? 'Task canceled. No further steps will run.' : ''}); }
        finally { if (this.#active === controller) this.#active = null; if (!this.#disposed) this.#notify(); }
    }
    transcribe(recording) {
        if (!this.#client) throw aiError('unavailable');
        return this.#job('transcribing', async (signal, apply) => {
            const result = await this.#client.transcribeCommand(recording, {signal});
            this.#snapshot = null;
            apply({phase: 'idle', command: result.text, plan: null, preview: null, selectedChoices: [], message: 'Transcript ready. Review and edit it before choosing Plan task.'});
        });
    }
    plan() {
        if (!this.#client) throw aiError('unavailable');
        const mode = requestMode(this.#state.mode);
        const {command} = validateWorkflowRequest({version: 1, task: 'plan-workflow', command: this.#state.command, mode});
        return this.#job('planning', async (signal, apply) => {
            const snapshot = this.#validateSnapshot(this.#broker.getSnapshot({mode}), mode);
            const {plan} = await this.#client.planCommand(command, {signal, mode});
            if (signal.aborted) return;
            const result = plan.status === 'ready' ? await this.#broker.preview(plan, snapshot, []) : {status: plan.status, message: plan.question ?? plan.summary, actions: [], choices: []};
            if (signal.aborted) return;
            const preview = this.#preview(result);
            this.#snapshot = snapshot;
            apply({phase: 'review', plan, preview, selectedChoices: [], message: preview.message || plan.summary});
        });
    }
    #preview(result) {
        if (!result || !['ready', 'clarify', 'unsupported'].includes(result.status) || (Array.isArray(result.actions) && result.actions.length > 16)) throw aiError('invalid-response');
        return {status: result.status, message: plain(result.message), actions: (Array.isArray(result.actions) ? result.actions : []).slice(0, 16).map((action, index) => ({label: plain(action?.label) || `Step ${index + 1}`})),
            choices: (Array.isArray(result.choices) ? result.choices : []).slice(0, 64).filter(choice => typeof choice?.id === 'string' && choice.id.length > 0 && choice.id.length <= 256).map(choice => ({id: choice.id, group: plain(choice.group, 128) || 'selection', label: plain(choice.label)}))};
    }
    choose(id) {
        const choice = this.#state.preview?.choices.find(choice => choice.id === id);
        if (this.#disposed || this.#active || !choice) return;
        this.#validateSnapshot(this.#snapshot);
        const existing = this.#state.preview.choices, selected = this.#state.selectedChoices.filter(id => existing.find(candidate => candidate.id === id)?.group !== choice.group);
        selected.push(id);
        return this.#job('reviewing', async (signal, apply) => {
            const preview = this.#preview(await this.#broker.preview(clone(this.#state.plan), this.#snapshot, selected));
            if (!signal.aborted) apply({phase: 'review', preview, selectedChoices: selected, message: preview.message || this.#state.plan.summary});
        });
    }
    run() {
        const {plan, preview, selectedChoices} = this.#state;
        if (this.#disposed || this.#state.phase !== 'review' || plan?.status !== 'ready' || preview?.status !== 'ready') throw aiError('invalid-request', 'Review the proposed steps and choose any required series before running.');
        const snapshot = this.#validateSnapshot(this.#snapshot);
        return this.#job('running', async (signal, apply) => {
            const result = await this.#broker.execute(clone(plan), snapshot, [...selectedChoices], {signal, onProgress: progress => apply({message: plain(typeof progress === 'string' ? progress : progress?.message) || 'Running the reviewed steps…'})});
            if (signal.aborted) return;
            this.#snapshot = null;
            apply({phase: 'complete', message: plain(result?.message) || 'Task complete. Review the resulting view.', canUndo: result?.canUndo !== false, plan: null, preview: null, selectedChoices: []});
        });
    }
    undo() {
        if (!this.#state.canUndo || this.#disposed) throw aiError('invalid-request');
        return this.#job('undoing', async (signal, apply) => { await this.#broker.undo({signal}); if (!signal.aborted) apply({phase: 'complete', message: 'Previous view restored.', canUndo: false, plan: null, preview: null, selectedChoices: []}); });
    }
    cancel() {
        if (this.#disposed) return;
        ++this.#generation; this.#active?.abort(); this.#client?.cancel();
        try { this.#broker.cancel(); } catch { /* Cancellation must still release UI state. */ }
        this.#snapshot = null; this.#set({phase: 'cancelled', plan: null, preview: null, selectedChoices: [], message: 'Task canceled. No further steps will run.', error: null});
    }
    clear({preserveUndo = false} = {}) {
        if (this.#disposed) return;
        const canUndo = preserveUndo === true && this.#state.canUndo;
        this.cancel(); this.#set({mode: 'fresh', phase: 'idle', command: '', message: '', error: null, canUndo});
    }
    dispose() { if (this.#disposed) return; this.cancel(); this.#disposed = true; this.#snapshot = null; this.#state = {mode: 'fresh', phase: 'idle', command: '', plan: null, preview: null, selectedChoices: [], message: '', error: null, canUndo: false}; this.#onChange = () => {}; }
}
