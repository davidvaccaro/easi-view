import './ui/styles.css';
import { startApp } from './ui/app.js';
import { localStoreAuthenticationHelp } from './integration/local-store-authentication.js';

const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
startApp(document.getElementById('app'), {
    initialDemo: null,
    getAuthenticationHelp: localStoreAuthenticationHelp,
    opening: { sourceEditing: true },
    sources: loopback ? [{ id: 'orthanc', name: 'Local Orthanc', type: 'dicomweb',
        baseUrl: new URL('/orthanc/dicom-web/', location.href).href },
    { id: 'easi-store-web', name: 'Local EASI Store · DICOMweb', type: 'dicomweb',
        baseUrl: new URL('/easi-store/dicomweb/', location.href).href, credentials: 'same-origin',
        searchFields: ['patientId', 'patientName', 'patientBirthDate', 'issuerOfPatientId', 'accessionNumber', 'studyDate', 'modality'] },
    { id: 'easi-store-dimse', name: 'Local EASI Store · DIMSE', type: 'dimse',
        baseUrl: new URL('/easi-store/dimse/', location.href).href, credentials: 'same-origin',
        searchFields: ['patientId', 'patientName', 'patientBirthDate', 'issuerOfPatientId', 'accessionNumber', 'studyDate', 'modality'] }] : []
});
