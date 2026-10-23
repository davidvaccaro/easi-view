# Read-only DICOMweb host gateway

This example runs a fixed-archive relay with host-enforced authorization. It
uses Node 22 or 24 standard libraries and no viewer engine. The backend owns
identity, resource access, session expiry, and revocation.

## Run the generated example

```sh
node examples/gateway/server.mjs --synthetic
```

The command creates two temporary loopback servers, generates a small DICOM
instance, and uses an ephemeral credential to verify study/instance reads and
unauthorized-request rejection. It then closes both servers. It does not read
original imaging files, print credentials, or save images or tokens.

## Configure an HTTPS gateway

Provide these through the server process environment or your deployment's
secret manager; this example does not create an environment file:

| Variable | Meaning |
| --- | --- |
| `EASI_GATEWAY_ARCHIVE_BASE` | Fixed HTTPS archive DICOMweb base address |
| `EASI_GATEWAY_PUBLIC_ORIGIN` | Exact HTTPS origin used by the viewer, including port if needed |
| `EASI_GATEWAY_AUTH_MODULE` | Path to your server ES module exporting `authorize` |
| `EASI_GATEWAY_TLS_CERT_PATH` | Existing TLS certificate file |
| `EASI_GATEWAY_TLS_KEY_PATH` | Existing TLS private key file |
| `EASI_GATEWAY_UPSTREAM_AUTHORIZATION` | Optional upstream authorization header from server secrets |
| `EASI_GATEWAY_BIND_HOST` | Listener address; defaults to `127.0.0.1` |

Then run `node examples/gateway/server.mjs`. The public origin controls the
listener's port, and incoming `Host` must match it exactly. HTTPS is required
by this runner. The factory supports an explicitly enabled HTTP loopback mode
for synthetic tests; it rejects remote unencrypted requests.

The server authorization module receives:

```js
export async function authorize(request, { signal }) {
    // Verify the host session, then authorize this route/filter/resource.
    const identity = await applicationSessions.verify({
        authorization: request.authorization,
        cookie: request.cookie,
        signal
    });
    if (!identity || !await applicationPolicy.canRead(identity, request, signal)) {
        return null;
    }
    return {
        subject: identity.subject,
        realm: identity.realm,
        expiresAt: identity.expiresAt,
        revocationSignal: identity.revocationSignal // Optional server-side AbortSignal.
    };
}
```

The named application services above are supplied by your backend. Do not
replace verification with a client-provided `authenticated`, `canRead`, or
`admin` flag. The request includes `method`, `path`, bounded `query`, a resource
kind (`metadata|instance|frame`), validated path `identifiers`, and downstream
session headers. Query wildcards require an explicit policy. Authorize result
scope before permitting QIDO with a broadly privileged upstream account; the
relay itself does not redact the archive's JSON result set.

Expiry aborts an active response. If your session service provides a
revocation signal, triggering it also aborts that response. All later reads
still require fresh authorization. This cannot revoke medical bytes already
received by a browser.

## Supported routes and limits

Only GET requests under `/dicom-web` are forwarded:

- `/studies` and `/studies/:studyUid/series` QIDO metadata.
- `/studies/:studyUid/series/:seriesUid/metadata` and selected instance metadata.
- `/studies/:studyUid/series/:seriesUid/instances/:sopUid` complete instances.
- `/studies/:studyUid/series/:seriesUid/instances/:sopUid/frames/:originalFrameNumber` native frames.

Metadata allows the client's bounded QIDO filters, limit≤100, and an optional
offset. UIDs must be valid numeric DICOM identifiers. Frame numbers are
one-based and limited to 10000. Instance/frame routes reject query parameters.
Unknown paths, writes, URL overrides, encoded path separators, cross-origin
browser requests, and redirects are rejected.

The factory defaults to four concurrent reads and a 30-second timeout; maxima
are 16 and 5 minutes. Response caps are 8MiB metadata, 256MiB instances, and 64MiB
frames. A configuration can lower these caps. Responses use `no-store`; cookies,
ETags, raw upstream warnings, error bodies, and redirect targets are not copied.
A 299 warning is replaced with fixed text that preserves pagination semantics.

Upstream credentials are provided by the server's `upstreamHeaders` callback,
limited to `Authorization` or`x-api-key`. Downstream credentials are consumed
only by `authorize`; they are never forwarded to the archive. The optional audit
callback receives only `gateway-read`, outcome, and duration.

## Native frame stream profile

A single `application/octet-stream` response, or a one-part
`multipart/related;type="application/octet-stream"` response, must identify the
exact selected upstream study/series/instance/original-frame URL in
`Content-Location`. A relative location is allowed only if it resolves to that
same URL. The gateway validates it and rewrites it to the exact downstream
URL before forwarding pixel bytes. It never follows that location.

The part transfer syntax is Explicit Little Endian (`1.2.840.10008.1.2.1`) or
the native octet-stream default. Compressed frames, missing/foreign locations,
multiple parts, extra headers, duplicate headers, preambles, epilogues, and
malformed closing boundaries are rejected. MIME headers are limited to 16KiB.
Only the header and a small boundary tail are retained; the pixel body streams
with backpressure. The viewer still validates frame length against metadata
and the selected image profile.

A stream can fail after initial bytes were forwarded, for example when the
closing boundary is malformed or the cap is exceeded. The connection is then
destroyed and the viewer must reject the entire retrieval. Use complete
instance mode for archives outside this narrow frame profile.

## Browser host wiring

`client.js` exports `createEnterpriseServices` as a small source-level example
of wiring host identity, a DICOMweb client, and a separately implemented host
JSON API. It starts no login, query, upload, or persistence operation. Its
workflow/share API is not implemented by the read-only gateway runner.
See [enterprise contracts](../../docs/ENTERPRISE.md) for that backend protocol
and explicit lifecycle requirements.

