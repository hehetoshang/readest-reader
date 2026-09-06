# Moke embedding contract (`moke.readest.embed.v1`)

## Runtime boundary

Reader is a static Next.js export plus an in-process Rust library. Moke owns the application lifecycle, server selection, authentication session, static asset origin and top-level Tauri configuration. Reader owns parsing/rendering, reading state and Reader UI.

There is no network listener between Moke and Reader. Their connection uses same-origin navigation, Tauri IPC and initialization/query context.

## Static route and launch context

Moke bundles `out/readest` and opens `/readest/reader`.

| Parameter/global | Meaning |
| --- | --- |
| `file` / `window.OPEN_WITH_FILES` | A local path already authorized by Moke's native index, file picker or Tauri fs scope. |
| `moke=1` / `window.__MOKE_EMBEDDED` | Enables host integration. |
| `mokeBookId` | Talebook book ID used by the progress API. |
| `mokeServerUrl` | Absolute HTTP(S) Talebook base URL. Omitted on desktop while Moke's main window owns progress saving. |
| `mokeSourceServerUrl` | Current Moke server origin. Present only for online books and used to bind the remote source to that origin. |
| `mokeRestoreProgress` | URL-encoded JSON using `moke.readest.progress.v1`. |
| `mokeReturnTo=/library` | The only allowed host return path. |
| `mokeEink`, `mokeDebug` | `0`/`1` host presentation flags. |

Moke accepts server URLs only through its server configuration flow. Reader does not evaluate arbitrary return URLs and never accepts credentials in query parameters.

## Online source adapter

An online EPUB is opened transiently and is never imported into Reader or Moke's offline library. Moke prefers the authorization-specific Talebook bootstrap resource. If the bootstrap endpoint is absent (an ordinary unstructured 404), Moke follows Talebook Android's compatibility strategy and probes the fixed authenticated `/api/book/{mokeBookId}.epub` route. This supports pre-bootstrap Talebook releases whose download handler is backed by Tornado `StaticFileHandler` (3.7+), without weakening the Range requirement for still older releases.

Reader accepts a source only when all of the following hold:

- `mokeSourceServerUrl` is the exact current HTTP(S) server origin;
- the source is either same-origin `/read/resource/{mokeBookId}.epub` with one safe `revision` value, or the exact query-free legacy `/api/book/{mokeBookId}.epub` path;
- HEAD returns a positive length and ETag when those fields are present; bootstrap resources use `application/epub+zip`, while the legacy handler may use its historical `application/octet-stream` response;
- a real `GET bytes=0-0` succeeds with exact `206`, length and total-size metadata before the parser receives the source;
- each body request is an exact `206` response for the requested range with the same ETag, allowed MIME and total size.

The transport uses the shared Tauri HTTP cookie jar, sets `maxRedirections: 0`, and never serializes cookies or tokens into the launch URL. A server that redirects, ignores Range, changes revision/ETag, or returns an unexpected MIME is rejected instead of being silently downloaded in full. In particular, Talebook 3.6 and older download handlers return a full `200` and therefore receive the explicit download fallback rather than being disguised as online streaming. Closing the transient file aborts active requests. Publication documents remain in Foliate sandbox frames and cannot invoke the top-level adapter.

## Native API

Moke links `readestlib` with `default-features = false` and calls:

- `register_reader_plugins(builder)`
- `register_reader_protocols(builder)`
- `reader_invoke_handler()`
- `manage_reader_state(app_handle)`

Desktop may call the `open_reader` command. Android uses the registered `rangefile` protocol for scoped byte ranges. Moke must keep the Reader plugins that expose Tauri permission manifests as direct dependencies; Cargo `links` metadata does not propagate through a transitive library.

## Events and errors

Reader sends `book:opened`, `page:changed`, `book:closed`, annotation-location receipts and `reader:error` through Moke's `ext_reader_event` command. High-frequency ordinary page events are throttled. The error payload contains a stable code and non-secret status metadata, not request headers, cookies or server credentials.

Reader also dispatches a browser `moke:reader-error` `CustomEvent` so the embedded debug panel and E2E harness can observe the same failure when host IPC is unavailable.

Progress failures are best effort: they do not interrupt rendering, are visible as `reader:error`, and are retried on a later page change or close flush.

## Talebook HTTP contract

On single-WebView platforms the Moke main React tree is unloaded while Reader is active, so Reader performs:

```text
POST {mokeServerUrl}/api/book/{mokeBookId}/progress
Content-Type: application/json
credentials: include

{"progress": {"schema": "moke.readest.progress.v1", ...}}
```

The request uses `@tauri-apps/plugin-http` so Moke's Rust cookie jar carries the authenticated Talebook session. Plain HTTP LAN servers, self-signed certificates and redirects are controlled by Moke's Tauri HTTP configuration. Moke's `http` ACL must allow the selected HTTP(S) origin.

A non-2xx response, redirected login/non-JSON response, or JSON envelope with `err` other than empty/`ok` is reported as a stable Reader error.

### CORS

Packaged Tauri requests are issued by the Rust HTTP plugin and are not browser CORS requests. Browser-only development uses native `fetch` semantics and therefore requires the Talebook origin to allow the development origin; production Moke does not rely on that exception.

## Versioning

Compatible additions keep `moke.readest.embed.v1`. Removing a launch field, command, event or changing progress semantics requires a new contract version and coordinated releases in both repositories.
