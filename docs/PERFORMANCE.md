# Local performance observations and repeatable baselines

EASI View has an in-memory timing recorder, an inspector timing panel, and a
controlled browser baseline. They help separate archive latency, streaming
processing, worker waits, cache reuse, and draw submission. They do not establish
hardware speed, physical display latency, or clinical playback performance.

## Inspect a viewing operation

Open an image and scroll the image inspector to **Pipeline timing**. The panel
shows the latest successful first-display, metadata-index, pipeline, decode,
frame, and display observations, plus the last frame's cache status. Choose
**Reset** in that panel to
clear completed measurements while retaining the current image and caches.

For a host application:

```js
const viewer = createViewer(container);
await viewer.ready;
viewer.configureArchive({ baseUrl: 'https://archive.example/dicom-web/' });

viewer.resetPerformance();
await viewer.openArchiveSeries(studyUid, seriesUid);
await viewer.setFrame(10);

const snapshot = viewer.getPerformance();
console.table(snapshot.summary);
console.log(snapshot.resources);
```

`studyUid` and `seriesUid` come from an explicit archive search. Select only an
available frame index. The application owns any export of this snapshot; the
viewer does not send timing telemetry or persist a timing database.

`getPerformance()` returns a detached snapshot:

```js
{
  limit: 256,
  measurements: [
    { phase: 'frame', durationMs: 3.2, status: 'success',
      decodedCacheHit: true, source: 'archive' }
  ],
  summary: {
    frame: { count: 1, successCount: 1, errorCount: 0, canceledCount: 0,
      lastMs: 3.2, medianMs: 3.2, p95Ms: 3.2 }
  },
  resources: {
    disposed: false, seriesCount: 1, frameCount: 8,
    encodedBytes: 16384, decodedCacheBytes: 16384, workerCount: 1
  }
}
```

The numbers above illustrate the schema, not a measured result. Measurements
contain only a fixed phase, duration, status, optional byte/cache fields, and a
source kind (`demo`, `files`, `url`, or `archive`). They contain no patient values,
instance identifiers, request URLs, headers, error bodies, or pixel arrays.

The recorder retains at most 256 completed measurements. The summary describes
that retained window, not the viewer's entire lifetime. Median and p95 use
successful measurements only; errors and cancellations have separate counts.
For an even sample count, median averages the two middle values. P95 uses the
nearest rank, `ceil(0.95 * sampleCount)`. With seven samples, p95 is the largest
sample, so it provides little evidence about a production tail distribution.
`lastMs` describes the latest completed measurement regardless of status.

`resetPerformance()` clears completed history. It does not cancel pending work;
an in-flight measurement can finish after the reset. `dispose()` stops recording,
clears history, and releases viewing resources. `getPerformance()` remains
readable afterward; reset is unavailable after disposal.

## What the timings mean

All durations use the browser's relative monotonic clock. They are not dates,
and durations do not compare browser timestamps directly with a server clock.
Timer precision and scheduling depend on the browser.

| Phase | Scope |
| --- | --- |
| `study-query`, `series-query` | Completed study/series metadata query workflow |
| `series-metadata` | Requested series metadata workflow |
| `metadata-read` | Bounded response collection and JSON/schema validation; bytes count consumed HTTP body content |
| `metadata-parse` | Canonicalization and EASI metadata processing; bytes count the canonical JSON passed to EASI |
| `metadata-index` | Archive descriptor validation, compatible-stack grouping and sorting before image retrieval |
| `instance-headers` | Waiting for an instance response to become available |
| `stream` | Consuming the instance byte stream, including consumer backpressure |
| `pipeline` | Running the EASI instance pipeline, including awaited input and callbacks |
| `decode` | Decoder request through completion, including queueing, copying, worker startup/transfer and worker wait |
| `frame` | Requested frame acquisition, including cache hits or retrieval/decode |
| `display` | Viewer work submitting an accepted frame for rendering |
| `first-display` | Source-open start through the first accepted frame's draw submission |
| `source-open` | Source-open workflow completion |

These scopes overlap. In particular, streaming consumption and pipeline parsing
run together, and a frame request can include retrieval and decoding. Do not add
phase medians to derive end-to-end latency. A decode measurement is not an
isolated decoder CPU benchmark.

**Display means draw submission.** A WebGL draw call does not prove that the GPU
has completed or that a physical screen has painted the image. The baseline also
records time through two later `requestAnimationFrame` callbacks. This is a later
animation opportunity, not an actual-paint measurement. The renderer's separate
numeric browser checks verify output pixels; they are not display-latency tests.

## What the resource counters mean

`encodedBytes` and `decodedCacheBytes` count retained pixel buffers owned by the
viewer's source sessions. `workerCount` counts owned decode-worker handles.
Source replacement can temporarily retain both the previous successful source
and the candidate source for rollback, and both are included in observations.

These counters exclude complete browser-process memory, parser backing buffers,
metadata models, GPU textures, browser caches, transient worker transfers, and
unrelated application resources. A zero counter after disposal establishes
release of the viewer's tracked ownership, not a proof that the browser process
returned all allocated pages to the operating system. Archive cache budgets are
64 MiB each per source session; source overlap can exceed a single session's
budget in the combined observation. See [STATUS.md](STATUS.md).

## Run the controlled baseline

Build the current source and start a local preview:

```sh
npm run check
npm run preview
```

In another terminal:

```sh
node tools/browser-performance-check.mjs
```

For another preview port or sample count:

```sh
EASI_VIEW_URL=http://127.0.0.1:5175/ EASI_VIEW_PERF_REPEATS=7 \
  node tools/browser-performance-check.mjs
```

The runner accepts 5–30 repeats, defaulting to seven. It starts its own generated
QIDO/WADO server and an isolated Chrome profile. It does not require Orthanc,
credentials, original imaging files, or external network services.

The default cases are eight single-frame signed 16-bit CT instances per stack,
at 64 × 64 and 256 × 256 pixels. The server uses `Cache-Control: no-store`, a
20 ms metadata delay, a 15 ms instance-header delay, 8 KiB body writes with 2 ms
intervals, and a dedicated 400 ms header delay for the superseded-seek test.
These are configured server-side conditions; browser or TCP buffering can change
how chunks are observed by the client.

Each repeat measures study query, series query, a pixel-cache-cold source open,
an uncached distant seek, and a decoded-cache return. Opening a source must fetch
only its selected instance; cached returns must issue no new instance request.
Independent browser elapsed durations are recorded alongside the viewer's phase
observations. Stored synthetic samples are checked at actual texture upload, so
a quick operation cannot pass by displaying the wrong frame.

“Cold” means new pixel caches after the application is mounted. It does not mean
a fresh operating-system cache, unloaded browser code, cold JIT, or cold machine.
The runner does not discard an initial warm-up sample; results include the first
measured repeat under those conditions. The browser uses software WebGL for
repeatable correctness checks, so these results are not a GPU-hardware ranking.

The runner also checks rapid supersession, a bounded measurement history,
independently computed success-only percentiles, reset behavior, and five repeated
open/dispose cycles. Worker creation/termination is observed independently of
the viewer's resource counters.

## Optional local Orthanc observations

After deliberately enabling the local read-only Orthanc workflow:

```sh
EASI_VIEW_PERF_LIVE_ORTHANC=1 node tools/browser-performance-check.mjs
```

This additionally uses the preview's fixed loopback bridge to Orthanc on port
8042, searches XA candidates, and selects the first available instance that fits
the supported native profile. It performs five pixel-cold opens and first/last
navigation checks. The normal controlled baseline remains a separate result.

Only technical timing, dimensions/profile, frame-count, and retained-resource
observations are saved. No patient names, identifiers, original pixel bytes, or
original-image screenshots are exported. Authentication and archive changes are
not performed. The source can be server-transcoded before delivery; the result
therefore characterizes the complete local archive/viewer path, not client codec
performance or every Orthanc installation.

## Evidence and comparisons

The runner writes `artifacts/browser-performance/results.json` and a screenshot
of the **synthetic** timing panel. The receipt records the cases, delays, chunk
conditions, repeated observations, sample counts, median/p95, browser and Node
versions, software-WebGL mode, fixture hashes, and build/source fingerprints.
Temporary `dist/qa` modules are removed before packaging. Evidence is ignored
and kept separate from release artifacts.

Compare results only when the source revision, scenario, browser, rendering
mode, and machine/load conditions are understood. Keep controlled and live
archive results separate. A single local baseline does not close cross-browser,
production-network, hardware, long-session, or clinical playback validation gates.
It supplies a repeatable starting point for later optimization.

## References

- [W3C High Resolution Time](https://www.w3.org/TR/hr-time-3/)
- [HTML animation-frame callbacks](https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html#animation-frames)
- [Supported profiles and resource bounds](STATUS.md)
- [DICOMweb retrieval scope](DICOMWEB.md)

For compressed frames, decode timing includes provider initialization, local
WASM asset loading/compilation on first use, queueing and frame decoding.
The retained pixel/cache counters exclude WASM linear memory and temporary
codec allocations. Only the requested encoded frame is transferred.
