import { AI_TIMEOUT_MS, MAX_AI_OUTPUT_BYTES, aiError, formatAiFact, validateAiRequest } from '../../src/ai/protocol.js';

export const DEFAULT_MODEL = 'amazon.nova-micro-v1:0';
export const SYSTEM_PROMPT = `You are EASI View AI Assist Preview, a technical imaging metadata and measurement assistant.
Use only the supplied allowlisted facts. Never infer image content, diagnoses, findings, lesion identity, patient identity, prognosis, treatment, or clinical meaning.
Return a concise plain-text draft, no HTML, links, markdown tables, code, or external sources. Cite every supplied factual statement using the exact evidence identifier in square brackets, such as [E1]. Do not invent identifiers.
For explain-series, explain the supplied technical properties and limitations in accessible language. Pixel counts are matrix dimensions, not physical resolution. Units must be quoted exactly. Do not calculate new values.
For summarize-measurements, summarize only the exact viewer-computed values and units, grouped by their supplied M labels. Preserve uncalibrated pixel units. Do not infer comparisons, lesions, or changes. Do not calculate new numbers.
Notice categories: jpeg-alignment means one nonstandard JPEG alignment byte was tolerated after an end marker; jpeg-precision means the decoded precision differs from declared stored bits and the viewer retains decoded values; geometry means limited or invalid optional spatial metadata; timing means limited optional frame timing; encoding and compatibility mean a source compatibility limitation. Original DICOM bytes and attributes are unchanged. A category is not a diagnosis or proof of validity.
Keep the response under 120 words in one or two short paragraphs. Do not repeat facts or add an introduction, conclusion, generic modality description, boilerplate caveats or a numbered list. Matrix dimensions alone do not establish resolution or image quality. Start directly with the useful explanation. All responses remain unverified drafts for user review.`;

export function modelMessages(input) {
    const request = validateAiRequest(input);
    if (request.task === 'connection-test') return {
        system: [{ text: 'You are a connectivity test. Reply with exactly: EASI View AI connection is ready.' }],
        messages: [{ role: 'user', content: [{ text: 'Run the synthetic connectivity test. No medical data is supplied.' }] }]
    };
    const facts = request.facts.map(fact => `[${fact.id}] ${formatAiFact(fact).text}`).join('\n');
    return { system: [{ text: SYSTEM_PROMPT }], messages: [{ role: 'user', content: [{ text: `Task: ${request.task}\nAllowlisted facts:\n${facts}` }] }] };
}

/** Optional server SDK is loaded only when the real Bedrock provider is used. */
export async function createBedrockProvider({ region = 'us-east-1', modelId = DEFAULT_MODEL, client, Command } = {}) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/.test(modelId)) throw new Error('Invalid configured model identifier.');
    if (!client || !Command) {
        const sdk = await import('@aws-sdk/client-bedrock-runtime');
        client ??= new sdk.BedrockRuntimeClient({ region, maxAttempts: 1 });
        Command ??= sdk.ConverseStreamCommand;
    }
    return {
        model: modelId,
        async *generate(input, { signal } = {}) {
            const request = validateAiRequest(input), timeout = AbortSignal.timeout(AI_TIMEOUT_MS - 1000);
            const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
            let bytes = 0, ended = false, content = false;
            try {
                const response = await client.send(new Command({ modelId, ...modelMessages(request),
                    inferenceConfig: { maxTokens: request.task === 'connection-test' ? 64 : 768, temperature: 0 } }), { abortSignal: combined });
                if (!response.stream) throw aiError('invalid-response');
                for await (const event of response.stream) {
                    if (combined.aborted) throw aiError(timeout.aborted ? 'timeout' : 'unavailable');
                    const text = event.contentBlockDelta?.delta?.text;
                    if (text != null) {
                        if (typeof text !== 'string' || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text)) throw aiError('invalid-response');
                        bytes += Buffer.byteLength(text);
                        if (bytes > MAX_AI_OUTPUT_BYTES - 2048) throw aiError('invalid-response');
                        if (text) { content = true; yield text; }
                    }
                    if (event.messageStop) {
                        if (event.messageStop.stopReason !== 'end_turn') throw aiError('provider-error');
                        ended = true;
                    }
                    if (Object.keys(event).some(key => /Exception$/.test(key))) throw aiError('provider-error');
                }
                if (!ended || !content) throw aiError('invalid-response');
            } catch (error) {
                if (timeout.aborted) throw aiError('timeout');
                if (error?.code) throw aiError(error.code);
                throw aiError(error?.name === 'ThrottlingException' ? 'rate-limited' : 'provider-error');
            }
        }
    };
}
