// Browser facade for the optional standalone loopback helper. It never opens a
// TCP socket or stores credentials. Hosted/embedded viewers need their own
// explicitly configured gateway instead of this local development service.
const PREFIX = '/storage-connections';
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_RESPONSE = 131072;
const SAFE_ERROR = Symbol('local connector browser error');
const safeError = (message, details = {}) => Object.assign(new Error(message), details, { [SAFE_ERROR]: true });

function canceled(signal) { signal?.throwIfAborted(); }
function validId(value) {
    if (typeof value !== 'string' || !ID.test(value)) throw new TypeError('Use a configured local connector ID.');
    return value;
}
function wait(operation, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const aborted = () => reject(signal.reason || new DOMException('Canceled', 'AbortError'));
        signal.addEventListener('abort', aborted, { once: true });
        Promise.resolve(operation).then(value => { signal.removeEventListener('abort', aborted); resolve(value); }, error => {
            signal.removeEventListener('abort', aborted); reject(error);
        });
    });
}
async function responseJson(response, signal) {
    if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '') || !response.body) throw safeError('The local DIMSE connector returned an unsupported response.');
    const reader = response.body.getReader(), chunks = []; let length = 0;
    const cancelReader = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancelReader, { once: true });
    try {
        while (true) {
            canceled(signal); const { done, value } = await wait(reader.read(), signal); if (done) break;
            length += value.byteLength; if (length > MAX_RESPONSE) throw safeError('The local DIMSE connector response exceeds its limit.');
            chunks.push(value);
        }
        const bytes = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        canceled(signal); return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } finally { signal.removeEventListener('abort', cancelReader); cancelReader(); reader.releaseLock(); }
}

export function createLocalStorageConnector({ origin = globalThis.location?.origin, fetchImpl = globalThis.fetch,
    timeoutMs = 5000, echoTimeoutMs = 15000 } = {}) {
    let local;
    try { local = new URL(origin); } catch { throw new TypeError('Configure the standalone viewer loopback origin.'); }
    if (local.origin !== origin || local.protocol !== 'http:' || !HOSTS.has(local.hostname) || typeof fetchImpl !== 'function') {
        throw new TypeError('The local DIMSE helper requires an exact HTTP loopback viewer origin.');
    }
    if (![timeoutMs, echoTimeoutMs].every(value => Number.isInteger(value) && value >= 10 && value <= 15000)) throw new TypeError('Use bounded local connector request deadlines.');
    async function request(path, { method = 'GET', body, signal, missing = false, deadline = timeoutMs } = {}) {
        canceled(signal);
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), deadline);
        const requestSignal = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
        let response, obtained = false;
        try {
            response = await wait(fetchImpl(origin + PREFIX + path, { method, signal: requestSignal, credentials: 'omit', cache: 'no-store', redirect: 'error',
                headers: { Accept: 'application/json', ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-EASI-View': '1' }) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), requestSignal);
            obtained = true;
            if (!response.ok) {
                void response.body?.cancel().catch(() => {});
                if (missing && response.status === 404) return null;
                const message = response.status === 400 ? 'The local DIMSE configuration was rejected. Check host, port and AE titles.'
                    : response.status === 403 ? 'The local DIMSE connector requires the standalone viewer origin.'
                        : response.status === 409 ? 'The local DIMSE connector has reached its configured-peer limit.'
                            : response.status === 429 ? 'The local DIMSE connector is busy. Wait for the current operation or cancel it.'
                                : response.status === 504 ? 'The local DIMSE operation was canceled or timed out.'
                                    : 'The local DIMSE connector could not complete the operation. Check the peer and its calling-AE/IP rules.';
                throw safeError(message, { status: response.status });
            }
            if (response.status === 204) return null;
            const value = await responseJson(response, requestSignal); canceled(signal); return value;
        } catch (error) {
            canceled(signal);
            if (requestSignal.aborted) throw safeError('The local DIMSE connector request timed out. Check the standalone viewer service and retry.', { name: 'TimeoutError', status: 504 });
            if (error?.[SAFE_ERROR]) throw error;
            throw safeError(obtained ? 'The local DIMSE connector returned an unsupported response.'
                : 'The local DIMSE connector is unavailable. Start the standalone viewer server or configure an HTTP DIMSE gateway.');
        } finally { clearTimeout(timer); controller.abort(); void response?.body?.cancel().catch(() => {}); }
    }
    function descriptor(value) {
        validId(value?.id);
        const expected = `${origin}${PREFIX}/${value.id}/dimse/`;
        if (value.baseUrl !== expected || typeof value.name !== 'string' || typeof value.remember !== 'boolean'
            || !value.dimse || typeof value.dimse.host !== 'string' || !Number.isInteger(value.dimse.port)
            || typeof value.dimse.callingAeTitle !== 'string' || typeof value.dimse.calledAeTitle !== 'string') {
            throw new Error('The local DIMSE connector returned an invalid profile.');
        }
        return { id: value.id, baseUrl: expected, name: value.name, remember: value.remember,
            dimse: { host: value.dimse.host, port: value.dimse.port, callingAeTitle: value.dimse.callingAeTitle, calledAeTitle: value.dimse.calledAeTitle } };
    }
    return Object.freeze({
        async available() {
            try { const result = await request(''); return result?.available === true && Array.isArray(result.profiles); }
            catch { return false; }
        },
        async list({ signal } = {}) {
            const result = await request('', { signal });
            if (result?.available !== true || !Array.isArray(result.profiles) || result.profiles.length > 32) throw new Error('The local DIMSE connector returned an invalid profile list.');
            return result.profiles.map(descriptor);
        },
        async save(value, { signal } = {}) {
            const id = value?.connectorId;
            if (id !== undefined && id !== null && id !== '') validId(id);
            const result = await request(id ? `/${id}` : '', { method: id ? 'PUT' : 'POST', signal,
                body: { name: value?.name, remember: value?.remember === true, dimse: value?.dimse } });
            return descriptor(result);
        },
        async remove(id, { signal } = {}) { await request(`/${validId(id)}`, { method: 'DELETE', signal, missing: true }); },
        async testEcho(id, { signal } = {}) {
            const result = await request(`/${validId(id)}/echo`, { method: 'POST', signal, body: {}, deadline: echoTimeoutMs });
            if (result?.ok !== true) throw new Error('The DIMSE peer did not complete C-ECHO successfully.');
            return { ok: true, summary: 'DIMSE C-ECHO succeeded.', checks: [{ name: 'DIMSE C-ECHO', status: 'passed' }],
                scope: 'Verification only; query, retrieval and image rendering are tested separately.' };
        }
    });
}
