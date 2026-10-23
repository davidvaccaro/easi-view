export const DEFAULT_ENCODED_CACHE_BYTES = 64 * 1024 * 1024;

export function releaseEncoded(record) {
    record.encapsulated?.dispose();
    record.encapsulated = null;
    record.bytes = new Uint8Array(0);
}

/** Byte-bounded original-instance LRU; only retained encoded bytes belong here. */
export class EncodedInstanceCache {
    constructor(budget = DEFAULT_ENCODED_CACHE_BYTES) {
        if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error('Invalid encoded-instance cache budget.');
        this.budget = budget; this.bytes = 0; this.entries = new Map();
    }
    get(key) {
        const record = this.entries.get(key); if (!record) return null;
        this.entries.delete(key); this.entries.set(key, record); return record;
    }
    set(key, record) {
        if (this.entries.get(key) === record) { this.get(key); return record; }
        this.delete(key);
        if (record.bytes.byteLength > this.budget) return record;
        while (this.bytes + record.bytes.byteLength > this.budget) this.delete(this.entries.keys().next().value);
        this.entries.set(key, record); this.bytes += record.bytes.byteLength; return record;
    }
    delete(key) {
        const record = this.entries.get(key); if (!record) return;
        this.bytes -= record.bytes.byteLength; this.entries.delete(key); releaseEncoded(record);
    }
    clear() { for (const key of [...this.entries.keys()]) this.delete(key); }
    takeEntries() { const records = [...this.entries]; this.entries.clear(); this.bytes = 0; return records; }
}

// A lazy map view avoids cloning the entire shared LRU for every has()/get().
class ScopedEntries {
    constructor(owner) { this.owner = owner; }
    has(key) { return this.owner.cache.entries.has(this.owner.key(key)); }
    get(key) { return this.owner.cache.entries.get(this.owner.key(key)); }
    *entries() {
        const { cache, prefix } = this.owner;
        for (const [key, record] of cache.entries) if (key.startsWith(`${prefix}|`)) yield [key.slice(prefix.length + 1), record];
    }
    *keys() { for (const [key] of this.entries()) yield key; }
    *values() { for (const [, record] of this.entries()) yield record; }
    [Symbol.iterator]() { return this.entries(); }
    get size() { let count = 0; for (const _ of this.entries()) count++; return count; }
}

/** Session-local cache API over one workspace original-instance budget. */
export class ScopedEncodedCache {
    constructor(cache, prefix) { this.cache = cache; this.prefix = prefix; this.entries = new ScopedEntries(this); }
    key(key) { return `${this.prefix}|${key}`; }
    get(key) { return this.cache.get(this.key(key)); }
    set(key, record) { return this.cache.set(this.key(key), record); }
    delete(key) { this.cache.delete(this.key(key)); }
    clear() { for (const key of [...this.entries.keys()]) this.delete(key); }
    takeEntries() {
        const records = [...this.entries];
        for (const [key, record] of records) { this.cache.entries.delete(this.key(key)); this.cache.bytes -= record.bytes.byteLength; }
        return records;
    }
    get budget() { return this.cache.budget; }
    get bytes() { let total = 0; for (const record of this.entries.values()) total += record.bytes.byteLength; return total; }
}
