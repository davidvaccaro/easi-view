import { plain, text, reference, context } from './contracts.js';

function worklistItem(value) {
    plain(value, ['key', 'title', 'reference', 'modality', 'priority', 'status']);
    const result = { key: text(value.key, 64), title: text(value.title, 128), reference: reference(value.reference) };
    if (value.modality != null) { if (typeof value.modality !== 'string' || !/^[A-Z0-9_]{1,16}$/u.test(value.modality)) throw new TypeError('Invalid worklist modality.'); result.modality = value.modality; }
    for (const [key, choices] of Object.entries({ priority: ['normal', 'urgent'], status: ['scheduled', 'ready', 'reading', 'complete'] })) {
        if (value[key] != null) { if (!choices.includes(value[key])) throw new TypeError('Invalid worklist state.'); result[key] = value[key]; }
    }
    return result;
}

/** Functional host worklists and explicit versioned persistence; no browser storage is implicit. */
export class WorkflowCoordinator {
    constructor({ session, adapter, persistence } = {}) {
        if (typeof session?.withIdentity !== 'function' || typeof adapter?.list !== 'function' || typeof adapter?.openStudy !== 'function' ||
            persistence != null && ['load', 'save'].some(key => typeof persistence[key] !== 'function')) throw new TypeError('Configure a host worklist adapter and optional context persistence.');
        this.session = session; this.adapter = adapter; this.persistence = persistence; this.disposed = false; this.lifetime = new AbortController();
    }
    signal(signal) { if (this.disposed) throw new Error('This workflow coordinator has been disposed.'); if (signal != null && !(signal instanceof AbortSignal)) throw new TypeError('Use an AbortSignal for enterprise workflows.'); return signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal; }
    listWorklist(options = {}) {
        plain(options, ['signal', 'offset', 'limit']);
        const { signal, offset = 0, limit = 25 } = options;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Use a bounded worklist page of at most100items.');
        return this.session.withIdentity('worklist', { signal: this.signal(signal) }, async current => {
            const page = await this.adapter.list({ ...current, offset, limit }); plain(page, ['items', 'nextOffset']);
            if (!Array.isArray(page.items) || page.items.length > limit || page.nextOffset != null && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset)) throw new TypeError('Invalid bounded worklist response.');
            const items = page.items.map(worklistItem);
            if (new Set(items.map(item => item.key)).size !== items.length) throw new TypeError('Duplicate worklist keys.');
            return { items, nextOffset: page.nextOffset ?? null };
        });
    }
    openStudy(value, { signal } = {}) {
        const selected = reference(value);
        return this.session.withIdentity('open-study', { signal: this.signal(signal) }, async current => {
            const result = context(await this.adapter.openStudy({ ...current, reference: selected }));
            const active = result.viewports.find(item => item.slot === result.activeViewport)?.reference;
            if (!active || Object.entries(selected).some(([key, value]) => active[key] !== value)) throw new Error('The requested study is not active in the returned context.');
            return result;
        });
    }
    saveContext(key, value, { signal } = {}) {
        if (!this.persistence) throw new Error('Context persistence is not configured.');
        const selectedKey = text(key, 64), selected = context(value);
        return this.session.withIdentity('save-context', { signal: this.signal(signal) }, async current => { await this.persistence.save({ ...current, key: selectedKey, context: selected }); return { saved: true }; });
    }
    dispose() { if (this.disposed) return; this.disposed = true; this.lifetime.abort(); this.adapter = null; this.persistence = null; }
    restoreContext(key, { signal } = {}) {
        if (!this.persistence) throw new Error('Context persistence is not configured.');
        const selectedKey = text(key, 64);
        return this.session.withIdentity('load-context', { signal: this.signal(signal) }, async current => { const value = await this.persistence.load({ ...current, key: selectedKey }); return value == null ? null : context(value); });
    }
}
