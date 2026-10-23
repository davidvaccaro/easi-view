const statusText = { matched: 'Matched', missing: 'No eligible stack', ambiguous: 'Choose between matching stacks', blocked: 'Waiting for another selection' };
function reason(code) {
    if (code.startsWith('rule-match:')) return `Matches ${code.slice(11)}`;
    if (code.startsWith('rule-mismatch:')) return `Different ${code.slice(14)}`;
    if (code.startsWith('rule-missing:')) return `Missing ${code.slice(13)}`;
    return code.replaceAll('-', ' ').replaceAll(':', ': ');
}

/** Explicit reading-layout selection. All metadata values are rendered as text. */
export class ReadingProtocolPanel {
    constructor(root, { getProtocols, getCatalog, preview, apply, cancel, reset }) {
        Object.assign(this, { root, getProtocols, getCatalog, preview, apply, cancel, reset });
        this.document = root.ownerDocument; this.lifetime = new AbortController(); this.rowsLifetime = new AbortController();
        this.busy = false; this.disposed = false; this.overrides = {}; this.catalog = null; this.plan = null;
        this._mount();
    }
    el(tag, className, text, id) {
        const node = this.document.createElement(tag); if (className) node.className = className;
        if (text != null) node.textContent = text; if (id) node.id = id; return node;
    }
    _mount() {
        this.dialog = this.el('dialog', 'reading-protocol-dialog', null, 'reading-protocol-dialog');
        this.dialog.setAttribute('aria-labelledby', 'reading-protocol-title');
        const heading = this.el('div', 'dialog-heading');
        heading.append(this.el('h2', null, 'Arrange your reading workspace', 'reading-protocol-title'));
        this.closeButton = this.el('button', 'reading-protocol-close', 'Close', 'reading-protocol-close'); this.closeButton.type = 'button'; heading.append(this.closeButton);
        this.dialog.append(heading, this.el('p', 'reading-protocol-intro', 'Choose a reading layout, review its matches, then apply. Previews use loaded metadata; images load only for the selected panes.'));
        const fields = this.el('div', 'reading-protocol-fields');
        const selectField = (label, id) => { const field = this.el('label'); field.append(this.el('span', null, label)); const select = this.el('select', null, null, id); field.append(select); fields.append(field); return select; };
        this.select = selectField('Reading layout', 'reading-protocol-select');
        this.current = selectField('Current loaded study', 'reading-protocol-current');
        this.prior = selectField('Comparison study (optional)', 'reading-protocol-prior');
        this.dialog.append(fields, this.el('p', 'reading-protocol-note', 'Study choices do not establish patient identity or registration. Select comparison images deliberately.'));
        this.previewRoot = this.el('div', 'reading-protocol-preview', null, 'reading-protocol-preview'); this.dialog.append(this.previewRoot);
        this.message = this.el('p', 'reading-protocol-message', null, 'reading-protocol-message'); this.message.setAttribute('role', 'status'); this.dialog.append(this.message);
        const actions = this.el('div', 'reading-protocol-actions');
        this.resetButton = this.el('button', 'button reading-protocol-reset', 'Return to single view', 'reading-protocol-reset'); this.resetButton.type = 'button';
        this.cancelButton = this.el('button', 'button reading-protocol-cancel', 'Cancel application', 'reading-protocol-cancel'); this.cancelButton.type = 'button'; this.cancelButton.hidden = true;
        this.applyButton = this.el('button', 'button import-button', 'Apply layout', 'reading-protocol-apply'); this.applyButton.type = 'button';
        actions.append(this.resetButton, this.cancelButton, this.applyButton); this.dialog.append(actions); this.root.append(this.dialog);
        const listen = (node, type, callback) => node.addEventListener(type, callback, { signal: this.lifetime.signal });
        listen(this.select, 'change', () => { this.overrides = {}; this._preview(); });
        listen(this.current, 'change', () => { if (this.prior.value === this.current.value) this.prior.value = ''; this.overrides = {}; this._preview(); });
        listen(this.prior, 'change', () => { this.overrides = {}; this._preview(); });
        listen(this.applyButton, 'click', () => this._run(() => this.apply(this.select.value, this.options()), true));
        listen(this.resetButton, 'click', () => this._run(() => this.reset(), false));
        listen(this.cancelButton, 'click', () => { void this.cancel(); });
        listen(this.closeButton, 'click', () => { void this.close(); });
        listen(this.dialog, 'cancel', event => { event.preventDefault(); event.stopPropagation(); void this.close(); });
        listen(this.dialog, 'close', () => this.launcher?.focus({ preventScroll: true }));
    }
    options() {
        const current = this.catalog?.groups.find(group => group.id === this.current.value);
        const prior = this.catalog?.groups.find(group => group.id === this.prior.value);
        return { currentSeries: current?.indices ?? [], priorSeries: prior?.indices ?? [], overrides: { ...this.overrides } };
    }
    refresh() {
        if (this.disposed || this.busy) return;
        const previousProtocol = this.select.value, previousCurrent = this.current.value, previousPrior = this.prior.value;
        let catalog;
        try { catalog = this.getCatalog(); }
        catch { this.clear(); this.applyButton.disabled = true; this.resetButton.disabled = true; this.previewRoot.append(this.el('p', 'reading-protocol-empty', 'Reading layouts are unavailable for this source. Open a supported, bounded set of image stacks.')); return; }
        const changed = this.catalog?.revision !== catalog.revision;
        this.catalog = catalog;
        const option = (value, text) => { const node = this.el('option', null, text); node.value = value; return node; };
        this.select.replaceChildren(...this.getProtocols().map(protocol => option(protocol.id, protocol.name)));
        if ([...this.select.options].some(value => value.value === previousProtocol)) this.select.value = previousProtocol;
        this.current.replaceChildren(option('', 'Choose a loaded study'), ...catalog.groups.map(group => option(group.id, group.label)));
        this.prior.replaceChildren(option('', 'No comparison study'), ...catalog.groups.map(group => option(group.id, group.label)));
        this.current.value = !changed && catalog.groups.some(group => group.id === previousCurrent) ? previousCurrent : catalog.activeGroup ?? '';
        this.prior.value = !changed && catalog.groups.some(group => group.id === previousPrior) ? previousPrior : '';
        if (changed) { this.overrides = {}; this.message.textContent = ''; }
        this._preview();
    }
    _preview() {
        if (this.disposed || this.busy) return;
        this.rowsLifetime.abort(); this.rowsLifetime = new AbortController(); this.previewRoot.replaceChildren();
        for (const option of this.prior.options) option.disabled = option.value !== '' && option.value === this.current.value;
        try {
            if (!this.select.value) { this.plan = null; this.previewRoot.append(this.el('p', 'reading-protocol-empty', 'Configure a reading layout through your application.')); this.applyButton.disabled = true; return; }
            this.plan = this.preview(this.select.value, this.options());
            const heading = this.el('div', 'reading-protocol-summary');
            heading.append(this.el('strong', null, `${this.plan.layout} ${this.plan.layout === 1 ? 'pane' : 'panes'}`), this.el('span', this.plan.status === 'ready' ? 'reading-protocol-ready' : 'reading-protocol-unresolved', this.plan.status === 'ready' ? 'Ready to apply' : 'Resolve selections below'));
            this.previewRoot.append(heading);
            for (const selector of this.plan.selectors) {
                const card = this.el('section', 'reading-protocol-match'); card.dataset.selector = selector.id;
                card.append(this.el('strong', null, selector.id.replaceAll('-', ' ')), this.el('span', 'reading-protocol-match-status', statusText[selector.status] ?? selector.status));
                const field = this.el('label'); field.append(this.el('span', null, 'Image stack'));
                const select = this.el('select'); select.dataset.protocolSelector = selector.id; select.setAttribute('aria-label', `${selector.id} image stack`);
                const auto = this.el('option', null, 'Automatic matching'); auto.value = ''; select.append(auto);
                for (const candidate of selector.candidates.filter(value => value.eligible)) {
                    const meta = this.catalog.series.find(value => value.index === candidate.index);
                    const option = this.el('option', null, meta?.label ?? `Stack ${candidate.index + 1}`); option.value = String(candidate.index); select.append(option);
                }
                select.value = this.overrides[selector.id] == null ? '' : String(this.overrides[selector.id]);
                select.addEventListener('change', () => { if (select.value === '') delete this.overrides[selector.id]; else this.overrides[selector.id] = Number(select.value); this._preview(); }, { signal: this.rowsLifetime.signal });
                field.append(select); card.append(field);
                if (selector.matchedIndex != null) {
                    const meta = this.catalog.series.find(value => value.index === selector.matchedIndex);
                    card.append(this.el('p', 'reading-protocol-selected', meta?.label ?? `Stack ${selector.matchedIndex + 1}`));
                }
                const codes = selector.candidates.find(value => value.index === selector.matchedIndex)?.reasonCodes ?? selector.reasonCodes;
                card.append(this.el('p', 'reading-protocol-reasons', codes.map(reason).join(' · '))); this.previewRoot.append(card);
            }
            const slots = this.el('ol', 'reading-protocol-slot-list');
            for (const slot of this.plan.slots) {
                const line = this.el('li'); line.append(this.el('strong', null, `Pane ${slot.id + 1}`), this.el('span', null,
                    slot.status === 'ready' ? `Stack ${slot.candidateIndex + 1} · Frame ${slot.frameIndex + 1}${slot.window ? ` · W ${slot.window.width} / L ${slot.window.center}${slot.windowUnit ? ` ${slot.windowUnit}` : ''}` : ' · Source window'}` : slot.status.replaceAll('-', ' '))); slots.append(line);
            }
            this.previewRoot.append(slots);
            const links = Object.entries(this.plan.links).filter(([, value]) => value).map(([key]) => ({ scroll: 'Slices', window: 'Window/level', camera: 'Physical view' })[key]);
            this.previewRoot.append(this.el('p', 'reading-protocol-note', links.length ? `Requested links: ${links.join(', ')}. Links apply only where image geometry and acquisition metadata are compatible.` : 'Panes navigate independently.'));
            this.applyButton.disabled = this.plan.status !== 'ready'; this.resetButton.disabled = !this.catalog.series.length;
        } catch {
            this.plan = null; this.applyButton.disabled = true;
            this.previewRoot.append(this.el('p', 'reading-protocol-empty', 'The selected layout cannot use these loaded images. Review the study choices or choose another layout.'));
        }
    }
    async _run(action, closeOnSuccess) {
        if (this.busy || this.disposed) return;
        this.busy = true; this._busy(); this.message.textContent = 'Preparing the selected images…';
        try { await action(); if (!this.disposed) { this.message.textContent = 'Reading layout applied. You can adjust panes and tools as usual.'; if (closeOnSuccess) this.dialog.close(); } }
        catch (error) { if (!this.disposed) this.message.textContent = error?.name === 'AbortError' ? 'Application canceled. Images from the current source remain available.' : 'The layout could not be applied. Review the selected images and try again.'; }
        finally { this.busy = false; if (!this.disposed) { this._busy(); this.refresh(); } }
    }
    _busy() {
        for (const node of [this.select, this.current, this.prior, this.resetButton, this.applyButton, ...this.previewRoot.querySelectorAll('select')]) node.disabled = this.busy;
        this.cancelButton.hidden = !this.busy; this.dialog.setAttribute('aria-busy', String(this.busy));
    }
    open(launcher) { if (this.disposed) return; this.launcher = launcher; this.refresh(); if (!this.dialog.open) this.dialog.showModal(); }
    async close() { if (this.disposed) return; if (this.busy) await this.cancel(); if (!this.disposed) this.dialog.close(); }
    isOpen() { return !this.disposed && this.dialog.open; }
    clear() { this.rowsLifetime.abort(); this.catalog = null; this.plan = null; this.overrides = {}; this.previewRoot.replaceChildren(); this.current.replaceChildren(); this.prior.replaceChildren(); this.message.textContent = ''; }
    dispose() { if (this.disposed) return; this.clear(); this.disposed = true; this.lifetime.abort(); this.dialog.remove(); this.root = null; this.document = null; this.launcher = null; }
}
