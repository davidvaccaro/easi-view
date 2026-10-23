# Demonstration deployment — 21 October 2026

The isolated preview is live with **OpenAI GPT-6.1 Sol**:

- Viewer: https://d3gv6o0ove04h3.cloudfront.net/
- AI sign-in: https://d3gv6o0ove04h3.cloudfront.net/api/ai/login
- Configured model: `gpt-6.1-sol`, native Responses API, low reasoning,
  `store: false`.

The demonstration invitation was rotated during activation. Retrieve the current
`passcode` from the administrator's private local file:
`/Users/davidvaccaro/.config/easi-view/ai-demo-access.json` (mode `0600`). Previous
sessions no longer authorize AI requests. Refresh the viewer, open the sign-in
page, and enter the current invitation. Never publish the code, place it in a URL,
or include it in screenshots or repository files. Image viewing remains available
without AI sign-in.

The OpenAI key is stored in a dedicated AWS Secrets Manager secret and loaded
only by authorized server-side generation. No key value is present in the viewer,
Lambda environment, template, output, repository or qualification receipts. The
private local key file remains at
`/Users/davidvaccaro/.config/easi-view/openai-api-key` (mode `0600`). Do not copy its
contents into documentation or artifacts. Only allowlisted selected technical and
viewer-computed measurement facts are sent; image files, pixels, identifiers and
free-text DICOM attributes remain outside the AI request contract.

## Owned infrastructure and active configuration

| Resource | Identifier |
| --- | --- |
| CloudFormation application stack | `easi-view-ai-demo-v1` |
| Code artifact stack | `easi-view-ai-demo-code` |
| CloudFront distribution | `EDUI9D9UKZP4D` |
| Gateway function | `easi-view-ai-demo-v1-ai` |
| Private viewer bucket | `easi-view-ai-demo-v1-viewerbucket-cywihgk0nalu` |
| Dedicated server key secret name | `easi-view-ai-demo-openai-key-20261021` |
| Gateway/secret region | `us-east-1` |

The reviewed stack update changed the existing Lambda code/environment, its
selected-provider permissions, and the CloudFront origin header policy. It created
no replacement resources. A dedicated key secret was added separately, the
invitation was rotated, and the private static viewer was updated. No DNS,
certificate, Orthanc, marketing bucket or unrelated distribution changed.

The role permits reads of only the exact configured key-secret ARN, updates of
its own quota table and writes to its own runtime log group. OpenAI mode has no
Bedrock invocation permission. The key value is not an environment variable;
only its ARN is configured there. The external key secret is retained separately
from this stack and is not implicitly deleted by stack removal.

Normal viewer artifacts remain AI-disabled. The hosted copy is marked
`isolated-ai-demo` in its inventory and uses a same-origin `/api/ai` profile labelled
`OpenAI API`. Qualified viewer source digest:

`9f83f631ac090337099bd4eacb21d6e35b69708de3fe0aa15c8db49442c3d96b`

Reviewed backend ZIP SHA256:

`cea0e4c6ccf941b75e3364b9509c3b9fdf7c0f1de5cb5c9311a190fe14fed0df`

## Limits and qualification

- The server fixes the provider/model and prompts. OpenAI output allowances are
  4,096 tokens for tools and 1,024 for connection tests, including reasoning.
- Admission remains capped at 200 calls/day globally, 12/minute globally,
  six/minute per client and two reserved Lambda invocations. These are admission
  limits, not dollar-denominated spending caps.
- Origin checks and signed, 30-minute HttpOnly/Secure/SameSite=Strict sessions
  precede model-equality, request/schema and quota checks. Provider/model signing
  scope rejects old sessions. Missing or stale `X-Easi-Ai-Model` headers return
  `409` / `configuration-changed` before secret loading or inference.
- Successful key reads are cached for at most five minutes. Each secret read has
  an eight-second bound and observes cancellation. The complete request has a
  60-second deadline, a 32 KiB input limit and 64 KiB wire output limit.
- AI routes never cache. S3 is private. Direct Lambda requests fail origin
  authentication. Diagnostics contain only controlled event/category/error codes,
  with no credentials, headers, bodies, arbitrary provider messages or generated
  prose. Runtime logs have seven-day retention.

The local implementation passed **2,303 automated tests** and a clean build. On
21 October 2026, a direct synthetic provider check succeeded, then hosted HTTPS
qualification passed **12/12 checks**. Exactly one paid hosted connection test was
used for that qualification: eight streamed deltas, the expected fixed connection
response, and exact model provenance. Other checks verified the current profile,
login recipient label, rotated session, old-session rejection, missing/stale model
binding rejection, Origin enforcement, no-cache behavior, logout, denied direct
Lambda access and denied public S3 access.

The initial SDK-mounted public browser gate passed **4/4 checks** against
`cbed0d1a6c491198349cf9936227b658137d11ec6c2199a4f487678bfe6da6b2`,
using three genuine OpenAI calls for connection, series explanation and measurement
summary. It verified exact preview facts and model bindings with no unknown
citations or browser errors. The series draft produced one numeric review flag,
which remained visible for review; the measurement summary produced none. These
are unverified drafts, and qualification does not establish clinical correctness.
Only synthetic inputs were used. No authentication values, original images,
generated prose or screenshots containing those values were saved in the receipts.

## Native standalone transport correction — 21 October 2026

The current viewer fingerprint above fixes a browser-native fetch invocation
error. The earlier SDK request-capture wrapper concealed that error; its receipts
remain evidence for SDK/provider calls, not the unmodified standalone transport.
The failure was reproduced in the actual viewer before any POST reached the
service. The fix passed **2,305 automated tests** and build/distribution checks.

Only the 46-file static viewer variant was refreshed in the owned S3 bucket and
CloudFront distribution. Prior S3 object versions were preserved; the Lambda
ZIP, secrets, permissions and stack configuration did not change.

The new native-fetch standalone gate passed **5 checks locally** and **5 checks
on the public demonstration**. Each disposable browser used the real invitation
form and Open Images workflow with a generated extensionless DICOM. An anonymous
Test reached HTTP 401 with sign-in guidance; the signed-in Test reached HTTP 200
and visibly succeeded with exactly one genuine empty-facts connection call per
origin. Native fetch was untouched. No unexpected uploads, external browser
requests, runtime exceptions or console errors occurred. These receipts are
separate from the historical SDK draft-generation results.

## History and rollback

The initial 20 October 2026 deployment used Amazon Bedrock Nova Micro. Its 2,239-test
build, 11 HTTPS checks and 4/4 browser qualification remain historical Bedrock
evidence. They are retained separately and are not represented as OpenAI results.
Account-level Bedrock invocation logging was unconfigured and no dedicated
CloudTrail trail was present at that initial deployment; no trail was added during
this provider change.

The previous deployed template, parameters, immutable code key and S3 object-version
inventory were saved privately before activation. The previous invitation details
were backed up as a mode-0600 local rollback file; they must never be published.
The previous static object versions and immutable backend ZIP remain available.
For an intentional provider rollback, use the reviewed template's Bedrock mode,
restore an accurately labelled Bedrock viewer profile, rotate the invitation again,
and qualify synthetic requests before sharing. Never silently fall back to a
provider different from the one shown to the user.

See [deployment and operation instructions](README.md) for repeatable builds,
rotation and retained-resource behavior. To stop model admissions immediately:

```sh
aws lambda put-function-concurrency --region us-east-1 \
  --function-name easi-view-ai-demo-v1-ai --reserved-concurrent-executions 0
```

Restore reserved concurrency to `2` or redeploy the reviewed template to resume.
Delete only the owned demonstration stacks when retiring the service, and review
retained S3 objects, quota table, logs and the separately managed key secret. API
key revocation is a separate deliberate operation. Secrets Manager storage and
other infrastructure/inference charges depend on the resources retained and use;
the call cap does not cap every infrastructure charge.
