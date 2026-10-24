import './ui/styles.css';
import { startApp } from './ui/app.js';
import { localStoreAuthenticationHelp } from './integration/local-store-authentication.js';
import { createLocalStorageConnector } from './integration/local-storage-connector.js';

const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
let profileStorage;
try { profileStorage = window.localStorage; } catch { /* Private browser policies may disable optional persistence. */ }
startApp(document.getElementById('app'), {
    initialDemo: null,
    getAuthenticationHelp: localStoreAuthenticationHelp,
    opening: { sourceEditing: true },
    storageSources: { storage: profileStorage, origin: location.origin,
        connector: loopback && location.protocol === 'http:' ? createLocalStorageConnector({ origin: location.origin }) : null },
    sources: loopback ? [{ id: 'orthanc', name: 'Local Orthanc', type: 'dicomweb',
        baseUrl: new URL('/orthanc/dicom-web/', location.href).href },
    { id: 'easi-store-web', name: 'Local EASI Store · DICOMweb', type: 'dicomweb',
        baseUrl: new URL('/easi-store/dicomweb/', location.href).href, credentials: 'same-origin',
        searchFields: ['patientId', 'patientName', 'patientBirthDate', 'issuerOfPatientId', 'accessionNumber', 'studyDate', 'modality'] },
    { id: 'easi-store-dimse', name: 'Local EASI Store · DIMSE', type: 'dimse',
        baseUrl: new URL('/easi-store/dimse/', location.href).href, credentials: 'same-origin',
        searchFields: ['patientId', 'patientName', 'patientBirthDate', 'issuerOfPatientId', 'accessionNumber', 'studyDate', 'modality'] }] : []
});
