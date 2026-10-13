import { decodeNative } from '../data/native.js';

self.onmessage = ({ data }) => {
    try {
        const result = decodeNative(new Uint8Array(data.bytes), data.metadata);
        self.postMessage({ id: data.id, samples: result.samples, range: result.range }, [result.samples.buffer]);
    } catch (error) {
        self.postMessage({ id: data.id, error: error.message });
    }
};
