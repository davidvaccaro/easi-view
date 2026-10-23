import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDicomGateway } from './gateway.mjs';

if (process.argv.includes('--synthetic')) {
    const { runSyntheticGateway } = await import('./synthetic.mjs');
    const result = await runSyntheticGateway();
    console.log(`Synthetic gateway verified: ${result.studies} study, one generated native instance, unauthorized requests denied. No credentials or images saved.`);
} else {
    try {
        const archiveBaseUrl = process.env.EASI_GATEWAY_ARCHIVE_BASE, publicOrigin = process.env.EASI_GATEWAY_PUBLIC_ORIGIN;
        const authModule = process.env.EASI_GATEWAY_AUTH_MODULE, certificate = process.env.EASI_GATEWAY_TLS_CERT_PATH, key = process.env.EASI_GATEWAY_TLS_KEY_PATH;
        if (![archiveBaseUrl, publicOrigin, authModule, certificate, key].every(value => typeof value === 'string' && value.length > 0)) throw new Error('Missing gateway configuration.');
        const { authorize } = await import(pathToFileURL(resolve(authModule)).href);
        const handler = createDicomGateway({ archiveBaseUrl, publicOrigin, authorize,
            upstreamHeaders: () => process.env.EASI_GATEWAY_UPSTREAM_AUTHORIZATION ? { Authorization: process.env.EASI_GATEWAY_UPSTREAM_AUTHORIZATION } : {} });
        const server = createServer({ cert: await readFile(certificate), key: await readFile(key), maxHeaderSize: 16384 }, handler);
        server.on('error', () => { console.error('The configured HTTPS gateway could not start.'); process.exitCode = 1; });
        const address = new URL(publicOrigin); server.listen(Number(address.port || 443), process.env.EASI_GATEWAY_BIND_HOST || '127.0.0.1', () => console.log('Configured HTTPS DICOM gateway is listening.'));
        for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
    } catch { console.error('Configure the HTTPS gateway endpoint, TLS files, fixed archive, and server authorization module before starting.'); process.exitCode = 1; }
}
