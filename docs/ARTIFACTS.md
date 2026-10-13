# Independent build and artifacts

EASI View is a standalone project and Git repository. Its package lock, build,
tests, CI workflow, version, license and releases belong to this repository.
EASI JS is a pinned npm dependency; no sibling checkout, git submodule or copied
EASI implementation is required.

## Outputs

| Location | Contents | Tracked? |
| --- | --- | --- |
| `dist/` | Deployable static viewer, worker, styles and license notices | No |
| `artifacts/releases/` | Versioned `.tar.gz`, SHA-256 checksum and per-file manifest | No |
| `artifacts/render-browser/` | Actual shader/reference verification results | No |
| `artifacts/browser/` | Integration evidence and screenshots | No |
| `docs/` | Architecture, support matrix, licensing and competitive roadmap | Yes |

## Build a distribution

```sh
npm ci
npm run check
npm run artifact:pack
```

The artifact command validates the existing `dist/` and packages it. Run `npm run
build` after source changes before packaging. The manifest records the viewer
version, pinned EASI JS version, source commit/cleanliness, build-input fingerprint,
archive hash, and every
included file's size and hash. It does not include personal input files or browser
profiles. Use a clean Git checkout for a release artifact.

Packaging rejects a stale build when source, dependency lock or license inputs
have changed. Rebuild before packaging to keep provenance accurate.
It also verifies the complete distribution inventory, rejecting modified output
or leftover browser-QA modules before they can enter a deployment artifact.

Extract the `.tar.gz` into a static hosting root. Serve JavaScript modules and the
worker with the correct content type. Preserve LICENSE, NOTICE and licenses/.
The artifact has no required server application and does not upload local files.
Archive integration remains subject to CORS, HTTPS and the chosen archive's access
controls. No hosting deployment is performed automatically.

## CI

The GitHub Actions workflow runs this repository's tests and build on Node.js 22
and 24. The Node.js 24 job packages the verified static distribution and stores it
as a private workflow artifact for 14 days. It does not publish to npm, GitHub
Pages, AWS, or a public release. Build-tool actions are pinned to reviewed commits.

Local browser verification uses an isolated Chrome profile. Set
`EASI_VIEW_BROWSER` to a Chrome executable on another machine. Browser QA is an
additional explicit check; the initial CI workflow runs the portable numeric,
parsing, geometry, worker/cache and distributable checks.

```sh
node tools/render-browser-check.mjs
node tools/browser-smoke.mjs
```

The integration runner expects the preview at `http://127.0.0.1:5174/`; build and
start `npm run preview` first. See each script's output for verification evidence.
