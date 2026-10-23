import { AI_ERROR_CODES, MAX_AI_OUTPUT_BYTES, aiByteLength, aiError, isAiModelLabel, validateAiDraft, validateAiRequest } from './protocol.js';

const snapshot = value => JSON.parse(JSON.stringify(value));
const initial = () => ({ phase: 'idle', request: null, contextKey: null, revision: null, text: '', result: null, error: null });

/** Per-viewer transient drafts. The host supplies and invalidates the local source binding. */
export class AiController {
    #client; #onChange; #state = initial(); #generation = 0; #abort = null; #disposed = false;
    constructor({ client = null, onChange = () => {} } = {}) {
        if (client != null && (typeof client.generate !== 'function' || typeof client.connectionTest !== 'function') || typeof onChange !== 'function') throw aiError('invalid-request');
        this.#client = client; this.#onChange = onChange;
    }
    getState() { return snapshot(this.#state); }
    #emit() { if (!this.#disposed) { try { this.#onChange(this.getState()); } catch { /* A host UI callback cannot retain an active request. */ } } }
    prepare({ request, contextKey, revision } = {}) {
        if (this.#disposed) return null;
        const checked = validateAiRequest(request);
        if (checked.task === 'connection-test' || typeof contextKey !== 'string' || !contextKey || contextKey.length > 2048 ||
            !['string', 'number'].includes(typeof revision) || typeof revision === 'number' && !Number.isFinite(revision) || typeof revision === 'string' && revision.length > 2048) throw aiError('invalid-request');
        this.#stop();
        this.#state = { ...initial(), phase: 'ready', request: checked, contextKey, revision };
        this.#emit(); return this.getState();
    }
    async generate() {
        if (this.#disposed || !this.#client) throw aiError('unavailable', 'Configure an AI gateway before generating a draft.');
        if (this.#abort) throw aiError('busy');
        if (!this.#state.request) throw aiError('invalid-request', 'Select and prepare AI context first.');
        return this.#run(false);
    }
    async test() {
        if (this.#disposed || !this.#client) throw aiError('unavailable', 'Configure an AI gateway before testing the connection.');
        if (this.#abort) throw aiError('busy');
        return this.#run(true);
    }
    async #run(testing) {
        const generation = ++this.#generation, controller = new AbortController(); this.#abort = controller;
        const request = this.#state.request ? snapshot(this.#state.request) : null;
        this.#state = { ...this.#state, phase: testing ? 'testing' : 'generating', text: '', result: null, error: null };
        this.#emit();
        const current = () => !this.#disposed && generation === this.#generation && !controller.signal.aborted;
        try {
            const options = { signal: controller.signal, onDelta: delta => {
                if (!current()) return;
                if (typeof delta !== 'string' || aiByteLength(this.#state.text) + aiByteLength(delta) > MAX_AI_OUTPUT_BYTES || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(delta)) throw aiError('invalid-response');
                this.#state.text += delta; this.#emit();
            } };
            const result = await (testing ? this.#client.connectionTest(options) : this.#client.generate(request, options));
            if (!current()) return null;
            const validated = testing ? { ...validateAiDraft(result.text, []), connectionTest: true } : validateAiDraft(result.text, request.facts);
            if (result.model != null) {
                if (!isAiModelLabel(result.model)) throw aiError('invalid-response');
                validated.model = result.model;
            }
            this.#state = { ...this.#state, phase: 'complete', text: validated.text, result: validated, error: null };
            this.#emit(); return snapshot(validated);
        } catch (error) {
            if (!current()) return null;
            const controlled = [...AI_ERROR_CODES, 'cancelled', 'busy'].includes(error?.code) ? aiError(error.code) : aiError('unavailable');
            this.#state = { ...this.#state, phase: 'error', text: '', result: null, error: { code: controlled.code, message: controlled.message } };
            this.#emit(); return null;
        } finally { if (this.#abort === controller) this.#abort = null; }
    }
    #stop() { ++this.#generation; this.#abort?.abort(aiError('cancelled')); this.#abort = null; }
    cancel() {
        if (this.#disposed) return;
        this.#stop(); this.#state = { ...this.#state, phase: 'cancelled', text: '', result: null, error: null }; this.#emit();
    }
    invalidate() { this.clear(); }
    clear() { if (this.#disposed) return; this.#stop(); this.#state = initial(); this.#emit(); }
    dispose() { this.#stop(); this.#state = initial(); this.#disposed = true; this.#onChange = () => {}; }
}
