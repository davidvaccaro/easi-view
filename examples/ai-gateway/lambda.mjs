import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AiGateway, aiRequestByteLimit } from './gateway.mjs';
import { createConfiguredProvider } from './provider-selection.mjs';
import { createDynamoQuota } from './aws-quota.mjs';
import { reportAiDiagnostic } from './diagnostics.mjs';

const operationalLogger = record => console.warn(JSON.stringify(record));
export function createGatewayLoader({ env = process.env, providerFactory = createConfiguredProvider, quotaFactory = createDynamoQuota, logger = operationalLogger } = {}) {
    let initialized;
    return function configuredGateway() {
        if (!initialized) {
            const attempt = Promise.resolve().then(() => Promise.all([providerFactory({ provider: env.AI_PROVIDER || 'bedrock', region: env.AWS_REGION,
                modelId: env.AI_MODEL_ID, openAiApiKeySecretArn: env.OPENAI_API_KEY_SECRET_ARN || undefined }),
            quotaFactory({ region: env.AWS_REGION, tableName: env.AI_QUOTA_TABLE })])).then(([provider, quota]) => new AiGateway({ provider, quota,
                passcode: env.AI_DEMO_PASSCODE, originSecret: env.AI_ORIGIN_SECRET, allowedOrigins: [],
                dailyLimit: Number(env.AI_DAILY_LIMIT ?? 200), minuteLimit: 12, maxConcurrent: 1, logger, requireModelBinding: true }));
            initialized = attempt;
            attempt.catch(error => {
                if (initialized === attempt) initialized = undefined;
                reportAiDiagnostic(logger, 'initialization-failed', error);
            });
        }
        return initialized;
    };
}
const configuredGateway = createGatewayLoader();
export async function handleLambda(event, responseStream, context, runtime = globalThis.awslambda) {
    let output;
    try {
        const body = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body ?? '';
        if (Buffer.byteLength(body) > aiRequestByteLimit(event.rawPath)) throw new Error('Request limit.');
        const gateway = await configuredGateway(), headers = { ...(event.headers ?? {}) };
        if (Array.isArray(event.cookies)) headers.cookie = event.cookies.join('; ');
        const remaining = Math.min(60000, Math.max(1, (context?.getRemainingTimeInMillis?.() ?? 65000) - 1500));
        // Only a request authenticated by the gateway's edge-secret gate can consume quota.
        // CloudFront overwrites this address in its viewer-request function.
        const edgeIp = headers['x-easi-viewer-ip'];
        const ip = typeof edgeIp === 'string' && /^[A-Fa-f0-9:.]{3,64}$/.test(edgeIp) ? edgeIp : event.requestContext?.http?.sourceIp ?? 'unknown';
        output = await gateway.handle({ method: event.requestContext?.http?.method, path: event.rawPath, headers, body, ip, signal: AbortSignal.timeout(remaining) });
    } catch (error) {
        reportAiDiagnostic(operationalLogger, 'initialization-failed', error);
        output = { status: 503, headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' }, body: '{"type":"error","code":"unavailable"}\n' };
    }
    const stream = runtime.HttpResponseStream.from(responseStream, { statusCode: output.status, headers: output.headers });
    await pipeline(Readable.from(typeof output.body === 'string' ? [output.body] : output.body), stream);
}
export const handler = globalThis.awslambda?.streamifyResponse(handleLambda);
