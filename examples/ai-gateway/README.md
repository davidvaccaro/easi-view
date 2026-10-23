# AI Assist Preview gateway

This optional **server** connects the two v1 AI tools to a configured model. It is
separate from the browser SDK; provider credentials never enter a viewer bundle.

**Current deployment — 21 October 2026:** the hosted demonstration uses OpenAI
`gpt-6.1-sol` through the native Responses API. Its server-only key is held in AWS
Secrets Manager; the gateway runs in `us-east-1`. A genuine hosted connection test
and both tools passed qualification using only synthetic inputs. The former
Bedrock model remains a supported explicit configuration, with its historical
receipts kept separately. See the
[deployment record](../../infrastructure/ai-demo/DEPLOYMENT.md).

The OpenAI connector targets the native Responses API and defaults to
`gpt-6.1-sol`, low reasoning and `store: false`. It streams only plain text from
validated responses; tools, conversation persistence, image interpretation and
image uploads are outside this v1 connector. The server never silently switches
providers if its configured service fails.

## Local demonstration

Use Node 22 or 24. Install the optional server dependencies independently:

```sh
npm ci --prefix examples/ai-gateway --ignore-scripts
```

Keep the invitation code and any API key in separate private files outside the
repository, each mode `0600`. The invitation contains at least 24 random
characters (`A-Z`, `a-z`, `0-9`, `_`, `-`). The OpenAI file contains the API key
alone, or JSON with `apiKey` or `OPENAI_API_KEY`. Never put values in command
arguments, environment files, viewer configuration, URLs, screenshots or Git.

For OpenAI, after a valid private key is available:

```sh
npm run build
node infrastructure/ai-demo/build.mjs --provider openai --model gpt-6.1-sol \
  --viewer-dist dist --output artifacts/ai-demo-openai
node examples/ai-gateway/server.mjs --provider openai --model gpt-6.1-sol \
  --openai-key-file /path/to/private-openai-key \
  --passcode-file /path/to/private-invitation-code \
  --static artifacts/ai-demo-openai/viewer --port 5188
```

For Bedrock, use an AWS identity permitted to invoke the fixed regional model:

```sh
node infrastructure/ai-demo/build.mjs --viewer-dist dist --output artifacts/ai-demo
node examples/ai-gateway/server.mjs \
  --passcode-file /path/to/private-invitation-code \
  --static artifacts/ai-demo/viewer --port 5188
```

Open `http://127.0.0.1:5188/api/ai/login`, enter the invitation code, then open a
synthetic image and select AI Assist. The server binds only to loopback. Its local
cookie omits `Secure` for HTTP loopback; AWS uses HTTPS and `Secure` cookies. The
normal viewer build remains AI-disabled. Change provider and viewer profile
together and sign in again after provider/model changes.

## Request and response contract

The browser posts to `/api/ai/generate` or `/api/ai/test`. Both sides use the shared
`src/ai/protocol.js` validator. Requests contain only allowlisted facts:

```json
{
  "version": 1,
  "task": "explain-series",
  "facts": [
    { "id": "E1", "code": "modality", "value": "CT" },
    { "id": "E2", "code": "rows", "value": 256 }
  ]
}
```

The reference server also requires `X-Easi-Ai-Model` to equal its configured model
ID (`gpt-6.1-sol` for the OpenAI example). This is an equality guard against stale
recipient labels, never a model selector. EASI View's AI client sets this header
from its configured profile; host headers cannot override it. A mismatch or
missing header returns HTTP `409` / `configuration-changed` before quota, secret
loading or inference. Reload the current connection profile and sign in again.
Custom `AiGateway` consumers can opt into this guard using
`requireModelBinding: true`; the reference Lambda and CLI server enable it.

Tasks are `explain-series`, `summarize-measurements` and the synthetic
`connection-test` (empty facts). Unknown fields and values are rejected. There is
no generic prompt, browser model selector, URL fetch or arbitrary DICOM attribute
endpoint. Names, identifiers, UIDs, dates, free-text attributes, measurement
labels, source URLs, pixels and files are absent from this contract.

The response is UTF-8 `application/x-ndjson`:

```json
{"type":"delta","text":"The image has 256 rows [E2]."}
{"type":"done","model":"gpt-6.1-sol"}
```

Errors use controlled codes such as `unauthorized`, `configuration-changed`,
`rate-limited` or `provider-error`. Model text is untrusted and displayed as text,
labelled an unverified draft. Citation and numeric checks help review supplied
facts; they do not establish clinical correctness.

## Credentials, limits and recovery

AWS OpenAI mode receives only an exact Secrets Manager **ARN** in its environment.
The key is read inside authorized generation, after origin/session/model/schema
checks and quota admission. Reads have an eight-second deadline, observe request
cancellation, and cache successful keys for at most five minutes. Failed or stale
refreshes are not retained. Login and static routes do not require a secret read.
The server role can read only the configured secret; OpenAI mode has no Bedrock
model permission. Bedrock mode has only its fixed model permission.

- OpenAI uses a reasoning-inclusive allowance of 4,096 output tokens (1,024 for
  connection tests); Bedrock uses 768 (64 for tests).
- Requests are limited to 32 KiB, total response wire output to 64 KiB, with a
  60-second request deadline. Provider calls have a slightly shorter deadline.
- Exact Origin checks and a private invitation create a 30-minute signed
  `HttpOnly; Secure; SameSite=Strict` session scoped to `/api/ai`. Its signing
  context also binds provider and model.
- AWS quotas are atomic DynamoDB counters: 200 calls/day globally, 12/minute
  globally, six/minute per client, login-attempt limits and two reserved Lambda
  invocations. These are admission caps, not dollar-denominated spending limits.
- Initialization failures retry on the next request instead of poisoning a warm
  Lambda environment. Operational diagnostics contain only fixed event/category/
  error codes, including secret access, timeout, provider authorization and quota
  failures. They exclude messages, stack traces, keys, headers, request/response
  bodies and generated prose.
- Cancellation stops local provider work. AWS may continue a short admitted
  invocation after a browser disconnect; fixed token/time/usage bounds remain.

This invitation login is for demonstrations. Production hosts should provide
enterprise identity, authorization and data-governance policy. Optional AI sends
only the selected allowlisted facts to the configured service; local image
viewing itself does not send files or pixels. See
[deployment and operation](../../infrastructure/ai-demo/README.md) for activation,
rotation and shutdown. Image interpretation, segmentation and the plugin
marketplace remain later work.
