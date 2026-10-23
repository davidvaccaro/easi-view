import { decodeFrame } from '../data/compressed.js';

self.onmessage = async ({ data }) => {
    try {
        const result = await decodeFrame(new Uint8Array(data.bytes), data.metadata);
        self.postMessage({ id: data.id, samples: result.samples, range: result.range, encodingWarnings: result.encodingWarnings,
            ...(result.bitsStored != null ? { bitsStored: result.bitsStored, highBit: result.highBit } : {}) }, [result.samples.buffer]);
    } catch (error) {
        self.postMessage({ id: data.id, error: error.message });
    }
};
