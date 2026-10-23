import { clockNow } from '../runtime/performance.js';
import { AUDIT_OPERATIONS, plain, text, origin, canceled, check, abortable, observe } from './contracts.js';

const FORBIDDEN = new Set(['accept', 'cookie', 'host', 'origin', 'referer', 'connection', 'content-length', 'content-type', 'transfer-encoding', 'proxy-authorization']);
function identity(value) {
    if (value == null) return null;
    plain(value, ['subject', 'realm', 'expiresAt']);
    if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now()) throw new Error('The enterprise identity is expired or invalid.');
    return { subject: text(value.subject), realm: text(value.realm), expiresAt: value.expiresAt };
}
function headers(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length > 32) throw new TypeError('Use bounded enterprise request headers.');
    const result = {}; let bytes = 0;
    for (const name of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (typeof name !== 'string' || !Object.hasOwn(descriptor, 'value') || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u.test(name) || FORBIDDEN.has(name.toLowerCase()) || /^(?:sec-|proxy-)/iu.test(name) || typeof descriptor.value !== 'string' || /[\r\n\0]/u.test(descriptor.value)) throw new TypeError('Unsupported enterprise request header.');
        bytes += name.length + descriptor.value.length;
        if (bytes > 8192) throw new TypeError('Enterprise request headers exceed their8KiB bound.');
        result[name] = descriptor.value;
    }
    return result;
}

/** Host identity integration; authorization remains enforced by the host/backend. */
export class EnterpriseSession {
    constructor({ identityAdapter, archiveOrigins, allowInsecureLoopback = false, audit } = {}) {
        if (!identityAdapter || ['login', 'logout', 'current', 'getHeaders'].some(key => typeof identityAdapter[key] !== 'function') ||
            !Array.isArray(archiveOrigins) || !archiveOrigins.length || archiveOrigins.length > 16 || typeof allowInsecureLoopback !== 'boolean' || audit != null && typeof audit !== 'function') throw new TypeError('Configure host identity callbacks and explicit archive origins.');
        this.adapter = identityAdapter; this.origins = new Set(archiveOrigins.map(value => origin(value, { loopback: allowInsecureLoopback })));
        this.audit = audit; this.identity = null; this.loggedOut = false; this.generation = 0; this.controllers = new Set(); this.listeners = new Set(); this.disposed = false;
    }
    getState() { return { authenticated: !this.disposed && !this.loggedOut && Boolean(this.identity && this.identity.expiresAt > Date.now()), expiresAt: this.disposed || this.loggedOut ? null : this.identity?.expiresAt ?? null, disposed: this.disposed }; }
    getRevision() { return this.generation; }
    subscribe(callback) { this.ensureActive(); if (typeof callback !== 'function') throw new TypeError('Use an enterprise state observer.'); this.listeners.add(callback); return () => this.listeners.delete(callback); }
    ensureActive() { if (this.disposed) throw new Error('This enterprise session has been disposed.'); }
    notify() { const state = this.getState(); for (const callback of this.listeners) observe(callback, { ...state }); }
    clearRequests() { for (const controller of this.controllers) controller.abort(); }
    invalidateRefresh(controller) {
        // An aborted older refresh must not clear a newer explicit login.
        check(controller.signal); this.ensureActive(); this.loggedOut = true;
        const active = [...this.controllers].find(value => value.signal === controller.signal);
        this.update(null, active);
    }
    update(value, active) {
        let next;
        try { next = identity(value); } catch (error) { this.identity = null; this.generation++; for (const controller of this.controllers) if (controller !== active) controller.abort(); this.notify(); throw error; }
        const changed = next?.subject !== this.identity?.subject || next?.realm !== this.identity?.realm;
        if (changed) { this.generation++; for (const controller of this.controllers) if (controller !== active) controller.abort(); }
        this.identity = next; this.notify(); return next;
    }
    async operation(name, signal, callback) {
        this.ensureActive(); if (!AUDIT_OPERATIONS.has(name) || signal != null && !(signal instanceof AbortSignal)) throw new TypeError('Use a supported enterprise operation and AbortSignal.');
        check(signal);
        const controller = new AbortController(), abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true }); this.controllers.add(controller);
        const started = clockNow(); let status = 'error';
        try { const result = await abortable(callback(controller), controller.signal); check(controller.signal); status = 'success'; return result; }
        catch (error) { if (controller.signal.aborted || signal?.aborted || error?.name === 'AbortError') { status = 'canceled'; throw canceled(); } throw new Error('The enterprise operation could not complete with valid authorized data.'); }
        finally { signal?.removeEventListener('abort', abort); this.controllers.delete(controller); observe(this.audit, { operation: name, status, durationMs: Math.max(0, clockNow() - started) }); }
    }
    login({ signal } = {}) {
        this.ensureActive(); this.clearRequests(); this.generation++; this.loggedOut = true; this.identity = null; this.notify();
        return this.operation('login', signal, async controller => {
            let value = await abortable(this.adapter.login({ signal: controller.signal }), controller.signal);
            if (value === undefined) value = await abortable(this.adapter.current({ signal: controller.signal }), controller.signal);
            check(controller.signal); if (!this.update(value, controller)) throw new Error('Authentication is required.'); this.loggedOut = false; this.notify(); return this.getState();
        });
    }
    logout({ signal } = {}) {
        this.ensureActive(); this.clearRequests(); this.generation++; this.loggedOut = true; this.identity = null; this.notify();
        return this.operation('logout', signal, async controller => { await abortable(this.adapter.logout({ signal: controller.signal }), controller.signal); return this.getState(); });
    }
    withIdentity(name, { signal } = {}, callback) {
        return this.operation(name, signal, async controller => {
            if (this.loggedOut) throw new Error('Authentication is required after explicit logout.');
            let value;
            try { value = await abortable(this.adapter.current({ signal: controller.signal }), controller.signal); }
            catch (error) { this.invalidateRefresh(controller); throw error; }
            check(controller.signal); const current = this.update(value, controller);
            if (!current) throw new Error('Authentication is required.');
            const generation = this.generation;
            check(controller.signal);
            const result = await abortable(callback({ identity: { ...current }, signal: controller.signal }), controller.signal);
            check(controller.signal);
            if (generation !== this.generation || this.identity?.subject !== current.subject || this.identity?.realm !== current.realm) throw canceled();
            if (current.expiresAt <= Date.now()) { this.update(null, controller); throw new Error('Authentication expired.'); }
            return result;
        });
    }
    dicomHeaders({ url, signal } = {}) {
        this.ensureActive();
        let parsed; try { parsed = new URL(url); } catch { throw new TypeError('The DICOM request origin is not configured.'); }
        if (!this.origins.has(parsed.origin) || parsed.username || parsed.password || parsed.hash) throw new TypeError('The DICOM request origin is not configured.');
        return this.withIdentity('dicom-auth', { signal }, async current => {
            try { return headers(await abortable(this.adapter.getHeaders({ ...current, url: parsed.href }), current.signal)); }
            catch (error) { this.invalidateRefresh({ signal: current.signal }); throw error; }
        });
    }
    dispose() { if (this.disposed) return; this.disposed = true; this.generation++; this.clearRequests(); this.identity = null; this.notify(); this.listeners.clear(); this.adapter = null; this.audit = null; }
}
