import { AI_ERROR_CODES, AI_TIMEOUT_MS, MAX_AI_OUTPUT_BYTES, aiError, validateAiRequest } from '../../src/ai/protocol.js';
import { modelMessages } from './provider.mjs';
import { createOpenAiWorkflowProvider } from './openai-workflow-provider.mjs';

export const DEFAULT_OPENAI_MODEL = 'gpt-6.1-sol';
const ENDPOINT = 'https://api.openai.com/v1/responses';
const TIMEOUT_MS = AI_TIMEOUT_MS - 1000;
const OUTPUT_LIMIT = MAX_AI_OUTPUT_BYTES - 2048;
const WIRE_LIMIT = MAX_AI_OUTPUT_BYTES;
const plainText = value => typeof value === 'string' && !/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value);
const validKey = value => typeof value === 'string' && /^[A-Za-z0-9._-]{16,1024}$/.test(value);
const DIAGNOSTICS = ['provider-unauthorized', 'provider-rate-limited', 'provider-timeout', 'provider-failure',
    'secret-access-denied', 'secret-timeout', 'secret-invalid', 'secret-unavailable'];

function providerError(code, diagnostic) {
    const error = aiError(code);
    if (diagnostic) error.aiDiagnostic = diagnostic;
    return error;
}

function controlledError(error) {
    const code = AI_ERROR_CODES.includes(error?.code) ? error.code : 'provider-error';
    return providerError(code, DIAGNOSTICS.includes(error?.aiDiagnostic) ? error.aiDiagnostic :
        code === 'rate-limited' ? 'provider-rate-limited' : code === 'timeout' ? 'provider-timeout' : code === 'provider-error' || code === 'invalid-response' ? 'provider-failure' : undefined);
}
function upstreamError(code) {
    return ['rate_limit_exceeded', 'insufficient_quota'].includes(code) ? providerError('rate-limited', 'provider-rate-limited') :
        ['invalid_api_key', 'authentication_error', 'permission_denied'].includes(code) ? providerError('provider-error', 'provider-unauthorized') : providerError('provider-error', 'provider-failure');
}
function checkedResponse(value, modelId, completed = false) {
    if (!value || typeof value !== 'object' || value.model !== modelId || value.error != null || value.incomplete_details != null ||
        completed && value.status !== 'completed') throw aiError('invalid-response');
    if (!completed) return;
    if (!Array.isArray(value.output)) throw aiError('invalid-response');
    let text = '';
    for (const item of value.output) {
        if (item?.type === 'reasoning') continue;
        if (item?.type !== 'message' || item.role !== 'assistant' || item.status !== 'completed' || !Array.isArray(item.content)) throw aiError('invalid-response');
        for (const part of item.content) {
            if (part?.type === 'refusal') throw aiError('provider-error');
            if (part?.type !== 'output_text' || !plainText(part.text)) throw aiError('invalid-response');
            text += part.text;
            if (Buffer.byteLength(text) > OUTPUT_LIMIT) throw aiError('invalid-response');
        }
    }
    return text;
}

/** Server-only Responses API adapter. The key is never returned, logged, stored
 * in model context, or accepted from a browser request. This narrow connector
 * uses text-only input, no tools, no conversation state and store:false. */
export function createOpenAiProvider({ apiKey, getApiKey, modelId = DEFAULT_OPENAI_MODEL, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
    if (apiKey != null && !validKey(apiKey) || getApiKey != null && typeof getApiKey !== 'function' ||
        apiKey == null && typeof getApiKey !== 'function' || apiKey != null && getApiKey != null) throw new Error('Configure a server-owned OpenAI API key or credential loader.');
    if (typeof modelId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(modelId)) throw new Error('Invalid configured OpenAI model identifier.');
    if (typeof fetchImpl !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > TIMEOUT_MS) throw new Error('Invalid OpenAI transport configuration.');
    return {
        model: modelId,
        ...createOpenAiWorkflowProvider({ apiKey, getApiKey, modelId, fetchImpl, timeoutMs }),
        async *generate(input, { signal } = {}) {
            const request = validateAiRequest(input), messages = modelMessages(request);
            if (signal != null && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw aiError('invalid-request');
            if (signal?.aborted) throw aiError('unavailable');
            const controller = new AbortController();
            const abort = () => controller.abort(aiError('unavailable'));
            signal?.addEventListener('abort', abort, { once: true });
            let reader, removeAbort, timer;
            const stopped = new Promise((_, reject) => {
                const listener = () => reject(controlledError(controller.signal.reason));
                controller.signal.addEventListener('abort', listener, { once: true });
                removeAbort = () => controller.signal.removeEventListener('abort', listener);
                timer = setTimeout(() => controller.abort(aiError('timeout')), timeoutMs);
            });
            // A consumer may pause at a yielded delta while the deadline expires.
            stopped.catch(() => {});
            const wait = promise => Promise.race([promise, stopped]);
            try {
                const key = getApiKey ? await wait(getApiKey({ signal: controller.signal })) : apiKey;
                if (controller.signal.aborted) throw controller.signal.reason;
                if (!validKey(key)) throw providerError('provider-error', 'provider-unauthorized');
                const body = { model: modelId, stream: true, store: false, reasoning: { effort: 'low' },
                    max_output_tokens: request.task === 'connection-test' ? 1024 : 4096,
                    input: [{ role: 'developer', content: [{ type: 'input_text', text: messages.system.map(item => item.text).join('\n') }] },
                        ...messages.messages.map(message => ({ role: message.role, content: message.content.map(part => ({ type: 'input_text', text: part.text })) }))],
                    tools: [], text: { format: { type: 'text' }, verbosity: 'low' }, truncation: 'disabled' };
                const upstream = Promise.resolve(fetchImpl(ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
                    body: JSON.stringify(body), signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' })).then(response => {
                    if (controller.signal.aborted) {
                        try { Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch { /* A late transport may already be closed. */ }
                        throw controller.signal.reason;
                    }
                    return response;
                });
                const response = await wait(upstream);
                if (!response?.ok) throw response?.status === 401 || response?.status === 403 ? providerError('provider-error', 'provider-unauthorized') :
                    response?.status === 429 ? providerError('rate-limited', 'provider-rate-limited') : providerError('provider-error', 'provider-failure');
                if (response.redirected || response.headers?.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'text/event-stream' || !response.body?.getReader) throw aiError('invalid-response');
                const advertised = response.headers.get('content-length');
                if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > WIRE_LIMIT)) throw aiError('invalid-response');
                reader = response.body.getReader();
                const decoder = new TextDecoder('utf-8', { fatal: true });
                let buffer = '', eventName = '', data = [], wireBytes = 0, outputBytes = 0, text = '', completed = false, sentinel = false;
                const event = () => {
                    if (!data.length) { eventName = ''; return null; }
                    const payload = data.join('\n'), named = eventName; data = []; eventName = '';
                    if (payload === '[DONE]') {
                        if (!completed || sentinel) throw aiError('invalid-response');
                        sentinel = true; return null;
                    }
                    if (completed || sentinel) throw aiError('invalid-response');
                    let value;
                    try { value = JSON.parse(payload); } catch { throw aiError('invalid-response'); }
                    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.type !== 'string' || named && named !== 'message' && named !== value.type) throw aiError('invalid-response');
                    const type = value.type;
                    if (['response.created', 'response.in_progress', 'response.queued'].includes(type)) checkedResponse(value.response, modelId);
                    else if (type === 'response.output_text.delta') {
                        if (!plainText(value.delta)) throw aiError('invalid-response');
                        outputBytes += Buffer.byteLength(value.delta);
                        if (outputBytes > OUTPUT_LIMIT) throw aiError('invalid-response');
                        text += value.delta;
                        return value.delta;
                    } else if (type === 'response.completed') {
                        const finalText = checkedResponse(value.response, modelId, true);
                        if (!text.trim() || finalText !== text) throw aiError('invalid-response');
                        completed = true;
                    } else if (type === 'error') throw upstreamError(value.code);
                    else if (type === 'response.failed') throw upstreamError(value.response?.error?.code);
                    else if (type === 'response.incomplete' || type.startsWith('response.refusal.')) throw aiError('provider-error');
                    else if (['response.output_item.added', 'response.output_item.done'].includes(type)) {
                        if (!['reasoning', 'message'].includes(value.item?.type) || value.item.type === 'message' && value.item.role !== 'assistant') throw aiError('invalid-response');
                        if (value.item.content?.some(part => part.type === 'refusal')) throw aiError('provider-error');
                    } else if (['response.content_part.added', 'response.content_part.done'].includes(type)) {
                        if (value.part?.type === 'refusal') throw aiError('provider-error');
                        if (value.part?.type !== 'output_text') throw aiError('invalid-response');
                    } else if (type === 'response.output_text.done') {
                        if (!plainText(value.text) || Buffer.byteLength(value.text) > OUTPUT_LIMIT) throw aiError('invalid-response');
                    } else if (!type.startsWith('response.reasoning_')) throw aiError('invalid-response');
                    return null;
                };
                const line = value => {
                    if (value === '') return event();
                    if (value.startsWith(':')) return null;
                    const colon = value.indexOf(':'), field = colon === -1 ? value : value.slice(0, colon);
                    let contents = colon === -1 ? '' : value.slice(colon + 1);
                    if (contents.startsWith(' ')) contents = contents.slice(1);
                    if (field === 'data') data.push(contents);
                    else if (field === 'event') eventName = contents;
                    return null;
                };
                while (true) {
                    const chunk = await wait(reader.read());
                    if (controller.signal.aborted) throw controller.signal.reason;
                    if (chunk.done) break;
                    if (!(chunk.value instanceof Uint8Array) || (wireBytes += chunk.value.byteLength) > WIRE_LIMIT) throw aiError('invalid-response');
                    try { buffer += decoder.decode(chunk.value, { stream: true }); } catch { throw aiError('invalid-response'); }
                    while (true) {
                        const separator = buffer.search(/[\r\n]/);
                        if (separator === -1 || buffer[separator] === '\r' && separator === buffer.length - 1) break;
                        const width = buffer[separator] === '\r' && buffer[separator + 1] === '\n' ? 2 : 1;
                        const delta = line(buffer.slice(0, separator)); buffer = buffer.slice(separator + width);
                        if (delta) yield delta;
                    }
                }
                try { buffer += decoder.decode(); } catch { throw aiError('invalid-response'); }
                if (buffer.endsWith('\r')) buffer = buffer.slice(0, -1);
                if (buffer) { const delta = line(buffer); if (delta) yield delta; }
                const delta = event(); if (delta) yield delta;
                if (!completed) throw aiError('invalid-response');
            } catch (error) {
                if (controller.signal.aborted) throw controlledError(controller.signal.reason);
                throw controlledError(error);
            } finally {
                clearTimeout(timer); removeAbort?.(); signal?.removeEventListener('abort', abort);
                controller.abort(aiError('unavailable'));
                try { Promise.resolve(reader?.cancel()).catch(() => {}); } catch { /* The upstream reader is already closed. */ }
                try { reader?.releaseLock(); } catch { /* A cancelled pending read releases when its transport settles. */ }
            }
        }
    };
}
