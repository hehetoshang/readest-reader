# Online EPUB connection and navigation validation

Validated on Linux with Node, Vitest/jsdom, a local HTTP server, real zip.js and
Foliate EPUB parsing. This is reproducible protocol/parser evidence, not an
Android/OHOS UI or authenticated production-server acceptance test.

## Recovery policy

Moke preflight and Reader HEAD/Range reads have a 15-second attempt deadline,
including response-body consumption. Network failures and HTTP 408/502/503/504
get at most two retries, after 250 and 500 ms. Auth, range, representation and
resource-version failures are not automatically retried. Closing/cancelling
stops active reads and backoff. Optional Moke progress lookup has an 8-second
limit and falls back to the Reader's locally available position.

Import error causes preserve typed online failures so Reader's in-document
Retry/Download actions remain reachable. Initial nav read failures are not
silently accepted as an empty TOC. Failed view initialization closes its source.

## Navigation and traffic

Online books use their embedded EPUB3 nav or EPUB2 NCX links and skip the
whole-spine fragment/navigation enrichment performed for local books. Thus
chapter-specific fragment-location enrichment is not precomputed online;
ordinary nested TOC links and their chapter anchors remain available.

`apps/readest-app/src/__tests__/document/moke-online-epub.test.ts` starts a local
HTTP endpoint, injects one 503, and exercises HEAD, exact Range 206, ZIP central
directory lookup, nested TOC parsing, resolving both chapter targets and reading
their text. A repeated chapter read makes no additional HTTP request.

| Fixture | EPUB bytes | GET Range attempts (including injected 503) | Sum of requested range lengths |
| --- | ---: | ---: | ---: |
| EPUB3 nav | 2,623,656 | 6 | 64,535 |
| EPUB2 NCX | 2,623,674 | 6 | 64,535 |

The last column conservatively includes the requested bytes of the failed
503 attempt, whose body is empty. It excludes HTTP headers and is not a packet
capture or a general performance benchmark. Fixtures intentionally contain
large unrequested media/padding entries; these numbers prove bounded on-demand
access for these fixtures, not a universal transfer ratio for all EPUBs.

Additional regressions cover a cached-range end-byte miss, disconnected bodies,
three exhausted nav attempts, timeout cancellation, no retry after close,
non-retryable status codes, typed importer errors, and avoiding whole-book scans
in `readerStore`. Transfer counters include both import and render opens.

## Native empty-chunk regression (2026-09-06)

A developer-reported legacy endpoint was tested through the actual Moke debug
binary, tauri-plugin-http 2.5.9, and Linux WebKitGTK under Xvfb. The native bridge
was injected into a minimal local page; this isolates transport from UI lifecycle.
The server returned exact 206 ranges promptly. A one-byte read completed, but
15,360-byte and 65,536-byte reads stalled for the full 15-second attempt timeout.

The native plugin returned all requested bytes, then `[0]`: an empty, nonterminal
HTTP chunk. `[1]` is the separate EOF marker. With `highWaterMark: 0`, the bridge's
`pull()` returned without enqueueing or closing on `[0]`, leaving the pending
consumer waiting forever. Retrying the same read only repeated the stall.
Both Moke and Reader now continue pulling past empty nonterminal chunks until
data or EOF arrives, while retaining cancellation and header validation.

After the fix the same 15,360-byte and 65,536-byte native reads completed in
31 ms and 34 ms in one measured run, including EOF. A separate native test using
Reader's `RemoteFile` and source transport with real zip.js/Foliate parsed the
reported EPUB: 10 TOC entries, 29 sections, all 10 TOC targets resolved, and a
target chapter loaded. It took 420 ms and 7 successful range requests totaling
71,242 payload bytes out of a 5,840,652-byte book. These are single-run local
measurements, not a latency guarantee or a rendered-reader/UI test.

`mokeTauriRangeFetch.test.ts` covers empty chunks before, between and after data;
the equivalent Moke regression fails with the old bridge and passes with the fix.
Timeout diagnostics identify the native phase, response status, range, received
byte count and elapsed time. Retry diagnostics report the attempt/backoff; neither
logs URLs, credentials, native error strings or publication contents. Native
filesystem parsers also reject remote URLs, avoiding the unrelated HTTPS
`file not found` fallback warning while keeping local EPUB/MOBI parsing.

## Reproduce

From the Reader repository root:

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm --filter @readest/readest-app exec vitest run src/__tests__/document/moke-online-epub.test.ts
```

Real-device acceptance still needs packaged Moke on the target platform: session
cookies against Talebook, first rendered page, TOC taps/page turns, saved progress,
wire traffic and no offline book file, plus callback/IPC logs on open/close/retry.
