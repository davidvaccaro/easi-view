import { loadFiles, loadUrl, loadDemo, MAX_SOURCE_BYTES } from '../data/sources.js';
import { ImageViewport, probe, measureDistance, isColorFrame } from '../render/ImageViewport.js';
import { validPixelSpacing } from '../render/DisplayMath.js';
import { icon } from './icons.js';
import { collectDroppedFiles, isImageCandidate } from './drop-files.js';
import { loadArchiveSeries } from '../data/archive-source.js';
import { ArchiveBrowser } from './ArchiveBrowser.js';
import { nativePlaybackAvailable, nativePlaybackInterval } from '../data/frame-timing.js';
import { PerformanceRecorder, beginMeasure } from '../runtime/performance.js';
import { WorkspaceModel } from '../runtime/workspace.js';
import { createImageTransform, transformPoint } from '../render/ViewportTransform.js';
import { AnnotationStore, createImageReference, measureAnnotation, measureGeometry } from '../annotations/index.js';
import { AnnotationController } from './AnnotationController.js';
import { createThumbnail, ThumbnailCache } from '../data/thumbnails.js';
import { ReconstructionWorkspace } from './ReconstructionWorkspace.js';
import { DerivedObjectPanel } from './DerivedObjectPanel.js';
import { OverlayRenderCache, DerivedOverlayLayer } from '../render/DerivedOverlayLayer.js';
import { displayFrame, matchesPresentation as presentationMatches } from '../integration/presentation.js';
import { exportStudyContext as exportContext } from '../integration/study-context.js';
import { StudyContextCoordinator } from '../integration/StudyContextCoordinator.js';
import { SpecialtyWorkspace } from './SpecialtyWorkspace.js';
import { AttributesPanel } from './AttributesPanel.js';
import { InspectorTabs } from './InspectorTabs.js';
import { evaluateReadingProtocol, normalizeReadingProtocol, normalizeReadingProtocols, getDefaultReadingProtocols } from '../protocols/index.js';
import { describeReadingSeries } from '../protocols/candidates.js';
import { ReadingProtocolCoordinator } from '../protocols/ReadingProtocolCoordinator.js';
import { ReadingProtocolPanel } from './ReadingProtocolPanel.js';
import { LocalCatalog } from '../catalog/LocalCatalog.js';
import { resolveLocalMedia } from '../catalog/DicomDirectory.js';
import { isDicomDirectory } from '../catalog/local-paths.js';
import { LocalPatientSession, LocalAnnotationSessions } from '../integration/LocalPatientSession.js';
import { planLocalWorkingSet } from '../integration/LocalWorkingSet.js';
import { LocalLibraryPanel } from './LocalLibraryPanel.js';
import { LocalOpenSelection } from '../catalog/LocalOpenSelection.js';
import { SessionCatalog } from '../catalog/SessionCatalog.js';
import { SourceRegistry } from '../catalog/SourceRegistry.js';
import { SessionLibraryPanel } from './SessionLibraryPanel.js';
import { OpenWorkflow } from './OpenWorkflow.js';
import { PrimaryMenu } from './PrimaryMenu.js';
import { SessionDragRegistry, SESSION_ITEM_TYPE } from '../integration/SessionDragRegistry.js';
import { instanceNavigation } from '../data/instance-navigation.js';
import { describeImageStacks } from './image-stack-labels.js';
import { ImageNoticeState } from './ImageNoticeState.js';
import { ImageNoticePopover } from './ImageNoticePopover.js';
import { AiAssistIntegration } from '../integration/AiAssistIntegration.js';
import { AiSourceBindings } from '../ai/AiSourceBindings.js';
import { createViewerWorkflow } from '../integration/ViewerWorkflow.js';
import { JPEG_ALIGNMENT_WARNING } from '../data/encapsulated.js';
import { JPEG_STORED_PRECISION_WARNING } from '../data/wasm-codecs.js';

const DEMOS = [
  { id: 'ct', modality: 'CT', title: 'CT stack', detail: 'Axial stack · calibrated HU', className: 'ct' },
  { id: 'mr', modality: 'MR', title: 'MR stack', detail: 'Soft-tissue contrast · 16-bit', className: 'mr' },
  { id: 'xr', modality: 'DX', title: 'Radiograph', detail: 'Projection image · grayscale', className: 'xr' },
  { id: 'us', modality: 'US', title: 'Ultrasound cine', detail: 'Multi-frame · motion playback', className: 'us' },
];
const TOOLS = [
  { id: 'window', label: 'Window', key: 'W', icon: 'window', hint: 'Drag to change window width and level' },
  { id: 'pan', label: 'Pan', key: 'H', icon: 'pan', hint: 'Drag to reposition the image' },
  { id: 'zoom', label: 'Zoom', key: 'Z', icon: 'zoom', hint: 'Drag up or down to zoom' },
  { id: 'probe', label: 'Probe', key: 'P', icon: 'probe', hint: 'Inspect original and rescaled pixel values' },
  { id: 'distance', label: 'Distance', key: 'L', icon: 'distance', hint: 'Drag between two image points to measure' },
  { id: 'angle', label: 'Angle', key: 'A', icon: 'distance', hint: 'Click three points: first arm, vertex, second arm' },
  { id: 'rectangle', label: 'Rectangle ROI', key: 'B', icon: 'layers', hint: 'Drag a rectangle to measure area and original pixel values' },
  { id: 'ellipse', label: 'Ellipse ROI', key: 'E', icon: 'window', hint: 'Drag an ellipse to measure area and original pixel values' },
  { id: 'polygon', label: 'Polygon ROI', key: 'G', icon: 'distance', hint: 'Click vertices, then press Enter or double-click to finish' },
  { id: 'select', label: 'Edit annotations', key: 'S', icon: 'probe', hint: 'Select an annotation; drag its handles or outline to edit' },
];
const INSPECTOR_TABS = [
  { id: 'details', label: 'Details', icon: 'inspector' },
  { id: 'measurements', label: 'Measurements', icon: 'distance' },
  { id: 'attributes', label: 'Attributes', icon: 'file' },
  { id: 'performance', label: 'Performance', icon: 'arrow' },
  { id: 'objects', label: 'Objects', icon: 'layers' },
];

function frameColorLabel(frame) { return frame.photometric === 'PALETTE COLOR' ? `Palette color · ${frame.palette?.bits ?? 8}-bit LUT` : 'RGB · 8-bit channels'; }

/** Public host mutations interrupt a task before changing its reviewed view. */
export function wrapWorkflowMutation(api, broker, name) {
  const action = api[name];
  api[name] = (...args) => { broker.interrupt(); return action(...args); };
}

function markup() {
  return `
    <header class="app-header">
      <button class="primary-menu-toggle" id="primary-menu-toggle" type="button" aria-label="Open primary menu" aria-haspopup="dialog" aria-controls="primary-menu" aria-expanded="false"><span class="brand-mark" id="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span></button>
      <div class="brand" aria-label="EASI View">
        <img class="brand-logo" id="brand-logo" alt="" hidden>
        <span id="brand-name">EASI<span class="brand-light"> View</span></span>
        <span class="release-tag" id="release-tag">ALPHA</span>
      </div>
      <div class="header-divider"></div>
      <div class="workspace-title"><span class="eyebrow">WORKSPACE</span><span id="workspace-name">Synthetic CT</span></div>
      <div class="header-actions">
        <button class="button" id="header-ai-assist" type="button" aria-label="AI Assist (Preview)" title="AI Assist (Preview)" hidden>AI <span>Assist</span></button>
        <button class="button icon-button mobile-library" id="toggle-library" title="Toggle study library" aria-label="Toggle study library" aria-expanded="false">${icon('library')}</button>
        <button class="button archive-button" id="open-archive" hidden tabindex="-1" title="Browse a DICOMweb archive" aria-label="Browse archive">${icon('link')}<span>Archive</span></button>
        <div class="image-notice-control" id="image-notice-control"></div>
        <button class="button icon-button" id="toggle-inspector" title="Toggle image inspector" aria-label="Toggle image inspector" aria-expanded="true">${icon('inspector')}</button>
      </div>
    </header>

    <div class="workspace">
      <aside class="library-panel" id="library-panel" aria-label="Session library">
        <div class="panel-heading"><h2>Session library</h2><button class="button import-button session-open-button" id="header-import" aria-haspopup="dialog">${icon('folder')}<span>Open…</span></button><span class="small-count" id="library-count" hidden></span></div>
        <div class="session-library-scroll" id="session-library-panel"></div>
        <div id="legacy-source-controls" hidden>
        <div class="library-mode-tabs" role="tablist" aria-label="Image sources"><button id="library-local-tab" role="tab" aria-selected="true" aria-controls="local-library">On device</button><button id="library-archive-tab" role="tab" aria-selected="false" aria-controls="archive-library">Archive</button></div>
        <div class="library-scroll">
          <div id="local-library" class="local-library" role="tabpanel" aria-labelledby="library-local-tab">
          <div id="local-catalog-panel"></div>
          <details id="library-examples" class="library-examples" open><summary>Examples &amp; diagnostics <span class="synthetic-pill">Synthetic</span></summary>
          <div class="section-caption"><span>BUILT-IN EXAMPLES</span><span class="synthetic-pill">Synthetic</span></div>
          <div class="demo-list">${DEMOS.map((demo) => `
            <button class="series-card ${demo.id === 'ct' ? 'active' : ''}" data-demo="${demo.id}" aria-pressed="${demo.id === 'ct'}">
              <span class="series-thumbnail thumbnail-${demo.className}" aria-hidden="true"><span class="phantom"></span><span class="thumb-modality">${demo.modality}</span></span>
              <span class="series-card-copy"><strong>${demo.title}</strong><span>${demo.detail}</span><span class="series-card-foot"><span class="native-dot"></span>Native DICOM<span class="series-card-arrow">${icon('chevron')}</span></span></span>
            </button>`).join('')}
          </div>
          </details>
          <section class="imported-section" id="imported-section" hidden>
            <div class="section-caption"><span id="imported-heading">LOCAL SERIES</span><span id="imported-count"></span></div>
            <div id="imported-list" class="imported-list"></div>
          </section>
          <div class="library-rule"></div>
          <div class="section-caption"><span>YOUR IMAGES</span>${icon('shield')}</div>
          <button class="drop-card" id="drop-card">
            <span class="drop-icon">${icon('folder')}</span>
            <strong>Open local DICOM files</strong>
            <span>Choose files or drop a folder</span>
            <span class="drop-local">Processed on your device</span>
          </button>
          <button class="folder-button" id="open-folder">${icon('folder')} Open a folder ${icon('chevron')}</button>
          <details class="dicomweb-panel" id="dicomweb-panel">
            <summary><span>${icon('link')} DICOMweb / HTTP source</span>${icon('chevron')}</summary>
            <form id="url-form">
              <label for="dicom-url">DICOM instance or WADO-RS URL</label>
              <input id="dicom-url" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://archive.example/dicom-web/…" required>
              <button class="button source-button" type="submit">Fetch DICOM ${icon('arrow')}</button>
              <p>The archive must allow browser access (CORS). No local files are uploaded.</p>
            </form>
          </details>
          </div>
          <section id="archive-library" class="archive-library" role="tabpanel" aria-labelledby="library-archive-tab" hidden>
            <div class="section-caption">DICOMWEB ARCHIVE</div>
            <form id="archive-connect-form" class="archive-form">
              <label for="archive-base-url">Archive address</label>
              <input id="archive-base-url" type="url" required autocomplete="off" spellcheck="false" placeholder="http://localhost:8042/dicom-web/">
              <label for="archive-retrieval-mode">Pixel retrieval<select id="archive-retrieval-mode"><option value="instance">Complete DICOM instance</option><option value="frame">Native grayscale / palette frame</option></select></label><p class="archive-helper">Frame mode retrieves only the selected native frame. It requires complete scalar or direct-palette metadata and archive support.</p>
              <div class="archive-connection-actions"><button class="button source-button" type="submit">Connect &amp; search ${icon('arrow')}</button><button class="archive-disconnect" id="archive-disconnect" type="button" hidden>Disconnect</button></div>
              <p class="archive-helper">Use the DICOMweb service address. Your application can supply access credentials for a protected archive.</p>
            </form>
            <form id="archive-search-form" class="archive-form archive-search" hidden>
              <div class="section-caption">FIND STUDIES</div>
              <label for="archive-patient-id">Patient ID</label><input id="archive-patient-id" type="search" maxlength="128" autocomplete="off" placeholder="Optional · * for a wildcard">
              <label for="archive-accession">Accession number</label><input id="archive-accession" type="search" maxlength="128" autocomplete="off" placeholder="Optional">
              <div class="archive-filter-pair"><label for="archive-modality">Modality<select id="archive-modality"><option value="">All</option>CT</option><option>MR</option><option>CR</option><option>DX</option><option>US</option><option>OT</option></select></label><label for="archive-date">Study date<input id="archive-date" type="date"></label></div>
              <button class="button source-button" type="submit">Search studies ${icon('zoom')}</button>
            </form>
            <p class="archive-message" id="archive-message" role="status">Connect an archive to browse its studies.</p>
            <div class="archive-error" id="archive-error" role="alert" hidden></div>
            <section id="archive-stack-section" class="archive-form" hidden><label for="archive-stack-select">Loaded image stack</label><select id="archive-stack-select" aria-label="Loaded image stack"></select><p class="archive-helper">Different image geometry is kept in separate stacks.</p></section>
            <section id="archive-studies" hidden><div class="section-caption"><span>STUDIES</span><span id="archive-study-count"></span></div><div id="archive-study-list" class="archive-result-list"></div><div class="archive-pagination"><button id="archive-study-prev" type="button">← Previous</button><span id="archive-study-page"></span><button id="archive-study-next" type="button">Next →</button></div></section>
            <section class="archive-priors" id="archive-priors" hidden><button type="button" id="archive-find-priors" class="button source-button">Find earlier study candidates</button><p id="archive-prior-message" class="archive-helper">Search uses this archive's exact Patient ID. Confirm identity before comparison.</p><div id="archive-prior-list" class="archive-result-list"></div></section>
            <label class="archive-add-option"><input id="archive-add-comparison" type="checkbox">Add series to active pane; keep loaded studies</label>
            <section id="archive-series" class="archive-series" hidden><div class="section-caption"><span>SERIES</span><span id="archive-series-count"></span></div><div id="archive-series-list" class="archive-result-list"></div><div class="archive-pagination"><button id="archive-series-prev" type="button">← Previous</button><span id="archive-series-page"></span><button id="archive-series-next" type="button">Next →</button></div></section>
          </section>
        </div>
        <div class="library-footer">${icon('layers')}<span>EASI JS <strong>1.0.0</strong><br><small>Independent viewer engine</small></span></div>
        </div>
      </aside>

      <main class="viewer-main" aria-label="DICOM image workspace">
        <div class="session-patient-banner" id="session-patient-banner" aria-live="polite" hidden></div>
        <div class="viewer-toolbar" role="toolbar" aria-label="Image tools">
          <div class="tool-group primary-tools">${TOOLS.slice(0, 5).map((tool) => `<button class="tool-button ${tool.id === 'window' ? 'active' : ''}" data-tool="${tool.id}" aria-pressed="${tool.id === 'window'}" aria-label="${tool.label}" title="${tool.hint} (${tool.key})">${icon(tool.icon)}<span>${tool.label}</span></button>`).join('')}<details class="measurement-tools" id="measurement-tools"><summary class="tool-button" title="Angles, area measurements and annotation editing">${icon('distance')}<span>Measure</span>${icon('chevron')}</summary><div class="measurement-menu">${TOOLS.slice(5).map(tool => `<button class="tool-button" data-tool="${tool.id}" aria-pressed="false" aria-label="${tool.label}" title="${tool.hint}">${icon(tool.icon)}<span>${tool.label}</span><kbd>${tool.key}</kbd></button>`).join('')}</div></details></div>
          <div class="tool-group image-tools"><button class="tool-button" id="open-specialty" title="Inspect the selected local series in a specialty workspace">${icon('layers')}<span>Specialty</span></button><button class="tool-button" id="open-reconstruction" title="Build derived patient-space views from the active spatial stack" disabled>${icon('layers')}<span>Reconstruct</span></button>
            <button class="tool-button compact" id="reset-view" title="Reset window and view (R)" aria-label="Reset window and view">${icon('reset')}</button>
            <button class="tool-button compact" id="rotate-view" title="Rotate clockwise 90 degrees" aria-label="Rotate clockwise 90 degrees">${icon('rotate')}</button>
            <button class="tool-button compact" id="flip-view" title="Flip horizontally" aria-label="Flip horizontally" aria-pressed="false">${icon('flip')}</button>
            <button class="tool-button compact" id="invert-view" title="Invert grayscale (I)" aria-label="Invert grayscale" aria-pressed="false">${icon('invert')}</button>
          </div>
        </div>
        <div class="error-banner" id="error-banner" role="alert" hidden><span>${icon('warning')}</span><div><strong id="error-title">Unable to open this image</strong><p id="error-message"></p></div><button class="icon-button" id="dismiss-error" aria-label="Dismiss error">${icon('close')}</button></div>
        <div class="workspace-controls" aria-label="Viewport layout and linking">
          <div class="layout-buttons" role="group" aria-label="Viewport layout"><button data-layout="1" aria-pressed="true" title="One viewport">1</button><button data-layout="2" aria-pressed="false" title="Two viewports">2</button><button data-layout="4" aria-pressed="false" title="Four viewports">4</button></div>
          <button class="reading-layout-button" id="open-reading-protocols" type="button" aria-haspopup="dialog" title="Preview and apply metadata-based reading layouts">${icon('layers')}<span>Reading layout</span></button><span class="reading-layout-status" id="reading-layout-status" role="status" hidden></span>
          <label class="pane-assignment"><span id="active-viewport-label">PANE 1</span><select id="viewport-series" aria-label="Series in active viewport"><option value="">Select a series</option></select></label>
          <div class="sync-controls"><span>LINK</span><label title="Match patient planes within 1 mm; requires matching reference geometry"><input id="sync-slices" type="checkbox">Slices</label><label title="Share compatible grayscale presentation"><input id="sync-window" type="checkbox">W/L</label><label title="Share patient-coordinate center and physical scale"><input id="sync-camera" type="checkbox">View</label></div>
          <label class="prefetch-control" title="After navigation stops, decode up to two adjacent frames within the shared cache budgets"><input id="prefetch-neighbors" type="checkbox">Prefetch nearby</label><span id="prefetch-status" class="prefetch-status" role="status"></span><span id="sync-status" class="sync-status" role="status"></span>
        </div>
        <div class="workspace-grid" id="workspace" data-layout="1">
        <div class="image-stage workspace-pane active" id="image-stage" data-slot="0">
          <canvas id="image-canvas" aria-label="DICOM image viewport. Use the toolbar to adjust the image." tabindex="0"></canvas>
          <svg class="annotation-layer" id="annotation-layer" aria-hidden="true"></svg>
          <div class="viewport-corner top-left">
            <div class="image-context"><span id="modality-badge" class="modality-badge">CT</span><span id="source-badge">SYNTHETIC DATA</span></div>
            <strong id="image-title">CT stack</strong>
            <span id="frame-overlay">Preparing image…</span>
          </div>
          <div class="viewport-corner top-right"><span class="viewport-index">01</span><span id="renderer-label">Initializing renderer</span></div>
          <div class="viewport-corner bottom-left"><span id="window-overlay">W — · L —</span><span id="pixel-overlay">—</span></div>
          <div class="viewport-corner bottom-right"><span id="zoom-overlay">100%</span><span id="sampling-overlay">—</span></div>
          <div class="viewport-loading" id="viewport-loading"><span class="spinner"></span><span id="loading-message">Opening synthetic CT</span></div>
          <div class="viewport-empty" id="viewport-empty" hidden>${icon('layers')}<strong>Open a Study or Image</strong><span>Choose Open… to add images, patient studies, or synthetic test images to your viewing session.</span></div>
          <div class="drop-overlay" id="drop-overlay" hidden>${icon('folder')}<strong>Drop DICOM files to open</strong><span>Images stay on this device.</span></div>
          <div class="tool-hint" id="tool-hint">Drag to adjust window · Scroll to browse frames</div>
        </div>
        </div>
        <div class="frame-controls">
          <button class="cine-button" id="cine-toggle" title="Play or pause cine (Space)" aria-label="Play cine" aria-pressed="false">${icon('play')}</button>
          <div class="frame-counter"><span class="eyebrow">FRAME</span><span><strong id="frame-number">01</strong><span class="frame-total" id="frame-total"> / —</span></span></div>
          <button class="icon-button frame-step" id="previous-frame" title="Previous frame (←)" aria-label="Previous frame">${icon('previous')}</button>
          <input id="frame-slider" type="range" min="0" max="0" value="0" step="1" aria-label="Image frame" disabled>
          <button class="icon-button frame-step" id="next-frame" title="Next frame (→)" aria-label="Next frame">${icon('next')}</button>
          <div class="cine-rate"><label for="cine-fps">CINE</label><select id="cine-fps" aria-label="Cine frames per second"><option value="5">5 fps</option><option value="10">10 fps</option><option value="15">15 fps</option><option value="20" selected>20 fps</option><option value="30">30 fps</option></select></div>
        </div>
      </main>

      <aside class="inspector-panel" id="inspector-panel" aria-label="Image inspector">
        <div class="panel-heading"><h2>Image inspector</h2><span class="live-badge"><i></i>LIVE</span></div>
        <div class="inspector-context"><span id="inspector-context-label">PANE 1 · NO IMAGE</span><strong id="inspector-image-name">Open an image to get started</strong></div>
        <div class="inspector-tabs" id="inspector-tabs" role="tablist" aria-label="Image inspector sections">${INSPECTOR_TABS.map(tab => `<button type="button" role="tab" id="inspector-tab-${tab.id}" data-inspector-tab="${tab.id}" aria-selected="${tab.id === 'details'}" aria-controls="inspector-panel-${tab.id}" tabindex="${tab.id === 'details' ? '0' : '-1'}">${icon(tab.icon)}<span>${tab.label}</span>${tab.id === 'measurements' ? '<span class="inspector-tab-count" id="inspector-measurement-count" hidden></span>' : tab.id === 'objects' ? '<span class="inspector-tab-count" id="inspector-object-count" hidden></span>' : ''}</button>`).join('')}</div>
        <div class="inspector-scroll">
          <div class="inspector-tab-panel" id="inspector-panel-details" data-inspector-panel="details" role="tabpanel" aria-labelledby="inspector-tab-details" tabindex="0">
          <section class="inspector-section">
            <div class="section-caption">WINDOW / LEVEL</div>
            <div class="window-fields"><label for="window-width"><span>Width</span><input id="window-width" type="number" min="1" step="1" value="400"></label><label for="window-center"><span>Level</span><input id="window-center" type="number" step="1" value="40"></label></div>
            <div class="preset-grid" id="window-presets"><button data-preset="auto" class="preset-button">Auto</button><button data-preset="soft" class="preset-button">Soft tissue</button><button data-preset="lung" class="preset-button">Lung</button><button data-preset="bone" class="preset-button">Bone</button></div>
            <p class="color-display-note" id="color-display-note" hidden>Decoded RGB channels are displayed directly. Window, level and grayscale inversion do not apply.</p>
          </section>
          <section class="inspector-section">
            <div class="section-caption">IMAGE DETAILS</div>
            <dl class="detail-list"><div><dt>Modality</dt><dd id="detail-modality">CT</dd></div><div><dt>Matrix</dt><dd id="detail-matrix">—</dd></div><div><dt>Pixel samples</dt><dd id="detail-samples">—</dd></div><div><dt>Photometric</dt><dd id="detail-photometric">—</dd></div><div><dt>Pixel spacing</dt><dd id="detail-spacing">—</dd></div><div><dt>Rescale</dt><dd id="detail-rescale">—</dd></div><div><dt>Frames</dt><dd id="detail-frames">—</dd></div></dl>
          </section>
          <section class="inspector-section">
            <div class="section-caption">PIXEL PROBE <kbd>P</kbd></div>
            <div class="probe-card"><span class="probe-coordinate" id="probe-coordinate">Choose the probe tool</span><strong id="probe-value">—<span> HU</span></strong><span id="probe-stored">Original samples remain available</span></div>
          </section>
          </div>
          <div class="inspector-tab-panel" id="inspector-panel-measurements" data-inspector-panel="measurements" role="tabpanel" aria-labelledby="inspector-tab-measurements" tabindex="0" hidden>
          <section class="inspector-section measurement-tool-section">
            <div class="section-caption">DRAW ON THE IMAGE</div>
            <div class="inspector-measure-tools" role="group" aria-label="Measurement tools">${TOOLS.filter(tool => ['distance', 'angle', 'rectangle', 'ellipse', 'polygon', 'select'].includes(tool.id)).map(tool => `<button type="button" data-tool="${tool.id}" aria-pressed="false" title="${tool.hint} (${tool.key})">${icon(tool.icon)}<span>${tool.label}</span></button>`).join('')}</div>
            <p class="inspector-helper">Draw on the active image, then select a measurement below to inspect or edit it.</p>
          </section>
          <section class="inspector-section annotation-section">
            <div class="section-caption"><span>MEASUREMENTS</span><span id="annotation-count">0 on this frame</span></div>
            <div class="annotation-actions"><button id="annotation-undo" type="button" title="Undo annotation edit (Ctrl/Cmd+Z)" disabled>Undo</button><button id="annotation-redo" type="button" title="Redo annotation edit" disabled>Redo</button><button id="annotation-delete" type="button" disabled>Delete selected</button></div>
            <div id="annotation-list" class="annotation-list"></div>
            <p class="inspector-empty" id="annotation-empty">No measurements on this frame yet. Choose a tool above and draw on the image.</p>
            <div id="annotation-statistics" class="annotation-statistics" hidden></div>
            <div class="annotation-transfer"><button id="annotation-export" type="button" disabled>Export JSON</button><button id="annotation-import" type="button">Import JSON</button></div>
            <p class="annotation-note">Measurements stay in this session. Export to keep them or integrate them through your application.</p>
          </section>
          </div>
          <div class="inspector-tab-panel" id="inspector-panel-attributes" data-inspector-panel="attributes" role="tabpanel" aria-labelledby="inspector-tab-attributes" tabindex="0" hidden>
            <div id="attributes-content"></div>
          </div>
          <div class="inspector-tab-panel" id="inspector-panel-performance" data-inspector-panel="performance" role="tabpanel" aria-labelledby="inspector-tab-performance" tabindex="0" hidden>
          <section class="inspector-section pipeline-section">
            <div class="section-caption">THE DATA PIPELINE</div>
            <ol class="pipeline-flow"><li><span class="pipeline-node"></span><div><strong id="pipeline-source">Synthetic DICOM</strong><span id="pipeline-source-detail">In-memory test fixture</span></div></li><li><span class="pipeline-node"></span><div><strong>EASI JS parser</strong><span>Streaming DICOM pipeline</span></div></li><li><span class="pipeline-node"></span><div><strong>Original pixel samples</strong><span id="pipeline-pixels">Preserved scalar intensities</span></div></li><li><span class="pipeline-node render-node"></span><div><strong>Our viewing engine</strong><span id="pipeline-renderer">Independent GPU renderer</span></div></li></ol>
            <div class="memory-line"><span>Decoded frame</span><strong id="frame-memory">—</strong></div>
            <div class="memory-line"><span>Decoded cache</span><strong id="cache-memory">—</strong></div>
            <div class="memory-line"><span>Encoded pixels</span><strong id="source-memory">—</strong></div>
          </section>
          <section class="inspector-section performance-section">
            <div class="section-caption">PIPELINE TIMING <button id="reset-performance" type="button" class="performance-reset">Reset</button></div>
            <dl class="detail-list"><div><dt>First draw</dt><dd id="performance-first-display">—</dd></div><div><dt>Metadata index</dt><dd id="performance-metadata-index">—</dd></div><div><dt>Read + parse</dt><dd id="performance-pipeline">—</dd></div><div><dt>Decode + queue</dt><dd id="performance-decode">—</dd></div><div><dt>Frame ready</dt><dd id="performance-frame">—</dd></div><div><dt>Draw submission</dt><dd id="performance-display">—</dd></div><div><dt>Frame cache</dt><dd id="performance-cache">—</dd></div></dl>
            <p class="performance-note">Latest successful timings on this device. Read and parse overlap; draw submission is not a screen-paint measurement.</p>
          </section>
          </div>
          <div class="inspector-tab-panel" id="inspector-panel-objects" data-inspector-panel="objects" role="tabpanel" aria-labelledby="inspector-tab-objects" tabindex="0" hidden></div>
        </div>
        <div class="research-note inspector-footer">Research alpha · Local files stay on your device.</div>
      </aside>
    </div>

    <footer class="status-bar"><div class="status-main"><span class="status-dot" id="status-dot"></span><span id="status-text">Initializing EASI View</span></div><div class="status-secondary"><span id="load-progress"></span><span class="session-status-summary" id="session-summary" aria-label="Viewing session summary"></span><button class="shortcut-button" id="show-shortcuts">${icon('help')}<span>Shortcuts</span></button><span class="privacy-footnote" id="privacy-footnote">No analytics · No uploads</span><span class="privacy-label" id="privacy-label">${icon('shield')}<span>Local files stay local</span></span></div></footer>
    <input id="file-input" type="file" multiple hidden>
    <input id="folder-input" type="file" multiple webkitdirectory directory hidden>
    <input id="annotation-input" type="file" accept=".json,application/json" hidden>
    <dialog class="shortcuts-dialog" id="shortcuts-dialog"><div class="dialog-heading"><h2>Make yourself at home.</h2><button class="icon-button" id="close-shortcuts" aria-label="Close keyboard shortcuts">${icon('close')}</button></div><p>Keyboard and mouse controls for the image workspace.</p><dl class="shortcut-list"><div><dt>Window / level</dt><dd><kbd>W</kbd> + drag</dd></div><div><dt>Pan</dt><dd><kbd>H</kbd> + drag · right-drag</dd></div><div><dt>Zoom</dt><dd><kbd>Z</kbd> + drag · Ctrl-scroll</dd></div><div><dt>Pixel probe</dt><dd><kbd>P</kbd> + point</dd></div><div><dt>Distance</dt><dd><kbd>L</kbd> + drag</dd></div><div><dt>Previous / next frame</dt><dd><kbd>←</kbd> <kbd>→</kbd> · scroll</dd></div><div><dt>Play / pause</dt><dd><kbd>Space</kbd></dd></div><div><dt>Reset / invert</dt><dd><kbd>R</kbd> <kbd>I</kbd></dd></div><div><dt>Open files</dt><dd><kbd>O</kbd></dd></div></dl><p class="dialog-note">Local files are read on your device. Fetching a remote URL connects to the archive you choose.</p></dialog>
  `;
}

function bytes(value) {
  if (!Number.isFinite(value)) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function number(value, digits = 1) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)).toLocaleString('en-US') : '—';
}

function isAbort(error) {
  return error?.name === 'AbortError';
}

export function startApp(root, options = {}) {
  root.innerHTML = markup();
  let activePane;
  let reconstruction = null;
  let reconstructionSeries = null;
  let cleanupPending = false;
  let cleanupDone = Promise.resolve();
  const $ = (id) => activePane?.element.querySelector(`[data-pane-id="${id}"]`) || root.querySelector(`#${id}`);
  let canvas = $('image-canvas');
  let viewport;
  try {
    viewport = new ImageViewport(canvas);
  } catch (error) {
    if (options.throwRendererErrors) throw error;
    $('error-title').textContent = 'The image renderer could not start';
    $('error-message').textContent = error?.message || 'This browser needs WebGL2 or Canvas2D support.';
    $('error-banner').hidden = false;
    $('viewport-loading').hidden = true;
    $('status-text').textContent = 'Renderer unavailable';
    $('status-dot').classList.add('error');
    return { dispose() {} };
  }
  const state = {
    series: [], currentSeries: null, frame: null, index: 0, renderedIndex: 0,
    tool: 'window', activeDemo: null, sourceType: 'empty', sourceLabel: 'No image',
    sourceController: null, frameController: null, loadToken: 0, frameToken: 0, pendingLoad: null,
    busy: false, frameBusy: false, frameRequestIsCine: false, playing: false, cineTimer: null, cineToken: 0, pointer: null,
    probePoint: null, measurement: null, dragDepth: 0, dropToken: 0, disposed: false,
  };
  const localCatalog = new LocalCatalog(), localSession = new LocalPatientSession(), localAnnotations = new LocalAnnotationSessions();
  const sessionCatalog = new SessionCatalog(), sessionReading = new LocalPatientSession();
  const sourceRegistry = new SourceRegistry(options.sources ?? []), localPreview = new LocalOpenSelection();
  const sessionOrigins = new WeakMap(), sessionLoaded = new Map(), savedPatientViews = new Map();
  const sessionDrag = new SessionDragRegistry();
  let primaryMenu = null, closingSession = null, aiAssist = null;
  let workflowApi = null, workflowBroker = null;
  const aiSourceBindings = new AiSourceBindings();
  let sessionPanel = null, openWorkflow = null, sessionRevision = 0, sessionDisplayPlan = null, sessionError = '', sessionNavigationRequest = 0, sessionPanelView = null, sessionPanelKey = '';
  const sessionMetadataControllers = new Set();
  let pickerIntent = 'images', pickerGeneration = 0, pendingPickerGeneration = null, configuredSourceSequence = 0;
  const openingPolicy = { localImages: true, localStudies: true, remoteStudies: true, tests: true, sourceEditing: false, ...options.opening };
  let localView = localCatalog.getView(), localViewRevision = 0, localPanel = null, localPanelKey = '';
  let localImportController = null, localImportDone = Promise.resolve(), localImportProgress = null, localImportSummary = null, localMediaReport = null, localLibraryError = '', localImportRequest = 0;
  let localSelectionOperation = null, localSelectionRequest = 0;
  const localLoaded = new Map(), localOrigins = new WeakMap();
  localSession.update(localView);
  let readingProtocols = getDefaultReadingProtocols(), readingRevision = 0, readingOperation = null, readingApplied = null;
  let readingCoordinator = null, readingPanel = null, readingRequest = 0;
  const imageNotices = new ImageNoticeState();
  const imageNoticePopover = new ImageNoticePopover($('image-notice-control'), { onAcknowledge: acknowledgeImageNotices });
  const attributesPanel = new AttributesPanel($('attributes-content'));
  const inspectorTabs = new InspectorTabs($('inspector-panel'), { onSelect: tab => {
    if (tab === 'attributes') updateInspector();
    if (tab === 'performance') updatePerformance();
  } });
  function revealInspectorTab(tab) {
    inspectorTabs.select(tab);
    // On narrow embeds the inspector overlays the image; selecting a drawing
    // tool must leave the canvas available until the user opens the inspector.
    if (root.dataset.uiInspector !== 'false' && root.clientWidth > 1180) {
      const wasHidden = root.classList.contains('inspector-hidden');
      root.classList.remove('inspector-hidden'); $('toggle-inspector').setAttribute('aria-expanded', 'true');
      if (wasHidden) requestAnimationFrame(() => { if (!state.disposed) { panes.forEach(pane => pane.viewport.resize()); drawAllAnnotations(); } });
    }
  }
  function updateInspector() {
    if (state.disposed) return;
    const frame = state.frame;
    $('inspector-context-label').textContent = `PANE ${(activePane?.slot ?? 0) + 1} · ${frame ? `${frame.modality || 'DICOM'} · FRAME ${state.renderedIndex + 1}` : 'NO IMAGE'}`;
    $('inspector-image-name').textContent = frame ? state.currentSeries?.description || 'DICOM image' : 'Open an image to get started';
    if (frame && state.currentSeries && !state.currentSeries.disposed) attributesPanel.setSource({ series: state.currentSeries, index: state.renderedIndex });
    else attributesPanel.clear();
  }
  function updateObjectCount() {
    const snapshot = derived.getState(), count = snapshot.overlayCount + snapshot.documentCount;
    $('inspector-object-count').textContent = count; $('inspector-object-count').hidden = count === 0;
  }
  const viewKeys = ['sourceType', 'sourceLabel', 'activeDemo', 'currentSeries', 'frame', 'index', 'renderedIndex', 'frameController', 'frameToken', 'frameBusy', 'frameRequestIsCine', 'probePoint', 'measurement', 'pointer'];
  const origins = new WeakMap();
  const thumbnailKeys = new WeakMap();
  const thumbnails = new ThumbnailCache();
  let thumbnailSequence = 0;
  let additionController = null;
  let contextOperation = null;
  let clearingArchive = false;
  const remoteImageKeys = new Set();
  let purgeAllAnnotations = false;
  function rememberArchiveImages(stacks) { for (const stack of stacks) for (const descriptor of stack.frames) { if (remoteImageKeys.size >= 10000) { purgeAllAnnotations = true; remoteImageKeys.clear(); return; } if (descriptor.sopUid) remoteImageKeys.add(descriptor.sopUid); } }
  let prefetch = { enabled: false, neighbors: 2 };
  function cancelAddition() { additionController?.abort(); additionController = null; }
  function applyOrigin(series) {
    const origin = origins.get(series) || { sourceType: 'empty', sourceLabel: 'No image', activeDemo: null };
    Object.assign(state, origin);
  }
  function rememberThumbnail(series, frame) {
    if (!thumbnailKeys.has(series)) thumbnailKeys.set(series, ++thumbnailSequence);
    const key = thumbnailKeys.get(series);
    if (!thumbnails.get(key)) thumbnails.set(key, createThumbnail(frame));
  }
  function schedulePrefetch(pane = activePane) {
    if (!prefetch.enabled || state.disposed || state.busy || state.playing || !panes.includes(pane) || !pane.view.frame) return;
    const series = pane.view.currentSeries;
    const frame = pane.view.frame;
    $('prefetch-status').textContent = 'Waiting for idle…';
    workspace.prefetchNeighbors(pane.slot, { neighbors: prefetch.neighbors, delayMs: 180 }).then(result => {
      if (state.disposed || !prefetch.enabled || !panes.includes(pane) || pane.view.currentSeries !== series || pane.view.frame !== frame) return;
      $('prefetch-status').textContent = result.canceled ? '' : `${result.completed} cached`;
      if (pane === activePane && state.frame) updateDetails();
    }).catch(() => { if (!state.disposed) $('prefetch-status').textContent = 'Unavailable for this image'; });
  }
  function setPrefetch(options) {
    ensureActive();
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.getPrototypeOf(options) !== Object.prototype ||
        Reflect.ownKeys(options).some(key => !['enabled', 'neighbors'].includes(key)) || typeof options.enabled !== 'boolean' ||
        options.neighbors != null && ![1, 2].includes(options.neighbors)) throw new TypeError('Use enabled:boolean and optionally one or two prefetch neighbors.');
    prefetch = { enabled: options.enabled, neighbors: options.neighbors ?? prefetch.neighbors };
    $('prefetch-neighbors').checked = prefetch.enabled;
    workspace.cancelPrefetch(); $('prefetch-status').textContent = '';
    if (prefetch.enabled) schedulePrefetch();
    return { ...prefetch };
  }

  const paneTemplate = $('image-stage').cloneNode(true);
  const workspaceElement = $('workspace');
  const panes = [];
  const workspace = new WorkspaceModel();
  const annotations = new AnnotationStore();
  const derived = new DerivedObjectPanel(root, {
    getFrame: () => state.frame,
    resolveSource: async (sopUid, frameNumber, { signal } = {}) => {
      const matches = [];
      for (const series of state.series) for (let index = 0; index < series.frames.length; index++) {
        const descriptor = series.frames[index];
        if (descriptor.sopUid === sopUid && (frameNumber == null ? descriptor._record?.frameCount === 1 && descriptor.frameIndex === 0 : descriptor.frameIndex + 1 === frameNumber)) matches.push({ series, index, descriptor });
      }
      if (matches.length !== 1) throw new Error('The referenced source image/frame is absent or ambiguous.');
      const { series, index, descriptor } = matches[0]; leaseFor(series);
      const frame = await workspace.request(series, index, signal, null);
      if (state.disposed || !state.series.includes(series) || series.disposed) throw new DOMException('The referenced source was canceled.', 'AbortError');
      return { ...frame, frameCount: descriptor._record?.frameCount ?? frame.frameCount, sopClassUid: descriptor._record?.sopClass ?? frame.sopClassUid };
    },
    onChange: () => { if (!state.disposed) { refreshPresentations(); drawAllAnnotations(); renderAllOverlays(); updateObjectCount(); emit('derivedchange'); } },
    onError: error => { if (!state.disposed && !isAbort(error)) emit('error', { title: 'Unable to import derived object', message: error.message }); },
    onApplyGsps: applyPresentation,
  });
  const overlayCache = new OverlayRenderCache(derived.store, { document: root.ownerDocument });
  function renderOverlay(pane) {
    if (!state.disposed && panes.includes(pane)) pane.overlay.render(pane.view.frame).catch(error => {
      if (!state.disposed && !isAbort(error)) emit('error', { title: 'Unable to display overlay', message: error.message });
    });
  }
  function renderAllOverlays() { savePane(); for (const pane of panes) renderOverlay(pane); }
  function refreshPresentations() {
    for (const pane of panes) if (pane.presentation) {
      const found = derived.documents.find(document => document.sopUid === pane.presentation.document.sopUid && JSON.stringify(document) === pane.presentation.signature);
      if (!found) { pane.presentation = null; if (pane.view.frame) { const transform = pane.viewport.state; pane.viewport.setFrame(pane.view.frame); pane.viewport.setTransform({ ...transform, invert: false }); } }
    }
  }
  function applyPresentation(document, frame) {
    ensureActive(); savePane();
    const targets = panes.filter(pane => pane.view.frame && presentationMatches(pane.view.frame, document));
    if (!targets.length) throw new Error('Display the referenced image before applying its presentation state.');
    const previous = targets.map(pane => ({ pane, presentation: pane.presentation, display: pane.viewport.frame, transform: pane.viewport.state }));
    try {
      for (const pane of targets) {
        const transform = pane.viewport.state;
        pane.viewport.setFrame(displayFrame(pane.view.frame, document));
        pane.viewport.setTransform({ ...transform, invert: false });
        pane.viewport.setWindow(document.window.center, document.window.width);
        pane.presentation = { document, signature: JSON.stringify(document) };
        pane.overlay.resize();
      }
    } catch (error) {
      for (const item of previous) { item.pane.presentation = item.presentation; item.pane.viewport.setFrame(item.display); item.pane.viewport.setTransform(item.transform); }
      throw error;
    }
    updateWindow(); drawAllAnnotations();
  }
  let annotationRevision = 0;
  let selectedStatistics = null;
  const borrowedLeases = new Map();
  function leaseFor(series) {
    let lease = borrowedLeases.get(series);
    if (!lease || lease.released) { lease = workspace.registerSource([series], { owned: false }); borrowedLeases.set(series, lease); }
    return lease;
  }
  let synchronization = { slice: false, window: false, camera: false, toleranceMm: 1 };
  let lastSync = [];
  let syncing = false;
  let syncRevision = 0;
  let syncController = null;
  let syncQueued = false;
  let syncDone = Promise.resolve();
  function invalidateSync() { ++syncRevision; syncController?.abort(); }
  function makePane(element, renderer, slot) {
    element.dataset.slot = String(slot);
    for (const node of [element, ...element.querySelectorAll('[id]')]) {
      node.dataset.paneId = node.id;
      if (slot) node.removeAttribute('id');
    }
    element.querySelector('.viewport-index').textContent = String(slot + 1).padStart(2, '0');
    const pane = { slot, element, canvas: element.querySelector('canvas'), viewport: renderer, lifetime: new AbortController(),
      view: Object.fromEntries(viewKeys.map(key => [key, key === 'sourceType' ? 'empty' : key === 'sourceLabel' ? 'No image' : key === 'frameToken' ? 0 : key === 'index' || key === 'renderedIndex' ? 0 : key === 'frameBusy' || key === 'frameRequestIsCine' ? false : null])) };
    pane.canvas.classList.add('viewport-canvas');
    panes.push(pane);
    pane.presentation = null;
    pane.overlay = new DerivedOverlayLayer(pane.canvas, renderer, overlayCache);
    pane.annotations = new AnnotationController({ canvas: pane.canvas,
      layer: element.querySelector('[data-pane-id="annotation-layer"]'), viewport: renderer,
      getFrame: () => pane === activePane ? state.frame : pane.view.frame,
      getTool: () => state.tool, store: annotations,
      onChange: () => { if (pane === activePane && !state.disposed) { updateMeasurements(); emit('annotationselectionchange'); } },
      onError: error => { if (!state.disposed) showError(error, 'Unable to complete this measurement'); } });
    bindSessionDrop(pane);
    const clear = root.ownerDocument.createElement('button'); clear.type = 'button'; clear.className = 'pane-clear-button'; clear.dataset.paneAction = 'clear'; clear.setAttribute('aria-label', `Clear pane ${String.fromCharCode(65 + slot)}`); clear.title = 'Clear this pane'; clear.textContent = '×';
    clear.addEventListener('click', event => { event.stopPropagation(); clearViewport(slot).catch(error => { if (!isAbort(error)) showError(error); }); }, { signal: pane.lifetime.signal });
    element.querySelector('.viewport-corner.top-right').append(clear);
    return pane;
  }
  activePane = makePane($('image-stage'), viewport, 0);
  Object.assign(activePane.view, Object.fromEntries(viewKeys.map(key => [key, state[key]])));
  const uiLifetime = new AbortController();
  const annotationDownloads = new Set();
  const unsubscribeAnnotations = annotations.subscribe(() => {
    ++annotationRevision; selectedStatistics = null; aiAssist?.invalidate();
    if (!state.disposed) { updateMeasurements(); emit('annotationchange'); }
  });
  const performanceRecorder = new PerformanceRecorder();
  const measure = (source, current = () => true) => event => {
    if (!state.disposed && (current() || event.status === 'canceled')) performanceRecorder.record({ ...event, source });
  };
  const archiveBrowser = new ArchiveBrowser(root, {
    openSeries: (client, studyUid, seriesUid, request = {}) => request.add ? addArchiveSeries(studyUid, seriesUid) : openSource(
      loadOptions => loadArchiveSeries(client, studyUid, seriesUid, loadOptions),
      'archive', 'DICOMweb series', null, { rejectErrors: true }),
    disconnectSource: () => clearArchiveSource(),
    onError: detail => emit('error', detail),
    onMeasure: measure('archive'),
  });
  localPanel = new LocalLibraryPanel($('local-catalog-panel'), {
    onImportFiles: () => $('file-input').click(), onImportFolder: () => $('folder-input').click(),
    onCancelImport: () => cancelLocalImport(), onClearLocalLibrary: () => clearLocalLibrary(),
    onSelectPatient: id => selectLocalPatient(id),
    onOpenStudy: (id, selection = {}) => openLocalStudy(id, { ...(selection.seriesId ? { seriesId: selection.seriesId } : {}) }),
    onOpenSeries: (id, selection = {}) => {
      const chosen = localSession.series(id);
      return selection.role === 'comparison' && localSession.currentStudyId && chosen.study.id !== localSession.currentStudyId
        ? compareLocalStudies(localSession.currentStudyId, chosen.study.id, { comparisonSeriesId: id }) : openLocalSeries(id);
    },
    onCompareStudies: (current, comparison, selection = {}) => compareLocalStudies(current, comparison, selection),
    onAssociatePatient: (from, to) => associateLocalPatient(from, to, { confirmed: true }),
  });
  sessionPanel = new SessionLibraryPanel($('session-library-panel'), {
    onOpen: () => openWorkflow.open(),
    onSelectPatient: id => selectSessionPatient(id),
    onOpenStudy: (id, selection) => openSessionStudy(id, selection),
    onOpenSeries: (id, selection) => openSessionSeries(id, selection),
    onOpenInstance: (id, selection) => openSessionInstance(id, selection),
    onListInstances: id => listSessionInstances(id),
    onDragStart: (event, reference) => { if (!state.busy && !localSelectionOperation) sessionDrag.begin(event.dataTransfer, reference); else event.preventDefault(); },
    onDragEnd: () => { sessionDrag.clear(); clearSessionDropTargets(); },
    onCompareStudies: (current, comparison, selection) => compareSessionStudies(current, comparison, selection),
    onRemovePatient: id => removeSessionPatient(id),
    onAssociatePatients: (from, to, options) => associateSessionPatients(from, to, options),
    getThumbnail: id => {
      const entry = sessionLoaded.get(id), series = entry?.stacks.find(stack => thumbnails.get(thumbnailKeys.get(stack)));
      const thumbnail = series ? thumbnails.get(thumbnailKeys.get(series)) : null;
      if (!thumbnail) return null;
      const image = document.createElement('canvas'); image.width = thumbnail.columns; image.height = thumbnail.rows;
      image.getContext('2d')?.putImageData(new ImageData(thumbnail.rgba, thumbnail.columns, thumbnail.rows), 0, 0); return image;
    },
  });
  openWorkflow = new OpenWorkflow(root, {
    getSources: () => sourceRegistry.list(),
    getPolicy: () => ({ ...openingPolicy, tests: openingPolicy.tests && root.dataset.uiDemos !== 'false' }),
    onPickFiles: intent => { pickerIntent = intent; pendingPickerGeneration = pickerGeneration; $('file-input').click(); },
    onPickFolder: intent => { pickerIntent = intent; pendingPickerGeneration = pickerGeneration; $('folder-input').click(); },
    onPreviewLocal: (files, request) => localPreview.preview(files, request),
    onCommitLocal: (preview, selection) => commitLocalPreview(preview, selection),
    onSearchRemote: (id, filters, page, request) => sourceRegistry.searchPatients(id, filters, { ...page, ...request }),
    onListRemoteStudies: (id, patient, page, request) => sourceRegistry.listPatientStudies(id, patient, { ...page, ...request }),
    onCommitRemote: (id, patient, studies, request) => commitRemoteSelection(id, patient, studies, request),
    onOpenTest: (id, request) => openTestWorkspace(id, request),
    onConfigureSource: configuration => configureSourceFromDialog(configuration),
    onClose: () => { ++pickerGeneration; pendingPickerGeneration = null; localPreview.clear(); },
  });

  function aiSeriesKey(series) { return aiSourceBindings.key(series); }
  function aiContext() {
    if (state.disposed || state.busy || state.frameBusy || !state.frame || !state.currentSeries || activePane.slot !== workspace.activeSlot) return null;
    const series = state.currentSeries, descriptor = series.frames[state.renderedIndex];
    if (!descriptor || descriptor.id !== state.frame.id) return null;
    const origin = sessionOrigins.get(series), local = localOrigins.get(series);
    const patientKey = origin ? `session:${origin.patientId}` : local ? `local:${local.patientId}` : aiSeriesKey(series);
    const binding = aiSourceBindings.bind(series, descriptor);
    if (!binding) return null;
    const source = { ...binding, slot: activePane.slot };
    const notices = [];
    if (state.frame.geometryWarnings?.length) notices.push('geometry');
    if (state.frame.timingWarnings?.length) notices.push('timing');
    // Transmit controlled categories, never free-form source warning text.
    for (const warning of state.frame.encodingWarnings ?? []) {
      const category = warning === JPEG_ALIGNMENT_WARNING ? 'jpeg-alignment' : warning === JPEG_STORED_PRECISION_WARNING ? 'jpeg-precision' : 'encoding';
      if (!notices.includes(category)) notices.push(category);
    }
    return { frame: state.frame, sourceBitsStored: descriptor?.bitsStored, sourceBitsAllocated: descriptor?.bitsAllocated,
      frameCount: series.frames.length, notices, source, patientKey,
      contextKey: `${source.key}/${source.slot}/${source.index}`, revision: annotationRevision,
      label: `Pane ${String.fromCharCode(65 + activePane.slot)} · Image ${state.renderedIndex + 1} of ${series.frames.length}`,
      measurements: frameAnnotations().slice(0, 64).map((annotation, index) => ({
        id: annotation.id, label: `${({length: 'Distance', angle: 'Angle', rectangle: 'Rectangle ROI', ellipse: 'Ellipse ROI', polygon: 'Polygon ROI'})[annotation.tool] ?? 'Measurement'} ${index + 1}`,
        measure: () => measureAnnotation(annotation, state.frame),
      })) };
  }
  function aiSourceAvailable(snapshot) {
    const source = snapshot?.source;
    if (!source || state.disposed) return false;
    return Boolean(aiSourceBindings.resolve(source, state.series));
  }
  workflowBroker = createViewerWorkflow({
    workflowPreferences: options.ai?.workflowPreferences,
    getViewer: () => workflowApi,
    getCatalog: () => sessionCatalog.getView(), getRoles: () => sessionReading.getState(),
    getLoaded: () => state.series, getOrigin: series => sessionOrigins.get(series),
    getStackIndex: (series, origin) => Math.max(0, sessionLoaded.get(origin.seriesId)?.stacks.indexOf(series) ?? 0),
    getMeasurements: () => annotations.list(), getAnnotationRevision: () => annotationRevision,
    getFrame: slot => slot === activePane.slot ? state.frame : panes[slot]?.view.frame,
    getWindowOverride: slot => panes[slot]?.viewport.state.windowOverride === true,
    restoreTransform(slot, transform) {
      if (!panes[slot]) throw new Error('The previous pane is no longer available.');
      panes[slot].viewport.setTransform(transform); drawAllAnnotations(); renderAllOverlays();
    },
    selectAnnotation(id) { activePane.annotations.select(id); revealInspectorTab('measurements'); },
  });
  aiAssist = new AiAssistIntegration(root, {
    ...(options.ai?.workflows === true ? { workflow: {
      getSnapshot(request) {
        ensureActive();
        if (state.busy || state.frameBusy && !state.frameRequestIsCine || localImportController || additionController) throw new Error('Finish opening images before planning a task.');
        return workflowBroker.getSnapshot(request);
      },
      preview: (plan, snapshot, choices) => workflowBroker.preview(plan, snapshot, choices),
      execute: (plan, snapshot, choices, request) => workflowBroker.execute(plan, snapshot, choices, request),
      undo: () => workflowBroker.undo(), cancel: () => workflowBroker.cancel(),
      isExecuting: () => workflowBroker.isExecuting(),
    } } : {}),
    configuration: options.ai, getContext: aiContext, isSourceAvailable: aiSourceAvailable,
    async navigateEvidence(snapshot, evidenceId) {
      if (!aiSourceAvailable(snapshot) || aiContext()?.patientKey !== snapshot.patientKey) return;
      const resolved = aiSourceBindings.resolve(snapshot.source, state.series);
      if (!resolved) return;
      const { series } = resolved;
      aiAssist.close(); pauseCine();
      if (!await selectSeries(series) || state.disposed || state.currentSeries !== series
          || !aiSourceAvailable(snapshot) || aiContext()?.patientKey !== snapshot.patientKey) return;
      const target = aiSourceBindings.resolve(snapshot.source, state.series);
      if (!target || !await requestFrame(target.index, { aiEvidence: snapshot.source }) || !aiSourceAvailable(snapshot) || aiContext()?.patientKey !== snapshot.patientKey) return;
      const measurementId = snapshot.evidence.find(item => item.id === evidenceId)?.measurementId;
      if (measurementId && frameAnnotations().some(item => item.id === measurementId)) activePane.annotations.select(measurementId);
    },
    onChange(detail) {
      if (state.disposed) return;
      const voiceTransfer = detail.workflowPhase === 'transcribing', commandTransfer = detail.workflowPhase === 'planning';
      const transferring = detail.phase === 'generating' || detail.phase === 'testing' || voiceTransfer || commandTransfer;
      $('privacy-footnote').textContent = transferring ? (voiceTransfer ? 'AI voice transfer active' : commandTransfer ? 'AI command transfer active' : 'AI metadata transfer active') : detail.configured ? 'No analytics · AI on demand' : 'No analytics · No uploads';
      $('privacy-label').querySelector('span').textContent = transferring ? (voiceTransfer ? 'Recorded voice → gateway' : commandTransfer ? 'Your command → gateway' : 'AI metadata → gateway') : 'Local files stay local';
      $('privacy-footnote').title = voiceTransfer ? 'Only your explicitly recorded command audio is sent for transcription. Image pixels and the local catalog stay local.' : commandTransfer ? 'Only the command you reviewed is sent for planning. Series matching runs locally.' : transferring ? 'Only the reviewed technical metadata or selected measurement facts are sent. Image pixels stay local.' : '';
      emit('aichange', detail);
    },
  });
  $('header-ai-assist').hidden = !aiAssist.getState().enabled;
  $('header-ai-assist').addEventListener('click', () => aiAssist.open(), { signal: uiLifetime.signal });
  aiAssist.sync();

  primaryMenu = new PrimaryMenu(root, {
    toggleButton: $('primary-menu-toggle'),
    onOpen: () => openWorkflow.open(),
    onCloseSession: () => closeSession(),
    onAiAssist: aiAssist.getState().enabled ? () => aiAssist.open() : undefined,
    onShortcuts: () => $('shortcuts-dialog').showModal(),
    onError: error => { if (!state.disposed && !isAbort(error)) showError(error, 'Unable to finish the session action'); },
    canClose: () => Boolean(sessionCatalog.getView().counts.patients || state.series.length || state.busy || localImportController),
  });

  const studyContexts = new StudyContextCoordinator({
    getClient: () => archiveBrowser.client,
    getSeries: () => state.series,
    loadSeries: (client, studyUid, seriesUid, options) => loadArchiveSeries(client, studyUid, seriesUid, options),
    listSeries: (client, studyUid, options) => client.listSeries(studyUid, options),
    getFrame: async (series, index, { signal } = {}) => {
      const operation = contextOperation; leaseFor(series);
      const frame = await workspace.request(series, index, signal, measure('archive'));
      if (signal.aborted || state.disposed || !operation || contextOperation !== operation) throw new DOMException('The study context was canceled.', 'AbortError');
      workspace.admitFrame(null, frame); operation.frames.push(frame);
      workspace.heldFrames = [...operation.previousHeld, ...operation.previous.paneViews.map(view => view.frame).filter(Boolean), ...operation.frames];
      return frame;
    },
    releaseSeries: series => { const lease = borrowedLeases.get(series); if (lease) workspace.releaseSource(lease); borrowedLeases.delete(series); series.dispose?.(); },
    commit: commitStudyContext,
  });
  async function cancelStudyContext() {
    const operation = contextOperation; if (!operation) return;
    operation.controller.abort(); studyContexts.cancel();
    try { await operation.done; } catch {}
  }
  async function applyStudyContext(input, options = {}) {
    ensureActive(); await cancelReadingProtocol(); await cancelStudyContext(); ensureActive();
    if (state.busy || state.frameBusy || additionController) throw new Error('Finish opening the current source before restoring a study context.');
    if (!options || Object.getPrototypeOf(options) !== Object.prototype || Reflect.ownKeys(options).some(key => !['archiveKey', 'scope', 'signal'].includes(key)) || options.signal != null && !(options.signal instanceof AbortSignal)) throw new TypeError('Use the configured archive key, verified scope and optional AbortSignal.');
    if (options.signal?.aborted) throw new DOMException('The study context was canceled.', 'AbortError');
    archiveBrowser.requireClient(); invalidateReadingSource(); pauseCine(); invalidateSync(); cancelAddition(); workspace.cancelPrefetch(); savePane();
    for (const pane of panes) { pane.view.frameController?.abort(); workspace.slots[pane.slot].cancel(); }
    const controller = new AbortController(), operation = { controller, previous: snapshotSource(), previousHeld: [...workspace.heldFrames], frames: [], done: null };
    contextOperation = operation; state.busy = true; workspace.heldFrames = [...operation.previousHeld, ...operation.previous.paneViews.map(view => view.frame).filter(Boolean)]; updateBusy();
    const abort = () => controller.abort(); options.signal?.addEventListener('abort', abort, { once: true });
    operation.done = studyContexts.apply(input, { ...options, signal: controller.signal }).finally(() => {
      options.signal?.removeEventListener('abort', abort);
      if (contextOperation === operation) { contextOperation = null; workspace.heldFrames = operation.revoked ? [] : operation.previousHeld; state.busy = false; if (!state.disposed) updateBusy(); }
    });
    return operation.done;
  }
  async function commitStudyContext({ context, assignments, newSeries, client, signal, isCurrent, accept }) {
    const operation = contextOperation, previous = operation.previous;
    const assertCurrent = () => { if (state.disposed || signal.aborted || !isCurrent() || contextOperation !== operation) throw new DOMException('The study context was canceled.', 'AbortError'); };
    const canRollback = () => !state.disposed && !operation.revoked && !operation.committed && archiveBrowser.client === client && contextOperation === operation;
    assertCurrent();
    try {
      leaveLocalContext(); assertCurrent();
      for (const stack of newSeries) origins.set(stack, { sourceType: 'archive', sourceLabel: 'DICOMweb study context', activeDemo: null });
      rememberArchiveImages(newSeries);
      const superseded = previous.series.filter(stack => stack._session?.client === client && newSeries.some(next => next.studyUid === stack.studyUid && next.seriesUid === stack.seriesUid));
      state.series = [...new Set([...previous.series.filter(stack => !superseded.includes(stack)), ...newSeries])];
      await setLayout(context.layout); assertCurrent(); clearWorkspaceViews(); assertCurrent();
      for (const assignment of assignments) {
        assertCurrent(); const pane = panes[assignment.slot], session = workspace.slots[pane.slot], frame = assignment.frame;
        pane.viewport.setFrame(frame);
        if (assignment.view.window) pane.viewport.setWindow(assignment.view.window.center, assignment.view.window.width);
        assertCurrent();
        session.lease = leaseFor(assignment.series).retain(); session.series = assignment.series; session.frame = frame; session.frameIndex = assignment.index;
        Object.assign(pane.view, { currentSeries: assignment.series, sourceType: 'archive', sourceLabel: 'DICOMweb study context', activeDemo: null,
          frame, index: assignment.index, renderedIndex: assignment.index, frameBusy: false });
        if (pane === activePane) Object.assign(state, pane.view);
        usePane(pane, () => { updateDetails(); updateBusy(); }); assertCurrent(); renderOverlay(pane);
      }
      setActiveViewport(context.activeViewport); assertCurrent();
      Object.assign(state, activePane.view); state.busy = false; savePane(); updateLibrary(); updateBusy(); emit('sourcechange'); assertCurrent();
      accept(); operation.committed = true;
      for (const series of superseded) { try { const lease = borrowedLeases.get(series); if (lease) workspace.releaseSource(lease); borrowedLeases.delete(series); series.dispose?.(); } catch {} }
    } catch (error) {
      if (canRollback()) {
        await setLayout(previous.paneViews.length);
        if (canRollback()) { state.series = previous.series; restoreSource(previous, { workspaceRestore: true }); renderAllOverlays(); }
      }
      throw error;
    }
  }
  function exportStudyContext(options = {}) {
    ensureActive(); savePane();
    if (!options || Object.getPrototypeOf(options) !== Object.prototype || Reflect.ownKeys(options).some(key => key !== 'archiveKey')) throw new TypeError('Supply the configured archive key.');
    return exportContext(panes, { archiveKey: options.archiveKey, archiveClient: archiveBrowser.requireClient(), activeViewport: activePane.slot,
      getOrigin: series => ({ ...origins.get(series), archiveClient: series._session?.client }) });
  }

  function readingCatalog() {
    savePane();
    if (state.series.length > 128 || state.series.reduce((count, series) => count + series.frames.length, 0) > 10000) throw new RangeError('Reading layouts accept at most 128 loaded stacks and 10,000 frames.');
    const groups = [], authorities = new Map();
    state.series.forEach((series, index) => {
      const authority = series._session?.client ?? series._session ?? series;
      let studies = authorities.get(authority); if (!studies) { studies = new Map(); authorities.set(authority, studies); }
      const firstStudy = series.frames[0]?.studyUid;
      const verifiedStudy = typeof firstStudy === 'string' && firstStudy.length && series.frames.every(frame => frame.studyUid === firstStudy) ? firstStudy : null;
      const key = series.studyUid || verifiedStudy || series;
      let group = studies.get(key);
      if (!group) { group = { id: String(groups.length), indices: [] }; studies.set(key, group); groups.push(group); }
      group.indices.push(index);
    });
    groups.forEach((group, index) => {
      const modalities = [...new Set(group.indices.map(index => state.series[index].modality || 'DICOM'))].join('/');
      group.label = `Study ${index + 1} · ${modalities} · ${group.indices.length} ${group.indices.length === 1 ? 'stack' : 'stacks'}`;
    });
    const active = state.series.indexOf(state.currentSeries);
    return { revision: readingRevision, groups, activeGroup: groups.find(group => group.indices.includes(active))?.id ?? null,
      series: state.series.map((series, index) => ({ index, label: `${series.modality || 'DICOM'} · Stack ${index + 1}${series.description ? ` · ${String(series.description).slice(0, 120)}` : ''} · ${series.frames.length} frames` })) };
  }
  function readingOptions(raw = {}, applying = false) {
    const keys = ['currentSeries', 'priorSeries', 'overrides', ...(applying ? ['signal'] : [])];
    if (!raw || Object.getPrototypeOf(raw) !== Object.prototype || Reflect.ownKeys(raw).some(key => !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(raw, key), 'value'))) throw new TypeError('Use loaded current/prior stack indices, selector overrides and an optional application signal.');
    if (applying && raw.signal != null && !(raw.signal instanceof AbortSignal)) throw new TypeError('Use an AbortSignal for reading layouts.');
    const catalog = readingCatalog();
    const indices = input => {
      if (!Array.isArray(input) || input.length > 128 || Reflect.ownKeys(input).length !== input.length + 1 || Array.from({ length: input.length }, (_, index) => Object.getOwnPropertyDescriptor(input, String(index))).some(property => !property?.enumerable || !Object.hasOwn(property, 'value'))) throw new TypeError('Use bounded arrays of loaded stack indices.');
      if (input.some(index => !Number.isInteger(index) || index < 0 || !state.series[index] || state.series[index].disposed) || new Set(input).size !== input.length) throw new RangeError('Choose each loaded stack once per study role.');
      return [...input];
    };
    const currentSeries = indices(raw.currentSeries ?? catalog.groups.find(group => group.id === catalog.activeGroup)?.indices ?? []);
    const priorSeries = indices(raw.priorSeries ?? []);
    if (priorSeries.some(index => currentSeries.includes(index))) throw new TypeError('Current and prior study roles must use distinct stacks.');
    return { currentSeries, priorSeries, overrides: raw.overrides ?? {}, ...(applying ? { signal: raw.signal } : {}) };
  }
  function planReadingProtocol(protocol, options) {
    savePane();
    const current = new Set(options.currentSeries), prior = new Set(options.priorSeries);
    const candidates = state.series.map((series, index) => describeReadingSeries(series, index, current.has(index) ? 'current' : prior.has(index) ? 'prior' : 'unassigned'));
    const selected = state.series.indexOf(state.currentSeries), activeFrames = {};
    for (const pane of panes) { const index = state.series.indexOf(pane.view.currentSeries); if (index >= 0 && pane.view.frame) activeFrames[index] = pane.view.renderedIndex; }
    if (selected >= 0 && state.frame) activeFrames[selected] = state.renderedIndex;
    return evaluateReadingProtocol(protocol, candidates, { selectedIndex: current.has(selected) ? selected : null, activeFrames, overrides: options.overrides });
  }
  function getReadingProtocols() { ensureActive(); return readingProtocols; }
  function getReadingProtocolState() {
    savePane();
    const matches = readingApplied && readingApplied.layout === panes.length && readingApplied.assignments.every(view => {
      const pane = panes[view.slot];
      return pane?.view.currentSeries === view.series && (!view.window || !isColorFrame(pane.view.frame) && pane.viewport.state.center === view.window.center && pane.viewport.state.width === view.window.width);
    }) && Object.entries(readingApplied.links).every(([key, value]) => synchronization[key] === value);
    return { ...(readingCoordinator?.getState() ?? { disposed: state.disposed, busy: false, preparing: false, committing: false, preparedFrames: 0, preparedBytes: 0, assignmentCount: 0 }),
      activeProtocolId: readingApplied?.id ?? null, manualOverride: Boolean(readingApplied && !matches), layout: state.disposed ? 1 : workspace.slots.length };
  }
  function updateReadingStatus() {
    if (state.disposed) return;
    const current = getReadingProtocolState(), node = $('reading-layout-status');
    node.hidden = !readingApplied && !current.busy;
    node.textContent = current.busy ? 'Preparing layout…' : readingApplied ? `${readingApplied.name}${current.manualOverride ? ' · adjusted' : ''}` : '';
  }
  function assertReadingIdle() { if (readingOperation) throw new Error('Finish or cancel the reading-layout application before changing this control.'); }
  async function stopReadingProtocol() {
    const operation = readingOperation;
    operation?.controller.abort();
    await readingCoordinator?.cancel();
    if (operation?.done) { try { await operation.done; } catch {} }
  }
  function cancelReadingProtocol() { ++readingRequest; return stopReadingProtocol(); }
  function setReadingProtocols(input) {
    ensureActive(); if (!Array.isArray(input)) throw new TypeError('Supply a reading-layout definition array.');
    const normalized = normalizeReadingProtocols(input);
    ++readingRequest; readingOperation?.controller.abort(); void readingCoordinator.cancel();
    readingProtocols = normalized; readingApplied = null; updateReadingStatus();
    readingPanel?.clear(); if (readingPanel?.isOpen()) readingPanel.refresh();
    emit('readingprotocolchange', getReadingProtocolState()); return readingProtocols;
  }
  function previewReadingProtocol(id, raw = {}) {
    ensureActive(); const protocol = readingProtocols.find(protocol => protocol.id === id);
    if (!protocol) throw new TypeError('Choose a configured reading-layout identifier.');
    return planReadingProtocol(protocol, readingOptions(raw));
  }
  function invalidateReadingSource() {
    ++readingRevision; ++readingRequest; readingApplied = null;
    readingPanel?.clear(); updateReadingStatus();
    emit('readingprotocolchange', getReadingProtocolState());
  }
  async function runReadingProtocol(makePlan, raw = {}) {
    ensureActive(); const request = ++readingRequest;
    await stopReadingProtocol(); await cancelStudyContext(); ensureActive();
    if (request !== readingRequest) throw new DOMException('The reading layout was superseded.', 'AbortError');
    const options = readingOptions(raw, true);
    if (options.signal?.aborted) throw new DOMException('The reading layout was canceled.', 'AbortError');
    if (state.busy || panes.some(pane => pane.view.frameBusy) || additionController || reconstruction?.getState().busy || specialty?.getState().busy) throw new Error('Finish opening the current source before applying a reading layout.');
    const { plan, name, reset } = makePlan(options);
    if (plan.status !== 'ready') throw new Error('Resolve every missing, ambiguous or unavailable selection before applying this reading layout.');
    pauseCine(); invalidateSync(); syncQueued = false; workspace.cancelPrefetch(); savePane();
    for (const pane of panes) { pane.view.frameController?.abort(); workspace.slots[pane.slot].cancel(); }
    const controller = new AbortController(), operation = { controller, revision: readingRevision, client: archiveBrowser.client,
      previous: snapshotSource(), previousHeld: [...workspace.heldFrames], previousSynchronization: { ...synchronization },
      previousApplied: readingApplied, protocols: readingProtocols, frames: [], name, reset, done: null, revoked: false, committed: false };
    readingOperation = operation; state.pointer = null; state.busy = true;
    workspace.heldFrames = [...operation.previousHeld, ...operation.previous.paneViews.map(view => view.frame).filter(Boolean)]; updateBusy();
    const abort = () => controller.abort(); options.signal?.addEventListener('abort', abort, { once: true });
    operation.done = readingCoordinator.apply(plan, { signal: controller.signal }).finally(() => {
      options.signal?.removeEventListener('abort', abort);
      if (readingOperation === operation) {
        readingOperation = null; workspace.heldFrames = state.disposed || operation.revoked ? [] : operation.previousHeld;
        operation.frames.length = 0; operation.previous = null; operation.previousApplied = null; operation.previousHeld = [];
        state.busy = false;
        if (!state.disposed) { updateBusy(); updateReadingStatus(); if (readingPanel?.isOpen()) readingPanel.refresh(); emit('readingprotocolchange', getReadingProtocolState()); }
      }
    });
    void operation.done.catch(() => {}); return operation.done;
  }
  function applyReadingProtocol(id, raw = {}) {
    return runReadingProtocol(options => {
      const protocol = readingProtocols.find(protocol => protocol.id === id);
      if (!protocol) throw new TypeError('Choose a configured reading-layout identifier.');
      return { plan: planReadingProtocol(protocol, options), name: protocol.name, reset: false };
    }, raw);
  }
  function resetReadingProtocol() {
    return runReadingProtocol(options => {
      const protocol = normalizeReadingProtocol({ version: 1, id: 'single-view', name: 'Single view', layout: 1,
        selectors: [{ id: 'selected', scope: 'selected', rules: [{ field: 'frameCount', op: 'exists', value: true }] }], slots: [{ id: 0, selector: 'selected', frame: { mode: 'active' } }],
        links: { scroll: false, window: false, camera: false } });
      return { plan: planReadingProtocol(protocol, options), name: 'Single view', reset: true };
    });
  }
  function restoreReadingLinks(links) {
    synchronization = { ...links }; invalidateSync(); lastSync = []; syncQueued = false;
    $('sync-slices').checked = synchronization.slice; $('sync-window').checked = synchronization.window; $('sync-camera').checked = synchronization.camera; $('sync-status').textContent = '';
  }
  async function commitReadingProtocol({ plan, assignments, signal, isCurrent, accept }) {
    const operation = readingOperation, previous = operation.previous;
    const assertCurrent = () => { if (state.disposed || signal.aborted || !isCurrent() || readingOperation !== operation || operation.revoked) throw new DOMException('The reading layout was canceled.', 'AbortError'); };
    const canRollback = () => !state.disposed && !operation.revoked && !operation.committed && readingOperation === operation && readingRevision === operation.revision && archiveBrowser.client === operation.client;
    assertCurrent();
    try {
      await setLayout(plan.layout, { readingInternal: true }); assertCurrent(); clearWorkspaceViews(); assertCurrent();
      for (const assignment of assignments) {
        assertCurrent(); const pane = panes[assignment.slot], session = workspace.slots[pane.slot];
        pane.presentation = null; pane.viewport.setFrame(assignment.frame); pane.overlay.resize();
        if (assignment.view.window) pane.viewport.setWindow(assignment.view.window.center, assignment.view.window.width);
        session.lease = leaseFor(assignment.series).retain(); session.series = assignment.series; session.frame = assignment.frame; session.frameIndex = assignment.index;
        const origin = origins.get(assignment.series) ?? { sourceType: 'local', sourceLabel: 'Loaded DICOM', activeDemo: null };
        Object.assign(pane.view, { ...origin, currentSeries: assignment.series, frame: assignment.frame, index: assignment.index, renderedIndex: assignment.index,
          frameBusy: false, frameController: null, pointer: null, probePoint: null, measurement: null });
        if (pane === activePane) Object.assign(state, pane.view);
        usePane(pane, () => { updateDetails(); updateBusy(); }); assertCurrent(); renderOverlay(pane); pane.annotations.render();
      }
      restoreReadingLinks({ slice: plan.links.scroll, window: plan.links.window, camera: plan.links.camera, toleranceMm: synchronization.toleranceMm });
      setActiveViewport(0); assertCurrent(); Object.assign(state, activePane.view); savePane();
      readingApplied = operation.reset ? null : { id: plan.protocolId, name: operation.name, layout: plan.layout,
        assignments: assignments.map(assignment => ({ slot: assignment.slot, series: assignment.series, window: isColorFrame(assignment.frame) ? null : { center: panes[assignment.slot].viewport.state.center, width: panes[assignment.slot].viewport.state.width } })),
        links: { slice: plan.links.scroll, window: plan.links.window, camera: plan.links.camera } };
      updateLibrary(); updateBusy(); drawAllAnnotations(); updateReadingStatus(); emit('sourcechange'); assertCurrent();
      emit('readingprotocolchange', getReadingProtocolState()); assertCurrent(); accept(); operation.committed = true;
    } catch (error) {
      if (canRollback()) {
        await setLayout(previous.paneViews.length, { readingInternal: true });
        if (canRollback()) {
          restoreSource(previous, { workspaceRestore: true });
          restoreReadingLinks(operation.previousSynchronization);
          readingApplied = readingProtocols === operation.protocols ? operation.previousApplied : null;
          workspace.heldFrames = [...operation.previousHeld, ...previous.paneViews.map(view => view.frame).filter(Boolean), ...operation.frames];
          renderAllOverlays(); updateReadingStatus();
        }
      }
      throw error;
    }
  }
  readingCoordinator = new ReadingProtocolCoordinator({
    getSeries: () => state.series, getRevision: () => readingRevision, getClient: () => archiveBrowser.client,
    getFrame: (series, index, { signal }) => { leaseFor(series); return workspace.request(series, index, signal, measure(origins.get(series)?.sourceType ?? 'local')); },
    holdFrame: frame => {
      const operation = readingOperation;
      if (!operation || operation.revoked || state.disposed) throw new DOMException('The reading layout was canceled.', 'AbortError');
      workspace.admitFrame(null, frame); operation.frames.push(frame);
      workspace.heldFrames = [...operation.previousHeld, ...operation.previous.paneViews.map(view => view.frame).filter(Boolean), ...operation.frames];
      return () => { operation.frames = operation.frames.filter(held => held !== frame); if (readingOperation === operation && !state.disposed) workspace.heldFrames = [...operation.previousHeld, ...(operation.previous?.paneViews.map(view => view.frame).filter(Boolean) ?? []), ...operation.frames]; };
    },
    commit: commitReadingProtocol,
    onChange: () => { if (!state.disposed) { updateReadingStatus(); emit('readingprotocolchange', getReadingProtocolState()); } },
  });
  readingPanel = new ReadingProtocolPanel(root, { getProtocols: getReadingProtocols, getCatalog: readingCatalog,
    preview: previewReadingProtocol, apply: applyReadingProtocol, cancel: cancelReadingProtocol, reset: resetReadingProtocol });
  $('open-reading-protocols').addEventListener('click', () => readingPanel.open($('open-reading-protocols')), { signal: uiLifetime.signal });

  const specialty = new SpecialtyWorkspace(root, {
    onChange: () => { if (!state.disposed) emit('specialtychange'); },
    onError: error => { if (!state.disposed && !isAbort(error)) emit('error', { title: 'Unable to open specialty profile', message: error.message }); },
  });
  const specialtyInput = root.ownerDocument.createElement('input'); specialtyInput.type = 'file'; specialtyInput.multiple = true;
  specialtyInput.hidden = true; specialtyInput.id = 'specialty-input'; root.append(specialtyInput);
  specialtyInput.addEventListener('change', () => { const files = [...specialtyInput.files]; specialtyInput.value = ''; if (files.length) openSpecialtyFiles(files).catch(error => { if (!isAbort(error) && !state.disposed) showError(error, 'Unable to open specialty profile'); }); }, { signal: uiLifetime.signal });
  async function openSpecialtyFiles(files, options) { ensureActive(); await cancelReadingProtocol(); pauseCine(); workspace.cancelPrefetch(); await closeReconstruction(); ensureActive(); return specialty.openFiles(files, options); }

  reconstruction = new ReconstructionWorkspace(root, {
    getSeries: index => state.series[index], getSeriesCount: () => state.series.length,
    getFrame: (series, index, { signal } = {}) => {
      if (state.disposed || !state.series.includes(series) || series.disposed) return Promise.reject(new DOMException('The reconstruction source was canceled.', 'AbortError'));
      leaseFor(series);
      return workspace.request(series, index, signal, null);
    },
    onChange: () => { if (!state.disposed) emit('reconstructionchange'); },
    onError: error => { if (!state.disposed && !isAbort(error)) emit('error', { title: 'Unable to reconstruct this series', message: error.message }); },
  });

  async function openReconstruction(options = {}) {
    ensureActive(); await cancelReadingProtocol(); ensureActive();
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.getPrototypeOf(options) !== Object.prototype ||
        Reflect.ownKeys(options).some(key => !['viewport', 'maxBytes', 'signal'].includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), 'value'))) throw new TypeError('Choose a viewport, optional volume byte budget and AbortSignal.');
    const slot = options.viewport ?? activePane.slot;
    if (!Number.isInteger(slot) || !panes[slot]?.view.frame) throw new RangeError('Open an image in an available viewport before reconstruction.');
    if (state.busy || additionController) throw new Error('Finish opening the current source before reconstruction.');
    const pane = panes[slot], series = pane.view.currentSeries;
    pauseCine(); workspace.cancelPrefetch();
    await specialty.close(); ensureActive();
    const result = await reconstruction.open({ seriesIndex: state.series.indexOf(series), maxBytes: options.maxBytes, signal: options.signal,
      window: { center: pane.viewport.state.center, width: pane.viewport.state.width, voiFunction: pane.view.frame.voiFunction ?? 'LINEAR' } });
    reconstructionSeries = series;
    return result;
  }
  function closeReconstruction() { reconstructionSeries = null; return reconstruction.close(); }

  function getPerformance() {
    const series = [...new Set([...state.series, ...(state.pendingLoad?.previous.series || [])])];
    const sessions = new Set(series.map(stack => stack._session).filter(Boolean));
    let encodedBytes = 0;
    for (const session of sessions) {
      encodedBytes += session.encoded?.bytes ?? series.filter(stack => stack._session === session).reduce((sum, stack) => sum + (stack.sourceBytes || 0), 0);
    }
    return { ...performanceRecorder.snapshot(), resources: {
      disposed: state.disposed, seriesCount: state.series.length,
      frameCount: state.currentSeries?.frames.length || 0, overlayBytes: derived.getState().overlayBytes, overlayRenderBytes: overlayCache.getState().bytes, specialtyBytes: specialty.getState().bytes, encodedBytes, decodedCacheBytes: workspace.snapshot().decodedBytes, workerCount: workspace.snapshot().workerCount, encodedCacheBytes: workspace.snapshot().encodedCacheBytes, thumbnailBytes: thumbnails.bytes, reconstructionVolumeBytes: reconstruction?.getState().volumeBytes ?? 0, reconstructionDerivedBytes: reconstruction?.getState().derivedBytes ?? 0, cleanupPending: cleanupPending || Boolean(contextOperation?.revoked) || Boolean(readingOperation?.revoked), viewportCount: state.disposed ? 0 : workspace.slots.length,
    } };
  }

  function updatePerformance() {
    if (state.disposed) return;
    const latest = new Map();
    // The inspector needs only recent completions; percentile work stays in the
    // explicit host snapshot API rather than every displayed cine frame.
    for (const event of performanceRecorder.measurements) if (event.status === 'success') latest.set(event.phase, event);
    for (const phase of ['first-display', 'metadata-index', 'pipeline', 'decode', 'frame', 'display']) {
      const event = latest.get(phase);
      $(`performance-${phase}`).textContent = event ? `${number(event.durationMs, 1)} ms` : '—';
    }
    const frame = latest.get('frame');
    $('performance-cache').textContent = !frame ? '—' : frame.decodedCacheHit ? 'Decoded frame hit' : frame.encodedCacheHit ? 'Encoded instance hit' : 'New decode';
  }

  function resetPerformance() {
    ensureActive();
    performanceRecorder.reset();
    updatePerformance();
  }

  // Host integration exposes only operational image state, never patient identifiers or pixels.
  function getState() {
    return {
      disposed: state.disposed, busy: state.busy || state.frameBusy || Boolean(localImportController) || Boolean(additionController) || Boolean(reconstruction?.getState().busy) || Boolean(specialty?.getState().busy), tool: state.tool,
      sourceType: state.sourceType, seriesCount: state.series.length,
      frameIndex: state.renderedIndex, frameCount: state.currentSeries?.frames.length || 0,
      modality: state.currentSeries?.modality || null, playing: state.playing,
      archive: { connected: Boolean(archiveBrowser.client), searching: archiveBrowser.busy },
      image: state.frame ? { rows: state.frame.rows, columns: state.frame.columns,
        photometric: state.frame.photometric, samplesPerPixel: state.frame.samplesPerPixel ?? 1,
        calibrated: Boolean(state.frame.pixelSpacing), geometryWarnings: [...(state.frame.geometryWarnings || [])], timingWarnings: [...(state.frame.timingWarnings || [])], encodingWarnings: [...(state.frame.encodingWarnings || [])] } : null,
      window: state.frame && !isColorFrame(state.frame) ? { center: viewport.state.center, width: viewport.state.width } : null,
      workspace: getWorkspaceState(),
      annotations: getAnnotationState(),
      reconstruction: reconstruction?.getState() ?? null,
      derived: derived.getState(),
      specialty: specialty.getState(),
      ai: aiAssist?.getState() ?? null,
      readingProtocol: getReadingProtocolState(),
      localLibrary: getLocalLibraryState(),
    };
  }

  function emit(type, detail = getState()) {
    try { const pending = options.onEvent?.(type, detail); if (pending?.then) Promise.resolve(pending).catch(() => {}); } catch {}
  }

  function savePane() {
    if (activePane) Object.assign(activePane.view, Object.fromEntries(viewKeys.map(key => [key, state[key]])));
  }

  function getWorkspaceState() {
    savePane();
    return { disposed: state.disposed, layout: workspace.slots.length, activeViewport: workspace.activeSlot,
      viewports: panes.map(pane => ({ slot: pane.slot, assigned: Boolean(pane.view.currentSeries),
        seriesIndex: pane.view.currentSeries ? state.series.indexOf(pane.view.currentSeries) : null,
        frameIndex: pane.view.frame ? pane.view.renderedIndex : null, frameCount: pane.view.currentSeries?.frames.length || 0,
        busy: Boolean(pane.view.frameBusy || workspace.slots[pane.slot]?.controller), image: pane.view.frame ? { rows: pane.view.frame.rows, columns: pane.view.frame.columns, photometric: pane.view.frame.photometric } : null,
        window: pane.view.frame && !isColorFrame(pane.view.frame) ? { center: pane.viewport.state.center, width: pane.viewport.state.width } : null,
        transform: { zoom: pane.viewport.state.zoom, panX: pane.viewport.state.panX, panY: pane.viewport.state.panY, rotation: pane.viewport.state.rotation, flipX: pane.viewport.state.flipX, flipY: pane.viewport.state.flipY, invert: pane.viewport.state.invert } })),
      synchronization: { ...synchronization }, prefetch: { ...prefetch }, decodedBytes: workspace.snapshot().decodedBytes, cacheBudget: workspace.cache.budget, encodedBytes: workspace.snapshot().encodedCacheBytes, encodedCacheBudget: workspace.encodedCache.budget, workerCount: workspace.snapshot().workerCount, thumbnailBytes: thumbnails.bytes,
      lastSync: lastSync.map(result => ({ slot: result.slot, matched: result.matched, ...(result.reason ? { reason: result.reason } : {}), ...(Number.isInteger(result.index) ? { frameIndex: result.index } : {}) })) };
  }

  function usePane(pane, action) {
    savePane();
    const previous = activePane;
    activePane = pane; canvas = pane.canvas; viewport = pane.viewport;
    Object.assign(state, pane.view);
    try { return action(); }
    finally {
      savePane(); activePane = previous; canvas = previous.canvas; viewport = previous.viewport;
      Object.assign(state, previous.view);
      if (pane !== previous && !state.disposed) { updateLibrary(); updateFrameControls(); updateImageNotices(); if (state.frame) updateDetails(); else updateInspector(); }
    }
  }

  function setActiveViewport(slot) {
    ensureActive();
    if (!Number.isInteger(slot) || !panes[slot]) throw new RangeError('Viewport index is outside the current layout.');
    if (activePane.slot !== slot) {
      pauseCine(); state.pointer = null; savePane();
      activePane = panes[slot]; canvas = activePane.canvas; viewport = activePane.viewport;
      Object.assign(state, activePane.view);
      workspace.setActiveSlot(slot);
      invalidateSync();
      restoreSource(snapshotSource()); updateBusy(); chooseTool(state.tool, { inspect: false });
      emit('viewportchange');
    }
    panes.forEach(pane => pane.element.classList.toggle('active', pane === activePane));
    $('active-viewport-label').textContent = `PANE ${slot + 1}`;
    updatePaneAssignment();
    return getWorkspaceState();
  }

  function updatePaneAssignment() {
    const select = $('viewport-series');
    select.replaceChildren();
    const empty = document.createElement('option'); empty.value = ''; empty.textContent = 'Select a series'; select.append(empty);
    state.series.forEach((series, index) => { const option = document.createElement('option'); option.value = String(index); option.textContent = `${series.modality || 'DICOM'} ${index + 1} · ${series.frames.length} frames`; option.selected = series === state.currentSeries; select.append(option); });
    select.disabled = !state.series.length || state.busy;
  }

  function clearWorkspaceViews() {
    pauseCine(); savePane();
    for (const pane of panes) {
      pane.view.frameController?.abort(); workspace.slots[pane.slot].clear();
      Object.assign(pane.view, { sourceType: 'empty', sourceLabel: 'No image', activeDemo: null, currentSeries: null, frame: null, index: 0, renderedIndex: 0, frameController: null, frameToken: pane.view.frameToken + 1, frameBusy: false, frameRequestIsCine: false, probePoint: null, measurement: null, pointer: null });
      pane.overlay.clear(); pane.presentation = null; pane.viewport.clearFrame();
      pane.element.querySelector('[data-pane-id="annotation-layer"]').replaceChildren();
      pane.element.querySelector('[data-pane-id="viewport-loading"]').hidden = true;
      pane.element.querySelector('[data-pane-id="viewport-empty"]').hidden = false;
    }
    Object.assign(state, activePane.view);
    lastSync = []; invalidateSync();
    updateInspector();
  }

  async function setLayout(layout, { readingInternal = false, localInternal = false } = {}) {
    if (!localInternal) assertLocalSelectionIdle();
    ensureActive(); if (!readingInternal) { await cancelReadingProtocol(); ensureActive(); }
    if (![1, 2, 4].includes(layout)) throw new RangeError('Viewport layout must be 1, 2 or 4.');
    if (activePane.slot >= layout) setActiveViewport(0);
    savePane();
    while (panes.length > layout) { const pane = panes.pop(); pane.view.frameController?.abort(); pane.overlay.dispose(); pane.annotations.dispose(); pane.lifetime.abort(); pane.viewport.dispose(); pane.element.remove(); }
    const previousLayout = panes.length;
    workspace.setLayout(layout);
    try { while (panes.length < layout) {
      const slot = panes.length, element = paneTemplate.cloneNode(true);
      workspaceElement.append(element);
      let renderer;
      try { renderer = new ImageViewport(element.querySelector('canvas')); } catch (error) { element.remove(); throw error; }
      const pane = makePane(element, renderer, slot);
      element.classList.remove('active'); bindCanvas(pane); bindViewportStatus(pane);
      pane.element.querySelector('[data-pane-id="viewport-loading"]').hidden = true;
      pane.element.querySelector('[data-pane-id="viewport-empty"]').hidden = false;
      pane.element.querySelector('[data-pane-id="viewport-empty"] strong').textContent = 'Open a Study or Image';
      pane.element.querySelector('[data-pane-id="viewport-empty"] span').textContent = 'Choose Open… to add images, patient studies, or synthetic test images to your viewing session.';
    } } catch (error) {
      while (panes.length > previousLayout) { const pane = panes.pop(); pane.overlay.dispose(); pane.annotations.dispose(); pane.lifetime.abort(); pane.viewport.dispose(); pane.element.remove(); }
      workspace.setLayout(previousLayout);
      throw error;
    }
    workspaceElement.dataset.layout = String(layout);
    root.querySelectorAll('[data-layout]').forEach(button => { if (button.tagName === 'BUTTON') button.setAttribute('aria-pressed', String(Number(button.dataset.layout) === layout)); });
    for (const pane of panes) pane.viewport.resize();
    updatePaneAssignment(); updateReadingStatus();
    if (!localInternal && sessionReading.patientId) syncSessionPaneRoles();
    updateSessionLibrary(); emit('layoutchange');
    return getWorkspaceState();
  }

  async function assignViewportSeries(slot, index) {
    assertLocalSelectionIdle();
    ensureActive(); await cancelReadingProtocol(); ensureActive();
    if (!Number.isInteger(slot) || !panes[slot]) throw new RangeError('Viewport index is outside the current layout.');
    if (!Number.isInteger(index) || !state.series[index]) throw new RangeError('Series index is outside the current source.');
    const pane = panes[slot];
    let pending;
    usePane(pane, () => { pending = selectSeries(state.series[index]); });
    const token = pane.view.frameToken;
    const displayed = await pending;
    if (state.disposed || !panes.includes(pane) || token !== pane.view.frameToken) throw new DOMException('The viewport assignment was canceled.', 'AbortError');
    if (!displayed) throw new Error('The requested viewport series could not be displayed.');
    syncSessionPaneRoles(); updateSessionLibrary(); return getWorkspaceState();
  }

  function capturePatientCamera(pane) {
    const frame = pane.view.frame, renderer = pane.viewport;
    if (!frame?.position || !frame.orientation || !frame.pixelSpacing) return null;
    const rect = pane.canvas.getBoundingClientRect();
    const image = renderer.screenToImage(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const center = frame.position.map((value, axis) => value + frame.orientation[axis] * (image.x - 0.5) * frame.pixelSpacing[1] + frame.orientation[axis + 3] * (image.y - 0.5) * frame.pixelSpacing[0]);
    const matrix = createImageTransform(frame, renderer.state, rect.width, rect.height);
    return { center, pixelsPerMm: Math.hypot(matrix.a, matrix.b) / frame.pixelSpacing[1] };
  }

  function applyPatientCamera(pane, camera) {
    const frame = pane.view.frame, rect = pane.canvas.getBoundingClientRect();
    const delta = camera.center.map((value, axis) => value - frame.position[axis]);
    const dot = vector => vector.reduce((sum, value, axis) => sum + value * delta[axis], 0);
    const point = { x: dot(frame.orientation.slice(0, 3)) / frame.pixelSpacing[1] + 0.5, y: dot(frame.orientation.slice(3)) / frame.pixelSpacing[0] + 0.5 };
    const initial = { ...pane.viewport.state, zoom: 1, panX: 0, panY: 0 };
    const matrix = createImageTransform(frame, initial, rect.width, rect.height);
    const zoom = camera.pixelsPerMm / (Math.hypot(matrix.a, matrix.b) / frame.pixelSpacing[1]);
    const scaled = createImageTransform(frame, { ...initial, zoom }, rect.width, rect.height);
    const projected = transformPoint(scaled, point.x, point.y);
    pane.viewport.setTransform({ zoom, panX: rect.width / 2 - projected.x, panY: rect.height / 2 - projected.y });
  }

  async function synchronizeWorkspace() {
    if (state.disposed || !state.frame || !(synchronization.slice || synchronization.window || synchronization.camera)) return;
    if (syncing) { syncQueued = true; return syncDone; }
    savePane();
    const slot = activePane.slot, revision = ++syncRevision, source = workspace.slots[slot];
    source.window = !isColorFrame(state.frame) ? { center: viewport.state.center, width: viewport.state.width } : null;
    source.camera = capturePatientCamera(activePane);
    syncing = true;
    const controller = new AbortController(); syncController = controller;
    let done; syncDone = new Promise(resolve => { done = resolve; });
    try {
      const results = await workspace.synchronize(slot, { ...synchronization, signal: controller.signal,
        onFrame(targetSlot, frame, index) {
          const pane = panes[targetSlot];
          if (state.disposed || controller.signal.aborted || !pane || revision !== syncRevision) throw new DOMException('The synchronization request was canceled.', 'AbortError');
          const previous = pane.viewport.frame, transform = pane.viewport.state;
          try { pane.viewport.setFrame(displayFrame(frame, pane.presentation?.document)); pane.overlay.resize(); pane.viewport.setTransform(transform); if (transform.windowOverride && !isColorFrame(frame)) pane.viewport.setWindow(transform.center, transform.width); }
          catch (error) { if (previous) { pane.viewport.setFrame(previous); pane.viewport.setTransform(transform); if (transform.windowOverride && !isColorFrame(previous)) pane.viewport.setWindow(transform.center, transform.width); } else pane.viewport.clearFrame(); throw error; }
          Object.assign(pane.view, { frame, index, renderedIndex: index, probePoint: null, measurement: null });
          usePane(pane, () => { updateDetails(); updateBusy(); });
        } });
      if (state.disposed || revision !== syncRevision) return;
      lastSync = results;
      for (const result of results) {
        const pane = panes[result.slot], session = workspace.slots[result.slot];
        if (!pane || !session.frame) continue;
        if (Number.isInteger(result.index)) {
          pane.view.frame = session.frame; pane.view.index = pane.view.renderedIndex = result.index;
          pane.view.probePoint = null; pane.view.measurement = null;
        }
        if (result.window) pane.viewport.setWindow(result.window.center, result.window.width);
        if (result.camera) applyPatientCamera(pane, result.camera);
        usePane(pane, () => { updateDetails(); updateBusy(); });
      }
      const failed = results.filter(result => !result.matched);
      $('sync-status').textContent = failed.length ? `${failed.length} pane${failed.length === 1 ? '' : 's'} unlinked · ${failed[0].reason.replaceAll('-', ' ')}` : results.length ? 'Compatible panes linked' : '';
      renderAllOverlays(); emit('syncchange');
    } catch (error) {
      if (!isAbort(error) && !state.disposed) { $('sync-status').textContent = 'Link unavailable for these images'; lastSync = []; }
    } finally {
      syncing = false; if (syncController === controller) syncController = null;
      if (syncQueued && !state.disposed) { syncQueued = false; await synchronizeWorkspace(); }
      done();
    }
  }

  async function setSynchronization(raw = {}) {
    assertLocalSelectionIdle();
    ensureActive(); await cancelReadingProtocol(); ensureActive();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) || Reflect.ownKeys(raw).some(key => !['slice', 'window', 'camera', 'toleranceMm'].includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(raw, key), 'value'))) throw new TypeError('Choose supported viewport synchronization options.');
    for (const key of ['slice', 'window', 'camera']) if (Object.hasOwn(raw, key) && typeof raw[key] !== 'boolean') throw new TypeError('Synchronization options must be booleans.');
    if (Object.hasOwn(raw, 'toleranceMm') && (!Number.isFinite(raw.toleranceMm) || raw.toleranceMm < 0 || raw.toleranceMm > 100)) throw new TypeError('Synchronization tolerance must be between 0 and 100 mm.');
    synchronization = { ...synchronization, ...raw }; invalidateSync();
    if (!(synchronization.slice || synchronization.window || synchronization.camera)) { lastSync = []; syncQueued = false; $('sync-status').textContent = ''; }
    $('sync-slices').checked = synchronization.slice; $('sync-window').checked = synchronization.window; $('sync-camera').checked = synchronization.camera;
    await synchronizeWorkspace(); updateReadingStatus(); emit('syncchange'); return getWorkspaceState();
  }

  function ensureActive() {
    if (state.disposed) throw new Error('This viewer has been disposed.');
  }

  function frameAnnotations(pane = activePane) {
    const frame = pane === activePane ? state.frame : pane?.view.frame;
    if (!frame || state.disposed) return [];
    try { return annotations.list(createImageReference(frame)); } catch { return []; }
  }

  function getAnnotationState() {
    if (state.disposed) return { count: 0, frameCount: 0, bytes: 0, canUndo: false, canRedo: false, selected: false, revision: annotationRevision };
    const snapshot = annotations.getState();
    return { count: snapshot.count, frameCount: frameAnnotations().length, bytes: snapshot.bytes,
      canUndo: snapshot.canUndo, canRedo: snapshot.canRedo, selected: Boolean(activePane?.annotations.getSelected()), revision: annotationRevision };
  }

  function updateMeasurements() {
    if (state.disposed || !activePane) return;
    const items = frameAnnotations(), snapshot = annotations.getState(), selected = activePane.annotations.getSelected();
    $('annotation-count').textContent = `${items.length} on this frame`;
    $('inspector-measurement-count').textContent = items.length;
    $('inspector-measurement-count').hidden = items.length === 0;
    $('annotation-empty').hidden = items.length > 0;
    $('annotation-undo').disabled = !snapshot.canUndo;
    $('annotation-redo').disabled = !snapshot.canRedo;
    $('annotation-delete').disabled = !selected;
    $('annotation-export').disabled = snapshot.count === 0;
    const list = $('annotation-list'); list.replaceChildren();
    for (const annotation of items) {
      const button = document.createElement('button');
      button.className = `annotation-item${annotation.id === selected?.id ? ' selected' : ''}`;
      button.type = 'button'; button.setAttribute('aria-pressed', String(annotation.id === selected?.id));
      const label = annotation.tool === 'length' ? 'Distance' : annotation.tool === 'polygon' ? 'Polygon ROI' : `${annotation.tool[0].toUpperCase()}${annotation.tool.slice(1)}${['rectangle', 'ellipse'].includes(annotation.tool) ? ' ROI' : ''}`;
      const geometry = measureGeometry(annotation.tool, annotation.points, state.frame);
      const unit = geometry.unit === 'mm2' ? 'mm²' : geometry.unit === 'px2' ? 'px²' : geometry.unit === 'deg' ? '°' : geometry.unit;
      button.textContent = `${label} · ${number(geometry.value, 2)} ${unit}`;
      button.addEventListener('click', () => { activePane.annotations.select(annotation.id); chooseTool('select'); });
      list.append(button);
    }
    const details = $('annotation-statistics'); details.replaceChildren(); details.hidden = !selected;
    if (!selected) { selectedStatistics = null; return; }
    try {
      if (!selectedStatistics || selectedStatistics.id !== selected.id || selectedStatistics.revision !== annotationRevision || selectedStatistics.frame !== state.frame) {
        selectedStatistics = { id: selected.id, revision: annotationRevision, frame: state.frame, result: measureAnnotation(selected, state.frame) };
      }
      const result = selectedStatistics.result;
      const heading = document.createElement('strong'); heading.textContent = result.geometry.calibrated ? 'DICOM Pixel Spacing calibration' : 'Uncalibrated image pixels'; details.append(heading);
      const statistics = result.statistics;
      if (!statistics) return;
      const line = text => { const paragraph = document.createElement('p'); paragraph.textContent = text; details.append(paragraph); };
      line(`${statistics.pixelCount} included pixels${statistics.excludedPadding ? ` · ${statistics.excludedPadding} padding pixels excluded` : ''}`);
      if (statistics.status === 'color-intensity-unavailable') { line('Scalar intensity statistics do not apply to color images.'); return; }
      if (statistics.status === 'empty') { line('No non-padding pixel centers lie inside this ROI.'); return; }
      line(`Mean ${number(statistics.modality.mean, 3)} ${statistics.unit || ''} · SD ${number(statistics.modality.stdDev, 3)}`);
      line(`Min ${number(statistics.modality.min, 3)} · Max ${number(statistics.modality.max, 3)}`);
      line(`Stored mean ${number(statistics.stored.mean, 3)} · population SD`);
    } catch (error) { details.textContent = error.message; selectedStatistics = null; }
  }

  function status(message, phase = 'ready') {
    $('status-text').textContent = message;
    $('status-dot').className = `status-dot ${phase}`;
  }

  function showError(error, title = 'Unable to open this image') {
    $('error-title').textContent = title;
    $('error-message').textContent = error?.message || String(error);
    $('error-banner').hidden = false;
    status('Action needed · see image message', 'error');
    emit('error', { title, message: error?.message || String(error) });
  }

  function clearError() {
    $('error-banner').hidden = true;
    $('error-message').textContent = '';
  }

  function updateImageNotices() {
    // Background pane work temporarily borrows state; only the selected pane
    // owns the header's current-image notices.
    if (activePane.slot !== workspace.activeSlot) return;
    const input = imageNoticeInput(), notice = imageNotices.get(input);
    imageNoticePopover.update({
      contextKey: state.frame ? `${activePane.slot}/${state.frame.id}` : null,
      contextLabel: state.frame ? `Pane ${String.fromCharCode(65 + activePane.slot)} · Image ${state.renderedIndex + 1} of ${state.currentSeries.frames.length}` : '',
      unreadCount: notice.visibleMessages.length,
      groups: [
        { id: 'geometry', label: input.calibrated ? 'Geometry & measurements' : 'Geometry · measurements use pixels', messages: input.geometryWarnings },
        { id: 'timing', label: 'Playback timing', messages: input.timingWarnings },
        { id: 'encoding', label: 'Encoding compatibility', messages: input.encodingWarnings }
      ]
    });
  }

  function imageNoticeScope(series) {
    const origin = sessionOrigins.get(series), metadata = origin && sessionCatalog.getSeries(origin.seriesId);
    if (metadata && metadata.studyId === origin.studyId && metadata.patientId === origin.patientId) {
      const study = sessionCatalog.getStudy(metadata.studyId);
      if (study?.patientIdOpaque === metadata.patientId) return study.id;
    }
    const local = localOrigins.get(series), patient = local && localView.patients.find(item => item.id === local.patientId);
    const study = patient?.studies.find(item => item.id === local.studyId);
    if (!study?.series.some(item => item.id === local.seriesId)) return null;
    const admittedPatient = sessionPatientForLocal(patient.id);
    return admittedPatient?.studies.find(item => item.provenance.studyId === study.id)?.id ?? study.id;
  }

  function imageNoticeInput() {
    return { series: state.currentSeries, scope: imageNoticeScope(state.currentSeries),
      calibrated: validPixelSpacing(state.frame?.pixelSpacing),
      geometryWarnings: state.frame?.geometryWarnings || [], timingWarnings: state.frame?.timingWarnings || [],
      encodingWarnings: state.frame?.encodingWarnings || [] };
  }

  function acknowledgeImageNotices() {
    if (state.disposed || !state.frame) return;
    const input = imageNoticeInput();
    if (!imageNotices.get(input).messages.length) return;
    imageNotices.dismiss(input);
    updateImageNotices();
  }

  function updateBusy() {
    if (activePane.slot === workspace.activeSlot) aiAssist?.sync();
    root.classList.toggle('reading-layout-applying', Boolean(readingOperation));
    root.classList.toggle('local-selection-applying', Boolean(localSelectionOperation));
    $('viewport-loading').hidden = Boolean(state.frame) || !(state.busy || state.frameBusy);
    $('viewport-empty').hidden = Boolean(state.frame) || state.busy || state.frameBusy;
    $('image-stage').classList.toggle('frame-loading', state.frameBusy && Boolean(state.frame));
    updatePaneAssignment();
    updateLocalLibrary();
    updateSessionLibrary();
  }

  function snapshotSource() {
    savePane();
    return {
      series: state.series, currentSeries: state.currentSeries, frame: state.frame,
      index: state.index, renderedIndex: state.renderedIndex, sourceType: state.sourceType,
      sourceLabel: state.sourceLabel, activeDemo: state.activeDemo,
      transform: viewport.state, probePoint: state.probePoint, measurement: state.measurement,
      paneViews: panes.map(pane => ({ ...pane.view, presentation: pane.presentation, transform: pane.viewport.state })), activeSlot: activePane.slot,
      localRoles: localSession.getState(), sessionRoles: sessionReading.getState(), sessionPlan: sessionDisplayPlan,
    };
  }

  function restoreSource(snapshot, { workspaceRestore = false } = {}) {
    if (workspaceRestore) { sessionDisplayPlan = snapshot.sessionPlan ?? null; if (!snapshot.sessionRoles?.activePatientId) sessionReading.clear(); }
    if (workspaceRestore && snapshot.sessionRoles?.activePatientId && sessionCatalog.getPatient(snapshot.sessionRoles.activePatientId)) {
      const roles = snapshot.sessionRoles;
      Object.assign(sessionReading, { patientId: roles.activePatientId, currentStudyId: roles.currentStudyId, comparisonStudyId: roles.comparisonStudyId });
      localAnnotations.prepare(roles.activePatientId, annotations)();
      const patient = sessionCatalog.selectPatient(roles.activePatientId);
      if (patient.kind === 'local' && snapshot.localRoles?.activePatientId === patient.provenance.patientId && localSession.patient(snapshot.localRoles.activePatientId)) {
        restoreLocalContext(snapshot.localRoles);
      } else localSession.clear();
    } else if (workspaceRestore && snapshot.localRoles) restoreLocalContext(snapshot.localRoles);
    if (workspaceRestore && snapshot.paneViews) {
      workspace.heldFrames = [];
      const restoredSlot = Math.min(snapshot.activeSlot ?? activePane.slot, panes.length - 1);
      activePane = panes[restoredSlot]; canvas = activePane.canvas; viewport = activePane.viewport; workspace.setActiveSlot(restoredSlot);
      panes.forEach(pane => pane.element.classList.toggle('active', pane === activePane));
      $('active-viewport-label').textContent = `PANE ${restoredSlot + 1}`;
      for (const pane of panes) {
        const view = snapshot.paneViews[pane.slot];
        if (!view) continue;
        const session = workspace.slots[pane.slot];
        session.clear();
        pane.presentation = view.presentation && derived.documents.some(document => document.sopUid === view.presentation.document.sopUid && JSON.stringify(document) === view.presentation.signature) ? view.presentation : null;
        Object.assign(pane.view, view, { frameController: null, frameBusy: false, pointer: null });
        if (view.currentSeries && !view.currentSeries.disposed) {
          const lease = leaseFor(view.currentSeries);
          session.lease = lease.retain(); session.series = view.currentSeries; session.frame = view.frame; session.frameIndex = view.renderedIndex;
        }
        if (view.frame) { pane.viewport.setFrame(displayFrame(view.frame, pane.presentation?.document)); pane.overlay.resize(); pane.viewport.setTransform(view.transform); if (view.transform.windowOverride && !isColorFrame(view.frame)) pane.viewport.setWindow(view.transform.center, view.transform.width); }
        else { pane.overlay.clear(); pane.viewport.clearFrame(); }
        pane.element.querySelector('[data-pane-id="viewport-empty"]').hidden = Boolean(view.frame);
        pane.element.querySelector('[data-pane-id="viewport-loading"]').hidden = true;
        pane.element.classList.remove('frame-loading');
      }
    }
    if (workspaceRestore && snapshot.paneViews) snapshot = { ...snapshot, ...activePane.view, transform: activePane.viewport.state };
    Object.assign(state, {
      series: snapshot.series, currentSeries: snapshot.currentSeries, frame: snapshot.frame,
      index: snapshot.index, renderedIndex: snapshot.renderedIndex, sourceType: snapshot.sourceType,
      sourceLabel: snapshot.sourceLabel, activeDemo: snapshot.activeDemo,
      probePoint: snapshot.probePoint, measurement: snapshot.measurement,
    });
    if (snapshot.frame) {
      viewport.setFrame(displayFrame(snapshot.frame, activePane.presentation?.document)); activePane.overlay.resize();
      viewport.setTransform(snapshot.transform);
      if (!isColorFrame(snapshot.frame) && snapshot.transform.windowOverride) viewport.setWindow(snapshot.transform.center, snapshot.transform.width);
      updateDetails(); renderOverlay(activePane);
    } else {
      activePane.overlay.clear(); viewport.clearFrame();
      updateImageNotices();
      $('modality-badge').textContent = 'DCM';
      $('source-badge').textContent = 'NO IMAGE';
      $('image-title').textContent = 'No image loaded';
      $('frame-overlay').textContent = 'No image loaded';
      $('window-overlay').textContent = 'W — · L —';
      $('pixel-overlay').textContent = '—';
      $('zoom-overlay').textContent = '100%';
      $('sampling-overlay').textContent = '—';
      ['detail-modality', 'detail-matrix', 'detail-samples', 'detail-photometric', 'detail-spacing', 'detail-rescale', 'probe-value'].forEach((id) => { $(id).textContent = '—'; });
      $('probe-coordinate').textContent = 'Choose the probe tool';
      $('probe-stored').textContent = 'Original samples remain available';
      $('frame-memory').textContent = '—';
      $('cache-memory').textContent = '—';
      $('source-memory').textContent = '—';
      $('pipeline-source').textContent = 'No image source';
      $('pipeline-source-detail').textContent = 'Choose files, a demo, or a URL';
      $('pipeline-pixels').textContent = 'No pixel data loaded';
      $('window-width').value = '';
      $('window-center').value = '';
      drawAnnotations();
    }
    savePane();
    updateLibrary();
    updateFrameControls();
    if (!state.frame) updateMeasurements();
  }

  function saveTransform() {
    return { zoom: viewport.state.zoom, panX: viewport.state.panX, panY: viewport.state.panY, rotation: viewport.state.rotation ?? viewport.state.rotationdeg ?? 0, flipX: viewport.state.flipX, flipY: viewport.state.flipY, invert: viewport.state.invert };
  }

  function updateLibrary() {
    updateLocalLibrary();
    archiveBrowser.updateSelection(state.sourceType === 'archive' ? state.currentSeries?.seriesUid : null);
    $('archive-stack-section').hidden = state.sourceType !== 'archive' || state.series.length < 2;
    $('archive-stack-select').replaceChildren();
    if (state.sourceType === 'archive') state.series.forEach((series, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = `${series.modality || 'DICOM'} stack ${index + 1} · ${series.frames.length} images`;
      option.selected = series === state.currentSeries;
      $('archive-stack-select').append(option);
    });
    root.querySelectorAll('[data-demo]').forEach((button) => {
      const active = state.sourceType === 'demo' && button.dataset.demo === state.activeDemo;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    const libraryTypes = new Set(state.series.map(series => origins.get(series)?.sourceType));
    const onlyDemo = libraryTypes.size === 1 && libraryTypes.has('demo');
    $('imported-section').hidden = Boolean(localSession.patientId) || onlyDemo || !state.series.length;
    $('imported-heading').textContent = libraryTypes.size > 1 || state.series.some(series => series.studyUid !== state.series[0].studyUid) ? 'LOADED SERIES' : ['url', 'archive'].includes(state.sourceType) ? 'REMOTE SERIES' : 'LOCAL SERIES';
    $('imported-count').textContent = `${state.series.length}`;
    $('imported-list').replaceChildren();
    if (!onlyDemo) state.series.forEach((series, index) => {
      const button = document.createElement('button');
      button.className = `imported-series ${series.id === state.currentSeries?.id ? 'active' : ''}`;
      button.setAttribute('aria-pressed', String(series.id === state.currentSeries?.id));
      const modality = document.createElement('span');
      modality.className = 'imported-modality';
      modality.textContent = series.modality || 'DCM';
      const copy = document.createElement('span');
      const title = document.createElement('strong');
      title.textContent = series.description || `${series.modality || 'DICOM'} series ${index + 1}`;
      const details = document.createElement('small');
      details.textContent = `${series.frames.length} frame${series.frames.length === 1 ? '' : 's'}`;
      copy.append(title, details);
      const thumbnail = thumbnails.get(thumbnailKeys.get(series));
      if (thumbnail) {
        const preview = document.createElement('canvas'); preview.className = 'imported-thumbnail';
        preview.width = thumbnail.columns; preview.height = thumbnail.rows; preview.setAttribute('aria-hidden', 'true');
        const context = preview.getContext('2d');
        if (context) context.putImageData(new ImageData(thumbnail.rgba, thumbnail.columns, thumbnail.rows), 0, 0);
        button.append(preview);
      } else button.append(modality);
      button.append(copy);
      button.addEventListener('click', () => selectSeries(series));
      $('imported-list').append(button);
    });
    $('workspace-name').textContent = state.sourceLabel;
    updatePaneAssignment();
    updateSessionLibrary();
  }

  function updateFrameControls() {
    updateInspector();
    const count = state.currentSeries?.frames.length || 0;
    $('frame-slider').max = Math.max(0, count - 1);
    $('frame-slider').value = state.index;
    $('frame-slider').disabled = count < 2 || !state.frame;
    $('frame-slider').style.setProperty('--range-progress', `${count > 1 ? (state.index / (count - 1)) * 100 : 0}%`);
    $('frame-slider').setAttribute('aria-valuetext', `Frame ${state.index + 1} of ${count}`);
    $('frame-number').textContent = String(state.index + 1).padStart(2, '0');
    $('frame-total').textContent = ` / ${count || '—'}`;
    $('previous-frame').disabled = count < 2 || !state.frame || state.index === 0;
    $('next-frame').disabled = count < 2 || !state.frame || state.index >= count - 1;
    $('open-reconstruction').disabled = count < 2 || !state.frame || state.busy;
    $('open-specialty').disabled = sessionCatalog.getSeries(sessionOrigins.get(state.currentSeries)?.seriesId)?.kind !== 'local' || state.busy;
    $('cine-toggle').disabled = count < 2 || !state.frame;
    $('cine-fps').disabled = count < 2;
    const color = isColorFrame(state.frame);
    $('window-width').disabled = !state.frame || color;
    $('window-center').disabled = !state.frame || color;
    $('window-presets').querySelectorAll('button').forEach((button) => { button.disabled = !state.frame || color; });
    root.querySelector('[data-tool="window"]').disabled = color;
    $('invert-view').disabled = color;
    $('color-display-note').hidden = !color;
    $('color-display-note').textContent = state.frame?.photometric === 'PALETTE COLOR' ? 'Original palette indices map through the DICOM color table. Grayscale window and inversion do not apply.' : 'Decoded RGB channels are displayed directly. Window, level and grayscale inversion do not apply.';
    $('detail-frames').textContent = count || '—';
  }

  function updateWindow() {
    if (!state.frame) return;
    const color = isColorFrame(state.frame);
    $('window-overlay').textContent = color ? frameColorLabel(state.frame) : viewport.state.voiMode === 'lut' ? 'VOI LUT' : `W ${number(viewport.state.width)} · L ${number(viewport.state.center)}`;
    const activeElement = root.getRootNode().activeElement;
    if (activeElement !== $('window-width')) $('window-width').value = color ? '' : Number(viewport.state.width.toFixed(2));
    if (activeElement !== $('window-center')) $('window-center').value = color ? '' : Number(viewport.state.center.toFixed(2));
    $('zoom-overlay').textContent = `${Math.round(viewport.state.zoom * 100)}%`;
    $('flip-view').classList.toggle('active', Boolean(viewport.state.flipX));
    $('flip-view').setAttribute('aria-pressed', String(Boolean(viewport.state.flipX)));
    $('invert-view').classList.toggle('active', Boolean(viewport.state.invert));
    $('invert-view').setAttribute('aria-pressed', String(Boolean(viewport.state.invert)));
    drawAnnotations();
    updateReadingStatus();
  }

  function updateDetails() {
    if (activePane.slot === workspace.activeSlot) aiAssist?.sync();
    const frame = state.frame;
    if (!frame) { updateImageNotices(); return; }
    updateInspector();
    const color = isColorFrame(frame);
    if (color && state.tool === 'window') chooseTool('pan');
    updateImageNotices();
    // Keep image and annotation coordinates current after updating pane controls.
    viewport.resize();
    const modality = state.currentSeries?.modality || 'DICOM';
    const demo = DEMOS.find((item) => item.id === state.activeDemo);
    $('modality-badge').textContent = modality;
    $('source-badge').textContent = state.sourceType === 'demo' ? 'SYNTHETIC DATA' : ['url', 'archive'].includes(state.sourceType) ? 'REMOTE SOURCE' : 'LOCAL FILES';
    $('image-title').textContent = state.sourceType === 'demo' ? demo?.title || 'Synthetic image' : `${modality} series`;
    $('frame-overlay').textContent = `Image ${String(state.renderedIndex + 1).padStart(2, '0')} / ${state.currentSeries.frames.length}`;
    $('pixel-overlay').textContent = `${frame.columns} × ${frame.rows} · ${color ? frameColorLabel(frame) : frame.samples.constructor.name.replace('Array', '')}`;
    $('sampling-overlay').textContent = frame.pixelSpacing ? `${number(frame.pixelSpacing[0], 3)} × ${number(frame.pixelSpacing[1], 3)} mm`
      : frame.pixelAspectRatio ? `Uncalibrated · aspect ${frame.pixelAspectRatio.join(':')}` : 'Uncalibrated pixels';
    $('detail-modality').textContent = modality;
    $('detail-matrix').textContent = `${frame.columns} × ${frame.rows}`;
    $('detail-samples').textContent = color ? frame.photometric === 'PALETTE COLOR' ? 'Original palette indices' : 'RGB · 3 × Uint8' : frame.samples.constructor.name.replace('Array', '');
    $('detail-photometric').textContent = frame.photometric || '—';
    $('detail-spacing').textContent = frame.pixelSpacing ? `${number(frame.pixelSpacing[0], 3)} × ${number(frame.pixelSpacing[1], 3)} mm` : 'Not available';
    $('detail-rescale').textContent = color ? 'Color display' : frame.modalityLut ? 'Modality LUT' : `× ${number(frame.slope ?? 1, 4)} ${Number(frame.intercept) < 0 ? '−' : '+'} ${number(Math.abs(frame.intercept || 0), 4)}`;
    $('frame-memory').textContent = bytes(frame.samples.byteLength);
    $('cache-memory').textContent = bytes(state.currentSeries?.cacheBytes || 0);
    $('source-memory').textContent = bytes(state.series.reduce((sum, series) => sum + (series.sourceBytes || 0), 0));
    $('pipeline-pixels').textContent = `${frame.samples.constructor.name} · ${color ? frame.photometric === 'PALETTE COLOR' ? 'original palette indices' : 'original RGB channels' : frame.unit || 'stored intensity'}`;
    const backend = String(viewport.backend || 'Renderer');
    $('renderer-label').textContent = backend;
    $('pipeline-renderer').textContent = backend;
    $('pipeline-source').textContent = state.sourceType === 'demo' ? 'Synthetic DICOM' : state.sourceType === 'archive' ? 'DICOMweb archive' : state.sourceType === 'url' ? 'HTTP / DICOMweb' : 'Local files';
    $('pipeline-source-detail').textContent = state.sourceType === 'demo' ? 'In-memory test fixture' : state.sourceType === 'archive' ? 'Metadata first · selected instance' : state.sourceType === 'url' ? 'Browser fetch · streaming response' : 'File API · no upload';
    $('window-presets').querySelectorAll('[data-preset]').forEach((button) => {
      button.hidden = button.dataset.preset !== 'auto' && modality !== 'CT';
      button.classList.remove('active');
    });
    updateFrameControls();
    updateWindow();
    updateProbe();
    updateMeasurements();
  }

  function updateProbe() {
    const value = state.frame && state.probePoint ? probe(state.frame, state.probePoint.x, state.probePoint.y) : null;
    $('probe-coordinate').textContent = value ? `Pixel (${value.x}, ${value.y})` : state.tool === 'probe' ? 'Point at a pixel in the image' : 'Choose the probe tool';
    $('probe-value').replaceChildren();
    $('probe-value').append(document.createTextNode(value ? value.rgb ? value.rgb.join(', ') : number(value.rescaled, 2) : '—'));
    const unit = document.createElement('span');
    unit.textContent = value ? ` ${value.rgb ? 'RGB' : value.unit || 'intensity'}` : state.frame?.unit ? ` ${state.frame.unit}` : '';
    $('probe-value').append(unit);
    $('probe-stored').textContent = value ? value.rgb && typeof value.stored === 'number' ? `Stored index: ${number(value.stored)} · R ${value.rgb[0]} · G ${value.rgb[1]} · B ${value.rgb[2]}` : value.rgb ? `R ${value.rgb[0]} · G ${value.rgb[1]} · B ${value.rgb[2]}` : `Stored: ${number(value.stored, 2)}${value.padding ? ' · padding value' : ''}` : 'Original samples remain available';
    drawAnnotations();
  }

  function drawAnnotations() {
    const layer = $('annotation-layer');
    const rect = canvas.getBoundingClientRect();
    layer.setAttribute('viewBox', `0 0 ${Math.max(1, rect.width)} ${Math.max(1, rect.height)}`);
    layer.replaceChildren();
    if (!state.frame) { activePane.overlay.clear(); activePane.annotations.render(); return; }
    const svg = (name, attributes, content) => {
      const node = document.createElementNS('http://www.w3.org/2000/svg', name);
      Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
      if (content !== undefined) node.textContent = content;
      layer.append(node);
      return node;
    };
    if (state.probePoint && probe(state.frame, state.probePoint.x, state.probePoint.y)) {
      const value = probe(state.frame, state.probePoint.x, state.probePoint.y);
      const point = viewport.imageToScreen(value.x + 0.5, value.y + 0.5);
      svg('circle', { cx: point.x, cy: point.y, r: 9, class: 'probe-reticle' });
      svg('path', { d: `M ${point.x - 14} ${point.y} h 9 M ${point.x + 5} ${point.y} h 9 M ${point.x} ${point.y - 14} v 9 M ${point.x} ${point.y + 5} v 9`, class: 'probe-reticle' });
    }
    if (state.measurement) {
      const [start, end] = state.measurement;
      const a = viewport.imageToScreen(start.x, start.y);
      const b = viewport.imageToScreen(end.x, end.y);
      const distance = measureDistance([start, end], state.frame.pixelSpacing);
      const label = `${number(distance.value, 2)} ${distance.unit}${distance.calibrated ? '' : ' · uncalibrated'}`;
      svg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'measurement-line' });
      svg('circle', { cx: a.x, cy: a.y, r: 3.5, class: 'measurement-endpoint' });
      svg('circle', { cx: b.x, cy: b.y, r: 3.5, class: 'measurement-endpoint' });
      const labelWidth = Math.min(230, Math.max(85, label.length * 6.8 + 20));
      const x = Math.min(Math.max(labelWidth / 2 + 6, (a.x + b.x) / 2), rect.width - labelWidth / 2 - 6);
      const y = Math.min(Math.max(20, (a.y + b.y) / 2 - 15), rect.height - 15);
      svg('rect', { x: x - labelWidth / 2, y: y - 16, width: labelWidth, height: 25, rx: 5, class: 'measurement-label-bg' });
      svg('text', { x, y, class: 'measurement-label', 'text-anchor': 'middle' }, label);
    }
    activePane.annotations.render();
    derived.drawGraphics(state.frame, layer, viewport, { presentationSopUid: activePane.presentation?.document.sopUid ?? null });
    activePane.overlay.resize();
  }

  function drawAllAnnotations() {
    for (const pane of panes) usePane(pane, drawAnnotations);
  }

  async function requestFrame(index, { reset = false, cine = false, aiEvidence = null } = {}) {
    if (readingOperation) return false;
    const pane = activePane;
    invalidateSync();
    const session = workspace.slots[pane.slot];
    const previousView = { ...pane.view };
    const previousSession = { lease: session.lease?.retain() ?? null, series: session.series, frame: session.frame, frameIndex: session.frameIndex, window: session.window, camera: session.camera };
    const previousTransform = pane.viewport.state;
    const series = state.currentSeries;
    if (!series?.frames.length) { previousSession.lease?.release(); return false; }
    const nextIndex = Math.min(Math.max(0, Math.round(index)), series.frames.length - 1);
    state.frameController?.abort();
    const controller = new AbortController();
    state.frameController = controller;
    const token = ++state.frameToken;
    state.index = nextIndex;
    state.frameBusy = true;
    state.frameRequestIsCine = cine;
    updateFrameControls();
    updateBusy();
    const oldTransform = saveTransform();
    const oldWindow = { center: viewport.state.center, width: viewport.state.width, windowOverride: viewport.state.windowOverride, voiMode: viewport.state.voiMode };
    savePane();
    const onMeasure = measure(state.sourceType, () => token === pane.view.frameToken && series === pane.view.currentSeries);
    let finishDisplay;
    try {
      const lease = leaseFor(series);
      const onFrame = frame => {
        if (aiEvidence && !aiSourceBindings.matches(aiEvidence, state.series, series, frame)) throw new Error('The captured AI evidence image changed before display. Select its source evidence again.');
        finishDisplay = beginMeasure(onMeasure, 'display', { signal: controller.signal });
        pane.viewport.setFrame(displayFrame(frame, pane.presentation?.document)); pane.overlay.resize();
        const actualIndex = series.frames.findIndex(descriptor => descriptor.id === frame.id);
        Object.assign(pane.view, { frame, index: actualIndex < 0 ? nextIndex : actualIndex, renderedIndex: actualIndex < 0 ? nextIndex : actualIndex, probePoint: null, measurement: null });
        if (pane === activePane) Object.assign(state, { frame, index: pane.view.index, renderedIndex: pane.view.renderedIndex, probePoint: null, measurement: null });
      };
      const frame = session.series === series
        ? await session.requestFrame(nextIndex, { signal: controller.signal, onMeasure, onFrame })
        : await session.assignSeries(lease, series.id, { index: nextIndex, signal: controller.signal, onMeasure, onFrame });
      if (state.disposed || controller.signal.aborted || token !== pane.view.frameToken || series !== pane.view.currentSeries) return false;
      const rendered = usePane(pane, () => {
      // The renderer submission committed atomically with this pane's model frame.
      if (reset) {
        viewport.reset();
        const clock = $('cine-fps');
        const previousRate = clock.value;
        clock.querySelectorAll('[data-native-rate]').forEach(option => option.remove());
        clock.value = previousRate;
        if (!clock.value || clock.value === 'native') clock.value = '20';
        const recorded = nativePlaybackAvailable(series.frames);
        if (recorded && frame.timingMode === 'vector') {
          const option = document.createElement('option');
          option.value = 'native'; option.textContent = 'Recorded timing'; option.dataset.nativeRate = 'true';
          clock.append(option); clock.value = 'native';
        } else if (recorded && Number.isFinite(frame.frameTime) && frame.frameTime > 0) {
          const rate = 1000 / frame.frameTime;
          const nativeOption = Array.from($('cine-fps').options).find((option) => Math.abs(Number(option.value) - rate) < 1e-9);
          if (nativeOption) $('cine-fps').value = nativeOption.value;
          else {
            const option = document.createElement('option');
            option.value = String(rate);
            option.textContent = `${number(rate, 2)} fps`;
            option.dataset.nativeRate = 'true';
            option.title = 'Rate from the DICOM Frame Time';
            $('cine-fps').append(option);
            $('cine-fps').value = option.value;
          }
        }
      } else {
        viewport.setTransform(oldTransform);
        if (!isColorFrame(frame) && oldWindow.windowOverride && Number.isFinite(oldWindow.center) && oldWindow.width > 0) viewport.setWindow(oldWindow.center, oldWindow.width);
      }
      state.frame = frame;
      // Progressive sources can insert an earlier slice while decoding is in flight.
      // Keep navigation attached to the displayed frame ID after geometry sorting.
      const actualIndex = series.frames.findIndex((descriptor) => descriptor.id === frame.id);
      state.renderedIndex = actualIndex < 0 ? nextIndex : actualIndex;
      state.index = state.renderedIndex;
      session.frameIndex = state.renderedIndex;
      state.probePoint = null;
      state.measurement = null;
      rememberThumbnail(series, frame);
      updateLibrary();
      updateDetails();
      if (!state.busy) status(`${state.sourceType === 'demo' ? 'Synthetic study' : ['url', 'archive'].includes(state.sourceType) ? 'Remote study' : 'Local study'} ready · ${series.frames.length} frame${series.frames.length === 1 ? '' : 's'}`);
      finishDisplay('success', { decodedBytes: frame.samples.byteLength });
      const pending = state.pendingLoad;
      if (pending?.accepted && !pending.firstDisplayed) {
        pending.firstDisplayed = true;
        pending.finishFirstDisplay('success');
      }
      updatePerformance();
      renderOverlay(pane);
      emit('framechange', { ...getState(), viewport: pane.slot });
      return true;
      });
      if (pane === activePane && !syncing) void synchronizeWorkspace();
      schedulePrefetch(pane);
      return rendered;
    } catch (error) {
      finishDisplay?.(isAbort(error) ? 'canceled' : 'error');
      if (!isAbort(error) && token === pane.view.frameToken && !state.disposed && panes.includes(pane)) usePane(pane, () => {
        pauseCine();
        const failedFrame = session.frame;
        session.cancel(); session.lease?.release(); session.lease = previousSession.lease?.retain() ?? null;
        Object.assign(session, { series: previousSession.series, frame: previousSession.frame, frameIndex: previousSession.frameIndex, window: previousSession.window, camera: previousSession.camera });
        if (failedFrame && failedFrame !== previousSession.frame) for (const [key, entry] of [...workspace.cache.entries]) if (entry.frame === failedFrame) workspace.cache.delete(key);
        Object.assign(state, previousView, { frameToken: token, frameController: controller, frameBusy: true });
        if (previousView.frame) { viewport.setFrame(displayFrame(previousView.frame, activePane.presentation?.document)); activePane.overlay.resize(); viewport.setTransform(previousTransform); if (previousTransform.windowOverride && !isColorFrame(previousView.frame)) viewport.setWindow(previousTransform.center, previousTransform.width); updateDetails(); }
        else { activePane.overlay.clear(); viewport.clearFrame(); }
        if (!viewport.frame) {
          state.frame = null;
          updateImageNotices();
          state.probePoint = null;
          state.measurement = null;
          viewport.clearFrame();
          drawAnnotations();
        }
        state.index = state.renderedIndex;
        showError(error, 'Unable to display this frame');
        if (!state.disposed && token === state.frameToken) updateFrameControls();
      });
      return false;
    } finally {
      previousSession.lease?.release();
      if (!state.disposed && token === pane.view.frameToken && panes.includes(pane)) usePane(pane, () => {
        state.frameBusy = false;
        state.frameRequestIsCine = false;
        updateBusy();
      });
    }
  }

  function selectSeries(series) {
    assertLocalSelectionIdle();
    if (readingOperation) return cancelReadingProtocol().then(() => { ensureActive(); return selectSeries(series); });
    pauseCine();
    invalidateSync();
    state.pointer = null;
    state.currentSeries = series;
    applyOrigin(series);
    state.index = 0;
    clearError();
    updateLibrary();
    const displayed = requestFrame(0, { reset: true });
    root.classList.remove('library-open');
    $('toggle-library').setAttribute('aria-expanded', 'false');
    return displayed;
  }

  async function openSource(loader, type, label, demoId = null, { rejectErrors = false } = {}) {
    if (closingSession) await closingSession;
    aiAssist?.invalidate();
    rememberSessionView();
    ensureActive();
    await cancelLocalSelection(); ensureActive();
    ++state.dropToken;
    await cancelReadingProtocol(); await cancelStudyContext(); ensureActive(); invalidateReadingSource();
    cancelAddition(); workspace.cancelPrefetch(); void closeReconstruction(); await specialty.close(); ensureActive();
    pauseCine();
    state.sourceController?.abort();
    state.frameController?.abort();
    ++state.frameToken;
    state.pointer = null;
    if (state.pendingLoad?.accepted) {
      const abandoned = state.series;
      const previous = state.pendingLoad.previous;
      clearWorkspaceViews();
      for (const [series, lease] of borrowedLeases) if (!previous.series.includes(series)) { workspace.releaseSource(lease); borrowedLeases.delete(series); }
      abandoned.forEach((series) => { if (!previous.series.includes(series)) series.dispose?.(); });
      restoreSource(previous, { workspaceRestore: true });
    }
    state.pendingLoad = null;
    workspace.heldFrames = [];
    const controller = new AbortController();
    state.sourceController = controller;
    const token = ++state.loadToken;
    const onMeasure = measure(type, () => token === state.loadToken);
    const finishSource = beginMeasure(onMeasure, 'source-open', { signal: controller.signal });
    const finishFirstDisplay = beginMeasure(onMeasure, 'first-display', { signal: controller.signal });
    state.frameBusy = false;
    state.busy = true;
    clearError();
    $('loading-message').textContent = `Opening ${label.toLowerCase()}`;
    $('load-progress').textContent = '';
    status('Reading DICOM source…', 'loading');
    updateBusy();
    const previous = snapshotSource();
    const pending = { token, previous, accepted: false, type, finishFirstDisplay, firstDisplayed: false };
    state.pendingLoad = pending;
    let received = false;
    const acceptSeries = async (series) => {
      if (token !== state.loadToken || controller.signal.aborted || !series?.length) return;
      state.series = series;
      if (type === 'archive') rememberArchiveImages(series);
      series.forEach(stack => origins.set(stack, { sourceType: type, sourceLabel: label, activeDemo: demoId }));
      state.sourceType = type;
      state.sourceLabel = label;
      state.activeDemo = demoId;
      if (!received) {
        received = true;
        pending.accepted = true;
        leaveLocalContext();
        clearWorkspaceViews();
        workspace.heldFrames = previous.paneViews?.map(view => view.frame).filter(Boolean) || [];
        state.currentSeries = series[0];
        applyOrigin(series[0]);
        state.frame = null;
        updateImageNotices();
        state.probePoint = null;
        state.measurement = null;
        state.index = state.renderedIndex = 0;
        viewport.clearFrame();
        updateLibrary();
        updateFrameControls();
        const displayed = await requestFrame(0, { reset: true });
        if (token !== state.loadToken || controller.signal.aborted) return;
        if (!displayed) throw new Error($('error-message').textContent || 'The initial pixel frame could not be decoded or displayed.');
      }
      if (token !== state.loadToken || controller.signal.aborted) return;
      updateLibrary();
      if (!state.frameBusy && state.frame) {
        const displayedIndex = state.currentSeries?.frames.findIndex((frame) => frame.id === state.frame.id);
        if (displayedIndex >= 0) state.index = state.renderedIndex = displayedIndex;
      }
      updateFrameControls();
      if (state.frame) updateDetails();
    };
    try {
      const series = await loader({
        signal: controller.signal,
        onMeasure,
        onSeries: acceptSeries,
        onProgress: (progress) => {
          if (token !== state.loadToken || controller.signal.aborted || !state.busy && !state.frameBusy) return;
          const phase = progress?.phase || 'reading';
          status(phase === 'ready' ? 'Source received · preparing pixels' : phase === 'parsing' ? 'Streaming DICOM through EASI JS…' : 'Reading DICOM source…', 'loading');
          $('load-progress').textContent = progress?.total ? `${bytes(progress.loaded || 0)} / ${bytes(progress.total)}` : progress?.loaded ? `${bytes(progress.loaded)} received` : '';
        },
      });
      if (token !== state.loadToken || controller.signal.aborted) {
        if (rejectErrors) throw new DOMException('The source load was canceled.', 'AbortError');
        return;
      }
      await acceptSeries(series);
      if (token !== state.loadToken || controller.signal.aborted) {
        if (rejectErrors) throw new DOMException('The source load was canceled.', 'AbortError');
        return;
      }
      if (!received) throw new Error('No supported image frames were found. Open a supported grayscale or color DICOM instance, or choose a synthetic example.');
      state.busy = false;
      workspace.heldFrames = [];
      for (const [series, lease] of borrowedLeases) if (!state.series.includes(series)) { workspace.releaseSource(lease); borrowedLeases.delete(series); }
      previous.series.forEach((oldSeries) => { if (!state.series.includes(oldSeries)) oldSeries.dispose?.(); });
      state.pendingLoad = null;
      schedulePrefetch();
      $('load-progress').textContent = `${state.series.length} series · ${bytes(state.series.reduce((sum, item) => sum + (item.sourceBytes || 0), 0))}`;
      if ($('error-banner').hidden) {
        if (state.frameBusy || !state.frame) status('Source ready · decoding frame…', 'loading');
        else status(`${type === 'demo' ? 'Synthetic study' : ['url', 'archive'].includes(type) ? 'Remote study' : 'Local study'} ready · ${state.currentSeries.frames.length} frame${state.currentSeries.frames.length === 1 ? '' : 's'}`);
      }
      root.classList.remove('library-open');
      $('toggle-library').setAttribute('aria-expanded', 'false');
      const completedState = getState();
      finishSource('success');
      updatePerformance();
      emit('sourcechange', completedState);
      return completedState;
    } catch (error) {
      const outcome = isAbort(error) ? 'canceled' : 'error';
      finishSource(outcome);
      if (!pending.firstDisplayed) finishFirstDisplay(outcome);
      if (!isAbort(error) && token === state.loadToken) {
        state.busy = false;
        state.frameController?.abort();
        ++state.frameToken;
        state.frameBusy = false;
        if (received) {
          clearWorkspaceViews();
          for (const [series, lease] of borrowedLeases) if (!previous.series.includes(series)) { workspace.releaseSource(lease); borrowedLeases.delete(series); }
          restoreSource(previous, { workspaceRestore: true });
        }
        state.pendingLoad = null;
        showError(error);
      }
      if (rejectErrors) {
        if (state.disposed || controller.signal.aborted || token !== state.loadToken) throw new DOMException('The source load was canceled.', 'AbortError');
        throw error;
      }
    } finally {
      // Early exits after supersession still close measurements without a stale success.
      finishSource(controller.signal.aborted || token !== state.loadToken ? 'canceled' : 'error');
      if (!pending.firstDisplayed) finishFirstDisplay(controller.signal.aborted || token !== state.loadToken ? 'canceled' : 'error');
      if (token === state.loadToken) {
        state.busy = false;
        updateBusy();
        updatePerformance();
      }
    }
  }

  function sessionPatientForLocal(id) {
    return sessionCatalog.getView().patients.find(patient => patient.kind === 'local' && patient.provenance.patientId === id) ?? null;
  }
  function syncLegacyLocalPlan(plan) {
    const patient = sessionPatientForLocal(plan.patientId);
    if (!patient) return;
    const mapStudy = id => patient.studies.find(study => study.provenance.studyId === id);
    const mapSeries = id => patient.studies.flatMap(study => study.series).find(series => series.provenance.seriesId === id);
    const opaque = { patientId: patient.id, currentStudyId: mapStudy(plan.currentStudyId)?.id ?? null,
      comparisonStudyId: mapStudy(plan.comparisonStudyId)?.id ?? null,
      selections: plan.selections.map(selected => ({ ...selected, patientId: patient.id, studyId: mapStudy(selected.studyId).id, seriesId: mapSeries(selected.seriesId).id })) };
    for (const stack of state.series) {
      const origin = localOrigins.get(stack), metadata = origin && mapSeries(origin.seriesId);
      if (metadata) sessionOrigins.set(stack, { patientId: patient.id, studyId: metadata.studyId, seriesId: metadata.id });
    }
    for (const [id, entry] of localLoaded) {
      const metadata = mapSeries(id); if (metadata) sessionLoaded.set(metadata.id, entry);
    }
    sessionReading.update(sessionCatalog.getView()); sessionReading.commit(opaque); sessionCatalog.selectPatient(patient.id); sessionDisplayPlan = opaque;
  }
  async function associateSessionPatients(fromId, toId, options = {}) {
    ensureActive(); assertLocalSelectionIdle();
    const from = sessionCatalog.getPatient(fromId), to = sessionCatalog.getPatient(toId);
    if (!options || Object.getPrototypeOf(options) !== Object.prototype || Reflect.ownKeys(options).some(key => key !== 'confirmed') || options.confirmed !== true || !from || !to || from.id === to.id || from.kind !== 'local' || to.kind !== 'local' || from.sourceId !== to.sourceId) {
      throw new Error('Review and confirm two local patient records before associating them.');
    }
    if (closingSession || state.busy || panes.some(pane => pane.view.frameBusy) || localImportController || additionController || readingOperation || contextOperation) throw new Error('Finish the current image operation before associating patient records.');
    const sourceAnnotations = localAnnotations.active === fromId ? annotations.getState().count : localAnnotations.documents.get(fromId)?.document.annotations.length;
    if (sourceAnnotations) throw new Error('Export and clear measurements for the outside patient records before associating them.');
    const commitAssociation = sessionCatalog.prepareLocalAssociation(fromId, toId, options);
    const switchAnnotations = localAnnotations.active === fromId ? localAnnotations.prepare(toId, annotations) : null;
    const roles = sessionReading.getState(), legacyRoles = localSession.getState();
    const remapPlan = plan => plan && ({ ...plan, patientId: plan.patientId === fromId ? toId : plan.patientId,
      ...(plan.rolePlan ? { rolePlan: remapPlan(plan.rolePlan) } : {}),
      selections: plan.selections.map(selected => ({ ...selected, patientId: selected.patientId === fromId ? toId : selected.patientId })) });
    // Both catalogs validate before changing ownership. No await or external
    // source callback may intervene between the private and session commits.
    savePane(); rememberSessionView(); beginSessionNavigation(); sessionDrag.clear(); clearSessionDropTargets(); pauseCine(); invalidateSync(); workspace.cancelPrefetch();
    localCatalog.confirmAssociation(from.provenance.patientId, to.provenance.patientId, { confirmed: true });
    commitAssociation();
    const stacks = new Set([...state.series, ...panes.map(pane => pane.view.currentSeries),
      ...[...sessionLoaded.values(), ...localLoaded.values()].flatMap(entry => entry.stacks)].filter(Boolean));
    for (const stack of stacks) {
      const origin = sessionOrigins.get(stack);
      if (origin?.patientId === fromId) sessionOrigins.set(stack, { ...origin, patientId: toId });
      const local = localOrigins.get(stack);
      if (local?.patientId === from.provenance.patientId) localOrigins.set(stack, { ...local, patientId: to.provenance.patientId });
    }
    const sourcePlan = savedPatientViews.get(fromId);
    savedPatientViews.delete(fromId);
    if (!savedPatientViews.has(toId) && sourcePlan) savedPatientViews.set(toId, remapPlan(sourcePlan));
    sessionDisplayPlan = remapPlan(sessionDisplayPlan);
    if (switchAnnotations) switchAnnotations();
    localAnnotations.documents.delete(fromId);
    refreshLocalCatalog();
    if (legacyRoles.activePatientId === from.provenance.patientId) Object.assign(localSession, {
      patientId: to.provenance.patientId, currentStudyId: legacyRoles.currentStudyId, comparisonStudyId: legacyRoles.comparisonStudyId });
    sessionReading.update(sessionCatalog.getView());
    if (roles.activePatientId === fromId) Object.assign(sessionReading, {
      patientId: toId, currentStudyId: roles.currentStudyId, comparisonStudyId: roles.comparisonStudyId });
    if (sessionReading.patientId) { sessionCatalog.selectPatient(sessionReading.patientId); syncSessionPaneRoles(); }
    // Series IDs do not change, so cached stacks and pane positions remain
    // owned by their original series while the patient workspace is updated.
    for (const [id, entry] of sessionLoaded) if (!sessionCatalog.getSeries(id)) { releaseLocalStacks(entry.stacks); sessionLoaded.delete(id); }
    sessionError = ''; refreshSessionCatalog(); updateLibrary(); updateFrameControls(); updateBusy(); drawAllAnnotations(); renderAllOverlays();
    status('Patient records associated for this viewing session'); emit('librarychange', getSessionState()); return getSessionState();
  }
  function clearSessionDropTargets() { for (const pane of panes) pane.element.classList.remove('session-drop-target'); }
  function bindSessionDrop(pane) {
    const signal = pane.lifetime.signal;
    pane.element.addEventListener('dragover', event => {
      if (!sessionDrag.accepts(event.dataTransfer)) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy';
      clearSessionDropTargets(); pane.element.classList.add('session-drop-target');
    }, { signal });
    pane.element.addEventListener('dragleave', event => {
      if (!pane.element.contains(event.relatedTarget)) pane.element.classList.remove('session-drop-target');
    }, { signal });
    pane.element.addEventListener('drop', event => {
      if (!Array.from(event.dataTransfer?.types ?? []).includes(SESSION_ITEM_TYPE)) return;
      event.preventDefault(); event.stopPropagation(); clearSessionDropTargets();
      const selected = sessionDrag.consume(event.dataTransfer);
      if (!selected || !panes.includes(pane) || state.disposed) return;
      const action = selected.instanceId ? openSessionInstance(selected.instanceId, { seriesId: selected.seriesId, viewport: pane.slot })
        : openSessionSeries(selected.seriesId, { viewport: pane.slot, stackIndex: selected.stackIndex, frameIndex: 0 });
      action.catch(error => { if (!state.disposed && !isAbort(error)) { sessionError = error.message; updateSessionLibrary(); } });
    }, { signal });
  }
  function emptySessionPlan(patientId) {
    return { patientId, currentStudyId: null, comparisonStudyId: null, selections: [], layout: panes.length, activeSlot: activePane.slot };
  }
  function syncSessionPaneRoles() {
    if (!sessionReading.patientId || !sessionCatalog.getPatient(sessionReading.patientId)) return;
    savePane(); const plan = viewportSessionPlan() ?? emptySessionPlan(sessionReading.patientId);
    sessionReading.update(sessionCatalog.getView()); sessionReading.commit(plan.rolePlan ?? plan);
    sessionDisplayPlan = plan; savedPatientViews.set(plan.patientId, plan);
  }
  async function clearViewport(slot) {
    ensureActive(); await cancelLocalSelection(); await cancelReadingProtocol(); ensureActive();
    if (!Number.isSafeInteger(slot) || !panes[slot]) throw new RangeError('Choose a pane in the current layout.');
    pauseCine(); invalidateSync(); workspace.cancelPrefetch();
    const pane = panes[slot]; pane.view.frameController?.abort(); workspace.slots[slot].clear();
    Object.assign(pane.view, { sourceType: 'empty', sourceLabel: 'No image', activeDemo: null, currentSeries: null,
      frame: null, index: 0, renderedIndex: 0, frameToken: pane.view.frameToken + 1, frameController: null,
      frameBusy: false, frameRequestIsCine: false, pointer: null, probePoint: null, measurement: null });
    pane.presentation = null; pane.overlay.clear(); pane.viewport.clearFrame(); pane.annotations.cancelDraft(); pane.annotations.render();
    pane.element.querySelector('[data-pane-id="viewport-empty"]').hidden = false;
    pane.element.querySelector('[data-pane-id="viewport-loading"]').hidden = true; pane.element.classList.remove('frame-loading');
    if (pane === activePane) { Object.assign(state, pane.view); updateInspector(); updateDetails(); updateFrameControls(); }
    syncSessionPaneRoles(); updateLibrary(); updateBusy(); emit('viewportchange'); return getWorkspaceState();
  }
  async function closeSession() {
    ensureActive(); if (closingSession) return closingSession;
    aiAssist?.invalidate();
    const operation = (async () => {
      beginSessionNavigation(); sessionDrag.clear(); clearSessionDropTargets(); openWorkflow.close(); localPreview.clear();
      cancelLocalImport(); cancelAddition(); state.sourceController?.abort(); ++state.loadToken; ++state.dropToken;
      state.frameController?.abort(); pauseCine(); invalidateSync(); workspace.cancelPrefetch();
      await Promise.allSettled([localImportDone, cancelLocalSelection(), cancelReadingProtocol(), cancelStudyContext()]); ensureActive();
      await Promise.allSettled([closeReconstruction(), specialty.close()]); ensureActive();
      const sources = new Set([...state.series, ...borrowedLeases.keys(), ...[...sessionLoaded.values()].flatMap(entry => entry.stacks)]);
      clearWorkspaceViews(); releaseLocalStacks([...sources]); state.series = []; state.pendingLoad = null; state.busy = false; state.frameBusy = false;
      localLoaded.clear(); sessionLoaded.clear(); savedPatientViews.clear();
      sessionReading.clear(); sessionDisplayPlan = null; sessionCatalog.clear(); localSession.clear(); localCatalog.clear();
      imageNotices.clear();
      sourceRegistry.clearSearchHistory(); archiveBrowser.resetQueries();
      localAnnotations.clear(); annotations.clear(); annotations.clearHistory(); derived.clear(); thumbnails.clear();
      localImportSummary = null; localMediaReport = null; localImportProgress = null; localLibraryError = ''; sessionError = '';
      refreshLocalCatalog(); refreshSessionCatalog(); restoreSource(snapshotSource());
      readingApplied = null; ++readingRevision; readingPanel.clear(); clearError(); updateLibrary(); updateFrameControls(); updateBusy();
      $('workspace-name').textContent = 'No image'; status('Session closed · choose Open… to begin');
      emit('librarychange', getSessionState()); emit('sourcechange'); return getSessionState();
    })();
    closingSession = operation;
    try { return await operation; } finally { if (closingSession === operation) closingSession = null; primaryMenu?.refresh(); }
  }
  async function listSessionInstances(seriesId, { signal } = {}) {
    ensureActive(); const metadata = sessionCatalog.getSeries(seriesId);
    if (!metadata) throw new Error('Choose a series in this session.');
    if (metadata.instancesLoaded) return structuredClone(metadata.instances);
    if (metadata.kind !== 'remote') return [];
    const controller = new AbortController(), lifetime = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    sessionMetadataControllers.add(controller);
    try {
      const origin = metadata.provenance, patient = sessionCatalog.getPatient(metadata.patientId);
      const values = await sourceRegistry.getClient(origin.sourceId).getSeriesMetadata(origin.studyUid, origin.seriesUid, { signal: lifetime });
      if (state.disposed || lifetime.aborted || !sessionCatalog.getSeries(seriesId)) throw new DOMException('The image list was canceled.', 'AbortError');
      const instances = instanceNavigation(values, { patient, sourceId: origin.sourceId, studyUid: origin.studyUid, seriesUid: origin.seriesUid });
      sessionCatalog.setSeriesInstances(seriesId, instances); refreshSessionCatalog(); return structuredClone(sessionCatalog.getSeries(seriesId).instances);
    } finally { sessionMetadataControllers.delete(controller); }
  }
  function findSessionInstance(instanceId, seriesId) {
    for (const patient of sessionCatalog.getView().patients) for (const study of patient.studies) for (const series of study.series) {
      if (seriesId && series.id !== seriesId) continue;
      const instance = series.instances.find(item => item.id === instanceId); if (instance) return { patient, study, series, instance };
    }
    throw new Error('Choose an image in this viewing session.');
  }
  async function openSessionInstance(instanceId, options = {}) {
    const { series, instance } = findSessionInstance(instanceId, options.seriesId);
    return openSessionSeries(series.id, { ...options, instanceId: instance.id, frameIndex: 0 });
  }
  function loadedInstanceDescriptors(stacks, seriesId) {
    const records = new Map();
    for (const [stackIndex, stack] of stacks.entries()) for (const [index, frame] of stack.frames.entries()) {
      const old = records.get(frame.sopUid), encodedIndex = frame.frameIndex ?? 0;
      const record = frame._record ?? frame._metadata;
      if (!old || encodedIndex < old.encodedIndex) records.set(frame.sopUid, { id: `${seriesId}-instance-${records.size + 1}`, sopUid: frame.sopUid,
        sopClassUid: record?.sopClass ?? record?.sopClassUid ?? '', instanceNumber: frame.instanceNumber ?? null,
        frameCount: record?.frameCount ?? 1, stackIndex, frameIndex: index, encodedIndex });
    }
    return [...records.values()].map(({ encodedIndex, ...instance }) => instance);
  }
  function getSessionState() {
    const view = sessionCatalog.getView();
    return { ...view.counts, ...sessionReading.getState(), busy: Boolean(localSelectionOperation), disposed: state.disposed };
  }
  function refreshSessionCatalog() {
    ++sessionRevision; sessionReading.update(sessionCatalog.getView()); updateSessionLibrary();
  }
  function updateSessionLibrary() {
    if (!sessionPanel || state.disposed) return;
    const view = sessionCatalog.getView(), selected = sessionOrigins.get(state.currentSeries);
    const paneAssignments = panes.map(pane => {
      const origin = pane.view.frame ? sessionOrigins.get(pane.view.currentSeries) : null, metadata = origin && sessionCatalog.getSeries(origin.seriesId);
      const descriptor = pane.view.currentSeries?.frames[pane.view.renderedIndex];
      const instanceId = metadata?.instances.find(instance => instance.sopUid === descriptor?.sopUid)?.id ?? null;
      return { viewport: pane.slot, slot: pane.slot, paneIndex: pane.slot, seriesId: origin?.seriesId ?? null, instanceId };
    });
    const presentation = { ...sessionReading.getState(), selectedSeriesId: selected?.seriesId ?? null, busy: Boolean(state.busy || localSelectionOperation), message: sessionError, paneAssignments };
    const key = JSON.stringify(presentation);
    if (view !== sessionPanelView || key !== sessionPanelKey) { sessionPanelView = view; sessionPanelKey = key; sessionPanel.setView(view, presentation); }
    const countLabel = (value, singular, plural = `${singular}s`) => `${value.toLocaleString()} ${value === 1 ? singular : plural}`;
    const summary = `${countLabel(view.counts.patients, 'patient')} · ${countLabel(view.counts.studies, 'study', 'studies')} · ${countLabel(view.counts.series, 'series', 'series')} · ${countLabel(view.counts.instances, 'instance')}`;
    if ($('session-summary').textContent !== summary) $('session-summary').textContent = summary;
    primaryMenu?.refresh();
    const patient = sessionCatalog.getPatient(sessionReading.patientId);
    const banner = $('session-patient-banner');
    banner.hidden = !patient;
    if (patient) {
      banner.textContent = patient.synthetic ? 'SYNTHETIC TEST WORKSPACE · generated examples'
        : `${patient.patientName?.replaceAll('^', ' ') || 'Unnamed patient'} · ID ${patient.patientId || 'not supplied'}${patient.patientBirthDate ? ` · DOB ${patient.patientBirthDate}` : ''} · ${patient.sourceLabel}`;
      banner.dataset.synthetic = String(Boolean(patient.synthetic));
    }
    for (const pane of panes) {
      const origin = sessionOrigins.get(pane.view.currentSeries), study = origin && sessionCatalog.getStudy(origin.studyId);
      const badge = pane.element.querySelector('.local-study-badge');
      if (!badge || !study) continue;
      const role = study.id === sessionReading.comparisonStudyId ? 'COMPARISON' : study.id === sessionReading.currentStudyId ? 'CURRENT' : 'LOADED';
      const date = /^\d{8}$/.test(study.studyDate || '') ? `${study.studyDate.slice(0,4)}-${study.studyDate.slice(4,6)}-${study.studyDate.slice(6)}` : 'Date not supplied';
      badge.hidden = !pane.view.frame; badge.textContent = `${role} · ${date}`; badge.dataset.role = role.toLowerCase();
    }
  }
  function admitIndexedLocal(selection = null) {
    const admissions = [];
    const choices = selection ?? sessionCatalog.getView().patients.filter(patient => patient.kind === 'local')
      .map(patient => ({ patientId: patient.provenance.patientId, studyIds: patient.studies.map(study => study.provenance.studyId) }));
    for (const choice of choices) if (choice.studyIds.length) admissions.push(sessionCatalog.admitLocal(localView, choice));
    refreshSessionCatalog(); return admissions;
  }
  async function commitLocalPreview(preview, selection = {}) {
    if (closingSession) await closingSession;
    ensureActive();
    const chosen = localPreview.resolve(preview, selection);
    if (state.busy || localImportController || localSelectionOperation) throw new Error('Finish opening the current images before adding this selection.');
    const controller = new AbortController(), signal = selection.signal ? AbortSignal.any([selection.signal, controller.signal]) : controller.signal;
    localImportController = controller; localImportProgress = { processed: 0, total: chosen.files.length }; updateBusy();
    const task = localCatalog.addFiles(chosen.files, { signal, references: chosen.references,
      onProgress: progress => { if (!state.disposed && !signal.aborted) localImportProgress = progress; } });
    localImportDone = task;
    try {
      const summary = await task;
      if (signal.aborted || state.disposed) throw new DOMException('Adding the selected studies was canceled.', 'AbortError');
      localMediaReport = chosen.media; localImportSummary = { added: summary.added, duplicates: summary.duplicates, failed: summary.failed };
      refreshLocalCatalog(); const admitted = admitIndexedLocal(summary.selection);
      localImportController = null;
      const addedFiles = new Set(chosen.files);
      const matching = localView.patients.filter(patient => patient.studies.some(study => study.series.some(series => localCatalog.getSeriesFiles(series.id).some(file => addedFiles.has(file)))));
      const first = admitted.find(entry => matching.some(patient => sessionCatalog.getPatient(entry.patientId)?.provenance.patientId === patient.id));
      const chosenStudy = first && sessionCatalog.getPatient(first.patientId)?.studies.find(study => {
        const original = localView.patients.flatMap(patient => patient.studies).find(item => item.id === study.provenance.studyId);
        return original?.series.some(series => localCatalog.getSeriesFiles(series.id).some(file => addedFiles.has(file)));
      });
      if (first && (!sessionReading.patientId || sessionCatalog.getPatient(sessionReading.patientId)?.synthetic || matching.length === 1 && first.patientId !== sessionReading.patientId)) {
        try { await openSessionStudy(chosenStudy?.id ?? first.studyIds[0], { signal: selection.signal }); }
        catch (error) { if (isAbort(error)) throw error; sessionError = error.message; updateSessionLibrary(); }
      }
      status(`${summary.added.toLocaleString()} images added to the session`);
      emit('librarychange', getLocalLibraryState()); return getSessionState();
    } finally {
      if (localImportController === controller) localImportController = null;
      localImportProgress = null; if (!state.disposed) updateBusy();
    }
  }
  function configureSourceFromDialog(configuration) {
    if (!openingPolicy.sourceEditing) throw new Error('Repository configuration is managed by the host application.');
    const descriptor = sourceRegistry.add({ ...configuration, id: configuration.id || `repository-${++configuredSourceSequence}` });
    return descriptor;
  }
  async function commitRemoteSelection(sourceId, patient, studies, request = {}) {
    if (closingSession) await closingSession;
    ensureActive(); if (request.signal?.aborted) throw new DOMException('The study selection was canceled.', 'AbortError');
    if (!Array.isArray(studies) || !studies.length) throw new Error('Choose at least one study to add.');
    const source = sourceRegistry.getSource(sourceId);
    const admitted = sessionCatalog.admitRemote(sourceId, patient, studies, { sourceLabel: source.name, protocol: source.type });
    refreshSessionCatalog();
    if (!sessionReading.patientId || sessionCatalog.getPatient(sessionReading.patientId)?.synthetic || admitted.patientId !== sessionReading.patientId) {
      try { await openSessionStudy(admitted.studyIds[0], { signal: request.signal }); }
      catch (error) { if (isAbort(error)) throw error; sessionError = error.message; updateSessionLibrary(); }
    }
    status(`${admitted.studyIds.length} selected studies added to the session`); emit('librarychange', getSessionState()); return getSessionState();
  }
  async function openTestWorkspace(id, request = {}) {
    if (!openingPolicy.tests) throw new Error('Synthetic examples are disabled by the application.');
    const demo = DEMOS.find(item => item.id === id);
    if (!demo) throw new TypeError('Choose a supported synthetic example.');
    if (request.signal?.aborted) throw new DOMException('Opening the example was canceled.', 'AbortError');
    const admitted = sessionCatalog.admitTest({ ...demo, description: demo.title }); refreshSessionCatalog();
    return openSessionStudy(admitted.studyIds[0], { signal: request.signal });
  }
  function beginSessionNavigation(signal) {
    if (signal?.aborted) throw new DOMException('Opening the selection was canceled.', 'AbortError');
    ++sessionNavigationRequest; localSelectionOperation?.controller.abort();
    for (const controller of sessionMetadataControllers) controller.abort();
    return sessionNavigationRequest;
  }
  function assertSessionNavigation(request, signal) {
    ensureActive(); if (signal?.aborted || request !== sessionNavigationRequest) throw new DOMException('The viewing selection was superseded.', 'AbortError');
  }
  async function ensureSessionStudy(studyId, { signal, request } = {}) {
    ensureActive(); const study = sessionCatalog.getStudy(studyId);
    if (!study) throw new Error('Choose a study in this session.');
    if (signal?.aborted) throw new DOMException('Opening the selected study was canceled.', 'AbortError');
    if (study.kind !== 'remote' || study.seriesLoaded) return study;
    const controller = new AbortController(), lifetime = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    sessionMetadataControllers.add(controller);
    try {
      const items = []; let offset = 0;
      for (let page = 0; page < 100; page++) {
        const result = await sourceRegistry.getClient(study.sourceId).listSeries(study.provenance.studyUid, { offset, limit: 100, signal: lifetime });
        assertSessionNavigation(request ?? sessionNavigationRequest, lifetime); items.push(...result.items);
        if (!result.hasMore) { sessionCatalog.setStudySeries(studyId, items); refreshSessionCatalog(); return sessionCatalog.getStudy(studyId); }
        if (!Number.isSafeInteger(result.nextOffset) || result.nextOffset <= offset) throw new Error('The repository returned an invalid series page.');
        offset = result.nextOffset;
      }
      throw new Error('The repository series list exceeds the session limit. Narrow the selection at the repository.');
    } finally { sessionMetadataControllers.delete(controller); }
  }
  function viewportSessionPlan(assignment = null) {
    const patientId = assignment?.patientId ?? sessionReading.patientId;
    const selections = panes.flatMap(pane => {
      if (assignment?.slot === pane.slot) return [{ ...assignment, slot: pane.slot, role: 'current' }];
      const origin = sessionOrigins.get(pane.view.currentSeries);
      if (!origin || origin.patientId !== patientId || !pane.view.frame) return [];
      const entry = sessionLoaded.get(origin.seriesId), stackIndex = Math.max(0, entry?.stacks.indexOf(pane.view.currentSeries) ?? 0);
      return [{ ...origin, slot: pane.slot, stackIndex, index: pane.view.renderedIndex, transform: pane.viewport.state, role: 'current' }];
    });
    if (!selections.length) return null;
    let currentStudyId = sessionReading.patientId === patientId && selections.some(item => item.studyId === sessionReading.currentStudyId) ? sessionReading.currentStudyId : selections[0].studyId;
    if (assignment?.slot === 0) currentStudyId = assignment.studyId;
    const comparisonStudyId = selections.some(item => item.studyId === sessionReading.comparisonStudyId && item.studyId !== currentStudyId)
      ? sessionReading.comparisonStudyId : selections.find(item => item.studyId !== currentStudyId)?.studyId ?? null;
    const selectedCurrent = selections.find(item => item.studyId === currentStudyId), selectedComparison = comparisonStudyId ? selections.find(item => item.studyId === comparisonStudyId) : null;
    const rolePlan = { patientId, currentStudyId, comparisonStudyId, selections: [
      { ...selectedCurrent, role: 'current' }, ...(selectedComparison ? [{ ...selectedComparison, role: 'comparison' }] : [])
    ] };
    return { patientId, currentStudyId, comparisonStudyId, selections, rolePlan, layout: panes.length, activeSlot: assignment?.slot ?? activePane.slot };
  }
  function rememberSessionView() {
    if (!sessionDisplayPlan || !sessionReading.patientId) return;
    savePane(); const plan = viewportSessionPlan(); if (plan) savedPatientViews.set(sessionReading.patientId, plan);
  }
  async function selectSessionPatient(id) {
    ensureActive(); const request = beginSessionNavigation();
    if (!sessionCatalog.getPatient(id)) throw new Error('Choose a patient in this session.');
    if (id === sessionReading.patientId) return getSessionState();
    aiAssist?.invalidate();
    const saved = savedPatientViews.get(id);
    if (saved) return displaySessionPlan(saved, 'Restoring patient workspace…', { request });
    const patient = sessionCatalog.getPatient(id), study = patient.studies[0];
    if (study) return openSessionStudy(study.id, { navigationRequest: request });
    throw new Error('This patient has no selected studies.');
  }
  async function openSessionStudy(id, selection = {}) {
    const signal = selection?.signal, request = selection?.navigationRequest ?? beginSessionNavigation(signal);
    const study = await ensureSessionStudy(id, { signal, request }); assertSessionNavigation(request, signal);
    const series = study.series.find(item => item.id === selection?.seriesId) ?? study.series.find(item => !['unsupported', 'unavailable', 'error'].includes(item.status)) ?? study.series[0];
    if (!series) throw new Error('This study has no available image series.');
    return openSessionSeries(series.id, { stackIndex: selection?.stackIndex ?? 0, signal, navigationRequest: request, replaceStudy: true });
  }
  async function openSessionSeries(id, selection = {}) {
    if (closingSession) await closingSession;
    ensureActive(); const signal = selection?.signal, request = selection?.navigationRequest ?? beginSessionNavigation(signal);
    assertSessionNavigation(request, signal); sessionReading.update(sessionCatalog.getView());
    const series = sessionCatalog.getSeries(id);
    if (!series) throw new Error('Choose a series in this session.');
    const slot = selection?.viewport ?? activePane.slot;
    if (!Number.isSafeInteger(slot) || !panes[slot]) throw new RangeError('Choose a pane in the current layout.');
    if (selection?.viewport != null && panes.some(pane => pane.view.frame && sessionOrigins.get(pane.view.currentSeries)?.patientId !== series.patientId)) {
      throw new Error('Switch to this patient in the Session library before assigning their images to a pane.');
    }
    if (selection.frameIndex != null && (!Number.isSafeInteger(selection.frameIndex) || selection.frameIndex < 0)) throw new RangeError('Choose an available image.');
    const stackIndex = selection?.stackIndex ?? 0;
    let plan = sessionReading.planSeries(id, { stackIndex });
    const assigned = { patientId: series.patientId, studyId: series.studyId, seriesId: id, slot, stackIndex,
      ...(selection.frameIndex != null ? { index: selection.frameIndex } : {}),
      ...(selection.instanceId ? { instanceId: selection.instanceId } : {}) };
    if (!selection?.replaceStudy && (series.patientId === sessionReading.patientId && panes.length > 1 || selection?.viewport != null)) {
      plan = viewportSessionPlan(assigned) ?? plan;
    } else {
      plan.selections[0] = { ...plan.selections[0], ...assigned, slot: 0 };
    }
    return displaySessionPlan(plan, 'Opening selected image…', { signal, request });
  }
  async function compareSessionStudies(currentId, comparisonId, selection = {}) {
    const { signal, navigationRequest, ...options } = selection ?? {}, request = navigationRequest ?? beginSessionNavigation(signal);
    await ensureSessionStudy(currentId, { signal, request }); await ensureSessionStudy(comparisonId, { signal, request }); assertSessionNavigation(request, signal);
    sessionReading.update(sessionCatalog.getView());
    const current = sessionDisplayPlan?.selections.find(item => item.studyId === currentId);
    return displaySessionPlan(sessionReading.planComparison(currentId, comparisonId, {
      ...(current ? { currentSeriesId: current.seriesId, currentStackIndex: current.stackIndex } : {}), ...options
    }), 'Preparing comparison…', { signal, request });
  }
  async function removeSessionPatient(id) {
    aiAssist?.invalidate();
    ensureActive(); beginSessionNavigation(); cancelLocalImport(); await Promise.allSettled([localImportDone, cancelLocalSelection()]); ensureActive();
    sessionDrag.clear(); const removedPatient = sessionCatalog.getPatient(id);
    const noticeScopes = [...(removedPatient?.studies.map(study => study.id) ?? []),
      ...(removedPatient?.kind === 'local' ? localCatalog.getPatient(removedPatient.provenance.patientId)?.studies.map(study => study.id) ?? [] : [])];
    for (const controller of sessionMetadataControllers) controller.abort();
    if (id === sessionReading.patientId) {
      rememberSessionView(); pauseCine(); clearWorkspaceViews(); releaseLocalStacks([...state.series]); state.series = [];
      sessionReading.clear(); sessionDisplayPlan = null; localSession.clear(); annotations.clear(); annotations.clearHistory(); derived.clear();
      localAnnotations.active = null;
      restoreSource(snapshotSource());
    }
    for (const [seriesId, entry] of sessionLoaded) if (sessionCatalog.getSeries(seriesId)?.patientId === id) { releaseLocalStacks(entry.stacks); sessionLoaded.delete(seriesId); }
    sessionCatalog.removePatient(id);
    if (removedPatient?.kind === 'local') { localCatalog.removePatient(removedPatient.provenance.patientId); refreshLocalCatalog(); }
    imageNotices.forgetScopes(noticeScopes);
    savedPatientViews.delete(id); localAnnotations.documents.delete(id); refreshSessionCatalog(); updateLibrary(); updateFrameControls();
    return getSessionState();
  }
  async function displaySessionPlan(plan, label, { signal, request = sessionNavigationRequest } = {}) {
    ensureActive();
    if (plan.patientId !== sessionReading.patientId) aiAssist?.invalidate();
    await cancelLocalSelection(); await cancelReadingProtocol(); await cancelStudyContext(); ensureActive();
    if (state.busy || state.frameBusy || additionController || localImportController) throw new Error('Finish opening the current images before changing the patient workspace.');
    assertSessionNavigation(request, signal); sessionReading.update(sessionCatalog.getView());
    const controller = new AbortController(), operation = { controller, label, done: null, committed: false };
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) controller.abort();
    const previous = snapshotSource(), previousRoles = sessionReading.getState(), previousPlan = sessionDisplayPlan, previousLinks = { ...synchronization };
    const previousHeld = [...workspace.heldFrames], revision = sessionRevision;
    rememberSessionView(); localSelectionOperation = operation; state.busy = true; sessionError = ''; updateBusy();
    const current = () => !state.disposed && !controller.signal.aborted && localSelectionOperation === operation && revision === sessionRevision && request === sessionNavigationRequest;
    const assertCurrent = () => { if (!current()) throw new DOMException('The viewing selection was canceled.', 'AbortError'); };
    const prepared = [], newStacks = [], replacements = new Map();
    workspace.heldFrames = [...previousHeld, ...previous.paneViews.map(view => view.frame).filter(Boolean)];
    pauseCine(); invalidateSync(); workspace.cancelPrefetch();
    operation.previous = previous;
    operation.done = (async () => {
      try {
        await closeReconstruction(); await specialty.close(); assertCurrent();
        for (const selected of plan.selections) {
          const metadata = sessionCatalog.getSeries(selected.seriesId);
          if (!metadata || metadata.patientId !== plan.patientId || metadata.studyId !== selected.studyId) throw new Error('The selected series does not belong to this patient workspace.');
          const origin = metadata.provenance, old = sessionLoaded.get(metadata.id);
          let stacks = old?.revision === metadata.revision && old.stacks.every(stack => !stack.disposed) ? old.stacks : null;
          if (!stacks) {
            const loadOptions = { signal: controller.signal, onMeasure: measure(origin.kind === 'remote' ? 'archive' : origin.kind === 'test' ? 'demo' : 'files', current) };
            stacks = origin.kind === 'local' ? await loadFiles(localCatalog.getSeriesFiles(origin.seriesId), loadOptions)
              : origin.kind === 'remote' ? await loadArchiveSeries(sourceRegistry.getClient(origin.sourceId), origin.studyUid, origin.seriesUid, { ...loadOptions, expectedPatient: Object.fromEntries(['patientId', 'issuerOfPatientId', 'patientName', 'patientBirthDate'].map(key => [key, sessionCatalog.getPatient(plan.patientId)[key] || ''])) })
                : await loadDemo(origin.demoId, loadOptions);
            newStacks.push(...stacks); replacements.set(metadata.id, { revision: metadata.revision, stacks });
            for (const stack of stacks) {
              origins.set(stack, { sourceType: origin.kind === 'remote' ? 'archive' : origin.kind === 'test' ? 'demo' : 'files', sourceLabel: metadata.sourceLabel, activeDemo: origin.demoId ?? null });
              sessionOrigins.set(stack, { patientId: plan.patientId, studyId: selected.studyId, seriesId: selected.seriesId }); leaseFor(stack);
            }
          }
          assertCurrent(); let stackIndex = selected.stackIndex ?? 0, requestedIndex = selected.index;
          if (selected.instanceId) {
            const instance = metadata.instances.find(item => item.id === selected.instanceId);
            if (!instance) throw new Error('The selected instance is no longer available.');
            let match = null;
            for (const [candidateStack, stack] of stacks.entries()) for (const [candidateIndex, descriptor] of stack.frames.entries()) {
              if (descriptor.sopUid === instance.sopUid && (!match || (descriptor.frameIndex ?? 0) < match.encodedIndex)) {
                match = { stackIndex: candidateStack, index: candidateIndex, encodedIndex: descriptor.frameIndex ?? 0 };
              }
            }
            if (!match) throw new Error('This instance has no displayable image frame in the selected series.');
            stackIndex = match.stackIndex; requestedIndex = match.index;
          }
          const series = stacks[stackIndex];
          if (!series) throw new Error('The selected image stack is unavailable.');
          const oldPane = previous.paneViews.find(view => view.currentSeries === series && view.frame);
          const index = requestedIndex ?? oldPane?.renderedIndex ?? 0;
          if (!Number.isSafeInteger(index) || index < 0 || index >= series.frames.length) throw new RangeError('The selected image is outside this stack.');
          const frame = await workspace.request(series, index, controller.signal, measure(origin.kind === 'remote' ? 'archive' : 'files', current));
          assertCurrent(); workspace.admitFrame(null, frame); workspace.heldFrames.push(frame);
          prepared.push({ ...selected, stackIndex, series, index, frame, transform: selected.transform ?? oldPane?.transform });
        }
        const ids = [...new Set(plan.selections.map(item => item.seriesId))];
        const required = ids.map(id => ({ id, stacks: (replacements.get(id) ?? sessionLoaded.get(id)).stacks }));
        const optionalIds = [...new Set(previous.series.filter(series => sessionOrigins.get(series)?.patientId === plan.patientId && !series.disposed).map(series => sessionOrigins.get(series).seriesId))].reverse();
        const optional = optionalIds.filter(id => !ids.includes(id)).map(id => ({ id, stacks: sessionLoaded.get(id)?.stacks })).filter(group => group.stacks?.every(stack => previous.series.includes(stack) && !stack.disposed));
        const { stacks: nextSeries } = planLocalWorkingSet(required, optional, { maxBytes: MAX_SOURCE_BYTES }); assertCurrent();
        const switchAnnotations = localAnnotations.prepare(plan.patientId, annotations);
        await setLayout(plan.layout ?? (prepared.length === 2 ? 2 : 1), { readingInternal: true, localInternal: true }); assertCurrent();
        clearWorkspaceViews(); state.series = nextSeries;
        for (let slot = 0; slot < prepared.length; slot++) {
          const selected = prepared[slot], pane = panes[selected.slot ?? slot], assigned = workspace.slots[selected.slot ?? slot];
          pane.viewport.setFrame(selected.frame); pane.overlay.resize();
          if (selected.transform) { pane.viewport.setTransform(selected.transform); if (selected.transform.windowOverride && !isColorFrame(selected.frame)) pane.viewport.setWindow(selected.transform.center, selected.transform.width); }
          assigned.lease = leaseFor(selected.series).retain(); assigned.series = selected.series; assigned.frame = selected.frame; assigned.frameIndex = selected.index;
          Object.assign(pane.view, { ...origins.get(selected.series), currentSeries: selected.series, frame: selected.frame, index: selected.index, renderedIndex: selected.index, frameBusy: false });
          if (pane === activePane) Object.assign(state, pane.view);
          usePane(pane, () => { updateDetails(); updateBusy(); }); assertCurrent();
        }
        sessionReading.commit(plan.rolePlan ?? plan); sessionCatalog.selectPatient(plan.patientId); localSession.clear(); switchAnnotations(); assertCurrent();
        if (previousRoles.activePatientId !== plan.patientId) { derived.clear(); thumbnails.clear(); imageNotices.clearTechnical(); }
        assertCurrent();
        sessionDisplayPlan = { ...plan, selections: prepared.map(({ series, frame, ...selection }) => selection) }; operation.committed = true;
        for (const [id, entry] of replacements) sessionLoaded.set(id, entry);
        restoreReadingLinks({ slice: false, window: false, camera: false, toleranceMm: previousLinks.toleranceMm });
        readingApplied = null; ++readingRevision; readingPanel.clear(); setActiveViewport(plan.activeSlot ?? 0); Object.assign(state, activePane.view); state.busy = false; savePane();
        prepared.forEach(item => rememberThumbnail(item.series, item.frame));
        restoreSource(snapshotSource()); drawAllAnnotations(); renderAllOverlays();
        releaseLocalStacks(previous.series.filter(series => !nextSeries.includes(series)));
        for (const [id, entry] of sessionLoaded) if (entry.stacks.some(stack => stack.disposed)) {
          const metadata = sessionCatalog.getSeries(id); if (metadata) sessionCatalog.updateSeries(id, { status: metadata.kind === 'local' ? 'indexed' : 'available' }); sessionLoaded.delete(id);
        }
        for (const item of prepared) {
          const entry = sessionLoaded.get(item.seriesId);
          const metadata = sessionCatalog.getSeries(item.seriesId);
          if (metadata.kind === 'test' && !metadata.instancesLoaded) sessionCatalog.setSeriesInstances(item.seriesId, loadedInstanceDescriptors(entry.stacks, item.seriesId));
          sessionCatalog.updateSeries(item.seriesId, { status: 'loaded', instanceCount: new Set(entry.stacks.flatMap(stack => stack.frames.map(frame => frame.sopUid))).size, frameCount: entry.stacks.reduce((sum, stack) => sum + stack.frames.length, 0),
            stackGroups: describeImageStacks(entry.stacks) });
        }
        clearError(); updateLibrary(); updateFrameControls(); updateBusy();
        status(prepared.length === 2 ? 'Comparison ready · independent views' : prepared.length ? 'Image ready' : 'Choose an image from the Session library');
        root.classList.remove('library-open'); $('toggle-library').setAttribute('aria-expanded', 'false');
        emit('librarychange', getSessionState()); emit('sourcechange'); return getSessionState();
      } catch (error) {
        if (!operation.committed && !state.disposed && localSelectionOperation === operation) {
          await setLayout(previous.paneViews.length, { readingInternal: true, localInternal: true });
          state.series = previous.series; restoreSource(previous, { workspaceRestore: true }); restoreReadingLinks(previousLinks);
          sessionDisplayPlan = previousPlan; Object.assign(sessionReading, { patientId: previousRoles.activePatientId, currentStudyId: previousRoles.currentStudyId, comparisonStudyId: previousRoles.comparisonStudyId });
        }
        if (!state.disposed && localSelectionOperation === operation && !isAbort(error)) {
          sessionError = error.message; updateSessionLibrary();
          showError(error, 'Unable to open selected image');
        }
        throw error;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (!operation.committed) releaseLocalStacks(newStacks);
        workspace.heldFrames = state.disposed ? [] : previousHeld;
        if (localSelectionOperation === operation) { localSelectionOperation = null; state.busy = false; }
        if (!state.disposed) { updateLibrary(); updateBusy(); }
      }
    })();
    void operation.done.catch(() => {}); return operation.done;
  }

  function leaveLocalContext() {
    sessionReading.clear(); sessionDisplayPlan = null;
    if (!localSession.patientId && localAnnotations.active == null) return;
    localAnnotations.prepare(null, annotations)(); localSession.clear(); localPanelKey = '';
  }
  function restoreLocalContext(roles) {
    const patient = localSession.patient(roles.activePatientId);
    const id = patient ? sessionPatientForLocal(patient.id)?.id ?? patient.id : null;
    localAnnotations.prepare(id, annotations)();
    if (!patient) localSession.clear();
    else { localSession.patientId = patient.id; localSession.currentStudyId = roles.currentStudyId; localSession.comparisonStudyId = roles.comparisonStudyId; }
    localPanelKey = '';
  }
  function getLocalLibraryState() {
    return { ...localCatalog.getState(), ...localSession.getState(), indexing: Boolean(localImportController),
      busy: Boolean(localImportController || localSelectionOperation), disposed: state.disposed,
      media: localMediaReport ? { ...localMediaReport, warnings: [...localMediaReport.warnings] } : null };
  }
  function refreshLocalCatalog() {
    localView = localCatalog.getView(); ++localViewRevision; localSession.update(localView); localPanelKey = '';
    updateLocalLibrary();
  }
  function updateLocalLibrary() {
    if (!localPanel || state.disposed) return;
    const selected = localOrigins.get(state.currentSeries), operational = getLocalLibraryState();
    const presentation = { ...operational, selectedSeriesId: selected?.seriesId ?? null,
      progress: localImportProgress, summary: localImportSummary, error: localLibraryError,
      operationLabel: localSelectionOperation?.label ?? '' };
    const key = JSON.stringify([localViewRevision, presentation]);
    if (key !== localPanelKey) { localPanelKey = key; localPanel.setCatalog(localView, presentation); }
    $('library-count').textContent = operational.patients ? `${operational.patients} patient${operational.patients === 1 ? '' : 's'}` : root.dataset.uiDemos === 'false' ? 'Local / remote' : '4 demos';
    for (const pane of panes) {
      let badge = pane.element.querySelector('.local-study-badge');
      if (!badge) { badge = document.createElement('span'); badge.className = 'local-study-badge'; pane.element.querySelector('.viewport-corner.top-left').append(badge); }
      const origin = localOrigins.get(pane.view.currentSeries), patient = localSession.patient(localSession.patientId);
      const study = patient?.studies.find(item => item.id === origin?.studyId);
      badge.hidden = !study || !pane.view.frame;
      if (study) {
        const role = study.id === localSession.comparisonStudyId ? 'comparison' : study.id === localSession.currentStudyId ? 'current' : 'loaded';
        const date = /^\d{8}$/.test(study.studyDate ?? '') ? `${study.studyDate.slice(0, 4)}-${study.studyDate.slice(4, 6)}-${study.studyDate.slice(6)}` : 'Date not supplied';
        badge.dataset.role = role; badge.textContent = `${role === 'comparison' ? 'COMPARISON' : role === 'current' ? 'CURRENT' : 'LOADED'} · ${date}`;
      } else badge.textContent = '';
    }
  }
  function assertLocalSelectionIdle() {
    if (localSelectionOperation) throw new Error('Finish preparing the local study selection before changing this control.');
  }
  async function cancelLocalSelection() {
    ++localSelectionRequest;
    const operation = localSelectionOperation; operation?.controller.abort();
    if (operation?.done) { try { await operation.done; } catch {} }
  }
  function cancelLocalImport() {
    ++localImportRequest;
    ++localSelectionRequest;
    localImportController?.abort();
    localSelectionOperation?.controller.abort();
  }
  async function importLocalFiles(files, options = {}) {
    if (closingSession) await closingSession;
    ensureActive();
    const beforeSource = { type: state.sourceType, series: state.currentSeries, token: state.loadToken, selection: localSelectionRequest };
    const mayOpenInitialStudy = beforeSource.type === 'empty' || beforeSource.type === 'demo';
    if (!options || Object.getPrototypeOf(options) !== Object.prototype || Reflect.ownKeys(options).some(key => key !== 'signal') || options.signal != null && !(options.signal instanceof AbortSignal)) throw new TypeError('Use an optional AbortSignal for local indexing.');
    const selected = [];
    for (const file of files ?? []) {
      if (!isImageCandidate(file) && !isDicomDirectory(file)) continue;
      if (selected.length >= 30000) throw new RangeError('The local catalog accepts at most 30,000 files per selection.');
      selected.push(file);
    }
    if (!selected.length) throw new Error('Choose local DICOM files or a folder containing image instances.');
    const request = ++localImportRequest;
    localImportController?.abort(); await localImportDone.catch(() => {}); ensureActive();
    if (request !== localImportRequest) throw new DOMException('Local indexing was superseded.', 'AbortError');
    if (options.signal?.aborted) throw new DOMException('Local indexing was canceled.', 'AbortError');
    const controller = new AbortController(); localImportController = controller;
    const abort = () => controller.abort(); options.signal?.addEventListener('abort', abort, { once: true });
    localLibraryError = ''; localImportProgress = { processed: 0, total: selected.length }; let lastProgress = 0;
    archiveBrowser.selectMode('local'); updateLocalLibrary();
    const hadPatients = localView.patients.length > 0;
    const progress = progress => {
      if (controller.signal.aborted || state.disposed || localImportController !== controller) return;
      localImportProgress = progress;
      if (performance.now() - lastProgress >= 80) { lastProgress = performance.now(); updateLocalLibrary(); }
    };
    const task = (async () => {
      const media = await resolveLocalMedia(selected, { signal: controller.signal, onProgress: progress });
      if (controller.signal.aborted || state.disposed) throw new DOMException('Local indexing was canceled.', 'AbortError');
      const indexed = media.files.length ? await localCatalog.addFiles(media.files, { signal: controller.signal, onProgress: progress, references: media.references })
        : { added: 0, duplicates: 0, failed: 0 };
      return { ...indexed, media: media.report.mode === 'dicomdir' ? media.report : null };
    })();
    localImportDone = task;
    let summary;
    try {
      summary = await task;
      if (state.disposed || controller.signal.aborted || localImportController !== controller) throw new DOMException('Local indexing was canceled.', 'AbortError');
      localImportSummary = { added: summary.added, duplicates: summary.duplicates, failed: summary.failed };
      localMediaReport = summary.media;
      refreshLocalCatalog(); admitIndexedLocal(summary.selection); $('library-examples').open = false;
      if (!$('error-banner').hidden && $('error-title').textContent === 'Unable to index these local files') {
        clearError(); status('Local library updated');
      }
    } catch (error) {
      if (!state.disposed && localImportController === controller) localLibraryError = isAbort(error) ? 'Indexing canceled. Previously added studies are unchanged.' : error.message;
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', abort);
      if (localImportController === controller) { localImportController = null; localImportProgress = null; }
      if (!state.disposed) { updateLocalLibrary(); emit('librarychange', getLocalLibraryState()); }
    }
    if (summary.added && mayOpenInitialStudy && request === localImportRequest && !hadPatients && localView.patients.length === 1 && !state.disposed &&
        state.sourceType === beforeSource.type && state.currentSeries === beforeSource.series && state.loadToken === beforeSource.token && localSelectionRequest === beforeSource.selection &&
        !state.busy && !state.frameBusy && !contextOperation && !readingOperation && !additionController) {
      const patient = localView.patients[0], study = patient.studies.find(item => item.series.length);
      if (study) { try { await openLocalStudy(study.id); } catch { /* The catalog remains usable when this indexed object has no supported image profile. */ } }
    }
    if (!state.disposed && !localSession.patientId && localView.patients.length > 1) {
      root.classList.add('library-open'); $('toggle-library').setAttribute('aria-expanded', 'true');
    }
    return { added: summary.added, duplicates: summary.duplicates, failed: summary.failed, ...getLocalLibraryState() };
  }
  function releaseLocalStacks(stacks) {
    for (const series of stacks) {
      const lease = borrowedLeases.get(series); if (lease) workspace.releaseSource(lease);
      borrowedLeases.delete(series); thumbnails.delete(thumbnailKeys.get(series)); series.dispose?.();
    }
    for (const [id, entry] of localLoaded) if (entry.stacks.some(stack => stack.disposed)) localLoaded.delete(id);
  }
  async function displayLocalPlan(makePlan, label) {
    ensureActive(); const canceling = cancelLocalSelection(), request = localSelectionRequest; await canceling;
    await cancelReadingProtocol(); await cancelStudyContext(); ensureActive();
    if (request !== localSelectionRequest) throw new DOMException('The local study selection was superseded.', 'AbortError');
    if (state.busy || state.frameBusy || additionController || localImportController) throw new Error('Finish the current source operation before choosing local studies.');
    const plan = makePlan(), controller = new AbortController(), revision = localViewRevision;
    if (plan.patientId !== localSession.patientId) aiAssist?.invalidate();
    const operation = { controller, label, done: null, committed: false };
    localSelectionOperation = operation; state.busy = true; localLibraryError = ''; updateBusy();
    const previous = snapshotSource(), previousRoles = localSession.getState(), previousLinks = { ...synchronization }, previousHeld = [...workspace.heldFrames], previousArchiveClient = archiveBrowser.client;
    operation.previous = previous;
    const newStacks = [], replacements = new Map(), prepared = [];
    const current = () => !state.disposed && !controller.signal.aborted && localSelectionOperation === operation && request === localSelectionRequest && revision === localViewRevision;
    const assertCurrent = () => { if (!current()) throw new DOMException('The local study selection was canceled.', 'AbortError'); };
    workspace.heldFrames = [...previousHeld, ...previous.paneViews.map(view => view.frame).filter(Boolean)];
    pauseCine(); invalidateSync(); workspace.cancelPrefetch();
    operation.done = (async () => {
      try {
        await closeReconstruction(); await specialty.close(); assertCurrent();
        for (const selected of plan.selections) {
          const metadata = localCatalog.getSeries(selected.seriesId), old = localLoaded.get(selected.seriesId);
          let stacks = old?.revision === metadata.revision && old.stacks.every(stack => !stack.disposed) ? old.stacks : null;
          if (!stacks) {
            stacks = await loadFiles(localCatalog.getSeriesFiles(selected.seriesId), { signal: controller.signal, onMeasure: measure('files', current) });
            newStacks.push(...stacks); replacements.set(selected.seriesId, { revision: metadata.revision, stacks });
            for (const stack of stacks) {
              origins.set(stack, { sourceType: 'files', sourceLabel: 'Local patient study', activeDemo: null });
              localOrigins.set(stack, { patientId: plan.patientId, studyId: selected.studyId, seriesId: selected.seriesId }); leaseFor(stack);
            }
          }
          assertCurrent(); const series = stacks[selected.stackIndex];
          if (!series) throw new RangeError('The selected local series does not contain that viewing stack.');
          const existingPane = previous.paneViews.find(view => view.currentSeries === series && view.frame);
          const index = existingPane?.renderedIndex ?? 0, frame = await workspace.request(series, index, controller.signal, measure('files', current));
          assertCurrent(); workspace.admitFrame(null, frame); workspace.heldFrames.push(frame);
          prepared.push({ ...selected, series, index, frame, transform: existingPane?.transform ?? null });
        }
        const requiredIds = [...new Set(plan.selections.map(selected => selected.seriesId))];
        const requiredGroups = requiredIds.map(id => ({ id, stacks: (replacements.get(id) ?? localLoaded.get(id)).stacks }));
        const resident = new Set(previous.series), optionalIds = [...new Set(previous.series.filter(series =>
          localOrigins.get(series)?.patientId === plan.patientId && !series.disposed).map(series => localOrigins.get(series).seriesId))].reverse();
        const optionalGroups = optionalIds.filter(id => !requiredIds.includes(id)).map(id => ({ id, stacks: localLoaded.get(id)?.stacks }))
          .filter(group => group.stacks?.every(stack => resident.has(stack) && !stack.disposed));
        // Navigation keeps the catalog complete. Resident pixels are a bounded
        // cache; old groups are released only after the new view commits.
        const { stacks: nextSeries } = planLocalWorkingSet(requiredGroups, optionalGroups, { maxBytes: MAX_SOURCE_BYTES });
        assertCurrent();
        await setLayout(plan.selections.length === 2 ? 2 : 1, { readingInternal: true, localInternal: true }); assertCurrent();
        clearWorkspaceViews(); state.series = nextSeries;
        for (let slot = 0; slot < prepared.length; slot++) {
          const selected = prepared[slot], pane = panes[slot], session = workspace.slots[slot];
          pane.viewport.setFrame(selected.frame); pane.overlay.resize();
          if (selected.transform) { pane.viewport.setTransform(selected.transform); if (selected.transform.windowOverride && !isColorFrame(selected.frame)) pane.viewport.setWindow(selected.transform.center, selected.transform.width); }
          session.lease = leaseFor(selected.series).retain(); session.series = selected.series; session.frame = selected.frame; session.frameIndex = selected.index;
          Object.assign(pane.view, { ...origins.get(selected.series), currentSeries: selected.series, frame: selected.frame, index: selected.index, renderedIndex: selected.index, frameBusy: false });
          if (pane === activePane) Object.assign(state, pane.view);
          usePane(pane, () => { updateDetails(); updateBusy(); }); assertCurrent();
        }
        assertCurrent();
        // Capture measurements after async preparation so the last edit is retained.
        const switchAnnotations = localAnnotations.prepare(sessionPatientForLocal(plan.patientId)?.id ?? plan.patientId, annotations);
        setActiveViewport(0); Object.assign(state, activePane.view); assertCurrent();
        localSession.commit(plan); switchAnnotations(); syncLegacyLocalPlan(plan);
        if (previousRoles.activePatientId !== plan.patientId) { derived.clear(); thumbnails.clear(); imageNotices.clearTechnical(); }
        operation.committed = true;
        for (const [id, entry] of replacements) localLoaded.set(id, entry);
        restoreReadingLinks({ slice: false, window: false, camera: false, toleranceMm: previousLinks.toleranceMm });
        readingApplied = null; ++readingRevision; readingPanel.clear();
        activePane = panes[0]; canvas = activePane.canvas; viewport = activePane.viewport; workspace.setActiveSlot(0); Object.assign(state, activePane.view);
        state.busy = false; savePane();
        if (prepared.length) {
          prepared.forEach(item => rememberThumbnail(item.series, item.frame));
          restoreSource(snapshotSource()); drawAllAnnotations(); renderAllOverlays();
        } else restoreSource(snapshotSource());
        releaseLocalStacks(previous.series.filter(series => !nextSeries.includes(series)));
        clearError(); updateLibrary(); updateFrameControls(); updateBusy();
        status(prepared.length === 2 ? 'Local comparison ready · independent views' : prepared.length ? 'Local study ready' : 'Choose a study from this patient’s timeline');
        root.classList.remove('library-open'); $('toggle-library').setAttribute('aria-expanded', 'false');
        emit('librarychange', getLocalLibraryState()); emit('sourcechange'); return getState();
      } catch (error) {
        if (!operation.committed && !state.disposed && localSelectionOperation === operation) {
          await setLayout(previous.paneViews.length, { readingInternal: true, localInternal: true });
          if (!state.disposed && localSelectionOperation === operation) {
            const safePrevious = previousArchiveClient === archiveBrowser.client ? previous : withoutArchiveSnapshot(previous);
            state.series = safePrevious.series; restoreSource(safePrevious, { workspaceRestore: true }); restoreReadingLinks(previousLinks);
          }
        }
        if (!state.disposed) { localLibraryError = isAbort(error) ? 'Selection canceled. The previous images are still available.' : error.message; if (!isAbort(error)) showError(error, 'Unable to open this local study'); }
        throw error;
      } finally {
        if (!operation.committed) releaseLocalStacks(newStacks);
        workspace.heldFrames = state.disposed || previousArchiveClient !== archiveBrowser.client ? [] : previousHeld;
        if (localSelectionOperation === operation) { localSelectionOperation = null; state.busy = false; }
        if (!state.disposed) { updateLibrary(); updateBusy(); emit('librarychange', getLocalLibraryState()); }
      }
    })();
    void operation.done.catch(() => {}); await operation.done; return getState();
  }
  async function selectLocalPatient(id) {
    ensureActive();
    if (id === localSession.patientId) { await cancelLocalSelection(); ensureActive(); return getState(); }
    aiAssist?.invalidate();
    return displayLocalPlan(() => localSession.planPatient(id), 'Selecting patient…');
  }
  function openLocalSeries(id, options = {}) { return displayLocalPlan(() => localSession.planSeries(id, options), 'Opening selected series…'); }
  function openLocalStudy(id, options = {}) { return displayLocalPlan(() => localSession.planStudy(id, options), 'Opening selected study…'); }
  function compareLocalStudies(current, comparison, options = {}) {
    savePane();
    const origin = [state.currentSeries, ...panes.map(pane => pane.view.currentSeries)].map(series => localOrigins.get(series)).find(origin => origin?.studyId === current);
    const selection = { ...(origin?.studyId === current ? { currentSeriesId: origin.seriesId } : {}), ...options };
    return displayLocalPlan(() => localSession.planComparison(current, comparison, selection), 'Preparing comparison…');
  }
  async function associateLocalPatient(from, to, options = {}) {
    ensureActive(); assertLocalSelectionIdle();
    const sessionFrom = sessionPatientForLocal(from), sessionTo = sessionPatientForLocal(to);
    if (sessionFrom && sessionTo) {
      await associateSessionPatients(sessionFrom.id, sessionTo.id, options);
      return getLocalLibraryState();
    }
    if (sessionFrom || sessionTo) throw new Error('Add the selected studies from both local patient records before reviewing their session association.');
    if (state.busy || state.frameBusy || additionController || localImportController) throw new Error('Finish the current source operation before associating local patients.');
    if (!options || Object.getPrototypeOf(options) !== Object.prototype || Reflect.ownKeys(options).some(key => key !== 'confirmed') || options.confirmed !== true) throw new TypeError('Explicitly confirm the local patient association.');
    const measurements = localAnnotations.active === from ? annotations.getState().count : localAnnotations.documents.get(from)?.document.annotations.length;
    if (measurements) throw new Error('Export and clear measurements for these outside records before associating their patient context.');
    localCatalog.confirmAssociation(from, to, options); refreshLocalCatalog();
    const applying = displayLocalPlan(() => localSession.planPatient(to), 'Updating patient association…'), selection = localSelectionRequest;
    await applying; ensureActive();
    if (selection !== localSelectionRequest || localSession.patientId !== to) throw new DOMException('The local patient association selection was superseded.', 'AbortError');
    releaseLocalStacks([...state.series]); state.series = []; localLoaded.clear(); updateLibrary();
    return getLocalLibraryState();
  }
  async function clearLocalLibrary() {
    aiAssist?.invalidate();
    ensureActive(); cancelLocalImport();
    const request = localImportRequest, canceling = cancelLocalSelection(), selection = localSelectionRequest;
    await Promise.allSettled([localImportDone, canceling]); ensureActive();
    if (request !== localImportRequest || selection !== localSelectionRequest) throw new DOMException('Clearing the local library was superseded.', 'AbortError');
    if (localSession.patientId) {
      const applying = displayLocalPlan(() => localSession.planPatient(localSession.patientId), 'Clearing local views…'), applyingSelection = localSelectionRequest;
      await applying; ensureActive();
      if (request !== localImportRequest || applyingSelection !== localSelectionRequest) throw new DOMException('Clearing the local library was superseded.', 'AbortError');
      clearWorkspaceViews(); releaseLocalStacks([...state.series]); state.series = [];
      annotations.clear(); annotations.clearHistory(); derived.clear();
    }
    const localPatientIds = sessionCatalog.getView().patients.filter(patient => patient.kind === 'local').map(patient => patient.id);
    const noticeScopes = [...localPatientIds.flatMap(id => sessionCatalog.getPatient(id).studies.map(study => study.id)),
      ...localView.patients.flatMap(patient => patient.studies.map(study => study.id))];
    if (localPatientIds.includes(sessionReading.patientId)) {
      pauseCine(); clearWorkspaceViews(); releaseLocalStacks([...state.series]); state.series = []; sessionReading.clear(); sessionDisplayPlan = null;
      annotations.clear(); annotations.clearHistory(); derived.clear(); localAnnotations.active = null; restoreSource(snapshotSource());
    }
    for (const id of localPatientIds) { sessionCatalog.removePatient(id); savedPatientViews.delete(id); localAnnotations.documents.delete(id); }
    for (const [id, entry] of sessionLoaded) if (!sessionCatalog.getSeries(id)) { releaseLocalStacks(entry.stacks); sessionLoaded.delete(id); }
    localLoaded.clear(); localSession.clear(); localCatalog.clear(); refreshSessionCatalog();
    imageNotices.forgetScopes(noticeScopes);
    localImportSummary = null; localMediaReport = null; localLibraryError = ''; refreshLocalCatalog(); updateLibrary(); updateFrameControls(); emit('librarychange', getLocalLibraryState());
    return getLocalLibraryState();
  }

  async function openFiles(files, options = {}) {
    ensureActive();
    archiveBrowser.selectMode('local');
    const selected = Array.from(files ?? []).filter(isImageCandidate);
    if (!selected.length) {
      const error = new Error('This selection contains no image files. Choose supported grayscale or color DICOM instances; DICOMDIR is an index, not an image.');
      showError(error);
      if (options.rejectErrors) throw error;
      return;
    }
    return openSource((loadOptions) => loadFiles(selected, loadOptions), 'files', 'Local DICOM', null, options);
  }

  function withoutArchiveSnapshot(previous) {
    const paneViews = previous.paneViews.map(view => view.sourceType !== 'archive' ? view : { ...view, currentSeries: null, frame: null, sourceType: 'empty', sourceLabel: 'No image', activeDemo: null, presentation: null, probePoint: null, measurement: null, frameBusy: false, frameController: null });
    const active = paneViews[Math.min(previous.activeSlot ?? 0, paneViews.length - 1)];
    return { ...previous, ...active, series: previous.series.filter(series => origins.get(series)?.sourceType !== 'archive' && !series.disposed), paneViews, transform: active.transform };
  }

  function clearArchiveSource() {
    if (clearingArchive || state.disposed) return;
    const client = archiveBrowser.client;
    const owned = series => origins.get(series)?.sourceType === 'archive' && series._session?.client === client;
    if (!client || ![...state.series, ...borrowedLeases.keys(), ...(state.pendingLoad?.previous.series ?? [])].some(owned) && state.pendingLoad?.type !== 'archive' && !contextOperation) return;
    localSelectionOperation?.controller.abort();
    aiAssist?.invalidate();
    clearingArchive = true;
    try {
    const readingInterrupted = readingOperation;
    if (readingInterrupted) {
      readingInterrupted.revoked = true; readingInterrupted.controller.abort();
      readingInterrupted.previousHeld = [];
      Object.assign(readingInterrupted.previous, withoutArchiveSnapshot(readingInterrupted.previous));
      readingInterrupted.previousApplied = null;
      void setLayout(readingInterrupted.previous.paneViews.length, { readingInternal: true }).catch(() => {});
      restoreSource(readingInterrupted.previous, { workspaceRestore: true });
      restoreReadingLinks(readingInterrupted.previousSynchronization);
    }
    void readingCoordinator.cancel(); invalidateReadingSource();
    const interrupted = contextOperation;
    if (interrupted) interrupted.revoked = true;
    const allRemote = [...new Set([...state.series, ...(state.pendingLoad?.previous.series ?? []), ...(interrupted?.previous.series ?? []), ...borrowedLeases.keys()])].filter(owned);
    interrupted?.controller.abort(); studyContexts.cancel();
    cancelAddition(); workspace.cancelPrefetch();
    void closeReconstruction(); void specialty.close();
    const retained = annotations.export();
    retained.annotations = retained.annotations.filter(item => !purgeAllAnnotations && !remoteImageKeys.has(item.image.sopUid));
    annotations.import(retained, { mode: 'replace' }); annotations.clearHistory();
    remoteImageKeys.clear(); purgeAllAnnotations = false;
    derived.clear(); thumbnails.clear();
    for (const pane of panes) { pane.presentation = null; pane.overlay.clear(); }
    if (interrupted?.previous) {
      const safe = withoutArchiveSnapshot(interrupted.previous);
      Object.assign(interrupted.previous, safe);
      void setLayout(safe.paneViews.length, { readingInternal: true }).catch(() => {});
      restoreSource(safe, { workspaceRestore: true });
    }
    if (state.pendingLoad && (state.pendingLoad.type === 'archive' || state.pendingLoad.previous.series.some(series => origins.get(series)?.sourceType === 'archive'))) {
      state.sourceController?.abort(); ++state.loadToken;
      const previous = state.pendingLoad.previous;
      Object.assign(previous, withoutArchiveSnapshot(previous));
      const rejected = state.series.filter(series => !previous.series.includes(series));
      clearWorkspaceViews();
      for (const series of rejected) { const lease = borrowedLeases.get(series); if (lease) workspace.releaseSource(lease); borrowedLeases.delete(series); series.dispose?.(); }
      state.pendingLoad = null; state.busy = false; restoreSource(previous, { workspaceRestore: true });
    }
    if (interrupted) workspace.heldFrames = [...interrupted.previousHeld, ...interrupted.previous.paneViews.map(view => view.frame).filter(Boolean), ...interrupted.frames];
    if (readingInterrupted) workspace.heldFrames = [...readingInterrupted.previous.paneViews.map(view => view.frame).filter(Boolean), ...readingInterrupted.frames];
    const removed = allRemote;
    if (removed.includes(reconstructionSeries) || reconstruction?.getState().busy) void closeReconstruction();
    if (!removed.length) {
      for (const pane of panes) if (pane.view.frame && origins.get(pane.view.currentSeries)?.sourceType !== 'archive') rememberThumbnail(pane.view.currentSeries, pane.view.frame);
      updateLibrary(); return;
    }
    pauseCine(); savePane();
    state.series = state.series.filter(series => !removed.includes(series));
    for (const pane of panes) {
      if (!removed.includes(pane.view.currentSeries)) continue;
      pane.view.frameController?.abort(); workspace.slots[pane.slot].clear();
      Object.assign(pane.view, { sourceType: 'empty', sourceLabel: 'No image', activeDemo: null, currentSeries: null, frame: null, index: 0, renderedIndex: 0, frameToken: pane.view.frameToken + 1, frameController: null, frameBusy: false, pointer: null, probePoint: null, measurement: null });
      pane.overlay.clear(); pane.presentation = null; pane.viewport.clearFrame(); pane.annotations.cancelDraft(); pane.annotations.render();
      pane.element.querySelector('[data-pane-id="viewport-empty"]').hidden = false;
      pane.element.querySelector('[data-pane-id="viewport-loading"]').hidden = true;
      pane.element.classList.remove('frame-loading');
    }
    Object.assign(state, activePane.view);
    for (const series of removed) { const lease = borrowedLeases.get(series); if (lease) workspace.releaseSource(lease); borrowedLeases.delete(series); series.dispose?.(); thumbnails.delete(thumbnailKeys.get(series)); }
    restoreSource(snapshotSource()); clearError(); updateBusy();
    for (const pane of panes) if (pane.view.frame && origins.get(pane.view.currentSeries)?.sourceType !== 'archive') rememberThumbnail(pane.view.currentSeries, pane.view.frame);
    updateLibrary();
    status(state.frame ? 'Image ready' : 'Viewer ready · open a DICOM image');
    } finally { clearingArchive = false; }
  }

  async function addArchiveSeries(studyUid, seriesUid, options = {}) {
    ensureActive(); await cancelReadingProtocol(); ensureActive();
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.getPrototypeOf(options) !== Object.prototype || Reflect.ownKeys(options).some(key => key !== 'viewport')) throw new TypeError('Use a viewport index for added series.');
    const slot = options.viewport ?? activePane.slot;
    if (!Number.isInteger(slot) || !panes[slot]) throw new RangeError('Viewport index is outside the current layout.');
    const client = archiveBrowser.requireClient();
    if (state.busy) throw new Error('Finish opening the current source before adding a study.');
    invalidateReadingSource(); cancelAddition(); workspace.cancelPrefetch(); savePane();
    const existing = state.series.find(series => origins.get(series)?.sourceType === 'archive' && series.studyUid === studyUid && series.seriesUid === seriesUid);
    if (existing) return assignViewportSeries(slot, state.series.indexOf(existing));
    const controller = new AbortController(); additionController = controller;
    const pane = panes[slot], paneToken = pane.view.frameToken, loadToken = state.loadToken;
    const current = () => !state.disposed && additionController === controller && !controller.signal.aborted && state.loadToken === loadToken && archiveBrowser.client === client && panes.includes(pane) && pane.view.frameToken === paneToken;
    let stacks = [], committed = false, previousSeries = null, beforeView = null, beforeTransform = null, assignmentToken = null, beforeLocalRoles = null;
    let abortAssignment = null;
    try {
      status('Reading series metadata for comparison…', 'loading');
      stacks = await loadArchiveSeries(client, studyUid, seriesUid, { signal: controller.signal, onMeasure: measure('archive', current) });
      if (!current()) throw new DOMException('The comparison addition was canceled.', 'AbortError');
      if (state.series.length + stacks.length > 128 || [...state.series, ...stacks].reduce((sum, series) => sum + series.frames.length, 0) > 10000) throw new Error('The loaded workspace accepts at most 128 stacks and 10,000 frames.');
      rememberArchiveImages(stacks);
      stacks.forEach(series => { origins.set(series, { sourceType: 'archive', sourceLabel: 'DICOMweb comparison', activeDemo: null }); leaseFor(series); });
      const frame = await workspace.request(stacks[0], 0, controller.signal, measure('archive', current));
      if (!current()) throw new DOMException('The comparison addition was canceled.', 'AbortError');
      workspace.admitFrame(null, frame);
      previousSeries = state.series; beforeView = { ...pane.view }; beforeTransform = pane.viewport.state;
      beforeLocalRoles = localSession.getState(); leaveLocalContext();
      state.series = [...previousSeries, ...stacks];
      let pending; usePane(pane, () => { pending = selectSeries(stacks[0]); });
      assignmentToken = pane.view.frameToken;
      abortAssignment = () => { if (pane.view.frameToken === assignmentToken) pane.view.frameController?.abort(); };
      controller.signal.addEventListener('abort', abortAssignment, { once: true });
      const displayed = await pending;
      if (!displayed || state.disposed || controller.signal.aborted || !panes.includes(pane) || pane.view.frameToken !== assignmentToken || archiveBrowser.client !== client || state.loadToken !== loadToken) {
        throw new DOMException('The comparison addition could not be committed.', 'AbortError');
      }
      committed = true; if (additionController === controller) additionController = null;
      rememberThumbnail(stacks[0], frame); updateLibrary(); emit('sourcechange');
      return getWorkspaceState();
    } catch (error) {
      if (!isAbort(error) && !state.disposed) showError(error, 'Unable to add this series');
      throw error;
    } finally {
      if (abortAssignment) controller.signal.removeEventListener('abort', abortAssignment);
      if (!committed && previousSeries && !state.disposed && state.loadToken === loadToken) {
        if (beforeLocalRoles) restoreLocalContext(beforeLocalRoles);
        state.series = state.series.filter(series => !stacks.includes(series));
        if (panes.includes(pane) && pane.view.frameToken === assignmentToken) {
          const session = workspace.slots[pane.slot]; session.clear();
          if (beforeView.currentSeries && !beforeView.currentSeries.disposed) {
            session.lease = leaseFor(beforeView.currentSeries).retain(); session.series = beforeView.currentSeries;
            session.frame = beforeView.frame; session.frameIndex = beforeView.renderedIndex;
          }
          Object.assign(pane.view, beforeView, { frameToken: assignmentToken, frameController: null, frameBusy: false });
          usePane(pane, () => { restoreSource({ ...snapshotSource(), ...beforeView, series: state.series, transform: beforeTransform }); updateBusy(); });
        }
      }
      if (!committed) for (const series of stacks) {
        const lease = borrowedLeases.get(series); if (lease) workspace.releaseSource(lease); borrowedLeases.delete(series); series.dispose?.();
      }
      if (additionController === controller) additionController = null;
      if (!state.disposed) { updateLibrary(); updateBusy(); if (isAbort(controller.signal.reason) || controller.signal.aborted) status(state.frame ? 'Image ready' : 'Viewer ready'); }
    }
  }

  function openDemo(id, options = {}) {
    ensureActive();
    return openTestWorkspace(id, options);
  }

  function openUrl(url, options = {}) {
    ensureActive();
    return openSource((loadOptions) => loadUrl(url, loadOptions), 'url', 'Remote DICOM', null, options);
  }

  function chooseTool(id, { inspect = true } = {}) {
    panes.forEach(pane => pane.annotations.cancelDraft());
    if (id === 'window' && isColorFrame(state.frame)) return;
    state.tool = id;
    $('measurement-tools').open = false;
    root.querySelectorAll('[data-tool]').forEach((button) => {
      const active = button.dataset.tool === id;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    canvas.dataset.tool = id;
    const tool = TOOLS.find((item) => item.id === id);
    $('tool-hint').textContent = `${tool?.hint || ''} · Scroll to browse frames`;
    updateProbe();
    if (inspect && ['distance', 'angle', 'rectangle', 'ellipse', 'polygon', 'select'].includes(id)) revealInspectorTab('measurements');
    else if (inspect && ['window', 'probe'].includes(id)) inspectorTabs.select('details');
  }

  function pauseCine() {
    const freezePendingFrame = state.playing && state.frameBusy && state.frameRequestIsCine;
    state.playing = false;
    ++state.cineToken;
    clearTimeout(state.cineTimer);
    state.cineTimer = null;
    if (freezePendingFrame) {
      state.frameController?.abort();
      ++state.frameToken;
      state.frameBusy = false;
      state.frameRequestIsCine = false;
      state.index = state.renderedIndex;
      updateFrameControls();
      updateBusy();
    }
    $('cine-toggle').innerHTML = icon('play');
    $('cine-toggle').classList.remove('playing');
    $('cine-toggle').setAttribute('aria-label', 'Play cine');
    $('cine-toggle').setAttribute('aria-pressed', 'false');
  }

  function playCine() {
    if (!state.frame || state.currentSeries.frames.length < 2) return;
    state.playing = true;
    $('cine-toggle').innerHTML = icon('pause');
    $('cine-toggle').classList.add('playing');
    $('cine-toggle').setAttribute('aria-label', 'Pause cine');
    $('cine-toggle').setAttribute('aria-pressed', 'true');
    const sourceToken = state.loadToken;
    const cineToken = ++state.cineToken;
    const interval = () => $('cine-fps').value === 'native' ? nativePlaybackInterval(state.currentSeries.frames, state.index) : 1000 / Number($('cine-fps').value);
    workspace.cancelPrefetch();
    const tick = async () => {
      if (!state.playing || cineToken !== state.cineToken || sourceToken !== state.loadToken || document.hidden) return;
      const started = performance.now();
      const success = await requestFrame((state.index + 1) % state.currentSeries.frames.length, { cine: true });
      if (!state.playing || cineToken !== state.cineToken || sourceToken !== state.loadToken || !success) return;
      const wait = interval();
      if (wait == null) { pauseCine(); return; }
      state.cineTimer = setTimeout(tick, Math.max(0, wait - (performance.now() - started)));
    };
    const begin = () => {
      if (!state.playing || cineToken !== state.cineToken || sourceToken !== state.loadToken) return;
      const wait = interval(); if (wait == null) { pauseCine(); return; }
      state.cineTimer = setTimeout(tick, wait);
    };
    // Replay is an explicit user action. Recorded timing still stops at the last
    // frame during playback; it does not invent a last-to-first interval.
    if (interval() == null) requestFrame(0, { cine: true }).then(success => { if (success) begin(); else if (cineToken === state.cineToken) pauseCine(); });
    else begin();
  }

  function resetView() {
    if (!state.frame || readingOperation) return;
    pauseCine();
    state.pointer = null;
    activePane.presentation = null; viewport.setFrame(state.frame);
    state.measurement = null;
    state.probePoint = null;
    updateWindow();
    updateProbe();
    $('window-presets').querySelectorAll('button').forEach((button) => button.classList.remove('active'));
  }

  function stepFrame(delta) {
    pauseCine();
    if (state.currentSeries && state.frame) requestFrame(state.index + delta);
  }

  root.querySelectorAll('[data-demo]').forEach((button) => button.addEventListener('click', () => {
    const demo = DEMOS.find((item) => item.id === button.dataset.demo);
    openSource((options) => loadDemo(demo.id, options), 'demo', `Synthetic ${demo.modality}`, demo.id);
  }));
  root.querySelectorAll('[data-tool]').forEach((button) => button.addEventListener('click', () => chooseTool(button.dataset.tool)));
  $('header-import').addEventListener('click', () => openWorkflow.open());
  $('drop-card').addEventListener('click', () => openWorkflow.open('images'));
  $('open-folder').addEventListener('click', () => openWorkflow.open('images'));
  const importSelection = event => { const files = [...event.target.files]; event.target.value = ''; if (!openWorkflow.getState().open || pendingPickerGeneration !== pickerGeneration) return; pendingPickerGeneration = null; openWorkflow.acceptFiles(files, { intent: pickerIntent }).catch(error => { if (!state.disposed && !isAbort(error)) showError(error, 'Unable to read this selection'); }); };
  $('file-input').addEventListener('change', importSelection);
  $('folder-input').addEventListener('change', importSelection);
  $('url-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const url = $('dicom-url').value.trim();
    let parsed;
    try { parsed = new URL(url); } catch { showError(new Error('Enter a complete http:// or https:// DICOM instance or WADO-RS URL.'), 'Check the source URL'); return; }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      showError(new Error('Use an HTTP(S) URL without embedded credentials. This alpha does not store authentication tokens.'), 'Check the source URL');
      return;
    }
    openSource((options) => loadUrl(url, options), 'url', 'Remote DICOM');
  });
  $('dismiss-error').addEventListener('click', () => { clearError(); status(state.frame ? 'Image ready' : 'Open a DICOM image'); });
  $('reset-view').addEventListener('click', resetView);
  $('reset-performance').addEventListener('click', resetPerformance);
  $('annotation-undo').addEventListener('click', () => annotations.undo());
  $('annotation-redo').addEventListener('click', () => annotations.redo());
  $('annotation-delete').addEventListener('click', () => activePane.annotations.deleteSelected());
  $('annotation-import').addEventListener('click', () => $('annotation-input').click());
  $('annotation-input').addEventListener('change', async event => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    try {
      if (file.size > annotations.maxBytes) throw new Error('This annotation document exceeds the 1 MiB import limit.');
      const text = await file.text();
      if (state.disposed) return;
      annotations.import(text); status('Annotations imported · matching images show their measurements');
    } catch (error) { if (!state.disposed) showError(error, 'Unable to import annotations'); }
  });
  $('annotation-export').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([annotations.exportJson()], { type: 'application/json' }));
    annotationDownloads.add(url);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'easi-view-annotations-v1.json'; anchor.click();
    setTimeout(() => { URL.revokeObjectURL(url); annotationDownloads.delete(url); }, 1000);
  });
  $('rotate-view').addEventListener('click', () => { if (state.frame) { viewport.setTransform({ rotation: ((viewport.state.rotation ?? viewport.state.rotationdeg ?? 0) + 90) % 360 }); updateWindow(); } });
  $('flip-view').addEventListener('click', () => { if (state.frame) { viewport.setTransform({ flipX: !viewport.state.flipX }); updateWindow(); } });
  $('invert-view').addEventListener('click', () => { if (state.frame && !isColorFrame(state.frame)) { viewport.setTransform({ invert: !viewport.state.invert }); updateWindow(); } });
  $('previous-frame').addEventListener('click', () => stepFrame(-1));
  $('archive-stack-select').addEventListener('change', () => { const series = state.series[Number($('archive-stack-select').value)]; if (series) selectSeries(series); });
  $('next-frame').addEventListener('click', () => stepFrame(1));
  $('open-specialty').addEventListener('click', () => {
    const metadata = sessionCatalog.getSeries(sessionOrigins.get(state.currentSeries)?.seriesId);
    if (metadata?.kind === 'local') openSpecialtyFiles(localCatalog.getSeriesFiles(metadata.provenance.seriesId)).catch(error => { if (!isAbort(error)) showError(error, 'Unable to open specialty profile'); });
  });
  $('open-reconstruction').addEventListener('click', () => { openReconstruction().catch(error => { if (!isAbort(error) && !state.disposed) showError(error, 'Unable to reconstruct this series'); }); });
  $('prefetch-neighbors').addEventListener('change', () => setPrefetch({ enabled: $('prefetch-neighbors').checked }));
  $('frame-slider').addEventListener('input', () => { const index = Number($('frame-slider').value); pauseCine(); requestFrame(index); });
  $('cine-toggle').addEventListener('click', () => state.playing ? pauseCine() : playCine());
  $('cine-fps').addEventListener('change', () => { if (state.playing) { pauseCine(); playCine(); } });
  ['window-width', 'window-center'].forEach((id) => $(id).addEventListener('change', () => {
    if (!state.frame || isColorFrame(state.frame)) return;
    const center = $('window-center').valueAsNumber;
    const width = $('window-width').valueAsNumber;
    if (Number.isFinite(center) && Number.isFinite(width) && width >= 1) {
      viewport.setWindow(center, width);
      updateWindow(); void synchronizeWorkspace();
      $('window-presets').querySelectorAll('button').forEach((button) => button.classList.remove('active'));
    } else {
      $('window-width').value = Number(viewport.state.width.toFixed(2));
      $('window-center').value = Number(viewport.state.center.toFixed(2));
    }
  }));
  root.querySelectorAll('[data-preset]').forEach((button) => button.addEventListener('click', () => {
    if (!state.frame || isColorFrame(state.frame)) return;
    const presets = { soft: { center: 40, width: 400 }, lung: { center: -600, width: 1500 }, bone: { center: 400, width: 1800 } };
    const range = state.frame.range;
    const correction = state.frame.voiFunction === 'LINEAR_EXACT' ? 0 : 1;
    const selected = button.dataset.preset === 'auto' ? (range ? { center: (range.min + range.max + correction) / 2, width: Math.max(1, range.max - range.min + correction) } : state.frame.window) : presets[button.dataset.preset];
    if (selected) { viewport.setWindow(selected.center, selected.width); void synchronizeWorkspace(); }
    $('window-presets').querySelectorAll('button').forEach((item) => item.classList.toggle('active', item === button));
    updateWindow();
  }));

  function bindCanvas(pane) {
    pane.element.addEventListener('pointerdown', () => { if (!readingOperation) setActiveViewport(pane.slot); }, { capture: true, signal: pane.lifetime.signal });
    pane.canvas.addEventListener('focus', () => { if (!readingOperation) setActiveViewport(pane.slot); }, { signal: pane.lifetime.signal });
  pane.canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  pane.canvas.addEventListener('pointerdown', (event) => {
    if (readingOperation) return;
    setActiveViewport(pane.slot);
    if (!state.frame) return;
    event.preventDefault();
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    const tool = event.button === 2 || event.button === 1 ? 'pan' : state.tool;
    state.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, tool, transform: saveTransform(), center: viewport.state.center, width: viewport.state.width };
    if (tool === 'distance') {
      state.measurement = null;
      const point = viewport.screenToImage(event.clientX, event.clientY);
      if (probe(state.frame, point.x, point.y)) state.measurement = [point, point];
    }
    if (tool === 'probe') { state.probePoint = viewport.screenToImage(event.clientX, event.clientY); updateProbe(); }
    drawAnnotations();
  });
  pane.canvas.addEventListener('pointermove', (event) => {
    if (readingOperation) return;
    if (pane !== activePane) return;
    if (!state.frame) return;
    const pointer = state.pointer;
    if (!pointer) {
      if (state.tool === 'probe') { state.probePoint = viewport.screenToImage(event.clientX, event.clientY); updateProbe(); }
      return;
    }
    if (event.pointerId !== pointer.id) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    if (pointer.tool === 'pan') viewport.setTransform({ panX: pointer.transform.panX + dx, panY: pointer.transform.panY + dy });
    if (pointer.tool === 'zoom') viewport.setTransform({ zoom: Math.min(20, Math.max(0.1, pointer.transform.zoom * Math.exp(-dy / 180))) });
    if (pointer.tool === 'window' && !isColorFrame(state.frame)) {
      const span = Math.max(1, state.frame.range ? state.frame.range.max - state.frame.range.min : pointer.width);
      const sensitivity = Math.max(0.25, span / 700);
      viewport.setWindow(pointer.center + dy * sensitivity, Math.max(1, pointer.width + dx * sensitivity));
      $('window-presets').querySelectorAll('button').forEach((button) => button.classList.remove('active'));
    }
    if (pointer.tool === 'probe') { state.probePoint = viewport.screenToImage(event.clientX, event.clientY); updateProbe(); }
    if (pointer.tool === 'distance' && state.measurement) {
      const point = viewport.screenToImage(event.clientX, event.clientY);
      state.measurement[1] = { x: Math.min(Math.max(0, point.x), state.frame.columns - 0.001), y: Math.min(Math.max(0, point.y), state.frame.rows - 0.001) };
    }
    updateWindow();
    if (['pan', 'zoom', 'window'].includes(pointer.tool)) void synchronizeWorkspace();
  });
  const releasePointer = (event) => { if (pane === activePane && state.pointer?.id === event.pointerId) state.pointer = null; };
  pane.canvas.addEventListener('pointerup', releasePointer);
  pane.canvas.addEventListener('pointercancel', releasePointer);
  pane.canvas.addEventListener('lostpointercapture', releasePointer);
  pane.canvas.addEventListener('dblclick', () => { setActiveViewport(pane.slot); resetView(); });
  let wheelAt = 0;
  pane.canvas.addEventListener('wheel', (event) => {
    if (readingOperation || localSelectionOperation) { event.preventDefault(); return; }
    setActiveViewport(pane.slot);
    if (!state.frame) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      viewport.setTransform({ zoom: Math.min(20, Math.max(0.1, viewport.state.zoom * Math.exp(-event.deltaY / 500))) });
      updateWindow();
    } else if (performance.now() - wheelAt > 45) {
      wheelAt = performance.now();
      stepFrame(event.deltaY > 0 ? 1 : -1);
    }
  }, { passive: false });

  }
  bindCanvas(activePane);
  root.querySelectorAll('button[data-layout]').forEach(button => button.addEventListener('click', () => setLayout(Number(button.dataset.layout)).catch(error => showError(error))));
  $('viewport-series').addEventListener('change', () => { if ($('viewport-series').value !== '') assignViewportSeries(activePane.slot, Number($('viewport-series').value)).catch(error => showError(error)); });
  ['sync-slices', 'sync-window', 'sync-camera'].forEach(id => $(id).addEventListener('change', () => setSynchronization({ slice: $('sync-slices').checked, window: $('sync-window').checked, camera: $('sync-camera').checked }).catch(error => showError(error))));

  function togglePanel(name) {
    if (name === 'library') {
      const open = root.classList.toggle('library-open');
      $('toggle-library').setAttribute('aria-expanded', String(open));
    } else {
      const hidden = root.classList.toggle('inspector-hidden');
      $('toggle-inspector').setAttribute('aria-expanded', String(!hidden));
    }
    requestAnimationFrame(() => { if (!state.disposed) { viewport.resize(); drawAnnotations(); } });
  }
  $('toggle-library').addEventListener('click', () => togglePanel('library'));
  $('toggle-inspector').addEventListener('click', () => togglePanel('inspector'));
  $('show-shortcuts').addEventListener('click', () => $('shortcuts-dialog').showModal());
  $('close-shortcuts').addEventListener('click', () => $('shortcuts-dialog').close());
  $('shortcuts-dialog').addEventListener('click', (event) => { if (event.target === $('shortcuts-dialog')) $('shortcuts-dialog').close(); });
  const keyHandler = (event) => {
    if (event.composedPath?.().includes($('image-notice-control')) || event.target?.closest?.('#image-notice-control')) return;
    if (aiAssist?.isOpen() || primaryMenu?.isOpen() || localSelectionOperation || openWorkflow?.getState().open || event.target?.closest?.('#local-catalog-panel, #session-library-panel')) return;
    if (readingOperation || readingPanel?.isOpen() || reconstruction?.getState().open || specialty.getState().open) return;
    if (!event.defaultPrevented && event.target?.matches?.('canvas') && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault(); event.shiftKey ? annotations.redo() : annotations.undo();
      if (options.keyboardScope === 'viewer') event.stopPropagation();
      return;
    }
    if (!event.defaultPrevented && event.target?.matches?.('canvas') && ['Delete', 'Backspace'].includes(event.key) && activePane.annotations.getSelected()) {
      event.preventDefault(); activePane.annotations.deleteSelected();
      if (options.keyboardScope === 'viewer') event.stopPropagation();
      return;
    }
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.target?.closest?.('input, textarea, select, [contenteditable="true"], #inspector-tabs, [data-inspector-panel]') || $('shortcuts-dialog').open) return;
    const key = event.key.toLowerCase();
    if ((key === ' ' || key === 'enter') && event.target?.closest?.('button, summary')) return;
    const tool = TOOLS.find((item) => item.key.toLowerCase() === key);
    if (tool) { event.preventDefault(); chooseTool(tool.id); }
    else if (key === 'arrowright' || key === 'arrowdown') { event.preventDefault(); stepFrame(1); }
    else if (key === 'arrowleft' || key === 'arrowup') { event.preventDefault(); stepFrame(-1); }
    else if (key === ' ') { event.preventDefault(); state.playing ? pauseCine() : playCine(); }
    else if (key === 'r') { event.preventDefault(); resetView(); }
    else if (key === 'i') { event.preventDefault(); $('invert-view').click(); }
    else if (key === 'o') { event.preventDefault(); openWorkflow.open(); }
    else if (['+', '=', '-'].includes(key) && state.frame) { event.preventDefault(); viewport.setTransform({ zoom: Math.min(20, Math.max(0.1, viewport.state.zoom * (key === '-' ? 0.9 : 1.1))) }); updateWindow(); }
    else if (key === 'escape') { event.preventDefault(); state.measurement = null; state.probePoint = null; pauseCine(); updateProbe(); }
    if (event.defaultPrevented && options.keyboardScope === 'viewer') event.stopPropagation();
  };
  const keyboardTarget = options.keyboardScope === 'viewer' ? root : document;
  keyboardTarget.addEventListener('keydown', keyHandler, { signal: uiLifetime.signal });
  const visibilityHandler = () => { if (document.hidden) { pauseCine(); specialty.pause(); } };
  document.addEventListener('visibilitychange', visibilityHandler, { signal: uiLifetime.signal });
  function bindViewportStatus(pane) {
  pane.canvas.addEventListener('viewportstatus', (event) => {
    if (pane !== activePane) return;
    if (event.detail?.contextLost) {
      pauseCine();
      showError(new Error(event.detail.message), 'Graphics context interrupted');
    } else {
      clearError();
      status('Graphics context restored · image ready');
    }
  }, { signal: uiLifetime.signal });
  }
  bindViewportStatus(activePane);

  const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
  root.addEventListener('dragenter', (event) => { if (hasFiles(event)) { event.preventDefault(); ++state.dragDepth; $('drop-overlay').hidden = false; $('drop-card').classList.add('drag-active'); } }, { signal: uiLifetime.signal });
  root.addEventListener('dragover', (event) => { if (hasFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }, { signal: uiLifetime.signal });
  root.addEventListener('dragleave', (event) => { if (hasFiles(event) && --state.dragDepth <= 0) { state.dragDepth = 0; $('drop-overlay').hidden = true; $('drop-card').classList.remove('drag-active'); } }, { signal: uiLifetime.signal });
  root.addEventListener('drop', async (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    state.dragDepth = 0;
    $('drop-overlay').hidden = true;
    $('drop-card').classList.remove('drag-active');
    pauseCine();
    const token = ++state.dropToken;
    try {
      const files = await collectDroppedFiles(event.dataTransfer, { maximumFiles: 30000, includeDicomdir: true, isCurrent: () => !state.disposed && state.dropToken === token });
      if (!files.length) throw new Error('This folder contains no image files. Choose a folder containing supported DICOM images.');
      if (!state.disposed && state.dropToken === token) openWorkflow.acceptFiles(files, { intent: 'images' }).catch(error => { if (!state.disposed && !isAbort(error)) showError(error, 'Unable to read this selection'); });
    } catch (error) {
      if (!isAbort(error) && !state.disposed && state.dropToken === token) showError(error, 'Unable to read this folder');
    }
  }, { signal: uiLifetime.signal });

  const observer = new ResizeObserver(() => { if (!state.disposed) { panes.forEach(pane => pane.viewport.resize()); drawAllAnnotations(); } });
  observer.observe(workspaceElement);
  if (root.clientWidth <= 1180) {
    root.classList.add('inspector-hidden');
    $('toggle-inspector').setAttribute('aria-expanded', 'false');
  }
  chooseTool('window', { inspect: false });
  restoreSource(snapshotSource());
  status('Viewer ready · open a DICOM image');
  updateBusy();
  const initialDemo = options.initialDemo === undefined ? 'ct' : options.initialDemo;
  const ready = initialDemo === null ? Promise.resolve(getState()) : openDemo(initialDemo, { rejectErrors: true });
  // The standalone app need not consume the API promise to show an initial-load error.
  ready.catch(() => {});

  // Explicit cleanup keeps the viewer embeddable and releases source/GPU ownership.
  const dispose = () => {
    if (state.disposed) return;
    state.disposed = true;
    workflowBroker?.dispose(); aiAssist?.dispose(); aiSourceBindings.dispose();
    ++localImportRequest; localImportController?.abort(); localSelectionOperation?.controller.abort();
    const localCleanup = Promise.allSettled([localImportDone, localSelectionOperation?.done ?? Promise.resolve()]);
    primaryMenu.dispose(); sessionDrag.clear(); openWorkflow.dispose(); localPreview.dispose(); sessionPanel.dispose(); sourceRegistry.dispose();
    for (const controller of sessionMetadataControllers) controller.abort();
    sessionCatalog.dispose(); sessionLoaded.clear(); savedPatientViews.clear();
    localPanel.dispose(); localCatalog.dispose(); localSession.update({ patients: [] }); localSession.clear(); localView = { patients: [] };
    localLoaded.clear(); localAnnotations.clear(); localImportSummary = null; localMediaReport = null; localImportProgress = null; localLibraryError = '';
    ++readingRevision; ++readingRequest; readingOperation?.controller.abort();
    readingApplied = null; readingPanel.dispose();
    contextOperation?.controller.abort(); studyContexts.dispose();
    cleanupPending = true;
    cleanupDone = Promise.allSettled([localCleanup, reconstruction.dispose(), specialty.dispose(), contextOperation?.done ?? Promise.resolve(), readingCoordinator.dispose(), readingOperation?.done ?? Promise.resolve()]);
    cancelAddition(); thumbnails.clear();
    invalidateSync();
    performanceRecorder.dispose();
    unsubscribeAnnotations(); selectedStatistics = null;
    attributesPanel.dispose(); inspectorTabs.dispose();
    imageNoticePopover.dispose(); imageNotices.clear();
    for (const url of annotationDownloads) URL.revokeObjectURL(url);
    annotationDownloads.clear();
    state.busy = false;
    state.frameBusy = false;
    ++state.loadToken;
    ++state.frameToken;
    pauseCine();
    uiLifetime.abort();
    archiveBrowser.dispose();
    state.sourceController?.abort();
    state.frameController?.abort();
    state.series.forEach((series) => series.dispose?.());
    state.pendingLoad?.previous.series.forEach((series) => series.dispose?.());
    observer.disconnect();
    keyboardTarget.removeEventListener('keydown', keyHandler);
    document.removeEventListener('visibilitychange', visibilityHandler);
    workspace.dispose();
    panes.forEach(pane => { pane.overlay.dispose(); pane.annotations.dispose(); pane.lifetime.abort(); pane.viewport.dispose(); });
    overlayCache.dispose(); derived.dispose();
    cleanupDone = Promise.allSettled([cleanupDone, overlayCache.whenDisposed()]).then(() => { cleanupPending = false; });
    borrowedLeases.clear(); remoteImageKeys.clear();
    annotations.dispose();
    panes.length = 0;
    state.series = [];
    state.currentSeries = null;
    state.frame = null;
    state.pendingLoad = null;
    state.pointer = null;
    state.probePoint = null;
    state.measurement = null;
    state.sourceController = null;
    state.frameController = null;
    root.replaceChildren();
    root.classList.remove('library-open', 'inspector-hidden');
    emit('dispose');
  };
  window.addEventListener('pagehide', (event) => { if (event.persisted) { pauseCine(); specialty.pause(); } else dispose(); }, { signal: uiLifetime.signal });
  window.addEventListener('pageshow', (event) => { if (event.persisted && !state.disposed) { viewport.resize(); drawAnnotations(); } }, { signal: uiLifetime.signal });
  const api = {
    ready, dispose, getState, getPerformance, exportStudyContext, applyStudyContext,
    openAiAssist: () => { ensureActive(); return aiAssist.open(); },
    closeAiAssist: () => aiAssist.close(), cancelAiAssist: () => aiAssist.cancel(),
    getAiState: () => aiAssist.getState(), getAiDraft: () => aiAssist.getDraft(),
    open: path => openWorkflow.open(path), getOpenWorkflowState: () => openWorkflow.getState(),
    getSessionCatalog: () => { ensureActive(); return structuredClone({ ...sessionCatalog.getView(), activePatientId: sessionReading.patientId }); }, getSessionState,
    selectSessionPatient, openSessionStudy, openSessionSeries, openSessionInstance, listSessionInstances, compareSessionStudies, removeSessionPatient, closeSession, clearViewport,
    getSources: () => sourceRegistry.list(), registerSource: configuration => sourceRegistry.add(configuration),
    importLocalFiles, getLocalCatalog: () => { ensureActive(); return structuredClone(localView); }, getLocalLibraryState,
    selectLocalPatient, openLocalStudy, openLocalSeries, compareLocalStudies, cancelLocalImport, clearLocalLibrary, associateLocalPatient,
    getReadingProtocols, setReadingProtocols, previewReadingProtocol, applyReadingProtocol, cancelReadingProtocol, resetReadingProtocol, getReadingProtocolState,
    openSpecialtyFiles, closeSpecialty: () => { ensureActive(); return specialty.close(); },
    getSpecialtyState: () => specialty.getState(),
    setSpecialty: options => { ensureActive(); return specialty.configure(options); },
    setSpecialtyFrame: index => { ensureActive(); return specialty.setFrame(index); },
    playSpecialty: () => { ensureActive(); return specialty.play(); },
    pauseSpecialty: () => { ensureActive(); return specialty.pause(); },
    probeSpecialty: (column, row) => { ensureActive(); return specialty.probe(column, row); },
    exportSpecialtyReport: () => { ensureActive(); return specialty.exportReport(); }, resetPerformance, getWorkspaceState, addArchiveSeries, setPrefetch, openReconstruction, closeReconstruction,
    getReconstructionState: () => reconstruction.getState(),
    setReconstruction: options => { ensureActive(); return reconstruction.configure(options); },
    setReconstructionFusion: (seriesIndex, options = {}) => { ensureActive(); return reconstruction.setFusion({ ...options, seriesIndex }); },
    probeReconstruction: (view, column, row) => { ensureActive(); return reconstruction.probe(view, column, row); },
    whenDisposed: () => { if (!state.disposed) throw new Error('Dispose the viewer before awaiting cleanup.'); return cleanupDone; },
    importDerived: (input, options) => { ensureActive(); return derived.import(input, options); },
    addOverlay(input, { viewport: slot = activePane.slot } = {}) { ensureActive(); if (!Number.isInteger(slot) || !panes[slot]?.view.frame) throw new RangeError('Choose a displayed viewport.'); return derived.addAiOverlay(input, panes[slot].view.frame); },
    updateOverlay: (id, style) => { ensureActive(); return derived.updateStyle(id, style); },
    removeOverlay: id => { ensureActive(); return derived.removeOverlay(id); },
    exportOverlays: () => { ensureActive(); return derived.exportOverlays(); },
    exportDerivedResults: () => { ensureActive(); return derived.exportResults(); },
    importDerivedResults: (document, options) => { ensureActive(); return derived.importResults(document, options); },
    applyPresentation: index => { ensureActive(); assertReadingIdle(); return derived.applyGsps(index); },
    getDerivedState: () => derived.getState(),
    clearDerived: () => { ensureActive(); return derived.clear(); },
    setLayout, setActiveViewport: slot => { assertReadingIdle(); assertLocalSelectionIdle(); return setActiveViewport(slot); }, assignViewportSeries, setSynchronization,
    getAnnotationState,
    getAnnotations({ viewport: slot = activePane.slot } = {}) {
      ensureActive(); if (!Number.isInteger(slot) || !panes[slot]) throw new RangeError('Viewport index is outside the current layout.');
      return frameAnnotations(panes[slot]);
    },
    addAnnotation(input, { viewport: slot = activePane.slot } = {}) {
      assertLocalSelectionIdle();
      ensureActive(); if (!Number.isInteger(slot) || !panes[slot]) throw new RangeError('Viewport index is outside the current layout.');
      if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).some(key => !['id', 'tool', 'points'].includes(key))) throw new TypeError('Supply a tool, image points and optional annotation id.');
      const frame = panes[slot] === activePane ? state.frame : panes[slot].view.frame;
      if (!frame) throw new Error('Display an image before adding an annotation.');
      return annotations.add({ ...input, image: createImageReference(frame) });
    },
    removeAnnotation(id) { ensureActive(); assertLocalSelectionIdle(); return annotations.remove(id); },
    measureAnnotation(id, { viewport: slot = activePane.slot } = {}) {
      ensureActive(); if (!Number.isInteger(slot) || !panes[slot]) throw new RangeError('Viewport index is outside the current layout.');
      const annotation = annotations.get(id), frame = panes[slot] === activePane ? state.frame : panes[slot].view.frame;
      if (!annotation || !frame) throw new Error('Choose an annotation and its displayed image.');
      return measureAnnotation(annotation, frame);
    },
    exportAnnotations() { ensureActive(); return annotations.export(); },
    importAnnotations(document, options) { ensureActive(); assertLocalSelectionIdle(); return annotations.import(document, options); },
    undoAnnotations() { ensureActive(); assertLocalSelectionIdle(); return annotations.undo(); },
    redoAnnotations() { ensureActive(); assertLocalSelectionIdle(); return annotations.redo(); },
    clearAnnotations() { ensureActive(); assertLocalSelectionIdle(); return annotations.clear(); },
    openFiles: files => openFiles(files, { rejectErrors: true }),
    openUrl: url => openUrl(url, { rejectErrors: true }),
    openDemo: id => openDemo(id, { rejectErrors: true }),
    configureArchive: configuration => { ensureActive(); return archiveBrowser.configure(configuration); },
    disconnectArchive: () => {
      ensureActive(); archiveBrowser.disconnect();
      const pending = [...overlayCache.entries.values()].filter(entry => entry.pending).map(entry => entry.promise);
      return Promise.allSettled([localSelectionOperation?.done ?? Promise.resolve(), contextOperation?.done ?? Promise.resolve(), readingOperation?.done ?? Promise.resolve(), readingCoordinator.whenIdle(), reconstruction.close(), specialty.close(), ...pending]).then(() => {});
    },
    searchStudies: (filters, page) => archiveBrowser.searchStudies(filters, page),
    listStudySeries: (studyUid, page) => archiveBrowser.listStudySeries(studyUid, page),
    findPriorStudies: (context, page) => archiveBrowser.findPriorStudies(context, page),
    openArchiveSeries: (studyUid, seriesUid) => archiveBrowser.openArchiveSeries(studyUid, seriesUid),
    async setSeries(index) {
      assertLocalSelectionIdle();
      ensureActive(); await cancelReadingProtocol(); ensureActive();
      if (!Number.isInteger(index) || index < 0 || index >= state.series.length) throw new RangeError('Series index is outside the current source.');
      const pane = activePane;
      const pending = selectSeries(state.series[index]);
      const token = pane.view.frameToken;
      const displayed = await pending;
      if (state.disposed || !panes.includes(pane) || token !== pane.view.frameToken) throw new DOMException('The stack request was canceled.', 'AbortError');
      if (!displayed) throw new Error('The requested image stack could not be displayed.');
      return getState();
    },
    setTool(id) { ensureActive(); if (!TOOLS.some(tool => tool.id === id)) throw new TypeError('Unknown viewer tool.'); if (id === 'window' && isColorFrame(state.frame)) throw new TypeError('Window and level apply to grayscale frames; RGB channels are displayed directly.'); chooseTool(id); },
    async setFrame(index) {
      assertLocalSelectionIdle();
      ensureActive(); await cancelReadingProtocol(); ensureActive();
      if (!Number.isInteger(index) || index < 0 || index >= (state.currentSeries?.frames.length || 0)) throw new RangeError('Frame index is outside the current series.');
      if (!state.frame) throw new Error('Wait for the first image before selecting another frame.');
      pauseCine();
      const pane = activePane;
      const pending = requestFrame(index);
      const token = pane.view.frameToken;
      const displayed = await pending;
      if (state.disposed || !panes.includes(pane) || token !== pane.view.frameToken) throw new DOMException('The frame request was canceled.', 'AbortError');
      if (!displayed) throw new Error('The requested frame could not be displayed.');
      return getState();
    },
    setWindow({ center, width }) {
      assertLocalSelectionIdle();
      ensureActive(); assertReadingIdle();
      if (!state.frame) throw new Error('Open an image before setting its window.');
      if (!Number.isFinite(center) || !Number.isFinite(width) || width < (viewport.frame.voiFunction === 'LINEAR' ? 1 : Number.MIN_VALUE)) throw new TypeError('Window center and width must satisfy the DICOM window function.');
      viewport.setWindow(center, width); updateWindow(); void synchronizeWorkspace();
    },
    play() { ensureActive(); assertReadingIdle(); pauseCine(); playCine(); },
    pause() { ensureActive(); pauseCine(); },
    reset() { ensureActive(); resetView(); },
  };
  workflowApi = { ...api };
  for (const name of ['openFiles', 'openUrl', 'openDemo', 'importLocalFiles', 'selectSessionPatient', 'openSessionStudy',
    'openSessionSeries', 'openSessionInstance', 'compareSessionStudies', 'removeSessionPatient', 'closeSession', 'clearViewport',
    'selectLocalPatient', 'openLocalStudy', 'openLocalSeries', 'compareLocalStudies', 'clearLocalLibrary', 'associateLocalPatient',
    'openArchiveSeries', 'addArchiveSeries', 'disconnectArchive', 'applyStudyContext', 'applyReadingProtocol',
    'setSeries', 'setFrame', 'setLayout', 'setActiveViewport', 'assignViewportSeries', 'setSynchronization',
    'setWindow', 'setTool', 'play', 'pause', 'reset',
    'addAnnotation', 'removeAnnotation', 'importAnnotations', 'undoAnnotations', 'redoAnnotations', 'clearAnnotations']) {
    wrapWorkflowMutation(api, workflowBroker, name);
  }
  root.addEventListener('pointerdown', event => {
    if (workflowBroker.isExecuting() && !event.target.closest('.ai-assist')) workflowBroker.interrupt();
  }, { capture: true, signal: uiLifetime.signal });
  return api;
}
