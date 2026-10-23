# EASI View DIMSE HTTP gateway

The browser cannot open a DIMSE TCP association. This independent example uses
EASI JS's exported Node DIMSE transport to expose a fixed PACS as a read-only
HTTP source. It does not edit or fork EASI JS and does not contain a viewer engine.

The viewer source is configured as `type: 'dimse'`; its `baseUrl` must point to
this HTTP facade, not to the PACS TCP port or the Kitchen Sink demonstration API.

## Run locally

Create a private host module outside the repository. The example runner listens
only on `127.0.0.1`, rejects other Host values, and permits one exact viewer
origin. The host supplies the authorization decision for each query/resource.

```js
// /absolute/path/to/host-config.mjs — do not commit application credentials.
export const association = {
    host: '127.0.0.1', port: 4242,
    callingAeTitle: 'EASI_VIEW', calledAeTitle: 'ORTHANC'
};
export const publicOrigin = 'http://127.0.0.1:5174';
export const port = 8091;
export async function authorize(request) {
    // Replace these application services with your backend's session/policy checks.
    const identity = await applicationSessions.verify(request.authorization, request.signal);
    return !!identity && await applicationPolicy.canRead(identity, request.resource, request.query, request.signal);
}
```

Then run:

```sh
node examples/dimse-gateway/server.mjs --config /absolute/path/to/host-config.mjs
```

Configure the source in the host viewer:

```js
sources: [{
    id: 'hospital-dimse', name: 'Hospital PACS', type: 'dimse',
    baseUrl: 'http://127.0.0.1:8091/dimse',
    headers: async ({ signal }) => applicationSessionHeaders(signal),
    searchFields: ['patientId', 'patientName', 'patientBirthDate',
        'issuerOfPatientId', 'accessionNumber', 'studyDate', 'modality']
}]
```

Header suppliers are evaluated only for explicit requests; adding the source
makes no PACS request. The `authorize` callback must return the boolean `true`
after checking both the session and the requested scope. It receives only the
Authorization header, method, path, validated query, resource identifiers and
cancellation signal. It does not receive browser-provided AE titles or peer
addresses. Browser credentials are never sent to the DIMSE peer. Configure the
PACS to allow the fixed calling AE title and C-GET Storage SCP role negotiation.
Optional matching fields should be declared only when supported by that PACS.

## Routes and behavior

- `GET /dimse/studies` → Study Root **C-FIND/STUDY**, with bounded patient/study filters.
- `GET /dimse/studies/:study/series` → **C-FIND/SERIES**.
- `GET /dimse/studies/:study/series/:series/metadata` → **C-GET/SERIES**, EASI parsing, then DICOM JSON without pixel bytes.
- `GET /dimse/studies/:study/series/:series/instances/:sop` → **C-GET/IMAGE**, returning exactly one Part 10 instance.

The DIMSE operation itself is buffered by EASI JS before HTTP output. Unlike a
native DICOMweb metadata endpoint, this metadata facade must retrieve the series
to obtain complete rendering metadata. It discards those retrieved pixel bytes
after constructing the metadata response. The selected instance is retrieved
again when the viewer needs its pixels. This deliberate initial implementation
provides correctness and source compatibility, not optimal DIMSE bandwidth.
A deployment can add an authenticated, bounded server cache later.

The facade has no frame endpoint, C-MOVE workflow, arbitrary URL proxy, writes,
file-system routes, or peer-selection parameters. Complete-instance mode is
required. Native fallback narrows C-GET negotiation to Explicit VR Little Endian;
it does not invent a transcoding capability the peer lacks.

Query results are sorted by UID before slicing offset/limit pages. An exactly
full page conservatively offers another page. Partial C-FIND results retain a
fixed 299 warning. Partial C-GET, mismatched study/series metadata, malformed
metadata and multiple-instance retrieval are rejected. UTF-8, default ASCII
and ISO_IR 100 text are supported; other character sets fail explicitly.

Defaults and maxima: two concurrent operations, 60-second timeout, 256 MiB
encoded data per operation, 10,000 result objects and 8 MiB JSON metadata.
Configuration can lower these limits. Cancellation is passed to the DIMSE
transport, including after browser disconnection. No peer response text,
query values, credentials or patient values enter logs or diagnostics.
The HTTP research runner is for local development; production hosts should
mount `createDimseGateway()` behind their HTTPS/authentication infrastructure.

## Verification

```sh
node --test test/source-registry.test.js test/dimse-gateway.test.js
```

The generated integration fixtures cover patient search, full patient study
selection, series metadata, actual EASI parsing and decoded frame samples,
authorization, source isolation, cancellation, bounded output, partial results
and native negotiation. They inject the DIMSE transport boundary and do not
contact a clinical PACS. Real peer interoperability remains an independent
site-specific check; the underlying EASI JS DIMSE transport has its own tests.
