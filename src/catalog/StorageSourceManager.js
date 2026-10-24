import { DicomWebClient } from '../data/DicomWebClient.js';
import { DimseGatewayClient } from '../data/DimseGatewayClient.js';
import { checkAbort } from '../runtime/native-decoder.js';

export const STORAGE_SOURCES_KEY = 'easi-view.storage-sources.v1';
const MAX_PROFILES = 32, MAX_SAVED_BYTES = 64 * 1024, MAX_TESTS = 2;
const encoder = new TextEncoder(), publicError = Symbol('storage-source-error');
const inputKeys = ['id', 'name', 'connection', 'baseUrl', 'authentication', 'token', 'username', 'password', 'remember', 'isDefault', 'dimse',
    'managed', 'editable', 'hasCredentials', 'requiresCredentials'];
const connections = ['dicomweb', 'dimse-gateway', 'dimse-local'], authentications = ['none', 'session', 'bearer', 'basic'];
const plain = value => value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const data = (value, keys) => plain(value) && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const short = (value, limit) => typeof value === 'string' && value.length <= limit && !/[\x00-\x1f\x7f]/u.test(value);
const failure = (code, publicMessage) => Object.assign(new Error(publicMessage), { code, publicMessage, [publicError]: true });
const canceled = () => new DOMException('The connection operation was canceled.', 'AbortError');
function abortable(value, signal) {
    checkAbort(signal);
    return new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(canceled()); };
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(value).then(result => { signal.removeEventListener('abort', abort); signal.aborted ? reject(canceled()) : resolve(result); }, error => { signal.removeEventListener('abort', abort); reject(error); });
        if (signal.aborted) abort();
    });
}
function endpoint(value) {
    let url;
    try { url = new URL(value); } catch { throw failure('INVALID_URL', 'Enter an absolute HTTP or HTTPS service URL.'); }
    if (!short(value, 2048) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /[?#\\]/u.test(value)) {
        throw failure('INVALID_URL', 'Use an HTTP or HTTPS URL without embedded credentials, a query or a fragment.');
    }
    return url.href.replace(/\/+$/, '');
}
function local(host) { return host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/u.test(host); }
function publicProfile(value) {
    const { id, name, connection, baseUrl, authentication, remember, dimse } = value;
    return { id, name, connection, baseUrl, authentication, remember, ...(dimse ? { dimse: { ...dimse } } : {}) };
}
function secretPresent(entry) { return entry?.profile.authentication === 'bearer' ? !!entry.secret?.token : entry?.profile.authentication === 'basic' ? !!entry.secret?.username && !!entry.secret?.password : false; }
function secretRequired(entry) { return ['bearer', 'basic'].includes(entry.profile.authentication) && !secretPresent(entry); }
function identity(profile) { return JSON.stringify([profile.connection, profile.baseUrl, profile.authentication, profile.dimse ?? null]); }
function normalize(input, previous, { restoring = false } = {}) {
    if (!data(input, inputKeys) || !short(input.name, 100) || !input.name.trim() || !connections.includes(input.connection) ||
        !authentications.includes(input.authentication ?? 'none') || typeof (input.remember ?? false) !== 'boolean' || typeof (input.isDefault ?? false) !== 'boolean' ||
        input.id != null && (typeof input.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.id))) {
        throw failure('INVALID_PROFILE', 'Use a short source name, a supported connection and authentication method, and valid profile settings.');
    }
    const profile = { id: input.id, name: input.name.trim(), connection: input.connection, baseUrl: '', authentication: input.authentication ?? 'none', remember: input.remember ?? false };
    if (profile.connection === 'dimse-local') {
        const value = input.dimse;
        if (!data(value, ['host', 'port', 'callingAeTitle', 'calledAeTitle']) || !short(value.host, 253) || !value.host.trim() ||
            !Number.isInteger(Number(value.port)) || Number(value.port) < 1 || Number(value.port) > 65535 ||
            ['callingAeTitle', 'calledAeTitle'].some(key => !short(value[key], 16) || !/^[\x20-\x7e]{1,16}$/u.test(value[key].trim()) || value[key].includes('\\'))) {
            throw failure('INVALID_DIMSE', 'Enter the PACS host, port and valid calling and called AE titles (1–16 ASCII characters).');
        }
        if (profile.authentication !== 'none') throw failure('INVALID_DIMSE_AUTH', 'Native DIMSE uses the configured trusted AE/IP policy. HTTP credentials belong on an HTTP gateway connection.');
        profile.dimse = { host: value.host.trim(), port: Number(value.port), callingAeTitle: value.callingAeTitle.trim(), calledAeTitle: value.calledAeTitle.trim() };
    } else profile.baseUrl = endpoint(input.baseUrl);
    if (profile.authentication !== 'none') {
        const url = new URL(profile.baseUrl);
        if (url.protocol !== 'https:' && !local(url.hostname)) throw failure('HTTPS_REQUIRED', 'Authenticated remote services require HTTPS. HTTP is permitted only for loopback development.');
    }
    const same = previous && identity(profile) === identity(previous.profile), secret = {};
    if (profile.authentication === 'bearer') {
        if (input.token != null && !short(input.token, 4096)) throw failure('INVALID_CREDENTIAL', 'Enter a valid bounded bearer token without control characters.');
        const token = input.token?.trim() || (same ? previous.secret?.token : '');
        if (token && !/^[A-Za-z0-9._~+\/-]+=*$/u.test(token)) throw failure('INVALID_CREDENTIAL', 'Enter a valid bearer token without spaces or control characters.');
        if (!token && !restoring) throw failure('CREDENTIAL_REQUIRED', 'Enter a bearer token for this connection. A changed endpoint requires a fresh credential.');
        if (token) secret.token = token;
    } else if (profile.authentication === 'basic') {
        if (input.username != null && (!short(input.username, 256) || input.username.includes(':')) || input.password != null && !short(input.password, 4096)) {
            throw failure('INVALID_CREDENTIAL', 'Enter a bounded username and password without control characters; usernames cannot contain a colon.');
        }
        const username = input.username || (same ? previous.secret?.username : ''), sameUser = same && username === previous.secret?.username;
        const password = input.password || (sameUser ? previous.secret?.password : '');
        if ((!username || !password) && !restoring) throw failure('CREDENTIAL_REQUIRED', 'Enter a username and password. A changed endpoint or username requires a fresh password.');
        if (username && password) Object.assign(secret, { username, password });
    }
    return { profile, secret, connectorId: previous?.connectorId ?? null };
}
function configuration(entry, origin) {
    const { profile } = entry;
    return { id: profile.id, name: profile.name, type: profile.connection === 'dicomweb' ? 'dicomweb' : 'dimse', baseUrl: profile.baseUrl,
        credentials: profile.authentication === 'session' ? new URL(profile.baseUrl).origin === origin ? 'same-origin' : 'include' : 'omit',
        headers: () => {
            if (secretRequired(entry)) throw failure('CREDENTIAL_REQUIRED', 'Re-enter this source credential in Storage sources before connecting.');
            if (profile.authentication === 'bearer') return { Authorization: `Bearer ${entry.secret.token}` };
            if (profile.authentication === 'basic') return { Authorization: `Basic ${btoa(String.fromCharCode(...encoder.encode(`${entry.secret.username}:${entry.secret.password}`)))}` };
            return {};
        } };
}

/** User-owned connection profiles. Patient content and private credentials are
 * never persisted, returned by this manager, or included in connection results. */
export class StorageSourceManager {
    #registry; #storage; #origin; #canChange; #connector; #entries = new Map(); #defaultId = null;
    #lifetime = new AbortController(); #tests = new Map(); #busy = false; #loaded = false; #disposed = false; #stored = null; #timeout; #cleanupTimeout;
    warnings = [];
    constructor({ registry, storage = null, origin = globalThis.location?.origin ?? 'http://localhost', canChange = () => true, connector = null, testTimeoutMs = 15000, cleanupTimeoutMs = 1000 } = {}) {
        if (!registry || ['list', 'getSource', 'getClient', 'add', 'replace', 'remove'].some(key => typeof registry[key] !== 'function') ||
            typeof canChange !== 'function' || !Number.isSafeInteger(testTimeoutMs) || testTimeoutMs < 1 || testTimeoutMs > 15000 || !Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 1000) throw new TypeError('Configure a source registry, change guard and bounded connection-test timeout.');
        this.#origin = new URL(origin).origin;
        if (!['http:', 'https:'].includes(new URL(this.#origin).protocol)) throw new TypeError('Configure an HTTP or HTTPS viewer origin.');
        this.#registry = registry; this.#storage = storage && ['getItem', 'setItem', 'removeItem'].every(key => typeof storage[key] === 'function') ? storage : null;
        this.#canChange = canChange; this.#connector = connector; this.#timeout = testTimeoutMs; this.#cleanupTimeout = cleanupTimeoutMs;
    }
    #check() { if (this.#disposed) throw failure('DISPOSED', 'The storage source manager has been disposed.'); }
    get canRemember() { return !!this.#storage; }
    get defaultId() { return this.#defaultId; }
    async connectorAvailable() { this.#check(); try { return !!await this.#connector?.available(); } catch { return false; } }
    list() {
        this.#check();
        return this.#registry.list().map(source => {
            const owned = this.#entries.get(source.id);
            return { ...source, managed: !owned, editable: !!owned, isDefault: source.id === this.#defaultId,
                connection: owned?.profile.connection ?? (source.type === 'dimse' ? 'dimse-gateway' : 'dicomweb'),
                authentication: owned?.profile.authentication ?? 'managed', remember: owned?.profile.remember ?? false,
                hasCredentials: owned ? secretPresent(owned) : false, requiresCredentials: owned ? secretRequired(owned) : false };
        }).sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
    }
    getProfile(id) {
        const source = this.list().find(value => value.id === id);
        if (!source) throw failure('UNKNOWN_SOURCE', 'Choose an existing storage source.');
        const entry = this.#entries.get(id);
        return entry ? { ...publicProfile(entry.profile), isDefault: source.isDefault, managed: false, editable: true,
            hasCredentials: secretPresent(entry), requiresCredentials: secretRequired(entry) }
            : { id: source.id, name: source.name, connection: source.connection, isDefault: source.isDefault, managed: true, editable: false };
    }
    #signal(signal) { return AbortSignal.any([this.#lifetime.signal, ...(signal ? [signal] : [])]); }
    async #guard(id, signal) {
        checkAbort(signal);
        let allowed; try { allowed = await abortable(this.#canChange(id), signal); } catch (error) {
            if (signal.aborted || error?.name === 'AbortError') throw canceled();
            throw failure('SOURCE_IN_USE', 'Close this source’s viewing session before changing or removing it.');
        }
        if (allowed === false) throw failure('SOURCE_IN_USE', 'Close this source’s viewing session before changing or removing it.');
        checkAbort(signal);
    }
    #snapshot(entries, defaultId) {
        const profiles = [...entries.values()].filter(entry => entry.profile.remember).map(entry => ({ ...publicProfile(entry.profile),
            ...(entry.connectorId ? { connectorId: entry.connectorId } : {}) }));
        const rememberedDefault = defaultId && (!entries.has(defaultId) || entries.get(defaultId).profile.remember) ? defaultId : null;
        if (!profiles.length && !rememberedDefault) return null;
        const value = JSON.stringify({ version: 1, profiles, defaultId: rememberedDefault });
        if (encoder.encode(value).byteLength > MAX_SAVED_BYTES) throw failure('STORAGE_LIMIT', 'Saved storage source settings exceed the 64 KiB limit. Remember fewer sources.');
        return value;
    }
    #persist(entries, defaultId) {
        const value = this.#snapshot(entries, defaultId);
        if (!this.#storage || value === this.#stored) return;
        try { value == null ? this.#storage.removeItem(STORAGE_SOURCES_KEY) : this.#storage.setItem(STORAGE_SOURCES_KEY, value); this.#stored = value; }
        catch { throw failure('STORAGE_UNAVAILABLE', 'Browser settings could not be saved. Allow local storage or turn off Remember this source.'); }
    }
    #restoreStored(value) {
        if (!this.#storage || value === this.#stored) return;
        try { value == null ? this.#storage.removeItem(STORAGE_SOURCES_KEY) : this.#storage.setItem(STORAGE_SOURCES_KEY, value); this.#stored = value; }
        catch { this.warnings.push('Saved settings could not be restored after an interrupted source change. Review remembered sources before reconnecting.'); }
    }
    async #cleanup(id, budget = this.#cleanupTimeout) {
        let timer;
        try {
            const pending = Promise.resolve(this.#connector.remove(id)).then(() => true, () => {
                this.warnings.push('An unused local connector profile could not be removed.'); return true;
            });
            if (budget <= 0) return;
            const completed = await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve(false), budget); })]);
            if (!completed) this.warnings.push('Local connector cleanup is continuing in the background.');
        } catch { this.warnings.push('An unused local connector profile could not be removed.'); }
        finally { clearTimeout(timer); }
    }
    #invalidate(id) { for (const [controller, sourceId] of this.#tests) if (sourceId === id) controller.abort(); }
    async load() {
        this.#check(); if (this.#loaded) return this.list(); this.#loaded = true;
        if (!this.#storage) return this.list();
        let value;
        try {
            const raw = this.#storage.getItem(STORAGE_SOURCES_KEY); this.#stored = raw;
            if (!raw) return this.list();
            if (encoder.encode(raw).byteLength > MAX_SAVED_BYTES) throw new Error();
            value = JSON.parse(raw);
            if (!data(value, ['version', 'profiles', 'defaultId']) || value.version !== 1 || !Array.isArray(value.profiles) || value.profiles.length > MAX_PROFILES) throw new Error();
        } catch { this.warnings.push('Saved storage source settings could not be read. Existing application sources remain available.'); return this.list(); }
        let localTargets;
        for (const input of value.profiles) {
            checkAbort(this.#lifetime.signal);
            try {
                if (!data(input, [...inputKeys, 'connectorId']) || typeof input.id !== 'string' || input.remember !== true || ['token', 'username', 'password'].some(key => Object.hasOwn(input, key))) throw new Error();
                const { connectorId, ...fields } = input, entry = normalize(fields, null, { restoring: true });
                if (entry.profile.connection === 'dimse-local') {
                    if (!this.#connector || typeof connectorId !== 'string') throw new Error();
                    localTargets ??= await abortable(this.#connector.list({ signal: this.#lifetime.signal }), this.#lifetime.signal);
                    const target = (Array.isArray(localTargets) ? localTargets : localTargets?.items ?? []).find(target => target.id === connectorId);
                    if (!target || ['host', 'port', 'callingAeTitle', 'calledAeTitle'].some(key => target.dimse?.[key] !== entry.profile.dimse[key])) throw new Error();
                    entry.connectorId = connectorId; entry.profile.baseUrl = endpoint(target.baseUrl);
                    if (new URL(entry.profile.baseUrl).origin !== this.#origin) throw new Error();
                }
                checkAbort(this.#lifetime.signal); this.#registry.add(configuration(entry, this.#origin)); this.#entries.set(entry.profile.id, entry);
            } catch (error) { if (this.#lifetime.signal.aborted) throw canceled(); this.warnings.push('A saved storage source was invalid or its local helper configuration was unavailable and was skipped.'); }
        }
        if (typeof value.defaultId === 'string' && this.list().some(source => source.id === value.defaultId)) this.#defaultId = value.defaultId;
        return this.list();
    }
    async save(input, { signal } = {}) {
        this.#check(); if (this.#busy) throw failure('BUSY', 'Finish the current source change before starting another.');
        this.#busy = true; const lifetime = this.#signal(signal); let created = null, committed = false;
        try {
            checkAbort(lifetime);
            if (!data(input, inputKeys)) throw failure('INVALID_PROFILE', 'Use supported storage source settings as plain data properties.');
            const existing = input?.id && this.list().find(source => source.id === input.id);
            if (existing?.managed) throw failure('MANAGED_SOURCE', 'This source is managed by the application and cannot be edited here.');
            const previous = input?.id ? this.#entries.get(input.id) : null, entry = normalize(input, previous);
            entry.profile.id ||= `source-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${this.#entries.size}`}`;
            if (entry.profile.remember && !this.#storage) throw failure('STORAGE_UNAVAILABLE', 'Remembered profiles are not available in this viewer. Use a session-only source.');
            if (!previous && this.list().length >= MAX_PROFILES) throw failure('SOURCE_LIMIT', 'Configure at most 32 storage sources.');
            if (previous) await this.#guard(entry.profile.id, lifetime);
            if (entry.profile.connection === 'dimse-local') {
                if (!this.#connector) throw failure('CONNECTOR_REQUIRED', 'Start the local DIMSE connector, or use an existing DIMSE HTTP gateway.');
                // Create first; an interrupted edit must never retarget the old helper record.
                const pending = this.#connector.save({ ...publicProfile(entry.profile), remember: entry.profile.remember }, { signal: lifetime });
                void Promise.resolve(pending).then(target => { if (lifetime.aborted) void this.#cleanup(target.id); }, () => {});
                created = await abortable(pending, lifetime); entry.connectorId = created.id; entry.profile.baseUrl = endpoint(created.baseUrl);
                if (created.dimse) entry.profile.dimse = { ...created.dimse };
                if (new URL(entry.profile.baseUrl).origin !== this.#origin) throw failure('INVALID_CONNECTOR', 'The local DIMSE connector returned an invalid service address.');
            } else entry.connectorId = null;
            const config = configuration(entry, this.#origin); new (config.type === 'dimse' ? DimseGatewayClient : DicomWebClient)({ baseUrl: config.baseUrl, headers: config.headers, credentials: config.credentials });
            if (previous) await this.#guard(entry.profile.id, lifetime); checkAbort(lifetime);
            const entries = new Map(this.#entries); entries.set(entry.profile.id, entry);
            const defaultId = input.isDefault ? entry.profile.id : this.#defaultId === entry.profile.id ? null : this.#defaultId;
            const storedBefore = this.#stored;
            try { this.#persist(entries, defaultId); previous ? this.#registry.replace(config) : this.#registry.add(config); }
            catch (error) { this.#restoreStored(storedBefore); throw error; }
            this.#invalidate(entry.profile.id); this.#entries = entries; this.#defaultId = defaultId; committed = true;
            if (previous) previous.secret = {};
            if (previous?.connectorId) await this.#cleanup(previous.connectorId);
            return this.list().find(source => source.id === entry.profile.id);
        } catch (error) {
            if (lifetime.aborted || error?.name === 'AbortError') throw canceled();
            if (error?.[publicError]) throw error;
            throw failure('SAVE_FAILED', 'The source could not be saved. Check the connection settings and local helper.');
        } finally { if (created && !committed) await this.#cleanup(created.id); this.#busy = false; }
    }
    async remove(id, { signal } = {}) {
        this.#check(); if (this.#busy) throw failure('BUSY', 'Finish the current source change before starting another.');
        const source = this.getProfile(id); if (source.managed) throw failure('MANAGED_SOURCE', 'This source is managed by the application and cannot be removed here.');
        this.#busy = true;
        try {
            const lifetime = this.#signal(signal); await this.#guard(id, lifetime);
            const entry = this.#entries.get(id), entries = new Map(this.#entries); entries.delete(id);
            const defaultId = this.#defaultId === id ? null : this.#defaultId;
            const storedBefore = this.#stored;
            try { this.#persist(entries, defaultId); this.#registry.remove(id); } catch (error) { this.#restoreStored(storedBefore); throw error; } this.#invalidate(id); this.#entries = entries; this.#defaultId = defaultId; entry.secret = {};
            if (entry.connectorId) await this.#cleanup(entry.connectorId);
            return true;
        } finally { this.#busy = false; }
    }
    async setDefault(id) {
        this.#check(); this.getProfile(id); if (this.#busy) throw failure('BUSY', 'Finish the current source change before choosing a default.');
        this.#persist(this.#entries, id); this.#defaultId = id; return this.list().find(source => source.id === id);
    }
    async test(input, { signal } = {}) {
        this.#check(); let entry, client, sourceId = null, temporary = null;
        if (typeof input === 'string') {
            this.getProfile(input); sourceId = input; entry = this.#entries.get(input); client = this.#registry.getClient(input);
        } else {
            if (!data(input, inputKeys)) throw failure('INVALID_PROFILE', 'Use supported storage source settings as plain data properties.');
            entry = normalize(input, input?.id ? this.#entries.get(input.id) : null); sourceId = input.id ?? null; }
        if (this.#tests.size >= MAX_TESTS) return { ok: false, summary: 'Two connection tests are already running. Wait or cancel one.', checks: [{ name: 'Metadata query', status: 'not-tested' }] };
        const controller = new AbortController(), timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), this.#timeout), lifetime = AbortSignal.any([this.#signal(signal), controller.signal, timeout.signal]);
        this.#tests.set(controller, sourceId); const started = Date.now(), checks = [];
        try {
            checkAbort(lifetime);
            if (entry && secretRequired(entry)) throw failure('CREDENTIAL_REQUIRED', 'Re-enter this source credential before testing the connection.');
            if (!client && entry.profile.connection === 'dimse-local') {
                if (!this.#connector) throw failure('CONNECTOR_REQUIRED', 'Start the local DIMSE connector or use an existing HTTP gateway.');
                const pending = this.#connector.save({ ...publicProfile(entry.profile), remember: false }, { signal: lifetime });
                void Promise.resolve(pending).then(target => { if (lifetime.aborted) void this.#cleanup(target.id); }, () => {});
                temporary = await abortable(pending, lifetime); entry.connectorId = temporary.id; entry.profile.baseUrl = endpoint(temporary.baseUrl);
                if (new URL(entry.profile.baseUrl).origin !== this.#origin) throw failure('INVALID_CONNECTOR', 'The local DIMSE connector returned an invalid service address.');
            }
            if (entry?.profile.connection === 'dimse-local') {
                await abortable(this.#connector.testEcho(entry.connectorId, { signal: lifetime }), lifetime);
                checks.push({ name: 'DIMSE C-ECHO', status: 'passed', detail: 'The configured peer responded.' });
            }
            if (!client) { const config = configuration(entry, this.#origin); client = new (config.type === 'dimse' ? DimseGatewayClient : DicomWebClient)({ baseUrl: config.baseUrl, headers: config.headers, credentials: config.credentials }); }
            await client.searchStudies({}, { limit: 1, offset: 0, signal: lifetime }); checkAbort(lifetime);
            checks.push({ name: 'Metadata query', status: 'passed', detail: 'A bounded study metadata query succeeded; patient details were discarded.' });
            checks.push({ name: 'Image retrieval', status: 'not-tested', detail: 'Open a study to verify image retrieval, decoding and display.' });
            return { ok: true, summary: 'Metadata query succeeded. Image retrieval and viewing were not tested.', checks, durationMs: Date.now() - started };
        } catch (error) {
            if (signal?.aborted || controller.signal.aborted || this.#lifetime.signal.aborted || error?.name === 'AbortError' && !timeout.signal.aborted) throw canceled();
            const summary = timeout.signal.aborted ? 'The connection test timed out. Check the service and try again.'
                : error?.status === 401 ? 'The service requires sign-in or a valid credential.' : error?.status === 403 ? 'The service denied access. Check the account and archive permissions.'
                : error?.[publicError] ? error.publicMessage : Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? `The service returned HTTP ${error.status}.`
                    : /invalid DICOM JSON|application\/dicom\+json metadata/.test(error?.message ?? '') ? 'The service returned unsupported or malformed DICOM metadata.'
                        : 'The metadata query could not complete. Check the endpoint, service, HTTPS and browser CORS settings.';
            checks.push({ name: checks.length ? 'Metadata query' : 'Connection', status: 'failed', detail: summary });
            checks.push({ name: 'Image retrieval', status: 'not-tested' });
            return { ok: false, summary, checks, durationMs: Date.now() - started };
        } finally { clearTimeout(timer); this.#tests.delete(controller); if (temporary) await this.#cleanup(temporary.id, Math.min(this.#cleanupTimeout, Math.max(0, this.#timeout - (Date.now() - started)))); }
    }
    dispose() {
        if (this.#disposed) return; this.#disposed = true; this.#lifetime.abort();
        for (const controller of this.#tests.keys()) controller.abort(); this.#tests.clear();
        for (const [id, entry] of this.#entries) {
            entry.secret = {};
            try { this.#registry.remove(id); } catch {}
            if (entry.connectorId && !entry.profile.remember) void this.#cleanup(entry.connectorId);
        }
        this.#entries.clear(); this.#defaultId = null;
    }
}

export default StorageSourceManager;
