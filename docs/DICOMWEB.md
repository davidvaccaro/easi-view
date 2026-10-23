# DICOMweb archive browsing

EASI View can search a DICOMweb archive, browse a study's series, and open a
series without downloading all of its image instances first. This is available
in the standalone viewer and through the embedded viewer API.

## Try the standalone viewer

1. Choose **Archive** in the header or study library.
2. Enter the DICOMweb service address, such as
   `http://127.0.0.1:5174/orthanc/dicom-web/` when using this repository's local
   preview with Orthanc running on port 8042 and its DICOMweb plugin enabled.
3. Choose **Connect & search**. Optionally filter by patient ID, accession,
   modality, or study date.
4. Choose a study and then a series. Use the frame slider, arrow keys, scroll,
   or cine controls to navigate it.

The **On device** tab retains local file and synthetic demo access. Opening the
viewer, choosing local files, and browsing synthetic examples do not connect to
an archive. Connections begin with an explicit archive action.

The service address is the DICOMweb base URL, not the Orthanc administration
page and not an individual instance URL. An individual DICOM/WADO-RS URL can
still be opened through the separate HTTP source control or `viewer.openUrl()`.

The local development/preview server bridges read-only DICOMweb study routes to
`http://127.0.0.1:8042/dicom-web/`. It streams responses, forwards only `Accept`,
and accepts loopback hosts and same-origin browser requests. It does not forward
cookies or authorization headers, follow redirects, accept upload requests, or
choose another target from a URL. This bridge is for local anonymous Orthanc
testing; it is not included in the static deployment artifact. Deployed apps
need archive CORS or their own authenticated gateway. Adjust the viewer port in
the bridge URL if your local preview uses a port other than 5174.

## Embed an archive workflow

```js
import { createViewer } from '/easi-view/assets/easi-view.js';

const viewer = createViewer(document.querySelector('#images'), {
  branding: { name: 'Your Imaging Product' },
  ui: { library: true },
});
await viewer.ready;

viewer.configureArchive({
  baseUrl: 'https://archive.example/dicom-web/',
});

const studies = await viewer.searchStudies(
  { modality: 'CT', studyDate: '20261001-20261031' },
  { offset: 0, limit: 25 },
);

if (studies.items.length) {
  const study = studies.items[0];
  const series = await viewer.listStudySeries(study.studyUid, { limit: 25 });
  if (series.items.length) {
    await viewer.openArchiveSeries(study.studyUid, series.items[0].seriesUid);
    await viewer.setFrame(Math.min(10, viewer.getState().frameCount - 1));
  }
}

// When the application removes the viewer:
viewer.dispose();
```

Select an available frame index: `setFrame()` uses a zero-based index and rejects
an index outside the currently loaded stack. Applications should inspect
`viewer.getState().frameCount` before selecting a specific frame.

Incompatible image geometry is kept in separate stacks. The standalone archive
panel shows a **Loaded image stack** selector when needed; hosts can select one
with `viewer.setSeries(index)`, using `getState().seriesCount` for its bounds.

`searchStudies()` accepts `patientId`, `patientName`, `studyDate`,
`accessionNumber`, `modality`, and `studyUid`. Matching syntax such as wildcards
and date ranges is interpreted by the archive. `listStudySeries()` scopes its
query to one Study Instance UID.

Both search methods accept `{ offset, limit, signal }`. A page has
`{ items, hasMore, nextOffset, warnings }`. Limits range from 1 to 100; the
default is 25 for studies and 50 for series. Continue with `nextOffset` while `hasMore` is true. A full page can
have `hasMore: true` even when it happens to be the last page: QIDO does not
provide a universal total-result count, so the next page may be empty. Server
truncation warnings are represented by a fixed message, rather than exposing
arbitrary response-header content.

Search records and metadata belong to the application that explicitly requested
them. Public viewing events and `getState()` omit patient names, patient IDs,
credentials, and pixel arrays. An application must handle returned search
records according to its own data-access requirements.

## Host-managed authentication

The host application owns sign-in and can supply request headers as an object
or as an async function. A function is called for each request so the host can
provide a current access token.

```js
viewer.configureArchive({
  baseUrl: 'https://archive.example/dicom-web/',
  headers: async ({ signal }) => ({
    Authorization: `Bearer ${await accessTokenForArchive({ signal })}`,
  }),
  credentials: 'omit',
});
```

`accessTokenForArchive()` is your application's authentication function; EASI
View does not implement an identity service. Do not put tokens in URLs, demo
source, branding options, or committed configuration. Header values and
connection configuration remain in memory. The viewer does not store them in
cookies, local storage, session storage, or telemetry.

The default browser credentials mode is `omit`. A host can explicitly select
`same-origin` or `include` for a cookie-based deployment. The viewer manages
`Accept` itself to negotiate its supported metadata and pixel formats; do not
supply an `Accept` header. Browser-controlled headers such as `Cookie`, `Host`,
and `Origin` cannot be provided through the header hook.

An async header supplier receives the request URL and cancellation signal.
Avoid logging that URL: search parameters can contain patient identifiers.
Cancellation stops the viewer from waiting on a pending supplier. The host's
own authentication operation should also respect its signal.

`viewer.disconnectArchive()` clears the configured connection, query results,
and any current archive source, canceling its pending work. Reconfiguring an
archive also clears its previous archive source. Local and synthetic viewing
remain available. The viewer's lifecycle cleanup cancels pending work when
`dispose()` is called. No
upload or server mutation is performed by archive viewing.

## What is streamed and what is retained

The archive workflow has separate metadata and image steps:

1. **QIDO-RS queries** retrieve DICOM JSON study and series summaries.
2. **WADO-RS series metadata** passes through EASI JS's DICOM metadata pipeline
   to construct frame descriptors and compatible stacks. Metadata contains no
   decoded pixel arrays. Pixel Data embedded as InlineBinary in a metadata
   response is rejected: pixels must arrive through explicit instance retrieval.
   BulkDataURI references are not followed.
3. **Selected-instance retrieval** requests the instance containing the
   requested frame, negotiates a supported transfer syntax, and streams its
   DICOM response through EASI JS. Its identity and pixel geometry must agree
   with the metadata before it is displayed.
4. **Frame decoding and display** decode only the selected frame and pass its
   original scalar samples to EASI View's own renderer. Cache hits reuse
   retained instances or decoded frames.

Seeking to a distant frame prioritizes that frame. A newer navigation request
cancels the superseded retrieval or decode. The alpha does not download
neighboring instances unless **Prefetch nearby** is explicitly enabled. The
default retrieves a complete DICOM instance, so a multiframe instance brings its
encoded frames together while decoding remains per-frame. The optional native
frame mode below retrieves only the selected frame.

Metadata JSON is bounded, validated and canonicalized before EASI parsing so
valid attribute property orders work with the pinned EASI JS package.

Current bounds are 8 MiB per metadata response, 10,000 frames per opened series,
4,096 frames per individual instance, and 256 MiB per retrieved instance. The
encoded pixel-instance cache and decoded-frame cache each retain at most
64 MiB. These cache budgets do not cap the full browser heap: active HTTP
parsing buffers, metadata, one oversized active instance, and GPU textures are
additional allocations. An instance larger than the encoded cache budget is
usable within the instance limit but is not retained by that cache.

Pixels are limited to the current native 8/16-bit grayscale and unsigned
8-bit RGB (three channels, planar configuration 0/1) profiles. An archive can
satisfy a supported profile by transcoding a compressed source
to a supported transfer syntax. A server that ignores negotiation and sends
unsupported compressed pixels is rejected. YBR/palette or 16-bit RGB,
nonempty ICC/color-space metadata, enhanced functional groups,
and specialty objects retain their documented limitations; DICOMweb access
does not add their display implementations.

Classic XA follows the same selected-instance workflow: a multiframe instance
is retrieved in full, then frames are decoded individually. Only the bounded
native grayscale profile is accepted, without active subtraction or special
angiographic presentation. Its manual navigation and forward-loop cine preview
use fixed Frame Time, without prescribed trim or sweeping playback semantics.
For a JPEG-stored XA source, a server such as Orthanc
can return negotiated native pixels. This is server transcoding, not client JPEG
codec support; opening the original compressed file locally is still deferred.
DSA, enhanced XA/XRF, rotational geometry and specialized calibration remain
future work.

Malformed optional spatial metadata can permit a 2D preview with a visible
geometry notice. Invalid spacing does not produce fabricated millimeter
measurements. Inconsistent geometry creates separate stacks rather than a
single misleading stack.

## Browser and archive deployment requirements

The archive must expose QIDO study and series searches, series metadata, and
WADO instance retrieval. It must permit the viewer's origin through CORS. For
cross-origin authorization headers, support the browser's `OPTIONS` preflight
and allow the actual headers used by your host. Cookie credentials additionally
require an explicit allowed origin and permission for credentialed requests.

Serve production viewer and archive traffic over HTTPS. Browsers normally block
an HTTPS application from fetching an ordinary HTTP archive. A same-origin
application gateway is another option; it must enforce the application's access
control and stream archive responses without turning local file viewing into an
upload workflow. EASI View does not configure or deploy that gateway.

The client uses GET requests, rejects redirect responses, and constructs archive
paths from validated numeric DICOM UIDs. It does not follow server-supplied
`BulkDataURI` values or arbitrary retrieval URLs. Archive HTTP errors expose the
status and a fixed diagnostic message, rather than reflecting response bodies,
request URLs, or credentials into the interface.

## Troubleshooting

- **No matching studies:** remove filters or check the archive's matching rules.
  An empty page is a valid search result.
- **Request failed:** check the DICOMweb base address, browser CORS/preflight,
  HTTPS compatibility, and authentication.
- **HTTP 401/403:** supply access through the host application or use the correct
  archive permission. The viewer cannot bypass archive authorization.
- **HTTP 404 after a successful search:** verify that the selected stored series
  and instances still exist. An archive can return query records whose underlying
  files are unavailable. Check the archive's own logs using its administrative
  tools.
- **Unsupported profile:** inspect the stated pixel or metadata restriction.
  Opening a failing replacement preserves the currently committed image.
- **Slow repeated visits to large instances:** an instance exceeding the encoded
  cache budget is retrieved again when needed. Use native frame mode when the
  archive and complete scalar/palette metadata support it, or narrow the series.

Local compatibility checks against Orthanc 1.12.8 with DICOMweb plugin 1.20
confirmed QIDO, series metadata, native multipart WADO retrieval, EASI parsing,
and native grayscale decoding for an available instance. Some existing records
in that local archive returned Orthanc's “Accessing an inexistent item” error;
those records did not prevent retrieval of other available images. Automated
checks use an independent synthetic archive and generated DICOM data, without
requiring Orthanc or a local imaging corpus.

## References

- [DICOM PS3.3 Image Pixel Module (RGB channels and planar configuration)](https://dicom.nema.org/medical/DICOM/current/output/chtml/part03/sect_C.7.6.3.html)
- [DICOM PS3.18 Search transaction (QIDO-RS)](https://dicom.nema.org/medical/dicom/current/output/chtml/part18/sect_10.6.html)
- [DICOM PS3.18 Retrieve transaction (WADO-RS)](https://dicom.nema.org/medical/dicom/current/output/chtml/part18/sect_10.4.html)
- [Orthanc DICOMweb plugin documentation](https://orthanc.uclouvain.be/book/plugins/dicomweb.html)
- [DICOM PS3.3 X-Ray modules and classic XA pixel profile](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.8.7.html)
- [DICOM PS3.3 Cine module](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.7.6.5.html)
- [DICOM PS3.3 Mask subtraction module](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.7.6.10.html)
- [Embedded viewer integration](EMBEDDING.md)
- [Supported image profiles](STATUS.md)

Compressed transport now uses `transfer-syntax=*`; EASI View validates and
decodes the actual received syntax. Metadata and retrieved pixels must agree
on identity, dimensions, stored layout and geometry. Valid changes in encoded
planar storage are decoded according to the retrieved instance and produce
canonical samples. See [COMPRESSED.md](COMPRESSED.md).

If an original pixel-encoding/index profile is unsupported, the archive loader
retries the selected SOP once with native Explicit VR Little Endian negotiation.
It validates identity/geometry before indexing on both attempts; HTTP, cancel,
source limits and semantic errors do not retry. Local files still fail clearly
on that unsupported encoding.

## Compare loaded studies and earlier candidates

`openArchiveSeries` replaces the current library. `addArchiveSeries(studyUid,
seriesUid, { viewport })` appends compatible stacks and assigns the first to the
specified pane (active pane by default). Existing panes and loaded local studies
remain available. In the Archive panel, enable **Add series to active pane**
before opening another series. Reopening an already loaded Study/Series pair
assigns its first stack without retrieving it again. The combined library is
bounded to 128 stacks and 10,000 frames. A failed or canceled addition discards
its new source; it must not overwrite another pane's image.

```js
await viewer.setLayout(2);
await viewer.openArchiveSeries(currentStudyUid, currentSeriesUid);
await viewer.addArchiveSeries(priorStudyUid, priorSeriesUid, { viewport: 1 });
viewer.setPrefetch({ enabled: true, neighbors: 2 }); // Optional; off by default.
```

**Find earlier study candidates** appears after selecting a study with an exact
Patient ID and complete date. It performs a bounded metadata-only search in the
configured archive. It excludes the current study and undated/newer results;
it does not retrieve pixels, automatically load studies, or establish patient
identity. Confirm identity before opening and comparing a candidate. Hosts can
call `findPriorStudies({ patientId, currentStudyUid, currentStudyDate, modality? },
{ signal?, limit?, maxPages? })`. See [PRIOR_STUDIES.md](PRIOR_STUDIES.md).

## Selected native-frame retrieval

Set `retrievalMode: 'frame'` in `configureArchive`, or choose **Native grayscale /
palette frame** before connecting. This opt-in policy uses the fixed requested
WADO-RS `/frames/N` path and requests native Explicit VR Little Endian octet-stream
pixels. It supports complete MONOCHROME1/2 or direct-palette metadata only; RGB,
missing external LUTs, or unsupported peer representations reject explicitly.
There is no implicit fallback to a full instance under this policy.

Single-part octet-stream or exactly one native multipart part must contain the
exact selected frame byte count. Multipart headers/envelope and frame pixels
are bounded. Any Content-Location must identify the exact requested resource;
foreign origins, another SOP/frame, multiple parts, rendered images and encoded
frame representations reject. Server BulkDataURI values are never followed.
Derived thumbnails come only from already displayed frames, have at most 96
pixels on their longest side, and share a separate 4 MiB RGBA cache; creating them
never starts another archive request. They are previews, not original samples.
