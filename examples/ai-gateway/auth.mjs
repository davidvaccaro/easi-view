import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_SECONDS = 30 * 60;
export const SESSION_COOKIE = 'easi_ai_demo';
export const digest = value => createHash('sha256').update(String(value)).digest('hex');
export function equalSecret(actual, expected) {
    return typeof actual === 'string' && typeof expected === 'string' && expected.length >= 24 &&
        timingSafeEqual(createHash('sha256').update(actual).digest(), createHash('sha256').update(expected).digest());
}

/** A demo access code never appears in the viewer bundle, URLs, or response logs. */
export class DemoSessions {
    constructor({ passcode, secure = true, path = '/api/ai', now = Date.now, context = 'legacy' } = {}) {
        if (typeof passcode !== 'string' || !/^[A-Za-z0-9_-]{24,128}$/.test(passcode)) throw new Error('A strong server-side demo access code is required.');
        if (typeof context !== 'string' || !/^[A-Za-z0-9._:/@+ -]{1,256}$/.test(context)) throw new Error('Invalid server session context.');
        this.passcode = passcode; this.secure = secure; this.path = path; this.now = now;
        this.key = createHmac('sha256', passcode).update(`EASI View AI demo session v1|${context}`).digest();
    }
    authenticate(passcode) { return equalSecret(passcode, this.passcode); }
    issue() {
        const payload = Buffer.from(JSON.stringify({ v: 1, exp: Math.floor(this.now() / 1000) + SESSION_SECONDS, n: randomBytes(16).toString('base64url') })).toString('base64url');
        return `${payload}.${createHmac('sha256', this.key).update(payload).digest('base64url')}`;
    }
    accepts(cookie = '') {
        if (typeof cookie !== 'string' || cookie.length > 8192) return false;
        const matches = cookie.split(';').map(value => value.trim()).filter(value => value.startsWith(`${SESSION_COOKIE}=`));
        if (matches.length !== 1) return false;
        const token = matches[0].slice(SESSION_COOKIE.length + 1);
        if (!/^[A-Za-z0-9_-]{1,256}\.[A-Za-z0-9_-]{43}$/.test(token)) return false;
        const [payload, signature] = token.split('.'), expected = createHmac('sha256', this.key).update(payload).digest('base64url');
        if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
        try {
            const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()), seconds = Math.floor(this.now() / 1000);
            return claims.v === 1 && Number.isSafeInteger(claims.exp) && claims.exp > seconds && claims.exp <= seconds + SESSION_SECONDS &&
                typeof claims.n === 'string' && /^[A-Za-z0-9_-]{22}$/.test(claims.n);
        } catch { return false; }
    }
    cookie(value = '', clear = false) {
        return `${SESSION_COOKIE}=${value}; Path=${this.path}; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_SECONDS}${this.secure ? '; Secure' : ''}`;
    }
}

/** Local demonstration only; AWS uses atomic DynamoDB counters across workers. */
export class MemoryQuota {
    constructor({ now = Date.now } = {}) { this.now = now; this.counts = new Map(); }
    async consume(key, limit, seconds) {
        const slot = Math.floor(this.now() / (seconds * 1000)), id = `${key}:${slot}`, count = this.counts.get(id)?.count ?? 0;
        for (const [old, entry] of this.counts) if (entry?.expires <= this.now()) this.counts.delete(old);
        if (count >= limit) return false;
        this.counts.set(id, { count: count + 1, expires: (slot + 2) * seconds * 1000 });
        // No client identities or request data are stored; only bounded counter keys.
        if (this.counts.size > 4096) this.counts.delete(this.counts.keys().next().value);
        return true;
    }
}
