import { decodeNative } from '../data/native.js';

export function abortError() {
    return new DOMException('The operation was canceled.', 'AbortError');
}

export function checkAbort(signal) {
    if (signal?.aborted) throw abortError();
}

/** One active decode limits transferred frame copies and keeps the UI responsive. */
export class NativeDecoder {
    constructor() {
        this.queue = [];
        this.active = null;
        this.worker = null;
        this.disposed = false;
        this.nextId = 1;
    }

    decode(bytes, metadata, { signal } = {}) {
        if (this.disposed) return Promise.reject(new Error('This source has been disposed.'));
        if (signal?.aborted) return Promise.reject(abortError());
        return new Promise((resolve, reject) => {
            const job = { id: this.nextId++, bytes, metadata, signal, resolve, reject };
            job.onAbort = () => {
                const index = this.queue.indexOf(job);
                if (index >= 0) {
                    this.queue.splice(index, 1);
                    signal.removeEventListener('abort', job.onAbort);
                    reject(abortError());
                } else if (this.active === job) {
                    this.worker?.terminate();
                    this.worker = null;
                    this.finish(null, abortError());
                }
            };
            signal?.addEventListener('abort', job.onAbort, { once: true });
            this.queue.push(job);
            this.pump();
        });
    }

    pump() {
        if (this.active || this.disposed || this.queue.length === 0) return;
        this.active = this.queue.shift();
        const job = this.active;
        if (typeof Worker === 'function') {
            try {
                if (!this.worker) {
                    const worker = new Worker(new URL('./decode-worker.js', import.meta.url), { type: 'module' });
                    this.worker = worker;
                    worker.onmessage = ({ data }) => {
                        if (worker !== this.worker) return;
                        if (data.id !== this.active?.id) return;
                        this.finish(data.error ? null : { samples: data.samples, range: data.range }, data.error ? new Error(data.error) : null);
                    };
                    worker.onerror = () => {
                        if (worker !== this.worker) return;
                        this.worker?.terminate();
                        this.worker = null;
                        this.finish(null, new Error('The pixel decoding worker failed.'));
                    };
                }
                // Transfer a single frame copy, never detach the retained encoded instance.
                const copy = job.bytes.slice();
                const { rows, columns, bitsAllocated, bitsStored, highBit, signed, littleEndian, slope, intercept, padding } = job.metadata;
                this.worker.postMessage({ id: job.id, bytes: copy.buffer,
                    metadata: { rows, columns, bitsAllocated, bitsStored, highBit, signed, littleEndian, slope, intercept, padding }
                }, [copy.buffer]);
            } catch (error) {
                this.finish(null, error);
            }
        } else {
            // Deterministic CPU implementation for Node tests and a worker-less browser.
            queueMicrotask(() => {
                if (this.active !== job) return;
                try { checkAbort(job.signal); this.finish(decodeNative(job.bytes, job.metadata)); }
                catch (error) { this.finish(null, error); }
            });
        }
    }

    finish(value, error = null) {
        const job = this.active;
        if (!job) return;
        this.active = null;
        job.signal?.removeEventListener('abort', job.onAbort);
        if (error) job.reject(error);
        else job.resolve(value);
        this.pump();
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.worker?.terminate();
        this.worker = null;
        if (this.active) this.finish(null, abortError());
        for (const job of this.queue) {
            job.signal?.removeEventListener('abort', job.onAbort);
            job.reject(abortError());
        }
        this.queue = [];
    }
}
