import { DicomWebClient } from '../data/DicomWebClient.js';
import { abortError } from '../runtime/native-decoder.js';
import { findPriorCandidates } from '../data/prior-studies.js';

function pageOptions(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.getPrototypeOf(options) !== Object.prototype) {
        throw new TypeError('Archive paging options must be a plain object.');
    }
    if (options.signal != null && !(options.signal instanceof AbortSignal)) throw new TypeError('Archive query signal must be an AbortSignal.');
    return { ...options };
}

/** Metadata navigation has a lifetime independent of the currently displayed image. */
export class ArchiveBrowser {
    constructor(root, { openSeries, disconnectSource, onError, onMeasure }) {
        this.root = root;
        this.openSeries = openSeries;
        this.disconnectSource = disconnectSource;
        this.onError = onError;
        this.onMeasure = onMeasure;
        this.client = null;
        this.disposed = false;
        this.lifetime = new AbortController();
        this.controllers = {};
        this.pages = { studies: null, series: null };
        this.filters = {};
        this.studyUid = null;
        this.selectedStudy = null;
        this.priors = null;
        this.activeSeriesUid = null;
        this.openToken = 0;
        this.offsets = { studies: 0, series: 0 };
        this.limits = { studies: 25, series: 50 };
        this.mode = 'local';
        if (['127.0.0.1', 'localhost'].includes(location.hostname) && ['5174', '5175'].includes(location.port)) {
            this.el('archive-base-url').value = `${location.origin}/orthanc/dicom-web/`;
        }
        const listen = (id, type, action) => this.el(id).addEventListener(type, action, { signal: this.lifetime.signal });
        listen('open-archive', 'click', () => { this.selectMode('archive'); root.classList.add('library-open'); this.el('toggle-library').setAttribute('aria-expanded', 'true'); if (!this.client) this.el('archive-base-url').focus(); });
        listen('library-archive-tab', 'click', () => this.selectMode('archive'));
        listen('library-local-tab', 'click', () => this.selectMode('local'));
        for (const mode of ['local', 'archive']) listen(`library-${mode}-tab`, 'keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            const next = event.key === 'Home' ? 'local' : event.key === 'End' ? 'archive' : mode === 'local' ? 'archive' : 'local';
            this.selectMode(next);
            this.el(`library-${next}-tab`).focus();
        });
        listen('archive-connect-form', 'submit', event => {
            event.preventDefault();
            try { this.configure({ baseUrl: this.el('archive-base-url').value.trim(), retrievalMode: this.el('archive-retrieval-mode').value }); this.searchStudies().catch(() => {}); }
            catch (error) { this.showError(error); }
        });
        listen('archive-search-form', 'submit', event => { event.preventDefault(); this.searchStudies(this.readFilters()).catch(() => {}); });
        listen('archive-disconnect', 'click', () => this.disconnect());
        listen('archive-find-priors', 'click', () => {
            const study = this.selectedStudy;
            if (!study) return;
            this.findPriorStudies({ patientId: study.patientId, currentStudyUid: study.studyUid, currentStudyDate: study.studyDate }).catch(error => { if (error.name !== 'AbortError') this.showError(error); });
        });
        for (const kind of ['studies', 'series']) {
            const prefix = kind === 'studies' ? 'archive-study' : 'archive-series';
            for (const direction of ['prev', 'next']) listen(`${prefix}-${direction}`, 'click', () => {
                const offset = direction === 'prev' ? Math.max(0, this.offsets[kind] - this.limits[kind]) : this.pages[kind]?.nextOffset;
                if (offset == null) return;
                const options = { offset, limit: this.limits[kind] };
                (kind === 'studies' ? this.searchStudies(this.filters, options) : this.listStudySeries(this.studyUid, options)).catch(() => {});
            });
        }
        listen('archive-add-comparison', 'change', () => this.render());
        this.selectMode('local');
    }

    el(id) { return this.root.querySelector(`#${id}`); }
    get busy() { return Object.keys(this.controllers).length > 0; }
    assertActive() { if (this.disposed) throw new Error('This viewer has been disposed.'); }
    requireClient() { this.assertActive(); if (!this.client) throw new Error('Connect a DICOMweb archive first.'); return this.client; }

    selectMode(mode) {
        this.assertActive();
        this.mode = mode;
        this.el('local-library').hidden = mode !== 'local';
        this.el('archive-library').hidden = mode !== 'archive';
        this.el('library-local-tab').setAttribute('aria-selected', String(mode === 'local'));
        this.el('library-archive-tab').setAttribute('aria-selected', String(mode === 'archive'));
        this.el('library-local-tab').tabIndex = mode === 'local' ? 0 : -1;
        this.el('library-archive-tab').tabIndex = mode === 'archive' ? 0 : -1;
        this.el('library-count').textContent = mode === 'archive' ? 'DICOMweb' : '4 demos';
    }

    resetQueries() {
        Object.values(this.controllers).forEach(controller => controller.abort());
        this.controllers = {};
        this.pages = { studies: null, series: null };
        this.studyUid = null;
        this.selectedStudy = null; this.priors = null;
        this.filters = {};
        this.offsets = { studies: 0, series: 0 };
        this.el('archive-error').hidden = true;
        this.render();
    }

    configure(configuration) {
        this.assertActive();
        const client = new DicomWebClient(configuration, { onMeasure: this.onMeasure });
        this.resetQueries();
        this.disconnectSource();
        this.client = client;
        this.el('archive-base-url').value = client.baseUrl;
        this.el('archive-retrieval-mode').value = client.retrievalMode;
        this.el('archive-search-form').hidden = false;
        this.el('archive-disconnect').hidden = false;
        this.el('archive-message').textContent = 'Archive configured. Search for a study to begin.';
        return { connected: true };
    }

    disconnect() {
        this.assertActive();
        this.resetQueries();
        // Revocation needs the owning client to find and release its displayed
        // series, retained attributes and pixel resources before forgetting it.
        try { this.disconnectSource(); }
        finally {
            this.client = null;
            this.el('archive-search-form').hidden = true;
            this.el('archive-disconnect').hidden = true;
            this.el('archive-message').textContent = 'Disconnected. Connect an archive to browse its studies.';
        }
    }

    readFilters() {
        return { patientId: this.el('archive-patient-id').value.trim(), accessionNumber: this.el('archive-accession').value.trim(),
            modality: this.el('archive-modality').value, studyDate: this.el('archive-date').value.replaceAll('-', '') };
    }

    async query(kind, operation, options) {
        options = pageOptions(options);
        const client = this.requireClient();
        this.controllers[kind]?.abort();
        const controller = new AbortController();
        this.controllers[kind] = controller;
        const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
        const current = () => !this.disposed && this.client === client && this.controllers[kind] === controller && !signal.aborted;
        this.el('archive-error').hidden = true;
        this.el('archive-message').textContent = kind === 'studies' ? 'Searching study metadata…' : 'Reading series metadata…';
        this.render();
        try {
            const page = await operation(client, { ...options, signal });
            if (!current()) throw abortError();
            this.pages[kind] = page;
            this.offsets[kind] = options.offset || 0;
            this.limits[kind] = options.limit || (kind === 'studies' ? 25 : 50);
            this.el('archive-message').textContent = page.warnings?.length ? page.warnings.join(' ')
                : page.items.length ? `${page.items.length} ${kind} on this page. ${kind === 'studies' ? 'Choose a study to browse series.' : 'Choose a series to open its first image.'}`
                : `No ${kind} found. ${kind === 'studies' ? 'Try changing the search filters.' : 'This study has no available series.'}`;
            this.render();
            return page;
        } catch (error) {
            if (!current() || error.name === 'AbortError') {
                if (!this.disposed && this.client === client && this.controllers[kind] === controller) {
                    this.el('archive-message').textContent = 'Archive query canceled. Search again when ready.';
                }
                throw abortError();
            }
            this.showError(error);
            throw error;
        } finally {
            if (!this.disposed && this.controllers[kind] === controller) {
                delete this.controllers[kind];
                this.render();
            }
        }
    }

    async searchStudies(filters = {}, options = {}) {
        options = pageOptions(options);
        this.requireClient();
        this.controllers.priors?.abort(); delete this.controllers.priors; this.priors = null; this.selectedStudy = null;
        this.controllers.series?.abort();
        delete this.controllers.series;
        this.pages.series = null;
        this.pages.studies = null;
        this.studyUid = null;
        this.filters = { ...filters };
        return this.query('studies', (client, request) => client.searchStudies(filters, request), options);
    }

    async listStudySeries(studyUid, options = {}) {
        options = pageOptions(options);
        this.requireClient();
        this.controllers.priors?.abort(); delete this.controllers.priors; this.priors = null;
        this.selectedStudy = this.pages.studies?.items.find(item => item.studyUid === studyUid) || null;
        this.pages.series = null;
        this.studyUid = studyUid;
        return this.query('series', (client, request) => client.listSeries(studyUid, request), options);
    }

    async openArchiveSeries(studyUid, seriesUid) {
        const client = this.requireClient();
        const token = ++this.openToken;
        const result = await this.openSeries(client, studyUid, seriesUid, { add: this.el('archive-add-comparison').checked });
        if (this.disposed || this.client !== client || token !== this.openToken) throw abortError();
        this.activeSeriesUid = seriesUid;
        this.render();
        return result;
    }

    async findPriorStudies(context, options = {}) {
        const client = this.requireClient();
        options = pageOptions(options);
        this.controllers.priors?.abort();
        const controller = new AbortController(); this.controllers.priors = controller;
        const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
        const current = () => !this.disposed && this.client === client && this.controllers.priors === controller && !signal.aborted;
        this.priors = null;
        this.el('archive-prior-message').textContent = 'Searching earlier study metadata…'; this.renderPriors();
        try {
            const result = await findPriorCandidates(client, context, { ...options, signal });
            if (!current()) throw abortError();
            this.priors = result;
            this.el('archive-prior-message').textContent = `${result.items.length} earlier candidates. ${result.warnings.join(' ')}`;
            this.renderPriors();
            return result;
        } finally {
            if (this.controllers.priors === controller) { delete this.controllers.priors; if (!this.disposed) this.renderPriors(); }
        }
    }

    renderPriors() {
        const study = this.selectedStudy;
        this.el('archive-priors').hidden = !study?.patientId || !/^\d{8}$/.test(study.studyDate || '');
        this.el('archive-find-priors').disabled = Boolean(this.controllers.priors);
        const list = this.el('archive-prior-list'); list.replaceChildren();
        for (const item of this.priors?.items || []) {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'archive-result';
            const title = document.createElement('strong'), description = document.createElement('span'), hint = document.createElement('small');
            title.textContent = item.studyDate.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
            description.textContent = item.description || 'Earlier study candidate';
            hint.textContent = `${item.modalities.join(' / ') || 'DICOM'} · Verify identity, then choose a series`;
            button.append(title, description, hint);
            button.addEventListener('click', () => this.listStudySeries(item.studyUid).catch(() => {})); list.append(button);
        }
    }

    updateSelection(seriesUid) {
        this.activeSeriesUid = seriesUid;
        if (!this.disposed) this.render();
    }

    showError(error) {
        if (this.disposed) return;
        this.el('archive-error').textContent = error.message || 'The archive request failed.';
        this.el('archive-error').hidden = false;
        this.el('archive-message').textContent = 'Check the archive connection or search and try again.';
        this.onError({ title: 'DICOMweb archive request failed', message: this.el('archive-error').textContent });
    }

    render() {
        this.renderPriors();
        for (const kind of ['studies', 'series']) {
            const prefix = kind === 'studies' ? 'archive-study' : 'archive-series';
            const page = this.pages[kind];
            this.el(kind === 'studies' ? 'archive-studies' : 'archive-series').hidden = !page;
            const list = this.el(`${prefix}-list`);
            list.replaceChildren();
            for (const item of page?.items || []) {
                const button = document.createElement('button');
                button.className = `archive-result ${kind === 'studies' ? 'archive-study' : 'archive-series-card'}`;
                button.type = 'button';
                const selected = kind === 'studies' ? item.studyUid === this.studyUid : item.seriesUid === this.activeSeriesUid;
                button.classList.toggle('active', selected);
                button.setAttribute('aria-pressed', String(selected));
                button.disabled = Boolean(this.controllers[kind]);
                const title = document.createElement('strong');
                const detail = document.createElement('span');
                const foot = document.createElement('small');
                if (kind === 'studies') {
                    button.dataset.studyUid = item.studyUid;
                    title.textContent = item.patientName || item.patientId || 'Unnamed study';
                    detail.textContent = item.description || 'DICOM study';
                    foot.textContent = [item.modalities.join(' / ') || 'DICOM', item.studyDate?.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'), item.instanceCount == null ? null : `${item.instanceCount} images`].filter(Boolean).join(' · ');
                    button.addEventListener('click', () => this.listStudySeries(item.studyUid).then(() => {
                        if (!this.disposed && this.studyUid === item.studyUid) this.el('archive-series').scrollIntoView({ block: 'nearest' });
                    }).catch(() => {}));
                } else {
                    button.dataset.seriesUid = item.seriesUid;
                    title.textContent = item.description || `${item.modality || 'DICOM'} series`;
                    detail.textContent = [item.modality, item.seriesNumber == null ? null : `Series ${item.seriesNumber}`].filter(Boolean).join(' · ');
                    foot.textContent = `${item.instanceCount == null ? 'Available' : item.instanceCount} instance${item.instanceCount === 1 ? '' : 's'} · ${this.el('archive-add-comparison').checked ? 'Add to active pane' : 'Open images'} →`;
                    button.addEventListener('click', () => this.openArchiveSeries(item.studyUid, item.seriesUid).catch(() => {}));
                }
                button.append(title, detail, foot);
                list.append(button);
            }
            this.el(`${prefix}-count`).textContent = String(page?.items.length || 0);
            this.el(`${prefix}-page`).textContent = `Page ${Math.floor(this.offsets[kind] / this.limits[kind]) + 1}`;
            this.el(`${prefix}-prev`).disabled = !this.offsets[kind] || Boolean(this.controllers[kind]);
            this.el(`${prefix}-next`).disabled = !page?.hasMore || Boolean(this.controllers[kind]);
        }
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.lifetime.abort();
        Object.values(this.controllers).forEach(controller => controller.abort());
        this.controllers = {};
        this.pages = { studies: null, series: null };
        this.client = null; this.priors = null; this.selectedStudy = null;
        this.onMeasure = null;
    }
}
