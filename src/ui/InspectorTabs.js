/** Viewer-scoped tabs with roving keyboard focus and independent scroll positions. */
export class InspectorTabs {
    constructor(root, { onSelect = () => {} } = {}) {
        this.root = root;
        this.onSelect = onSelect;
        this.lifetime = new AbortController();
        this.buttons = [...root.querySelectorAll('[data-inspector-tab]')];
        this.panels = [...root.querySelectorAll('[data-inspector-panel]')];
        this.scroll = root.querySelector('.inspector-scroll');
        this.positions = new Map();
        this.selected = this.buttons.find(button => button.getAttribute('aria-selected') === 'true')?.dataset.inspectorTab;
        for (const button of this.buttons) {
            button.addEventListener('click', () => this.select(button.dataset.inspectorTab), { signal: this.lifetime.signal });
            button.addEventListener('keydown', event => {
                const index = this.buttons.indexOf(button);
                const next = event.key === 'ArrowRight' ? (index + 1) % this.buttons.length
                    : event.key === 'ArrowLeft' ? (index + this.buttons.length - 1) % this.buttons.length
                    : event.key === 'Home' ? 0 : event.key === 'End' ? this.buttons.length - 1 : null;
                if (next === null || event.altKey || event.ctrlKey || event.metaKey) return;
                event.preventDefault(); event.stopPropagation();
                this.select(this.buttons[next].dataset.inspectorTab, { focus: true });
            }, { signal: this.lifetime.signal });
        }
    }

    select(name, { focus = false } = {}) {
        if (this.lifetime.signal.aborted) return;
        const target = this.buttons.find(button => button.dataset.inspectorTab === name);
        if (!target) throw new TypeError('Choose an available inspector tab.');
        if (name !== this.selected) {
            this.positions.set(this.selected, this.scroll.scrollTop);
            this.selected = name;
            for (const button of this.buttons) {
                const active = button === target;
                button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
            }
            for (const panel of this.panels) panel.hidden = panel.dataset.inspectorPanel !== name;
            this.scroll.scrollTop = this.positions.get(name) ?? 0;
            this.onSelect(name);
        }
        if (focus) target.focus({ preventScroll: true });
    }

    dispose() {
        this.lifetime.abort(); this.positions.clear(); this.buttons = []; this.panels = [];
        this.root = null; this.scroll = null; this.onSelect = null;
    }
}
