# Storage sources

Open the upper-left viewer menu and choose **Storage sources**. The same manager
is available from **Open… → Open Study → From remote storage → Storage sources…**.
Closing the manager from that workflow returns to the updated source choices.

## Add and test an archive

1. Choose **Add source**, then enter a recognizable name.
2. Select DICOMweb, DIMSE through an HTTP gateway, or DIMSE through the local helper.
3. Enter the service address or the PACS connection settings described below.
4. Choose authentication where applicable, then **Test connection**.
5. Review the individual checks. Choose **Save source**, then open remote studies
   using the named archive.

Testing an unsaved draft does not save or replace its source. Tests are explicit,
cancellable, limited to two concurrent operations and bounded by a 15-second
deadline. Closing settings cancels the current test. Changing a field clears an
earlier result so it cannot be mistaken for verification of new settings.

The test performs a study metadata query with a page limit of one. Local DIMSE
also performs C-ECHO. No images are downloaded, and returned patient metadata is
discarded. A successful empty response is valid. The result explicitly says that
image retrieval, decoding and display have **not** been tested; open a study to
exercise those paths. Failures distinguish authentication/permission responses,
timeouts, malformed metadata and general network/HTTPS/CORS problems without
displaying a remote error body or credentials.

## DICOMweb and HTTP DIMSE gateways

Enter an absolute HTTP(S) base URL for the service. A DIMSE gateway must implement
the [EASI HTTP gateway contract](../examples/dimse-gateway/README.md); a native
PACS TCP port is not an HTTP endpoint.

Authentication choices are:

| Choice | Behavior |
| --- | --- |
| None | Send no credentials; the server must permit the requested access |
| Browser session | Use the archive's browser session; sign in at that archive first |
| Bearer token | Send the entered token in the Authorization header for this session |
| Username and password | Send HTTP Basic authentication for this session |

Remote authenticated endpoints require HTTPS. HTTP credentials are permitted
only for loopback development. Usernames, passwords and tokens remain in memory;
they are not included in source descriptors, test results or remembered profiles.
Editing an unchanged connection can retain its current credential using blank
credential fields. Changing its endpoint or authentication method requires fresh
credentials; changing a Basic username requires a fresh password.

Direct cross-origin archives must allow the viewer origin through CORS. Cookie
authentication also depends on credentialed CORS and browser cookie policy.
Selecting None does not change archive permissions or bypass these rules.
An HTTPS viewer cannot fetch an ordinary HTTP archive. A host application can
provide a same-origin gateway instead. The named local Store/Orthanc sources in
the development server already use their configured local bridges.

## Native DIMSE with the local helper

Run the standalone viewer with `npm run dev` or `npm run preview`. Its loopback
server includes the optional local connector. When available, the manager offers
**DIMSE through this local helper** and fields for:

- PACS host and TCP port.
- Calling AE title identifying this viewer's connector.
- Called AE title identifying the archive.

Configure the archive to trust the connector's source IP and calling AE title.
The helper uses C-FIND and C-GET through EASI JS; HTTP credentials are never sent
to the DIMSE peer. Native DICOM TLS is not implemented by this helper. Hosted
static viewers and embedded applications use an explicitly deployed HTTP gateway
instead; they cannot open native DIMSE sockets in the browser.

The helper accepts only same-origin loopback control requests. It validates and
binds each target to a generated connector ID, rejects unsupported secret/TLS
fields and prevents request query parameters from selecting another TCP peer.
DNS results are validated and pinned to a literal address for each operation.
The helper permits configured LAN PACS addresses and rejects metadata-service,
link-local, unspecified and multicast destinations.

Opting to remember a local DIMSE source also saves its nonsecret target in an
owner-only configuration file. The development server uses
`storage-sources-<viewer-port>.json` under:

- macOS: `~/Library/Application Support/EASI View/`
- Windows: `%APPDATA%/EASI View/` (home directory fallback).
- Linux: `$XDG_CONFIG_HOME/easi-view/` or `~/.config/easi-view/`.

`EASI_VIEW_CONFIG_DIR` overrides that directory. No environment file is required.
Session-only targets remain in service memory and are removed when released or
the service stops. Listing or restoring profiles does not contact the PACS.

## Remember, edit and remove

**Remember this source in this browser** saves only nonsecret connection settings.
After a page reload, token/password sources require credential re-entry. Browser
storage is scoped by origin, including port; localhost and 127.0.0.1 have separate
settings. If storage is unavailable, use session-only sources.

The default source is shown first when choosing remote storage. Edit settings
and save explicitly, or use **Remove source** and its confirmation. These actions
do not delete anything from the archive. Close studies belonging to a source
before changing or removing its connection; existing patient references must
never silently point to a different archive.

## Embedded and managed sources

Applications supply `sources` and current credentials using the existing SDK.
These entries are marked **Managed**: users may test them, but cannot edit or
remove their connection details. User editing defaults off and is controlled by
`opening.sourceEditing`. An embedded viewer does not receive browser persistence
or the local helper automatically. Authentication/OAuth sign-in, token refresh
and server authorization remain owned by the host application.

The SDK adds:

```js
viewer.openStorageSources();
const result = await viewer.testSource('main-pacs', { signal });
viewer.updateSource({ id: 'main-pacs', name: 'Main PACS', type: 'dicomweb',
  baseUrl: 'https://pacs.example/dicomweb/', headers: currentSessionHeaders });
viewer.removeSource('main-pacs');
```

`testSource` returns only safe check summaries. Host update/remove applies to
host-managed sources and rejects sources with admitted studies. User-added
profiles are maintained through Storage sources so persistence, credentials and
connector cleanup stay together. No registration, profile restoration or source
listing automatically searches an archive.
