import { AI_ERROR_CODES } from '../../src/ai/protocol.js';

const CATEGORIES = new Set(['invalid-config', 'secret-access-denied', 'secret-timeout', 'secret-invalid', 'secret-unavailable',
    'quota-unavailable', 'provider-unauthorized', 'provider-rate-limited', 'provider-timeout', 'provider-failure', 'initialization-failure']);
const EVENTS = new Set(['initialization-failed', 'login-quota-failed', 'inference-quota-failed', 'provider-failed']);
export function diagnosticError(code, category) {
    const error = new Error('The configured AI service could not complete this operation.');
    error.code = code; error.aiDiagnostic = CATEGORIES.has(category) ? category : 'initialization-failure';
    return error;
}
/** Never pass upstream messages, stack traces, keys, headers, bodies or model text. */
export function reportAiDiagnostic(logger, event, error, fallback = 'initialization-failure') {
    if (typeof logger !== 'function' || !EVENTS.has(event)) return;
    const category = CATEGORIES.has(error?.aiDiagnostic) ? error.aiDiagnostic : CATEGORIES.has(fallback) ? fallback : 'initialization-failure';
    try { logger(Object.freeze({ event, category, code: AI_ERROR_CODES.includes(error?.code) ? error.code : 'unavailable' })); } catch { /* Diagnostics must not break a request. */ }
}
