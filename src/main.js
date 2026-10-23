import './ui/styles.css';
import { startApp } from './ui/app.js';
import { normalizeAiConfiguration } from './ai/AiClient.js';

const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
let ai;
try {
    const response = await fetch(new URL('viewer-config.json', document.baseURI), { credentials: 'same-origin', redirect: 'error' });
    if (response.ok) {
        const body = await response.text();
        if (body.length > 4096) throw new Error('Configuration exceeds limit.');
        const configuration = JSON.parse(body);
        if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)
            || Object.keys(configuration).some(key => key !== 'ai')) throw new Error('Unknown deployment configuration.');
        if (Object.hasOwn(configuration, 'ai')) ai = normalizeAiConfiguration(configuration.ai);
    }
} catch { /* A missing or invalid host configuration leaves optional AI disabled. */ }
startApp(document.getElementById('app'), {
    initialDemo: null, ai,
    opening: { sourceEditing: true },
    sources: loopback ? [{ id: 'orthanc', name: 'Local Orthanc', type: 'dicomweb',
        baseUrl: new URL('/orthanc/dicom-web/', location.href).href }] : []
});
