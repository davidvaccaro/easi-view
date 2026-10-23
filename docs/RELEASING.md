# Releasing EASI View

The initial candidate is **1.0.0-rc.1**. Preparation and packing do not publish it.
Keep source, dependency versions, qualification receipts and released artifacts
bound to one clean tagged checkout. EASI JS remains a separately licensed and
released dependency; this process must not silently fork or patch installed core
code. [RELEASE_PLAN.md](RELEASE_PLAN.md) records scope and outstanding gates.

## 1. Freeze prerequisites

1. Review the AI-free release diff and the supported matrix/known limitations.
   Preserve the AI checkpoint and retain all intended non-AI fixes.
2. The independent `@xinonix/easi-js@1.0.1` is published and its registry archive
   was matched to the tested artifact. Retain registry integrity/provenance and
   the exact pin/lock. A private archive or version string alone is not evidence.
3. Use Node.js 22 or 24 and a fresh checkout. `npm ci` must succeed without any
   sibling project, private corpus, ignored tool binaries or local tarball path.
4. Check license notices and public content. Never include credentials, `.env`
   files, original imaging collections, private reports or browser profiles.
   Keep the Community License and commercial enquiry details accurate.

## 2. Qualify the exact candidate

```sh
npm ci
npm run check
```

Run the current native-browser gates for opening/admission/cancellation, display,
measurement, comparison, embedding and disposal. Verify the standalone and SDK
have no AI controls, public assistant API, startup configuration fetch or inference
requests. Preserve generated-fixture receipts with the actual source fingerprint.

Before **stable 1.0.0**, run the explicit local corpus campaign against the private
23,893-file collection
using [CORPUS_TESTING.md](CORPUS_TESTING.md). Keep private per-file outcomes and
compare with the historical baseline. A successful metadata parse is not a
successful display; report actual draws and applicable navigation/cine/tools.
Known unsupported or invalid classifications remain explicit. A public RC may
proceed after targeted/browser/consumer gates with the full rerun clearly pending;
do not represent the historical campaign as a completed new-build pass. If a fix changes
the build, qualify that final fingerprint rather than copying prior passes.

In a fresh independent consumer, install the locally packed SDK, resolve its
TypeScript declarations, copy all assets and mount/render/dispose the viewer.
Validate worker/WASM MIME types, module-relative URLs, CSP and branding/isolation.
Registry availability is required for ordinary dependency resolution.

## 3. Prepare immutable release artifacts

The candidate manifest explicitly allows public publication and defaults to
`next`. Verify those settings and the exact candidate version before publishing.
Any manifest/source change alters the fingerprint: build and validate that final
source rather than shipping an earlier artifact. Tag only the reviewed commit.

```sh
git status --short
npm ci
npm run check
npm run artifact:pack
npm run sdk:pack
```

Use a clean tagged checkout, e.g. tag `v1.0.0-rc.1`, and retain source/build
fingerprints, archive hashes, npm integrity and file manifests. Inspect the exact
SDK tarball inventory. Verify a fresh consumer installs that exact tarball and
its independently released core, and that the adjacent worker/codec assets render.
The static artifact must retain all licenses/notices and `build-info.json`.

Do not publish an artifact whose provenance identifies a dirty tree, local path
dependency, unexpected code/profile or a different build than its qualification.
Do not amend a released tag to point at changed contents; use another version.

## 4. Publish a candidate deliberately

After targeted candidate checks, browser and clean-consumer gates pass and
publication is authorized, disclose the pending full-corpus stable gate and publish the verified
SDK archive under `next`:

```sh
npm publish artifacts/releases/xinonix-easi-view-1.0.0-rc.1.tgz --access public --tag next
```

npm may require the account owner's device authentication. Never place provider
keys, npm tokens or recovery codes in source, terminal output or chat.

Create the matching versioned GitHub release and attach verified static/SDK
archives and checksums. Publish source under the documented source-available
license. Deploy the static viewer to its intended viewer/demo host, preserving
MIME/CSP settings and notices. Retest the public install and hosted/embedded
viewer against their recorded build identity; a successful local pack is not
proof that registry installation or hosting works.

Verify the actual npm version, integrity and `next` tag from an independent
consumer. Update README/status/release notes with real URLs and completed results.
No CI job in this preparation automatically publishes npm or deploys hosting.

## 5. Promote a distinct stable release

Complete the new-build full 23,893-file campaign, review its classified outcomes,
review candidate feedback and resolve release-blocking defects. Set version
`1.0.0`, create its own final clean commit/tag, build/qualify/package it, then
publish that stable package to `latest` as a separate release action. Do not put
the prerelease version `1.0.0-rc.1` on `latest` and describe it as stable 1.0.0.
Retain candidate evidence and rollback artifacts; communicate supported profiles
and remaining limitations rather than promising broad viewer/clinical parity.
