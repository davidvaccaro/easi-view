# Host identity, workflow, and controlled sharing

Installed SDK users should start with the [embedding guide](EMBEDDING.md) and the viewer/SDK section below. Examples importing `src/` require a repository checkout; those internal modules are not npm exports.


EASI View's enterprise modules connect a viewer host to its own identity,
worklist, persistence, and sharing services. They use host-provided callbacks;
they do not select an identity provider, store credentials, or implement a
PACS vendor's authentication protocol. The modules are available from
`src/enterprise/index.js`. The standalone viewer does not sign users in or
create shares automatically.

The host backend must authenticate and authorize every worklist, context,
share, and DICOM read. A browser identity or permission flag is not an access
control boundary. These foundations do not imply clinical, regulatory, or
security certification.

## Identity and DICOMweb

```js
import { EnterpriseSession } from '../src/enterprise/index.js';
import { DicomWebClient } from '../src/data/DicomWebClient.js';

const session = new EnterpriseSession({
    archiveOrigins: ['https://imaging.example.org'],
    identityAdapter: {
        login: ({ signal }) => hostIdentity.login({ signal }),
        logout: ({ signal }) => hostIdentity.logout({ signal }),
        current: ({ signal }) => hostIdentity.current({ signal }),
        getHeaders: ({ identity, url, signal }) =>
            hostIdentity.headersForArchive({ identity, url, signal })
    },
    audit: event => hostAudit.record(event)
});

// Connect this to the host's explicit sign-in action.
await session.login();
const client = new DicomWebClient({
    baseUrl: 'https://imaging.example.org/dicom-web',
    headers: request => session.dicomHeaders(request),
    credentials: 'omit'
});
const page = await client.searchStudies({ modality: 'CT' }, { limit: 25 });
```

`hostIdentity` and `hostAudit` above are supplied by the application. No example
contains a reusable credential. `current()` returns `null` or
`{ subject, realm, expiresAt }`, where `expiresAt` is an absolute future epoch
time in milliseconds. `login()` may return that identity directly; returning
`undefined` causes a subsequent `current()` call. The realm identifies the
host's identity tenant or security domain. Subjects and realms are bounded,
control-free strings and are not included in default state or audit events.

Every authorized operation calls `current()` again, and every DICOM request
calls `getHeaders()` again. This permits the host to refresh or rotate a
credential per request. Returned headers are a plain object bounded to 32
fields and 8KiB. The viewer controls `Accept`; cookies, routing headers, and
browser security headers cannot be supplied through this callback. DICOMweb
redirects are rejected and credentials are omitted by default.

`archiveOrigins` is an explicit origin allowlist. HTTPS is required. The
`allowInsecureLoopback:true` option permits HTTP only for local development;
it is not an option for a remote production service. The host header callback
should additionally bind credentials to the intended archive path/resource.
Configure the DICOMweb client with a fixed base address, not an address taken
from a worklist item, share receipt, or user-provided context.

`session.getState()` returns only `{ authenticated, expiresAt, disposed }`.
`subscribe(handler)` observes detached copies of that state and returns an
unsubscribe function. `getRevision()` returns a numeric identity revision,
so a host can detect subject/realm changes without exposing identity fields.
`logout()` immediately clears the local identity and
aborts pending operations before awaiting the backend. Explicit logout stays
latched even if backend logout fails; a later explicit `login()` is required.
Identity subject/realm changes and disposal also abort pending operations.
An `AbortSignal` may be passed to login, logout, and coordinator operations.
Late results from adapters that ignore cancellation are not committed.

Observer and audit callback failures, including rejected promises, are
isolated. Audit events contain only a fixed operation name,
`success|error|canceled`, and `durationMs`. They never include names, UIDs,
URLs, credentials, pixels, response bodies, or provider error messages. A
host needing a durable or attributable audit trail must implement it on its
backend; the callback itself is neither durable storage nor enforcement.

## Worklists and explicit study context

```js
import { WorkflowCoordinator } from '../src/enterprise/index.js';

const workflow = new WorkflowCoordinator({
    session,
    adapter: {
        list: request => hostWorkflow.list(request),
        openStudy: request => hostWorkflow.openStudy(request)
    },
    persistence: {
        load: request => hostContexts.load(request),
        save: request => hostContexts.save(request)
    }
});

const page = await workflow.listWorklist({ offset: 0, limit: 25 });
const context = await workflow.openStudy(page.items[0].reference);
await workflow.saveContext('reading-session-1', context);
const restored = await workflow.restoreContext('reading-session-1');
```

Worklist adapters receive `{ identity, signal, offset, limit }` and return
`{ items, nextOffset }`. Pages contain at most 100 items; `nextOffset` is null
or advances beyond the requested offset. Each item has a unique `key`, a
bounded `title`, and an archive `reference`. Optional fields are `modality`,
`priority` (`normal|urgent`), and `status`
(`scheduled|ready|reading|complete`). Treat titles as host-managed text and
render them with text nodes. No patient name, patient ID, or arbitrary vendor
fields are included by default.

References are `{ archiveKey, studyUid, seriesUid?, sopUid? }`. `archiveKey`
is an opaque configured archive identifier, not a network address. UIDs are
validated DICOM numeric identifiers. A SOP reference also requires a series.
Adapters must map the archive key to a fixed authorized server configuration.

`openStudy()` receives `{ identity, signal, reference }` and returns a versioned
context with the requested reference active. A context is limited to 64KiB:

```json
{
  "version": 1,
  "layout": 2,
  "activeViewport": 0,
  "viewports": [
    {
      "slot": 0,
      "reference": { "archiveKey": "primary", "studyUid": "2.25.100", "seriesUid": "2.25.100.1", "sopUid": "2.25.100.1.1" },
      "frameIndex": 0,
      "originalFrameNumber": 1,
      "window": { "center": 40, "width": 400 }
    }
  ]
}
```

Layouts are 1, 2, or 4; slots are unique and within the selected layout; frame
indices are zero-based and bounded below 10000. Windows are optional finite
center/positive width pairs. Unknown fields are rejected. Contexts carry no
pixels, patient labels, arbitrary URLs, access tokens, or browser storage
settings. The host must resolve referenced series, validate the selected
group/frame against current data, and apply the context through viewer APIs.
`originalFrameNumber`, when supplied, is an authoritative one-based encoded
frame number from1 to4096 and requires an exact SOP reference. This preserves
the selected image across enhanced temporal/echo grouping and spatial sort.
`frameIndex` remains a logical navigation hint. Older contexts without an
original frame number retain that hint fallback; their SOP reference still
constrains the selected instance. These viewing contexts remain separate from
annotation documents and their durable image references.

Persistence is optional and always explicit. No `localStorage`, cookies,
database, automatic restoration, or automatic patient-data saving is added.
The persistence adapter must authorize both key ownership and the referenced
archive resources. `restoreContext()` returns null when no saved context
exists. Disposing the workflow aborts its operations without disposing the
shared identity session.

## HTTP host adapter protocol

`createEnterpriseHttpAdapters({ baseUrl, headers, credentials:'omit' })`
returns `{ adapter, persistence, shareAdapter }`. It implements a small host
JSON protocol, separate from DICOMweb:

| Method and route | Request | Response |
| --- | --- | --- |
| GET `/worklist?offset=N&limit=N` | Authorized request | Worklist page |
| POST `/study-context` | Archive reference | Version1 context |
| GET `/contexts/:key` | Authorized request | Context or 204 |
| PUT `/contexts/:key` | Context | Successful response or 204 |
| POST `/shares` | `{reference,ttlMs,viewerOrigin}` | Share receipt |
| POST `/shares/verify` | `{receipt,operation}` | Server verification |
| DELETE `/shares/:shareId` | Authorized request | Revocation receipt |

`headers({ identity, url, signal })` is called per request. HTTP response JSON
is limited to 64KiB, must be valid UTF-8 with `application/json`, and is then
validated by its coordinator. Requests reject redirects, omit credentials by
default, and use `cache:'no-store'`. Explicit `credentials:'same-origin'` can
be used for a host's cookie session. The host must provide corresponding CSRF
protection for state-changing endpoints. Timeout defaults to 30 seconds and
is configurable up to 5 minutes. There is no arbitrary endpoint discovery or
fallback to a guessed PACS login/worklist API.

## Controlled sharing

```js
import { ShareCoordinator } from '../src/enterprise/index.js';

const shares = new ShareCoordinator({
    session,
    adapter: hostShareAdapter,
    viewerOrigin: 'https://viewer.example.org'
});
const issued = await shares.create(archiveReference, { ttlMs: 15 * 60 * 1000 });
// Transfer this receipt only through the host's deliberate protected flow.
const verified = await shares.resolve({
    shareId: issued.shareId,
    capability: issued.capability
});
await shares.revoke(issued.shareId);
```

All three server methods (`create`, `verify`, and `revoke`) are required.
`create()` returns an opaque `{ shareId, capability }`. `verify()` is called
after creation, on every resolution, and after revocation. It must return:

```js
{
    shareId, subject, realm, origin, expiresAt,
    revoked: false, permissions: ['view'], reference
}
```

Verification must match the current host identity, realm, configured viewer
origin, expected share ID, and a future expiry. A newly created reference must
match exactly. Revocation verification requires `revoked:true`. Creation
lifetimes are explicitly bounded from 1 second to 24 hours; the default is 15
minutes. The backend should issue and enforce its own shorter expiry policy.
Only the explicit creation result exposes a capability. Default state stores
bounded expiry/generation bookkeeping and returns only an active count.

The server owns grants, recipient access, revocation, and authorization for
every subsequent DICOM read. The client checks consistency of the trusted
adapter response; it cannot make an untrusted archive secure. A share receipt
does not automatically connect a viewer, change archive headers, or generate
a URL. The host must enforce the verified reference scope when configuring
access. Do not put capabilities in query strings, logs, or default events.
Revocation stops future authorized access; it cannot retract bytes already
delivered to a recipient. A backend may provide a revocation signal to cancel
an ongoing gateway read.

Local files, raw pixels, arbitrary URLs, and credentials are not accepted as
share references. Sharing local files requires a separately designed,
explicit host upload/storage workflow, which is not implemented here.

## Read-only gateway example

The repository-only `examples/gateway` directory contains a runnable
synthetic smoke test and a configured HTTPS server. The gateway fixes one
upstream archive and asks a server authorization callback to approve each
read. It never forwards browser cookies or authorization headers upstream;
upstream credentials come only from the trusted server callback/process.
It supports bounded QIDO metadata, selected instance retrieval, and a narrow
native selected-frame profile. It is not an arbitrary URL proxy.

Metadata is capped at 8MiB, complete instances at 256MiB, and selected frame
responses at 64MiB. Concurrency defaults to 4 and is bounded to 16. Header
rewriting retains at most 16KiB of MIME headers and a small closing-boundary
tail, so pixels begin flowing before the response ends. A malformed tail or
over-budget stream destroys the response; the viewer must reject that failed
retrieval instead of committing a partial image.

Authentication policy, returned metadata scope, session revocation, rate
limits across processes, and storage/audit retention remain host/backend
responsibilities. Configure an archive user's upstream permissions or enforce
query/result scope before using a broadly privileged upstream service account.
This example does not provide the worklist/share/persistence backend.

## Bind the services to a viewer

```js
import { createEnterpriseViewer } from '../src/integration/enterprise-viewer.js';

const enterprise = createEnterpriseViewer(viewer, {
    identityAdapter: hostIdentity,
    archive: { key: 'primary', baseUrl: 'https://imaging.example.org/dicom-web' },
    workflowAdapter: hostWorkflow,
    persistence: hostContexts,
    shareAdapter: hostShares,
    viewerOrigin: 'https://viewer.example.org',
    audit: event => hostAudit.record(event),
    onChange: state => renderEnterpriseStatus(state)
});

await enterprise.login();
const worklist = await enterprise.listWorklist({ limit: 25 });
await enterprise.openStudy(worklist.items[0].reference);
await enterprise.saveContext('reading-session-1');
await enterprise.restoreContext('reading-session-1');
await enterprise.logout();
await enterprise.dispose(); // Leaves the host viewer and local panes owned by the application.
```

Construction performs no sign-in, query, persistence, or sharing operation.
Explicit login configures the fixed DICOMweb address with a per-request session
header callback. The wrapper uses only public viewer methods:
`configureArchive`, `disconnectArchive`, `exportStudyContext`, and
`applyStudyContext`. One controller owns one viewer until service cleanup
finishes; it never calls `viewer.dispose()`.

`openStudy(reference,{signal})` obtains an authorized host workflow context,
validates every archive key, and asks the viewer to apply it transactionally.
`saveContext(key,{signal})` exports only referenced archive panes from the
viewer, normalizes the version1 schema, and explicitly invokes persistence.
Local files, pixels, URLs, and credentials are excluded. `restoreContext` loads
and revalidates that schema before applying it. Saved original SOP/frame
references remain authoritative across enhanced group ordering; logical frame
indices are hints. The viewer must reject unsupported source geometry, profile,
or identity mismatches rather than restoring another image.

`createShare(reference,options)` creates only an explicit archive share.
`resolveShare(receipt,{signal})` verifies the backend grant, obtains a workflow
context, and constrains **every** context pane to its verified Study/Series/SOP
scope before applying it. The capability never becomes an archive URL or an
authorization header. The host backend still authorizes each DICOM read;
client scope checks are a consistency guard, not server access control.

Logout, identity changes, identity expiry, active-share expiry/revocation, and
a newly denied verification of the active share cancel protected operations
and disconnect remote projections. A fresh explicit login is required to
configure access again. Identity and active-share expiry are checked with
timers even when no new request occurs. The viewer's disconnect implementation
must also purge protected annotation/overlay/reconstruction/history state while
preserving local panes. A canceled remote transaction must not restore denied
remote images during rollback.

`getState()` and `subscribe()` expose only safe booleans and operational counts:
authentication, connection, pending operations/cleanup, worklist count, and
share count. They do not expose identity subjects, realms, references, URLs,
capabilities, or pixels. A failed host disconnection sets `blocked:true` and
causes authentication operations to fail; the wrapper cannot erase another
component's data without that component implementing its public disconnect
contract. Callback errors are isolated. Dispose the controller to clear its
timers and adapter lifetime; host viewer disposal also triggers that cleanup
when its public `dispose` event is available.

## Lifecycle and validation

Dispose coordinators first, then the shared `EnterpriseSession` when the host
tears down its viewer. Also disconnect/cancel the viewer's archive operations;
identity disposal alone does not erase pixels already displayed or cached by
another component. No enterprise module sends telemetry or persists data by
default.

Synthetic tests exercise rotating headers, ignored late callbacks, logout,
realm changes, expiry, bounded JSON/context validation, controlled sharing,
authorization rejection, stream cancellation, redirect rejection, and exact
native-frame location rewriting. Run `npm run check` and
`node examples/gateway/server.mjs --synthetic` from the repository root.

The transport design follows [HTTP origin and request semantics](https://www.rfc-editor.org/rfc/rfc9110.html),
[Node's HTTPS server API](https://nodejs.org/api/https.html), and
[Node streaming backpressure and pipeline cancellation](https://nodejs.org/api/stream.html).


## Installed viewer integration

```js
import { createViewer, createEnterpriseViewer } from '@xinonix/easi-view';
const viewer = createViewer(document.getElementById('viewer'), { initialDemo: null });
const enterprise = createEnterpriseViewer(viewer, {
  identityAdapter: host.identity,
  archive: { key: 'primary', baseUrl: 'https://images.example.org/dicom-web' },
  workflowAdapter: host.worklist, persistence: host.contexts, shareAdapter: host.shares,
  viewerOrigin: location.origin
});
await enterprise.login(); // The host's explicit sign-in action.
const page = await enterprise.listWorklist();
await enterprise.openStudy(page.items[0].reference);
await enterprise.saveContext('review');
await enterprise.logout();
```

The `host` adapters are the application's real backend integrations. There is no implicit account, sign-in, credential storage or automatic save. `examples/gateway` provides a separately operated read-only gateway and an explicitly synthetic local development mode; it is not automatically deployed. Production identity, authorization policy, retention and TLS belong to the host backend.

The viewer exports an explicit version1 reference-only context through `exportStudyContext({archiveKey})`; local File/Blob panes are omitted. SOP Instance UID plus one-based `originalFrameNumber` preserve enhanced-image partition identity. `applyStudyContext(context,{archiveKey,scope,signal})` prepares bounded metadata and only requested pixel frames, validates all panes against the fixed client/reference scope, then commits. Failed replacements retain the previous workspace while its archive remains authorized. A changed/disconnected archive cannot restore its old protected scene. Study-only navigation considers one page of25 series and at most5 metadata attempts; choose an exact series when the desired study cannot be found within that bound.

Logout, expiry, identity realm/subject changes and revoked active shares abort protected operations, clear archive frames/caches, reconstruction, masks, reported documents, presentation states and historical remote thumbnails. Remote annotation references and all undo/redo history are purged. A pending replacement with an archive rollback snapshot is canceled and that snapshot is sanitized. Existing local-file image panes remain available; local derived documents are also conservatively cleared. Explicit host exports/copies remain the host's responsibility. `disconnectArchive()` returns a cleanup promise after its immediate protected-pixel removal, and `whenDisposed()` waits for owned pending reconstruction/mask cancellation after disposal.

Shared capabilities are passed explicitly to a backend verifier, never inserted into archive URLs, archive headers or browser history. The verifier's bounded reference narrows every restored pane. Neither the wrapper's client-side flags nor a context file authorizes a DICOM read.

A failed `current()`/`getHeaders()` refresh or invalid returned headers latches the session off and clears protected projections until explicit sign-in. A canceled older refresh cannot revoke a newer sign-in. Context commit has an explicit synchronous ownership handoff: immediate cancellation before handoff rolls back; cancellation queued after successful handoff leaves the committed images valid.
