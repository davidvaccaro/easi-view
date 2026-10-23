import { createViewer } from './assets/easi-view.js';

const skins = {
    nova: { branding: { name: 'NOVA Imaging' }, theme: { accent: '#7aa9ff' }, accent: '#4b75d3', mark: '#14336d' },
    orbit: { branding: { name: 'Orbit Research' }, theme: { accent: '#c2a6ff', panel: '#171427' }, accent: '#8260bd', mark: '#59407f' },
    easi: { branding: { name: 'EASI View' }, theme: {}, accent: '#318976', mark: '#246f60' },
};
const container = document.getElementById('viewer-container');
const status = document.getElementById('integration-status');
const viewer = createViewer(container, {
    branding: skins.nova.branding, theme: skins.nova.theme,
    ui: { library: false, demos: false }, initialDemo: 'ct',
});
const displayStatus = state => {
    status.textContent = state.image && state.frameCount > 0
        ? `${state.modality || 'DICOM'} · Image ${state.frameIndex + 1} of ${state.frameCount} · ${state.image.columns} × ${state.image.rows}`
        : 'Open a study or image.';
};
viewer.on('framechange', displayStatus);
viewer.on('sourcechange', displayStatus);
viewer.on('error', error => { status.textContent = error.message; });
viewer.ready.then(() => displayStatus(viewer.getState())).catch(error => { status.textContent = error.message; });

document.querySelectorAll('[data-study]').forEach(button => button.addEventListener('click', async () => {
    try {
        await viewer.openDemo(button.dataset.study);
        document.querySelectorAll('[data-study]').forEach(item => item.classList.toggle('selected', item === button));
        document.getElementById('host-source').textContent = button.querySelector('strong').textContent;
        document.querySelector('.host-profile').textContent = 'Synthetic study';
    } catch (error) { if (error.name !== 'AbortError') status.textContent = error.message; }
}));
document.querySelectorAll('[data-skin]').forEach(button => button.addEventListener('click', () => {
    const skin = skins[button.dataset.skin];
    viewer.setBranding(skin.branding);
    viewer.setTheme(skin.theme);
    document.getElementById('product-name').textContent = skin.branding.name;
    document.documentElement.style.setProperty('--product-accent', skin.accent);
    document.documentElement.style.setProperty('--product-mark', skin.mark);
    document.querySelectorAll('[data-skin]').forEach(item => {
        item.classList.toggle('selected', item === button);
        item.setAttribute('aria-pressed', String(item === button));
    });
}));
document.getElementById('host-open').addEventListener('click', () => document.getElementById('host-files').click());
document.getElementById('host-files').addEventListener('change', async event => {
    const files = Array.from(event.target.files);
    event.target.value = '';
    if (!files.length) return;
    try {
        await viewer.openFiles(files);
        document.querySelectorAll('[data-study]').forEach(item => item.classList.remove('selected'));
        document.getElementById('host-source').textContent = 'Local DICOM';
        document.querySelector('.host-profile').textContent = 'Processed on your device';
    } catch (error) { if (error.name !== 'AbortError') status.textContent = error.message; }
});
