import { abortError, checkAbort } from './native-decoder.js';

/** A source owns its jobs, while the workspace owns the single decoding worker. */
export class ScopedDecoder {
    constructor(decoder) {
        this.decoder = decoder; this.controllers = new Set(); this.disposed = false;
    }
    get worker() { return this.disposed ? null : this.decoder.worker; }
    async decode(bytes, metadata, { signal } = {}) {
        if (this.disposed) throw new Error('This source decoder has been disposed.');
        checkAbort(signal);
        const controller = new AbortController(), abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true }); this.controllers.add(controller);
        try {
            const result = await this.decoder.decode(bytes, metadata, { signal: controller.signal });
            checkAbort(controller.signal); if (this.disposed) throw abortError(); return result;
        } finally { signal?.removeEventListener('abort', abort); this.controllers.delete(controller); }
    }
    dispose() {
        if (this.disposed) return; this.disposed = true;
        for (const controller of this.controllers) controller.abort(); this.controllers.clear();
    }
}
