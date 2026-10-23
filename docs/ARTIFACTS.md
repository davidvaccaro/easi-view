# Independent build and artifacts

EASI View is a standalone project and Git repository. Its package lock, build,
tests, CI workflow, version, license and releases belong to this repository.
EASI JS is a pinned independent package dependency; no sibling checkout, git
submodule or viewer-owned fork is required. This hardening candidate resolves
the exact core package from the verified source archive described below.

## Outputs

| Location | Contents | Tracked? |
| --- | --- | --- |
| `dist/` | Static standalone viewer, embeddable ESM SDK, host example, worker, styles and license notices | No |
| `artifacts/releases/` | Versioned static `.tar.gz`, installable npm `.tgz`, checksums and per-file manifests | No |
| `artifacts/render-browser/` | Actual shader/reference verification results | No |
| `artifacts/browser/` | Integration evidence and screenshots | No |
| `artifacts/browser-embed/` | SDK isolation, lifecycle and branded host example evidence | No |
| `artifacts/browser-archive/` | Synthetic QIDO/WADO browsing, selected-instance retrieval and host integration evidence | No |
| `artifacts/browser-performance/` | Controlled repeated timings, source/fixture fingerprints, cancellation/disposal and optional local Orthanc technical observations | No |
| `artifacts/local-corpus/` | Explicit local-file functional evidence and filename reports; no image/screenshot/pixel payloads | No |
| `vendor/xinonix-easi-js-1.0.1-corpus.0.tgz` and companion manifest | Independent source-only EASI JS candidate and its provenance for reproducible checkout installs | Yes |
| `docs/` | Architecture, support matrix, licensing and competitive roadmap | Yes |

## Build a distribution

```sh
npm ci
npm run check
npm run artifact:pack
npm run sdk:pack
```

The artifact command validates the existing `dist/` and packages it. Run `npm run
build` after source changes before packaging. The manifest records the viewer
version, pinned EASI JS version, source commit/cleanliness, build-input fingerprint,
archive hash, and every
included file's size and hash. It does not include personal input files or browser
profiles. Use a clean Git checkout for a release artifact.

Packaging rejects a stale build when source, dependency lock or license inputs
have changed. Rebuild before packaging to keep provenance accurate.
The source fingerprint also covers the installed EASI JS package metadata,
source and notices. The recorded core version comes from that installed package;
the build rejects a mismatch with the exact dependency pin.
It also verifies the complete distribution inventory, rejecting modified output
or leftover browser-QA modules before they can enter a deployment artifact.

Extract the `.tar.gz` into a static hosting root. Serve JavaScript modules and the
worker with the correct content type. Preserve LICENSE, NOTICE and licenses/.
The artifact has no required server application and does not upload local files.
Archive integration remains subject to CORS, HTTPS and the chosen archive's access
controls. Configure archive addresses and request headers at runtime through the
host SDK; do not put credentials or local archive data into a distributable.
The static build now includes archive browsing but needs no archive server to
open its local/synthetic images. See [DICOMWEB.md](DICOMWEB.md). No hosting
deployment is performed automatically.

For product integration, import `assets/easi-view.js` and preserve its adjacent
`decode-worker.js`, linked legal-comment files and notices. `embed.html` is the
working host example. `build-info.json` additionally records
`inlineStyleSha256`, the base64 SHA-256 digest of the exact Shadow DOM stylesheet;
a host can permit `'sha256-<digest>'` in `style-src`, or pass its matching CSP
nonce through the SDK's `styleNonce` option. See [EMBEDDING.md](EMBEDDING.md).
The SDK also ships as a locally installable npm archive. The repository remains
private and `private: true` blocks accidental npm publication; these commands do
not publish or deploy anything.

## Installable SDK and framework assets

The SDK declares exact `@xinonix/easi-js@1.0.1-corpus.0` semver metadata. The
checkout lock resolves it to `vendor/xinonix-easi-js-1.0.1-corpus.0.tgz` with npm
integrity, so `npm ci` reconstructs the candidate without a sibling checkout or
modified installed source. A fresh checkout install has been verified. The
vendor manifest identifies the independent core source artifact; its candidate
version does not change or publish the core's stable registry release.

Until that exact core candidate is published, install **both local archives in
the same command** in an independent consumer:

```sh
npm install ./xinonix-easi-js-1.0.1-corpus.0.tgz ./xinonix-easi-view-0.1.0-alpha.0.tgz
npx easi-view-copy-assets public/easi-view
```

Supply the verified core archive from `vendor/` alongside the packed SDK. The
SDK package manifest retains the exact semver dependency; it contains no local
temporary tarball path. Installing only the SDK may try the registry for the
unpublished core candidate. Packaging or local installation publishes neither
package, and no npm release is authorized by this candidate setup.

The SDK's ESM export and TypeScript declarations resolve from `@xinonix/easi-view`.
Because workers and WASM have their own asset URLs, the portable integration is
`npx easi-view-copy-assets public/easi-view`, followed by a browser import from
`/easi-view/assets/easi-view.js`. A Vite/React host can use
`import(/* @vite-ignore */ '/easi-view/assets/easi-view.js')` in its mount lifecycle
and `import type { Viewer } from '@xinonix/easi-view'` for static types. The same
public-asset path works in other frameworks that serve a public directory.
Give the host container a height, await `viewer.ready`, and dispose on unmount.

The asset copy helper refuses an existing destination. For an update, copy to a
new versioned public path and update your import; preserve the folder together.
Do not extract one SDK file or assume a bundler preserves the worker/codec URLs.
Direct package imports are valid ESM, but automatic worker/WASM rewriting is
bundler-specific and is not claimed without a tested configuration.

Serve `.js` as JavaScript and `.wasm` as `application/wasm`. The SDK stylesheet
uses a host-supplied CSP nonce or the recorded stylesheet hash; worker/module
execution and WebAssembly require the documented CSP. Local files remain local.
No registry access, original data or sibling source checkout is needed at runtime.
The `test:corpus`, `test:corpus:campaign` and report-comparison commands are repository-only development tools, excluded from
the installable SDK. [CORPUS_TESTING.md](CORPUS_TESTING.md) describes its separate
explicit opt-in run; original local files and private reports never enter distributables.

`sdk:pack` verifies the static distribution and current source fingerprint before
packing, checks a strict path/size/content inventory, and writes archive SHA-256,
npm integrity and per-file receipts. It includes both projects' licenses/notices,
codec notices and usage/profile documents. Repository sources, tests, local
images, environments and browser profiles stay out of the package.

## CI

The GitHub Actions workflow runs this repository's tests and build on Node.js 22
and 24. The Node.js 24 job packages the verified static distribution and installable SDK and stores it
as a private workflow artifact for 14 days. It does not publish to npm, GitHub
Pages, AWS, or a public release. Build-tool actions are pinned to reviewed commits.

Local browser verification uses an isolated Chrome profile. Set
`EASI_VIEW_BROWSER` to a Chrome executable on another machine. Browser QA is an
additional explicit check; the initial CI workflow runs the portable numeric,
parsing, geometry, worker/cache and distributable checks.

```sh
node tools/render-browser-check.mjs
node tools/browser-smoke.mjs
node tools/browser-geometry-check.mjs
node tools/browser-embed-check.mjs
node tools/browser-archive-check.mjs
node tools/browser-color-check.mjs
node tools/browser-xa-check.mjs
node tools/browser-performance-check.mjs
node tools/browser-hardening-check.mjs
node tools/browser-jpeg2000-ybr-check.mjs
```

The integration runner expects the preview at `http://127.0.0.1:5174/`; build and
start `npm run preview` first. See each script's output for verification evidence.
The archive runner creates its own temporary local synthetic QIDO/WADO server;
it does not require a live PACS, Orthanc, credentials or original imaging files.
The color runner uses generated RGB DICOM fixtures and independent channel
expectations to check GPU/Canvas2D output, real worker decoding, frame navigation
and grayscale/color control transitions. Its results are written under
`artifacts/browser-color/`; it does not save original medical images.
The XA runner uses generated classic angiography cine and inactive/active mask
fixtures to verify stored samples, fixed timing, cache reuse, playback and failed
source recovery. Evidence is written under `artifacts/browser-xa/`.
Keep browser evidence separate from release inventory. In particular, browser
QA's temporary `dist/qa` modules must be cleaned before packaging; the
distributable checker rejects leftover modules.

The hardening runner compares actual WebGL2/Canvas2D circular shutters with an
independent pixel oracle, including transforms, polarity and unchanged original
probes. The JPEG2000 YBR runner opens generated `.90`/`.91` files through the
actual SDK and decoding worker, checks canonical RGB uploads/framebuffer colors
and teardown. These tools serve only generated local assets. Their receipts in
`artifacts/browser-hardening/` and `artifacts/browser-jpeg2000-ybr/` record the
specific source fingerprint; an interim pass is not transferred to a later build.

The performance runner records conditions, independent browser elapsed times,
median/p95 and bounded resource observations. Its default cases use only
generated metadata/images. Live Orthanc is an explicit optional read-only mode,
with technical observations and no original image export. See
[PERFORMANCE.md](PERFORMANCE.md) before interpreting or comparing timings.

Compressed decoding adds `assets/dicom-codecs.wasm` and the complete
`licenses/codecs/` notice/provenance directory. Deploy both with the SDK,
application and worker; serve the binary as `application/wasm`. The runtime
uses the unmodified pinned binary through an owned adapter, and never fetches
codecs from a CDN. See [COMPRESSED.md](COMPRESSED.md).
