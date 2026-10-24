/** Named archive configuration. Credentials live only in the current draft or
 * the injected manager; this component never writes browser storage or HTML. */
let nextDialog = 0;
const list = value => Array.isArray(value) ? value : [];
const protocolLabel = connection => ({ dicomweb: 'DICOMweb', 'dimse-gateway': 'DIMSE gateway', 'dimse-local': 'DIMSE · local helper' }[connection] || 'Archive');
const emptyDraft = () => ({ name: '', connection: 'dicomweb', baseUrl: '', authentication: 'none', token: '', username: '', password: '', remember: false, isDefault: false,
    dimse: { host: '127.0.0.1', port: 4248, callingAeTitle: 'EASI_VIEW', calledAeTitle: 'EASISTORE' } });
const abortError = () => Object.assign(new Error('Canceled.'), { name: 'AbortError' });

export class StorageSourcesDialog {
    #root; #document; #options; #manager; #dialog; #title; #list; #editor; #feedback; #footer; #add; #dismiss;
    #prefix = `storage-sources-${++nextDialog}`; #lifetime = new AbortController(); #operation = null; #generation = 0;
    #opened = false; #disposed = false; #returnFocus = null; #selection = null; #draft = null; #managed = false; #busy = false;
    #result = null; #message = ''; #removeConfirm = false; #helperAvailable = false; #fields = new Map();

    constructor(root, { manager, onChange, onClose, canEdit = true, getConnectorAvailable } = {}) {
        if (!root?.ownerDocument?.createElement || typeof root.append !== 'function') throw new TypeError('Mount storage sources in a DOM element.');
        if (!manager || typeof manager.list !== 'function' || typeof manager.getProfile !== 'function') throw new TypeError('Provide a storage source manager.');
        this.#root = root; this.#document = root.ownerDocument; this.#manager = manager;
        this.#options = { onChange, onClose, canEdit, getConnectorAvailable }; this.#mount();
    }
    #node(tag, className, text) {
        const node = this.#document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node;
    }
    #button(action, label, className = '') {
        const node = this.#node('button', `storage-sources-button ${className}`.trim(), label); node.type = 'button'; node.dataset.storageAction = action; return node;
    }
    #editable() {
        try { return typeof this.#options.canEdit === 'function' ? Boolean(this.#options.canEdit()) : this.#options.canEdit !== false; }
        catch { return false; }
    }
    #entries() { return list(this.#manager.list()); }
    #selectedEntry() { return this.#entries().find(entry => entry.id === this.#selection); }
    #mount() {
        this.#dialog = this.#node('dialog', 'storage-sources-dialog'); this.#dialog.id = this.#prefix; this.#dialog.setAttribute('aria-labelledby', `${this.#prefix}-title`); this.#dialog.setAttribute('aria-modal', 'true');
        const header = this.#node('header', 'storage-sources-header'), heading = this.#node('div');
        heading.append(this.#node('p', 'storage-sources-eyebrow', 'VIEWER SETTINGS'));
        this.#title = this.#node('h2', '', 'Storage sources'); this.#title.id = `${this.#prefix}-title`; this.#title.tabIndex = -1;
        heading.append(this.#title, this.#node('p', 'storage-sources-intro', 'Name your archives once. Choose them when opening a study.'));
        this.#dismiss = this.#button('close', '×', 'storage-sources-dismiss'); this.#dismiss.setAttribute('aria-label', 'Close storage sources'); header.append(heading, this.#dismiss);
        const layout = this.#node('div', 'storage-sources-layout'), sidebar = this.#node('aside', 'storage-sources-sidebar'); sidebar.setAttribute('aria-label', 'Configured storage sources');
        const toolbar = this.#node('div', 'storage-sources-toolbar'); toolbar.append(this.#node('h3', '', 'Your archives'));
        this.#add = this.#button('add', '+ Add source', 'storage-sources-add'); toolbar.append(this.#add);
        this.#list = this.#node('div', 'storage-sources-list'); sidebar.append(toolbar, this.#list);
        const main = this.#node('section', 'storage-sources-main'); this.#editor = this.#node('div', 'storage-sources-editor');
        this.#feedback = this.#node('div', 'storage-sources-feedback'); this.#feedback.tabIndex = -1; this.#feedback.setAttribute('aria-live', 'polite'); this.#feedback.setAttribute('aria-atomic', 'false');
        this.#footer = this.#node('footer', 'storage-sources-footer'); main.append(this.#editor, this.#feedback, this.#footer); layout.append(sidebar, main);
        this.#dialog.append(header, layout); this.#root.append(this.#dialog);
        const signal = this.#lifetime.signal;
        this.#dialog.addEventListener('click', event => {
            let node = event.target;
            while (node && node !== this.#dialog) {
                if (node.dataset?.storageAction) { if (!node.disabled) this.#action(node.dataset.storageAction, node.dataset.storageId); return; }
                node = node.parentNode;
            }
            if (event.target === this.#dialog && this.#dialog.getBoundingClientRect) {
                const box = this.#dialog.getBoundingClientRect();
                if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) this.close();
            }
        }, { signal });
        this.#dialog.addEventListener('input', event => this.#change(event.target), { signal });
        this.#dialog.addEventListener('change', event => this.#change(event.target), { signal });
        this.#dialog.addEventListener('submit', event => { event.preventDefault(); if (!this.#busy) this.#save(); }, { signal });
        this.#dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); }, { signal });
        this.#dialog.addEventListener('close', () => { if (this.#opened && !this.#dialog.open) this.close(); }, { signal });
        this.#dialog.addEventListener('keydown', event => this.#trapFocus(event), { signal });
    }
    #trapFocus(event) {
        if (!this.#opened || event.key !== 'Tab' || !this.#dialog.querySelectorAll) return;
        const controls = Array.from(this.#dialog.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')).filter(node => {
            if (node.disabled || node.tabIndex === -1) return false;
            for (let parent = node; parent && parent !== this.#dialog; parent = parent.parentNode) if (parent.hidden) return false;
            return true;
        });
        const first = controls[0], last = controls.at(-1), active = this.#root.getRootNode?.()?.activeElement ?? this.#document.activeElement;
        if (event.shiftKey && active === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && active === last) { event.preventDefault(); first?.focus(); }
    }
    #renderList() {
        this.#list.replaceChildren(); this.#add.hidden = !this.#editable(); this.#add.disabled = this.#busy;
        const entries = this.#entries();
        for (const entry of entries) {
            const button = this.#button('select', null, 'storage-sources-source'); button.dataset.storageId = entry.id; button.disabled = this.#busy;
            button.setAttribute('aria-pressed', String(entry.id === this.#selection));
            button.append(this.#node('strong', 'storage-sources-source-name', entry.name));
            const badges = this.#node('span', 'storage-sources-source-badges'); badges.append(this.#node('span', '', protocolLabel(entry.connection || (entry.type === 'dimse' ? 'dimse-gateway' : 'dicomweb'))));
            if (entry.isDefault || this.#manager.defaultId === entry.id) badges.append(this.#node('span', 'storage-sources-badge', 'Default'));
            if (entry.managed || entry.editable === false) badges.append(this.#node('span', 'storage-sources-badge storage-sources-managed', 'Managed'));
            button.append(badges); if (entry.requiresCredentials) button.append(this.#node('span', 'storage-sources-credentials-note', 'Credentials needed'));
            this.#list.append(button);
        }
        if (!entries.length) this.#list.append(this.#node('p', 'storage-sources-empty', 'No storage sources yet. Add a DICOMweb archive or a DIMSE connection.'));
        if (!this.#editable()) this.#list.append(this.#node('p', 'storage-sources-help', 'The host application manages storage sources for this viewer.'));
    }
    #field(form, key, label, { type = 'text', placeholder = '', hint = '', options, value, maxLength = 2048, required = false } = {}) {
        const wrap = this.#node('div', 'storage-sources-field'), id = `${this.#prefix}-${key.replaceAll('.', '-')}`, title = this.#node('label', '', label); title.setAttribute('for', id);
        const control = this.#node(options ? 'select' : 'input'); control.id = id; control.name = key; control.dataset.storageField = key;
        if (options) for (const [optionValue, text] of options) { const option = this.#node('option', '', text); option.value = optionValue; control.append(option); }
        else { control.type = type; control.placeholder = placeholder; control.maxLength = maxLength; control.autocomplete = 'off'; control.spellcheck = false; }
        control.value = value == null ? '' : String(value); control.disabled = this.#busy; control.required = required;
        wrap.append(title, control); if (hint) { const note = this.#node('p', 'storage-sources-help', hint); note.id = `${id}-help`; control.setAttribute('aria-describedby', note.id); wrap.append(note); }
        this.#fields.set(key, control); form.append(wrap); return control;
    }
    #check(form, key, label, hint) {
        const wrap = this.#node('div', 'storage-sources-check'), row = this.#node('label'), control = this.#node('input'); control.type = 'checkbox'; control.dataset.storageField = key; control.checked = Boolean(this.#draft[key]); control.disabled = this.#busy;
        row.append(control, this.#node('span', '', label)); wrap.append(row); if (hint) wrap.append(this.#node('p', 'storage-sources-help', hint)); form.append(wrap); this.#fields.set(key, control); return control;
    }
    #renderEditor() {
        // Detached inputs must not retain a previous credential value when the
        // editor is rebuilt for a test, authentication change or helper update.
        for (const key of ['token', 'username', 'password']) { const input = this.#fields.get(key); if (input) input.value = ''; }
        this.#editor.replaceChildren(); this.#fields.clear();
        if (!this.#draft) { this.#editor.append(this.#node('h3', '', 'Choose a storage source'), this.#node('p', 'storage-sources-help', 'Select an archive to view its connection settings or test access.')); return; }
        this.#editor.append(this.#node('h3', 'storage-sources-editor-title', this.#managed ? this.#draft.name : this.#selection ? 'Edit storage source' : 'New storage source'));
        if (this.#managed) {
            this.#editor.append(this.#node('p', 'storage-sources-lock', 'Managed by the host application'), this.#node('p', 'storage-sources-help', 'Connection details and credentials are controlled by the application. You can test this source without changing it.'),
                this.#node('p', 'storage-sources-protocol', protocolLabel(this.#draft.connection)));
            return;
        }
        const form = this.#node('form', 'storage-sources-form'); form.noValidate = false;
        this.#field(form, 'name', 'Source name', { value: this.#draft.name, placeholder: 'Research archive', maxLength: 100, required: true });
        const protocols = [['dicomweb', 'DICOMweb'], ['dimse-gateway', 'DIMSE through an HTTP gateway']];
        if (this.#helperAvailable || this.#draft.connection === 'dimse-local') protocols.push(['dimse-local', this.#helperAvailable ? 'DIMSE through this local helper' : 'DIMSE · local helper unavailable']);
        this.#field(form, 'connection', 'Connection type', { options: protocols, value: this.#draft.connection });
        if (this.#draft.connection === 'dimse-local') {
            const grid = this.#node('div', 'storage-sources-field-grid');
            this.#field(grid, 'dimse.host', 'PACS host', { value: this.#draft.dimse.host, placeholder: '127.0.0.1', required: true, maxLength: 253 });
            const port = this.#field(grid, 'dimse.port', 'PACS port', { type: 'number', value: this.#draft.dimse.port, required: true, maxLength: 5 }); port.min = '1'; port.max = '65535';
            this.#field(grid, 'dimse.callingAeTitle', 'Calling AE title · this viewer', { value: this.#draft.dimse.callingAeTitle, required: true, maxLength: 16 });
            this.#field(grid, 'dimse.calledAeTitle', 'Called AE title · archive', { value: this.#draft.dimse.calledAeTitle, required: true, maxLength: 16 }); form.append(grid);
            form.append(this.#node('p', 'storage-sources-help', 'The local helper connects over DIMSE using the configured AE titles and the archive’s IP trust rules. HTTP passwords are not sent to the PACS. DICOM TLS is not supported by this helper.'));
            if (!this.#helperAvailable) form.append(this.#node('p', 'storage-sources-warning', 'This viewer is not connected to its local DIMSE helper. Start the local viewer service or use an HTTP DIMSE gateway.'));
        } else {
            const gateway = this.#draft.connection === 'dimse-gateway';
            this.#field(form, 'baseUrl', gateway ? 'DIMSE gateway URL' : 'DICOMweb base URL', { type: 'url', value: this.#draft.baseUrl, placeholder: gateway ? 'https://viewer.example.org/dimse/' : 'https://pacs.example.org/dicomweb/', required: true,
                hint: gateway ? 'Browsers cannot open DIMSE TCP sockets. Use an EASI-compatible HTTP gateway, or the local helper when available.' : 'Use the archive’s DICOMweb endpoint. Cross-origin archives must permit this viewer through CORS.' });
            this.#field(form, 'authentication', 'Authentication', { options: [['none', 'None · research access'], ['session', 'Browser session'], ['bearer', 'Bearer token'], ['basic', 'Username and password']], value: this.#draft.authentication });
            if (this.#draft.authentication === 'session') form.append(this.#node('p', 'storage-sources-help', 'Uses the browser session for this archive. Sign in at the archive first. The archive must allow credentialed requests from this viewer.'));
            if (this.#draft.authentication === 'bearer') this.#field(form, 'token', 'Bearer token', { type: 'password', value: this.#draft.token, placeholder: this.#draft.hasCredentials ? 'Leave blank to keep this session’s credential' : 'Enter a token', maxLength: 4096,
                hint: 'Kept in memory for this viewer session. Remote credentials require HTTPS.' });
            if (this.#draft.authentication === 'basic') {
                this.#field(form, 'username', 'Username', { value: this.#draft.username, placeholder: this.#draft.hasCredentials ? 'Leave both blank to keep the current credential' : 'Username', maxLength: 256 });
                this.#field(form, 'password', 'Password', { type: 'password', value: this.#draft.password, placeholder: 'Password', maxLength: 4096,
                    hint: 'Credentials stay in memory. Leave both fields blank to retain credentials for an unchanged connection.' });
            }
        }
        if (this.#manager.canRemember !== false) this.#check(form, 'remember', 'Remember this source in this browser', 'Only connection settings are saved. Tokens, usernames and passwords are never saved; re-enter them after a reload.');
        this.#check(form, 'isDefault', 'Use as the default storage source', 'Show this archive first when choosing remote storage.');
        this.#editor.append(form);
        if (!this.#editable()) {
            for (const field of this.#fields.values()) field.disabled = true;
            this.#editor.append(this.#node('p', 'storage-sources-help', 'Editing storage sources is disabled by the host application.'));
        }
    }
    #renderFeedback() {
        this.#feedback.replaceChildren(); this.#feedback.hidden = !this.#busy && !this.#message && !this.#result;
        if (this.#busy) {
            const status = this.#node('p', 'storage-sources-progress'); status.setAttribute('role', 'status');
            const spinner = this.#node('span', 'storage-sources-spinner'); spinner.setAttribute('aria-hidden', 'true'); status.append(spinner, this.#node('span', '', this.#message)); this.#feedback.append(status);
        } else if (this.#message) { const status = this.#node('p', 'storage-sources-message', this.#message); status.setAttribute('role', 'status'); this.#feedback.append(status); }
        if (this.#result) {
            const summary = this.#node('p', `storage-sources-test-summary ${this.#result.ok ? 'is-success' : 'is-failure'}`, this.#result.summary || (this.#result.ok ? 'Connection test completed.' : 'The connection test could not complete.'));
            summary.setAttribute('role', 'status'); this.#feedback.append(summary);
            const checks = this.#node('ul', 'storage-sources-checks');
            for (const check of list(this.#result.checks)) {
                const line = this.#node('li'), state = ['passed', 'failed', 'not-tested', 'warning', 'skipped', 'success', 'error'].includes(check.status) ? check.status : 'info'; line.dataset.status = state;
                line.append(this.#node('strong', '', check.name));
                if (state === 'not-tested' || state === 'skipped') line.append(this.#node('span', 'storage-sources-check-state', 'Not tested'));
                if (check.detail) line.append(this.#node('span', '', check.detail)); checks.append(line);
            }
            this.#feedback.append(checks);
        }
    }
    #renderFooter() {
        this.#footer.replaceChildren();
        if (this.#busy) { this.#footer.append(this.#button('cancel-operation', 'Cancel', 'storage-sources-secondary')); return; }
        if (this.#removeConfirm) {
            const confirmation = this.#node('div', 'storage-sources-remove-confirm'); confirmation.setAttribute('role', 'alert'); confirmation.append(this.#node('p', '', 'Remove this storage source? Images stored in the archive will not be deleted.'));
            confirmation.append(this.#button('cancel-remove', 'Keep source'), this.#button('confirm-remove', 'Remove source', 'storage-sources-danger')); this.#footer.append(confirmation); return;
        }
        if (this.#draft) {
            this.#footer.append(this.#button('test', 'Test connection', 'storage-sources-secondary'));
            if (this.#managed) {
                if (this.#editable() && typeof this.#manager.setDefault === 'function' && !(this.#selectedEntry()?.isDefault || this.#manager.defaultId === this.#selection)) this.#footer.append(this.#button('default', 'Use as default'));
            } else if (this.#editable()) {
                if (this.#selection) this.#footer.append(this.#button('remove', 'Remove', 'storage-sources-remove'));
                this.#footer.append(this.#button('save', this.#selection ? 'Save changes' : 'Save source', 'storage-sources-primary'));
                this.#footer.append(this.#button('cancel-edit', 'Cancel'));
            }
        }
        if (!this.#draft || this.#managed || !this.#editable()) this.#footer.append(this.#button('close', 'Done'));
    }
    #render() { this.#dialog.setAttribute('aria-busy', String(this.#busy)); this.#renderList(); this.#renderEditor(); this.#renderFeedback(); this.#renderFooter(); }
    #clearSecrets() {
        if (this.#draft) for (const key of ['token', 'username', 'password']) this.#draft[key] = '';
        for (const key of ['token', 'username', 'password']) { const field = this.#fields.get(key); if (field) field.value = ''; }
    }
    #change(target) {
        const key = target?.dataset?.storageField; if (!key || this.#busy || this.#managed || !this.#draft || !this.#editable()) return;
        const value = ['remember', 'isDefault'].includes(key) ? Boolean(target.checked) : target.value;
        if (key.startsWith('dimse.')) this.#draft.dimse[key.slice(6)] = key === 'dimse.port' ? Number(value) : value;
        else this.#draft[key] = value;
        this.#result = null; this.#message = ''; this.#removeConfirm = false;
        if (key === 'connection') {
            this.#clearSecrets(); this.#draft.baseUrl = ''; this.#draft.authentication = 'none'; this.#draft.hasCredentials = false;
            this.#renderEditor(); this.#fields.get(key)?.focus();
        } else if (key === 'authentication') {
            this.#clearSecrets(); this.#draft.hasCredentials = false; this.#renderEditor(); this.#fields.get(key)?.focus();
        } else if (key === 'baseUrl') { this.#clearSecrets(); }
        else if (key === 'username') { this.#draft.password = ''; const password = this.#fields.get('password'); if (password) password.value = ''; }
        this.#renderFeedback(); this.#renderFooter();
    }
    #select(id) {
        if (this.#busy) return;
        this.#clearSecrets(); this.#selection = id || null; this.#result = null; this.#message = ''; this.#removeConfirm = false;
        if (!id) { this.#managed = false; this.#draft = this.#editable() ? emptyDraft() : null; }
        else {
            const entry = this.#selectedEntry(); if (!entry) { this.#draft = null; this.#managed = false; this.#render(); return; }
            let profile;
            try { profile = this.#manager.getProfile(id); } catch (error) {
                this.#draft = null; this.#message = error?.publicMessage || 'This storage source is no longer available. Choose another source.'; this.#render(); return;
            }
            this.#managed = Boolean(entry.managed || entry.editable === false || profile?.managed);
            this.#draft = { ...emptyDraft(), ...profile, name: profile?.name || entry.name, connection: profile?.connection || entry.connection || (entry.type === 'dimse' ? 'dimse-gateway' : 'dicomweb'),
                isDefault: Boolean(entry.isDefault || this.#manager.defaultId === id), dimse: { ...emptyDraft().dimse, ...profile?.dimse }, token: '', username: '', password: '' };
        }
        this.#render();
    }
    async #run(message, action, complete) {
        if (this.#busy || !this.#opened || this.#disposed) return;
        const controller = new AbortController(), generation = ++this.#generation; this.#operation = controller; this.#busy = true; this.#message = message; this.#result = null; this.#removeConfirm = false; this.#render();
        this.#footer.querySelector?.('button')?.focus();
        try {
            await Promise.resolve(); if (controller.signal.aborted) throw abortError();
            const value = await action(controller.signal);
            if (controller.signal.aborted || generation !== this.#generation || !this.#opened || this.#disposed) return;
            this.#operation = null; this.#busy = false; this.#message = ''; complete(value); this.#render(); (this.#feedback.hidden ? this.#title : this.#feedback).focus({ preventScroll: true });
        } catch (error) {
            if (controller.signal.aborted || generation !== this.#generation || !this.#opened || this.#disposed) return;
            this.#operation = null; this.#busy = false;
            this.#message = error?.name === 'AbortError' ? 'Operation canceled.' : (typeof error?.publicMessage === 'string' ? error.publicMessage : 'The operation could not finish. Check the connection settings and try again.');
            this.#render(); this.#feedback.focus({ preventScroll: true });
        }
    }
    #changed(type, sourceId) { try { this.#options.onChange?.({ type, sourceId }); } catch { /* Keep the configuration dialog usable if a host callback fails. */ } }
    #save() {
        if (!this.#draft || this.#managed || !this.#editable() || this.#busy) return;
        const profile = structuredClone(this.#draft); delete profile.hasCredentials;
        return this.#run('Saving storage source…', signal => this.#manager.save(profile, { signal }), descriptor => {
            this.#clearSecrets(); this.#select(descriptor.id); this.#message = 'Storage source saved. Choose it when opening a study.'; this.#changed('save', descriptor.id);
        });
    }
    #test() {
        if (!this.#draft || this.#busy) return;
        const profile = this.#managed ? this.#selection : structuredClone(this.#draft);
        if (typeof profile === 'object') delete profile.hasCredentials;
        return this.#run('Checking connection… No images will be downloaded.', signal => this.#manager.test(profile, { signal }), result => { this.#result = result; });
    }
    #action(action, id) {
        if (action === 'close') return this.close();
        if (action === 'cancel-operation') {
            this.#generation++; this.#operation?.abort(); this.#operation = null; this.#busy = false; this.#result = null; this.#message = 'Operation canceled.'; this.#render(); this.#feedback.focus({ preventScroll: true }); return;
        }
        if (this.#busy) return;
        if (action === 'add' && this.#editable()) { this.#select(null); this.#fields.get('name')?.focus(); }
        else if (action === 'select') this.#select(id);
        else if (action === 'save') this.#save();
        else if (action === 'test') this.#test();
        else if (action === 'cancel-edit') { if (this.#selection) this.#select(this.#selection); else this.#select(this.#entries()[0]?.id); }
        else if (action === 'remove' && !this.#managed && this.#editable()) { this.#removeConfirm = true; this.#renderFooter(); }
        else if (action === 'cancel-remove') { this.#removeConfirm = false; this.#renderFooter(); }
        else if (action === 'confirm-remove' && !this.#managed && this.#editable()) {
            const sourceId = this.#selection;
            this.#run('Removing storage source…', signal => this.#manager.remove(sourceId, { signal }), () => { this.#select(this.#entries()[0]?.id); this.#message = 'Storage source removed.'; this.#changed('remove', sourceId); });
        } else if (action === 'default' && this.#editable() && this.#selection && typeof this.#manager.setDefault === 'function') {
            const sourceId = this.#selection;
            this.#run('Updating default source…', () => this.#manager.setDefault(sourceId), () => { this.#select(sourceId); this.#message = 'Default storage source updated.'; this.#changed('default', sourceId); });
        }
    }
    open({ sourceId } = {}) {
        if (this.#disposed) return;
        if (!this.#opened) this.#returnFocus = this.#root.getRootNode?.()?.activeElement ?? this.#document.activeElement;
        this.#opened = true; this.#select(sourceId || this.#selection || this.#manager.defaultId || this.#entries()[0]?.id || null);
        if (!this.#dialog.open) { if (typeof this.#dialog.showModal === 'function') this.#dialog.showModal(); else { this.#dialog.open = true; this.#dialog.setAttribute('open', ''); } }
        this.#title.focus();
        const generation = this.#generation;
        if (typeof this.#options.getConnectorAvailable === 'function') Promise.resolve().then(() => this.#options.getConnectorAvailable()).then(value => {
            if (this.#disposed || !this.#opened || generation !== this.#generation) return;
            const available = value === true; if (available === this.#helperAvailable) return; this.#helperAvailable = available;
            if (!this.#busy) {
                const focused = this.#root.getRootNode?.()?.activeElement ?? this.#document.activeElement, key = focused?.dataset?.storageField;
                const selection = typeof focused?.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd] : null;
                this.#renderEditor(); const replacement = key ? this.#fields.get(key) : null; replacement?.focus();
                if (selection && replacement?.setSelectionRange) { try { replacement.setSelectionRange(...selection); } catch { /* Some numeric/select inputs do not expose a text caret. */ } }
            }
        }).catch(() => { /* A missing optional helper leaves gateway configuration available. */ });
    }
    close() {
        if (this.#disposed || !this.#opened) return;
        this.#opened = false; this.#generation++; this.#operation?.abort(); this.#operation = null; this.#busy = false; this.#clearSecrets(); this.#draft = null; this.#result = null; this.#message = ''; this.#removeConfirm = false;
        this.#editor.replaceChildren(); this.#feedback.replaceChildren(); this.#footer.replaceChildren(); this.#fields.clear();
        if (this.#dialog.open && typeof this.#dialog.close === 'function') this.#dialog.close(); else { this.#dialog.open = false; this.#dialog.removeAttribute('open'); }
        const focus = this.#returnFocus; this.#returnFocus = null; if (focus?.isConnected !== false) focus?.focus?.();
        try { this.#options.onClose?.(); } catch { /* Closing configuration must always release its modal. */ }
    }
    isOpen() { return this.#opened && !this.#disposed; }
    dispose() { if (this.#disposed) return; this.close(); this.#disposed = true; this.#lifetime.abort(); this.#dialog.remove(); this.#options = {}; this.#manager = null; }
}
