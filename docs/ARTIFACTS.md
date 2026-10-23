# Independent build and artifacts

EASI View owns its Git repository, package lock, tests, CI, version, license and
releases. EASI JS remains an independent exact-version package dependency. No
sibling checkout, submodule or viewer-owned fork is required.

The public **1.0.0-rc.1** viewer uses independent **@xinonix/easi-js@1.0.1**.
The [GitHub release](https://github.com/davidvaccaro/easi-view/releases/tag/v1.0.0-rc.1)
provides six archive/manifest/checksum assets. Both projects’ registry archives
were verified against their tested artifacts. The former
`1.0.1-corpus.0` vendored candidate belongs to historical qualification, not the
release dependency contract.

## Outputs

| Location | Contents | Tracked? |
| --- | --- | --- |
| `dist/` | Static viewer, embeddable ESM SDK, host example, worker, styles and notices | No |
| `artifacts/releases/` | Versioned static `.tar.gz`, installable npm `.tgz`, hashes and manifests | No |
| `artifacts/browser*/` | Generated browser qualification and technical receipts | No |
| `artifacts/render-browser/` | Shader/reference verification | No |
| `artifacts/local-corpus/` | Private explicit corpus reports; no public imaging payloads | No |
| `docs/` | Supported profiles, architecture, release gates and historical backlog | Yes |

## Build a distribution

From a clean release checkout using Node.js 22 or 24:

```sh
npm ci
npm run check
npm run artifact:pack
npm run sdk:pack
```

`check` runs the numeric/runtime suite, builds both standalone and SDK bundles,
and validates the distribution. Packaging refuses a stale build. Manifests record
the exact source fingerprint, pinned EASI JS version and per-file hashes. The
static archive also records Git commit/cleanliness; publish from a clean tagged
checkout and retain the qualification receipt for that same source fingerprint.
See [RELEASING.md](RELEASING.md) for the complete release sequence.

The build rejects an installed EASI JS version that differs from the exact pin.
Its source fingerprint includes the installed core source/package/notices and
the release-profile guard, not merely a version string. Distribution inventory
checks reject changed output and leftover browser-QA modules.

## AI-free release contract

The production build records `releaseProfile: "core-no-ai"` and its actual owned
bundled modules in `build-info.json`. AI implementation modules are rejected even
when their exports are unused or the feature is disabled. Distribution checks
reject assistant APIs/UI, provider endpoints and AI deployment/profile assets.
The SDK documentation allowlist excludes the old active AI setup guides while
retaining the deferred historical [AI backlog](AI_BACKLOG.md).

DICOM SEG/SR/GSPS and explicitly supplied overlay data remain ordinary supported
derived-result features. Imported provenance such as `source: 'ai'` does not
invoke a model. Source-bound result display is independent of AI execution.

## Static hosting and embedding

Extract the `.tar.gz` into a static hosting root. Serve `.js` as JavaScript and
`.wasm` as `application/wasm`; preserve LICENSE, NOTICE and licenses/. No server
application, AI sign-in, model account or inference gateway is needed for local
viewing or generated examples. Archive access requires the configured archive's
HTTPS, CORS and host-managed authentication. Original local files stay local.

For embedding, preserve `assets/easi-view.js`, `decode-worker.js`, codec WASM and
adjacent linked legal files. `embed.html` is a working host example. The SDK
carries its Shadow DOM stylesheet. `build-info.json` records `inlineStyleSha256`;
hosts can allow that exact CSP style hash or supply a matching `styleNonce`.
Worker/module execution and WebAssembly need the documented CSP permissions.
See [EMBEDDING.md](EMBEDDING.md).

## Installable SDK and framework assets

Install the public candidate in an independent consumer without sibling source
directories:

```sh
npm install @xinonix/easi-view@next
npx easi-view-copy-assets public/easi-view
```

For exact pinning use `npm install @xinonix/easi-view@1.0.0-rc.1`; a supplied
local archive can use `npm install ./xinonix-easi-view-1.0.0-rc.1.tgz`. Fresh
public-registry installation verified the package integrity, exports, types and
46 copied runtime files. Both npm `next` and `latest` currently resolve to RC1;
this is still a prerelease. See [STATUS.md](STATUS.md) for the measured tag
limitation, release commit and exact archive SHA-256. Local packing/installation
publishes neither project.

Import the served module from `/easi-view/assets/easi-view.js`; use
`import type { Viewer } from '@xinonix/easi-view'` for TypeScript. In a Vite/React
mount lifecycle, `import(/* @vite-ignore */ '/easi-view/assets/easi-view.js')`
keeps the browser URL intact. Give the container a height, await `viewer.ready`,
and dispose on unmount. Await `whenDisposed()` when verifying completed cleanup.

The copy helper refuses an existing destination. For upgrades use a new versioned
asset path and update its import. Preserve the whole directory: bundling one JS
file does not automatically preserve worker/WASM URLs. Direct package imports
are ESM; any bundler-specific asset rewriting needs its own qualification.

`sdk:pack` verifies source/build fingerprints, asset inventory, runtime exclusion,
explicit package paths, document allowlist and byte/content limits. It produces
archive SHA-256, npm integrity and per-file manifests. Original imaging files,
private reports, environments, credentials, tests and corpus tools stay out of
the installable SDK. All public fixtures are synthetic.

## CI and publication boundaries

GitHub Actions runs checks on Node.js 22 and 24 for `main`, release branches and
pull requests. Node.js 24 also creates static and SDK archives retained as workflow
artifacts. CI does not automatically publish npm, deploy hosting or create a
public GitHub release. The candidate manifest explicitly permits public
prerelease publication and defaults to the `next` tag. This is a release
configuration, not an automatic publishing job. The initial publication also
received npm’s `latest` tag; its attempted removal returned HTTP 400, as recorded
in STATUS.md. Stable 1.0.0 is separate and remains gated by the running final
full-corpus qualification.

The local browser harness uses an isolated Chrome profile. Set `EASI_VIEW_BROWSER`
for another executable. Browser and local-corpus qualification are explicit
additional gates, separate from the portable numeric/build CI job.
