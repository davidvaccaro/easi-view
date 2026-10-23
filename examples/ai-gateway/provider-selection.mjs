import { createBedrockProvider, DEFAULT_MODEL } from './provider.mjs';
import { createOpenAiProvider, DEFAULT_OPENAI_MODEL } from './openai-provider.mjs';
import { diagnosticError } from './diagnostics.mjs';

const SECRET_ARN = /^arn:aws[a-z-]*:secretsmanager:([a-z0-9-]+):\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/;
function normalizedKey(input) {
    let value = input;
    if (typeof value !== 'string' || value.length > 16384) throw diagnosticError('unavailable', 'secret-invalid');
    if (value.trim().startsWith('{')) {
        try { const parsed = JSON.parse(value); value = parsed.apiKey ?? parsed.OPENAI_API_KEY; } catch { throw diagnosticError('unavailable', 'secret-invalid'); }
    }
    if (typeof value !== 'string' || !/^[\x21-\x7E]{20,4096}$/.test(value.trim())) throw diagnosticError('unavailable', 'secret-invalid');
    return value.trim();
}

/** Bounded five-minute server-only secret cache; failed loads are never cached. */
export async function createOpenAiSecretLoader({ secretArn, region = 'us-east-1', client, Command, now = Date.now, timeoutMs = 8000, cacheMs = 300000 } = {}) {
    const match = typeof secretArn === 'string' && secretArn.match(SECRET_ARN);
    if (!match || match[1] !== region || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000 ||
        !Number.isInteger(cacheMs) || cacheMs < 0 || cacheMs > 300000) throw diagnosticError('unavailable', 'invalid-config');
    if (!client || !Command) {
        const sdk = await import('@aws-sdk/client-secrets-manager');
        client ??= new sdk.SecretsManagerClient({ region, maxAttempts: 1 }); Command ??= sdk.GetSecretValueCommand;
    }
    let cached, expires = 0;
    return async function loadKey({ signal } = {}) {
        if (signal?.aborted) throw diagnosticError('unavailable', 'secret-unavailable');
        if (cached && now() < expires) return cached;
        const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), timeoutMs);
        const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        let onAbort;
        try {
            const interrupted = new Promise((_, reject) => {
                onAbort = () => reject(diagnosticError(controller.signal.aborted ? 'timeout' : 'unavailable', controller.signal.aborted ? 'secret-timeout' : 'secret-unavailable'));
                combined.addEventListener('abort', onAbort, { once: true });
                if (combined.aborted) onAbort();
            });
            const operation = client.send(new Command({ SecretId: secretArn, VersionStage: 'AWSCURRENT' }), { abortSignal: combined });
            const response = await Promise.race([operation, interrupted]);
            if (combined.aborted) throw diagnosticError('unavailable', 'secret-unavailable');
            cached = normalizedKey(response.SecretString); expires = now() + cacheMs; return cached;
        } catch (error) {
            cached = undefined; expires = 0;
            if (error?.aiDiagnostic) throw error;
            throw diagnosticError('unavailable', error?.name === 'AccessDeniedException' ? 'secret-access-denied' : 'secret-unavailable');
        } finally { clearTimeout(timeout); if (onAbort) combined.removeEventListener('abort', onAbort); }
    };
}

export async function createConfiguredProvider({ provider = 'bedrock', modelId, region = 'us-east-1', openAiApiKey, openAiApiKeySecretArn,
    secretOptions, bedrockFactory = createBedrockProvider, openAiFactory = createOpenAiProvider, fetchImpl } = {}) {
    if (provider === 'bedrock') {
        if (openAiApiKey || openAiApiKeySecretArn) throw diagnosticError('unavailable', 'invalid-config');
        const configured = await bedrockFactory({ region, modelId: modelId || DEFAULT_MODEL });
        return { ...configured, sessionScope: `bedrock:${configured.model}` };
    }
    if (provider !== 'openai' || Boolean(openAiApiKey) === Boolean(openAiApiKeySecretArn)) throw diagnosticError('unavailable', 'invalid-config');
    const model = modelId || DEFAULT_OPENAI_MODEL;
    if (openAiApiKey) return { ...await openAiFactory({ apiKey: normalizedKey(openAiApiKey), modelId: model, fetchImpl }), sessionScope: `openai:${model}` };
    const loadKey = await createOpenAiSecretLoader({ secretArn: openAiApiKeySecretArn, region, ...secretOptions });
    return { ...await openAiFactory({ getApiKey: loadKey, modelId: model, fetchImpl }), sessionScope: `openai:${model}` };
}
