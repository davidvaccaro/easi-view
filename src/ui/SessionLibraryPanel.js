import { canReviewLocalPatients, possibleLocalPatientMatch } from './local-patient-match.js';

const PATIENT_PAGE = 20, STUDY_PAGE = 12, SERIES_PAGE = 24, STACK_PAGE = 24, INSTANCE_PAGE = 25, MATCH_PREVIEW = 3;
const text = (value, fallback = '') => value == null || value === '' ? fallback : String(value);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const plural = (value, one, many = `${one}s`) => `${value.toLocaleString()} ${value === 1 ? one : many}`;
const patientName = patient => text(patient.patientName, 'Unnamed patient').replaceAll('^', ' ').trim() || 'Unnamed patient';
const studiesOf = patient => Array.isArray(patient?.studies) ? patient.studies : [];
const seriesOf = study => Array.isArray(study?.series) ? study.series : [];
const blocked = item => ['unsupported', 'unavailable', 'error'].includes(item?.status);
function dateLabel(value, unknown = 'Date not supplied') {
    const date = text(value).replaceAll('-', '');
    if (!/^\d{8}$/u.test(date)) return unknown;
    const year = Number(date.slice(0, 4)), month = Number(date.slice(4, 6)), day = Number(date.slice(6));
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return unknown;
    return `${String(day).padStart(2, '0')} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month - 1]} ${year}`;
}
const availability = series => ({ loaded: 'Ready', loading: 'Loading…', indexed: 'Available locally', available: 'Available', unsupported: 'Not displayable', unavailable: 'Unavailable', error: 'Unable to open', 'uid-conflict': 'UID conflict · review notices' })[series.status] ?? 'Available';

/** Read-only navigator over admitted session metadata. Opening sources belongs
 * to the Open workflow; this panel never searches repositories or reads files. */
export class SessionLibraryPanel {
    #root; #document; #callbacks; #lifetime = new AbortController(); #disposed = false;
    #view = { patients: [] }; #state = {}; #finding = false; #query = ''; #patientPage = 0; #studyPage = 0; #activeId = null;
    #expanded = new Set(); #seenStudies = new Set(); #seriesPages = new Map(); #chosenSeries = new Map(); #error = '';
    #expandedInstances = new Set(); #instancePages = new Map(); #stackPages = new Map();
    #panel; #finder; #search; #patients; #patientPages; #patient; #timeline; #studyPages; #message;
    #association; #associationId = null; #associationConfirmed = false; #associationInput; #associationConfirm;
    #associationFromTimeline = false; #pendingAssociationId = null;

    constructor(root, callbacks = {}) {
        if (!root?.ownerDocument?.createElement || typeof root.replaceChildren !== 'function') throw new TypeError('Mount the session library in a DOM element.');
        this.#root = root; this.#document = root.ownerDocument; this.#callbacks = callbacks; this.#mount(); this.#render();
    }
    #node(tag, className, value) {
        const node = this.#document.createElement(tag); if (className) node.className = className; if (value != null) node.textContent = value; return node;
    }
    #button(label, action, data = {}, className = 'session-library-button') {
        const button = this.#node('button', className, label); button.type = 'button'; button.dataset.sessionAction = action; Object.assign(button.dataset, data); return button;
    }
    #mount() {
        this.#panel = this.#node('section', 'session-library'); this.#panel.setAttribute('aria-label', 'Viewing session library');
        this.#message = this.#node('p', 'session-library-message'); this.#message.setAttribute('role', 'status'); this.#message.setAttribute('aria-live', 'polite');
        this.#finder = this.#node('div', 'session-library-finder');
        const label = this.#node('label', 'session-library-search-label', 'Find a patient in this session');
        this.#search = this.#node('input', 'session-library-search'); this.#search.type = 'search'; this.#search.maxLength = 256; this.#search.autocomplete = 'off'; this.#search.placeholder = 'Name, patient ID or birth date'; this.#search.setAttribute('spellcheck', 'false'); this.#search.setAttribute('aria-label', 'Find a patient in the viewing session'); label.append(this.#search);
        this.#patients = this.#node('div', 'session-library-patients'); this.#patientPages = this.#node('nav', 'session-library-pagination'); this.#patientPages.setAttribute('aria-label', 'Session patient pages');
        this.#association = this.#node('div', 'session-library-association'); this.#association.setAttribute('role', 'region'); this.#association.setAttribute('aria-label', 'Review local patient association');
        this.#finder.append(label, this.#patients, this.#patientPages, this.#association);
        this.#patient = this.#node('div', 'session-library-patient'); this.#patient.setAttribute('aria-label', 'Active patient');
        this.#timeline = this.#node('div', 'session-library-timeline'); this.#timeline.setAttribute('aria-label', 'Studies in the viewing session');
        this.#studyPages = this.#node('nav', 'session-library-pagination'); this.#studyPages.setAttribute('aria-label', 'Session study pages');
        this.#panel.append(this.#message, this.#finder, this.#patient, this.#timeline, this.#studyPages); this.#root.replaceChildren(this.#panel);
        this.#search.addEventListener('input', () => { this.#query = this.#search.value.slice(0, 256).trim().toLowerCase(); this.#patientPage = 0; this.#renderPatients(); }, { signal: this.#lifetime.signal });
        this.#panel.addEventListener('change', event => {
            if (event.target === this.#associationInput && !this.#state.busy) {
                this.#associationConfirmed = Boolean(this.#associationInput.checked);
                if (this.#associationConfirm) this.#associationConfirm.disabled = !this.#associationConfirmed || Boolean(this.#state.busy);
            }
        }, { signal: this.#lifetime.signal });
        this.#panel.addEventListener('click', event => {
            const target = this.#eventTarget(event);
            if (target && !target.disabled) this.#action(target.dataset.sessionAction, target.dataset);
        }, { signal: this.#lifetime.signal });
        this.#panel.addEventListener('keydown', event => {
            if (!['Enter', ' ', 'Spacebar'].includes(event.key) || event.repeat) return;
            const target = this.#eventTarget(event);
            // Native buttons already generate their own keyboard click. The
            // series selection region is the only custom keyboard target.
            if (target?.dataset.sessionAction !== 'open-series' || event.target?.dataset?.sessionSeriesSelect !== 'true') return;
            event.preventDefault(); if (!target.disabled) this.#action('open-series', target.dataset);
        }, { signal: this.#lifetime.signal });
        this.#panel.addEventListener('dragstart', event => {
            const target = this.#eventTarget(event);
            if (!target || !['open-series', 'open-instance'].includes(target.dataset.sessionAction) || target.disabled || typeof this.#callbacks.onDragStart !== 'function') { event.preventDefault(); return; }
            const selection = { seriesId: target.dataset.seriesId, frameIndex: 0 };
            if (target.dataset.instanceId) selection.instanceId = target.dataset.instanceId;
            this.#callbacks.onDragStart(event, selection);
        }, { signal: this.#lifetime.signal });
        this.#panel.addEventListener('dragend', event => this.#callbacks.onDragEnd?.(event), { signal: this.#lifetime.signal });
    }
    #eventTarget(event) {
        let target = event.target;
        while (target && target !== this.#panel) {
            if (target.dataset?.sessionAction) return target;
            if (target.dataset?.sessionIgnore === 'true' || ['button', 'input', 'select', 'textarea', 'summary', 'a'].includes(String(target.tagName).toLowerCase())) return null;
            target = target.parentNode;
        }
        return null;
    }
    #invoke(name, ...args) {
        if (this.#disposed || typeof this.#callbacks[name] !== 'function') return;
        this.#error = ''; this.#renderMessage();
        const failed = error => { if (!this.#disposed && error?.name !== 'AbortError') { this.#error = text(error?.message, 'The requested session action could not finish.'); this.#renderMessage(); } };
        try { const operation = this.#callbacks[name](...args); if (operation?.catch) operation.catch(failed); } catch (error) { failed(error); }
    }
    #activePatient() { return this.#view.patients.find(patient => patient.id === this.#activeId) ?? null; }
    #matches() {
        const terms = this.#query.split(/\s+/u).filter(Boolean);
        return this.#view.patients.filter(patient => {
            const haystack = `${patientName(patient)} ${text(patient.patientId)} ${text(patient.issuerOfPatientId)} ${text(patient.patientBirthDate)} ${dateLabel(patient.patientBirthDate, '')} ${text(patient.sourceLabel)}`.toLowerCase();
            return terms.every(term => haystack.includes(term));
        });
    }
    #demographics(patient, parent) {
        parent.append(this.#node('span', 'session-library-patient-id', `ID ${text(patient.patientId, 'not supplied')}`), this.#node('span', 'session-library-patient-demographics', `Born ${dateLabel(patient.patientBirthDate, 'not supplied')}`));
        if (patient.issuerOfPatientId) parent.append(this.#node('span', 'session-library-patient-issuer', patient.issuerOfPatientId));
        if (patient.synthetic || patient.kind === 'test') parent.append(this.#node('span', 'session-library-test-label', 'Synthetic test workspace'));
        else parent.append(this.#node('span', 'session-library-patient-source', text(patient.sourceLabel, 'Session images')));
    }
    #paging(container, page, pages, previous, next, data = {}) {
        container.replaceChildren(); container.hidden = pages < 2; if (pages < 2) return;
        const before = this.#button('Previous', previous, data), after = this.#button('Next', next, data); before.disabled = page <= 0; after.disabled = page >= pages - 1;
        container.append(before, this.#node('span', null, `${page + 1} / ${pages}`), after);
    }
    #renderPatients() {
        const matches = this.#matches(), pages = Math.max(1, Math.ceil(matches.length / PATIENT_PAGE)); this.#patientPage = Math.min(this.#patientPage, pages - 1); this.#patients.replaceChildren();
        if (!matches.length) this.#patients.append(this.#node('p', 'session-library-empty-search', 'No patients match this search.'));
        for (const patient of matches.slice(this.#patientPage * PATIENT_PAGE, (this.#patientPage + 1) * PATIENT_PAGE)) {
            const card = this.#button('', 'select-patient', { patientId: patient.id }, 'session-library-patient-card'); card.disabled = Boolean(this.#state.busy); card.setAttribute('aria-pressed', String(patient.id === this.#activeId));
            card.append(this.#node('strong', null, patientName(patient))); this.#demographics(patient, card); card.append(this.#node('span', 'session-library-patient-study-count', plural(studiesOf(patient).length, 'study', 'studies')));
            const row = this.#node('div', 'session-library-patient-row'); row.append(card);
            if (this.#canAssociate(patient)) {
                const possible = possibleLocalPatientMatch(patient, this.#activePatient());
                if (possible) card.append(this.#node('span', 'session-library-match-badge', 'Possible same patient'));
                const review = this.#button('Review and combine…', 'review-association', { fromPatientId: patient.id }, `session-library-review-association${possible ? ' is-possible-match' : ''}`); review.disabled = Boolean(this.#state.busy); review.setAttribute('aria-label', `Review whether ${patientName(patient)} belongs to the active local patient and combine studies`); row.append(review);
            }
            this.#patients.append(row);
        }
        this.#paging(this.#patientPages, this.#patientPage, pages, 'patients-previous', 'patients-next');
        if (this.#activePatient()) this.#patients.prepend?.(this.#button('Return to active patient', 'return-patient', {}, 'session-library-return'));
        this.#renderAssociation();
    }
    #canAssociate(from) {
        return typeof this.#callbacks.onAssociatePatients === 'function' && canReviewLocalPatients(from, this.#activePatient());
    }
    #renderMatches() {
        const active = this.#activePatient();
        const matches = this.#view.patients.filter(patient => this.#canAssociate(patient) && possibleLocalPatientMatch(patient, active));
        if (!matches.length) return;
        const banner = this.#node('section', 'session-library-match-banner'); banner.setAttribute('aria-label', 'Possible same patient');
        banner.append(this.#node('strong', null, 'Possible same patient'), this.#node('p', null, 'MRN, name and birth date match. Review to combine studies.'));
        for (const candidate of matches.slice(0, MATCH_PREVIEW)) {
            const review = this.#button(matches.length > 1 ? `Review and combine… (${plural(studiesOf(candidate).length, 'study', 'studies')})` : 'Review and combine…', 'review-association', { fromPatientId: candidate.id }, 'session-library-match-review');
            review.disabled = Boolean(this.#state.busy); review.setAttribute('aria-label', `Review and combine studies from ${patientName(candidate)}`); banner.append(review);
        }
        if (matches.length > MATCH_PREVIEW) {
            const all = this.#button('Review other matches…', 'change-patient', {}, 'session-library-review-association'); all.disabled = Boolean(this.#state.busy); banner.append(all);
        }
        this.#patient.append(banner);
    }
    #renderAssociation() {
        this.#association.replaceChildren(); this.#associationInput = null; this.#associationConfirm = null;
        const from = this.#view.patients.find(patient => patient.id === this.#associationId), to = this.#activePatient();
        this.#association.hidden = !this.#canAssociate(from); if (this.#association.hidden) return;
        this.#association.append(this.#node('h4', null, 'Review and combine studies'), this.#node('p', null, 'Compare both identities before bringing their examinations into the active patient workspace.'));
        for (const [label, patient] of [['Studies to add', from], ['Active patient', to]]) {
            const identity = this.#node('div', 'session-library-association-person');
            identity.append(this.#node('small', null, label), this.#node('strong', null, patientName(patient)),
                this.#node('span', null, `Source: ${text(patient.sourceLabel ?? patient.source?.label, 'On this device')}`),
                this.#node('span', null, `ID: ${text(patient.patientId, 'not supplied')}`),
                this.#node('span', null, `Issuer: ${text(patient.issuerOfPatientId, 'not supplied')}`),
                this.#node('span', null, `Born: ${dateLabel(patient.patientBirthDate, 'not supplied')}`)); this.#association.append(identity);
        }
        this.#association.append(this.#node('p', 'session-library-association-note', 'Original DICOM attributes stay unchanged. Source identities are retained. Combining applies only to this viewing session.'));
        const consent = this.#node('label', 'session-library-association-consent'), checkbox = this.#node('input'); this.#associationInput = checkbox; checkbox.type = 'checkbox'; checkbox.checked = this.#associationConfirmed; checkbox.disabled = Boolean(this.#state.busy);
        consent.append(checkbox, this.#node('span', null, 'I confirm these records belong to the same patient')); this.#association.append(consent);
        const actions = this.#node('div', 'session-library-study-actions'), confirm = this.#button('Combine studies', 'confirm-association'), cancel = this.#button('Cancel', 'cancel-association');
        this.#associationConfirm = confirm; confirm.disabled = !this.#associationConfirmed || Boolean(this.#state.busy); actions.append(confirm, cancel); this.#association.append(actions);
    }
    #chosen(study) {
        const series = seriesOf(study), chosen = this.#chosenSeries.get(study.id);
        return series.find(item => item.id === chosen) ?? series.find(item => item.id === this.#state.selectedSeriesId) ?? series.find(item => !blocked(item)) ?? series[0] ?? null;
    }
    #paneLabels(series) {
        const assignments = this.#state.paneAssignments;
        if (!assignments) return [];
        if (assignments instanceof Map) {
            const direct = assignments.get(series.id);
            if (direct != null) return (Array.isArray(direct) ? direct : [direct]).map(value => typeof value === 'object' ? text(value.label ?? value.paneLabel ?? value.paneId) : text(value));
            return [...assignments.entries()].filter(([, value]) => value?.seriesId === series.id || value === series.id).map(([pane, value]) => text(value?.label ?? value?.paneLabel, typeof pane === 'number' ? `Pane ${String.fromCharCode(65 + pane)}` : `Pane ${pane}`));
        }
        if (Array.isArray(assignments)) return assignments.filter(item => item?.seriesId === series.id).map((item, index) => text(item.label ?? item.paneLabel, `Pane ${String.fromCharCode(65 + (item.paneIndex ?? index))}`));
        const value = assignments[series.id]; return value == null ? [] : (Array.isArray(value) ? value : [value]).map(item => text(item));
    }
    #instancePaneLabels(series, instance) {
        const assignments = this.#state.paneAssignments;
        const entries = assignments instanceof Map ? [...assignments.entries()].map(([paneIndex, assignment]) => ({ assignment, paneIndex })) : Array.isArray(assignments) ? assignments.map((assignment, paneIndex) => ({ assignment, paneIndex })) : [];
        return entries.filter(({ assignment }) => assignment?.seriesId === series.id && assignment.instanceId === instance.id)
            .map(({ assignment, paneIndex }) => text(assignment.label ?? assignment.paneLabel, `Pane ${String.fromCharCode(65 + (assignment.paneIndex ?? paneIndex))}`));
    }
    #notices(items) {
        if (!Array.isArray(items) || !items.length) return null;
        const details = this.#node('details', 'session-library-notices'); details.dataset.sessionIgnore = 'true'; details.append(this.#node('summary', null, plural(items.length, 'notice')));
        for (const item of items.slice(0, 10)) details.append(this.#node('p', null, text(item))); return details;
    }
    #renderInstances(series, study, patient) {
        const instances = Array.isArray(series.instances) ? series.instances : [], total = Math.max(count(series.instanceCount), instances.length), expanded = this.#expandedInstances.has(series.id);
        const container = this.#node('div', 'session-library-instances'); container.dataset.sessionIgnore = 'true';
        const toggle = this.#button(`${expanded ? '−' : '+'} Instances${total ? ` (${total.toLocaleString()})` : ''}`, 'toggle-instances', { patientId: patient.id, studyId: study.id, seriesId: series.id }, 'session-library-instance-toggle');
        toggle.setAttribute('aria-expanded', String(expanded)); toggle.setAttribute('aria-label', `${expanded ? 'Hide' : 'Show'} individual instances of ${text(series.description, 'series')}`); toggle.disabled = Boolean(this.#state.busy); container.append(toggle);
        if (!expanded) return container;
        if (!instances.length) {
            container.append(this.#node('p', 'session-library-instances-empty', series.instancesLoaded === false ? 'Retrieving instance list…' : 'Individual instances are not listed yet. Open the series to make its images available.'));
            return container;
        }
        const pages = Math.max(1, Math.ceil(instances.length / INSTANCE_PAGE)), page = Math.min(this.#instancePages.get(series.id) ?? 0, pages - 1); this.#instancePages.set(series.id, page);
        const list = this.#node('div', 'session-library-instance-list'); list.setAttribute('aria-label', `Individual instances of ${text(series.description, 'series')}`);
        for (const [offset, instance] of instances.slice(page * INSTANCE_PAGE, (page + 1) * INSTANCE_PAGE).entries()) {
            const number = instance.instanceNumber ?? page * INSTANCE_PAGE + offset + 1, frames = count(instance.frameCount);
            const item = this.#button('', 'open-instance', { patientId: patient.id, studyId: study.id, seriesId: series.id, instanceId: instance.id }, 'session-library-instance');
            item.append(this.#node('span', 'session-library-instance-number', `Image ${number}`));
            if (frames > 1) item.append(this.#node('span', 'session-library-instance-frames', plural(frames, 'frame')));
            item.disabled = Boolean(this.#state.busy) || blocked(series) || blocked(instance) || instance.indexStatus === 'unsupported';
            item.draggable = !item.disabled && typeof this.#callbacks.onDragStart === 'function';
            const paneLabels = this.#instancePaneLabels(series, instance); item.setAttribute('aria-pressed', String(paneLabels.length > 0));
            if (paneLabels.length) {
                const badges = this.#node('span', 'session-library-instance-badges');
                for (const label of paneLabels) badges.append(this.#node('span', 'session-library-instance-pane-badge', label)); item.append(badges);
            }
            item.setAttribute('aria-label', `Open image ${number}${frames > 1 ? `, ${plural(frames, 'frame')}` : ''} of ${text(series.description, 'series')} in the active pane${paneLabels.length ? `. Displayed in ${paneLabels.join(', ')}` : ''}`);
            if (item.draggable) item.title = 'Click to view, or drag to a pane';
            list.append(item);
        }
        container.append(list);
        const paging = this.#node('nav', 'session-library-pagination'); paging.setAttribute('aria-label', `Instance pages for ${text(series.description, 'series')}`);
        this.#paging(paging, page, pages, 'instances-previous', 'instances-next', { patientId: patient.id, studyId: study.id, seriesId: series.id }); container.append(paging);
        return container;
    }
    #renderSeries(series, study, patient) {
        const selected = series.id === this.#state.selectedSeriesId, card = this.#node('article', `session-library-series${selected ? ' is-selected' : ''}`); card.dataset.seriesId = series.id;
        Object.assign(card.dataset, { sessionAction: 'open-series', patientId: patient.id, studyId: study.id });
        card.disabled = Boolean(this.#state.busy) || blocked(series); card.setAttribute('aria-disabled', String(card.disabled));
        card.draggable = !card.disabled && typeof this.#callbacks.onDragStart === 'function';
        const selection = this.#node('div', 'session-library-series-select'); selection.dataset.sessionSeriesSelect = 'true'; selection.tabIndex = card.disabled ? -1 : 0; selection.setAttribute('role', 'button'); selection.setAttribute('aria-disabled', String(card.disabled)); selection.setAttribute('aria-pressed', String(selected));
        selection.setAttribute('aria-label', `Open ${text(series.description, 'Unnamed series')} from its first image in the active pane`); card.title = 'Click to view the first image, or drag to a pane';
        const thumbnail = this.#node('div', 'session-library-thumbnail'); thumbnail.setAttribute('aria-hidden', 'true');
        const supplied = this.#callbacks.getThumbnail?.(series.id, series);
        if (supplied?.ownerDocument === this.#document && typeof supplied.cloneNode === 'function') {
            const node = supplied.cloneNode(true);
            if (String(supplied.tagName).toLowerCase() === 'canvas') {
                node.width = supplied.width; node.height = supplied.height;
                node.getContext?.('2d')?.drawImage(supplied, 0, 0);
            }
            thumbnail.append(node);
        }
        else thumbnail.append(this.#node('span', 'session-library-thumbnail-symbol', '▱'), this.#node('span', 'session-library-thumbnail-modality', text(series.modality, 'DICOM')));
        const copy = this.#node('div', 'session-library-series-copy'), title = text(series.description, 'Unnamed series');
        copy.append(this.#node('strong', 'session-library-series-title', title));
        const instances = count(series.instanceCount), frames = count(series.frameCount), counts = [];
        if (series.seriesNumber != null) counts.push(`Series ${series.seriesNumber}`);
        if (instances) counts.push(plural(instances, 'instance'));
        if (frames > instances) counts.push(plural(frames, 'frame'));
        if (!instances && frames) counts.push(plural(frames, 'frame'));
        copy.append(this.#node('span', 'session-library-series-counts', counts.join(' · ') || 'Image count pending'));
        const status = this.#node('span', 'session-library-series-status', availability(series)); status.dataset.status = text(series.status); copy.append(status);
        const badges = this.#node('div', 'session-library-pane-badges');
        for (const label of this.#paneLabels(series)) badges.append(this.#node('span', 'session-library-pane-badge', label));
        copy.append(badges);
        selection.append(thumbnail, copy); card.append(selection);
        if (Array.isArray(series.stackGroups) && series.stackGroups.length > 1) {
            const groups = this.#node('div', 'session-library-stack-groups'); groups.dataset.sessionIgnore = 'true'; groups.append(this.#node('span', null, 'Image stacks'));
            const total = series.stackGroups.length, pages = Math.ceil(total / STACK_PAGE), page = Math.min(this.#stackPages.get(series.id) ?? 0, pages - 1);
            const start = page * STACK_PAGE, end = Math.min(start + STACK_PAGE, total); this.#stackPages.set(series.id, page);
            if (pages > 1) {
                const range = this.#node('span', 'session-library-stack-range', `${(start + 1).toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()}`);
                range.setAttribute('aria-live', 'polite'); range.setAttribute('aria-atomic', 'true'); groups.append(range);
            }
            for (const [offset, group] of series.stackGroups.slice(start, end).entries()) {
                const stackIndex = start + offset;
                const label = text(group.label, `Stack ${stackIndex + 1}`), images = count(group.frameCount);
                const button = this.#button(`${label}${images ? ` · ${images.toLocaleString()}` : ''}`, 'open-group', { patientId: patient.id, studyId: study.id, seriesId: series.id, stackIndex: String(stackIndex) });
                button.title = `${label}${images ? ` · ${plural(images, 'image')}` : ''}`;
                button.setAttribute('aria-label', `Open ${label} image stack${images ? `, ${plural(images, 'image')}` : ''}`);
                button.disabled = Boolean(this.#state.busy) || blocked(series); groups.append(button);
            }
            if (pages > 1) {
                const paging = this.#node('nav', 'session-library-pagination session-library-stack-pagination'); paging.setAttribute('aria-label', `Image stack pages for ${text(series.description, 'series')}`);
                this.#paging(paging, page, pages, 'stacks-previous', 'stacks-next', { patientId: patient.id, studyId: study.id, seriesId: series.id });
                for (const button of paging.children) if (String(button.tagName).toLowerCase() === 'button') {
                    button.disabled ||= Boolean(this.#state.busy);
                    button.setAttribute('aria-label', `${button.dataset.sessionAction === 'stacks-previous' ? 'Previous' : 'Next'} image stacks for ${text(series.description, 'series')}`);
                }
                groups.append(paging);
            }
            card.append(groups);
        }
        card.append(this.#renderInstances(series, study, patient));
        const notices = this.#notices(series.warnings); if (notices) card.append(notices); return card;
    }
    #renderStudy(study, patient) {
        const current = study.id === this.#state.currentStudyId, comparison = study.id === this.#state.comparisonStudyId;
        const card = this.#node('article', `session-library-study${current ? ' is-current' : ''}${comparison ? ' is-comparison' : ''}`); card.dataset.studyId = study.id;
        const expanded = this.#expanded.has(study.id), heading = this.#node('div', 'session-library-study-heading');
        const toggle = this.#button(expanded ? '−' : '+', 'toggle-study', { studyId: study.id }, 'session-library-study-toggle'); toggle.setAttribute('aria-expanded', String(expanded)); toggle.setAttribute('aria-label', `${expanded ? 'Hide' : 'Show'} series for ${text(study.description, 'examination')} dated ${dateLabel(study.studyDate)}`);
        heading.append(toggle, this.#node('time', 'session-library-study-date', dateLabel(study.studyDate)));
        if (current || comparison) heading.append(this.#node('span', `session-library-role${comparison ? ' comparison' : ''}`, current ? 'Current' : 'Comparison'));
        const modalities = Array.isArray(study.modalities) ? study.modalities : [], series = seriesOf(study);
        const seriesCount = Math.max(count(study.seriesCount), series.length), seriesLabel = !study.seriesLoaded && !seriesCount ? 'Series not listed yet' : plural(seriesCount, 'series', 'series');
        card.append(heading, this.#node('strong', 'session-library-study-description', text(study.description, 'Untitled examination')),
            this.#node('span', 'session-library-study-metadata', `${modalities.join(' / ') || 'DICOM'} · ${seriesLabel}${count(study.instanceCount) ? ` · ${plural(study.instanceCount, 'image')}` : ''}`),
            this.#node('span', 'session-library-source', text(study.sourceLabel ?? study.source?.label, 'Session images')));
        const canOpen = !blocked(study) && (!study.seriesLoaded || series.some(item => !blocked(item))), chosen = this.#chosen(study), actions = this.#node('div', 'session-library-study-actions');
        const open = this.#button(current ? 'View current' : 'View study', 'open-study', { patientId: patient.id, studyId: study.id }); open.disabled = Boolean(this.#state.busy) || !canOpen;
        const compare = this.#button(comparison ? 'Comparing' : 'Compare', 'compare-study', { patientId: patient.id, studyId: study.id }); compare.disabled = Boolean(this.#state.busy) || !canOpen || current || comparison || !studiesOf(patient).some(item => item.id === this.#state.currentStudyId); compare.title = 'Display beside the current examination for this patient'; actions.append(open, compare); card.append(actions);
        if (chosen && series.length > 1) card.append(this.#node('span', 'session-library-chosen-series', `Selected: ${text(chosen.description, 'Unnamed series')}`));
        const notices = this.#notices(study.warnings); if (notices) card.append(notices);
        if (expanded) {
            const list = this.#node('div', 'session-library-series-list');
            if (!series.length) list.append(this.#node('p', 'session-library-series-empty', study.seriesLoaded ? 'No displayable series returned.' : 'Choose View study to retrieve the series list.'));
            const pages = Math.max(1, Math.ceil(series.length / SERIES_PAGE)), page = Math.min(this.#seriesPages.get(study.id) ?? 0, pages - 1); this.#seriesPages.set(study.id, page);
            for (const entry of series.slice(page * SERIES_PAGE, (page + 1) * SERIES_PAGE)) list.append(this.#renderSeries(entry, study, patient));
            const paging = this.#node('nav', 'session-library-pagination'); paging.setAttribute('aria-label', `Series pages for ${text(study.description, 'examination')}`); this.#paging(paging, page, pages, 'series-previous', 'series-next', { studyId: study.id }); list.append(paging); card.append(list);
        }
        return card;
    }
    #renderStudies() {
        this.#timeline.replaceChildren(); const patient = this.#activePatient(); if (!patient) { this.#studyPages.hidden = true; return; }
        const studies = [...studiesOf(patient)].sort((a, b) => text(b.studyDate).localeCompare(text(a.studyDate)) || text(b.studyTime).localeCompare(text(a.studyTime)) || text(a.id).localeCompare(text(b.id))), pages = Math.max(1, Math.ceil(studies.length / STUDY_PAGE)); this.#studyPage = Math.min(this.#studyPage, pages - 1);
        this.#timeline.append(this.#node('h3', 'session-library-timeline-title', 'Studies in this session'));
        if (!studies.length) this.#timeline.append(this.#node('p', 'session-library-series-empty', 'No studies have been added for this patient.'));
        for (const study of studies.slice(this.#studyPage * STUDY_PAGE, (this.#studyPage + 1) * STUDY_PAGE)) this.#timeline.append(this.#renderStudy(study, patient));
        if (this.#state.comparisonStudyId) this.#timeline.append(this.#node('p', 'session-library-comparison-note', 'Current and comparison examinations share this patient workspace. Spatial linking requires compatible geometry.'));
        this.#paging(this.#studyPages, this.#studyPage, pages, 'studies-previous', 'studies-next');
    }
    #renderMessage() { const message = this.#error || text(this.#state.message ?? this.#state.operationLabel); this.#message.textContent = message; this.#message.hidden = !message; this.#message.dataset.kind = this.#error ? 'error' : 'status'; }
    #render() {
        const patient = this.#activePatient(), finding = this.#finding || !patient, empty = !this.#view.patients.length;
        this.#finder.hidden = empty || !finding; this.#patient.hidden = !patient || finding; this.#timeline.hidden = !patient || finding; this.#studyPages.hidden = !patient || finding;
        this.#renderMessage(); this.#renderPatients(); this.#patient.replaceChildren();
        if (patient) {
            const heading = this.#node('div', 'session-library-patient-heading'); heading.append(this.#node('strong', 'session-library-patient-name', patientName(patient)));
            const switcher = this.#button('Switch', 'change-patient', {}, 'session-library-switch-patient'); switcher.disabled = Boolean(this.#state.busy); switcher.hidden = this.#view.patients.length < 2; heading.append(switcher); this.#patient.append(heading); this.#demographics(patient, this.#patient);
            const notices = this.#notices(patient.warnings); if (notices) this.#patient.append(notices);
            this.#renderMatches();
            const close = this.#button('Close patient workspace', 'remove-patient', { patientId: patient.id }, 'session-library-close-patient'); close.disabled = Boolean(this.#state.busy); this.#patient.append(close);
        }
        this.#renderStudies(); if (finding) this.#studyPages.hidden = true;
    }
    #focus(action, data = {}) {
        const visit = node => { for (const child of node.children ?? []) { if (child.hidden) continue; if (child.dataset?.sessionAction === action && Object.entries(data).every(([field, value]) => child.dataset[field] === value)) return child; const nested = visit(child); if (nested) return nested; } return null; };
        visit(this.#panel)?.focus();
    }
    #action(action, data) {
        if (this.#disposed) return;
        if (action === 'change-patient') { if (this.#state.busy) return; this.#finding = true; this.#associationId = null; this.#associationConfirmed = false; this.#associationFromTimeline = false; this.#render(); this.#search.focus(); return; }
        if (action === 'return-patient') { this.#finding = false; this.#associationId = null; this.#associationConfirmed = false; this.#associationFromTimeline = false; this.#render(); return; }
        if (action === 'review-association') { const patient = this.#view.patients.find(item => item.id === data.fromPatientId); if (!this.#state.busy && this.#canAssociate(patient)) { this.#associationFromTimeline = !this.#finding; this.#finding = true; this.#associationId = patient.id; this.#associationConfirmed = false; this.#render(); this.#associationInput?.focus(); } return; }
        if (action === 'cancel-association') { const fromPatientId = this.#associationId; if (this.#associationFromTimeline) this.#finding = false; this.#associationId = null; this.#associationConfirmed = false; this.#associationFromTimeline = false; this.#render(); this.#focus('review-association', { fromPatientId }); return; }
        if (action === 'confirm-association') {
            const patient = this.#view.patients.find(item => item.id === this.#associationId), active = this.#activePatient();
            if (this.#associationConfirmed && !this.#state.busy && this.#canAssociate(patient)) {
                this.#pendingAssociationId = patient.id; this.#associationId = null; this.#associationConfirmed = false; this.#renderAssociation(); this.#invoke('onAssociatePatients', patient.id, active.id, { confirmed: true });
            }
            return;
        }
        if (action === 'select-patient') { if (!this.#view.patients.some(patient => patient.id === data.patientId)) return; this.#finding = false; this.#associationId = null; this.#associationConfirmed = false; this.#invoke('onSelectPatient', data.patientId); return; }
        if (action === 'remove-patient') { if (data.patientId === this.#activeId) this.#invoke('onRemovePatient', data.patientId); return; }
        if (action.startsWith('patients-')) { this.#patientPage = Math.max(0, this.#patientPage + (action === 'patients-next' ? 1 : -1)); this.#renderPatients(); this.#focus(action); return; }
        if (action.startsWith('studies-')) { this.#studyPage = Math.max(0, this.#studyPage + (action === 'studies-next' ? 1 : -1)); this.#renderStudies(); this.#focus(action); return; }
        const patient = this.#activePatient(), study = studiesOf(patient).find(item => item.id === data.studyId); if (!study) return;
        if (action === 'toggle-study') { if (this.#expanded.has(study.id)) this.#expanded.delete(study.id); else this.#expanded.add(study.id); this.#renderStudies(); this.#focus(action, { studyId: study.id }); }
        else if (action === 'open-study') this.#invoke('onOpenStudy', study.id, { patientId: patient.id, seriesId: this.#chosen(study)?.id });
        else if (action === 'compare-study') { if (studiesOf(patient).some(item => item.id === this.#state.currentStudyId) && study.id !== this.#state.currentStudyId) this.#invoke('onCompareStudies', this.#state.currentStudyId, study.id, { comparisonSeriesId: this.#chosen(study)?.id }); }
        else if (action === 'series-next' || action === 'series-previous') { this.#seriesPages.set(study.id, Math.max(0, (this.#seriesPages.get(study.id) ?? 0) + (action === 'series-next' ? 1 : -1))); this.#renderStudies(); this.#focus(action, { studyId: study.id }); }
        else if (['toggle-instances', 'instances-next', 'instances-previous', 'stacks-next', 'stacks-previous', 'open-instance', 'open-series', 'open-group'].includes(action)) {
            const series = seriesOf(study).find(item => item.id === data.seriesId); if (!series) return;
            if (action === 'stacks-next' || action === 'stacks-previous') {
                if (this.#state.busy) return;
                const pages = Math.max(1, Math.ceil((series.stackGroups?.length ?? 0) / STACK_PAGE));
                const page = Math.max(0, Math.min(pages - 1, (this.#stackPages.get(series.id) ?? 0) + (action === 'stacks-next' ? 1 : -1)));
                this.#stackPages.set(series.id, page); this.#renderStudies();
                this.#focus(action === 'stacks-next' && page === pages - 1 ? 'stacks-previous' : action === 'stacks-previous' && page === 0 ? 'stacks-next' : action, { seriesId: series.id }); return;
            }
            if (action === 'toggle-instances') {
                if (this.#expandedInstances.has(series.id)) this.#expandedInstances.delete(series.id);
                else { this.#expandedInstances.add(series.id); if (series.instancesLoaded === false) this.#invoke('onListInstances', series.id); }
                this.#renderStudies(); this.#focus(action, { seriesId: series.id }); return;
            }
            if (action === 'instances-next' || action === 'instances-previous') {
                this.#instancePages.set(series.id, Math.max(0, (this.#instancePages.get(series.id) ?? 0) + (action === 'instances-next' ? 1 : -1)));
                this.#renderStudies(); this.#focus(action, { seriesId: series.id }); return;
            }
            if (this.#state.busy || blocked(series)) return;
            this.#chosenSeries.set(study.id, series.id);
            const options = { patientId: patient.id, studyId: study.id, role: study.id === this.#state.comparisonStudyId ? 'comparison' : 'current', frameIndex: 0 };
            if (action === 'open-group') {
                options.stackIndex = Number(data.stackIndex);
                if (!Number.isSafeInteger(options.stackIndex) || options.stackIndex < 0 || !series.stackGroups?.[options.stackIndex]) return;
            }
            if (action === 'open-instance') {
                const instance = series.instances?.find(item => item.id === data.instanceId);
                if (!instance || blocked(instance) || instance.indexStatus === 'unsupported') return;
                this.#invoke('onOpenInstance', instance.id, { ...options, seriesId: series.id });
            } else this.#invoke('onOpenSeries', series.id, options);
        }
    }
    setView(view, state = {}) {
        if (this.#disposed) return; if (!Array.isArray(view?.patients)) throw new TypeError('Use a viewing session catalog.');
        const restoreConsentFocus = this.#document.activeElement === this.#associationInput && this.#associationInput != null;
        const identity = patient => patient ? JSON.stringify([patient.id, patient.patientId, patient.patientName, patient.patientBirthDate, patient.issuerOfPatientId, patient.sourceId]) : '';
        if (this.#associationId) {
            const from = this.#view.patients.find(patient => patient.id === this.#associationId), next = view.patients.find(patient => patient.id === this.#associationId);
            if (identity(from) !== identity(next) || identity(this.#activePatient()) !== identity(view.patients.find(patient => patient.id === this.#activeId))) this.#associationConfirmed = false;
        }
        const active = Object.hasOwn(state, 'activePatientId') ? state.activePatientId : view.activePatientId;
        if (active !== this.#activeId) { this.#activeId = active ?? null; this.#finding = false; this.#studyPage = 0; this.#error = ''; this.#associationId = null; this.#associationConfirmed = false; this.#associationFromTimeline = false; }
        if (this.#pendingAssociationId && !view.patients.some(patient => patient.id === this.#pendingAssociationId)) { this.#pendingAssociationId = null; this.#finding = false; this.#associationFromTimeline = false; }
        this.#view = view; this.#state = state;
        for (const patient of view.patients) for (const [index, study] of studiesOf(patient).entries()) {
            if (!this.#seenStudies.has(study.id)) { if (index === 0 || study.id === state.currentStudyId || study.id === state.comparisonStudyId) this.#expanded.add(study.id); this.#seenStudies.add(study.id); }
        }
        const liveStudies = new Set(view.patients.flatMap(patient => studiesOf(patient).map(study => study.id)));
        const liveSeries = new Set(view.patients.flatMap(patient => studiesOf(patient).flatMap(study => seriesOf(study).map(series => series.id))));
        for (const set of [this.#expanded, this.#seenStudies]) for (const id of set) if (!liveStudies.has(id)) set.delete(id);
        for (const map of [this.#seriesPages, this.#chosenSeries]) for (const id of map.keys()) if (!liveStudies.has(id)) map.delete(id);
        for (const id of this.#expandedInstances) if (!liveSeries.has(id)) this.#expandedInstances.delete(id);
        for (const id of this.#instancePages.keys()) if (!liveSeries.has(id)) this.#instancePages.delete(id);
        for (const id of this.#stackPages.keys()) if (!liveSeries.has(id)) this.#stackPages.delete(id);
        for (const patient of view.patients) for (const study of studiesOf(patient)) for (const series of seriesOf(study)) {
            if (!this.#stackPages.has(series.id)) continue;
            const pages = Math.max(1, Math.ceil((series.stackGroups?.length ?? 0) / STACK_PAGE));
            this.#stackPages.set(series.id, Math.min(this.#stackPages.get(series.id), pages - 1));
        }
        this.#render();
        if (restoreConsentFocus && this.#associationInput && !this.#associationInput.disabled) this.#associationInput.focus();
    }
    setCatalog(view, state = {}) { this.setView(view, state); }
    getState() { return Object.freeze({ activePatientId: this.#activeId, findingPatient: this.#finding || !this.#activePatient(), patientCount: this.#view.patients.length, matchedPatientCount: this.#matches().length, patientPage: this.#patientPage, studyPage: this.#studyPage }); }
    dispose() { if (!this.#disposed) { this.#disposed = true; this.#lifetime.abort(); this.#root.replaceChildren(); this.#view = { patients: [] }; this.#callbacks = {}; this.#expanded.clear(); this.#seenStudies.clear(); this.#seriesPages.clear(); this.#chosenSeries.clear(); this.#expandedInstances.clear(); this.#instancePages.clear(); this.#stackPages.clear(); } }
}
