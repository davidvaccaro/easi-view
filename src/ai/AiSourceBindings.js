const validSeries = series => !!series && typeof series === 'object' && !series.disposed && Array.isArray(series.frames);
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 2048 || typeof id === 'number' && Number.isSafeInteger(id);

/** Stable local frame identities for progressively inserted/sorted sources.
 * Weakly owns series records containing primitive IDs only. No descriptor,
 * decoded frame, samples, source URL or strong series reference is retained. */
export class AiSourceBindings {
    #series = new WeakMap(); #sequence = 0;
    #record(series) {
        if (!validSeries(series)) return null;
        let record = this.#series.get(series);
        if (!record) {
            record = { key: `source-${++this.#sequence}`, ids: [], indices: new Map() };
            this.#series.set(series, record);
        }
        return record;
    }
    key(series) { return this.#record(series)?.key ?? null; }
    bind(series, descriptor) {
        if (!validSeries(series) || !validId(descriptor?.id)) return null;
        const id = descriptor.id;
        // Duplicate IDs cannot establish an exact source reference.
        if (series.frames.reduce((count, frame) => count + (frame?.id === id ? 1 : 0), 0) !== 1) return null;
        const record = this.#record(series);
        if (!record.indices.has(id)) { record.indices.set(id, record.ids.length); record.ids.push(id); }
        return { key: record.key, index: record.indices.get(id) };
    }
    resolve(source, seriesList) {
        if (!source || typeof source.key !== 'string' || !Number.isSafeInteger(source.index) || source.index < 0 || !Array.isArray(seriesList)) return null;
        const seen = new WeakSet();
        for (const series of seriesList) {
            if (!validSeries(series) || seen.has(series)) continue;
            seen.add(series);
            const record = this.#series.get(series);
            if (!record || record.key !== source.key || source.index >= record.ids.length) continue;
            const id = record.ids[source.index];
            let index = -1;
            for (let current = 0; current < series.frames.length; current++) if (series.frames[current]?.id === id) {
                if (index !== -1) return null;
                index = current;
            }
            return index === -1 ? null : { series, index };
        }
        return null;
    }
    /** Recheck a queued decode's identity immediately before renderer admission. */
    matches(source, seriesList, series, frame) {
        const resolved = this.resolve(source, seriesList);
        return !!resolved && resolved.series === series && validId(frame?.id) && series.frames[resolved.index]?.id === frame.id;
    }
    // Keep sequence monotonic so a pre-reset binding cannot match a later source.
    reset() { this.#series = new WeakMap(); }
    dispose() { this.reset(); }
}
