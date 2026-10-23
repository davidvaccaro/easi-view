import { plain, text, origin, reference, check } from './contracts.js';

const MAX_TTL = 24 * 60 * 60 * 1000;
function identifier(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(value)) throw new TypeError('Invalid controlled-share identifier.'); return value; }
function receipt(value) {
    plain(value, ['shareId', 'capability']);
    if (typeof value.capability !== 'string' || !value.capability || value.capability.length > 4096 || /[\x00-\x20\x7f]/u.test(value.capability)) throw new TypeError('Use a bounded opaque server-issued share receipt.');
    return { shareId: identifier(value.shareId), capability: value.capability };
}

/** Coordinates server-authorized shares. Browser booleans never enforce archive access. */
export class ShareCoordinator {
    constructor({ session, adapter, viewerOrigin, allowInsecureLoopback = false, limit = 64 } = {}) {
        if (typeof session?.withIdentity !== 'function' || !adapter || ['create', 'verify', 'revoke'].some(key => typeof adapter[key] !== 'function') ||
            !Number.isInteger(limit) || limit < 1 || limit > 256) throw new TypeError('Controlled sharing requires an explicit server adapter.');
        this.session = session; this.adapter = adapter; this.origin = origin(viewerOrigin, { loopback: allowInsecureLoopback });
        this.limit = limit; this.known = new Map(); this.disposed = false; this.lifetime = new AbortController();
        this.unsubscribe = session.subscribe?.(state => { if (!state.authenticated || state.disposed) this.known.clear(); });
    }
    ensureActive() { if (this.disposed) throw new Error('This controlled-share coordinator has been disposed.'); }
    validate(value, current, expectedId, { revoked = false, maximumExpiry = Date.now() + MAX_TTL } = {}) {
        plain(value, ['shareId', 'subject', 'realm', 'origin', 'expiresAt', 'revoked', 'permissions', 'reference']);
        if (identifier(value.shareId) !== expectedId || text(value.subject) !== current.identity.subject || text(value.realm) !== current.identity.realm ||
            origin(value.origin, { loopback: this.origin.startsWith('http:') }) !== this.origin || value.revoked !== revoked ||
            !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0 || value.expiresAt > maximumExpiry || !revoked && value.expiresAt <= Date.now() ||
            !Array.isArray(value.permissions) || value.permissions.length !== 1 || value.permissions[0] !== 'view') throw new Error('The server share verification is not current or bound to this identity and viewer.');
        return { shareId: expectedId, expiresAt: value.expiresAt, reference: reference(value.reference) };
    }
    remember(value) {
        this.prune(); this.known.delete(value.shareId); this.known.set(value.shareId, { expiresAt: value.expiresAt, generation: this.session.generation });
        while (this.known.size > this.limit) this.known.delete(this.known.keys().next().value);
    }
    prune() { for (const [key, value] of this.known) if (value.expiresAt <= Date.now() || value.generation !== this.session.generation) this.known.delete(key); }
    getState() { this.prune(); return { configured: !this.disposed, activeShareCount: this.known.size, disposed: this.disposed }; }
    signal(signal) { if (signal != null && !(signal instanceof AbortSignal)) throw new TypeError('Use an AbortSignal for controlled sharing.'); return signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal; }
    create(value, { ttlMs = 15 * 60 * 1000, signal } = {}) {
        this.ensureActive(); const selected = reference(value);
        if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > MAX_TTL) throw new TypeError('Use a share lifetime from one second to24hours.');
        return this.session.withIdentity('create-share', { signal: this.signal(signal) }, async current => {
            const issued = receipt(await this.adapter.create({ ...current, reference: selected, ttlMs, viewerOrigin: this.origin }));
            check(current.signal);
            // A remote server starts its lifetime when creation arrives, after network transit.
            const maximumExpiry = Date.now() + ttlMs;
            const verified = this.validate(await this.adapter.verify({ ...current, receipt: issued, operation: 'create' }), current, issued.shareId, { maximumExpiry });
            if (JSON.stringify(verified.reference) !== JSON.stringify(selected)) throw new Error('The verified share does not match the requested archive resource.');
            check(current.signal); this.ensureActive(); this.remember(verified);
            // Credential material is returned only from this explicit create call.
            return { shareId: issued.shareId, capability: issued.capability, expiresAt: verified.expiresAt };
        });
    }
    resolve(value, { signal } = {}) {
        this.ensureActive(); const issued = receipt(value);
        return this.session.withIdentity('resolve-share', { signal: this.signal(signal) }, async current => {
            try {
                const verified = this.validate(await this.adapter.verify({ ...current, receipt: issued, operation: 'resolve' }), current, issued.shareId);
                check(current.signal); this.ensureActive(); this.remember(verified); return verified;
            } catch (error) { this.known.delete(issued.shareId); throw error; }
        });
    }
    revoke(shareId, { signal } = {}) {
        this.ensureActive(); const selected = identifier(shareId);
        return this.session.withIdentity('revoke-share', { signal: this.signal(signal) }, async current => {
            const issued = receipt(await this.adapter.revoke({ ...current, shareId: selected }));
            check(current.signal);
            if (issued.shareId !== selected) throw new Error('Share revocation returned the wrong resource.');
            this.validate(await this.adapter.verify({ ...current, receipt: issued, operation: 'revoke' }), current, selected, { revoked: true });
            check(current.signal); this.ensureActive(); this.known.delete(selected); return { shareId: selected, revoked: true };
        });
    }
    dispose() { if (this.disposed) return; this.disposed = true; this.lifetime.abort(); this.unsubscribe?.(); this.known.clear(); this.adapter = null; }
}
