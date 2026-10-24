import { DicomWebClient } from './DicomWebClient.js';

/** HTTP facade backed by server-side DIMSE C-FIND/C-GET. Never opens TCP in the browser.
 * The companion example exposes the same bounded metadata/retrieve routes consumed
 * by ArchiveSeries; an arbitrary DIMSE endpoint is not a compatible HTTP gateway. */
export class DimseGatewayClient extends DicomWebClient {
    constructor(options, internalOptions) {
        if (options?.retrievalMode != null && options.retrievalMode !== 'instance') {
            throw new Error('DIMSE gateways retrieve complete instances; use instance retrieval mode.');
        }
        super({ ...options, retrievalMode: 'instance' }, internalOptions);
    }

    async request(path, options) {
        try { return await super.request(path, options); }
        catch (error) {
            if (error?.name === 'AbortError') throw error;
            if (Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) {
                throw Object.assign(new Error(`The DIMSE HTTP gateway returned HTTP ${error.status}.`), { status: error.status });
            }
            if (/request failed|host could not provide/.test(error?.message ?? '')) {
                throw new Error('The DIMSE HTTP gateway request failed. Check the gateway, authentication, and browser CORS settings.');
            }
            throw error;
        }
    }

    async retrieveNativeFrame() {
        throw new Error('DIMSE gateways do not provide DICOMweb frame retrieval. Use complete instances.');
    }
}

export default DimseGatewayClient;
