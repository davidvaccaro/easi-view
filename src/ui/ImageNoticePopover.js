let nextId = 0;
const string = value => value == null ? '' : String(value);
const CLOSE_DELAY = 180;

/** Current-image compatibility notes, kept out of the image and inspector layout.
 * Opening a note never acknowledges it; acknowledgement remains owned by the
 * session so that the same source can be used by independently embedded viewers. */
export class ImageNoticePopover {
    #mount; #document; #callbacks; #button; #badge; #popover; #context; #summary; #body; #acknowledge; #dismiss;
    #lifetime = new AbortController(); #timer; #opened = false; #pinned = false; #disposed = false; #hovered = false; #suppressFocus = false;
    #contextKey; #contentKey; #count = 0; #unread = 0;

    constructor(mount, callbacks = {}) {
        if (!mount?.ownerDocument?.createElement || typeof mount.append !== 'function') throw new TypeError('Mount image notices in a DOM element.');
        this.#mount = mount; this.#document = mount.ownerDocument; this.#callbacks = callbacks; this.#build();
        this.update();
    }
    #node(tag, className, text) {
        const node = this.#document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node;
    }
    #build() {
        const id = `easi-image-notices-${++nextId}`;
        this.#button = this.#node('button', 'icon-button image-notice-button'); this.#button.type = 'button';
        this.#button.setAttribute('aria-haspopup', 'dialog'); this.#button.setAttribute('aria-controls', id); this.#button.setAttribute('aria-expanded', 'false');
        const symbol = this.#node('span', 'image-notice-symbol', 'i'); symbol.setAttribute('aria-hidden', 'true');
        this.#badge = this.#node('span', 'image-notice-badge'); this.#badge.setAttribute('aria-hidden', 'true'); this.#button.append(symbol, this.#badge);
        this.#popover = this.#node('section', 'image-notice-popover'); this.#popover.id = id; this.#popover.hidden = true;
        this.#popover.setAttribute('popover', 'manual'); this.#popover.setAttribute('role', 'dialog'); this.#popover.setAttribute('aria-labelledby', `${id}-title`); this.#popover.setAttribute('aria-describedby', `${id}-context`);
        const header = this.#node('header', 'image-notice-header'), headings = this.#node('div');
        const title = this.#node('h2', 'image-notice-title', 'Image notices'); title.id = `${id}-title`;
        this.#context = this.#node('p', 'image-notice-context'); this.#context.id = `${id}-context`; headings.append(title, this.#context);
        this.#dismiss = this.#node('button', 'image-notice-close', '×'); this.#dismiss.type = 'button'; this.#dismiss.setAttribute('aria-label', 'Close image notices'); header.append(headings, this.#dismiss);
        this.#body = this.#node('div', 'image-notice-body'); this.#body.tabIndex = 0; this.#body.setAttribute('role', 'region'); this.#body.setAttribute('aria-label', 'Image notice details');
        const footer = this.#node('footer', 'image-notice-footer'); this.#summary = this.#node('span', 'image-notice-summary');
        this.#acknowledge = this.#node('button', 'image-notice-acknowledge', 'Mark as read'); this.#acknowledge.type = 'button'; footer.append(this.#summary, this.#acknowledge);
        this.#popover.append(header, this.#body, footer); this.#mount.append(this.#button, this.#popover);
        const signal = this.#lifetime.signal;
        this.#button.addEventListener('pointerenter', event => { if (event.pointerType === 'touch') return; this.#hovered = true; this.#cancelClose(); this.open(); }, {signal});
        this.#button.addEventListener('pointerleave', () => { this.#hovered = false; this.#scheduleClose(); }, {signal});
        this.#popover.addEventListener('pointerenter', event => { if (event.pointerType === 'touch') return; this.#hovered = true; this.#cancelClose(); }, {signal});
        this.#popover.addEventListener('pointerleave', () => { this.#hovered = false; this.#scheduleClose(); }, {signal});
        this.#button.addEventListener('focus', () => { if (!this.#suppressFocus) this.open(); }, {signal});
        this.#mount.addEventListener('focusin', () => this.#cancelClose(), {signal});
        this.#mount.addEventListener('focusout', () => this.#scheduleClose(true), {signal});
        this.#button.addEventListener('click', () => {
            if (this.#opened && this.#pinned) this.close({restoreFocus: true}); else this.open({pinned: true, focus: true});
        }, {signal});
        this.#dismiss.addEventListener('click', () => this.close({restoreFocus: true}), {signal});
        this.#acknowledge.addEventListener('click', () => {
            if (!this.#unread || this.#disposed) return;
            const focused = (this.#mount.getRootNode?.()?.activeElement ?? this.#document.activeElement) === this.#acknowledge;
            this.#callbacks.onAcknowledge?.({contextKey: this.#contextKey});
            if (focused && this.#opened && this.#acknowledge.hidden) this.#dismiss.focus({preventScroll: true});
        }, {signal});
        this.#document.addEventListener?.('pointerdown', event => { if (this.#opened && !this.#ownsEvent(event)) this.close(); }, {signal, capture: true});
        this.#document.addEventListener?.('keydown', event => {
            if (event.key !== 'Escape' || !this.#opened || (!this.#ownsEvent(event) && !this.#hasFocus() && !this.#hovered)) return;
            event.preventDefault(); event.stopPropagation(); this.close({restoreFocus: this.#hasFocus()});
        }, {signal, capture: true});
        this.#popover.addEventListener('toggle', event => { if (event.newState === 'closed' && this.#opened && this.#popover.matches?.(':popover-open') === false) this.close(); }, {signal});
        const view = this.#document.defaultView;
        view?.addEventListener?.('resize', () => this.#position(), {signal});
        view?.addEventListener?.('scroll', () => this.#position(), {signal, capture: true});
        view?.visualViewport?.addEventListener?.('resize', () => this.#position(), {signal});
        view?.visualViewport?.addEventListener?.('scroll', () => this.#position(), {signal});
    }
    #contains(node) {
        for (let current = node; current; current = current.parentNode) if (current === this.#mount) return true;
        return false;
    }
    #ownsEvent(event) { return event.composedPath?.().includes(this.#mount) || this.#contains(event.target); }
    #hasFocus() { return this.#contains(this.#mount.getRootNode?.()?.activeElement ?? this.#document.activeElement); }
    #cancelClose() { if (this.#timer != null) { clearTimeout(this.#timer); this.#timer = null; } }
    #scheduleClose(fromFocus = false) {
        this.#cancelClose(); this.#timer = setTimeout(() => {
            this.#timer = null;
            if (!this.#hasFocus() && (fromFocus || !this.#pinned && !this.#hovered)) this.close();
        }, CLOSE_DELAY);
    }
    #position() {
        if (!this.#opened || !this.#button.getBoundingClientRect) return;
        const view = this.#document.defaultView, viewport = view?.visualViewport;
        const viewportLeft = viewport?.offsetLeft ?? 0, viewportTop = viewport?.offsetTop ?? 0;
        const viewportRight = viewportLeft + (viewport?.width ?? view?.innerWidth ?? this.#document.documentElement?.clientWidth ?? 1024);
        const viewportBottom = viewportTop + (viewport?.height ?? view?.innerHeight ?? this.#document.documentElement?.clientHeight ?? 768);
        const shell = this.#mount.closest?.('.viewer-shell')?.getBoundingClientRect?.();
        const left = Math.max(viewportLeft, shell?.left ?? viewportLeft) + 8, right = Math.min(viewportRight, shell?.right ?? viewportRight) - 8;
        const top = Math.max(viewportTop, shell?.top ?? viewportTop) + 8, bottom = Math.min(viewportBottom, shell?.bottom ?? viewportBottom) - 8;
        const width = Math.max(0, Math.min(420, right - left)), button = this.#button.getBoundingClientRect();
        this.#popover.style.width = `${width}px`;
        this.#popover.style.maxHeight = `${Math.max(0, Math.min(520, bottom - top))}px`;
        const height = this.#popover.getBoundingClientRect?.().height ?? 300;
        const below = button.bottom + 8, above = button.top - 8 - height;
        const y = below + height <= bottom ? below : above >= top ? above : Math.max(top, Math.min(below, bottom - height));
        this.#popover.style.left = `${Math.max(left, Math.min(button.right - width, right - width))}px`;
        this.#popover.style.top = `${Math.max(top, y)}px`;
    }
    update({contextKey, contextLabel = '', groups = [], unreadCount = 0} = {}) {
        if (this.#disposed) return;
        if (contextKey !== this.#contextKey) { this.close({restoreFocus: this.#hasFocus()}); this.#contextKey = contextKey; }
        const seen = new Set(), sections = [], content = [];
        for (const group of Array.isArray(groups) ? groups : []) {
            const messages = [];
            for (const message of Array.isArray(group?.messages) ? group.messages : []) {
                if (typeof message !== 'string' || !message.trim() || seen.has(message.trim())) continue;
                seen.add(message.trim()); messages.push(message.trim());
            }
            if (!messages.length) continue;
            content.push([string(group.id), string(group.label), messages]);
            const section = this.#node('section', 'image-notice-group'); section.dataset.noticeGroup = string(group.id);
            section.append(this.#node('h3', 'image-notice-group-title', string(group.label) || 'Image information'));
            const list = this.#node('ul', 'image-notice-list');
            for (const message of messages) list.append(this.#node('li', 'image-notice-message', message));
            section.append(list); sections.push(section);
        }
        this.#count = seen.size; this.#unread = Number.isFinite(unreadCount) ? Math.max(0, Math.min(this.#count, Math.trunc(unreadCount))) : 0;
        const contentKey = JSON.stringify(content);
        if (contentKey !== this.#contentKey) { this.#body.replaceChildren(...sections); this.#contentKey = contentKey; }
        this.#context.textContent = string(contextLabel) || 'Current image';
        this.#button.disabled = !this.#count; this.#button.dataset.unread = this.#unread ? 'true' : 'false';
        this.#button.dataset.noticeCount = string(this.#count); this.#button.dataset.unreadCount = string(this.#unread);
        this.#button.setAttribute('aria-label', this.#count ? `Image notices: ${this.#count} ${this.#count === 1 ? 'notice' : 'notices'}${this.#unread ? `, ${this.#unread} unread` : ', all read'}. Open image notices.` : 'No image notices');
        this.#badge.textContent = this.#unread > 99 ? '99+' : string(this.#unread); this.#badge.hidden = !this.#unread;
        this.#summary.textContent = `${this.#count} ${this.#count === 1 ? 'notice' : 'notices'} · ${this.#unread ? `${this.#unread} unread` : 'All read'}`;
        this.#acknowledge.hidden = !this.#unread; this.#acknowledge.disabled = typeof this.#callbacks.onAcknowledge !== 'function';
        if (!this.#count) this.close({restoreFocus: false}); else this.#position();
    }
    open({pinned = false, focus = false} = {}) {
        if (this.#disposed || !this.#count) return;
        this.#cancelClose(); this.#pinned ||= pinned;
        if (!this.#opened) {
            this.#opened = true; this.#popover.hidden = false; this.#button.setAttribute('aria-expanded', 'true');
            try { this.#popover.showPopover?.(); } catch { /* Fixed-position fallback for hosts without usable popovers. */ }
            this.#callbacks.onShow?.({contextKey: this.#contextKey});
        }
        this.#popover.dataset.pinned = this.#pinned ? 'true' : 'false'; this.#position();
        if (focus) this.#dismiss.focus({preventScroll: true});
    }
    close({restoreFocus = false} = {}) {
        this.#cancelClose(); if (!this.#opened) return;
        this.#opened = false; this.#pinned = false; this.#hovered = false;
        try { this.#popover.hidePopover?.(); } catch { /* Already hidden, detached, or using the fallback. */ }
        this.#popover.hidden = true; this.#button.setAttribute('aria-expanded', 'false');
        if (restoreFocus && !this.#button.disabled && this.#button.isConnected !== false) {
            this.#suppressFocus = true; this.#button.focus({preventScroll: true}); this.#suppressFocus = false;
        }
    }
    isOpen() { return this.#opened && !this.#disposed; }
    dispose() {
        if (this.#disposed) return;
        this.close(); this.#disposed = true; this.#lifetime.abort(); this.#button.remove(); this.#popover.remove(); this.#callbacks = {};
    }
}

export default ImageNoticePopover;
