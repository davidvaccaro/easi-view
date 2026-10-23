import { decodeFrame } from '../data/compressed.js';

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
                        if (data.error) { this.worker?.terminate(); this.worker = null; }
                        const precisionOverride = data.bitsStored !== undefined || data.highBit !== undefined;
                        const metadata = this.active.metadata;
                        if (!data.error && precisionOverride && !(data.bitsStored === 16 && data.highBit === 15 &&
                            metadata.bitsAllocated === 16 && metadata.bitsStored === 12 && metadata.highBit === 11 && metadata.signed === false && metadata.samplesPerPixel === 1 &&
                            !metadata.modalityLut && !metadata.voiLut && !metadata.hasVoiLut &&
                            ['MONOCHROME1', 'MONOCHROME2'].includes(metadata.encodedPhotometric ?? metadata.photometric) &&
                            ['1.2.840.10008.1.2.4.57', '1.2.840.10008.1.2.4.70'].includes(metadata.transferSyntax))) {
                            this.worker?.terminate(); this.worker = null;
                            this.finish(null, new Error('The pixel decoding worker returned inconsistent precision metadata.')); return;
                        }
                        this.finish(data.error ? null : { samples: data.samples, range: data.range,
                            ...(precisionOverride ? { bitsStored: data.bitsStored, highBit: data.highBit } : {}),
                            ...(Array.isArray(data.encodingWarnings) ? { encodingWarnings: [...data.encodingWarnings] } : {}) }, data.error ? new Error(data.error) : null);
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
                const { rows, columns, bitsAllocated, bitsStored, highBit, signed, littleEndian, slope, intercept, padding,
                    photometric, samplesPerPixel, planarConfiguration, transferSyntax, encodedPhotometric, modalityLut, pixelDecodingProfile, encodingWarnings } = job.metadata;
                this.worker.postMessage({ id: job.id, bytes: copy.buffer,
                    metadata: { rows, columns, bitsAllocated, bitsStored, highBit, signed, littleEndian, slope, intercept, padding,
                        photometric, samplesPerPixel, planarConfiguration, transferSyntax, encodedPhotometric, modalityLut, pixelDecodingProfile,
                        hasVoiLut: Boolean(job.metadata.voiLut || job.metadata.hasVoiLut),
                        ...(Array.isArray(encodingWarnings) ? { encodingWarnings: [...new Set(encodingWarnings)] } : {}) }
                }, [copy.buffer]);
            } catch (error) {
                this.finish(null, error);
            }
        } else {
            // Deterministic CPU implementation for Node tests and a worker-less browser.
            queueMicrotask(async () => {
                if (this.active !== job) return;
                try { checkAbort(job.signal); const result = await decodeFrame(job.bytes, job.metadata); if (this.active === job) { checkAbort(job.signal); this.finish(result); } }
                catch (error) { if (this.active === job) this.finish(null, error); }
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
