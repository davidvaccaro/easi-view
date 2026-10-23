import { EnterpriseSession } from '../enterprise/EnterpriseSession.js';
import { WorkflowCoordinator } from '../enterprise/WorkflowCoordinator.js';
import { ShareCoordinator } from '../enterprise/ShareCoordinator.js';
import { plain, origin, reference, context, canceled, check, abortable, observe } from '../enterprise/contracts.js';

const owners = new WeakMap();
const OPTIONS = ['identityAdapter', 'archive', 'workflowAdapter', 'persistence', 'shareAdapter', 'viewerOrigin', 'audit', 'allowInsecureLoopback', 'onChange'];
function options(value, keys = ['signal']) { plain(value, keys); if (value.signal != null && !(value.signal instanceof AbortSignal)) throw new TypeError('Use an AbortSignal for enterprise viewing.'); check(value.signal); return value; }
function archiveConfiguration(value, loopback) {
    plain(value, ['key', 'baseUrl', 'retrievalMode']); const key = reference({ archiveKey: value.key, studyUid: '1' }).archiveKey;
    let parsed; try { parsed = new URL(value.baseUrl); } catch { throw new TypeError('Configure a fixed enterprise archive address.'); }
    origin(parsed.origin, { loopback });
    if (typeof value.baseUrl !== 'string' || parsed.username || parsed.password || parsed.search || parsed.hash ||
        value.retrievalMode != null && !['instance', 'frame'].includes(value.retrievalMode)) throw new TypeError('Use a fixed archive without URL credentials or parameters.');
    return Object.freeze({ key, baseUrl: parsed.href.replace(/\/+$/u, ''), retrievalMode: value.retrievalMode ?? 'instance', origin: parsed.origin });
}

class EnterpriseViewer {
    #viewer; #session; #workflow; #shares; #archive; #disposed = false; #viewerDisposed = false;
    #authorized = false; #configured = false; #securityEpoch = 0; #identityRevision = 0; #lastInvalidation = null;
    #lifetime = new AbortController(); #operations = new Set(); #authentication = null; #authenticationToken = 0; #contextRequest = null;
    #expiryTimer = null; #shareTimer = null; #activeShareId = null; #disconnectQueue = Promise.resolve(); #clearing = 0; #clearError = false;
    #listeners = new Set(); #onChange; #worklistCount = 0; #unsubscribe; #viewerUnsubscribe;

    constructor(viewer, configuration) {
        plain(configuration, OPTIONS);
        if (!viewer || ['configureArchive', 'disconnectArchive', 'exportStudyContext', 'applyStudyContext'].some(key => typeof viewer[key] !== 'function') ||
            configuration.onChange != null && typeof configuration.onChange !== 'function' || owners.has(viewer)) throw new TypeError('Use one enterprise controller per live viewer with study-context APIs.');
        if (viewer.getState?.().disposed) throw new TypeError('Use a live host viewer.');
        const loopback = configuration.allowInsecureLoopback ?? false;
        if (typeof loopback !== 'boolean') throw new TypeError('Local development must be enabled explicitly.');
        this.#archive = archiveConfiguration(configuration.archive, loopback); this.#viewer = viewer; this.#onChange = configuration.onChange;
        try {
            this.#session = new EnterpriseSession({ identityAdapter: configuration.identityAdapter, archiveOrigins: [this.#archive.origin], audit: configuration.audit, allowInsecureLoopback: loopback });
            this.#workflow = new WorkflowCoordinator({ session: this.#session, adapter: configuration.workflowAdapter, persistence: configuration.persistence });
            if (configuration.shareAdapter != null) this.#shares = new ShareCoordinator({ session: this.#session, adapter: configuration.shareAdapter, viewerOrigin: configuration.viewerOrigin, allowInsecureLoopback: loopback });
            this.#identityRevision = this.#session.getRevision();
            this.#unsubscribe = this.#session.subscribe(state => this.#identityChanged(state));
            if (typeof viewer.on === 'function') this.#viewerUnsubscribe = viewer.on('dispose', () => { this.#viewerDisposed = true; this.dispose().catch(() => {}); });
            owners.set(viewer, this);
        } catch (error) { this.#shares?.dispose(); this.#workflow?.dispose(); this.#session?.dispose(); this.#unsubscribe?.(); this.#viewerUnsubscribe?.(); throw error; }
    }
    #ensure() { if (this.#disposed) throw new Error('This enterprise viewer controller has been disposed.'); }
    #signedIn() {
        this.#ensure();
        if (!this.#authorized || !this.#session.getState().authenticated) {
            if (this.#authorized) this.#invalidate('expired');
            throw new Error('Sign in explicitly before using enterprise viewer services.');
        }
    }
    getState() {
        const authenticated = !this.#disposed && this.#authorized && this.#session.getState().authenticated;
        return { disposed: this.#disposed, authenticated, connected: authenticated && this.#configured, pendingOperations: this.#operations.size + Number(Boolean(this.#authentication)),
            clearingRemote: this.#clearing > 0, cleanupPending: this.#clearing > 0 || this.#operations.size > 0 || Boolean(this.#authentication), blocked: this.#clearError,
            worklistCount: authenticated ? this.#worklistCount : 0, sharingEnabled: !this.#disposed && Boolean(this.#shares), activeShareCount: authenticated ? this.#shares?.getState().activeShareCount ?? 0 : 0 };
    }
    subscribe(callback) { this.#ensure(); if (typeof callback !== 'function') throw new TypeError('Use an enterprise viewer state observer.'); this.#listeners.add(callback); return () => this.#listeners.delete(callback); }
    #emit() { const state = this.getState(); observe(this.#onChange, { ...state }); for (const callback of this.#listeners) observe(callback, { ...state }); }
    #abortOperations() { for (const controller of this.#operations) controller.abort(); this.#contextRequest = null; }
    #clearShare() { clearTimeout(this.#shareTimer); this.#shareTimer = null; this.#activeShareId = null; }
    #disconnect(viewer = this.#viewer) {
        if (!viewer || this.#viewerDisposed) return this.#disconnectQueue;
        ++this.#clearing; this.#emit();
        const pending = this.#disconnectQueue.catch(() => {}).then(async () => {
            try { if (!this.#viewerDisposed) await viewer.disconnectArchive(); this.#clearError = false; }
            catch { this.#clearError = true; throw new Error('The host viewer could not clear remote projections.'); }
            finally { --this.#clearing; this.#emit(); }
        });
        this.#disconnectQueue = pending; pending.catch(() => {}); return pending;
    }
    #invalidate(reason) {
        const key = `${this.#session.getRevision()}/${reason}`, active = this.#authorized || this.#configured;
        this.#authorized = false; this.#configured = false; ++this.#securityEpoch; this.#worklistCount = 0; this.#abortOperations(); this.#clearShare();
        if (active || key !== this.#lastInvalidation) { this.#lastInvalidation = key; this.#disconnect(); }
        this.#emit();
    }
    #scheduleExpiry(expiresAt) {
        clearTimeout(this.#expiryTimer); this.#expiryTimer = null;
        if (!expiresAt || this.#disposed) return;
        this.#expiryTimer = setTimeout(() => {
            this.#expiryTimer = null;
            if (this.#disposed) return;
            const current = this.#session.getState();
            if (current.authenticated && current.expiresAt > Date.now()) this.#scheduleExpiry(current.expiresAt);
            else this.#invalidate('expired');
        }, Math.min(2147483647, Math.max(1, expiresAt - Date.now())));
        this.#expiryTimer.unref?.();
    }
    #identityChanged(state) {
        if (this.#disposed) return;
        const revision = this.#session.getRevision(), changed = revision !== this.#identityRevision; this.#identityRevision = revision;
        if (!state.authenticated || changed) this.#invalidate(state.authenticated ? 'identity' : 'signed-out');
        this.#scheduleExpiry(state.authenticated ? state.expiresAt : null); this.#emit();
    }
    #reference(value) { const selected = reference(value); if (selected.archiveKey !== this.#archive.key) throw new TypeError('The reference does not belong to the configured archive.'); return selected; }
    #context(value, scope) {
        const selected = context(value);
        if (!selected.viewports.length || !selected.viewports.some(item => item.slot === selected.activeViewport)) throw new TypeError('A viewing context must activate an authorized archive pane.');
        for (const pane of selected.viewports) {
            const image = this.#reference(pane.reference);
            if (scope && ['archiveKey', 'studyUid', 'seriesUid', 'sopUid'].some(key => scope[key] != null && image[key] !== scope[key])) throw new TypeError('Every context pane must stay inside the verified share scope.');
        }
        return selected;
    }
    #valid(epoch, revision, signal) { return !this.#disposed && !signal.aborted && this.#authorized && this.#session.getState().authenticated && epoch === this.#securityEpoch && revision === this.#session.getRevision(); }
    async #invoke(method, args, signal, guard) {
        const viewer = this.#viewer, pending = Promise.resolve().then(() => { check(signal); return viewer[method](...args); });
        pending.then(() => {
            if ((!guard() || signal.aborted) && owners.get(viewer) === this) {
                // All login configurations use this same fixed archive and live header provider.
                // A late context commit is unsafe even if a newer identity/context has succeeded.
                if (method !== 'configureArchive' || !this.#authorized || !this.#session.getState().authenticated) this.#invalidate('stale-viewer-operation');
            }
        }).catch(() => {});
        const result = await abortable(pending, signal); check(signal); if (!guard()) throw canceled(); return result;
    }
    #data(optionsValue, callback, contextOperation = false) {
        const selected = options(optionsValue); this.#signedIn();
        const controller = new AbortController(), combined = AbortSignal.any([controller.signal, this.#lifetime.signal, ...(selected.signal ? [selected.signal] : [])]);
        if (contextOperation) { this.#contextRequest?.abort(); this.#contextRequest = controller; }
        this.#operations.add(controller); const epoch = this.#securityEpoch, revision = this.#session.getRevision(), guard = () => this.#valid(epoch, revision, combined); this.#emit();
        return (async () => {
            try { const result = await abortable(callback(combined, guard), combined); if (!guard()) throw canceled(); return result; }
            catch (error) { if (combined.aborted || error?.name === 'AbortError') throw canceled(); throw new Error('The enterprise viewer operation could not complete with authorized data.'); }
            finally { this.#operations.delete(controller); if (this.#contextRequest === controller) this.#contextRequest = null; this.#emit(); }
        })();
    }
    #auth(optionsValue, callback) {
        const selected = options(optionsValue); this.#ensure(); this.#authentication?.abort();
        const controller = new AbortController(), token = ++this.#authenticationToken;
        const combined = AbortSignal.any([controller.signal, this.#lifetime.signal, ...(selected.signal ? [selected.signal] : [])]); this.#authentication = controller; this.#invalidate('authentication');
        const active = () => !this.#disposed && !combined.aborted && token === this.#authenticationToken;
        const pending = (async () => {
            try { await abortable(callback(combined, active), combined); if (!active()) throw canceled(); }
            catch (error) { if (this.#authentication === controller) { this.#authorized = false; this.#configured = false; } if (combined.aborted || error?.name === 'AbortError') throw canceled(); throw new Error('The enterprise sign-in or sign-out could not complete safely.'); }
            finally { if (this.#authentication === controller) this.#authentication = null; this.#emit(); }
        })();
        return pending.then(() => this.getState());
    }
    login(optionsValue = {}) {
        return this.#auth(optionsValue, async (signal, active) => {
            await this.#session.login({ signal }); const revision = this.#session.getRevision(), epoch = this.#securityEpoch;
            await abortable(this.#disconnectQueue, signal); check(signal); if (!active()) throw canceled();
            const guard = () => active() && this.#session.getState().authenticated && revision === this.#session.getRevision() && epoch === this.#securityEpoch;
            await this.#invoke('configureArchive', [{ baseUrl: this.#archive.baseUrl, retrievalMode: this.#archive.retrievalMode, credentials: 'omit',
                headers: request => { this.#signedIn(); return this.#session.dicomHeaders(request); } }], signal, guard);
            if (!guard()) throw canceled(); this.#authorized = true; this.#configured = true; this.#emit();
        });
    }
    logout(optionsValue = {}) {
        return this.#auth(optionsValue, async signal => {
            const result = await Promise.allSettled([this.#session.logout({ signal }), abortable(this.#disconnectQueue, signal)]);
            if (result.some(value => value.status === 'rejected')) throw result.find(value => value.status === 'rejected').reason;
        });
    }
    listWorklist(optionsValue = {}) {
        options(optionsValue, ['signal', 'offset', 'limit']); const { signal, ...page } = optionsValue;
        return this.#data({ signal }, async current => { const result = await this.#workflow.listWorklist({ ...page, signal: current }); this.#worklistCount = result.items.length; return result; });
    }
    async #apply(value, scope, signal, guard) {
        const selected = this.#context(value, scope);
        await this.#session.withIdentity('open-study', { signal }, () => this.#invoke('applyStudyContext', [selected, { archiveKey: this.#archive.key, signal, ...(scope ? { scope: { ...scope } } : {}) }], signal, guard));
        if (!guard()) throw canceled();
    }
    async #open(selected, scope, signal, guard) {
        const resolved = await this.#workflow.openStudy(selected, { signal }); check(signal); return this.#apply(resolved, scope, signal, guard);
    }
    openStudy(value, optionsValue = {}) { const selected = this.#reference(value); return this.#data(optionsValue, async (signal, guard) => { await this.#open(selected, null, signal, guard); this.#clearShare(); }, true).then(() => this.getState()); }
    saveContext(key, optionsValue = {}) {
        return this.#data(optionsValue, async signal => {
            const selected = this.#context(this.#viewer.exportStudyContext({ archiveKey: this.#archive.key }));
            return this.#workflow.saveContext(key, selected, { signal });
        });
    }
    restoreContext(key, optionsValue = {}) {
        return this.#data(optionsValue, async (signal, guard) => {
            const selected = await this.#workflow.restoreContext(key, { signal }); if (selected == null) return null;
            await this.#apply(selected, null, signal, guard); this.#clearShare(); return true;
        }, true).then(result => result === null ? null : this.getState());
    }
    #sharing() { this.#ensure(); if (!this.#shares) throw new Error('Controlled sharing is not configured for this host viewer.'); }
    createShare(value, optionsValue = {}) {
        this.#sharing(); const selected = this.#reference(value); options(optionsValue, ['signal', 'ttlMs']);
        return this.#data({ signal: optionsValue.signal }, signal => this.#shares.create(selected, { signal, ...(optionsValue.ttlMs == null ? {} : { ttlMs: optionsValue.ttlMs }) }));
    }
    resolveShare(receipt, optionsValue = {}) {
        this.#sharing(); plain(receipt, ['shareId', 'capability']);
        return this.#data(optionsValue, async (signal, guard) => {
            let verified;
            try { verified = await this.#shares.resolve(receipt, { signal }); } catch (error) { if (this.#activeShareId === receipt.shareId) this.#invalidate('share-denied'); throw error; }
            const selected = this.#reference(verified.reference);
            await this.#open(selected, selected, signal, guard); if (verified.expiresAt <= Date.now()) { this.#invalidate('share-expired'); throw canceled(); }
            this.#clearShare(); this.#activeShareId = verified.shareId;
            const expire = () => { this.#shareTimer = null; if (this.#disposed || this.#activeShareId !== verified.shareId) return;
                if (verified.expiresAt > Date.now()) { this.#shareTimer = setTimeout(expire, Math.max(1, verified.expiresAt - Date.now())); this.#shareTimer.unref?.(); }
                else this.#invalidate('share-expired'); };
            this.#shareTimer = setTimeout(expire, Math.max(1, verified.expiresAt - Date.now())); this.#shareTimer.unref?.();
            return { shareId: verified.shareId, expiresAt: verified.expiresAt, reference: selected, opened: true };
        }, true);
    }
    revokeShare(shareId, optionsValue = {}) {
        this.#sharing(); return this.#data(optionsValue, signal => this.#shares.revoke(shareId, { signal })).then(async result => {
            if (this.#activeShareId === shareId) { this.#invalidate('share-revoked'); await this.#disconnectQueue; }
            return result;
        });
    }
    dispose() {
        if (this.#disposed) return this.#disconnectQueue.catch(() => {}).then(() => this.getState());
        this.#disposed = true; ++this.#authenticationToken; this.#authentication?.abort(); this.#lifetime.abort(); this.#abortOperations(); clearTimeout(this.#expiryTimer); this.#clearShare();
        this.#unsubscribe?.(); this.#viewerUnsubscribe?.(); this.#shares?.dispose(); this.#workflow.dispose(); this.#session.dispose(); this.#authorized = false; this.#configured = false;
        const viewer = this.#viewer, completion = this.#disconnect(); this.#emit(); this.#listeners.clear(); this.#onChange = null;
        return completion.then(() => this.getState()).finally(() => { if (owners.get(viewer) === this) owners.delete(viewer); });
    }
}

/** Explicit host identity/workflow integration; the caller continues to own and dispose its viewer. */
export function createEnterpriseViewer(viewer, configuration = {}) { return Object.freeze(new EnterpriseViewer(viewer, configuration)); }
