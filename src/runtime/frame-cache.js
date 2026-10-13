/** Byte-budgeted LRU. The currently displayed frame is owned by the viewport. */
export class FrameCache {
    constructor(budget = 64 * 1024 * 1024) {
        if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error('Invalid decoded-frame cache budget.');
        this.budget = budget;
        this.bytes = 0;
        this.entries = new Map();
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
        const bytes = frame.samples.byteLength;
        if (bytes > this.budget) return frame;
        while (this.bytes + bytes > this.budget) this.delete(this.entries.keys().next().value);
        this.entries.set(key, { frame, bytes });
        this.bytes += bytes;
        return frame;
    }

    delete(key) {
        const entry = this.entries.get(key);
        if (!entry) return;
        this.bytes -= entry.bytes;
        this.entries.delete(key);
    }

    clear() {
        this.entries.clear();
        this.bytes = 0;
    }
}
