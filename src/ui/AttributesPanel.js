import { MAX_ATTRIBUTE_ROWS as MAX_ROWS, MAX_ATTRIBUTE_DEPTH as MAX_DEPTH, MAX_ATTRIBUTE_VALUE_CHARS as MAX_VALUE_CHARS,
    MAX_ATTRIBUTE_BYTES, MAX_SESSION_ATTRIBUTE_BYTES } from '../data/attributes.js';

const PAGE_SIZE = 50, MAX_QUERY_CHARS = 256;
const KINDS = new Set(['value', 'sequence', 'item', 'binary', 'bulk']);
const PREVIEW_CHARS = 128;

function validateSnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.rows) || snapshot.rows.length > MAX_ROWS || typeof snapshot.truncated !== 'boolean') throw new TypeError('Invalid retained attribute preview.');
    for (const row of snapshot.rows) {
        if (!row || !['meta', 'dataset'].includes(row.section) || !Number.isInteger(row.depth) || row.depth < 0 || row.depth > MAX_DEPTH ||
            !KINDS.has(row.kind) || typeof row.truncated !== 'boolean') throw new TypeError('Invalid retained attribute row.');
        for (const [key, maximum] of [['tag', 24], ['name', 512], ['vr', 16], ['path', MAX_VALUE_CHARS], ['value', MAX_VALUE_CHARS]]) {
            if (typeof row[key] !== 'string' || row[key].length > maximum) throw new TypeError('Invalid retained attribute text.');
        }
    }
    return snapshot;
}

function attributeTree(rows) {
    const nodes = [], ancestors = [];
    for (const row of rows) {
        // Item rows and the attributes they contain share metadata depth. The
        // retained preorder paths, not that depth, define their visible tree.
        while (ancestors.length && (ancestors.at(-1).row.section !== row.section || !row.path.startsWith(`${ancestors.at(-1).row.path}/`))) ancestors.pop();
        const parent = ancestors.at(-1) ?? null;
        const node = { row, index: nodes.length, parent, level: parent ? parent.level + 1 : 0, hasChildren: false };
        if (parent) parent.hasChildren = true;
        nodes.push(node);
        if (row.kind === 'sequence' || row.kind === 'item') ancestors.push(node);
    }
    return nodes;
}

/** Inspect already-retained metadata. This component never fetches or decodes. */
export class AttributesPanel {
    #root; #document; #lifetime = new AbortController(); #disposed = false;
    #source = null; #index = null; #snapshot = null; #nodes = []; #matches = []; #shown = []; #expanded = new Set(); #toggles = new Map(); #page = 0; #query = '';
    #search; #clearSearch; #count; #warning; #empty; #table; #body; #pagination; #previous; #next; #pageStatus;
    #expandAll; #collapseAll; #hint;
    #failed = false; #shortened = false;

    constructor(root) {
        if (!root?.ownerDocument?.createElement || typeof root.replaceChildren !== 'function') throw new TypeError('Mount the attribute panel in a DOM element.');
        this.#root = root; this.#document = root.ownerDocument; this.#mount(); this.#render();
    }
    #node(tag, className, text) {
        const node = this.#document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }
    #mount() {
        const panel = this.#node('div', 'attributes-panel');
        const tools = this.#node('div', 'attributes-search-row');
        const label = this.#node('label', 'attributes-search-label', 'Search attributes'); label.htmlFor = 'attributes-search';
        this.#search = this.#node('input', 'attributes-search'); this.#search.id = 'attributes-search'; this.#search.type = 'search';
        this.#search.placeholder = 'Tag, name, value, or sequence path'; this.#search.maxLength = MAX_QUERY_CHARS; this.#search.autocomplete = 'off';
        this.#search.setAttribute('spellcheck', 'false'); this.#search.setAttribute('autocapitalize', 'off');
        this.#search.setAttribute('aria-controls', 'attributes-table'); this.#search.setAttribute('aria-describedby', 'attributes-count');
        this.#clearSearch = this.#node('button', 'attributes-clear-search', 'Clear'); this.#clearSearch.type = 'button';
        this.#clearSearch.setAttribute('aria-label', 'Clear attribute search');
        tools.append(label, this.#search, this.#clearSearch);
        const treeTools = this.#node('div', 'attributes-tree-tools');
        this.#expandAll = this.#node('button', 'attributes-expand-all', 'Expand all'); this.#expandAll.type = 'button';
        this.#collapseAll = this.#node('button', 'attributes-collapse-all', 'Collapse all'); this.#collapseAll.type = 'button';
        this.#expandAll.setAttribute('aria-controls', 'attributes-table'); this.#collapseAll.setAttribute('aria-controls', 'attributes-table');
        treeTools.append(this.#expandAll, this.#collapseAll);
        this.#hint = this.#node('p', 'attributes-hint'); this.#hint.id = 'attributes-hint';
        this.#search.setAttribute('aria-describedby', 'attributes-count attributes-hint');
        this.#count = this.#node('p', 'attributes-count'); this.#count.id = 'attributes-count';
        this.#count.setAttribute('role', 'status'); this.#count.setAttribute('aria-live', 'polite'); this.#count.setAttribute('aria-atomic', 'true');
        this.#warning = this.#node('p', 'attributes-warning'); this.#warning.setAttribute('role', 'note');
        this.#empty = this.#node('p', 'attributes-empty');
        const scroll = this.#node('div', 'attributes-table-scroll');
        this.#table = this.#node('table', 'attributes-table'); this.#table.id = 'attributes-table';
        this.#table.append(this.#node('caption', 'attributes-caption', 'DICOM attributes'));
        const head = this.#node('thead'), headings = this.#node('tr');
        for (const text of ['Tag', 'Name', 'VR', 'Value']) { const cell = this.#node('th', null, text); cell.scope = 'col'; headings.append(cell); }
        head.append(headings); this.#body = this.#node('tbody'); this.#table.append(head, this.#body); scroll.append(this.#table);
        this.#pagination = this.#node('nav', 'attributes-pagination'); this.#pagination.setAttribute('aria-label', 'Attribute result pages');
        this.#previous = this.#node('button', 'attributes-previous', 'Previous'); this.#previous.id = 'attributes-prev'; this.#previous.type = 'button';
        this.#previous.setAttribute('aria-label', 'Previous attribute page');
        this.#next = this.#node('button', 'attributes-next', 'Next'); this.#next.id = 'attributes-next'; this.#next.type = 'button';
        this.#next.setAttribute('aria-label', 'Next attribute page');
        this.#pageStatus = this.#node('span', 'attributes-page-status'); this.#pageStatus.id = 'attributes-page';
        this.#pagination.append(this.#previous, this.#pageStatus, this.#next);
        panel.append(tools, treeTools, this.#hint, this.#count, this.#warning, this.#empty, scroll, this.#pagination); this.#root.replaceChildren(panel);
        const options = { signal: this.#lifetime.signal };
        this.#search.addEventListener('input', () => {
            this.#query = this.#search.value.slice(0, MAX_QUERY_CHARS).trim().toLowerCase(); this.#search.value = this.#search.value.slice(0, MAX_QUERY_CHARS);
            this.#page = 0; this.#filter(); this.#render();
        }, options);
        this.#clearSearch.addEventListener('click', () => {
            this.#query = ''; this.#search.value = ''; this.#page = 0; this.#filter(); this.#render(); this.#search.focus();
        }, options);
        this.#previous.addEventListener('click', () => { if (this.#page > 0) { --this.#page; this.#render(); } }, options);
        this.#next.addEventListener('click', () => { if ((this.#page + 1) * PAGE_SIZE < this.#shown.length) { ++this.#page; this.#render(); } }, options);
        this.#expandAll.addEventListener('click', () => {
            if (!this.#snapshot || this.#query) return;
            this.#expanded = new Set(this.#nodes.filter(node => node.hasChildren).map(node => node.index)); this.#filter(); this.#render();
        }, options);
        this.#collapseAll.addEventListener('click', () => {
            if (!this.#snapshot || this.#query) return;
            this.#expanded.clear(); this.#page = 0; this.#filter(); this.#render();
        }, options);
        this.#body.addEventListener('click', event => {
            let target = event.target;
            while (target && target !== this.#body) {
                if (target.dataset?.attributeBranch != null) { this.#toggle(Number(target.dataset.attributeBranch)); return; }
                target = target.parentNode;
            }
        }, options);
    }
    #filter() {
        const terms = this.#query.split(/\s+/u).filter(Boolean);
        const compactQuery = /^[0-9a-f(),\s]+$/iu.test(this.#query) ? this.#query.replace(/[^0-9a-f]/giu, '') : '';
        this.#matches = this.#nodes.filter(({ row }) => {
            if (!terms.length) return true;
            const compactTag = row.tag.replace(/[^0-9a-f]/giu, '').toLowerCase();
            if (compactQuery.length === 8 && compactQuery === compactTag) return true;
            const text = `${row.tag} ${compactTag} ${row.name} ${row.vr} ${row.path} ${row.value}`.toLowerCase();
            return terms.every(term => text.includes(term));
        });
        const revealed = new Set();
        this.#shown = this.#query ? this.#matches : this.#matches.filter(node => {
            if (node.parent && (!revealed.has(node.parent.index) || !this.#expanded.has(node.parent.index))) return false;
            revealed.add(node.index); return true;
        });
        this.#page = Math.min(this.#page, Math.max(0, Math.ceil(this.#shown.length / PAGE_SIZE) - 1));
    }
    #toggle(index) {
        if (this.#disposed || this.#query || !Number.isSafeInteger(index) || !this.#nodes[index]?.hasChildren) return;
        if (this.#expanded.has(index)) this.#expanded.delete(index); else this.#expanded.add(index);
        this.#filter(); this.#render(); this.#toggles.get(index)?.focus();
    }
    #value(row, cell) {
        // Binary/bulk summaries never offer an expansion action or a URL link.
        if (row.kind === 'binary' || row.kind === 'bulk' || row.value.length <= PREVIEW_CHARS) {
            cell.append(this.#node('span', row.kind === 'binary' || row.kind === 'bulk' ? 'attributes-binary-summary' : 'attributes-value-text', row.value));
        } else {
            cell.append(this.#node('span', 'attributes-value-preview', `${row.value.slice(0, PREVIEW_CHARS)}…`));
            const details = this.#node('details', 'attributes-expanded-value');
            details.append(this.#node('summary', null, 'Expand value'), this.#node('pre', 'attributes-full-value', row.value)); cell.append(details);
        }
        if (row.truncated) cell.append(this.#node('span', 'attributes-truncated', 'Shortened'));
    }
    #render() {
        if (this.#disposed) return;
        const total = this.#snapshot?.rows.length ?? 0, count = this.#shown.length, pages = Math.ceil(count / PAGE_SIZE);
        const first = this.#page * PAGE_SIZE, visible = this.#shown.slice(first, first + PAGE_SIZE);
        this.#search.disabled = !this.#snapshot; this.#clearSearch.disabled = !this.#search.value;
        this.#count.textContent = this.#snapshot ? this.#query ? `${count.toLocaleString()} matches of ${total.toLocaleString()}` : `${count.toLocaleString()} shown of ${total.toLocaleString()} attributes` : 'No attributes loaded';
        this.#expandAll.disabled = Boolean(this.#query) || !this.#nodes.some(node => node.hasChildren && !this.#expanded.has(node.index));
        this.#collapseAll.disabled = Boolean(this.#query) || !this.#expanded.size;
        this.#hint.textContent = this.#query ? 'Search includes matching attributes inside collapsed sequences. Clear search to browse the hierarchy.' : 'Use + and − to reveal sequence items and their attributes. L0, L1, and higher labels show nesting levels.';
        this.#table.hidden = !count; this.#pagination.hidden = !count;
        this.#empty.hidden = count > 0;
        const byteLimit = Array.isArray(this.#snapshot?.reasons) && this.#snapshot.reasons.includes('byte-limit');
        this.#empty.textContent = this.#failed ? 'Attributes are unavailable for this image.' : !this.#snapshot ? 'Open a DICOM image to inspect its attributes.' : total ? 'No attributes match this search.' : byteLimit ? 'Attribute retention budget reached; no preview is available for this image.' : 'No retained attributes are available for this image.';
        this.#warning.hidden = !this.#shortened;
        const limits = this.#snapshot?.limits ?? {};
        const bound = (name, fallback) => Number.isSafeInteger(limits[name]) && limits[name] > 0 ? Math.min(limits[name], fallback) : fallback;
        const bytes = Number.isSafeInteger(limits.maxBytes) && limits.maxBytes >= 0 ? Math.min(limits.maxBytes, MAX_ATTRIBUTE_BYTES) : MAX_ATTRIBUTE_BYTES;
        const byteLabel = bytes >= 1024 ? `${(bytes / 1024).toLocaleString()} KiB` : `${bytes} bytes`;
        this.#warning.textContent = this.#shortened ? `${byteLimit ? 'Attribute retention budget reached. ' : ''}This preview is limited to ${bound('maxRows', MAX_ROWS).toLocaleString()} rows, ${bound('maxDepth', MAX_DEPTH)} sequence levels, ${bound('maxValueChars', MAX_VALUE_CHARS).toLocaleString()} characters per value, and ${byteLabel} of retained metadata per image. Loaded-source previews share a ${(MAX_SESSION_ATTRIBUTE_BYTES / (1024 * 1024)).toLocaleString()} MiB budget. Displayed values or nested items may be shortened.` : '';
        this.#previous.disabled = this.#page === 0; this.#next.disabled = this.#page + 1 >= pages;
        this.#pageStatus.textContent = count ? `${first + 1}–${first + visible.length} of ${count.toLocaleString()} · Page ${this.#page + 1} of ${pages}` : '';
        this.#body.replaceChildren(); this.#toggles.clear();
        for (const node of visible) {
            const { row, index, level } = node;
            const element = this.#node('tr', `attributes-row attributes-kind-${row.kind}`);
            element.dataset.depth = String(row.depth); element.dataset.level = String(level); element.dataset.tone = String(level % 10); element.dataset.section = row.section; element.dataset.kind = row.kind;
            const tag = this.#node('th', 'attributes-tag', row.tag); tag.scope = 'row';
            const name = this.#node('td', 'attributes-name'), line = this.#node('div', 'attributes-name-line');
            if (node.hasChildren) {
                const expanded = this.#expanded.has(index), toggle = this.#node('button', 'attributes-toggle', expanded ? '−' : '+');
                toggle.type = 'button'; toggle.dataset.attributeBranch = String(index); toggle.disabled = Boolean(this.#query);
                toggle.setAttribute('aria-expanded', String(expanded)); toggle.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} ${row.name} ${row.tag}, level ${level}`);
                toggle.setAttribute('title', `${expanded ? 'Collapse' : 'Expand'} child attributes`); line.append(toggle); this.#toggles.set(index, toggle);
            } else {
                const placeholder = this.#node('span', 'attributes-toggle-placeholder'); placeholder.setAttribute('aria-hidden', 'true'); line.append(placeholder);
            }
            const levelLabel = this.#node('span', 'attributes-level', `L${level}`); levelLabel.setAttribute('title', `Nesting level ${level}`); levelLabel.setAttribute('aria-label', `Nesting level ${level}`);
            line.append(this.#node('span', 'attributes-name-text', row.name), levelLabel); name.append(line);
            const path = this.#node('span', 'attributes-path', row.path); path.title = row.path; name.append(path);
            const value = this.#node('td', 'attributes-value'); this.#value(row, value);
            element.append(tag, name, this.#node('td', 'attributes-vr', row.vr), value); this.#body.append(element);
        }
    }
    #reset() {
        this.#source = null; this.#index = null; this.#snapshot = null; this.#nodes = []; this.#matches = []; this.#shown = []; this.#expanded.clear(); this.#toggles.clear(); this.#page = 0; this.#query = ''; this.#failed = false; this.#shortened = false;
        this.#search.value = ''; this.#body.replaceChildren(); this.#render();
    }
    setSource({ series, index } = {}) {
        if (this.#disposed) throw new Error('The attribute panel is disposed.');
        if (series == null) { this.clear(); return this.getState(); }
        const changedSource = this.#source !== series, changedIndex = this.#index !== index;
        if (changedSource) this.#reset();
        try {
            if (typeof series.getAttributes !== 'function' || !Number.isSafeInteger(index) || index < 0 || index >= 10000) throw new TypeError('Select a retained image frame.');
            const retained = series.getAttributes(index);
            if (!changedSource && retained === this.#snapshot) { this.#index = index; return this.getState(); }
            const snapshot = validateSnapshot(retained);
            this.#source = series; this.#index = index; this.#snapshot = snapshot; this.#failed = false;
            this.#nodes = attributeTree(snapshot.rows); this.#expanded.clear();
            this.#shortened = snapshot.truncated || snapshot.rows.some(row => row.truncated);
            if (changedIndex) this.#page = 0;
            this.#filter(); this.#render();
        } catch {
            // A disposed source must not leave protected values in the DOM or
            // report an error containing source identifiers or patient text.
            this.#reset(); this.#failed = true; this.#render();
        }
        return this.getState();
    }
    clear() { if (!this.#disposed) this.#reset(); }
    getState() {
        return { disposed: this.#disposed, ready: Boolean(this.#snapshot), error: this.#failed,
            rowCount: this.#snapshot?.rows.length ?? 0, matchedCount: this.#matches.length,
            visibleCount: Math.min(PAGE_SIZE, Math.max(0, this.#shown.length - this.#page * PAGE_SIZE)),
            page: this.#page, pageCount: Math.ceil(this.#shown.length / PAGE_SIZE),
            truncated: this.#shortened };
    }
    dispose() {
        if (this.#disposed) return;
        this.#reset(); this.#disposed = true; this.#lifetime.abort(); this.#root.replaceChildren(); this.#root = null; this.#document = null;
    }
}
