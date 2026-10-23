import { AI_ERROR_CODES, AI_TIMEOUT_MS, MAX_AI_OUTPUT_BYTES, aiByteLength, aiError, isAiModelLabel, validateAiRequest } from './protocol.js';
import {validateWorkflowRequest, validateWorkflowPlanResponse, validateTranscriptionRequest, validateTranscriptionResponse} from './workflow-protocol.js';

/** Endpoint policy is independent of provider credentials, which belong to the gateway. */
export function normalizeAiBaseUrl(value, base = globalThis.location?.href) {
    if (typeof value !== 'string' || !value || value.length > 2048) throw aiError('invalid-request', 'Configure an AI gateway URL.');
    let url;
    try { url = base ? new URL(value, base) : new URL(value); } catch { throw aiError('invalid-request', 'The AI gateway URL is invalid.'); }
    if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol) ||
        url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
        throw aiError('invalid-request', 'The AI gateway requires HTTPS, or a loopback URL for local development.');
    }
    return url.href.replace(/\/+$/, '');
}

/** An explicit host-owned login page, never a model/server-error redirect. */
export function normalizeAiSignInUrl(value, baseUrl) {
    if (!baseUrl || typeof value !== 'string' || /[\x00-\x20\x7f]/.test(value)) throw aiError('invalid-request', 'Configure a sign-in page on the AI gateway origin.');
    const gateway = normalizeAiBaseUrl(baseUrl);
    const url = normalizeAiBaseUrl(value, `${gateway}/`);
    if (new URL(url).origin !== new URL(gateway).origin) throw aiError('invalid-request', 'The AI sign-in page must use the gateway origin.');
    return url;
}

/** A host's display preference, not a claim of clinical superiority. Stays local. */
export function normalizeWorkflowPreferences(input) {
    if (input == null) return { routineCt: 'no-preference' };
    if (typeof input !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(input)) ||
        Reflect.ownKeys(input).some(key => key !== 'routineCt' || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), 'value')) ||
        !['no-preference', 'blended'].includes(input.routineCt)) throw aiError('invalid-request', 'Choose a supported local CT reading preference.');
    return { routineCt: input.routineCt };
}

/** Host configuration is local presentation/transport state, never part of AI context. */
export function normalizeAiConfiguration(input) {
    if (input == null || input === false) return { enabled: false, configured: false, baseUrl: null, label: 'AI service', recipient: null, model: null, credentials: 'omit' };
    if (typeof input !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).some(key => typeof key !== 'string' ||
        !['enabled', 'configured', 'baseUrl', 'label', 'recipient', 'model', 'getHeaders', 'timeoutMs', 'credentials', 'workflows', 'signInUrl', 'workflowPreferences'].includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), 'value'))) throw aiError('invalid-request', 'The AI configuration contains unsupported settings.');
    if (input.workflows != null && typeof input.workflows !== 'boolean' || input.enabled != null && typeof input.enabled !== 'boolean' || input.configured != null && typeof input.configured !== 'boolean' || input.getHeaders != null && typeof input.getHeaders !== 'function' ||
        input.credentials != null && !['omit', 'same-origin'].includes(input.credentials) || input.timeoutMs != null && (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > AI_TIMEOUT_MS)) throw aiError('invalid-request', 'The AI configuration is invalid.');
    const label = (value, fallback) => {
        if (value == null) return fallback;
        if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\x00-\x1F\x7F]/.test(value)) throw aiError('invalid-request', 'AI connection labels must be short plain text.');
        return value.trim();
    };
    const baseUrl = input.baseUrl == null || input.baseUrl === '' ? null : normalizeAiBaseUrl(input.baseUrl);
    if (input.model != null && !isAiModelLabel(input.model)) throw aiError('invalid-request', 'The AI model label is invalid.');
    return { enabled: input.enabled ?? true, configured: !!baseUrl, baseUrl, label: label(input.label, 'AI service'),
        recipient: label(input.recipient, baseUrl ? new URL(baseUrl).hostname : null), model: input.model ?? null, credentials: input.credentials ?? 'omit',
        ...(input.workflowPreferences != null ? { workflowPreferences: normalizeWorkflowPreferences(input.workflowPreferences) } : {}),
        ...(input.signInUrl != null ? { signInUrl: normalizeAiSignInUrl(input.signInUrl, baseUrl) } : {}), ...(input.workflows != null ? { workflows: input.workflows } : {}), ...(input.getHeaders ? { getHeaders: input.getHeaders } : {}), ...(input.timeoutMs != null ? { timeoutMs: input.timeoutMs } : {}) };
}

function checkedHeaders(input) {
    const headers = new Headers({ Accept: 'application/x-ndjson', 'Content-Type': 'application/json' });
    if (input == null) return headers;
    let extra;
    try { extra = new Headers(input); } catch { throw aiError('unauthorized'); }
    if (aiByteLength(JSON.stringify([...extra])) > 8192 || [...extra].length > 16) throw aiError('unauthorized');
    for (const [name, value] of extra) {
        // The host may provide short-lived gateway authorization, never alter transport policy.
        if (!['authorization', 'x-easi-ai-token', 'x-csrf-token'].includes(name) && !/^x-[a-z0-9-]{1,60}$/.test(name)) throw aiError('unauthorized');
        headers.set(name, value);
    }
    return headers;
}
function responseError(status) {
    return aiError(status === 401 || status === 403 ? 'unauthorized' : status === 429 ? 'rate-limited'
        : status === 409 ? 'configuration-changed' : status === 400 || status === 413 ? 'invalid-request' : status === 502 ? 'provider-error' : status === 504 ? 'timeout' : 'unavailable');
}
function controlledError(error) { return aiError([...AI_ERROR_CODES, 'cancelled', 'busy'].includes(error?.code) ? error.code : 'unavailable'); }
function checkEvent(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw aiError('invalid-response');
    const allowed = event.type === 'delta' ? ['type', 'text'] : event.type === 'done' ? ['type', 'model'] : event.type === 'error' ? ['type', 'code'] : [];
    if (!allowed.length || Object.keys(event).some(key => !allowed.includes(key))) throw aiError('invalid-response');
    if (event.type === 'delta' && (typeof event.text !== 'string' || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(event.text)) ||
        event.type === 'done' && event.model != null && !isAiModelLabel(event.model) || event.type === 'error' && !AI_ERROR_CODES.includes(event.code)) throw aiError('invalid-response');
    return event;
}

/** One bounded NDJSON job. No automatic requests, redirects, retries, storage or logging. */
export class AiClient {
    #baseUrl; #fetch; #getHeaders; #timeoutMs; #credentials; #model; #active = null;
    constructor({ baseUrl, getHeaders, timeoutMs = AI_TIMEOUT_MS, credentials = 'omit', model = null } = {}, { fetchImpl = globalThis.fetch } = {}) {
        this.#baseUrl = normalizeAiBaseUrl(baseUrl);
        if (model != null && !isAiModelLabel(model) || typeof fetchImpl !== 'function' || getHeaders != null && typeof getHeaders !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > AI_TIMEOUT_MS || !['omit', 'same-origin'].includes(credentials)) throw aiError('invalid-request');
        this.#fetch = fetchImpl; this.#getHeaders = getHeaders; this.#timeoutMs = timeoutMs; this.#credentials = credentials; this.#model = model;
    }
    generate(input, options) {
        const request = validateAiRequest(input);
        if (request.task === 'connection-test') throw aiError('invalid-request');
        return this.#run('/generate', request, options);
    }
    connectionTest(options) { return this.#run('/test', { version: 1, task: 'connection-test', facts: [] }, options); }
    planCommand(command, options) { return this.#runJson('/plan', validateWorkflowRequest({version: 1, task: 'plan-workflow', command,
        ...(options?.mode != null ? {mode: options.mode} : {})}), validateWorkflowPlanResponse, options); }
    transcribeCommand({mimeType, audio} = {}, options) { return this.#runJson('/transcribe', validateTranscriptionRequest({version: 1, task: 'transcribe-command', mimeType, audio}), validateTranscriptionResponse, options); }
    cancel() { this.#active?.abort(aiError('cancelled')); }
    async #runJson(path, request, validate, {signal} = {}) {
        if (this.#active) throw aiError('busy');
        if (signal != null && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw aiError('invalid-request');
        if (signal?.aborted) throw aiError('cancelled');
        const controller = new AbortController(); this.#active = controller;
        const cancel = () => controller.abort(aiError('cancelled')); signal?.addEventListener('abort', cancel, {once: true});
        let reader, timer, removeAbort;
        const abort = new Promise((_, reject) => {
            const listener = () => reject(controlledError(controller.signal.reason));
            controller.signal.addEventListener('abort', listener, {once: true}); removeAbort = () => controller.signal.removeEventListener('abort', listener);
            timer = setTimeout(() => controller.abort(aiError('timeout')), this.#timeoutMs);
        });
        const work = async () => {
            const rawHeaders = await this.#getHeaders?.({signal: controller.signal});
            if (controller.signal.aborted) throw controller.signal.reason;
            const headers = checkedHeaders(rawHeaders); headers.set('Accept', 'application/json'); headers.delete('x-easi-ai-model');
            if (this.#model) headers.set('X-Easi-Ai-Model', this.#model);
            const fetchRequest = this.#fetch;
            const response = await fetchRequest(`${this.#baseUrl}${path}`, {method: 'POST', headers, body: JSON.stringify(request), signal: controller.signal,
                credentials: this.#credentials, redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer'});
            if (controller.signal.aborted) throw controller.signal.reason;
            if (!response?.ok) throw responseError(response?.status);
            if (response.redirected || response.headers?.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || !response.body?.getReader) throw aiError('invalid-response');
            reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', {fatal: true}); let body = '', bytes = 0;
            while (true) {
                const chunk = await reader.read();
                if (controller.signal.aborted) throw controller.signal.reason;
                if (chunk.done) break;
                if (!(chunk.value instanceof Uint8Array) || (bytes += chunk.value.byteLength) > MAX_AI_OUTPUT_BYTES) throw aiError('invalid-response');
                try { body += decoder.decode(chunk.value, {stream: true}); } catch { throw aiError('invalid-response'); }
            }
            try {
                body += decoder.decode(); const value = validate(JSON.parse(body));
                if (path === '/plan' && this.#model && value.model !== this.#model) throw aiError('configuration-changed');
                return value;
            } catch (error) { throw error?.code === 'configuration-changed' ? error : aiError('invalid-response'); }
        };
        try { return await Promise.race([work(), abort]); }
        catch (error) { controller.abort(controlledError(error)); throw controlledError(controller.signal.reason); }
        finally {
            clearTimeout(timer); removeAbort?.(); signal?.removeEventListener('abort', cancel);
            try { Promise.resolve(reader?.cancel()).catch(() => {}); } catch { /* Already released. */ }
            try { reader?.releaseLock(); } catch { /* Pending read releases after cancellation. */ }
            if (this.#active === controller) this.#active = null;
        }
    }
    async #run(path, request, { signal, onDelta } = {}) {
        if (this.#active) throw aiError('busy');
        if (onDelta != null && typeof onDelta !== 'function' || signal != null && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw aiError('invalid-request');
        if (signal?.aborted) throw aiError('cancelled');
        const controller = new AbortController(); this.#active = controller;
        const cancel = () => controller.abort(aiError('cancelled'));
        signal?.addEventListener('abort', cancel, { once: true });
        let reader, timer, removeAbort;
        const abort = new Promise((_, reject) => {
            const listener = () => reject(controlledError(controller.signal.reason));
            controller.signal.addEventListener('abort', listener, { once: true });
            removeAbort = () => controller.signal.removeEventListener('abort', listener);
            timer = setTimeout(() => controller.abort(aiError('timeout')), this.#timeoutMs);
        });
        const work = async () => {
            const rawHeaders = await this.#getHeaders?.({ signal: controller.signal });
            if (controller.signal.aborted) throw controller.signal.reason;
            const headers = checkedHeaders(rawHeaders);
            // This identifies the profile the user reviewed; it never selects a model.
            headers.delete('x-easi-ai-model');
            if (this.#model) headers.set('X-Easi-Ai-Model', this.#model);
            // Native browser fetch must not receive this AiClient as its receiver.
            const fetchRequest = this.#fetch;
            const response = await fetchRequest(`${this.#baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(request),
                signal: controller.signal, credentials: this.#credentials, redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' });
            if (controller.signal.aborted) throw controller.signal.reason;
            if (!response?.ok) throw responseError(response?.status);
            if (response.redirected || response.headers?.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/x-ndjson' || !response.body?.getReader) throw aiError('invalid-response');
            reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8', { fatal: true });
            let buffer = '', text = '', outputBytes = 0, wireBytes = 0, done = false, model;
            const eventLine = line => {
                if (!line.trim()) return;
                if (done) throw aiError('invalid-response');
                let event;
                try { event = checkEvent(JSON.parse(line)); } catch (error) { throw error?.code ? error : aiError('invalid-response'); }
                if (event.type === 'error') throw aiError(event.code);
                if (event.type === 'done') { done = true; model = event.model; return; }
                outputBytes += aiByteLength(event.text);
                if (outputBytes > MAX_AI_OUTPUT_BYTES) throw aiError('invalid-response', 'The AI draft exceeded its output limit.');
                text += event.text;
                if (!controller.signal.aborted) onDelta?.(event.text);
            };
            while (true) {
                const chunk = await reader.read();
                if (controller.signal.aborted) throw controller.signal.reason;
                if (chunk.done) break;
                if (!(chunk.value instanceof Uint8Array)) throw aiError('invalid-response');
                wireBytes += chunk.value.byteLength;
                // A token-sized NDJSON stream has more framing bytes than draft bytes.
                if (wireBytes > MAX_AI_OUTPUT_BYTES * 48) throw aiError('invalid-response');
                try { buffer += decoder.decode(chunk.value, { stream: true }); } catch { throw aiError('invalid-response'); }
                let newline;
                while ((newline = buffer.indexOf('\n')) !== -1) { eventLine(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
                if (aiByteLength(buffer) > MAX_AI_OUTPUT_BYTES * 8) throw aiError('invalid-response');
            }
            try { buffer += decoder.decode(); } catch { throw aiError('invalid-response'); }
            if (buffer.trim()) eventLine(buffer);
            if (!done || !text.trim()) throw aiError('invalid-response');
            return { text, ...(model ? { model } : {}) };
        };
        try { return await Promise.race([work(), abort]); }
        catch (error) {
            controller.abort(controlledError(error));
            throw controlledError(controller.signal.reason);
        } finally {
            clearTimeout(timer); removeAbort?.(); signal?.removeEventListener('abort', cancel);
            // Do not await a broken transport's cancellation indefinitely.
            try { Promise.resolve(reader?.cancel()).catch(() => {}); } catch { /* Resource already released. */ }
            try { reader?.releaseLock(); } catch { /* A cancelled pending read owns the lock until it settles. */ }
            if (this.#active === controller) this.#active = null;
        }
    }
}
