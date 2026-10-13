# EASI View

An independent, zero-footprint DICOM viewer built on **EASI JS**. The browser
application owns its renderer, loading runtime, cache, interactions and tools.
It starts with a useful 2D research alpha and a documented path to a full viewer.

**Version:** 0.1.0-alpha.0. **License:** source available under the
[EASI View Community License](LICENSE), with a commercial alternative.

## Run locally

Requires Node.js 22 or 24 and a current desktop browser. From the project directory:

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5174/**. The first study is generated synthetic CT data.
Choose MR, X-ray or ultrasound demos to explore other display and cine behavior.
Refresh the page after a source change; the dev server rebuilds automatically.

```sh
npm run check       # Numeric/runtime tests, build and distributable checks
npm run build       # Static browser application in dist/
npm run preview     # Serve the built application locally
npm run artifact:pack # Package the verified dist/ with checksums and a manifest
```

Use `EASI_VIEW_PORT=5175 npm run dev` if port 5174 is occupied. The development
server binds only to your machine's loopback address. Static production hosting
must serve `.js` as JavaScript and preserve the included license notices.

## View your images

Use **Open files** or drop DICOM files onto the viewer. Select multiple instances
to open a stack; files are grouped by series and ordered using image geometry
where compatible geometry is present. Imports remain in browser memory. The
application has no upload endpoint, analytics, or persistent patient-data storage.
Use the supported native monochrome profile listed in [STATUS.md](docs/STATUS.md).

The **DICOMweb URL** field retrieves a single `application/dicom` image or a
`multipart/related` response containing DICOM instances. For example, use an
Orthanc WADO-RS instance URL of this form:

```text
http://localhost:8042/dicom-web/studies/<StudyInstanceUID>/series/<SeriesInstanceUID>/instances/<SOPInstanceUID>
```

A series retrieve URL can return multiple instances in a multipart response.
The archive must allow the viewer origin through CORS and supply a supported
native transfer syntax. Browser authentication and archive search are future
integration work; the alpha does not accept credentials in URLs. An HTTPS-hosted
viewer cannot fetch an ordinary HTTP archive because of browser mixed-content
rules. Use an HTTPS archive or run the viewer locally for local testing.

## Tools

Choose Window, Pan, Zoom, Probe or Distance, then drag or click within the image.
Window changes reuse decoded samples and the GPU texture. Pixel probes report
stored and rescaled values; distance reports millimeters when valid patient-plane
Pixel Spacing is available, otherwise pixels. Rotate, flip, invert and reset are
available from the viewport controls.

Use the frame slider or arrow keys to navigate a stack. Ultrasound's synthetic
multiframe demo supports play/pause. Playback pauses when the tab is hidden or
the input changes. Keyboard shortcuts are shown in the workspace and do not
intercept ordinary input-field typing.

## Why this architecture

EASI JS parses DICOM through its expressive streaming pipeline. EASI View turns
that output into lazy raw-frame sources, decodes selected frames in a worker,
and applies presentation in its own WebGL2 renderer. A Canvas2D reference path
is available when WebGL2 is unavailable. The implementation retains original
sample precision for windowing, probes, calibrated tools and future reconstruction.

Input retention and decoded cache limits are distinct. This first alpha retains
encoded pixels within a hard input cap and decodes frames lazily; it does not
claim constant-memory processing of arbitrarily large studies. See the
[architecture](docs/ARCHITECTURE.md) for contracts, lifecycle and future volume work.

## Scope and roadmap

This is the first functioning foundation, not the completed general viewer.
Compressed and enhanced profiles, multiple viewports, archive search, MPR/3D,
SEG/SR, reporting and enterprise integrations are later work. The supported
format and validation matrix is in [STATUS.md](docs/STATUS.md).

The [roadmap](docs/ROADMAP.md) records phased exit gates. The
[interactive competitive catalog](docs/easi-view-plan.html) contains 272 candidate
features across 21 domains, with original acceptance criteria and primary sources.
That catalog is a backlog, not a list of implemented capabilities.

This project has its own repository, CI and versioned deployment artifacts.
See [the artifact setup](docs/ARTIFACTS.md); no sibling EASI checkout is needed.

## Licensing and publication

Copyright © 2026 Xinonix Interactive Development, Inc. Qualifying research
institutions, nonprofits and individuals may use the project free under the
license conditions. Businesses also qualify when their organization group's
annual gross revenue is **strictly below USD 5 million**. Other organizations
require a written commercial license. See [licensing](docs/LICENSING.md) and the
binding [LICENSE](LICENSE) for institutional exceptions, affiliate aggregation,
redistribution and transition terms.

Commercial enquiries: [dvaccaro@xinonix.com](mailto:dvaccaro@xinonix.com).
This model is **source available**, rather than OSI-approved open source.

The runtime dependency is pinned to `@xinonix/easi-js@1.0.0`; esbuild is the only
direct development dependency. EASI JS and its bundled third-party code retain
their separate notices, which the static build includes. Demos and tests are
generated synthetic data. This local alpha has not been published to npm or
deployed publicly and does not claim clinical or regulatory validation.
