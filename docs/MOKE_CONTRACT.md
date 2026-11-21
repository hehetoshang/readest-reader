# Moke embedding contract (`moke.readest.embed.v1`)

## Runtime boundary

Reader is a static Next.js export and an in-process Rust library. Moke owns server selection, authentication, the cookie jar, caller/document authority, source leases and remote progress persistence. Reader owns parsing, rendering and identity-scoped local state.

The packaged manifest is `contract/moke-reader.v1.json`, also included in the Rust library as `MOKE_READER_MANIFEST_JSON`. All three capabilities must match the frozen `contract/reader-host-launch.v1.json`. The frozen host explanation and 18 synthetic semantic fixtures are supplied unchanged in `docs/READER_HOST_LAUNCH.md` and `contract/fixtures/reader-host-launch.v1.json`. Fixtures grant no IPC authority.

## Controlled online launch

The fixed native target is `/readest/reader?moke=1&mokeLaunchId=...`. The lookup grants no permission. Before providers mount, HTTP runs or local progress restores, Reader calls `moke_reader_claim` from the actual target WebView/document. Native IPC validates the caller; JavaScript validates the returned schema, generations, source, exact resource and fixed `progressOwner: host`.

Claims cannot be mixed with external `file`, `ids`, `cfi`, book, server or restore query fields. Claim tokens remain in memory. Reader clears legacy server/restore globals and derives the single source solely from the claim. A missing/rejected claim stops bootstrap. Unclaimed embedded HTTP is rejected before the generic RemoteFile fallback.

`source.libraryBaseUrl` is the canonical **original full library base**, including its path prefix. `resource.effectiveBaseUrl` may reflect the host-permitted default-port HTTP to HTTPS upgrade. The effective URL, revision, launch ID, epoch and document generation do not replace persistent library identity. Host and Reader document generations are distinct fences.

## Resource transport

The claim seals one exact URL in either template:

- `{effectiveBaseUrl}/read/resource/{bookId}.epub?revision={revision}`
- `{effectiveBaseUrl}/api/book/{bookId}.epub`

Every native HEAD/GET first calls `moke_reader_resource_dispatch`. The raw plugin HTTP adapter preserves Range headers, uses the shared cookie jar and disables redirects. It accepts no arbitrary URL, request body or credentials/header injection. HEAD and a real one-byte `206` probe check the sealed size/ETag; subsequent exact ranges validate URL, MIME, total size, ETag and body length. The fixed legacy route also permits `application/octet-stream`.

Native EOF (including final bytes accompanying its EOF flag), or confirmed cancellation with outstanding native reads drained, precedes `moke_reader_resource_settle`. Reader awaits the original settle ACK. AbortController, a UI timeout, `finally`, lost IPC or document destruction cannot release occupancy. An unknown result disables further requests and progress mutations. Confirmed transient read failures retain bounded retry; retries wait for the prior native terminal state and ACK.

Publication content remains in Foliate sandbox frames. TLS/cookie policy remains the embedding host's existing policy; this change adds no ACL grants.

## Local progress identity and restore

Persistent snapshot keys are `moke-reader-progress-v1:` plus `JSON.stringify([canonicalOriginalLibraryBaseUrl, String(bookId)])`. Reader derives its existing hex book/config/store ID from that tuple, preserving the byte hash separately. This isolates localStorage, config paths, memory, first view restore, autosave and close saves for same-byte books in same-origin `/a` and `/b`.

An old snapshot whose key explicitly names the same original full base may restore. Empty-namespace snapshots are never read, migrated or deleted. Anonymous byte-hash config contributes presentation settings only, never location, page, XPointer or other progress. Identity-scoped snapshots cannot roll back a newer identity-scoped config.

The current claim has **no remote restore snapshot**. Reader does not fetch one using a global server or reconstruct authority. That host integration remains a separate follow-up. Third-party file/KOSync progress providers remain disabled during managed launches so another source cannot overwrite the claimed position.

## Progress relay and return

Managed relocate snapshots save locally under the full identity and coalesce trailing progress before `moke_reader_progress`. Sequences increase within the current document. The host takes and acknowledges remote saves. Managed progress never enters the legacy direct Talebook POST path, even if a stale global server is present. Native mutation replies that are lost/unknown are never replayed.

Before closing, Reader flushes pending relocate, stops autosave/new progress, completes accepted local writes and progress promises, cancels outstanding resource reads and subscribes to targeted `moke:reader-drain-ready`. It calls `moke_reader_closing` with the final sequence. Pending results remain occupied. A matching hint only triggers the same-claim, same-sequence closing observation; it does not release a source. There is no polling or timeout-based return. Only an authoritative `returned` with `complete` or `failed` permits closing the dedicated window. Unknown leaves the document/source occupied and blocks navigation.

Moke `21a2142` keeps Windows, mobile and full-document ownership unsupported. The controlled target has no legacy return query; its supported desktop lane returns by closing the dedicated native window after the handshake. Browser mocks and viewport tests do not validate native caller, EOF, ACK or mobile ownership. The actual Moke gitlink/controller and production gates remain host responsibilities.

## Legacy local launch

Already host-authorized local files may use `file`/`window.OPEN_WITH_FILES` and legacy presentation/context parameters. These values do not authorize an online source or declare capabilities. Legacy direct single-WebView progress saving remains for that compatibility path; managed online progress always has the host as sole remote owner. `mokeReturnTo` allows only `/library` on legacy returns.

Moke links `readestlib` with `default-features = false`, registers Reader plugins/protocols/invoke handlers/state and keeps plugin crates as direct dependencies for Tauri ACL manifests. Lifecycle and extension events continue through `ext_reader_event`; managed page persistence uses the frozen native relay instead. The retained progress schema is `moke.readest.progress.v1`.

## Verification and versioning

Run contract/Vitest tests, lint, typecheck, Reader build and the applicable locked Rust check, then validate the actual fixed host combination on supported native platforms. Missing vendor sources or browser/native tools must be reported as unmet checks. Compatible additions retain embed.v1/progress.v1; changes to frozen host fields require coordinated versioning.
