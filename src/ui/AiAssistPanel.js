import {formatAiFact} from '../ai/protocol.js';
import {AiWorkflowPanel} from './AiWorkflowPanel.js';
import {normalizeAiSignInUrl} from '../ai/AiClient.js';

let nextId = 0;
const list = value => Array.isArray(value) ? value : [];
const text = value => value == null ? '' : String(value);
const TASKS = [
    {id: 'explain-series', label: 'Explain this series', description: 'Explain technical image properties, calibration and compatibility using selected metadata.'},
    {id: 'summarize-measurements', label: 'Draft a measurement summary', description: 'Summarize selected existing measurements. Viewer calculations remain authoritative.'}
];
const MAX_TEXT = 65536;

/** Optional, explicit-send AI workspace. The host owns context preparation,
 * transport, cancellation and evidence admission. This component never fetches
 * or reads image data and never interprets provider text as markup. */
export class AiAssistPanel {
    #root; #document; #callbacks; #dialog; #body; #closeButton; #generate; #cancel; #test; #refresh;
    #tasks = []; #measurements; #measurementSection; #recipient; #scope; #setup; #status; #error; #preview; #facts; #output; #result; #flags; #evidence;
    #lifetime = new AbortController(); #disposed = false; #opened = false; #returnFocus = null;
    #state = {configured: false, hasImage: false, measurements: [], phase: 'idle'};
    #task = 'explain-series'; #selected = new Set(); #snapshot = null; #stale = false; #localError = ''; #measurementKey = ''; #factKey = ''; #generation = 0;
    #workflowPanel = null; #workflowRoot; #explainRoot; #modes = []; #mode = 'explain'; #signIn; #authNotice;

    constructor(root, callbacks = {}) {
        if (!root?.ownerDocument?.createElement || typeof root.append !== 'function') throw new TypeError('Mount AI Assist in a DOM element.');
        this.#root = root; this.#document = root.ownerDocument; this.#callbacks = callbacks; this.#mount(); this.#render();
    }
    #node(tag, className, value) {
        const node = this.#document.createElement(tag); if (className) node.className = className; if (value != null) node.textContent = value; return node;
    }
    #button(label, action, className = 'ai-assist-button') {
        const node = this.#node('button', className, label); node.type = 'button'; node.dataset.aiAction = action; return node;
    }
    #mount() {
        const id = `easi-ai-assist-${++nextId}`;
        this.#dialog = this.#node('dialog', 'ai-assist'); this.#dialog.id = id; this.#dialog.setAttribute('aria-labelledby', `${id}-title`); this.#dialog.setAttribute('aria-describedby', `${id}-description`);
        const header = this.#node('header', 'ai-assist-header'), heading = this.#node('div');
        heading.append(this.#node('span', 'ai-assist-eyebrow', 'CONNECTED ASSISTANCE'));
        const title = this.#node('h2', 'ai-assist-title', 'AI Assist'); title.id = `${id}-title`; title.append(this.#node('span', 'ai-assist-preview-badge', 'Preview'));
        const description = this.#node('p', 'ai-assist-description', this.#callbacks.workflow ? 'Describe a viewing task, review the proposed steps, then run it. Or explore image facts and measurements.' : 'Understand series metadata. Draft summaries of measurements you choose.'); description.id = `${id}-description`;
        heading.append(title, description); this.#closeButton = this.#button('×', 'close', 'ai-assist-close'); this.#closeButton.setAttribute('aria-label', 'Close AI Assist'); header.append(heading, this.#closeButton);
        this.#body = this.#node('div', 'ai-assist-body'); this.#recipient = this.#node('div', 'ai-assist-recipient');
        this.#setup = this.#node('section', 'ai-assist-setup'); this.#setup.append(this.#node('h3', '', 'Connect your AI service'), this.#node('p', '', 'Your application can configure an AI gateway and model. Provider credentials stay on the server. No request is made until you explicitly use an AI action.'));
        const taskSection = this.#node('section', 'ai-assist-section'); taskSection.append(this.#node('h3', 'ai-assist-section-title', 'Choose an action'));
        const taskGroup = this.#node('div', 'ai-assist-tasks'); taskGroup.setAttribute('role', 'group'); taskGroup.setAttribute('aria-label', 'AI action');
        for (const task of TASKS) {
            const button = this.#button('', 'task', 'ai-assist-task'); button.dataset.aiTask = task.id;
            button.append(this.#node('strong', '', task.label), this.#node('span', '', task.description)); this.#tasks.push(button); taskGroup.append(button);
        }
        taskSection.append(taskGroup);
        this.#measurementSection = this.#node('section', 'ai-assist-section ai-assist-measurement-section'); this.#measurementSection.append(this.#node('h3', 'ai-assist-section-title', 'Choose measurements'));
        this.#measurements = this.#node('div', 'ai-assist-measurements'); this.#measurementSection.append(this.#measurements);
        const scopeSection = this.#node('section', 'ai-assist-section'), scopeHeader = this.#node('div', 'ai-assist-section-heading');
        scopeHeader.append(this.#node('h3', 'ai-assist-section-title', 'Review the context')); this.#refresh = this.#button('Use current selection', 'refresh', 'ai-assist-button ai-assist-refresh'); scopeHeader.append(this.#refresh);
        this.#scope = this.#node('p', 'ai-assist-scope'); this.#facts = this.#node('div', 'ai-assist-facts');
        const details = this.#node('details', 'ai-assist-wire'); details.append(this.#node('summary', '', 'Exact context sent to the gateway'));
        this.#preview = this.#node('pre', 'ai-assist-context'); this.#preview.tabIndex = 0; this.#preview.setAttribute('aria-label', 'Exact AI request JSON'); details.append(this.#preview);
        scopeSection.append(scopeHeader, this.#scope, this.#facts, details);
        const privacy = this.#node('p', 'ai-assist-privacy', 'Only the technical metadata and selected measurement facts shown here are sent. Image files and pixels are not sent. This assistant does not interpret image pixels.');
        this.#status = this.#node('p', 'ai-assist-status'); this.#status.setAttribute('role', 'status'); this.#status.setAttribute('aria-live', 'polite');
        this.#error = this.#node('p', 'ai-assist-error'); this.#error.setAttribute('role', 'alert');
        this.#result = this.#node('section', 'ai-assist-result'); this.#result.append(this.#node('h3', 'ai-assist-section-title', 'Unverified draft'), this.#node('p', 'ai-assist-draft-note', 'Review the draft against the viewer facts. Generated prose does not change images, measurements or findings.'));
        this.#flags = this.#node('div', 'ai-assist-flags'); this.#output = this.#node('pre', 'ai-assist-output'); this.#output.tabIndex = 0; this.#output.setAttribute('aria-label', 'Unverified AI draft');
        this.#evidence = this.#node('div', 'ai-assist-evidence'); this.#evidence.setAttribute('aria-label', 'Draft source evidence'); this.#result.append(this.#flags, this.#output, this.#evidence);
        this.#explainRoot = this.#node('div', 'ai-assist-explain'); this.#explainRoot.id = `${id}-explain`; this.#explainRoot.append(taskSection, this.#measurementSection, scopeSection, privacy, this.#result);
        this.#authNotice = this.#node('p', 'ai-assist-auth-notice'); this.#authNotice.setAttribute('role', 'status'); this.#authNotice.setAttribute('aria-live', 'polite');
        this.#body.append(this.#recipient, this.#authNotice, this.#setup);
        if (this.#callbacks.workflow) {
            this.#mode = 'tasks';
            const tabs = this.#node('nav', 'ai-assist-modes'); tabs.setAttribute('aria-label', 'AI Assist workspace'); tabs.setAttribute('role', 'tablist');
            for (const [mode, label] of [['tasks', 'Tasks'], ['explain', 'Explain']]) {
                const button = this.#button(label, 'mode', 'ai-assist-button ai-assist-mode'); button.dataset.aiMode = mode; button.id = `${id}-tab-${mode}`; button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', `${id}-${mode}`); this.#modes.push(button); tabs.append(button);
            }
            this.#workflowRoot = this.#node('div', 'ai-assist-workflow'); this.#workflowRoot.id = `${id}-tasks`; this.#workflowRoot.setAttribute('role', 'tabpanel'); this.#workflowRoot.setAttribute('aria-labelledby', `${id}-tab-tasks`);
            this.#explainRoot.setAttribute('role', 'tabpanel'); this.#explainRoot.setAttribute('aria-labelledby', `${id}-tab-explain`);
            this.#workflowPanel = new AiWorkflowPanel(this.#workflowRoot, this.#callbacks.workflow);
            this.#body.append(tabs, this.#workflowRoot);
        }
        this.#body.append(this.#explainRoot, this.#status, this.#error);
        const footer = this.#node('footer', 'ai-assist-footer');
        this.#signIn = this.#node('a', 'ai-assist-button ai-assist-sign-in', 'Sign in to AI ↗');
        this.#signIn.setAttribute('target', '_blank'); this.#signIn.setAttribute('rel', 'noopener noreferrer'); this.#signIn.setAttribute('referrerpolicy', 'no-referrer'); this.#signIn.setAttribute('aria-label', 'Sign in to AI (opens in a new tab)');
        this.#test = this.#button('Test connection', 'test'); this.#cancel = this.#button('Cancel request', 'cancel'); this.#generate = this.#button('Generate', 'generate', 'ai-assist-button ai-assist-generate'); footer.append(this.#signIn, this.#test, this.#cancel, this.#generate);
        this.#dialog.append(header, this.#body, footer); this.#root.append(this.#dialog);
        const signal = this.#lifetime.signal;
        this.#dialog.addEventListener('click', event => {
            let node = event.target; while (node && node !== this.#dialog) { if (node.dataset?.aiAction) { if (!node.disabled) this.#action(node.dataset); return; } node = node.parentNode; }
        }, {signal});
        this.#dialog.addEventListener('change', event => {
            const input = event.target; if (!input?.dataset?.aiMeasurement || this.#busy()) return;
            if (input.checked) this.#selected.add(input.dataset.aiMeasurement); else this.#selected.delete(input.dataset.aiMeasurement);
            this.#capture(true);
        }, {signal});
        this.#dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); }, {signal});
        this.#dialog.addEventListener('close', () => { if (this.#opened && !this.#dialog.open) this.close(); }, {signal});
        this.#dialog.addEventListener('keydown', event => {
            event.stopPropagation();
            if (this.#modes.includes(event.target) && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                event.preventDefault(); if (this.#busy()) return;
                const index = event.key === 'Home' ? 0 : event.key === 'End' ? this.#modes.length - 1 : (this.#modes.indexOf(event.target) + (event.key === 'ArrowRight' ? 1 : -1) + this.#modes.length) % this.#modes.length;
                this.#selectMode(this.#modes[index].dataset.aiMode); this.#modes[index].focus({preventScroll: true});
            }
        }, {signal});
    }
    #busy() { return this.#state.busy === true || this.#state.workflow?.busy === true || this.#state.recording === true || this.#state.phase === 'generating' || this.#state.phase === 'testing'; }
    #selectMode(mode) { if (!['tasks', 'explain'].includes(mode) || mode === this.#mode) return; this.#mode = mode; if (mode === 'explain') this.#capture(true); this.#render(); }
    #invoke(name, ...args) {
        const generation = this.#generation;
        try { const result = this.#callbacks[name]?.(...args); if (result?.then) Promise.resolve(result).catch(error => { if (generation === this.#generation) this.#showError(error); }); return result; }
        catch (error) { this.#showError(error); }
    }
    #showError(error) { if (!this.#disposed && this.#opened && error?.name !== 'AbortError') { this.#localError = text(error?.message || 'The AI action could not finish.').slice(0, 1000); this.#state = {...this.#state, phase: 'error', busy: false}; this.#render(); } }
    #action(data) {
        if (this.#disposed || !this.#opened) return;
        if (data.aiAction === 'close') { this.close(); return; }
        if (data.aiAction === 'cancel') { this.#generation++; this.#invoke('onCancel'); this.#state = {...this.#state, phase: 'cancelled', busy: false}; this.#render(); return; }
        if (this.#busy()) return;
        if (data.aiAction === 'mode') { this.#selectMode(data.aiMode); return; }
        if (data.aiAction === 'task') {
            if (!TASKS.some(task => task.id === data.aiTask) || this.#task === data.aiTask) return;
            this.#task = data.aiTask; this.#capture(true); return;
        }
        if (data.aiAction === 'refresh') { this.#capture(true); return; }
        if (data.aiAction === 'test') { if (this.#state.configured) { this.#localError = ''; this.#state = {...this.#state, phase: 'testing', text: '', result: null}; this.#render(); this.#invoke('onTestConnection'); } return; }
        if (data.aiAction === 'generate') {
            if (!this.#canGenerate()) return;
            this.#localError = ''; this.#state = {...this.#state, phase: 'generating', text: '', result: null}; this.#render(); this.#invoke('onGenerate', this.#snapshot); return;
        }
        if (data.aiAction === 'evidence' && !this.#stale && list(this.#snapshot?.evidence).some(entry => entry.id === data.aiEvidence)) this.#invoke('onNavigateEvidence', data.aiEvidence, this.#snapshot);
    }
    #capture(changed = false) {
        this.#generation++; this.#localError = ''; this.#snapshot = null; this.#stale = false;
        this.#state = {...this.#state, text: '', result: null, error: null, connectionStatus: ''};
        if (changed) this.#invoke('onSelectionChange', {task: this.#task, selectedMeasurementIds: [...this.#selected]});
        if (this.#state.configured && this.#state.hasImage && (this.#task !== 'summarize-measurements' || this.#selected.size)) {
            try { this.#snapshot = this.#callbacks.getSnapshot?.(this.#task, [...this.#selected]) ?? null; }
            catch (error) { this.#localError = text(error?.message || 'This context could not be prepared.').slice(0, 1000); }
        }
        this.#render();
    }
    #canGenerate() { return Boolean(this.#state.configured && this.#state.hasImage && typeof this.#callbacks.onGenerate === 'function' && !this.#busy() && !this.#stale && this.#snapshot?.request && (this.#task !== 'summarize-measurements' || this.#selected.size)); }
    #renderMeasurements() {
        this.#measurementSection.hidden = this.#task !== 'summarize-measurements';
        const choices = list(this.#state.measurements), key = JSON.stringify(choices.map(item => [item.id, item.label]));
        if (key !== this.#measurementKey) {
            this.#measurementKey = key; const nodes = [];
            for (const choice of choices) {
                const label = this.#node('label', 'ai-assist-measurement'), input = this.#node('input'); input.type = 'checkbox'; input.dataset.aiMeasurement = text(choice.id); input.checked = this.#selected.has(text(choice.id));
                label.append(input, this.#node('span', '', text(choice.label).slice(0, 600))); nodes.push(label);
            }
            if (!nodes.length) nodes.push(this.#node('p', 'ai-assist-empty', 'Create a supported measurement first, then choose it here.'));
            this.#measurements.replaceChildren(...nodes);
        }
        for (const label of this.#measurements.children) for (const node of label.children ?? []) if (node.dataset?.aiMeasurement) { node.checked = this.#selected.has(node.dataset.aiMeasurement); node.disabled = this.#busy(); }
    }
    #renderFacts() {
        const facts = list(this.#snapshot?.request?.facts), key = JSON.stringify([this.#task, facts]); if (key === this.#factKey) return; this.#factKey = key; this.#facts.replaceChildren();
        if (!facts.length) { this.#facts.append(this.#node('p', 'ai-assist-empty', this.#task === 'summarize-measurements' ? 'Select measurements to preview their exact facts.' : 'Open an image to prepare technical metadata.')); return; }
        const table = this.#node('table', 'ai-assist-fact-table'), caption = this.#node('caption', '', 'Authoritative viewer facts'); table.append(caption);
        const head = this.#node('thead'), headings = this.#node('tr'); for (const label of ['Source', 'Property', 'Value']) { const cell = this.#node('th', '', label); cell.setAttribute('scope', 'col'); headings.append(cell); } head.append(headings); table.append(head);
        const body = this.#node('tbody');
        for (const fact of facts) {
            const row = this.#node('tr'); row.dataset.aiFact = text(fact.id);
            const formatted = this.#callbacks.formatFact?.(fact) ?? formatAiFact(fact);
            const value = Array.isArray(fact.value) ? fact.value.join(' × ') : text(fact.value);
            row.append(this.#node('td', 'ai-assist-fact-id', text(fact.id)), this.#node('td', '', `${fact.group ? `${fact.group} · ` : ''}${formatted?.label ?? text(fact.code).replaceAll('_', ' ')}`), this.#node('td', '', `${formatted?.value ?? value}${formatted?.unit ?? fact.unit ? ` ${formatted?.unit ?? fact.unit}` : ''}`)); body.append(row);
        }
        table.append(body); this.#facts.append(table);
    }
    #renderStatus() {
        const phase = this.#state.phase;
        this.#status.textContent = phase === 'generating' ? 'Sending the reviewed metadata and measurement facts. Receiving a draft…' : phase === 'testing' ? 'Testing the connection with synthetic facts only…' : phase === 'cancelled' ? 'Request canceled. No result was applied.' : phase === 'complete' ? (this.#state.connectionStatus || (this.#state.result?.connectionTest ? 'Connection succeeded using synthetic facts. No image context was sent.' : 'Draft received. Review it against the viewer facts.')) : text(this.#state.connectionStatus);
        this.#status.hidden = !this.#status.textContent;
        this.#error.textContent = this.#localError || text(this.#state.error?.message ?? this.#state.error); this.#error.hidden = !this.#error.textContent;
    }
    #renderResult() {
        const result = this.#state.result, output = this.#state.phase === 'testing' || result?.connectionTest ? '' : text(this.#state.text ?? result?.text).slice(0, MAX_TEXT);
        this.#result.hidden = !output && this.#state.phase !== 'generating'; this.#output.textContent = output || (this.#state.phase === 'generating' ? 'Waiting for the model…' : '');
        this.#flags.replaceChildren();
        if (list(result?.numericWarnings).length) this.#flags.append(this.#node('p', 'ai-assist-validation-warning', 'Some numeric statements could not be matched to the supplied facts. Check every value and unit in the authoritative table.'));
        if (list(result?.unknownEvidenceIds).length) this.#flags.append(this.#node('p', 'ai-assist-validation-warning', 'Some source references were not supplied by the viewer and cannot be opened.'));
        this.#evidence.replaceChildren();
        const ids = list(result?.evidenceIds), entries = list(this.#snapshot?.evidence);
        for (const id of ids) {
            const entry = entries.find(item => item.id === id); if (!entry) continue;
            const button = this.#button(`${id} · ${text(entry.label).slice(0, 200)}`, 'evidence', 'ai-assist-button ai-assist-evidence-button'); button.dataset.aiEvidence = id; button.disabled = this.#stale; this.#evidence.append(button);
        }
    }
    #render() {
        if (this.#disposed) return;
        const configured = this.#state.configured === true, profile = this.#state.profile ?? {}, busy = this.#busy();
        let signInUrl = null;
        if (configured && profile.signInUrl) { try { signInUrl = normalizeAiSignInUrl(profile.signInUrl, profile.baseUrl); } catch { /* An invalid host URL must never become a link. */ } }
        this.#signIn.hidden = !signInUrl;
        if (signInUrl) this.#signIn.setAttribute('href', signInUrl); else this.#signIn.removeAttribute('href');
        const unauthorized = this.#state.error?.code === 'unauthorized' || this.#state.workflow?.error?.code === 'unauthorized';
        this.#authNotice.hidden = !signInUrl || !unauthorized;
        this.#authNotice.textContent = this.#authNotice.hidden ? '' : 'AI access needs sign-in. Choose Sign in to AI below. After signing in, close that new tab and retry here. Your open images and task stay in this tab; refreshing the viewer does not renew AI access.';
        this.#explainRoot.hidden = this.#mode !== 'explain'; if (this.#workflowRoot) this.#workflowRoot.hidden = this.#mode !== 'tasks';
        for (const tab of this.#modes) { tab.setAttribute('aria-selected', tab.dataset.aiMode === this.#mode ? 'true' : 'false'); tab.tabIndex = tab.dataset.aiMode === this.#mode ? 0 : -1; tab.disabled = busy; }
        this.#workflowPanel?.update({...this.#state.workflow, configured, busy: this.#state.workflow?.busy === true || ['generating', 'testing'].includes(this.#state.phase)});
        this.#setup.hidden = configured; this.#recipient.replaceChildren();
        if (configured) this.#recipient.append(this.#node('strong', '', text(profile.label) || 'Configured AI service'), this.#node('span', '', `Model: ${text(profile.model) || 'Configured by your application'}`), this.#node('span', '', `Recipient: ${text(profile.recipient) || 'Host AI gateway'}`));
        else this.#recipient.append(this.#node('strong', '', 'AI is not connected'), this.#node('span', '', 'Ordinary image viewing remains available.'));
        for (const task of this.#tasks) { task.setAttribute('aria-pressed', task.dataset.aiTask === this.#task ? 'true' : 'false'); task.disabled = busy; }
        this.#renderMeasurements();
        this.#scope.textContent = this.#stale ? 'The viewing context changed. Use current selection to review a new context before sending.' : this.#snapshot ? `Captured context: ${text(this.#snapshot.label) || 'Selected image'}. It stays fixed while you browse frames.` : 'No context is prepared for sending.';
        this.#scope.dataset.stale = this.#stale ? 'true' : 'false';
        this.#preview.textContent = this.#snapshot?.request ? JSON.stringify(this.#snapshot.request) : '';
        this.#renderFacts(); this.#renderResult(); this.#renderStatus();
        this.#generate.hidden = this.#mode !== 'explain'; this.#generate.disabled = !this.#canGenerate(); this.#refresh.disabled = busy || !configured || !this.#state.hasImage;
        this.#test.disabled = busy || !configured || typeof this.#callbacks.onTestConnection !== 'function'; this.#cancel.hidden = !busy || this.#mode === 'tasks'; this.#cancel.disabled = !busy;
        this.#dialog.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
    update(state = {}) {
        if (this.#disposed) return;
        const previous = this.#state; this.#state = {...this.#state, ...state};
        const eligible = new Set(list(this.#state.measurements).map(item => text(item.id)));
        let removed = false; for (const id of this.#selected) if (!eligible.has(id)) { this.#selected.delete(id); removed = true; }
        if (this.#snapshot && (removed || this.#state.configured !== true || !this.#state.hasImage || previous.contextKey !== this.#state.contextKey || previous.revision !== this.#state.revision)) this.#stale = true;
        this.#render();
    }
    /** The host cancels its owned request first, then clears source-bound UI.
     * Invalidation never prepares or sends replacement patient context. */
    invalidate() {
        if (this.#disposed) return;
        this.#generation++; this.#snapshot = null; this.#selected.clear(); this.#stale = true; this.#localError = '';
        this.#state = {...this.#state, text: '', result: null, error: null, phase: 'idle', busy: false, connectionStatus: ''}; this.#render();
    }
    open() {
        if (this.#disposed || this.#opened) return;
        this.#returnFocus = this.#root.getRootNode?.()?.activeElement ?? this.#document.activeElement; this.#opened = true;
        if (this.#workflowPanel) this.#mode = 'tasks';
        if (this.#mode === 'explain') this.#capture(); else this.#render();
        if (!this.#dialog.open) { if (typeof this.#dialog.showModal === 'function') this.#dialog.showModal(); else { this.#dialog.open = true; this.#dialog.setAttribute('open', ''); } }
        this.#closeButton.focus({preventScroll: true});
    }
    close() {
        if (this.#disposed || !this.#opened) return;
        this.#opened = false; this.#generation++; this.#workflowPanel?.clear(); this.#invoke('onCancel');
        if (this.#dialog.open && typeof this.#dialog.close === 'function') this.#dialog.close(); else { this.#dialog.open = false; this.#dialog.removeAttribute('open'); }
        this.#snapshot = null; this.#selected.clear(); this.#state = {...this.#state, text: '', result: null, error: null, phase: 'idle', busy: false, connectionStatus: ''}; this.#invoke('onClose');
        const focus = this.#returnFocus; this.#returnFocus = null; if (focus?.isConnected !== false) focus?.focus?.({preventScroll: true});
    }
    isOpen() { return this.#opened && !this.#disposed; }
    cancelRecording() { this.#workflowPanel?.cancelRecording(); }
    clearWorkflow() { this.#workflowPanel?.clear(); }
    dispose() { if (this.#disposed) return; this.close(); this.#workflowPanel?.dispose(); this.#disposed = true; this.#lifetime.abort(); this.#dialog.remove(); this.#callbacks = {}; this.#snapshot = null; this.#selected.clear(); }
}

export default AiAssistPanel;
