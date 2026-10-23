import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createDimseGateway } from './gateway.mjs';

// A host module owns authentication/authorization; no secrets are accepted as CLI arguments.
const arguments_ = process.argv.slice(2);
if (arguments_.length !== 2 || arguments_[0] !== '--config') {
    throw new Error('Run node examples/dimse-gateway/server.mjs --config /absolute/path/to/host-config.mjs');
}
const configuration = await import(pathToFileURL(resolve(arguments_[1])).href);
const port = configuration.port ?? 8091;
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Use a loopback gateway port from 1024 to 65535.');
const handler = createDimseGateway({ association: configuration.association, publicOrigin: configuration.publicOrigin,
    authorize: configuration.authorize, ...(configuration.limits ? { limits: configuration.limits } : {}) });
const server = createServer((request, response) => {
    // Keep this example loopback-only and reject DNS-rebinding hostnames.
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(request.headers.host)) {
        response.writeHead(403); response.end('Use the configured loopback gateway address.'); return;
    }
    void handler(request, response);
});
server.listen(port, '127.0.0.1', () => console.log(`EASI View DIMSE HTTP gateway: http://127.0.0.1:${port}/dimse`));
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => {
    server.close(); server.closeAllConnections();
});
