/** Viewer-wide actions in a native modal drawer. New actions can be added to
 * the item list without coupling session operations to navigation markup. */
export class PrimaryMenu {
    #root; #document; #callbacks; #toggleButton; #dialog; #dismiss; #message; #items;
    #lifetime = new AbortController(); #opened = false; #disposed = false; #busy = false; #returnFocus = null;

    constructor(root, callbacks = {}) {
        if (!root?.ownerDocument?.createElement || typeof root.append !== 'function') throw new TypeError('Mount the primary menu in a DOM element.');
        this.#root = root; this.#document = root.ownerDocument; this.#callbacks = callbacks; this.#toggleButton = callbacks.toggleButton;
        this.#items = [
            { id: 'open', label: 'Open…', hint: 'Images, studies and test images', callback: 'onOpen' },
            { id: 'close', label: 'Close viewing session', hint: 'Clear the open patients and images', callback: 'onCloseSession' },
            { id: 'ai-assist', label: 'AI Assist (Preview)', hint: 'Explain metadata and draft measurement summaries', callback: 'onAiAssist', optional: true },
            { id: 'shortcuts', label: 'Keyboard shortcuts', callback: 'onShortcuts', optional: true }
        ];
        this.#mount(); this.refresh();
    }
    #node(tag, className, value) {
        const node = this.#document.createElement(tag); if (className) node.className = className; if (value != null) node.textContent = value; return node;
    }
    #mount() {
        this.#dialog = this.#node('dialog', 'primary-menu'); this.#dialog.id = 'primary-menu'; this.#dialog.setAttribute('aria-labelledby', 'primary-menu-title');
        const heading = this.#node('header', 'primary-menu-header'), title = this.#node('h2', 'primary-menu-title', 'Viewer menu'); title.id = 'primary-menu-title';
        this.#dismiss = this.#node('button', 'primary-menu-dismiss', '×'); this.#dismiss.type = 'button'; this.#dismiss.id = 'primary-menu-dismiss'; this.#dismiss.setAttribute('aria-label', 'Close menu'); heading.append(title, this.#dismiss);
        const nav = this.#node('nav', 'primary-menu-navigation'); nav.setAttribute('aria-label', 'Viewer actions');
        for (const item of this.#items) {
            const button = this.#node('button', `primary-menu-action${item.optional ? ' primary-menu-secondary' : ''}`); button.type = 'button'; button.id = `primary-menu-${item.id}`; button.dataset.primaryAction = item.id;
            button.append(this.#node('span', 'primary-menu-action-label', item.label)); if (item.hint) button.append(this.#node('span', 'primary-menu-action-hint', item.hint)); item.button = button; nav.append(button);
        }
        this.#message = this.#node('p', 'primary-menu-message'); this.#message.setAttribute('role', 'status'); this.#message.setAttribute('aria-live', 'polite'); this.#message.hidden = true;
        this.#dialog.append(heading, nav, this.#message); this.#root.append(this.#dialog);
        const signal = this.#lifetime.signal;
        this.#toggleButton?.setAttribute('aria-haspopup', 'dialog'); this.#toggleButton?.setAttribute('aria-controls', this.#dialog.id); this.#toggleButton?.setAttribute('aria-expanded', 'false');
        this.#toggleButton?.addEventListener('click', () => this.toggle(), { signal });
        this.#dismiss.addEventListener('click', () => this.close(), { signal });
        this.#dialog.addEventListener('click', event => {
            let node = event.target;
            while (node && node !== this.#dialog) {
                if (node.dataset?.primaryAction) { if (!node.disabled) this.#activate(node.dataset.primaryAction); return; }
                node = node.parentNode;
            }
            if (event.target !== this.#dialog || typeof this.#dialog.getBoundingClientRect !== 'function') return;
            const bounds = this.#dialog.getBoundingClientRect();
            if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) this.close();
        }, { signal });
        this.#dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); }, { signal });
        // Native close events are queued. An older event must not dismiss a
        // drawer that was opened again before that event reached this handler.
        this.#dialog.addEventListener('close', () => { if (this.#opened && !this.#dialog.open) this.close(); }, { signal });
    }
    #activate(id) {
        if (this.#disposed || this.#busy) return;
        this.refresh(); const item = this.#items.find(entry => entry.id === id); if (!item || item.button.disabled || item.button.hidden) return;
        this.#busy = true; this.close(); this.refresh();
        const finished = () => { if (!this.#disposed) { this.#busy = false; this.refresh(); } };
        const failed = error => {
            if (this.#disposed || error?.name === 'AbortError') return;
            this.#message.textContent = String(error?.message || 'The requested action could not finish.'); this.#message.hidden = false;
            try { this.#callbacks.onError?.(error); } catch { /* Keep the drawer usable if a host error callback fails. */ }
        };
        try {
            const operation = this.#callbacks[item.callback]();
            if (operation?.then) Promise.resolve(operation).catch(failed).finally(finished); else finished();
        } catch (error) { failed(error); finished(); }
    }
    open() {
        if (this.#disposed || this.#opened) return;
        this.#returnFocus = this.#root.getRootNode?.()?.activeElement ?? this.#document.activeElement ?? this.#toggleButton;
        this.#opened = true; this.refresh();
        if (!this.#dialog.open) { if (typeof this.#dialog.showModal === 'function') this.#dialog.showModal(); else { this.#dialog.open = true; this.#dialog.setAttribute('open', ''); } }
        this.#toggleButton?.setAttribute('aria-expanded', 'true');
        (this.#items.find(item => !item.button.hidden && !item.button.disabled)?.button ?? this.#dismiss).focus();
    }
    close() {
        if (this.#disposed || !this.#opened) return;
        this.#opened = false; this.#toggleButton?.setAttribute('aria-expanded', 'false');
        if (this.#dialog.open && typeof this.#dialog.close === 'function') this.#dialog.close(); else { this.#dialog.open = false; this.#dialog.removeAttribute('open'); }
        const focus = this.#returnFocus; this.#returnFocus = null; if (focus?.isConnected !== false) focus?.focus?.();
    }
    toggle() { if (this.#opened) this.close(); else this.open(); }
    isOpen() { return this.#opened && !this.#disposed; }
    refresh() {
        if (this.#disposed) return;
        for (const item of this.#items) {
            item.button.hidden = Boolean(item.optional && typeof this.#callbacks[item.callback] !== 'function');
            const canClose = item.id !== 'close' || typeof this.#callbacks.canClose !== 'function' || Boolean(this.#callbacks.canClose());
            item.button.disabled = this.#busy || !canClose || typeof this.#callbacks[item.callback] !== 'function';
        }
    }
    dispose() {
        if (this.#disposed) return;
        this.close(); this.#disposed = true; this.#lifetime.abort(); this.#dialog.remove(); this.#callbacks = {}; this.#returnFocus = null;
        this.#toggleButton?.removeAttribute('aria-haspopup'); this.#toggleButton?.removeAttribute('aria-controls'); this.#toggleButton?.removeAttribute('aria-expanded');
    }
}
