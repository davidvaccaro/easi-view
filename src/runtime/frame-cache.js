/** Byte-budgeted LRU. The currently displayed frame is owned by the viewport. */
export class FrameCache {
    constructor(budget = 64 * 1024 * 1024) {
        if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error('Invalid decoded-frame cache budget.');
        this.budget = budget;
        this.bytes = 0;
        this.entries = new Map();
        this.buffers = new Map();
    }

    get(key) {
        const entry = this.entries.get(key);
        if (!entry) return null;
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.frame;
    }

    set(key, frame) {
        this.delete(key);
        // Shared LUT backing stores count once while any cached frame references them.
        const buffers = new Set([frame.samples, frame.modalityLut?.entries, frame.voiLut?.entries,
            frame.palette?.red, frame.palette?.green, frame.palette?.blue]
            .filter(ArrayBuffer.isView).map(view => view.buffer));
        const total = [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0);
        if (total > this.budget) return frame;
        const additional = () => [...buffers].reduce((sum, buffer) => sum + (this.buffers.has(buffer) ? 0 : buffer.byteLength), 0);
        while (this.bytes + additional() > this.budget) this.delete(this.entries.keys().next().value);
        this.entries.set(key, { frame, buffers });
        for (const buffer of buffers) {
            const count = this.buffers.get(buffer) ?? 0;
            if (count === 0) this.bytes += buffer.byteLength;
            this.buffers.set(buffer, count + 1);
        }
        return frame;
    }

    delete(key) {
        const entry = this.entries.get(key);
        if (!entry) return;
        for (const buffer of entry.buffers) {
            const count = this.buffers.get(buffer) - 1;
            if (count === 0) { this.buffers.delete(buffer); this.bytes -= buffer.byteLength; }
            else this.buffers.set(buffer, count);
        }
        this.entries.delete(key);
    }

    clear() {
        this.entries.clear();
        this.buffers.clear();
        this.bytes = 0;
    }
}
