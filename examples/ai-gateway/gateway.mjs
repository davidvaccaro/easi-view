import { AI_ERROR_CODES, AI_TIMEOUT_MS, MAX_AI_OUTPUT_BYTES, MAX_AI_REQUEST_BYTES, aiError, isAiModelLabel, validateAiRequest } from '../../src/ai/protocol.js';
import { DemoSessions, MemoryQuota, digest, equalSecret } from './auth.mjs';
import { LOGIN_CSS, LOGIN_JS, renderLoginHtml } from './login.mjs';
import { reportAiDiagnostic } from './diagnostics.mjs';
import { MAX_TRANSCRIPTION_REQUEST_BYTES, MAX_WORKFLOW_REQUEST_BYTES, validateWorkflowRequest, validateWorkflowPlanResponse,
    validateTranscriptionRequest, validateTranscriptionResponse } from '../../src/ai/workflow-protocol.js';

const BASE_HEADERS = Object.freeze({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" });
const ERROR_STATUS = Object.freeze({ 'invalid-request': 400, unauthorized: 401, 'configuration-changed': 409, 'rate-limited': 429, unavailable: 503, timeout: 504, 'provider-error': 502, 'invalid-response': 502 });
const encoded = value => `${JSON.stringify(value)}\n`;
function canonicalOrigin(value) {
    try { const parsed = new URL(value); return parsed.origin === value && ['https:', 'http:'].includes(parsed.protocol) ? value : null; } catch { return null; }
}
function result(status, type, body, headers = {}) { return { status, headers: { ...BASE_HEADERS, 'Content-Type': type, ...headers }, body }; }
function failure(code, headers) { return result(ERROR_STATUS[code] ?? 503, 'application/x-ndjson; charset=utf-8', encoded({ type: 'error', code }), headers); }
function parseJson(body, max = MAX_AI_REQUEST_BYTES) {
    if (typeof body !== 'string' || Buffer.byteLength(body) > max) throw aiError('invalid-request');
    try { return JSON.parse(body); } catch { throw aiError('invalid-request'); }
}
export function aiRequestByteLimit(path) { return path === '/api/ai/transcribe' ? MAX_TRANSCRIPTION_REQUEST_BYTES : MAX_AI_REQUEST_BYTES; }

/** No prompts, patient data, bodies, model text, access codes or headers are logged. */
export class AiGateway {
    constructor({ provider, passcode, quota = new MemoryQuota(), allowedOrigins = ['http://127.0.0.1:5174'],
        secureCookies = true, originSecret, prefix = '/api/ai', now = Date.now, dailyLimit = 200, minuteLimit = 12, maxConcurrent = 2, logger, requireModelBinding = false } = {}) {
        if (!provider || typeof provider.generate !== 'function' || !isAiModelLabel(provider.model) || !Array.isArray(allowedOrigins) || allowedOrigins.some(value => !canonicalOrigin(value)) ||
            !Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 1000 || !Number.isInteger(minuteLimit) || minuteLimit < 1 || minuteLimit > 60 ||
            !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 10 || typeof requireModelBinding !== 'boolean' || prefix !== '/api/ai') throw new Error('Invalid AI gateway configuration.');
        if (originSecret != null && !/^[A-Za-z0-9_-]{24,128}$/.test(originSecret)) throw new Error('Invalid edge authentication secret.');
        this.provider = provider; this.quota = quota; this.allowedOrigins = allowedOrigins; this.originSecret = originSecret; this.prefix = prefix;
        this.sessions = new DemoSessions({ passcode, secure: secureCookies, path: prefix, now, context: provider.sessionScope ?? provider.model });
        this.logger = logger;
        this.requireModelBinding = requireModelBinding;
        this.dailyLimit = dailyLimit; this.minuteLimit = minuteLimit; this.maxConcurrent = maxConcurrent; this.active = 0;
    }
    async handle({ method = 'GET', path = '/', headers: rawHeaders = {}, body = '', ip = 'local', signal } = {}) {
        const headers = Object.fromEntries(Object.entries(rawHeaders).map(([key, value]) => [key.toLowerCase(), value]));
        if (this.originSecret && !equalSecret(headers['x-easi-origin-auth'], this.originSecret)) return failure('unauthorized');
        const edgeOrigin = this.originSecret ? canonicalOrigin(headers['x-easi-public-origin']) : null;
        if (this.originSecret && (!edgeOrigin || !edgeOrigin.startsWith('https://'))) return failure('unauthorized');
        const origin = headers.origin, allowed = edgeOrigin ? origin === edgeOrigin : this.allowedOrigins.includes(origin);
        const cors = allowed ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Credentials': 'true' } : {};
        if (origin && !allowed) return failure('unauthorized');
        if (method === 'OPTIONS') return allowed ? result(204, 'text/plain', '', { ...cors, 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Easi-Ai-Model', 'Access-Control-Max-Age': '300' }) : failure('unauthorized');
        if (method === 'GET') {
            const assets = { [`${this.prefix}/login`]: ['text/html; charset=utf-8', renderLoginHtml(this.provider)], [`${this.prefix}/login.js`]: ['text/javascript; charset=utf-8', LOGIN_JS], [`${this.prefix}/login.css`]: ['text/css; charset=utf-8', LOGIN_CSS] };
            if (assets[path]) return result(200, ...assets[path]);
            return result(404, 'text/plain', 'Not found.');
        }
        if (method !== 'POST' || !allowed || headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') return failure('invalid-request', cors);
        const identity = digest(ip).slice(0, 32);
        if (path === `${this.prefix}/login`) {
            try {
                if (!await this.quota.consume('login-global', 120, 60) || !await this.quota.consume(`login:${identity}`, 5, 60)) return failure('rate-limited', cors);
                let input;
                try { input = parseJson(body, 512); } catch { return failure('invalid-request', cors); }
                if (!input || Object.keys(input).length !== 1 || typeof input.passcode !== 'string' || !this.sessions.authenticate(input.passcode)) return failure('unauthorized', cors);
                return result(200, 'application/json', '{"authenticated":true}', { ...cors, 'Set-Cookie': this.sessions.cookie(this.sessions.issue()) });
            } catch (error) { reportAiDiagnostic(this.logger, 'login-quota-failed', error, 'quota-unavailable'); return failure('unavailable', cors); }
        }
        if (!this.sessions.accepts(headers.cookie)) return failure('unauthorized', cors);
        if (path === `${this.prefix}/logout`) return result(200, 'application/json', '{}', { ...cors, 'Set-Cookie': this.sessions.cookie('', true) });
        if (![`${this.prefix}/generate`, `${this.prefix}/test`, `${this.prefix}/plan`, `${this.prefix}/transcribe`].includes(path)) return result(404, 'text/plain', 'Not found.');
        if (this.requireModelBinding && headers['x-easi-ai-model'] !== this.provider.model) return failure('configuration-changed', cors);
        const workflow = path.endsWith('/plan') ? 'plan' : path.endsWith('/transcribe') ? 'transcribe' : null;
        let request;
        try {
            request = workflow === 'plan' ? validateWorkflowRequest(parseJson(body, MAX_WORKFLOW_REQUEST_BYTES)) :
                workflow === 'transcribe' ? validateTranscriptionRequest(parseJson(body, MAX_TRANSCRIPTION_REQUEST_BYTES)) : validateAiRequest(parseJson(body));
            if (!workflow && (path.endsWith('/test')) !== (request.task === 'connection-test')) return failure('invalid-request', cors);
        } catch { return failure('invalid-request', cors); }
        if (workflow && typeof this.provider[workflow] !== 'function') return failure('unavailable', cors);
        if (this.active >= this.maxConcurrent) return failure('rate-limited', cors);
        try {
            if (!await this.quota.consume('inference-global-day', this.dailyLimit, 86400) || !await this.quota.consume('inference-global-minute', this.minuteLimit, 60) ||
                !await this.quota.consume(`inference:${identity}`, 6, 60)) return failure('rate-limited', cors);
        } catch (error) { reportAiDiagnostic(this.logger, 'inference-quota-failed', error, 'quota-unavailable'); return failure('unavailable', cors); }
        // Acquire after awaited quota calls too: parallel local requests must not race.
        if (this.active >= this.maxConcurrent) return failure('rate-limited', cors);
        this.active++;
        const controller = new AbortController(), timeout = setTimeout(() => controller.abort(aiError('timeout')), AI_TIMEOUT_MS);
        timeout.unref?.();
        const aborted = () => controller.abort(signal?.reason ?? aiError('unavailable'));
        let released = false;
        const release = () => {
            if (released) return;
            released = true; clearTimeout(timeout); signal?.removeEventListener('abort', aborted); this.active--;
        };
        controller.signal.addEventListener('abort', release, { once: true });
        signal?.addEventListener('abort', aborted, { once: true });
        if (signal?.aborted) aborted();
        if (workflow) {
            let stop;
            try {
                if (controller.signal.aborted) throw controller.signal.reason;
                const interrupted = new Promise((_, reject) => {
                    stop = () => reject(controller.signal.reason ?? aiError('unavailable'));
                    controller.signal.addEventListener('abort', stop, { once: true });
                });
                const output = await Promise.race([this.provider[workflow](request, { signal: controller.signal }), interrupted]);
                if (controller.signal.aborted) throw controller.signal.reason;
                const validated = workflow === 'plan' ? validateWorkflowPlanResponse(output, this.provider.model) : validateTranscriptionResponse(output);
                return result(200, 'application/json; charset=utf-8', JSON.stringify(validated), cors);
            } catch (error) {
                if (!signal?.aborted) reportAiDiagnostic(this.logger, 'provider-failed', error, 'provider-failure');
                const code = controller.signal.aborted && controller.signal.reason?.code === 'timeout' ? 'timeout' : AI_ERROR_CODES.includes(error?.code) ? error.code : 'provider-error';
                return failure(code, cors);
            } finally {
                if (stop) controller.signal.removeEventListener('abort', stop);
                controller.abort(); release();
            }
        }
        const self = this;
        async function* response() {
            let bytes = 0, content = false;
            try {
                if (controller.signal.aborted) throw controller.signal.reason;
                for await (const text of self.provider.generate(request, { signal: controller.signal })) {
                    if (controller.signal.aborted) throw controller.signal.reason;
                    if (typeof text !== 'string' || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text)) throw aiError('invalid-response');
                    const line = encoded({ type: 'delta', text }); bytes += Buffer.byteLength(line);
                    if (bytes > MAX_AI_OUTPUT_BYTES - 1024) throw aiError('invalid-response');
                    if (text) { content = true; yield line; }
                }
                if (!content || controller.signal.aborted) throw controller.signal.reason ?? aiError('invalid-response');
                yield encoded({ type: 'done', model: self.provider.model });
            } catch (error) {
                if (!signal?.aborted) reportAiDiagnostic(self.logger, 'provider-failed', error, 'provider-failure');
                const code = controller.signal.aborted && controller.signal.reason?.code === 'timeout' ? 'timeout' : AI_ERROR_CODES.includes(error?.code) ? error.code : 'provider-error';
                controller.abort(); yield encoded({ type: 'error', code });
            } finally {
                controller.abort(); release();
            }
        }
        return result(200, 'application/x-ndjson; charset=utf-8', response(), { ...cors, 'X-Accel-Buffering': 'no' });
    }
}
