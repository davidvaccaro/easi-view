import { loadFiles, loadUrl, loadDemo, MAX_SOURCE_BYTES } from '../data/sources.js';
import { ImageViewport, probe, measureDistance } from '../render/ImageViewport.js';
import { icon } from './icons.js';
import { collectDroppedFiles, isImageCandidate } from './drop-files.js';

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
];

function markup() {
  return `
    <header class="app-header">
      <a class="brand" href="./" aria-label="EASI View home">
        <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
        <span>EASI<span class="brand-light"> View</span></span>
        <span class="release-tag">ALPHA</span>
      </a>
      <div class="header-divider"></div>
      <div class="workspace-title"><span class="eyebrow">WORKSPACE</span><span id="workspace-name">Synthetic CT</span></div>
      <div class="header-actions">
        <span class="privacy-label" id="privacy-label">${icon('shield')}<span>Local files stay local</span></span>
        <button class="button icon-button mobile-library" id="toggle-library" title="Toggle study library" aria-label="Toggle study library" aria-expanded="false">${icon('library')}</button>
        <button class="button import-button" id="header-import">${icon('folder')}<span>Open DICOM</span><kbd>O</kbd></button>
        <button class="button icon-button" id="toggle-inspector" title="Toggle image inspector" aria-label="Toggle image inspector" aria-expanded="true">${icon('inspector')}</button>
      </div>
    </header>

    <div class="workspace">
      <aside class="library-panel" id="library-panel" aria-label="Study library">
        <div class="panel-heading"><h2>Study library</h2><span class="small-count">4 demos</span></div>
        <div class="library-scroll">
          <div class="section-caption"><span>BUILT-IN EXAMPLES</span><span class="synthetic-pill">Synthetic</span></div>
          <div class="demo-list">${DEMOS.map((demo) => `
            <button class="series-card ${demo.id === 'ct' ? 'active' : ''}" data-demo="${demo.id}" aria-pressed="${demo.id === 'ct'}">
              <span class="series-thumbnail thumbnail-${demo.className}" aria-hidden="true"><span class="phantom"></span><span class="thumb-modality">${demo.modality}</span></span>
              <span class="series-card-copy"><strong>${demo.title}</strong><span>${demo.detail}</span><span class="series-card-foot"><span class="native-dot"></span>Native DICOM<span class="series-card-arrow">${icon('chevron')}</span></span></span>
            </button>`).join('')}
          </div>
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
        <div class="library-footer">${icon('layers')}<span>EASI JS <strong>1.0.0</strong><br><small>Independent viewer engine</small></span></div>
      </aside>

      <main class="viewer-main" aria-label="DICOM image workspace">
        <div class="viewer-toolbar" role="toolbar" aria-label="Image tools">
          <div class="tool-group primary-tools">${TOOLS.map((tool) => `<button class="tool-button ${tool.id === 'window' ? 'active' : ''}" data-tool="${tool.id}" aria-pressed="${tool.id === 'window'}" aria-label="${tool.label}" title="${tool.hint} (${tool.key})">${icon(tool.icon)}<span>${tool.label}</span></button>`).join('')}</div>
          <div class="tool-group image-tools">
            <button class="tool-button compact" id="reset-view" title="Reset window and view (R)" aria-label="Reset window and view">${icon('reset')}</button>
            <button class="tool-button compact" id="rotate-view" title="Rotate clockwise 90 degrees" aria-label="Rotate clockwise 90 degrees">${icon('rotate')}</button>
            <button class="tool-button compact" id="flip-view" title="Flip horizontally" aria-label="Flip horizontally" aria-pressed="false">${icon('flip')}</button>
            <button class="tool-button compact" id="invert-view" title="Invert grayscale (I)" aria-label="Invert grayscale" aria-pressed="false">${icon('invert')}</button>
          </div>
        </div>
        <div class="error-banner" id="error-banner" role="alert" hidden><span>${icon('warning')}</span><div><strong id="error-title">Unable to open this image</strong><p id="error-message"></p></div><button class="icon-button" id="dismiss-error" aria-label="Dismiss error">${icon('close')}</button></div>
        <div class="image-stage" id="image-stage">
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
          <div class="viewport-empty" id="viewport-empty" hidden>${icon('layers')}<strong>Open a DICOM image</strong><span>Choose a synthetic study or open files from your device.</span></div>
          <div class="drop-overlay" id="drop-overlay" hidden>${icon('folder')}<strong>Drop DICOM files to open</strong><span>Images stay on this device.</span></div>
          <div class="tool-hint" id="tool-hint">Drag to adjust window · Scroll to browse frames</div>
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
        <div class="inspector-scroll">
          <section class="inspector-section">
            <div class="section-caption">WINDOW / LEVEL</div>
            <div class="window-fields"><label for="window-width"><span>Width</span><input id="window-width" type="number" min="1" step="1" value="400"></label><label for="window-center"><span>Level</span><input id="window-center" type="number" step="1" value="40"></label></div>
            <div class="preset-grid" id="window-presets"><button data-preset="auto" class="preset-button">Auto</button><button data-preset="soft" class="preset-button">Soft tissue</button><button data-preset="lung" class="preset-button">Lung</button><button data-preset="bone" class="preset-button">Bone</button></div>
          </section>
          <section class="inspector-section">
            <div class="section-caption">IMAGE DETAILS</div>
            <dl class="detail-list"><div><dt>Modality</dt><dd id="detail-modality">CT</dd></div><div><dt>Matrix</dt><dd id="detail-matrix">—</dd></div><div><dt>Pixel samples</dt><dd id="detail-samples">—</dd></div><div><dt>Photometric</dt><dd id="detail-photometric">—</dd></div><div><dt>Pixel spacing</dt><dd id="detail-spacing">—</dd></div><div><dt>Rescale</dt><dd id="detail-rescale">—</dd></div><div><dt>Frames</dt><dd id="detail-frames">—</dd></div></dl>
          </section>
          <section class="inspector-section">
            <div class="section-caption">PIXEL PROBE <kbd>P</kbd></div>
            <div class="probe-card"><span class="probe-coordinate" id="probe-coordinate">Choose the probe tool</span><strong id="probe-value">—<span> HU</span></strong><span id="probe-stored">Original samples remain available</span></div>
          </section>
          <section class="inspector-section pipeline-section">
            <div class="section-caption">THE DATA PIPELINE</div>
            <ol class="pipeline-flow"><li><span class="pipeline-node"></span><div><strong id="pipeline-source">Synthetic DICOM</strong><span id="pipeline-source-detail">In-memory test fixture</span></div></li><li><span class="pipeline-node"></span><div><strong>EASI JS parser</strong><span>Streaming DICOM pipeline</span></div></li><li><span class="pipeline-node"></span><div><strong>Original pixel samples</strong><span id="pipeline-pixels">Preserved scalar intensities</span></div></li><li><span class="pipeline-node render-node"></span><div><strong>Our viewing engine</strong><span id="pipeline-renderer">Independent GPU renderer</span></div></li></ol>
            <div class="memory-line"><span>Decoded frame</span><strong id="frame-memory">—</strong></div>
            <div class="memory-line"><span>Decoded cache</span><strong id="cache-memory">—</strong></div>
            <div class="memory-line"><span>Encoded pixels</span><strong id="source-memory">—</strong></div>
          </section>
          <div class="research-note">Research alpha · Native grayscale DICOM.<br>Display and measurement validation is in progress.</div>
        </div>
      </aside>
    </div>

    <footer class="status-bar"><div class="status-main"><span class="status-dot" id="status-dot"></span><span id="status-text">Initializing EASI View</span></div><div class="status-secondary"><span id="load-progress"></span><span class="privacy-footnote">No analytics · No uploads</span><button class="shortcut-button" id="show-shortcuts">${icon('help')}<span>Shortcuts</span></button></div></footer>
    <input id="file-input" type="file" multiple accept=".dcm,.dicom,application/dicom" hidden>
    <input id="folder-input" type="file" multiple webkitdirectory directory hidden>
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

export function startApp(root) {
  root.innerHTML = markup();
  const $ = (id) => root.querySelector(`#${id}`);
  const canvas = $('image-canvas');
  let viewport;
  try {
    viewport = new ImageViewport(canvas);
  } catch (error) {
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
    tool: 'window', activeDemo: 'ct', sourceType: 'demo', sourceLabel: 'Synthetic CT',
    sourceController: null, frameController: null, loadToken: 0, frameToken: 0, pendingLoad: null,
    busy: false, frameBusy: false, frameRequestIsCine: false, playing: false, cineTimer: null, cineToken: 0, pointer: null,
    probePoint: null, measurement: null, dragDepth: 0, dropToken: 0, disposed: false,
  };
  const uiLifetime = new AbortController();

  function status(message, phase = 'ready') {
    $('status-text').textContent = message;
    $('status-dot').className = `status-dot ${phase}`;
  }

  function showError(error, title = 'Unable to open this image') {
    $('error-title').textContent = title;
    $('error-message').textContent = error?.message || String(error);
    $('error-banner').hidden = false;
    status('Action needed · see image message', 'error');
  }

  function clearError() {
    $('error-banner').hidden = true;
    $('error-message').textContent = '';
  }

  function updateBusy() {
    $('viewport-loading').hidden = Boolean(state.frame) || !(state.busy || state.frameBusy);
    $('viewport-empty').hidden = Boolean(state.frame) || state.busy || state.frameBusy;
    $('image-stage').classList.toggle('frame-loading', state.frameBusy && Boolean(state.frame));
  }

  function snapshotSource() {
    return {
      series: state.series, currentSeries: state.currentSeries, frame: state.frame,
      index: state.index, renderedIndex: state.renderedIndex, sourceType: state.sourceType,
      sourceLabel: state.sourceLabel, activeDemo: state.activeDemo,
      transform: viewport.state, probePoint: state.probePoint, measurement: state.measurement,
    };
  }

  function restoreSource(snapshot) {
    Object.assign(state, {
      series: snapshot.series, currentSeries: snapshot.currentSeries, frame: snapshot.frame,
      index: snapshot.index, renderedIndex: snapshot.renderedIndex, sourceType: snapshot.sourceType,
      sourceLabel: snapshot.sourceLabel, activeDemo: snapshot.activeDemo,
      probePoint: snapshot.probePoint, measurement: snapshot.measurement,
    });
    if (snapshot.frame) {
      viewport.setFrame(snapshot.frame);
      viewport.setTransform(snapshot.transform);
      viewport.setWindow(snapshot.transform.center, snapshot.transform.width);
      updateDetails();
    } else {
      viewport.clearFrame();
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
    updateLibrary();
    updateFrameControls();
  }

  function saveTransform() {
    return { zoom: viewport.state.zoom, panX: viewport.state.panX, panY: viewport.state.panY, rotation: viewport.state.rotation ?? viewport.state.rotationdeg ?? 0, flipX: viewport.state.flipX, flipY: viewport.state.flipY, invert: viewport.state.invert };
  }

  function updateLibrary() {
    root.querySelectorAll('[data-demo]').forEach((button) => {
      const active = state.sourceType === 'demo' && button.dataset.demo === state.activeDemo;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    $('imported-section').hidden = state.sourceType === 'demo' || !state.series.length;
    $('imported-heading').textContent = state.sourceType === 'url' ? 'REMOTE SERIES' : 'LOCAL SERIES';
    $('imported-count').textContent = `${state.series.length}`;
    $('imported-list').replaceChildren();
    if (state.sourceType !== 'demo') state.series.forEach((series, index) => {
      const button = document.createElement('button');
      button.className = `imported-series ${series.id === state.currentSeries?.id ? 'active' : ''}`;
      button.setAttribute('aria-pressed', String(series.id === state.currentSeries?.id));
      const modality = document.createElement('span');
      modality.className = 'imported-modality';
      modality.textContent = series.modality || 'DCM';
      const copy = document.createElement('span');
      const title = document.createElement('strong');
      title.textContent = `${series.modality || 'DICOM'} series ${index + 1}`;
      const details = document.createElement('small');
      details.textContent = `${series.frames.length} frame${series.frames.length === 1 ? '' : 's'}`;
      copy.append(title, details);
      button.append(modality, copy);
      button.addEventListener('click', () => selectSeries(series));
      $('imported-list').append(button);
    });
    $('workspace-name').textContent = state.sourceLabel;
  }

  function updateFrameControls() {
    const count = state.currentSeries?.frames.length || 0;
    $('frame-slider').max = Math.max(0, count - 1);
    $('frame-slider').value = state.index;
    $('frame-slider').disabled = count < 2;
    $('frame-slider').style.setProperty('--range-progress', `${count > 1 ? (state.index / (count - 1)) * 100 : 0}%`);
    $('frame-slider').setAttribute('aria-valuetext', `Frame ${state.index + 1} of ${count}`);
    $('frame-number').textContent = String(state.index + 1).padStart(2, '0');
    $('frame-total').textContent = ` / ${count || '—'}`;
    $('previous-frame').disabled = count < 2 || state.index === 0;
    $('next-frame').disabled = count < 2 || state.index >= count - 1;
    $('cine-toggle').disabled = count < 2 || !state.frame;
    $('cine-fps').disabled = count < 2;
    $('window-width').disabled = !state.frame;
    $('window-center').disabled = !state.frame;
    $('window-presets').querySelectorAll('button').forEach((button) => { button.disabled = !state.frame; });
    $('detail-frames').textContent = count || '—';
  }

  function updateWindow() {
    if (!state.frame) return;
    $('window-overlay').textContent = `W ${number(viewport.state.width)} · L ${number(viewport.state.center)}`;
    if (document.activeElement !== $('window-width')) $('window-width').value = Number(viewport.state.width.toFixed(2));
    if (document.activeElement !== $('window-center')) $('window-center').value = Number(viewport.state.center.toFixed(2));
    $('zoom-overlay').textContent = `${Math.round(viewport.state.zoom * 100)}%`;
    $('flip-view').classList.toggle('active', Boolean(viewport.state.flipX));
    $('flip-view').setAttribute('aria-pressed', String(Boolean(viewport.state.flipX)));
    $('invert-view').classList.toggle('active', Boolean(viewport.state.invert));
    $('invert-view').setAttribute('aria-pressed', String(Boolean(viewport.state.invert)));
    drawAnnotations();
  }

  function updateDetails() {
    const frame = state.frame;
    if (!frame) return;
    const modality = state.currentSeries?.modality || 'DICOM';
    const demo = DEMOS.find((item) => item.id === state.activeDemo);
    $('modality-badge').textContent = modality;
    $('source-badge').textContent = state.sourceType === 'demo' ? 'SYNTHETIC DATA' : state.sourceType === 'url' ? 'REMOTE SOURCE' : 'LOCAL FILES';
    $('image-title').textContent = state.sourceType === 'demo' ? demo?.title || 'Synthetic image' : `${modality} series`;
    $('frame-overlay').textContent = `Image ${String(state.renderedIndex + 1).padStart(2, '0')} / ${state.currentSeries.frames.length}`;
    $('pixel-overlay').textContent = `${frame.columns} × ${frame.rows} · ${frame.samples.constructor.name.replace('Array', '')}`;
    $('sampling-overlay').textContent = frame.pixelSpacing ? `${number(frame.pixelSpacing[0], 3)} × ${number(frame.pixelSpacing[1], 3)} mm` : 'Uncalibrated pixels';
    $('detail-modality').textContent = modality;
    $('detail-matrix').textContent = `${frame.columns} × ${frame.rows}`;
    $('detail-samples').textContent = frame.samples.constructor.name.replace('Array', '');
    $('detail-photometric').textContent = frame.photometric || '—';
    $('detail-spacing').textContent = frame.pixelSpacing ? `${number(frame.pixelSpacing[0], 3)} × ${number(frame.pixelSpacing[1], 3)} mm` : 'Not available';
    $('detail-rescale').textContent = `× ${number(frame.slope ?? 1, 4)} ${Number(frame.intercept) < 0 ? '−' : '+'} ${number(Math.abs(frame.intercept || 0), 4)}`;
    $('frame-memory').textContent = bytes(frame.samples.byteLength);
    $('cache-memory').textContent = bytes(state.currentSeries?.cacheBytes || 0);
    $('source-memory').textContent = bytes(state.series.reduce((sum, series) => sum + (series.sourceBytes || 0), 0));
    $('pipeline-pixels').textContent = `${frame.samples.constructor.name} · ${frame.unit || 'stored intensity'}`;
    const backend = String(viewport.backend || 'Renderer');
    $('renderer-label').textContent = backend;
    $('pipeline-renderer').textContent = backend;
    $('pipeline-source').textContent = state.sourceType === 'demo' ? 'Synthetic DICOM' : state.sourceType === 'url' ? 'HTTP / DICOMweb' : 'Local files';
    $('pipeline-source-detail').textContent = state.sourceType === 'demo' ? 'In-memory test fixture' : state.sourceType === 'url' ? 'Browser fetch · streaming response' : 'File API · no upload';
    $('window-presets').querySelectorAll('[data-preset]').forEach((button) => {
      button.hidden = button.dataset.preset !== 'auto' && modality !== 'CT';
      button.classList.remove('active');
    });
    updateFrameControls();
    updateWindow();
    updateProbe();
  }

  function updateProbe() {
    const value = state.frame && state.probePoint ? probe(state.frame, state.probePoint.x, state.probePoint.y) : null;
    $('probe-coordinate').textContent = value ? `Pixel (${value.x}, ${value.y})` : state.tool === 'probe' ? 'Point at a pixel in the image' : 'Choose the probe tool';
    $('probe-value').replaceChildren();
    $('probe-value').append(document.createTextNode(value ? number(value.rescaled, 2) : '—'));
    const unit = document.createElement('span');
    unit.textContent = value ? ` ${value.unit || 'intensity'}` : state.frame?.unit ? ` ${state.frame.unit}` : '';
    $('probe-value').append(unit);
    $('probe-stored').textContent = value ? `Stored: ${number(value.stored, 2)}${value.padding ? ' · padding value' : ''}` : 'Original samples remain available';
    drawAnnotations();
  }

  function drawAnnotations() {
    const layer = $('annotation-layer');
    const rect = canvas.getBoundingClientRect();
    layer.setAttribute('viewBox', `0 0 ${Math.max(1, rect.width)} ${Math.max(1, rect.height)}`);
    layer.replaceChildren();
    if (!state.frame) return;
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
  }

  async function requestFrame(index, { reset = false, cine = false } = {}) {
    const series = state.currentSeries;
    if (!series?.frames.length) return false;
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
    const oldWindow = { center: viewport.state.center, width: viewport.state.width };
    try {
      const frame = await series.getFrame(nextIndex, { signal: controller.signal });
      if (state.disposed || controller.signal.aborted || token !== state.frameToken || series !== state.currentSeries) return false;
      viewport.setFrame(frame);
      if (reset) {
        viewport.reset();
        if (Number.isFinite(frame.frameTime) && frame.frameTime > 0) {
          const rate = 1000 / frame.frameTime;
          $('cine-fps').querySelectorAll('[data-native-rate]').forEach((option) => option.remove());
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
        if (Number.isFinite(oldWindow.center) && oldWindow.width > 0) viewport.setWindow(oldWindow.center, oldWindow.width);
      }
      state.frame = frame;
      // Progressive sources can insert an earlier slice while decoding is in flight.
      // Keep navigation attached to the displayed frame ID after geometry sorting.
      const actualIndex = series.frames.findIndex((descriptor) => descriptor.id === frame.id);
      state.renderedIndex = actualIndex < 0 ? nextIndex : actualIndex;
      state.index = state.renderedIndex;
      state.probePoint = null;
      state.measurement = null;
      viewport.resize();
      updateDetails();
      if (!state.busy) status(`${state.sourceType === 'demo' ? 'Synthetic study' : state.sourceType === 'url' ? 'Remote study' : 'Local study'} ready · ${series.frames.length} frame${series.frames.length === 1 ? '' : 's'}`);
      return true;
    } catch (error) {
      if (!isAbort(error) && token === state.frameToken) {
        pauseCine();
        if (!viewport.frame) {
          state.frame = null;
          state.probePoint = null;
          state.measurement = null;
          viewport.clearFrame();
          drawAnnotations();
        }
        state.index = state.renderedIndex;
        showError(error, 'Unable to display this frame');
        updateFrameControls();
      }
      return false;
    } finally {
      if (token === state.frameToken) {
        state.frameBusy = false;
        state.frameRequestIsCine = false;
        updateBusy();
      }
    }
  }

  function selectSeries(series) {
    pauseCine();
    state.pointer = null;
    state.currentSeries = series;
    state.index = 0;
    clearError();
    updateLibrary();
    requestFrame(0, { reset: true });
    root.classList.remove('library-open');
    $('toggle-library').setAttribute('aria-expanded', 'false');
  }

  async function openSource(loader, type, label, demoId = null) {
    ++state.dropToken;
    pauseCine();
    state.sourceController?.abort();
    state.frameController?.abort();
    ++state.frameToken;
    state.pointer = null;
    if (state.pendingLoad?.accepted) {
      const abandoned = state.series;
      const previous = state.pendingLoad.previous;
      abandoned.forEach((series) => { if (!previous.series.includes(series)) series.dispose?.(); });
      restoreSource(previous);
    }
    state.pendingLoad = null;
    const controller = new AbortController();
    state.sourceController = controller;
    const token = ++state.loadToken;
    state.frameBusy = false;
    state.busy = true;
    clearError();
    $('loading-message').textContent = `Opening ${label.toLowerCase()}`;
    $('load-progress').textContent = '';
    status('Reading DICOM source…', 'loading');
    updateBusy();
    const previous = snapshotSource();
    const pending = { token, previous, accepted: false };
    state.pendingLoad = pending;
    let received = false;
    const acceptSeries = async (series) => {
      if (token !== state.loadToken || controller.signal.aborted || !series?.length) return;
      state.series = series;
      state.sourceType = type;
      state.sourceLabel = label;
      state.activeDemo = demoId;
      if (!received) {
        received = true;
        pending.accepted = true;
        pauseCine();
        state.currentSeries = series[0];
        state.frame = null;
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
        onSeries: acceptSeries,
        onProgress: (progress) => {
          if (token !== state.loadToken || controller.signal.aborted) return;
          const phase = progress?.phase || 'reading';
          status(phase === 'ready' ? 'Source received · preparing pixels' : phase === 'parsing' ? 'Streaming DICOM through EASI JS…' : 'Reading DICOM source…', 'loading');
          $('load-progress').textContent = progress?.total ? `${bytes(progress.loaded || 0)} / ${bytes(progress.total)}` : progress?.loaded ? `${bytes(progress.loaded)} received` : '';
        },
      });
      if (token !== state.loadToken || controller.signal.aborted) return;
      await acceptSeries(series);
      if (!received) throw new Error('No supported image frames were found. Open a native grayscale DICOM instance or choose a synthetic example.');
      state.busy = false;
      previous.series.forEach((oldSeries) => { if (!state.series.includes(oldSeries)) oldSeries.dispose?.(); });
      state.pendingLoad = null;
      $('load-progress').textContent = `${state.series.length} series · ${bytes(state.series.reduce((sum, item) => sum + (item.sourceBytes || 0), 0))}`;
      if ($('error-banner').hidden) {
        if (state.frameBusy || !state.frame) status('Source ready · decoding frame…', 'loading');
        else status(`${type === 'demo' ? 'Synthetic study' : type === 'url' ? 'Remote study' : 'Local study'} ready · ${state.currentSeries.frames.length} frame${state.currentSeries.frames.length === 1 ? '' : 's'}`);
      }
      root.classList.remove('library-open');
      $('toggle-library').setAttribute('aria-expanded', 'false');
    } catch (error) {
      if (!isAbort(error) && token === state.loadToken) {
        state.busy = false;
        state.frameController?.abort();
        ++state.frameToken;
        state.frameBusy = false;
        if (received) restoreSource(previous);
        state.pendingLoad = null;
        showError(error);
      }
    } finally {
      if (token === state.loadToken) {
        state.busy = false;
        updateBusy();
      }
    }
  }

  function openFiles(files) {
    if (!files?.length) return;
    const selected = Array.from(files).filter(isImageCandidate);
    if (!selected.length) { showError(new Error('This selection contains no image files. Choose native grayscale DICOM instances; DICOMDIR is an index, not an image.')); return; }
    openSource((options) => loadFiles(selected, options), 'files', 'Local DICOM');
  }

  function chooseTool(id) {
    state.tool = id;
    root.querySelectorAll('[data-tool]').forEach((button) => {
      const active = button.dataset.tool === id;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    canvas.dataset.tool = id;
    const tool = TOOLS.find((item) => item.id === id);
    $('tool-hint').textContent = `${tool?.hint || ''} · Scroll to browse frames`;
    updateProbe();
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
    const tick = async () => {
      if (!state.playing || cineToken !== state.cineToken || sourceToken !== state.loadToken || document.hidden) return;
      const started = performance.now();
      const success = await requestFrame((state.index + 1) % state.currentSeries.frames.length, { cine: true });
      if (!state.playing || cineToken !== state.cineToken || sourceToken !== state.loadToken || !success) return;
      state.cineTimer = setTimeout(tick, Math.max(0, 1000 / Number($('cine-fps').value) - (performance.now() - started)));
    };
    state.cineTimer = setTimeout(tick, 1000 / Number($('cine-fps').value));
  }

  function resetView() {
    if (!state.frame) return;
    pauseCine();
    state.pointer = null;
    viewport.reset();
    state.measurement = null;
    state.probePoint = null;
    updateWindow();
    updateProbe();
    $('window-presets').querySelectorAll('button').forEach((button) => button.classList.remove('active'));
  }

  function stepFrame(delta) {
    pauseCine();
    if (state.currentSeries) requestFrame(state.index + delta);
  }

  root.querySelectorAll('[data-demo]').forEach((button) => button.addEventListener('click', () => {
    const demo = DEMOS.find((item) => item.id === button.dataset.demo);
    openSource((options) => loadDemo(demo.id, options), 'demo', `Synthetic ${demo.modality}`, demo.id);
  }));
  root.querySelectorAll('[data-tool]').forEach((button) => button.addEventListener('click', () => chooseTool(button.dataset.tool)));
  ['header-import', 'drop-card'].forEach((id) => $(id).addEventListener('click', () => $('file-input').click()));
  $('open-folder').addEventListener('click', () => $('folder-input').click());
  $('file-input').addEventListener('change', (event) => { openFiles(event.target.files); event.target.value = ''; });
  $('folder-input').addEventListener('change', (event) => { openFiles(event.target.files); event.target.value = ''; });
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
  $('rotate-view').addEventListener('click', () => { if (state.frame) { viewport.setTransform({ rotation: ((viewport.state.rotation ?? viewport.state.rotationdeg ?? 0) + 90) % 360 }); updateWindow(); } });
  $('flip-view').addEventListener('click', () => { if (state.frame) { viewport.setTransform({ flipX: !viewport.state.flipX }); updateWindow(); } });
  $('invert-view').addEventListener('click', () => { if (state.frame) { viewport.setTransform({ invert: !viewport.state.invert }); updateWindow(); } });
  $('previous-frame').addEventListener('click', () => stepFrame(-1));
  $('next-frame').addEventListener('click', () => stepFrame(1));
  $('frame-slider').addEventListener('input', () => { const index = Number($('frame-slider').value); pauseCine(); requestFrame(index); });
  $('cine-toggle').addEventListener('click', () => state.playing ? pauseCine() : playCine());
  $('cine-fps').addEventListener('change', () => { if (state.playing) { pauseCine(); playCine(); } });
  ['window-width', 'window-center'].forEach((id) => $(id).addEventListener('change', () => {
    if (!state.frame) return;
    const center = $('window-center').valueAsNumber;
    const width = $('window-width').valueAsNumber;
    if (Number.isFinite(center) && Number.isFinite(width) && width >= 1) {
      viewport.setWindow(center, width);
      updateWindow();
      $('window-presets').querySelectorAll('button').forEach((button) => button.classList.remove('active'));
    } else {
      $('window-width').value = Number(viewport.state.width.toFixed(2));
      $('window-center').value = Number(viewport.state.center.toFixed(2));
    }
  }));
  root.querySelectorAll('[data-preset]').forEach((button) => button.addEventListener('click', () => {
    if (!state.frame) return;
    const presets = { soft: { center: 40, width: 400 }, lung: { center: -600, width: 1500 }, bone: { center: 400, width: 1800 } };
    const range = state.frame.range;
    const correction = state.frame.voiFunction === 'LINEAR_EXACT' ? 0 : 1;
    const selected = button.dataset.preset === 'auto' ? (range ? { center: (range.min + range.max + correction) / 2, width: Math.max(1, range.max - range.min + correction) } : state.frame.window) : presets[button.dataset.preset];
    if (selected) viewport.setWindow(selected.center, selected.width);
    $('window-presets').querySelectorAll('button').forEach((item) => item.classList.toggle('active', item === button));
    updateWindow();
  }));

  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  canvas.addEventListener('pointerdown', (event) => {
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
  canvas.addEventListener('pointermove', (event) => {
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
    if (pointer.tool === 'window') {
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
  });
  const releasePointer = (event) => { if (state.pointer?.id === event.pointerId) state.pointer = null; };
  canvas.addEventListener('pointerup', releasePointer);
  canvas.addEventListener('pointercancel', releasePointer);
  canvas.addEventListener('lostpointercapture', releasePointer);
  canvas.addEventListener('dblclick', resetView);
  let wheelAt = 0;
  canvas.addEventListener('wheel', (event) => {
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
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.target?.closest?.('input, textarea, select, [contenteditable="true"]') || $('shortcuts-dialog').open) return;
    const key = event.key.toLowerCase();
    if ((key === ' ' || key === 'enter') && event.target?.closest?.('button, summary')) return;
    const tool = TOOLS.find((item) => item.key.toLowerCase() === key);
    if (tool) { event.preventDefault(); chooseTool(tool.id); }
    else if (key === 'arrowright' || key === 'arrowdown') { event.preventDefault(); stepFrame(1); }
    else if (key === 'arrowleft' || key === 'arrowup') { event.preventDefault(); stepFrame(-1); }
    else if (key === ' ') { event.preventDefault(); state.playing ? pauseCine() : playCine(); }
    else if (key === 'r') resetView();
    else if (key === 'i') $('invert-view').click();
    else if (key === 'o') { event.preventDefault(); $('file-input').click(); }
    else if (['+', '=', '-'].includes(key) && state.frame) { event.preventDefault(); viewport.setTransform({ zoom: Math.min(20, Math.max(0.1, viewport.state.zoom * (key === '-' ? 0.9 : 1.1))) }); updateWindow(); }
    else if (key === 'escape') { state.measurement = null; state.probePoint = null; pauseCine(); updateProbe(); }
  };
  document.addEventListener('keydown', keyHandler, { signal: uiLifetime.signal });
  const visibilityHandler = () => { if (document.hidden) pauseCine(); };
  document.addEventListener('visibilitychange', visibilityHandler, { signal: uiLifetime.signal });
  canvas.addEventListener('viewportstatus', (event) => {
    if (event.detail?.contextLost) {
      pauseCine();
      showError(new Error(event.detail.message), 'Graphics context interrupted');
    } else {
      clearError();
      status('Graphics context restored · image ready');
    }
  }, { signal: uiLifetime.signal });

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
      const files = await collectDroppedFiles(event.dataTransfer, { maximumBytes: MAX_SOURCE_BYTES, isCurrent: () => !state.disposed && state.dropToken === token });
      if (!files.length) throw new Error('This folder contains no image files. Choose a folder containing native grayscale DICOM instances.');
      if (!state.disposed && state.dropToken === token) openFiles(files);
    } catch (error) {
      if (!isAbort(error) && !state.disposed && state.dropToken === token) showError(error, 'Unable to read this folder');
    }
  }, { signal: uiLifetime.signal });

  const observer = new ResizeObserver(() => { if (!state.disposed) { viewport.resize(); drawAnnotations(); } });
  observer.observe($('image-stage'));
  if (matchMedia('(max-width: 1180px)').matches) {
    root.classList.add('inspector-hidden');
    $('toggle-inspector').setAttribute('aria-expanded', 'false');
  }
  chooseTool('window');
  openSource((options) => loadDemo('ct', options), 'demo', 'Synthetic CT', 'ct');

  // Explicit cleanup keeps the viewer embeddable and releases source/GPU ownership.
  const dispose = () => {
    if (state.disposed) return;
    state.disposed = true;
    ++state.loadToken;
    ++state.frameToken;
    pauseCine();
    uiLifetime.abort();
    state.sourceController?.abort();
    state.frameController?.abort();
    state.series.forEach((series) => series.dispose?.());
    state.pendingLoad?.previous.series.forEach((series) => series.dispose?.());
    observer.disconnect();
    document.removeEventListener('keydown', keyHandler);
    document.removeEventListener('visibilitychange', visibilityHandler);
    viewport.dispose();
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
  };
  window.addEventListener('pagehide', (event) => { if (event.persisted) pauseCine(); else dispose(); }, { signal: uiLifetime.signal });
  window.addEventListener('pageshow', (event) => { if (event.persisted && !state.disposed) { viewport.resize(); drawAnnotations(); } }, { signal: uiLifetime.signal });
  return { dispose };
}
