import EASI from '@xinonix/easi-js';
import { MAX_DERIVED_BYTES, integer, checkSignal, fail, validateStructure } from './common.js';

/** Bounded local bytes/Blob only. No URL fetch, bulk-data dereference or upload. */
export async function readDerivedInstance(input, { signal, maxBytes = MAX_DERIVED_BYTES } = {}) {
    integer(maxBytes, 1, MAX_DERIVED_BYTES); checkSignal(signal);
    const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
    if (!(bytes instanceof Uint8Array) && !(typeof Blob !== 'undefined' && input instanceof Blob)) fail('local bytes or a Blob is required');
    if ((bytes.byteLength ?? input.size) > maxBytes) fail('input exceeds its byte budget');
    const underlying = bytes instanceof Uint8Array ? new Blob([bytes]).stream() : input.stream(), reader = underlying.getReader();
    let total = 0, closed = false;
    const finish = () => { signal?.removeEventListener('abort', aborted); try { reader.releaseLock(); } catch {} };
    let streamController;
    const aborted = () => {
        if (closed) return; closed = true;
        const error = new DOMException('Derived-object processing was canceled.', 'AbortError');
        streamController?.error(error); Promise.resolve(reader.cancel(error)).catch(() => {}).finally(finish);
    };
    const source = new ReadableStream({
        start(controller) { streamController = controller; signal?.addEventListener('abort', aborted, { once: true }); if (signal?.aborted) aborted(); },
        async pull(controller) {
            try {
                checkSignal(signal); const chunk = await reader.read(); if (closed) return;
                if (chunk.done) { closed = true; finish(); controller.close(); return; }
                if (!(chunk.value instanceof Uint8Array) || (total += chunk.value.byteLength) > maxBytes) fail('input stream exceeds its byte budget');
                controller.enqueue(chunk.value);
            } catch (error) { if (!closed) { closed = true; controller.error(error); await reader.cancel(error).catch(() => {}); finish(); } }
        },
        async cancel(reason) { closed = true; await reader.cancel(reason).catch(() => {}); finish(); }
    });
    try {
        const result = await EASI.pipelineBuilder().fromPartStream().ofDicomData()
            .withBulkDataPolicy({ mode: 'materialize', hardSafetyCap: maxBytes }).toInstances().build()
            .process({ source, sourceOptions: { contentType: 'application/dicom' } });
        checkSignal(signal); if (result.count !== 1) fail('exactly one local DICOM instance is required');
        const instance = result.first(); validateStructure(instance.dataSet); return instance;
    } catch (error) { checkSignal(signal); throw error; }
    finally { if (!closed) { closed = true; await reader.cancel().catch(() => {}); } finish(); }
}
