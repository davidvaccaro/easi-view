import {AiVoiceCapture} from './AiVoiceCapture.js';

let nextId = 0;
const text = value => typeof value === 'string' ? value : '';

/** Task commands are reviewed text. Plans are inert text and closed local
 * actions; this panel never evaluates model code or sends a source catalog. */
export class AiWorkflowPanel {
    #root; #document; #callbacks; #mode; #modeNote; #newRequest; #command; #plan; #run; #cancel; #undo; #record; #status; #error; #steps; #choices; #review; #summary; #voice; #voiceState = 'idle'; #localError = ''; #choiceKey = ''; #lifetime = new AbortController(); #disposed = false;
    #state = {configured: false, mode: 'fresh', phase: 'idle', command: '', plan: null, preview: null, selectedChoices: [], busy: false, canUndo: false};
    constructor(root, callbacks = {}, voiceOptions = {}) {
        this.#root = root; this.#document = root.ownerDocument; this.#callbacks = callbacks;
        const id = `easi-ai-workflow-${++nextId}`, signal = this.#lifetime.signal;
        const node = (tag, className, value) => { const element = this.#document.createElement(tag); if (className) element.className = className; if (value != null) element.textContent = value; return element; };
        const button = (label, action) => { const element = node('button', 'ai-assist-button', label); element.type = 'button'; element.dataset.aiWorkflowAction = action; return element; };
        const modeLabel = node('label', 'ai-workflow-label', 'Request starting point'); modeLabel.setAttribute('for', `${id}-mode`);
        this.#mode = node('select', 'ai-workflow-request-mode'); this.#mode.id = `${id}-mode`; this.#mode.dataset.aiWorkflowMode = 'true';
        for (const [value, caption] of [['fresh', 'New task from study'], ['continue', 'Continue current view']]) { const option = node('option', '', caption); option.value = value; this.#mode.append(option); }
        this.#modeNote = node('p', 'ai-workflow-mode-note'); this.#modeNote.id = `${id}-mode-note`; this.#mode.setAttribute('aria-describedby', this.#modeNote.id);
        this.#newRequest = button('New request', 'new-request');
        const requestControls = node('div', 'ai-workflow-request-controls'); requestControls.append(this.#mode, this.#newRequest);
        const label = node('label', 'ai-workflow-label', 'What would you like to do?'); label.setAttribute('for', `${id}-command`);
        this.#command = node('textarea', 'ai-workflow-command'); this.#command.id = `${id}-command`; this.#command.maxLength = 1200; this.#command.rows = 4;
        this.#command.placeholder = 'For example: Set up this chest CT for routine review, or compare the lowest-energy images with the blended reconstruction.';
        const privacy = node('p', 'ai-assist-privacy', 'Plan task sends your reviewed text and chosen starting mode to the configured AI service. Do not include patient identifiers. Image files, pixels and the session catalog stay local. Proposed actions run only after you choose Run task.');
        this.#record = button('Record a task', 'record'); this.#record.setAttribute('aria-pressed', 'false');
        const voiceNotice = node('p', 'ai-workflow-voice-note', 'Optional voice: recording is limited to 20 seconds. Stop sends this audio to the configured transcription service (OpenAI for this demonstration). Review and edit the returned transcript before planning.');
        this.#plan = button('Plan task', 'plan'); this.#run = button('Run task', 'run'); this.#run.className += ' ai-workflow-primary'; this.#cancel = button('Cancel task', 'cancel'); this.#undo = button('Undo last task', 'undo');
        const controls = node('div', 'ai-workflow-controls'); controls.append(this.#record, this.#plan, this.#run, this.#cancel, this.#undo);
        this.#status = node('p', 'ai-assist-status ai-workflow-status'); this.#status.setAttribute('role', 'status'); this.#status.setAttribute('aria-live', 'polite');
        this.#error = node('p', 'ai-assist-error ai-workflow-error'); this.#error.setAttribute('role', 'alert');
        this.#review = node('section', 'ai-workflow-review'); const title = node('h3', 'ai-assist-section-title', 'Proposed steps · review before running'); this.#summary = node('p', 'ai-workflow-summary');
        this.#steps = node('ol', 'ai-workflow-steps'); this.#choices = node('div', 'ai-workflow-choices'); this.#choices.setAttribute('aria-label', 'Choose images for this viewing task');
        this.#review.append(title, this.#summary, this.#steps, this.#choices);
        root.append(modeLabel, requestControls, this.#modeNote, label, this.#command, privacy, voiceNotice, controls, this.#status, this.#error, this.#review);
        this.#voice = new AiVoiceCapture({...voiceOptions, onState: state => { this.#voiceState = state; this.#render(); this.#callbacks.onRecordingState?.(state); }, onError: message => { this.#localError = message; this.#render(); }, onRecording: recording => this.#invoke('onTranscribe', recording)});
        root.addEventListener('input', event => { if (event.target === this.#command && !this.#busy()) { this.#localError = ''; this.#invoke('onCommand', this.#command.value); } }, {signal});
        root.addEventListener('change', event => { if (this.#busy()) return; if (event.target === this.#mode) { this.#localError = ''; this.#invoke('onMode', this.#mode.value); } else if (event.target?.dataset?.aiWorkflowChoice) this.#invoke('onChoose', event.target.dataset.aiWorkflowChoice); }, {signal});
        root.addEventListener('click', event => {
            let target = event.target; while (target && target !== root) { if (target.dataset?.aiWorkflowAction) { if (!target.disabled) this.#action(target.dataset.aiWorkflowAction); break; } target = target.parentNode; }
        }, {signal});
        this.#render();
    }
    #busy() { return this.#state.busy || this.#voiceState !== 'idle'; }
    #invoke(name, ...args) { try { const value = this.#callbacks[name]?.(...args); if (value?.catch) value.catch(() => { if (!this.#disposed) { this.#localError = 'This action could not finish. Review the task and try again.'; this.#render(); } }); } catch { this.#localError = 'This action could not finish. Review the task and try again.'; this.#render(); } }
    #action(action) {
        if (this.#disposed) return;
        if (action === 'cancel') { this.#voice.cancel(); this.#localError = ''; this.#invoke('onCancel'); return; }
        if (action === 'record') { if (this.#voiceState === 'recording') this.#voice.stop(); else if (!this.#busy() && this.#state.configured) { this.#localError = ''; this.#voice.start(); } return; }
        if (this.#busy()) return;
        this.#localError = '';
        if (action === 'new-request') { this.#invoke('onNewRequest'); this.#command.focus(); }
        if (action === 'plan') this.#invoke('onPlan');
        if (action === 'run') this.#invoke('onRun');
        if (action === 'undo') this.#invoke('onUndo');
    }
    #render() {
        if (this.#disposed) return;
        const state = this.#state, busy = this.#busy();
        this.#root.setAttribute('aria-busy', busy ? 'true' : 'false');
        if (this.#command.value !== state.command) this.#command.value = text(state.command);
        this.#command.disabled = busy || !state.configured;
        this.#mode.value = state.mode === 'continue' ? 'continue' : 'fresh'; this.#mode.disabled = busy || !state.configured; this.#newRequest.disabled = busy;
        this.#modeNote.textContent = state.mode === 'continue'
            ? 'Builds on the panes, images and viewing settings you currently have open. Choose this to adjust or extend the current view.'
            : 'New task starts from one clean pane in the current study only when you choose Run task. Imported studies and measurements stay in the session. Planning changes no images.';
        this.#plan.disabled = busy || !state.configured || !text(state.command).trim(); this.#run.hidden = !state.preview; this.#run.disabled = busy || state.phase !== 'review' || state.preview?.status !== 'ready';
        this.#cancel.hidden = !busy; this.#cancel.disabled = !busy; this.#undo.disabled = busy || !state.canUndo;
        this.#record.textContent = this.#voiceState === 'recording' ? 'Stop and transcribe' : this.#voiceState === 'permission' ? 'Waiting for microphone…' : 'Record a task';
        this.#record.setAttribute('aria-pressed', this.#voiceState === 'recording' ? 'true' : 'false'); this.#record.disabled = !state.configured || (busy && this.#voiceState !== 'recording');
        this.#status.textContent = this.#voiceState === 'recording' ? 'Recording · maximum 20 seconds. Stop to send audio for transcription, or Cancel to discard.' : this.#voiceState === 'permission' ? 'Waiting for microphone permission. You can cancel without recording.' : text(state.message); this.#status.hidden = !this.#status.textContent;
        this.#error.textContent = this.#localError || text(state.error?.message); this.#error.hidden = !this.#error.textContent;
        this.#review.hidden = !state.plan; this.#summary.textContent = text(state.plan?.question) || text(state.plan?.summary);
        this.#steps.replaceChildren();
        for (const action of state.preview?.actions ?? []) { const item = this.#document.createElement('li'); item.textContent = text(action.label); this.#steps.append(item); }
        const choices = state.preview?.choices ?? [], key = JSON.stringify([choices, state.selectedChoices, busy]);
        if (key !== this.#choiceKey) {
            this.#choiceKey = key; this.#choices.replaceChildren();
            for (const choice of choices) {
                const label = this.#document.createElement('label'), input = this.#document.createElement('input'), copy = this.#document.createElement('span'); label.className = 'ai-workflow-choice';
                input.type = 'radio'; input.name = `${this.#command.id}-${choice.group || 'selection'}`; input.dataset.aiWorkflowChoice = choice.id; input.checked = state.selectedChoices?.includes(choice.id); input.disabled = busy; copy.textContent = text(choice.label); label.append(input, copy); this.#choices.append(label);
            }
        }
    }
    update(state = {}) { if (this.#disposed) return; this.#state = {...this.#state, ...state}; this.#render(); }
    cancelRecording() { this.#voice.cancel(); this.#localError = ''; }
    clear() { this.cancelRecording(); this.#state = {...this.#state, mode: 'fresh', phase: 'idle', command: '', plan: null, preview: null, selectedChoices: [], busy: false, canUndo: false, message: '', error: null}; this.#render(); }
    dispose() { if (this.#disposed) return; this.#voice.dispose(); this.#disposed = true; this.#lifetime.abort(); this.#callbacks = {}; this.#root.replaceChildren(); }
}
