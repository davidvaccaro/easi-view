const PAGE_SIZE = 25, STUDIES_PER_PAGE = 12, SERIES_PER_PAGE = 20, MAX_QUERY = 256;

const text = (value, fallback = '') => value == null || value === '' ? fallback : String(value);
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const plural = (count, singular, many = `${singular}s`) => `${count.toLocaleString()} ${count === 1 ? singular : many}`;
const nameOf = patient => text(patient.patientName ?? patient.name, 'Unnamed patient').replaceAll('^', ' ').trim() || 'Unnamed patient';
const idOf = item => item.id;
const studiesOf = patient => Array.isArray(patient?.studies) ? patient.studies : [];
const seriesOf = study => Array.isArray(study?.series) ? study.series : [];
function dateLabel(value, unknown = 'Date not supplied') {
    const date = text(value).replaceAll('-', '');
    if (!/^\d{8}$/.test(date)) return unknown;
    const year = Number(date.slice(0, 4)), month = Number(date.slice(4, 6)), day = Number(date.slice(6, 8));
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return unknown;
    return `${String(day).padStart(2, '0')} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month - 1]} ${year}`;
}
function studyDateKey(study) {
    const date = text(study.studyDate).replaceAll('-', '');
    return /^\d{8}$/.test(date) && dateLabel(date) !== 'Date not supplied' ? `${date}${text(study.studyTime)}` : '';
}
function statusLabel(status) {
    return ({ indexed: 'Metadata indexed', 'uid-conflict': 'UID conflict · review notices', available: 'Available', loaded: 'Loaded', loading: 'Loading', unsupported: 'Not displayable', error: 'Unable to open', unavailable: 'Unavailable' })[status] ?? 'Metadata indexed';
}

/** Patient-first navigation over retained local metadata; never reads or uploads files. */
export class LocalLibraryPanel {
    #root; #document; #callbacks; #lifetime = new AbortController(); #disposed = false;
    #view = {patients: []}; #state = {}; #finding = false; #query = ''; #patientPage = 0; #studyPage = 0;
    #expanded = new Set(); #seriesPages = new Map(); #selectedByStudy = new Map(); #activePatientId = null; #localError = ''; #associationId = null; #associationConfirmed = false; #lastRoles = [];
    #panel; #intro; #count; #search; #finder; #patients; #patientPaging; #patientStatus; #previousPatient; #nextPatient;
    #patient; #timeline; #association; #associationInput; #associationConfirm; #clear; #studyPaging; #studyStatus; #previousStudy; #nextStudy; #message; #mediaMessage; #progress; #cancel; #importFiles; #importFolder;

    constructor(root, callbacks = {}) {
        if (!root?.ownerDocument?.createElement || typeof root.replaceChildren !== 'function') throw new TypeError('Mount the local library in a DOM element.');
        this.#root = root; this.#document = root.ownerDocument; this.#callbacks = callbacks; this.#mount(); this.#render();
    }
    #node(tag, className, value) {
        const element = this.#document.createElement(tag);
        if (className) element.className = className;
        if (value != null) element.textContent = value;
        return element;
    }
    #button(label, action, className = 'local-library-button', data = {}) {
        const button = this.#node('button', className, label); button.type = 'button';
        button.dataset.localAction = action;
        Object.assign(button.dataset, data);
        return button;
    }
    #mount() {
        this.#panel = this.#node('section', 'local-library'); this.#panel.setAttribute('aria-label', 'Local patient library');
        const heading = this.#node('div', 'local-library-heading');
        heading.append(this.#node('h3', null, 'On this device'));
        this.#count = this.#node('span', 'local-library-count'); heading.append(this.#count);
        this.#intro = this.#node('p', 'local-library-intro', 'Add files or a folder. Choose a patient, then an examination.');
        const imports = this.#node('div', 'local-library-imports');
        this.#importFiles = this.#button('Add files', 'import-files'); this.#importFiles.setAttribute('aria-label', 'Add local DICOM files');
        this.#importFolder = this.#button('Add folder', 'import-folder'); this.#importFolder.setAttribute('aria-label', 'Add local DICOM folder');
        this.#importFolder.title = 'Choose the media root containing DICOMDIR and its image folders, or any folder of DICOM files.';
        imports.append(this.#importFiles, this.#importFolder);
        this.#message = this.#node('p', 'local-library-message'); this.#message.setAttribute('role', 'status'); this.#message.setAttribute('aria-live', 'polite');
        this.#mediaMessage = this.#node('p', 'local-library-media'); this.#mediaMessage.setAttribute('role', 'status');
        const progressRow = this.#node('div', 'local-library-progress-row');
        this.#progress = this.#node('progress', 'local-library-progress'); this.#progress.setAttribute('aria-label', 'Local metadata indexing');
        this.#cancel = this.#button('Cancel', 'cancel-import', 'local-library-button local-library-cancel'); progressRow.append(this.#progress, this.#cancel);
        this.#finder = this.#node('div', 'local-library-finder');
        const label = this.#node('label', 'local-library-search-label', 'Find a patient');
        this.#search = this.#node('input', 'local-library-search'); this.#search.type = 'search'; this.#search.maxLength = MAX_QUERY;
        this.#search.placeholder = 'Name, patient ID, or birth date'; this.#search.autocomplete = 'off'; this.#search.setAttribute('aria-label', 'Find a local patient by name, ID, issuer, or birth date');
        this.#search.setAttribute('spellcheck', 'false'); this.#search.setAttribute('autocapitalize', 'off'); label.append(this.#search);
        this.#patients = this.#node('div', 'local-library-patients');
        this.#patientPaging = this.#node('nav', 'local-library-pagination'); this.#patientPaging.setAttribute('aria-label', 'Patient pages');
        this.#previousPatient = this.#button('Previous', 'patients-previous'); this.#previousPatient.setAttribute('aria-label', 'Previous patients');
        this.#nextPatient = this.#button('Next', 'patients-next'); this.#nextPatient.setAttribute('aria-label', 'Next patients');
        this.#patientStatus = this.#node('span', 'local-library-page-status'); this.#patientPaging.append(this.#previousPatient, this.#patientStatus, this.#nextPatient);
        this.#association = this.#node('div', 'local-library-association');
        this.#finder.append(label, this.#patients, this.#patientPaging, this.#association);
        this.#patient = this.#node('div', 'local-library-patient');
        this.#timeline = this.#node('div', 'local-library-timeline'); this.#timeline.setAttribute('aria-label', 'Patient study timeline');
        this.#studyPaging = this.#node('nav', 'local-library-pagination'); this.#studyPaging.setAttribute('aria-label', 'Study pages');
        this.#previousStudy = this.#button('Previous', 'studies-previous'); this.#previousStudy.setAttribute('aria-label', 'Previous studies');
        this.#nextStudy = this.#button('Next', 'studies-next'); this.#nextStudy.setAttribute('aria-label', 'Next studies');
        this.#studyStatus = this.#node('span', 'local-library-page-status'); this.#studyPaging.append(this.#previousStudy, this.#studyStatus, this.#nextStudy);
        this.#clear = this.#button('Clear local library', 'clear-library', 'local-library-clear');
        this.#panel.append(heading, this.#intro, imports, this.#message, this.#mediaMessage, progressRow, this.#finder, this.#patient, this.#timeline, this.#studyPaging, this.#clear); this.#root.replaceChildren(this.#panel);
        this.#search.addEventListener('input', () => {
            this.#query = this.#search.value.slice(0, MAX_QUERY).trim().toLowerCase(); this.#search.value = this.#search.value.slice(0, MAX_QUERY); this.#patientPage = 0; this.#renderPatients();
        }, {signal: this.#lifetime.signal});
        this.#panel.addEventListener('change', event => {
            if (event.target?.dataset?.localAssociationConsent != null) { this.#associationConfirmed = event.target.checked; if (this.#associationConfirm) this.#associationConfirm.disabled = !this.#associationConfirmed || Boolean(this.#state.busy); }
            if (event.target?.dataset?.localStudySeries != null) this.#selectedByStudy.set(event.target.dataset.localStudySeries, event.target.value);
        }, {signal: this.#lifetime.signal});
        this.#panel.addEventListener('click', event => {
            let target = event.target;
            while (target && target !== this.#panel) {
                if (target.dataset?.localAction) { if (!target.disabled) this.#action(target.dataset.localAction, target.dataset); return; }
                target = target.parentNode;
            }
        }, {signal: this.#lifetime.signal});
    }
    #invoke(key, ...args) {
        if (this.#disposed || typeof this.#callbacks[key] !== 'function') return;
        this.#localError = '';
        try {
            const operation = this.#callbacks[key](...args);
            if (operation?.catch) operation.catch(error => { if (!this.#disposed && error?.name !== 'AbortError') { this.#localError = text(error?.message, 'The requested action could not finish.'); this.#renderMessage(); } });
        } catch (error) { this.#localError = text(error?.message, 'The requested action could not finish.'); this.#renderMessage(); }
    }
    #patientsMatching() {
        const terms = this.#query.split(/\s+/u).filter(Boolean);
        return this.#view.patients.filter(patient => {
            const haystack = `${nameOf(patient)} ${text(patient.patientId)} ${text(patient.issuerOfPatientId ?? patient.issuer)} ${text(patient.patientBirthDate ?? patient.birthDate)} ${dateLabel(patient.patientBirthDate ?? patient.birthDate, '')}`.toLowerCase();
            return terms.every(term => haystack.includes(term));
        });
    }
    #selectedPatient() { return this.#view.patients.find(patient => idOf(patient) === this.#state.activePatientId) ?? null; }
    #studies(patient) { return [...studiesOf(patient)].sort((a, b) => studyDateKey(b).localeCompare(studyDateKey(a)) || text(a.id).localeCompare(text(b.id))); }
    #action(action, data) {
        if (this.#disposed) return;
        if (action === 'import-files') this.#invoke('onImportFiles');
        else if (action === 'import-folder') this.#invoke('onImportFolder');
        else if (action === 'cancel-import') this.#invoke('onCancelImport');
        else if (action === 'clear-library') this.#invoke('onClearLocalLibrary');
        else if (action === 'review-association') { this.#associationId = data.patientId; this.#associationConfirmed = false; this.#renderAssociation(); this.#associationInput?.focus(); }
        else if (action === 'cancel-association') { this.#associationId = null; this.#associationConfirmed = false; this.#renderAssociation(); }
        else if (action === 'confirm-association') {
            const source = this.#view.patients.find(patient => String(patient.id) === this.#associationId), target = this.#selectedPatient();
            if (this.#associationConfirmed && source && target && source.id !== target.id) {
                this.#associationId = null; this.#associationConfirmed = false; this.#invoke('onAssociatePatient', source.id, target.id); this.#renderAssociation();
            }
        }
        else if (action === 'change-patient') { this.#finding = true; this.#render(); this.#search.focus(); }
        else if (action === 'return-patient') { this.#finding = false; this.#render(); }
        else if (action === 'select-patient') {
            const patient = this.#view.patients.find(item => String(item.id) === data.patientId);
            if (!patient) return;
            this.#finding = false; this.#studyPage = 0; this.#associationId = null; this.#associationConfirmed = false; this.#invoke('onSelectPatient', patient.id);
        } else if (action === 'patients-previous') { this.#patientPage = Math.max(0, this.#patientPage - 1); this.#renderPatients(); }
        else if (action === 'patients-next') { ++this.#patientPage; this.#renderPatients(); }
        else if (action === 'studies-previous') { this.#studyPage = Math.max(0, this.#studyPage - 1); this.#renderStudies(); }
        else if (action === 'studies-next') { ++this.#studyPage; this.#renderStudies(); }
        else {
            const patient = this.#selectedPatient(), study = studiesOf(patient).find(item => String(item.id) === data.studyId);
            if (!patient || !study) return;
            if (action === 'toggle-study') {
                if (this.#expanded.has(study.id)) this.#expanded.delete(study.id); else this.#expanded.add(study.id);
                this.#renderStudies(); this.#focusAction(data);
            } else if (action === 'open-study') this.#invoke('onOpenStudy', study.id, {patientId: patient.id, seriesId: this.#chosenSeries(study)?.id});
            else if (action === 'compare-study') {
                if (!this.#state.currentStudyId || study.id === this.#state.currentStudyId || !studiesOf(patient).some(item => item.id === this.#state.currentStudyId)) return;
                this.#invoke('onCompareStudies', this.#state.currentStudyId, study.id, {comparisonSeriesId: this.#chosenSeries(study)?.id});
            } else if (action === 'open-series') {
                const series = seriesOf(study).find(item => String(item.id) === data.seriesId);
                if (series) { this.#selectedByStudy.set(String(study.id), String(series.id)); this.#invoke('onOpenSeries', series.id, {patientId: patient.id, studyId: study.id, role: study.id === this.#state.comparisonStudyId ? 'comparison' : 'current'}); }
            } else if (action === 'series-next' || action === 'series-previous') {
                this.#seriesPages.set(study.id, Math.max(0, (this.#seriesPages.get(study.id) ?? 0) + (action === 'series-next' ? 1 : -1))); this.#renderStudies(); this.#focusAction(data);
            }
        }
    }
    #demographics(patient, parent) {
        const id = text(patient.patientId, 'Not supplied'), issuer = text(patient.issuerOfPatientId ?? patient.issuer, 'Issuer not supplied');
        parent.append(this.#node('span', 'local-library-patient-id', `ID ${id}`), this.#node('span', 'local-library-patient-demographics', `Born ${dateLabel(patient.patientBirthDate ?? patient.birthDate, 'not supplied')}`), this.#node('span', 'local-library-patient-issuer', issuer));
        if (patient.identityStatus === 'confirmed-association') parent.append(this.#node('span', 'local-library-identity-note', 'Patient association confirmed for this session'));
        else if (patient.identityStatus === 'batch-scoped' || patient.identityStatus === 'study-scoped' || patient.identityStatus === 'unverified' || patient.identityVerified === false || (!patient.issuerOfPatientId && !patient.issuer)) {
            parent.append(this.#node('span', 'local-library-identity-note', 'Local identity · imports kept separate unless verified'));
        }
        if (Array.isArray(patient.warnings) && patient.warnings.length) parent.append(this.#node('span', 'local-library-identity-warning', patient.warnings.map(item => text(item)).join(' ')));
    }
    #renderPatients() {
        const matches = this.#patientsMatching(); this.#patientPage = Math.min(this.#patientPage, Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1));
        this.#patients.replaceChildren();
        const visible = matches.slice(this.#patientPage * PAGE_SIZE, (this.#patientPage + 1) * PAGE_SIZE);
        for (const patient of visible) {
            const card = this.#button('', 'select-patient', 'local-library-patient-card', {patientId: String(patient.id)}); card.disabled = Boolean(this.#state.busy);
            card.append(this.#node('strong', 'local-library-patient-name', nameOf(patient))); this.#demographics(patient, card);
            card.append(this.#node('span', 'local-library-patient-count', plural(studiesOf(patient).length, 'study', 'studies')));
            const row = this.#node('div', 'local-library-patient-row'); row.append(card);
            if (this.#selectedPatient() && patient.id !== this.#state.activePatientId && typeof this.#callbacks.onAssociatePatient === 'function') {
                const associate = this.#button('Review patient association…', 'review-association', 'local-library-associate-link', {patientId: String(patient.id)}); associate.disabled = Boolean(this.#state.busy); row.append(associate);
            }
            this.#patients.append(row);
        }
        if (!visible.length) this.#patients.append(this.#node('p', 'local-library-empty', this.#view.patients.length ? 'No patients match this search.' : 'Your local studies will appear here. Files stay on this device.'));
        if (this.#finding && this.#selectedPatient()) this.#patients.append(this.#button('Return to selected patient', 'return-patient', 'local-library-button local-library-return'));
        this.#patientPaging.hidden = matches.length <= PAGE_SIZE;
        this.#previousPatient.disabled = this.#patientPage === 0; this.#nextPatient.disabled = (this.#patientPage + 1) * PAGE_SIZE >= matches.length;
        this.#patientStatus.textContent = `${this.#patientPage * PAGE_SIZE + (matches.length ? 1 : 0)}–${this.#patientPage * PAGE_SIZE + visible.length} of ${matches.length.toLocaleString()}`;
    }
    #focusAction(data) {
        const pending = [...this.#panel.children];
        while (pending.length) {
            const node = pending.shift();
            if (node.dataset?.localAction === data.localAction && ['studyId', 'seriesId', 'patientId'].every(key => node.dataset[key] === data[key])) { node.focus(); return; }
            pending.push(...node.children);
        }
    }
    #renderAssociation() {
        const source = this.#view.patients.find(patient => String(patient.id) === this.#associationId), target = this.#selectedPatient();
        this.#association.replaceChildren(); this.#associationInput = null; this.#associationConfirm = null; this.#association.hidden = !source || !target || source.id === target.id;
        if (this.#association.hidden) return;
        this.#association.setAttribute('role', 'region'); this.#association.setAttribute('aria-label', 'Review local patient association');
        this.#association.append(this.#node('h4', null, 'Review patient association'), this.#node('p', null, 'Confirm these records belong to one patient before bringing their examinations together.'));
        for (const [label, patient] of [['Imported records', source], ['Selected patient', target]]) {
            const details = this.#node('div', 'local-library-association-person'); details.append(this.#node('small', null, label), this.#node('strong', null, nameOf(patient))); this.#demographics(patient, details); this.#association.append(details);
        }
        this.#association.append(this.#node('p', 'local-library-association-note', 'This association applies to this catalog session. Original DICOM attributes stay unchanged.'));
        const consent = this.#node('label', 'local-library-association-consent'), checkbox = this.#node('input'); this.#associationInput = checkbox; checkbox.type = 'checkbox'; checkbox.dataset.localAssociationConsent = ''; checkbox.checked = this.#associationConfirmed; checkbox.disabled = Boolean(this.#state.busy);
        consent.append(checkbox, this.#node('span', null, 'I confirm these records belong to the same patient.')); this.#association.append(consent);
        const actions = this.#node('div', 'local-library-study-actions'), confirm = this.#button('Associate records', 'confirm-association'), cancel = this.#button('Cancel', 'cancel-association'); this.#associationConfirm = confirm; confirm.disabled = !this.#associationConfirmed || Boolean(this.#state.busy); actions.append(confirm, cancel); this.#association.append(actions);
    }
    #chosenSeries(study) {
        const series = seriesOf(study), chosen = this.#selectedByStudy.get(String(study.id));
        return series.find(item => String(item.id) === chosen) ?? series.find(item => item.id === this.#state.selectedSeriesId) ?? series.find(item => !['unsupported', 'unavailable', 'error'].includes(item.status)) ?? series[0];
    }
    #warnings(warnings) {
        if (!Array.isArray(warnings) || !warnings.length) return null;
        const details = this.#node('details', 'local-library-warnings');
        details.append(this.#node('summary', null, plural(warnings.length, 'notice')));
        for (const warning of warnings.slice(0, 10)) details.append(this.#node('p', null, text(warning)));
        if (warnings.length > 10) details.append(this.#node('p', null, `${warnings.length - 10} additional notices.`));
        return details;
    }
    #renderStudy(study, patient) {
        const current = study.id === this.#state.currentStudyId, comparison = study.id === this.#state.comparisonStudyId;
        const card = this.#node('article', `local-library-study${current ? ' is-current' : ''}${comparison ? ' is-comparison' : ''}`); card.dataset.studyId = String(study.id);
        const line = this.#node('div', 'local-library-study-date'); line.append(this.#node('time', null, dateLabel(study.studyDate)));
        if (current || comparison) line.append(this.#node('span', `local-library-role${comparison ? ' comparison' : ''}`, current ? 'Current' : 'Comparison'));
        const title = this.#node('strong', 'local-library-study-description', text(study.description ?? study.studyDescription, 'Untitled examination'));
        const allSeries = seriesOf(study), modalities = Array.isArray(study.modalities) ? study.modalities : [...new Set(allSeries.map(series => series.modality).filter(Boolean))];
        const metadata = this.#node('p', 'local-library-study-metadata', `${modalities.join(' / ') || 'DICOM'} · ${plural(allSeries.length, 'series', 'series')} · ${plural(number(study.instanceCount), 'instance')}`);
        const source = this.#node('span', 'local-library-source', text(study.sourceLabel, 'Local files'));
        const actions = this.#node('div', 'local-library-study-actions');
        const chosen = this.#chosenSeries(study), canOpen = chosen && !['unsupported', 'unavailable', 'error'].includes(chosen.status);
        const open = this.#button(current ? 'Open current' : 'Set as current', 'open-study', 'local-library-button local-library-open-study', {studyId: String(study.id)}); open.disabled = Boolean(this.#state.busy) || !canOpen;
        open.setAttribute('aria-label', `Open ${text(study.description ?? study.studyDescription, 'examination')} dated ${dateLabel(study.studyDate)} as current`);
        const compare = this.#button(comparison ? 'Comparing' : 'Compare', 'compare-study', 'local-library-button local-library-compare', {studyId: String(study.id)});
        compare.disabled = Boolean(this.#state.busy) || !canOpen || !this.#state.currentStudyId || current || comparison || !studiesOf(patient).some(item => item.id === this.#state.currentStudyId);
        compare.title = !this.#state.currentStudyId ? 'Open a current examination first' : 'Display beside the current examination';
        compare.setAttribute('aria-label', `Compare ${text(study.description ?? study.studyDescription, 'examination')} dated ${dateLabel(study.studyDate)} with current examination`);
        actions.append(open, compare);
        const expanded = this.#expanded.has(study.id);
        const page = Math.min(this.#seriesPages.get(study.id) ?? 0, Math.max(0, Math.ceil(allSeries.length / SERIES_PER_PAGE) - 1)); this.#seriesPages.set(study.id, page);
        const visibleSeries = allSeries.slice(page * SERIES_PER_PAGE, (page + 1) * SERIES_PER_PAGE);
        const toggle = this.#button(`${expanded ? '−' : '+'} ${plural(allSeries.length, 'series', 'series')}`, 'toggle-study', 'local-library-series-toggle', {studyId: String(study.id)}); toggle.setAttribute('aria-expanded', String(expanded)); toggle.setAttribute('aria-label', `${expanded ? 'Hide' : 'Show'} series for ${text(study.description ?? study.studyDescription, 'examination')} dated ${dateLabel(study.studyDate)}`);
        card.append(line, title, metadata, source);
        const studyWarnings = this.#warnings(study.warnings); if (studyWarnings) card.append(studyWarnings);
        if (allSeries.length > 1) {
            const label = this.#node('label', 'local-library-series-choice', 'Series to open or compare'), select = this.#node('select', 'local-library-series-select');
            select.dataset.localStudySeries = String(study.id); select.setAttribute('aria-label', `Series for ${text(study.description ?? study.studyDescription, 'examination')} dated ${dateLabel(study.studyDate)}`); select.disabled = Boolean(this.#state.busy);
            const options = chosen && !visibleSeries.includes(chosen) ? [chosen, ...visibleSeries] : visibleSeries;
            for (const series of options) {
                const option = this.#node('option', null, `${series.seriesNumber != null ? `${series.seriesNumber} · ` : ''}${text(series.description ?? series.seriesDescription, 'Unnamed series')}${number(series.frameCount) ? ` · ${plural(number(series.frameCount), 'frame')}` : ''}`);
                option.value = String(series.id); option.disabled = ['unsupported', 'unavailable', 'error'].includes(series.status); select.append(option);
            }
            select.value = String(chosen?.id ?? ''); label.append(select); card.append(label);
        }
        card.append(actions, toggle);
        if (expanded) {
            const list = this.#node('div', 'local-library-series-list');
            for (const series of visibleSeries) {
                const selected = series.id === this.#state.selectedSeriesId, button = this.#button('', 'open-series', `local-library-series${selected ? ' selected' : ''}`, {studyId: String(study.id), seriesId: String(series.id)});
                button.disabled = Boolean(this.#state.busy) || ['unsupported', 'unavailable', 'error'].includes(series.status); button.setAttribute('aria-pressed', String(selected));
                button.append(this.#node('span', 'local-library-series-modality', text(series.modality, 'DCM')));
                const copy = this.#node('span', 'local-library-series-copy'); copy.append(this.#node('strong', null, `${text(series.description ?? series.seriesDescription, 'Unnamed series')}${series.variant ? ` · Variant ${series.variant}` : ''}`));
                const count = `${series.seriesNumber != null && series.seriesNumber !== '' ? `Series ${series.seriesNumber} · ` : ''}${plural(number(series.instanceCount), 'instance')}${number(series.frameCount) ? ` · ${plural(number(series.frameCount), 'frame')}` : ''}`;
                copy.append(this.#node('span', null, count), this.#node('small', 'local-library-series-status', statusLabel(series.status))); button.append(copy); list.append(button);
                const seriesWarnings = this.#warnings(series.warnings); if (seriesWarnings) list.append(seriesWarnings);
            }
            card.append(list);
        }
        if (allSeries.length > SERIES_PER_PAGE) {
            const pages = this.#node('nav', 'local-library-pagination'); pages.setAttribute('aria-label', `Series pages for ${text(study.description ?? study.studyDescription, 'examination')}`);
            const previous = this.#button('Previous', 'series-previous', 'local-library-button', {studyId: String(study.id)}), next = this.#button('Next', 'series-next', 'local-library-button', {studyId: String(study.id)});
            previous.disabled = page === 0; next.disabled = (page + 1) * SERIES_PER_PAGE >= allSeries.length;
            pages.append(previous, this.#node('span', 'local-library-page-status', `Series ${page * SERIES_PER_PAGE + 1}–${Math.min((page + 1) * SERIES_PER_PAGE, allSeries.length)} of ${allSeries.length.toLocaleString()}`), next); card.append(pages);
        }
        return card;
    }
    #renderStudies() {
        const patient = this.#selectedPatient(), studies = this.#studies(patient); this.#studyPage = Math.min(this.#studyPage, Math.max(0, Math.ceil(studies.length / STUDIES_PER_PAGE) - 1));
        this.#timeline.replaceChildren(); this.#timeline.hidden = !patient || this.#finding; this.#studyPaging.hidden = this.#timeline.hidden || studies.length <= STUDIES_PER_PAGE;
        if (patient) {
            const heading = this.#node('div', 'local-library-timeline-heading'); heading.append(this.#node('h4', null, 'Study timeline'), this.#node('span', null, plural(studies.length, 'study', 'studies'))); this.#timeline.append(heading);
            this.#timeline.append(this.#node('p', 'local-library-comparison-hint', this.#state.currentStudyId && studies.some(study => study.id === this.#state.currentStudyId) ? 'Choose Compare on another date. Spatial linking stays off.' : 'Set an examination as current, then compare another date.'));
            const visible = studies.slice(this.#studyPage * STUDIES_PER_PAGE, (this.#studyPage + 1) * STUDIES_PER_PAGE);
            for (const study of visible) this.#timeline.append(this.#renderStudy(study, patient));
            if (!visible.length) this.#timeline.append(this.#node('p', 'local-library-empty', 'No examinations are indexed for this patient.'));
            this.#studyStatus.textContent = `${this.#studyPage * STUDIES_PER_PAGE + (studies.length ? 1 : 0)}–${this.#studyPage * STUDIES_PER_PAGE + visible.length} of ${studies.length.toLocaleString()}`;
        }
        this.#previousStudy.disabled = this.#studyPage === 0; this.#nextStudy.disabled = (this.#studyPage + 1) * STUDIES_PER_PAGE >= studies.length;
    }
    #renderMessage() {
        const error = text(this.#state.error?.message ?? this.#state.error ?? this.#localError);
        const progress = this.#state.progress, total = number(progress?.total), processed = number(progress?.processed ?? progress?.completed);
        const outcome = this.#state.summary;
        const summary = typeof outcome === 'string' ? outcome : outcome && typeof outcome === 'object'
            ? `${plural(number(outcome.added), 'file')} indexed${number(outcome.duplicates) ? ` · ${plural(number(outcome.duplicates), 'duplicate')}` : ''}${number(outcome.failed) ? ` · ${plural(number(outcome.failed), 'file')} skipped` : ''}` : '';
        const indexing = this.#state.indexing === true;
        const readingMedia = progress?.phase === 'media';
        const operation = text(this.#state.operationLabel, 'Preparing selected images…');
        this.#message.textContent = error || (this.#state.busy ? indexing ? readingMedia ? 'Reading DICOMDIR media index…' : total ? `Indexing ${Math.min(processed, total).toLocaleString()} of ${total.toLocaleString()} files…` : 'Indexing local metadata…' : operation : summary);
        this.#message.hidden = !this.#message.textContent; this.#message.dataset.kind = error ? 'error' : 'status';
        const media = this.#state.media;
        this.#mediaMessage.hidden = !media || media.mode !== 'dicomdir';
        if (media?.mode === 'dicomdir') {
            const issues = ['missing', 'ambiguous', 'invalid', 'unsupported'].filter(key => number(media[key])).map(key => `${number(media[key]).toLocaleString()} ${key}`);
            this.#mediaMessage.textContent = `DICOMDIR · ${plural(number(media.resolved), 'referenced image')} located${issues.length ? ` · ${issues.join(' · ')}` : ''}. Only indexed references are added. ${Array.isArray(media.warnings) ? media.warnings.join(' ') : ''}`;
            this.#mediaMessage.dataset.kind = issues.length || media.warnings?.length ? 'warning' : 'status';
        } else this.#mediaMessage.textContent = '';
        const canCancel = Boolean(this.#state.busy) && typeof this.#callbacks.onCancelImport === 'function';
        this.#progress.parentNode.hidden = !indexing && !canCancel;
        this.#progress.hidden = !indexing;
        if (total) { this.#progress.max = total; this.#progress.value = Math.min(processed, total); }
        else this.#progress.removeAttribute?.('value');
        this.#cancel.hidden = !canCancel;
    }
    #render() {
        if (this.#disposed) return;
        const patient = this.#selectedPatient();
        this.#count.textContent = plural(this.#view.patients.length, 'patient');
        this.#importFiles.disabled = Boolean(this.#state.busy) || typeof this.#callbacks.onImportFiles !== 'function';
        this.#importFolder.disabled = Boolean(this.#state.busy) || typeof this.#callbacks.onImportFolder !== 'function';
        this.#clear.hidden = typeof this.#callbacks.onClearLocalLibrary !== 'function' || !this.#view.patients.length; this.#clear.disabled = Boolean(this.#state.busy);
        this.#clear.title = 'Clear the local catalog and its viewing session. Original files stay unchanged.';
        this.#finder.hidden = Boolean(patient) && !this.#finding;
        this.#intro.hidden = Boolean(patient) && !this.#finding;
        this.#patient.hidden = !patient || this.#finding; this.#patient.replaceChildren();
        if (patient) {
            const heading = this.#node('div', 'local-library-patient-heading'); heading.append(this.#node('span', 'local-library-eyebrow', 'Selected patient'));
            const change = this.#button('Change', 'change-patient', 'local-library-change'); change.setAttribute('aria-label', 'Change selected patient'); heading.append(change); this.#patient.append(heading);
            this.#patient.append(this.#node('strong', 'local-library-selected-name', nameOf(patient))); this.#demographics(patient, this.#patient);
        }
        this.#renderMessage(); if (!this.#finder.hidden) this.#renderPatients(); this.#renderStudies(); this.#renderAssociation();
    }
    setCatalog(view = {patients: []}, state = {}) {
        if (this.#disposed) return;
        if (!view || !Array.isArray(view.patients)) throw new TypeError('Supply a normalized local patient catalog.');
        const activeElement = this.#root.getRootNode?.()?.activeElement ?? this.#document.activeElement;
        const focused = activeElement?.dataset?.localAction ? {...activeElement.dataset} : null;
        this.#view = view; this.#state = state; this.#localError = '';
        if (state.activePatientId !== this.#activePatientId) { this.#activePatientId = state.activePatientId; this.#finding = false; this.#studyPage = 0; this.#expanded.clear(); this.#seriesPages.clear(); this.#selectedByStudy.clear(); this.#associationId = null; this.#associationConfirmed = false; }
        const roles = [state.currentStudyId, state.comparisonStudyId];
        for (let index = 0; index < roles.length; ++index) if (roles[index] && roles[index] !== this.#lastRoles[index]) this.#expanded.add(roles[index]);
        this.#lastRoles = roles; this.#render(); if (focused) this.#focusAction(focused);
    }
    getState() {
        return {findingPatient: this.#finding || !this.#selectedPatient(), patientCount: this.#view.patients.length, matchedPatientCount: this.#patientsMatching().length,
            patientPage: this.#patientPage, studyPage: this.#studyPage, expandedStudyCount: this.#expanded.size, disposed: this.#disposed};
    }
    dispose() {
        if (this.#disposed) return;
        this.#disposed = true; this.#lifetime.abort(); this.#view = {patients: []}; this.#state = {}; this.#expanded.clear(); this.#seriesPages.clear(); this.#selectedByStudy.clear(); this.#callbacks = {};
        this.#root.replaceChildren(); this.#root = null; this.#document = null;
    }
}
