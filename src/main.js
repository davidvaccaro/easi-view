import './ui/styles.css';
import { startApp } from './ui/app.js';

const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
startApp(document.getElementById('app'), {
    initialDemo: null,
    opening: { sourceEditing: true },
    sources: loopback ? [{ id: 'orthanc', name: 'Local Orthanc', type: 'dicomweb',
        baseUrl: new URL('/orthanc/dicom-web/', location.href).href }] : []
});
