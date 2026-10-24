import styles from '../ui/styles.css';
import { startApp } from '../ui/app.js';
import { normalizeOptions, themeVariables } from './options.js';
import { EMBED_STYLE_PREFIX } from './style-prefix.js';

const mounted = new WeakMap();
const eventTypes = new Set(['sourcechange', 'framechange', 'layoutchange', 'viewportchange', 'syncchange', 'annotationchange', 'annotationselectionchange', 'reconstructionchange', 'derivedchange', 'specialtychange', 'readingprotocolchange', 'librarychange', 'error', 'dispose']);

/** Mount one independently owned viewer without taking over the host application's DOM or CSS. */
export function createViewer(container, rawOptions = {}) {
    if (!(container instanceof HTMLElement) || container.ownerDocument !== document) {
        throw new TypeError('Mount EASI View into an HTML element in the current document.');
    }
    if (mounted.has(container)) throw new Error('This container already has an EASI View instance.');
    let configuration = normalizeOptions(rawOptions);
    const host = document.createElement('easi-view-embed');
    host.className = 'easi-view-embed';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    if (configuration.styleNonce) style.nonce = configuration.styleNonce;
    style.textContent = EMBED_STYLE_PREFIX + styles;
    const wrapper = document.createElement('div');
    wrapper.className = 'viewer-container';
    const root = document.createElement('div');
    root.className = 'viewer-shell';
    wrapper.append(root);
    shadow.append(style, wrapper);
    const events = new EventTarget();
    let engine;
    let disposed = false;
    let api;

    function applyTheme() {
        // Replace only this instance's known variables, leaving the host's styles untouched.
        const all = themeVariables({ accent: '#000', background: '#000', panel: '#000', text: '#000', muted: '#000', border: '#000' });
        Object.keys(all).forEach(key => root.style.removeProperty(key));
        for (const [key, value] of Object.entries(themeVariables(configuration.theme))) root.style.setProperty(key, value);
    }

    function applyBranding() {
        const brand = configuration.branding;
        root.querySelector('#brand-name').textContent = brand.name;
        const logo = root.querySelector('#brand-logo');
        logo.alt = brand.logoAlt;
        logo.hidden = !brand.logoUrl;
        if (brand.logoUrl) logo.src = brand.logoUrl;
        else logo.removeAttribute('src');
        root.querySelector('#brand-mark').hidden = false; // The mark is the primary-menu control, independent of branding.
        root.querySelector('#release-tag').hidden = !brand.showReleaseTag;
        // Branding is a label inside the host application, never a navigation away from it.
        const link = root.querySelector('.brand');
        link.removeAttribute('href');
        link.setAttribute('aria-label', brand.name);
    }

    function ensureActive() {
        if (disposed) throw new Error('This viewer has been disposed.');
    }

    const releaseMount = () => {
        disposed = true;
        host.remove();
        if (mounted.get(container) === api) mounted.delete(container);
    };

    const dispose = () => {
        if (disposed) return;
        releaseMount();
        engine?.dispose();
    };

    for (const [key, value] of Object.entries(configuration.ui)) {
        const name = key === 'statusBar' ? 'status-bar' : key;
        root.setAttribute(`data-ui-${name}`, String(value));
    }
    applyTheme();
    container.append(host);
    try {
        engine = startApp(root, {
            initialDemo: configuration.initialDemo, keyboardScope: 'viewer', throwRendererErrors: true,
            sources: configuration.sources ?? [], opening: configuration.opening,
            onEvent(type, detail) {
                // Page lifecycle disposal must also release the mounting registration.
                if (type === 'dispose' && !disposed) releaseMount();
                events.dispatchEvent(new CustomEvent(type, { detail }));
            },
        });
        applyBranding();
        if (!configuration.ui.inspector) root.classList.add('inspector-hidden');
    } catch (error) {
        dispose();
        throw error;
    }
    api = {
        ready: engine.ready,
        open(path) { ensureActive(); return engine.open(path); },
        getOpenWorkflowState() { ensureActive(); return engine.getOpenWorkflowState(); },
        getSessionCatalog() { ensureActive(); return engine.getSessionCatalog(); },
        getSessionState() { ensureActive(); return engine.getSessionState(); },
        selectSessionPatient(id) { ensureActive(); return engine.selectSessionPatient(id); },
        openSessionStudy(id, options) { ensureActive(); return engine.openSessionStudy(id, options); },
        openSessionSeries(id, options) { ensureActive(); return engine.openSessionSeries(id, options); },
        compareSessionStudies(currentId, comparisonId, options) { ensureActive(); return engine.compareSessionStudies(currentId, comparisonId, options); },
        removeSessionPatient(id) { ensureActive(); return engine.removeSessionPatient(id); },
        closeSession() { ensureActive(); return engine.closeSession(); },
        clearViewport(slot) { ensureActive(); return engine.clearViewport(slot); },
        openSessionInstance(id, options) { ensureActive(); return engine.openSessionInstance(id, options); },
        listSessionInstances(id, options) { ensureActive(); return engine.listSessionInstances(id, options); },
        getSources() { ensureActive(); return engine.getSources(); },
        registerSource(configuration) { ensureActive(); return engine.registerSource(configuration); },
        updateSource(configuration) { ensureActive(); return engine.updateSource(configuration); },
        removeSource(id) { ensureActive(); return engine.removeSource(id); },
        testSource(id, options) { ensureActive(); return engine.testSource(id, options); },
        openStorageSources() { ensureActive(); return engine.openStorageSources(); },
        openFiles(files) { ensureActive(); return engine.openFiles(files); },
        importLocalFiles(files, options) { ensureActive(); return engine.importLocalFiles(files, options); },
        getLocalCatalog() { ensureActive(); return engine.getLocalCatalog(); },
        getLocalLibraryState() { return engine.getLocalLibraryState(); },
        selectLocalPatient(id) { ensureActive(); return engine.selectLocalPatient(id); },
        openLocalStudy(id, options) { ensureActive(); return engine.openLocalStudy(id, options); },
        openLocalSeries(id, options) { ensureActive(); return engine.openLocalSeries(id, options); },
        compareLocalStudies(currentId, comparisonId, options) { ensureActive(); return engine.compareLocalStudies(currentId, comparisonId, options); },
        cancelLocalImport() { ensureActive(); return engine.cancelLocalImport(); },
        clearLocalLibrary() { ensureActive(); return engine.clearLocalLibrary(); },
        associateLocalPatient(fromId, toId, options) { ensureActive(); return engine.associateLocalPatient(fromId, toId, options); },
        openUrl(url) { ensureActive(); return engine.openUrl(url); },
        openDemo(id) { ensureActive(); return engine.openDemo(id); },
        exportStudyContext(options) { ensureActive(); return engine.exportStudyContext(options); },
        applyStudyContext(context, options) { ensureActive(); return engine.applyStudyContext(context, options); },
        getReadingProtocols() { ensureActive(); return engine.getReadingProtocols(); },
        setReadingProtocols(protocols) { ensureActive(); return engine.setReadingProtocols(protocols); },
        previewReadingProtocol(id, options) { ensureActive(); return engine.previewReadingProtocol(id, options); },
        applyReadingProtocol(id, options) { ensureActive(); return engine.applyReadingProtocol(id, options); },
        cancelReadingProtocol() { ensureActive(); return engine.cancelReadingProtocol(); },
        resetReadingProtocol() { ensureActive(); return engine.resetReadingProtocol(); },
        getReadingProtocolState() { return engine.getReadingProtocolState(); },
        configureArchive(configuration) { ensureActive(); return engine.configureArchive(configuration); },
        disconnectArchive() { ensureActive(); return engine.disconnectArchive(); },
        searchStudies(filters, page) { ensureActive(); return engine.searchStudies(filters, page); },
        listStudySeries(studyUid, page) { ensureActive(); return engine.listStudySeries(studyUid, page); },
        openArchiveSeries(studyUid, seriesUid) { ensureActive(); return engine.openArchiveSeries(studyUid, seriesUid); },
        addArchiveSeries(studyUid, seriesUid, options) { ensureActive(); return engine.addArchiveSeries(studyUid, seriesUid, options); },
        findPriorStudies(context, options) { ensureActive(); return engine.findPriorStudies(context, options); },
        setPrefetch(options) { ensureActive(); return engine.setPrefetch(options); },
        openReconstruction(options) { ensureActive(); return engine.openReconstruction(options); },
        closeReconstruction() { ensureActive(); return engine.closeReconstruction(); },
        getReconstructionState() { return engine.getReconstructionState(); },
        setReconstruction(options) { ensureActive(); return engine.setReconstruction(options); },
        setReconstructionFusion(seriesIndex, options) { ensureActive(); return engine.setReconstructionFusion(seriesIndex, options); },
        probeReconstruction(view, column, row) { ensureActive(); return engine.probeReconstruction(view, column, row); },
        importDerived(input, options) { ensureActive(); return engine.importDerived(input, options); },
        addOverlay(input, options) { ensureActive(); return engine.addOverlay(input, options); },
        updateOverlay(id, style) { ensureActive(); return engine.updateOverlay(id, style); },
        removeOverlay(id) { ensureActive(); return engine.removeOverlay(id); },
        exportOverlays() { ensureActive(); return engine.exportOverlays(); },
        exportDerivedResults() { ensureActive(); return engine.exportDerivedResults(); },
        importDerivedResults(document, options) { ensureActive(); return engine.importDerivedResults(document, options); },
        applyPresentation(index) { ensureActive(); return engine.applyPresentation(index); },
        getDerivedState() { return engine.getDerivedState(); },
        clearDerived() { ensureActive(); return engine.clearDerived(); },
        openSpecialtyFiles(files, options) { ensureActive(); return engine.openSpecialtyFiles(files, options); },
        closeSpecialty() { ensureActive(); return engine.closeSpecialty(); },
        getSpecialtyState() { return engine.getSpecialtyState(); },
        setSpecialty(options) { ensureActive(); return engine.setSpecialty(options); },
        setSpecialtyFrame(index) { ensureActive(); return engine.setSpecialtyFrame(index); },
        playSpecialty() { ensureActive(); return engine.playSpecialty(); },
        pauseSpecialty() { ensureActive(); return engine.pauseSpecialty(); },
        probeSpecialty(column, row) { ensureActive(); return engine.probeSpecialty(column, row); },
        exportSpecialtyReport() { ensureActive(); return engine.exportSpecialtyReport(); },
        whenDisposed() { if (!disposed) throw new Error('Dispose the viewer before awaiting cleanup.'); return engine.whenDisposed(); },
        setLayout(layout) { ensureActive(); return engine.setLayout(layout); },
        setActiveViewport(slot) { ensureActive(); return engine.setActiveViewport(slot); },
        assignViewportSeries(slot, seriesIndex) { ensureActive(); return engine.assignViewportSeries(slot, seriesIndex); },
        setSynchronization(options) { ensureActive(); return engine.setSynchronization(options); },
        getWorkspaceState() { return engine.getWorkspaceState(); },
        getAnnotationState() { return engine.getAnnotationState(); },
        getAnnotations(options) { ensureActive(); return engine.getAnnotations(options); },
        addAnnotation(input, options) { ensureActive(); return engine.addAnnotation(input, options); },
        removeAnnotation(id) { ensureActive(); return engine.removeAnnotation(id); },
        measureAnnotation(id, options) { ensureActive(); return engine.measureAnnotation(id, options); },
        exportAnnotations() { ensureActive(); return engine.exportAnnotations(); },
        importAnnotations(document, options) { ensureActive(); return engine.importAnnotations(document, options); },
        undoAnnotations() { ensureActive(); return engine.undoAnnotations(); },
        redoAnnotations() { ensureActive(); return engine.redoAnnotations(); },
        clearAnnotations() { ensureActive(); return engine.clearAnnotations(); },
        setFrame(index) { ensureActive(); return engine.setFrame(index); },
        setSeries(index) { ensureActive(); return engine.setSeries(index); },
        setTool(tool) { ensureActive(); engine.setTool(tool); },
        setWindow(window) { ensureActive(); engine.setWindow(window); },
        play() { ensureActive(); engine.play(); },
        pause() { ensureActive(); engine.pause(); },
        reset() { ensureActive(); engine.reset(); },
        getState() { return engine.getState(); },
        getPerformance() { return engine.getPerformance(); },
        resetPerformance() { ensureActive(); engine.resetPerformance(); },
        setBranding(branding) {
            ensureActive();
            configuration = normalizeOptions({ ...configuration, branding });
            applyBranding();
        },
        setTheme(theme) {
            ensureActive();
            configuration = normalizeOptions({ ...configuration, theme });
            applyTheme();
        },
        on(type, handler) {
            ensureActive();
            if (!eventTypes.has(type) || typeof handler !== 'function') throw new TypeError('Choose a supported viewer event and a handler function.');
            const listener = event => { try { Promise.resolve(handler(event.detail)).catch(() => {}); } catch {} };
            events.addEventListener(type, listener);
            return () => events.removeEventListener(type, listener);
        },
        dispose,
    };
    mounted.set(container, api);
    return Object.freeze(api);
}

export { createEnterpriseViewer } from './enterprise-viewer.js';
export { getDefaultReadingProtocols, normalizeReadingProtocol, normalizeReadingProtocols, evaluateReadingProtocol } from '../protocols/index.js';
