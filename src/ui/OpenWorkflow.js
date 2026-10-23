const PAGE_SIZE = 25;
let nextId = 0;
const string = value => value == null ? '' : String(value);
const list = value => Array.isArray(value) ? value : [];
const key = value => string(value?.id ?? value?.studyUid);
const selectable = study => Boolean(key(study)) && !['unsupported', 'unavailable', 'error'].includes(study?.status) && study?.available !== false && study?.disabled !== true;
const patientName = patient => string(patient?.patientName ?? patient?.name).replaceAll('^', ' ').trim() || 'Unnamed patient';
const date = value => /^\d{8}$/.test(string(value)) ? `${string(value).slice(0, 4)}-${string(value).slice(4, 6)}-${string(value).slice(6, 8)}` : string(value) || 'Date not supplied';
const count = (value, singular, plural = `${singular}s`) => `${value.toLocaleString()} ${value === 1 ? singular : plural}`;
const abortError = () => new DOMException('Opening canceled.', 'AbortError');
const DEFAULT_FIELDS = ['patientId', 'patientName', 'patientBirthDate', 'issuerOfPatientId', 'accessionNumber', 'studyDate', 'modality'];
const TESTS = [
    {id: 'ct', name: 'CT stack', modality: 'CT', description: 'Navigate slices and compare window settings.'},
    {id: 'mr', name: 'MR image', modality: 'MR', description: 'Explore image contrast and measurement tools.'},
    {id: 'xr', name: 'Chest radiograph', modality: 'XR', description: 'Try zoom, pan and image inspection.'},
    {id: 'us', name: 'Ultrasound cine', modality: 'US', description: 'Navigate frames and play a synthetic clip.'}
];

/** A staged, source-independent opening dialog. Only explicit Add actions change the viewing session. */
export class OpenWorkflow {
    #root; #document; #callbacks; #dialog; #body; #footer; #title; #subtitle; #steps; #notice; #status; #closeButton;
    #stage; #content; #progress; #progressLabel; #cancelButton; #adding = false; #blocking = false;
    #selectAll = null; #selectionCount = null; #clearSelection = null;
    #lifetime = new AbortController(); #operation = null; #generation = 0; #disposed = false; #returnFocus = null;
    #state = this.#emptyState();

    constructor(root, callbacks = {}) {
        if (!root?.ownerDocument?.createElement || typeof root.append !== 'function') throw new TypeError('Mount the opening workflow in a DOM element.');
        this.#root = root; this.#document = root.ownerDocument; this.#callbacks = callbacks; this.#mount();
    }
    #emptyState() {
        return {open: false, step: 'choose', intent: null, sourceId: null, filters: {}, preview: null, patient: null,
            patients: [], studies: [], patientPage: null, studyPage: null, patientOffset: 0, studyOffset: 0,
            selected: new Map(), error: '', warnings: [], busy: false, status: '', includeSubfolders: true};
    }
    #node(tag, className, text) {
        const node = this.#document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node;
    }
    #button(text, action, data = {}, className = 'open-workflow-button') {
        const button = this.#node('button', className, text); button.type = 'button'; button.dataset.openAction = action; Object.assign(button.dataset, data); return button;
    }
    #policy() {
        const policy = this.#callbacks.getPolicy?.() ?? {};
        return {allowLocalImages: policy.localImages !== false && policy.allowLocalImages !== false, allowLocalStudies: policy.localStudies !== false && policy.allowLocalStudies !== false,
            allowRemote: policy.remoteStudies !== false && policy.allowRemote !== false, allowTests: policy.tests !== false && policy.allowTests !== false && policy.demos !== false, allowSourceEditing: policy.sourceEditing === true || policy.allowSourceEditing === true};
    }
    #sources() { return list(this.#callbacks.getSources?.()); }
    #source() { return this.#sources().find(source => string(source.id) === string(this.#state.sourceId)); }
    #fields() { return list(this.#source()?.capabilities?.searchFields ?? DEFAULT_FIELDS); }
    #mount() {
        const id = `easi-open-${++nextId}`;
        this.#dialog = this.#node('dialog', 'open-workflow'); this.#dialog.setAttribute('aria-labelledby', `${id}-title`); this.#dialog.setAttribute('aria-describedby', `${id}-subtitle`);
        const header = this.#node('header', 'open-workflow-header'), heading = this.#node('div');
        const eyebrow = this.#node('span', 'open-workflow-eyebrow', 'YOUR VIEWING SESSION');
        this.#title = this.#node('h2', 'open-workflow-title'); this.#title.id = `${id}-title`; this.#title.tabIndex = -1;
        this.#subtitle = this.#node('p', 'open-workflow-subtitle'); this.#subtitle.id = `${id}-subtitle`;
        heading.append(eyebrow, this.#title, this.#subtitle); this.#closeButton = this.#button('×', 'close', {}, 'open-workflow-close'); this.#closeButton.setAttribute('aria-label', 'Cancel opening and return to viewer'); header.append(heading, this.#closeButton);
        this.#steps = this.#node('nav', 'open-workflow-steps'); this.#steps.setAttribute('aria-label', 'Opening progress');
        this.#notice = this.#node('div', 'open-workflow-error'); this.#notice.setAttribute('role', 'alert'); this.#notice.hidden = true;
        this.#status = this.#node('p', 'open-workflow-status'); this.#status.setAttribute('role', 'status'); this.#status.setAttribute('aria-live', 'polite');
        this.#body = this.#node('div', 'open-workflow-body'); this.#footer = this.#node('footer', 'open-workflow-footer');
        this.#stage = this.#node('div', 'open-workflow-stage'); this.#content = this.#node('div', 'open-workflow-content');
        this.#content.append(this.#steps, this.#notice, this.#status, this.#body);
        this.#progress = this.#node('div', 'open-workflow-progress'); this.#progress.hidden = true;
        this.#progress.setAttribute('role', 'status'); this.#progress.setAttribute('aria-live', 'polite'); this.#progress.setAttribute('aria-atomic', 'true');
        const progressCard = this.#node('div', 'open-workflow-progress-card'), spinner = this.#node('span', 'open-workflow-spinner'); spinner.setAttribute('aria-hidden', 'true');
        this.#progressLabel = this.#node('strong', 'open-workflow-progress-label'); this.#progressLabel.id = `${id}-progress`;
        progressCard.append(spinner, this.#progressLabel, this.#node('span', 'open-workflow-progress-hint', 'Please wait while this step completes. You can cancel this operation.'));
        this.#progress.append(progressCard); this.#stage.append(this.#content, this.#progress);
        this.#dialog.append(header, this.#stage, this.#footer); this.#root.append(this.#dialog);
        const signal = this.#lifetime.signal;
        this.#dialog.addEventListener('click', event => {
            let target = event.target;
            while (target && target !== this.#dialog) {
                if (target.dataset?.openAction) { if (!target.disabled) this.#action(target.dataset.openAction, target.dataset); return; }
                target = target.parentNode;
            }
        }, {signal});
        this.#dialog.addEventListener('change', event => this.#change(event.target), {signal});
        this.#dialog.addEventListener('input', event => { if (event.target?.dataset?.openFilter) this.#state.filters[event.target.dataset.openFilter] = event.target.value; }, {signal});
        this.#dialog.addEventListener('submit', event => { event.preventDefault(); if (event.target.dataset?.openForm === 'criteria') this.#searchRemote(); if (event.target.dataset?.openForm === 'configure') this.#configureSource(event.target); }, {signal});
        this.#dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); }, {signal});
        this.#dialog.addEventListener('close', () => { if (this.#state.open && !this.#dialog.open) this.close(); }, {signal});
    }
    #assertActive() { if (this.#disposed) throw new Error('This opening workflow has been disposed.'); }
    #cancelOperation() { this.#generation++; this.#operation?.abort(); this.#operation = null; this.#state.busy = false; this.#state.status = ''; this.#adding = false; this.#blocking = false; this.#renderProgress(); }
    #navigate(step, {clear = false} = {}) {
        this.#cancelOperation(); this.#state.step = step; this.#state.error = ''; this.#state.warnings = [];
        if (clear) { this.#state.selected.clear(); this.#state.patient = null; this.#state.patientOffset = 0; this.#state.studyOffset = 0; }
        this.#render(); this.#title.focus();
    }
    #showError(error) {
        this.#state.error = string(error?.message || error || 'This action could not finish.'); this.#renderMessages();
    }
    #paintBeforeWork(signal) {
        const view = this.#document.defaultView;
        if (typeof view?.requestAnimationFrame !== 'function') return null;
        return new Promise((resolve, reject) => {
            let frame, timer, finished = false;
            const finish = error => {
                if (finished) return; finished = true;
                view.cancelAnimationFrame?.(frame); view.clearTimeout(timer); signal.removeEventListener('abort', cancel);
                if (error) reject(error); else resolve();
            };
            const cancel = () => finish(abortError());
            signal.addEventListener('abort', cancel, {once: true});
            // A first frame paints the busy state; work starts on the following
            // frame. The timeout also bounds this yield in a background tab.
            timer = view.setTimeout(() => finish(), 200);
            frame = view.requestAnimationFrame(() => { frame = view.requestAnimationFrame(() => finish()); });
            if (signal.aborted) cancel();
        });
    }
    async #run(message, operation, complete, {adding = false} = {}) {
        this.#cancelOperation(); const generation = this.#generation, controller = new AbortController(); this.#operation = controller;
        this.#state.busy = true; this.#state.error = ''; this.#state.status = message; this.#adding = adding; this.#blocking = true; this.#render();
        this.#cancelButton.focus({preventScroll: true}); this.#dialog.scrollTop = 0;
        try {
            const paint = this.#paintBeforeWork(controller.signal); if (paint) await paint;
            if (this.#disposed || !this.#state.open || generation !== this.#generation || controller.signal.aborted) throw abortError();
            const result = await operation(controller.signal);
            if (this.#disposed || !this.#state.open || generation !== this.#generation || controller.signal.aborted) throw abortError();
            this.#state.busy = false; this.#state.status = ''; this.#operation = null; this.#adding = false; this.#blocking = false; complete(result); this.#render();
        } catch (error) {
            if (this.#disposed || !this.#state.open || generation !== this.#generation || controller.signal.aborted) return;
            this.#state.busy = false; this.#state.status = ''; this.#operation = null; this.#adding = false; this.#blocking = false;
            if (error?.name === 'AbortError') this.#state.status = 'Operation canceled. You can try again.'; else this.#showError(error);
            this.#render();
            this.#title.focus();
        }
    }
    open(path = 'choose') {
        this.#assertActive(); const returnFocus = this.#state.open ? this.#returnFocus : this.#document.activeElement;
        this.#cancelOperation(); this.#callbacks.onClose?.(); this.#returnFocus = returnFocus;
        this.#state = this.#emptyState(); this.#state.open = true;
        const policy = this.#policy();
        if (path === 'images' && policy.allowLocalImages) { this.#state.step = 'images'; this.#state.intent = 'images'; }
        else if (['study', 'studies'].includes(path) && (policy.allowLocalStudies || policy.allowRemote)) { this.#state.step = 'study'; this.#state.intent = 'study'; }
        else if (['test', 'tests'].includes(path) && policy.allowTests) this.#state.step = 'test';
        this.#render();
        if (!this.#dialog.open) { if (typeof this.#dialog.showModal === 'function') this.#dialog.showModal(); else { this.#dialog.open = true; this.#dialog.setAttribute('open', ''); } }
        this.#title.focus(); return this.getState();
    }
    close() {
        if (this.#disposed || !this.#state.open) return;
        this.#cancelOperation(); this.#state = this.#emptyState();
        if (this.#dialog.open && typeof this.#dialog.close === 'function') this.#dialog.close(); else { this.#dialog.open = false; this.#dialog.removeAttribute('open'); }
        this.#body.replaceChildren(); this.#footer.replaceChildren(); this.#callbacks.onClose?.(); this.#returnFocus?.focus?.(); this.#returnFocus = null;
    }
    acceptFiles(files, {intent = this.#state.intent ?? 'images'} = {}) {
        this.#assertActive(); const selection = Array.from(files ?? []);
        if (!selection.length) return Promise.resolve();
        if (!['images', 'study'].includes(intent)) return Promise.reject(new TypeError('Choose images or a local study.'));
        const policy = this.#policy(); if (!(intent === 'images' ? policy.allowLocalImages : policy.allowLocalStudies)) return Promise.reject(new Error('This opening option is disabled by the application.'));
        if (!this.#state.open) this.open(intent);
        this.#state.intent = intent; this.#state.step = intent === 'images' ? 'images' : 'study';
        return this.#run(intent === 'study' ? 'Preparing local studies…' : 'Reading local files…', signal => {
            if (!this.#callbacks.onPreviewLocal) throw new Error('Local image opening is unavailable.');
            return this.#callbacks.onPreviewLocal(selection, {intent, includeSubfolders: this.#state.includeSubfolders, signal});
        }, preview => {
            if (!preview || !list(preview.patients).length) throw new Error(intent === 'study' ? 'No indexed patient studies were found. Choose the media folder containing DICOMDIR, or use Open Images to scan a folder.' : 'No readable DICOM images were found in the selected files.');
            this.#state.preview = preview; this.#state.patients = preview.patients; this.#state.warnings = list(preview.warnings); this.#state.patient = null; this.#state.selected.clear();
            if (intent === 'images') {
                for (const patient of preview.patients) for (const study of list(patient.studies)) this.#state.selected.set(key(study), {patientId: patient.id, study});
                this.#state.step = 'local-images';
            } else if (preview.patients.length === 1) {
                this.#state.patient = preview.patients[0]; this.#state.studies = list(preview.patients[0].studies); this.#state.step = 'local-studies';
            } else this.#state.step = 'local-patients';
            this.#title.focus();
        });
    }
    #pick(kind, intent) {
        if (this.#state.busy) return;
        this.#state.intent = intent;
        try {
            const callback = this.#callbacks[kind === 'files' ? 'onPickFiles' : 'onPickFolder'];
            if (!callback) throw new Error('The local file picker is unavailable.');
            const generation = this.#generation, result = callback(intent, {includeSubfolders: this.#state.includeSubfolders});
            if (result?.then) result.then(files => { if (files?.length && this.#state.open && generation === this.#generation) this.acceptFiles(files, {intent}); }).catch(error => { if (!this.#disposed && this.#state.open && generation === this.#generation) this.#showError(error); });
            else if (result?.length) this.acceptFiles(result, {intent});
        } catch (error) { this.#showError(error); }
    }
    #change(target) {
        if (this.#state.busy) return;
        if (target?.dataset?.openSelectAll != null && ['local-studies', 'studies'].includes(this.#state.step)) {
            for (const study of this.#selectionScope()) {
                if (target.checked) this.#state.selected.set(key(study), {patientId: this.#state.patient?.id, study});
                else this.#state.selected.delete(key(study));
            }
            this.#updateStudySelection(); this.#renderFooter(); return;
        }
        if (target?.dataset?.openStudy != null) {
            const id = target.dataset.openStudy, study = this.#state.studies.find(study => key(study) === id);
            if (study && selectable(study)) { if (target.checked) this.#state.selected.set(id, {patientId: this.#state.patient?.id, study}); else this.#state.selected.delete(id); this.#updateStudySelection(); this.#renderFooter(); }
        }
        if (target?.dataset?.openSubfolders != null) this.#state.includeSubfolders = Boolean(target.checked);
        if (target?.dataset?.openFilter) this.#state.filters[target.dataset.openFilter] = target.value;
    }
    #action(action, data) {
        if (action === 'close') { this.close(); return; }
        if (this.#state.busy) return;
        const policy = this.#policy();
        if (action === 'back') this.#back();
        else if (action === 'images' && policy.allowLocalImages) { this.#state.intent = 'images'; this.#navigate('images', {clear: true}); }
        else if (action === 'study' && (policy.allowLocalStudies || policy.allowRemote)) { this.#state.intent = 'study'; this.#navigate('study', {clear: true}); }
        else if (action === 'test' && policy.allowTests) this.#navigate('test', {clear: true});
        else if (action === 'pick-files' && policy.allowLocalImages) this.#pick('files', 'images');
        else if (action === 'pick-images-folder' && policy.allowLocalImages) this.#pick('folder', 'images');
        else if (action === 'pick-study-folder' && policy.allowLocalStudies) this.#pick('folder', 'study');
        else if (action === 'remote' && policy.allowRemote) this.#navigate('sources', {clear: true});
        else if (action === 'source') { this.#state.sourceId = data.sourceId; this.#state.filters = {}; this.#navigate('criteria', {clear: true}); }
        else if (action === 'search') this.#searchRemote();
        else if (action === 'patient') this.#choosePatient(data.patientId);
        else if (action === 'patients-next') this.#searchRemote(this.#state.patientPage?.nextOffset ?? this.#state.patientOffset + PAGE_SIZE);
        else if (action === 'patients-previous') this.#searchRemote(Math.max(0, this.#state.patientOffset - PAGE_SIZE));
        else if (action === 'local-patients-next') { this.#state.patientOffset += PAGE_SIZE; this.#render(); }
        else if (action === 'local-patients-previous') { this.#state.patientOffset = Math.max(0, this.#state.patientOffset - PAGE_SIZE); this.#render(); }
        else if (action === 'studies-next') this.#studyPage(this.#state.studyPage?.nextOffset ?? this.#state.studyOffset + PAGE_SIZE);
        else if (action === 'studies-previous') this.#studyPage(Math.max(0, this.#state.studyOffset - PAGE_SIZE));
        else if (action === 'clear-studies' && ['local-studies', 'studies'].includes(this.#state.step)) {
            for (const [id, selected] of this.#state.selected) if (string(selected.patientId) === string(this.#state.patient?.id)) this.#state.selected.delete(id);
            this.#updateStudySelection(); this.#renderFooter();
        }
        else if (action === 'add') this.#commit();
        else if (action === 'open-test' && policy.allowTests && TESTS.some(test => test.id === data.testId)) this.#run('Opening synthetic test images…', signal => { if (!this.#callbacks.onOpenTest) throw new Error('Synthetic test images are unavailable.'); return this.#callbacks.onOpenTest(data.testId, {signal}); }, () => this.close(), {adding: true});
        else if (action === 'scan-images' && policy.allowLocalImages) { this.#state.intent = 'images'; this.#navigate('images', {clear: true}); }
    }
    #back() {
        const step = this.#state.step;
        if (['images', 'study', 'test'].includes(step)) this.#navigate('choose');
        else if (step === 'sources') this.#navigate('study');
        else if (step === 'criteria') this.#navigate('sources');
        else if (step === 'patients') this.#navigate('criteria');
        else if (step === 'studies') this.#navigate('patients', {clear: true});
        else if (step === 'local-studies' && this.#state.patients.length > 1) this.#navigate('local-patients', {clear: true});
        else this.#navigate(this.#state.intent === 'images' ? 'images' : 'study', {clear: true});
    }
    #searchRemote(offset = 0) {
        if (this.#state.busy || !this.#source()) return;
        const fields = this.#fields(), filters = Object.fromEntries(Object.entries(this.#state.filters).filter(([field, value]) => fields.includes(field) && string(value).trim()).map(([field, value]) => [field, ['patientBirthDate', 'studyDate'].includes(field) ? string(value).replaceAll('-', '') : string(value).trim()]));
        if (!['patientId', 'patientName', 'patientBirthDate', 'accessionNumber'].some(field => filters[field])) { this.#showError(new Error('Enter a patient ID, patient name, birth date or accession number before searching.')); return; }
        this.#state.filters = {...this.#state.filters};
        return this.#run('Finding matching patients…', signal => {
            if (!this.#callbacks.onSearchRemote) throw new Error('Remote patient search is unavailable.');
            return this.#callbacks.onSearchRemote(this.#state.sourceId, filters, {offset, limit: PAGE_SIZE}, {signal});
        }, page => {
            this.#state.patients = list(page?.items); this.#state.patientPage = page; this.#state.patientOffset = offset;
            this.#state.patient = null; this.#state.selected.clear(); this.#state.warnings = list(page?.warnings); this.#state.step = 'patients'; this.#title.focus();
        });
    }
    #choosePatient(id) {
        const patient = this.#state.patients.find(patient => string(patient.id) === id); if (!patient) return;
        this.#state.patient = patient; this.#state.selected.clear(); this.#state.studyOffset = 0;
        if (this.#state.step === 'local-patients') { this.#state.studies = list(patient.studies); this.#navigate('local-studies'); }
        else this.#studyPage(0);
    }
    #studyPage(offset) {
        if (this.#state.step === 'local-studies') { this.#state.studyOffset = offset; this.#render(); return; }
        const patient = this.#state.patient; if (!patient) return;
        return this.#run('Finding this patient’s studies…', signal => {
            if (!this.#callbacks.onListRemoteStudies) throw new Error('Remote study browsing is unavailable.');
            return this.#callbacks.onListRemoteStudies(this.#state.sourceId, patient, {offset, limit: PAGE_SIZE}, {signal});
        }, page => {
            this.#state.studies = list(page?.items); this.#state.studyPage = page; this.#state.studyOffset = offset; this.#state.warnings = [...list(patient.warnings), ...list(page?.warnings)]; this.#state.step = 'studies'; this.#title.focus();
        });
    }
    #commit() {
        if (!this.#state.selected.size) return;
        const selected = [...this.#state.selected.values()], studyIds = [...this.#state.selected.keys()];
        if (this.#state.step === 'studies') return this.#run('Adding selected studies…', signal => {
            if (!this.#callbacks.onCommitRemote) throw new Error('Adding remote studies is unavailable.');
            return this.#callbacks.onCommitRemote(this.#state.sourceId, this.#state.patient, selected.map(item => item.study), {signal});
        }, () => this.close(), {adding: true});
        const selection = [...new Set(selected.map(item => item.patientId))].map(patientId => ({patientId, studyIds: selected.filter(item => item.patientId === patientId).map(item => key(item.study))}));
        return this.#run(this.#state.step === 'local-studies' ? 'Adding selected studies…' : 'Adding selected images…', signal => {
            if (!this.#callbacks.onCommitLocal) throw new Error('Adding local images is unavailable.');
            return this.#callbacks.onCommitLocal(this.#state.preview, {intent: this.#state.intent, patientId: this.#state.patient?.id ?? null, studyIds, selection, signal});
        }, () => this.close(), {adding: true});
    }
    #configureSource(form) {
        if (!this.#policy().allowSourceEditing || this.#state.busy) return;
        const get = name => string(form.querySelector?.(`[name="${name}"]`)?.value).trim();
        const configuration = {name: get('sourceName'), type: get('sourceType'), baseUrl: get('sourceUrl')};
        if (!configuration.name || !configuration.baseUrl) { this.#showError(new Error('Enter a repository name and address.')); return; }
        return this.#run('Saving repository settings…', signal => {
            if (!this.#callbacks.onConfigureSource) throw new Error('Repository settings are managed by this application.');
            return this.#callbacks.onConfigureSource(configuration, {signal});
        }, source => { this.#state.sourceId = source?.id ?? source?.sourceId ?? source; this.#state.step = this.#source() ? 'criteria' : 'sources'; });
    }
    #card(title, description, action, data = {}, badge = '') {
        const card = this.#button('', action, data, 'open-workflow-card');
        if (badge) card.append(this.#node('span', 'open-workflow-card-badge', badge));
        const copy = this.#node('span', 'open-workflow-card-copy'); copy.append(this.#node('strong', null, title), this.#node('span', null, description));
        card.append(copy, this.#node('span', 'open-workflow-card-arrow', '→')); return card;
    }
    #render() {
        if (this.#disposed || !this.#state.open) return;
        const {step} = this.#state, policy = this.#policy(); this.#body.replaceChildren(); this.#selectAll = null; this.#selectionCount = null; this.#clearSelection = null;
        const titles = {choose: ['Open…', 'Choose what to add. Your current viewing session stays available.'], images: ['Open Images', 'View only the local files or folder contents you select.'], study: ['Open Study', 'Find patient examinations on local media or in a configured archive.'], test: ['Open Test Images', 'Generated examples open in a separate, clearly marked test workspace.'], sources: ['Select remote storage', 'Choose the repository you want to search.'], criteria: ['Find a patient', 'Search this repository using the identifiers you know.'], patients: ['Choose a patient', 'Review identifiers before selecting a patient.'], 'local-patients': ['Choose a patient', 'These patients were found on the selected local media.'], studies: ['Choose studies', 'Select examinations to add. Image data loads when you view a series.'], 'local-studies': ['Choose studies', 'Select local examinations to add to the session.'], 'local-images': ['Review selected images', 'The selected files will be organized into patient workspaces, studies and series.']};
        const title = titles[step] ?? titles.choose; this.#title.textContent = title[0]; this.#subtitle.textContent = title[1]; this.#renderSteps();
        if (step === 'choose') {
            const cards = this.#node('div', 'open-workflow-cards');
            if (policy.allowLocalImages) cards.append(this.#card('Open Images', 'View selected files or a folder on this device.', 'images', {}, '01'));
            if (policy.allowLocalStudies || policy.allowRemote) cards.append(this.#card('Open Study', 'Choose patient studies from media or an archive.', 'study', {}, '02'));
            if (policy.allowTests) cards.append(this.#card('Open Test Images', 'Try the viewer with synthetic examples.', 'test', {}, '03'));
            this.#body.append(cards, this.#note('Added studies appear in the Session Library. Opening new images does not replace an existing patient workspace.'));
        } else if (step === 'images') {
            const cards = this.#node('div', 'open-workflow-cards'); cards.append(this.#card('From local files', 'Select one or more DICOM files, with or without a file extension.', 'pick-files'), this.#card('From a local folder', 'Scan only the folder you choose. Related files elsewhere are not added.', 'pick-images-folder')); this.#body.append(cards);
            const label = this.#node('label', 'open-workflow-checkbox'), input = this.#node('input'); input.type = 'checkbox'; input.checked = this.#state.includeSubfolders; input.dataset.openSubfolders = ''; label.append(input, this.#node('span', null, 'Include subfolders when opening a folder')); this.#body.append(label, this.#note('Local images are read on this device. Nothing is uploaded.'));
        } else if (step === 'study') {
            const cards = this.#node('div', 'open-workflow-cards');
            if (policy.allowLocalStudies) cards.append(this.#card('From local storage', 'Choose the media folder containing DICOMDIR and its image folders.', 'pick-study-folder', {}, 'LOCAL'));
            if (policy.allowRemote) cards.append(this.#card('From remote storage', 'Find a patient in a configured archive, then select their studies.', 'remote', {}, 'REMOTE'));
            this.#body.append(cards); if (policy.allowLocalImages) this.#body.append(this.#note('No DICOMDIR? Use Open Images to scan the selected folder.'), this.#button('Open Images instead', 'scan-images', {}, 'open-workflow-text-button'));
        } else if (step === 'test') {
            const grid = this.#node('div', 'open-workflow-test-grid'); for (const test of TESTS) grid.append(this.#card(test.name, test.description, 'open-test', {testId: test.id}, test.modality)); this.#body.append(grid, this.#note('Synthetic images are visibly labeled and kept separate from patient examinations.'));
        } else if (step === 'sources') this.#renderSources();
        else if (step === 'criteria') this.#renderCriteria();
        else if (['patients', 'local-patients'].includes(step)) this.#renderPatients();
        else if (['studies', 'local-studies'].includes(step)) this.#renderStudies();
        else if (step === 'local-images') this.#renderLocalImages();
        this.#renderWarnings(); this.#renderMessages(); this.#renderFooter();
        if (this.#state.busy) for (const input of this.#body.querySelectorAll?.('button,input,select,textarea') ?? []) input.disabled = true;
    }
    #renderSteps() {
        this.#steps.replaceChildren(); const {step, intent} = this.#state;
        if (['choose', 'images', 'study', 'test'].includes(step)) { this.#steps.hidden = true; return; }
        this.#steps.hidden = false;
        const remote = ['sources', 'criteria', 'patients', 'studies'].includes(step), labels = remote ? ['Storage', 'Patient criteria', 'Patient', 'Studies'] : intent === 'images' ? ['Select images', 'Review & add'] : ['Select media', 'Patient', 'Studies'];
        const current = remote ? ['sources', 'criteria', 'patients', 'studies'].indexOf(step) : intent === 'images' ? 1 : step === 'local-patients' ? 1 : 2;
        labels.forEach((label, index) => { const item = this.#node('span', `open-workflow-step${index === current ? ' current' : ''}`, `Step ${index + 1}: ${label}`); if (index === current) item.setAttribute('aria-current', 'step'); this.#steps.append(item); });
    }
    #renderMessages() {
        this.#notice.textContent = this.#state.error; this.#notice.hidden = !this.#state.error; this.#status.textContent = this.#state.status; this.#status.hidden = !this.#state.status || this.#blocking; this.#dialog.setAttribute('aria-busy', string(this.#state.busy)); this.#renderProgress();
    }
    #renderProgress() {
        const blocking = this.#blocking && this.#state.open && this.#state.busy;
        this.#stage.dataset.adding = string(this.#adding && blocking); this.#stage.dataset.busy = string(blocking); this.#content.inert = blocking; this.#progress.hidden = !blocking;
        this.#progressLabel.textContent = blocking ? this.#state.status : '';
        this.#dialog.setAttribute('aria-busy', string(this.#state.busy));
    }
    #note(text) { return this.#node('p', 'open-workflow-note', text); }
    #renderSources() {
        const sources = this.#sources(), cards = this.#node('div', 'open-workflow-cards');
        for (const source of sources) cards.append(this.#card(source.name || source.label || 'Configured repository', source.description || (source.type === 'dimse' ? 'Connected through a configured image gateway.' : 'Search patient studies in this archive.'), 'source', {sourceId: string(source.id)}, source.type === 'dimse' ? 'DIMSE' : 'DICOMweb'));
        this.#body.append(cards);
        if (!sources.length) this.#body.append(this.#note('No remote repositories are configured. Your application administrator can provide a connection.'));
        if (this.#policy().allowSourceEditing && this.#callbacks.onConfigureSource) {
            const details = this.#node('details', 'open-workflow-settings'); details.append(this.#node('summary', null, 'Connection settings'));
            const form = this.#node('form', 'open-workflow-form'); form.dataset.openForm = 'configure';
            this.#field(form, 'Repository name', 'sourceName', 'text', '', 'For example: Research archive');
            const label = this.#node('label', 'open-workflow-field', 'Connection type'), select = this.#node('select'); select.name = 'sourceType';
            for (const [value, text] of [['dicomweb', 'DICOMweb'], ['dimse', 'DIMSE via HTTP gateway']]) { const option = this.#node('option', null, text); option.value = value; select.append(option); } label.append(select); form.append(label);
            this.#field(form, 'Repository address', 'sourceUrl', 'url', '', 'https://archive.example/dicom-web');
            form.append(this.#note('Connections are held for this viewing session. Authentication can be supplied by the embedding application.'));
            const submit = this.#node('button', 'open-workflow-button', 'Add repository'); submit.type = 'submit'; form.append(submit); details.append(form); this.#body.append(details);
        }
    }
    #field(root, labelText, name, type, value = '', placeholder = '', filter = false) {
        const label = this.#node('label', 'open-workflow-field', labelText), input = this.#node('input'); input.name = name; input.type = type; input.value = string(value); input.maxLength = 256; input.autocomplete = 'off'; input.setAttribute('spellcheck', 'false'); if (placeholder) input.placeholder = placeholder;
        if (filter) input.dataset.openFilter = name; label.append(input); root.append(label); return input;
    }
    #renderCriteria() {
        const source = this.#source(); this.#body.append(this.#node('div', 'open-workflow-source-label', source?.name || 'Selected repository'));
        const form = this.#node('form', 'open-workflow-form'); form.dataset.openForm = 'criteria'; const primary = this.#node('div', 'open-workflow-field-grid'), fields = this.#fields();
        for (const [name, label, type, placeholder] of [['patientId', 'Patient ID / MRN', 'text', 'Identifier in this repository'], ['patientName', 'Patient name', 'text', 'Family name or known name'], ['patientBirthDate', 'Birth date', 'date', '']]) if (fields.includes(name)) this.#field(primary, label, name, type, ['patientBirthDate'].includes(name) ? string(this.#state.filters[name]).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : this.#state.filters[name], placeholder, true);
        form.append(primary);
        const secondaryFields = [['issuerOfPatientId', 'Patient ID issuer', 'text'], ['accessionNumber', 'Accession number', 'text'], ['studyDate', 'Study date', 'date'], ['modality', 'Modality', 'text']].filter(([name]) => fields.includes(name));
        if (secondaryFields.length) {
            const details = this.#node('details', 'open-workflow-additional'); details.append(this.#node('summary', null, 'Additional criteria')); const grid = this.#node('div', 'open-workflow-field-grid');
            for (const [name, label, type] of secondaryFields) this.#field(grid, label, name, type, name === 'studyDate' ? string(this.#state.filters[name]).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : this.#state.filters[name], name === 'modality' ? 'CT, MR, US…' : '', true);
            details.append(grid); form.append(details);
        }
        const submit = this.#node('button', 'open-workflow-button open-workflow-primary', 'Find patients'); submit.type = 'submit'; form.append(submit); this.#body.append(form, this.#note('Searching does not add images. The next step lets you review matching patients and choose their examinations.'));
    }
    #demographics(patient, root) {
        root.append(this.#node('span', 'open-workflow-patient-id', `ID ${string(patient.patientId) || 'not supplied'}${patient.issuerOfPatientId ? ` · ${patient.issuerOfPatientId}` : ''}`), this.#node('span', 'open-workflow-patient-birth', `Born ${date(patient.patientBirthDate ?? patient.birthDate)}`));
    }
    #renderPatients() {
        const local = this.#state.step === 'local-patients', patients = local ? this.#state.patients.slice(this.#state.patientOffset, this.#state.patientOffset + PAGE_SIZE) : this.#state.patients;
        if (!patients.length) this.#body.append(this.#note('No patients matched. Go back to adjust the search criteria.'));
        const cards = this.#node('div', 'open-workflow-patients');
        for (const patient of patients) { const card = this.#button('', 'patient', {patientId: string(patient.id)}, 'open-workflow-patient-card'); card.append(this.#node('strong', null, patientName(patient))); this.#demographics(patient, card); if (patient.identityStatus === 'study-scoped') card.append(this.#note('Identifier incomplete · only the discovered examinations are available.')); if (patient.identityStatus === 'demographics-conflict') card.append(this.#note('Patient identity needs review · matching records remain separate.')); cards.append(card); }
        this.#body.append(cards);
        if (!local) this.#body.append(this.#note(`${count(patients.length, 'matching patient')} on this result page. Further pages may include more records for the same patient.`));
        this.#pagination('patients', this.#state.patientOffset, local ? this.#state.patientOffset + PAGE_SIZE < this.#state.patients.length : this.#hasNext(this.#state.patientPage), local);
    }
    #renderStudies() {
        const local = this.#state.step === 'local-studies', patient = this.#state.patient, person = this.#node('div', 'open-workflow-selected-patient'); person.append(this.#node('strong', null, patientName(patient))); this.#demographics(patient, person); this.#body.append(person);
        // An explicit page refresh can make an earlier selection unavailable.
        // Reconcile only these known rows; never fetch or infer unseen pages.
        for (const study of this.#state.studies) if (this.#state.selected.has(key(study))) {
            if (!selectable(study)) this.#state.selected.delete(key(study));
            else this.#state.selected.set(key(study), {patientId: patient?.id, study});
        }
        const studies = local ? this.#state.studies.slice(this.#state.studyOffset, this.#state.studyOffset + PAGE_SIZE) : this.#state.studies;
        const selection = this.#node('div', 'open-workflow-study-selection'), label = this.#node('label', 'open-workflow-select-all');
        this.#selectAll = this.#node('input'); this.#selectAll.type = 'checkbox'; this.#selectAll.dataset.openSelectAll = '';
        label.append(this.#selectAll, this.#node('span', null, local ? `Select all ${count(this.#selectionScope().length, 'study', 'studies')} for this patient` : 'Select all studies on this page'));
        this.#selectionCount = this.#node('p', 'open-workflow-selection-count'); this.#selectionCount.setAttribute('role', 'status'); this.#selectionCount.setAttribute('aria-live', 'polite'); this.#selectionCount.setAttribute('aria-atomic', 'true');
        this.#clearSelection = this.#button('Clear all selected studies', 'clear-studies', {}, 'open-workflow-text-button'); selection.append(label, this.#selectionCount, this.#clearSelection); this.#body.append(selection);
        const rows = this.#node('div', 'open-workflow-studies');
        for (const study of studies) {
            const label = this.#node('label', 'open-workflow-study'), input = this.#node('input'); input.type = 'checkbox'; input.dataset.openStudy = key(study); input.checked = this.#state.selected.has(key(study)); input.disabled = !selectable(study); if (input.disabled) label.className += ' is-unavailable';
            const copy = this.#node('span', 'open-workflow-study-copy'); copy.append(this.#node('strong', null, study.description || study.studyDescription || 'Untitled examination'), this.#node('span', null, `${date(study.studyDate)} · ${list(study.modalities).join(', ') || study.modality || 'Modality not supplied'}`));
            const counts = [Number.isSafeInteger(study.seriesCount) ? count(study.seriesCount, 'series', 'series') : '', Number.isSafeInteger(study.instanceCount) ? count(study.instanceCount, 'image') : '', study.accessionNumber ? `Accession ${study.accessionNumber}` : '', study.inSession ? 'Already in session' : '', input.disabled ? 'Unavailable for opening' : ''].filter(Boolean); if (counts.length) copy.append(this.#node('small', null, counts.join(' · '))); label.append(input, copy); rows.append(label);
        }
        this.#body.append(rows); if (!studies.length) this.#body.append(this.#note('No studies are available for this patient.'));
        if (!local && this.#hasNext(this.#state.studyPage)) this.#body.append(this.#note('More studies are available on the next page. Checked studies remain selected across pages.'));
        this.#pagination('studies', this.#state.studyOffset, local ? this.#state.studyOffset + PAGE_SIZE < this.#state.studies.length : this.#hasNext(this.#state.studyPage));
        this.#updateStudySelection();
    }
    #selectionScope() { return this.#state.studies.filter(selectable); }
    #updateStudySelection() {
        if (!this.#selectAll) return;
        const scope = this.#selectionScope(), selected = scope.filter(study => this.#state.selected.has(key(study))).length;
        const selectedTotal = [...this.#state.selected.values()].filter(item => string(item.patientId) === string(this.#state.patient?.id)).length;
        this.#selectAll.checked = scope.length > 0 && selected === scope.length; this.#selectAll.indeterminate = selected > 0 && selected < scope.length;
        this.#selectAll.disabled = this.#state.busy || scope.length === 0; this.#selectAll.setAttribute('aria-checked', this.#selectAll.indeterminate ? 'mixed' : string(this.#selectAll.checked));
        this.#selectionCount.textContent = this.#state.step === 'local-studies' ? `${selectedTotal.toLocaleString()} of ${count(scope.length, 'available study', 'available studies')} selected` : `${count(selected, 'study', 'studies')} selected on this page · ${count(selectedTotal, 'study', 'studies')} selected across pages`;
        this.#clearSelection.disabled = this.#state.busy || selectedTotal === 0;
        for (const input of this.#body.querySelectorAll?.('input') ?? []) if (input.dataset.openStudy != null) input.checked = !input.disabled && this.#state.selected.has(input.dataset.openStudy);
    }
    #renderLocalImages() {
        const patients = this.#state.patients, studyCount = patients.reduce((total, patient) => total + list(patient.studies).length, 0);
        const counts = this.#state.preview?.counts ?? {}, summary = [count(patients.length, 'patient'), count(studyCount, 'study', 'studies')];
        if (Number.isSafeInteger(counts.series)) summary.push(count(counts.series, 'series', 'series'));
        if (Number.isSafeInteger(counts.instances)) summary.push(count(counts.instances, 'image'));
        this.#body.append(this.#node('div', 'open-workflow-import-summary', summary.join(' · ')));
        for (const patient of patients.slice(0, PAGE_SIZE)) { const row = this.#node('div', 'open-workflow-import-patient'); row.append(this.#node('strong', null, patientName(patient))); this.#demographics(patient, row); row.append(this.#note(count(list(patient.studies).length, 'study', 'studies'))); this.#body.append(row); }
        if (patients.length > PAGE_SIZE) this.#body.append(this.#note(`${count(patients.length - PAGE_SIZE, 'additional patient')} will also be added in separate workspaces.`));
        if (patients.length > 1) this.#body.append(this.#note('Patients stay separate. Only one patient workspace is active at a time.'));
    }
    #hasNext(page) { return page?.nextOffset != null || page?.hasMore === true; }
    #pagination(kind, offset, next, local = false) {
        if (!offset && !next) return;
        const nav = this.#node('nav', 'open-workflow-pagination'); nav.setAttribute('aria-label', `${kind} pages`);
        const prefix = local ? `local-${kind}` : kind, previous = this.#button('Previous', `${prefix}-previous`), forward = this.#button('Next', `${prefix}-next`); previous.disabled = offset === 0; forward.disabled = !next;
        nav.append(previous, this.#node('span', null, `Page ${Math.floor(offset / PAGE_SIZE) + 1}`), forward); this.#body.append(nav);
    }
    #renderWarnings() {
        const warnings = this.#state.step.startsWith('local-') ? [...list(this.#state.preview?.warnings), ...list(this.#state.patient?.warnings)] : this.#state.warnings;
        if (!warnings.length) return;
        const details = this.#node('details', 'open-workflow-warnings'); details.append(this.#node('summary', null, `${count(warnings.length, 'notice')} about this selection`));
        for (const warning of warnings.slice(0, 10)) details.append(this.#note(typeof warning === 'string' ? warning : warning?.message || 'Review this selection.'));
        if (warnings.length > 10) details.append(this.#note(`${warnings.length - 10} additional notices.`)); this.#body.append(details);
    }
    #renderFooter() {
        this.#footer.replaceChildren(); const {step, busy} = this.#state;
        const left = this.#node('div', 'open-workflow-footer-start'); if (step !== 'choose') { const back = this.#button('← Back', 'back'); back.disabled = busy; left.append(back); }
        const right = this.#node('div', 'open-workflow-footer-end'); this.#cancelButton = this.#button(busy ? 'Cancel operation' : 'Cancel', 'close');
        if (this.#blocking) this.#cancelButton.setAttribute('aria-describedby', this.#progressLabel.id);
        right.append(this.#cancelButton);
        if (['local-images', 'local-studies', 'studies'].includes(step)) { const selected = this.#state.selected.size, add = this.#button(step === 'local-images' ? 'Add selected images' : `Add ${count(selected, 'study', 'studies')}`, 'add', {}, 'open-workflow-button open-workflow-primary'); add.disabled = busy || !selected; right.append(add); }
        this.#footer.append(left, right);
    }
    getState() {
        return {open: this.#state.open, step: this.#state.step, intent: this.#state.intent, busy: this.#state.busy,
            sourceId: this.#state.sourceId, patientId: this.#state.patient?.id ?? null, selectedStudyIds: [...this.#state.selected.keys()],
            patientCount: this.#state.patients.length, error: this.#state.error, patientOffset: this.#state.patientOffset, studyOffset: this.#state.studyOffset};
    }
    dispose() { if (this.#disposed) return; this.close(); this.#disposed = true; this.#lifetime.abort(); this.#dialog.remove(); this.#callbacks = {}; }
}
