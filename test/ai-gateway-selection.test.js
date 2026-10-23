import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfiguredProvider, createOpenAiSecretLoader } from '../examples/ai-gateway/provider-selection.mjs';
import { createGatewayLoader } from '../examples/ai-gateway/lambda.mjs';
import { AiGateway } from '../examples/ai-gateway/gateway.mjs';
import { reportAiDiagnostic } from '../examples/ai-gateway/diagnostics.mjs';

const key = 'sk-synthetic-example-key-not-a-credential', passcode = 'synthetic-test-invitation-code-1234567890';
const secretArn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:synthetic-openai-AbCdEf';
class Command { constructor(input) { this.input = input; } }
const provider = { model: 'synthetic-model', async *generate() { yield 'Ready.'; } };
test('AI provider selection retains Bedrock and rejects ambiguous or unknown providers', async () => {
    let input; const configured = await createConfiguredProvider({ bedrockFactory: async value => { input = value; return provider; } });
    assert.equal(input.modelId, 'amazon.nova-micro-v1:0'); assert.equal(configured.sessionScope, 'bedrock:synthetic-model');
    await assert.rejects(createConfiguredProvider({ provider: 'unknown' }));
    await assert.rejects(createConfiguredProvider({ provider: 'bedrock', openAiApiKey: key }));
    await assert.rejects(createConfiguredProvider({ provider: 'openai' }));
    await assert.rejects(createConfiguredProvider({ provider: 'openai', openAiApiKey: key, openAiApiKeySecretArn: secretArn }));
});
test('AI configured OpenAI model and key remain server-side and use explicit provider scope', async () => {
    let captured; const configured = await createConfiguredProvider({ provider: 'openai', openAiApiKey: key, openAiFactory: async options => { captured = options; return { ...provider, model: options.modelId }; } });
    assert.equal(captured.apiKey, key); assert.equal(configured.model, 'gpt-6.1-sol'); assert.equal(configured.sessionScope, 'openai:gpt-6.1-sol');
    assert.equal(JSON.stringify(configured).includes(key), false);
});
test('AI secret-backed provider loads no key before authorized generation and passes abort signal', async () => {
    let reads = 0, options;
    const configured = await createConfiguredProvider({ provider: 'openai', openAiApiKeySecretArn: secretArn,
        secretOptions: { Command, client: { async send(command, settings) { reads++; assert.equal(command.input.SecretId, secretArn); assert.ok(settings.abortSignal); return { SecretString: key }; } } },
        openAiFactory: async captured => { options = captured; return { ...provider, model: captured.modelId, async *generate(request, { signal }) { assert.equal(await captured.getApiKey({ signal }), key); yield 'Ready.'; } }; } });
    assert.equal(reads, 0); assert.equal(typeof options.getApiKey, 'function'); assert.equal(options.apiKey, undefined);
    const controller = new AbortController(); for await (const text of configured.generate({}, { signal: controller.signal })) assert.equal(text, 'Ready.');
    assert.equal(reads, 1);
});
test('AI secret cache expires within five minutes and accepts dedicated raw or JSON formats', async () => {
    let now = 0, reads = 0;
    const loader = await createOpenAiSecretLoader({ secretArn, Command, now: () => now, client: { async send() { reads++; return { SecretString: reads === 1 ? key : JSON.stringify({ apiKey: `${key}-rotated` }) }; } } });
    assert.equal(await loader(), key); now = 299999; assert.equal(await loader(), key); assert.equal(reads, 1);
    now = 300000; assert.equal(await loader(), `${key}-rotated`); assert.equal(reads, 2);
});
test('AI secret errors are redacted, failed reads retry, and no stale key survives a failed refresh', async () => {
    let calls = 0, now = 0;
    const loader = await createOpenAiSecretLoader({ secretArn, Command, now: () => now, client: { async send() {
        calls++; if (calls === 1) return { SecretString: key }; if (calls === 2) throw Object.assign(new Error('private upstream message'), { name: 'AccessDeniedException' }); return { SecretString: `${key}-new` };
    } } });
    assert.equal(await loader(), key); now = 300000;
    await assert.rejects(loader(), error => error.aiDiagnostic === 'secret-access-denied' && !error.message.includes('private'));
    assert.equal(await loader(), `${key}-new`); assert.equal(calls, 3);
});
test('AI secret load has a deterministic timeout even if an injected client ignores cancellation', async () => {
    let signal;
    const loader = await createOpenAiSecretLoader({ secretArn, Command, timeoutMs: 10, client: { send(command, options) { signal = options.abortSignal; return new Promise(() => {}); } } });
    await assert.rejects(loader(), error => error.code === 'timeout' && error.aiDiagnostic === 'secret-timeout'); assert.equal(signal.aborted, true);
});
test('AI secret load aborts with the caller and never supplies a late key', async () => {
    let signal;
    const loader = await createOpenAiSecretLoader({ secretArn, Command, client: { send(command, options) { signal = options.abortSignal; return new Promise(() => {}); } } });
    const controller = new AbortController(), pending = loader({ signal: controller.signal }); controller.abort();
    await assert.rejects(pending, error => error.aiDiagnostic === 'secret-unavailable'); assert.equal(signal.aborted, true);
});
test('AI secret configuration rejects wrong regions, malformed secrets and broad ARN placeholders', async () => {
    await assert.rejects(createOpenAiSecretLoader({ secretArn: '*' }));
    await assert.rejects(createOpenAiSecretLoader({ secretArn, region: 'us-west-2' }));
    for (const SecretString of ['', 'short', '{}', JSON.stringify({ apiKey: 123 }), `${key} bad`, undefined]) {
        const loader = await createOpenAiSecretLoader({ secretArn, Command, client: { async send() { return { SecretString }; } } });
        await assert.rejects(loader(), error => error.aiDiagnostic === 'secret-invalid');
    }
});
test('AI gateway initialization shares in-flight work, retries after rejection and logs only controlled fields', async () => {
    let attempts = 0; const records = [];
    const load = createGatewayLoader({ env: { AI_DEMO_PASSCODE: passcode, AI_MODEL_ID: provider.model }, providerFactory: async () => {
        attempts++; if (attempts === 1) throw new Error(`private ${key}`); return provider;
    }, quotaFactory: async () => ({ async consume() { return true; } }), logger: value => records.push(value) });
    const first = load(); assert.equal(load(), first); await assert.rejects(first);
    const gateway = await load(); assert.ok(gateway instanceof AiGateway); assert.equal(await load(), gateway); assert.equal(attempts, 2);
    assert.deepEqual(records, [{ event: 'initialization-failed', category: 'initialization-failure', code: 'unavailable' }]);
    assert.equal(JSON.stringify(records).includes(key), false);
});
test('AI provider or model changes invalidate the old signed session even when invitation is unchanged', () => {
    const first = new AiGateway({ provider: { ...provider, sessionScope: 'bedrock:synthetic-model' }, passcode });
    const second = new AiGateway({ provider: { ...provider, sessionScope: 'openai:synthetic-model' }, passcode });
    const other = new AiGateway({ provider: { ...provider, sessionScope: 'openai:different-model' }, passcode });
    const cookie = first.sessions.cookie(first.sessions.issue());
    assert.equal(first.sessions.accepts(cookie), true); assert.equal(second.sessions.accepts(cookie), false); assert.equal(other.sessions.accepts(cookie), false);
});
test('AI login identifies the actual configured provider without a secret read', async () => {
    const gateway = new AiGateway({ provider: { ...provider, model: 'gpt-6.1-sol', sessionScope: 'openai:gpt-6.1-sol' }, passcode });
    const response = await gateway.handle({ path: '/api/ai/login' });
    assert.equal(response.status, 200); assert.match(response.body, /OpenAI \(gpt-6\.1-sol\)/); assert.doesNotMatch(response.body, /Nova Micro/);
});
test('AI reference gateway rejects missing or stale consent-model binding before quota, secret or inference', async () => {
    const events = [], origin = 'https://demo.invalid';
    const gateway = new AiGateway({ provider: { model: 'gpt-6.1-sol', sessionScope: 'openai:gpt-6.1-sol', async *generate() { events.push('model-or-secret'); yield 'Ready.'; } },
        passcode, requireModelBinding: true, allowedOrigins: [origin], quota: { async consume() { events.push('quota'); return true; } } });
    const cookie = gateway.sessions.cookie(gateway.sessions.issue()), body = JSON.stringify({ version: 1, task: 'connection-test', facts: [] });
    for (const model of [undefined, 'amazon.nova-micro-v1:0', 'gpt-6.1-sol-other']) {
        const response = await gateway.handle({ method: 'POST', path: '/api/ai/test', body, headers: { origin, cookie, 'content-type': 'application/json', ...(model ? { 'X-Easi-Ai-Model': model } : {}) } });
        assert.equal(response.status, 409); assert.equal(JSON.parse(response.body).code, 'configuration-changed'); assert.deepEqual(events, []);
    }
    const response = await gateway.handle({ method: 'POST', path: '/api/ai/test', body, headers: { origin, cookie, 'content-type': 'application/json', 'X-Easi-Ai-Model': 'gpt-6.1-sol' } });
    assert.equal(response.status, 200); for await (const line of response.body) {}
    assert.deepEqual(events, ['quota', 'quota', 'quota', 'model-or-secret']);
    const preflight = await gateway.handle({ method: 'OPTIONS', path: '/api/ai/test', headers: { origin } });
    assert.match(preflight.headers['Access-Control-Allow-Headers'], /X-Easi-Ai-Model/);
});
test('AI diagnostic logger ignores uncontrolled categories and all arbitrary error fields', () => {
    const events = [], logger = value => events.push(value);
    reportAiDiagnostic(logger, 'provider-failed', { code: 'provider-error', aiDiagnostic: `private ${key}`, message: key, headers: { Authorization: key } }, 'provider-failure');
    reportAiDiagnostic(logger, 'unrecognized-event', new Error(key));
    assert.deepEqual(events, [{ event: 'provider-failed', category: 'provider-failure', code: 'provider-error' }]); assert.equal(JSON.stringify(events).includes(key), false);
});
