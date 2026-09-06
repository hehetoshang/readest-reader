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
