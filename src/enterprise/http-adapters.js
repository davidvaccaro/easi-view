import { CONTEXT_BYTES, origin, text, canceled, check, abortable } from './contracts.js';

/** Explicit JSON host protocol; this adapter does not guess a PACS vendor's login/worklist API. */
export function createWorkflowHttpAdapter({ baseUrl, headers = async () => ({}), credentials = 'omit', allowInsecureLoopback = false, timeoutMs = 30000 } = {}) {
    let base; try { base = new URL(baseUrl); } catch { throw new TypeError('Configure an explicit workflow API address.'); }
    origin(base.origin, { loopback: allowInsecureLoopback });
    if (base.username || base.password || base.search || base.hash || typeof headers !== 'function' || !['omit', 'same-origin'].includes(credentials) ||
        !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new TypeError('Use a bounded workflow HTTP adapter without URL credentials.');
    const prefix = base.href.replace(/\/+$/u, '');
    async function request(path, current, method = 'GET', body) {
        const controller = new AbortController(), abort = () => controller.abort(); current.signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(abort, timeoutMs); let response, reader;
        try {
            check(current.signal);
            const url = `${prefix}${path}`, supplied = await abortable(headers({ identity: current.identity, url, signal: controller.signal }), controller.signal);
            if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) || Reflect.ownKeys(supplied).length > 32) throw new Error('Invalid workflow headers.');
            const requestHeaders = new Headers(); let headerBytes = 0;
            for (const name of Reflect.ownKeys(supplied)) {
                const field = Object.getOwnPropertyDescriptor(supplied, name);
                if (typeof name !== 'string' || !Object.hasOwn(field, 'value') || typeof field.value !== 'string' || /[\r\n\0]/u.test(field.value) || /^(?:cookie|host|origin|referer|accept|content-type|content-length|connection|transfer-encoding|sec-.*|proxy-.*)$/iu.test(name)) throw new Error('Invalid workflow headers.');
                headerBytes += name.length + field.value.length; if (headerBytes > 8192) throw new Error('Workflow header limit exceeded.'); requestHeaders.set(name, field.value);
            }
            requestHeaders.set('Accept', 'application/json'); if (body) requestHeaders.set('Content-Type', 'application/json');
            response = await fetch(url, { method, headers: requestHeaders, body, credentials, redirect: 'error', cache: 'no-store', signal: controller.signal });
            if (!response.ok) throw new Error('Workflow request failed.');
            if (response.status === 204) return null;
            if ((response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json' || Number(response.headers.get('content-length')) > CONTEXT_BYTES || !response.body) throw new Error('Invalid workflow JSON response.');
            reader = response.body.getReader(); let bytes = 0, encoded = '';
            const decoder = new TextDecoder('utf-8', { fatal: true });
            while (true) {
                const part = await abortable(reader.read(), controller.signal); check(controller.signal);
                if (part.done) break;
                bytes += part.value.byteLength; if (bytes > CONTEXT_BYTES) throw new Error('Workflow JSON limit exceeded.'); encoded += decoder.decode(part.value, { stream: true });
            }
            encoded += decoder.decode(); return JSON.parse(encoded);
        } catch (error) {
            if (controller.signal.aborted || current.signal?.aborted || error?.name === 'AbortError') throw canceled();
            throw new Error('The workflow API did not return valid bounded JSON.');
        } finally {
            clearTimeout(timer); current.signal?.removeEventListener('abort', abort);
            if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
            else if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
        }
    }
    const keyPath = key => { const value = text(key, 64); if (!/^[A-Za-z0-9_.:-]+$/u.test(value) || ['.', '..'].includes(value)) throw new TypeError('Use an opaque workflow context key.'); return encodeURIComponent(value); };
    return {
        adapter: {
            list: current => request(`/worklist?offset=${current.offset}&limit=${current.limit}`, current),
            openStudy: current => request('/study-context', current, 'POST', JSON.stringify(current.reference))
        },
        shareAdapter: {
            create: current => request('/shares', current, 'POST', JSON.stringify({ reference: current.reference, ttlMs: current.ttlMs, viewerOrigin: current.viewerOrigin })),
            verify: current => request('/shares/verify', current, 'POST', JSON.stringify({ receipt: current.receipt, operation: current.operation })),
            revoke: current => request(`/shares/${keyPath(current.shareId)}`, current, 'DELETE')
        },
        persistence: {
            load: current => request(`/contexts/${keyPath(current.key)}`, current),
            save: current => request(`/contexts/${keyPath(current.key)}`, current, 'PUT', JSON.stringify(current.context))
        }
    };
}

export const createEnterpriseHttpAdapters = createWorkflowHttpAdapter;
