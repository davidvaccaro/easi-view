import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createDicomFixture } from '../../src/data/synthetic.js';
import { createDicomGateway } from './gateway.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });

/** Self-contained generated data/session demonstration; no reusable credentials are printed or persisted. */
export async function runSyntheticGateway() {
    const study = '2.25.990', series = `${study}.1`, sop = `${series}.1`;
    const bytes = createDicomFixture({ rows: 2, columns: 2, values: [0, 64, 128, 255], seriesUid: series, sopUid: sop, extraAttributes: { '0020000D': ['UI', study] } });
    const secret = randomBytes(32).toString('base64url'), expected = Buffer.from(`Bearer ${secret}`);
    const archive = createServer((request, response) => {
        if (request.url.startsWith('/dicom-web/studies?')) { response.writeHead(200, { 'Content-Type': 'application/dicom+json' }); response.end(JSON.stringify([{ '0020000D': { vr: 'UI', Value: [study] } }])); }
        else if (request.url === `/dicom-web/studies/${study}/series/${series}/instances/${sop}`) { response.writeHead(200, { 'Content-Type': 'application/dicom' }); response.end(bytes); }
        else { response.writeHead(404); response.end(); }
    });
    const gateway = createServer();
    try {
        const archivePort = await listen(archive), port = await listen(gateway), publicOrigin = `http://127.0.0.1:${port}`;
        const handler = createDicomGateway({ archiveBaseUrl: `http://127.0.0.1:${archivePort}/dicom-web`, publicOrigin, allowInsecureLoopback: true,
            authorize({ authorization, path, query }) {
                const supplied = Buffer.from(authorization || '');
                if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected) ||
                    !(path === '/studies' && query.StudyInstanceUID === study || path === `/studies/${study}/series/${series}/instances/${sop}`)) return null;
                return { subject: 'synthetic-user', realm: 'synthetic-example', expiresAt: Date.now() + 60000 };
            } });
        gateway.on('request', handler);
        const headers = { Authorization: `Bearer ${secret}`, Accept: 'application/dicom+json' };
        const studies = await fetch(`${publicOrigin}/dicom-web/studies?StudyInstanceUID=${study}`, { headers });
        if (!studies.ok || (await studies.json()).length !== 1) throw new Error('Synthetic study verification failed.');
        const instance = await fetch(`${publicOrigin}/dicom-web/studies/${study}/series/${series}/instances/${sop}`, { headers: { ...headers, Accept: 'application/dicom' } });
        if (!instance.ok || (await instance.arrayBuffer()).byteLength !== bytes.length) throw new Error('Synthetic instance verification failed.');
        const forbidden = await fetch(`${publicOrigin}/dicom-web/studies?StudyInstanceUID=${study}`);
        if (forbidden.status !== 403) throw new Error('Synthetic authentication verification failed.');
        return { studies: 1, instanceBytes: bytes.length, unauthenticatedStatus: 403, originalImagingFilesUsed: false };
    } finally { await Promise.all([close(gateway), close(archive)]); }
}
