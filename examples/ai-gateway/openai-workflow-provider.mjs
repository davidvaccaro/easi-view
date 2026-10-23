import { AI_ERROR_CODES, AI_TIMEOUT_MS, aiError } from '../../src/ai/protocol.js';
import { MAX_WORKFLOW_RESPONSE_BYTES, WORKFLOW_PLAN_SCHEMA, WORKFLOW_TRANSCRIPTION_MODEL, validateWorkflowRequest,
    validateWorkflowPlanResponse, validateTranscriptionRequest, validateTranscriptionResponse } from '../../src/ai/workflow-protocol.js';

const TIMEOUT_MS = AI_TIMEOUT_MS - 1000;
const DIAGNOSTICS = new Set(['provider-unauthorized', 'provider-rate-limited', 'provider-timeout', 'provider-failure',
    'secret-access-denied', 'secret-timeout', 'secret-invalid', 'secret-unavailable']);
const validKey = value => typeof value === 'string' && /^[A-Za-z0-9._-]{16,1024}$/.test(value);
const PROMPT = `You translate a clinician's explicit viewing goal into a typed, reversible EASI View plan that reduces navigation and display setup.
You receive only the command, never a patient catalog, identifiers, descriptions or pixels. Local code resolves conceptual selectors against actual study metadata, configured reading preferences and patient scope. Never invent source numbers or claim an image was found, an action completed, or a finding detected. Use only submit_viewer_plan, with no prose outside it, code, URLs or arbitrary viewer calls.
This is a viewing assistant. Image interpretation, locating an organ/lesion, finding the largest organ slice, diagnosing, identifying enhancement phase and drawing anatomical measurements are unsupported. Activating a manual measurement tool is supported: the clinician still draws. A request to prepare lung/bone/soft-tissue review is supported display setup; do not mistake that for image analysis or refuse ordinary workflow assistance.
Ready plans contain actions and a null question. Clarify contains a short question and no actions. Unsupported contains no actions and a null question. Do not echo patient details, paths or credentials. Use at most twelve actions.
For conceptual source selection use select-view, not a made-up series number or a prerequisite to open series cards. The selector fields are all required; leave unrequested criteria null. Study active means current study; displayed is only an explicit request to retain the currently displayed stack. Latest/prior/selected-prior are local chronology or explicit comparison requests. Missing or conflicting metadata will be handled locally; never infer contrast or energy from modality alone.
Select-view purpose routine, lung, soft-tissue or bone means ordinary CT viewing. The local host can prefer an appropriate available reconstruction for routine viewing; this is a disclosed display preference, not a claim of clinical superiority. Use reconstruction ordinary for general CT review unless a specific family is requested. Use blended for blended images, monoenergetic for an explicit energy/monoenergetic request, conventional only when explicitly requested. Never treat iodine/material maps or virtual-unenhanced reconstructions as ordinary CT. Explicit requests for those specialized reconstructions may use their corresponding family, with default presentation; never apply calibrated-HU presets to quantitative maps.
Use energyPreference lowest/highest for the lowest/highest available recorded monoenergetic reconstruction; energyKeV only for an explicit keV value, never together. Tube kVp is not reconstruction keV. Use thickness thinnest/thickest only if requested, and kernel sharp/standard only for an explicitly requested reconstruction kernel. Asking to review lungs alone does not demand a sharp kernel. Body-part criteria are requested metadata, not detected anatomy. Do not infer chest merely from a lung window. For explicit chest, ribs or thoracic review bodyPart chest is appropriate; spinal review alone does not require a spine body-part tag on a chest CT.
Pane indices: left/first/upper-left0, right/second/upper-right1, lower-left2, lower-right3. Use viewport active if no pane stated. Layouts are1,2,4. Three views use a four-pane layout with panes0,1,2. Repeat identical select-view selectors when the same reconstruction should appear in several panes; local code resolves them once and binds the same source. For a comparison, selectors differ only in the explicitly requested source characteristic or study scope.
Routine chest CT review and 'show this CT in lung and soft-tissue windows side by side': layout2, identical active-study CT axial select-view selectors with purpose routine and reconstruction ordinary in panes0/1, lung/soft-tissue windows, synchronize slices and camera while window linking is false. For 'one-pane lung review' use layout1, active CT axial purpose lung, reconstruction ordinary, lung window. Bone review similarly uses purpose bone and bone window; soft-tissue review uses its corresponding purpose/preset. For three requested windows use the same ordinary CT selector in panes0/1/2, then lung, soft-tissue,bone windows with slice/camera links and independent windows. Never link window adjustments across different presets.
For 'compare lowest-energy with blended' use layout2, first active-study CT axial select-view with purpose soft-tissue, reconstruction monoenergetic, energyPreference lowest; second with reconstruction blended and null energyPreference; soft-tissue windows on both. Link compatible slices/camera only when requested; no registration is inferred. For current/prior comparison use active and prior scopes respectively, purpose routine and ordinary reconstruction, requested windows, no links unless requested.
Position first/middle/last is calculated locally from the resolved stack length. Use position rather than inventing a frame number. Explicit numeric frame requests use frame, with one-based numbering. To show first and last side by side, disable links BEFORE changing source/frame, then layout2, identical routine selectors in both panes, position first/last, requested windows. Use cine for play/pause; CT playback traverses spatial slices, not patient motion. Pause playback before explicit positioning or measurement preparation. For midpoint with ellipse/distance/probe: select suitable routine axial CT, pause, position middle, soft-tissue window, activate tool ellipse/length/probe. Never infer an anatomical location from a frame count.
Numeric series identifiers remain an advanced explicit override using legacy select-series. Literal displayed-series requests can use select-series with study displayed; do not substitute another stack. An existing last-measurement action returns to an annotation already in the local workspace and creates no measurement. Reset affects the requested pane. Keep the plan concise and do not ask users to supply internal identifiers when the conceptual selector can represent their goal.`;

const REQUEST_MODES = Object.freeze({
    fresh: 'Request mode: NEW TASK FROM STUDY. The user wants a clean viewing setup, not an edit to previous panes. Local execution prepares one empty pane, active pane0, with playback and links stopped, only AFTER review and Run. Imported studies and measurements remain available. Include a select-view (or an explicit source selection or last-measurement) before windows, frames, cine or manual tools. Use study active for the current study, never displayed: no old displayed series is carried into this mode. Do not ask the user to clear, re-import or manually find a series. Layouts required by the new goal are explicit. If the request only says to adjust an existing pane, clarify that Continue current view is the appropriate mode.',
    continue: 'Request mode: CONTINUE CURRENT VIEW. Build on the actual currently displayed panes. This is not a saved conversation: you receive no previous command or model answer. Resolve this image, same series and currently selected image as displayed, not a new active-study search. For a window, frame, playback or tool adjustment, change only what is requested; do not invent a new source selection or shrink the layout. An unspecified pane is viewport active. Explicit left/right pane targets are numeric0/1. When the user explicitly requests a new one-pane layout, use layout1 and viewport active (local code rebinds an active pane removed by the layout). For a genuinely new multi-pane comparison or a requested reconstruction, include its requested source selectors and layout. Ask for clarification if the command depends on unavailable conversation history.'
});

function failure(code, diagnostic) { const error = aiError(code); if (diagnostic) error.aiDiagnostic = diagnostic; return error; }
function safeError(error) {
    const code = AI_ERROR_CODES.includes(error?.code) ? error.code : 'provider-error';
    return failure(code, DIAGNOSTICS.has(error?.aiDiagnostic) ? error.aiDiagnostic : code === 'timeout' ? 'provider-timeout' : code === 'rate-limited' ? 'provider-rate-limited' : 'provider-failure');
}
function statusError(status) { return status === 401 || status === 403 ? failure('provider-error', 'provider-unauthorized') :
    status === 429 ? failure('rate-limited', 'provider-rate-limited') : failure('provider-error', 'provider-failure'); }

/** No catalog, raw DICOM, images, paths, durable conversation or model-controlled
 * execution. A forced function describes intent; only the viewer can apply it. */
export function createOpenAiWorkflowProvider({ apiKey, getApiKey, modelId = 'gpt-6.1-sol', fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
    if (apiKey != null && !validKey(apiKey) || getApiKey != null && typeof getApiKey !== 'function' ||
        apiKey == null && typeof getApiKey !== 'function' || apiKey != null && getApiKey != null || typeof fetchImpl !== 'function' ||
        typeof modelId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(modelId) || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > TIMEOUT_MS) throw new Error('Invalid OpenAI workflow provider configuration.');
    async function invoke(url, makeBody, { signal, maximum = 128 * 1024 } = {}) {
        if (signal?.aborted) throw aiError('unavailable');
        const controller = new AbortController(), abort = () => controller.abort(aiError('unavailable'));
        signal?.addEventListener('abort', abort, { once: true });
        let reader, listener;
        const timeout = setTimeout(() => controller.abort(failure('timeout', 'provider-timeout')), timeoutMs);
        const stopped = new Promise((_, reject) => { listener = () => reject(safeError(controller.signal.reason)); controller.signal.addEventListener('abort', listener, { once: true }); });
        stopped.catch(() => {});
        const wait = promise => Promise.race([promise, stopped]);
        try {
            const key = getApiKey ? await wait(getApiKey({ signal: controller.signal })) : apiKey;
            if (controller.signal.aborted) throw controller.signal.reason;
            if (!validKey(key)) throw failure('provider-error', 'provider-unauthorized');
            const body = makeBody(), json = typeof body === 'string';
            const upstream = Promise.resolve(fetchImpl(url, { method: 'POST', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(json ? { 'Content-Type': 'application/json' } : {}) },
                body, signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' })).then(response => {
                if (controller.signal.aborted) { try { Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch {} throw controller.signal.reason; }
                return response;
            });
            const response = await wait(upstream);
            if (!response?.ok) throw statusError(response?.status);
            if (response.redirected || response.headers?.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || !response.body?.getReader) throw aiError('invalid-response');
            const advertised = response.headers.get('content-length');
            if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > maximum)) throw aiError('invalid-response');
            reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true });
            let text = '', bytes = 0;
            while (true) {
                const chunk = await wait(reader.read());
                if (controller.signal.aborted) throw controller.signal.reason;
                if (chunk.done) break;
                if (!(chunk.value instanceof Uint8Array) || (bytes += chunk.value.byteLength) > maximum) throw aiError('invalid-response');
                try { text += decoder.decode(chunk.value, { stream: true }); } catch { throw aiError('invalid-response'); }
            }
            try { text += decoder.decode(); return JSON.parse(text); } catch { throw aiError('invalid-response'); }
        } catch (error) { throw safeError(controller.signal.aborted ? controller.signal.reason : error); }
        finally {
            clearTimeout(timeout); controller.signal.removeEventListener('abort', listener); signal?.removeEventListener('abort', abort); controller.abort();
            try { Promise.resolve(reader?.cancel()).catch(() => {}); } catch {}
            try { reader?.releaseLock(); } catch {}
        }
    }
    return {
        async plan(input, options) {
            const request = validateWorkflowRequest(input);
            const response = await invoke('https://api.openai.com/v1/responses', () => JSON.stringify({ model: modelId, store: false, stream: false,
                reasoning: { effort: 'low' }, max_output_tokens: 4096, parallel_tool_calls: false,
                tool_choice: { type: 'function', name: 'submit_viewer_plan' },
                tools: [{ type: 'function', name: 'submit_viewer_plan', description: 'Submit a bounded viewer intent plan for local grounding and review.', strict: true, parameters: WORKFLOW_PLAN_SCHEMA }],
                input: [{ role: 'developer', content: [{ type: 'input_text', text: PROMPT + '\n' + REQUEST_MODES[request.mode ?? 'continue'] }] }, { role: 'user', content: [{ type: 'input_text', text: request.command }] }],
                truncation: 'disabled' }), options);
            if (!response || response.model !== modelId || response.status !== 'completed' || response.error != null || response.incomplete_details != null || !Array.isArray(response.output)) throw aiError('invalid-response');
            const calls = [];
            for (const item of response.output) {
                if (item?.type === 'reasoning') continue;
                if (item?.type === 'message' && item.content?.some(part => part.type === 'refusal')) throw aiError('provider-error');
                if (item?.type !== 'function_call' || item.name !== 'submit_viewer_plan' || typeof item.arguments !== 'string' ||
                    Buffer.byteLength(item.arguments) > MAX_WORKFLOW_RESPONSE_BYTES || item.status != null && item.status !== 'completed') throw aiError('invalid-response');
                calls.push(item);
            }
            if (calls.length !== 1) throw aiError('invalid-response');
            let plan;
            try { plan = JSON.parse(calls[0].arguments); } catch { throw aiError('invalid-response'); }
            return validateWorkflowPlanResponse({ version: 1, model: modelId, plan }, modelId);
        },
        async transcribe(input, options) {
            const request = validateTranscriptionRequest(input);
            const response = await invoke('https://api.openai.com/v1/audio/transcriptions', () => {
                const extensions = { 'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3' };
                const type = request.mimeType.split(';')[0], form = new FormData();
                form.set('model', WORKFLOW_TRANSCRIPTION_MODEL);
                form.set('file', new Blob([Buffer.from(request.audio, 'base64')], { type: type === 'audio/x-wav' ? 'audio/wav' : type }), `command.${extensions[type]}`);
                return form;
            }, { ...options, maximum: 8192 });
            if (!response || response.model != null && response.model !== WORKFLOW_TRANSCRIPTION_MODEL) throw aiError('invalid-response');
            return validateTranscriptionResponse({ version: 1, model: WORKFLOW_TRANSCRIPTION_MODEL, text: response.text });
        }
    };
}
