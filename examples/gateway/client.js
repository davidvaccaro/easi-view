import { DicomWebClient } from '../../src/data/DicomWebClient.js';
import { EnterpriseSession, WorkflowCoordinator, ShareCoordinator, createEnterpriseHttpAdapters } from '../../src/enterprise/index.js';

/** Source-level host wiring; construction performs no sign-in, query, persistence, or sharing. */
export function createEnterpriseServices({ identityAdapter, archiveBaseUrl, workflowBaseUrl, viewerOrigin,
    workflowHeaders, audit, allowInsecureLoopback = false } = {}) {
    if (typeof workflowHeaders !== 'function') throw new TypeError('Configure a separate host API header provider.');
    let session, workflow, shares;
    try {
        session = new EnterpriseSession({ identityAdapter, archiveOrigins: [new URL(archiveBaseUrl).origin], audit, allowInsecureLoopback });
        const client = new DicomWebClient({ baseUrl: archiveBaseUrl, headers: request => session.dicomHeaders(request), credentials: 'omit' });
        const http = createEnterpriseHttpAdapters({ baseUrl: workflowBaseUrl, headers: workflowHeaders, credentials: 'omit', allowInsecureLoopback });
        workflow = new WorkflowCoordinator({ session, adapter: http.adapter, persistence: http.persistence });
        shares = new ShareCoordinator({ session, adapter: http.shareAdapter, viewerOrigin, allowInsecureLoopback });
        return { session, client, workflow, shares, dispose() { shares.dispose(); workflow.dispose(); session.dispose(); } };
    } catch (error) { shares?.dispose(); workflow?.dispose(); session?.dispose(); throw error; }
}
