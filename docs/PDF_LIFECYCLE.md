## PDF and file resource ownership (TB-460 / TB-473)

Foliate's PDF adapter owns its PDF.js loading task until it hands a book to
the caller. Failed loading, metadata, page or outline initialization awaits
task destruction. `makePDF(file, { signal })` also supports loading cancellation.
PDF `book.destroy()` returns a memoized promise, stops the Range queue, drops late
data, and awaits PDF.js destruction and all already-started file reads. A failed
destroy remains a failed promise on repeated calls. Range failures are observed
and abort initialization/the live task rather than leaving an unhandled rejection.

`NativeFile` and `RemoteFile` have a terminal close fence. Close rejects new reads
and waits for actual pending operations, even if a transport ignores abort. A
late result cannot update metadata or populate caches. Native stream chunks own
independent handles released in `finally`; stream cancellation waits for its
pending read. Transport cancellation is requested immediately, while native
primary handles close after pending operations settle. No timeout is treated as
proof of native I/O completion.

`bookDataStore` was an unbounded strong owner of documents and files after
`clearViewState`; Foliate view close only destroys its renderer. The TTS session
manager intentionally retains `view.book` for background speech. The new release
path therefore checks all view keys (including loading views), active TTS, and
TTS teardowns before detaching book data and awaiting document/file cleanup.
There is no idle document cache after the final holder leaves. Concurrent closes
join pending cleanup; a reopen gets fresh resources. Opening cancellation prevents
a late document from recreating a closed view, and pre-publication failures
destroy the newly acquired document.

Cache and rendering budgets are unchanged: Foliate 16 decoded/rendered pages,
NativeFile 50 chunks, RemoteFile 128 chunks, with the existing per-transport chunk
sizes and concurrency limit 6. Desktop/mobile rendering resolution is unchanged.

## Reproduce checks

From a recursive clone with Node 24.22+ (the Foliate test uses `registerHooks`)
and the lockfile's pnpm 11.1.1:

```sh
pnpm install --frozen-lockfile
pnpm setup:vendors
node --test vendor/foliate-js/tests/pdf-lifecycle.test.mjs
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm check:rust
```

The Foliate lifecycle suite imports production `pdf.js` with controlled PDF.js and
I/O doubles. Reader tests import production file adapters, store and ownership
release paths with mocked native I/O/TTS dependencies. Existing EPUB tests parse
generated EPUB3/NCX bytes over a controlled HTTP Range server. None of these is
evidence of real Worker rendering, native Windows memory improvement, or the
reporter's PDF/EPUB behavior. No Playwright MCP tool was available in this run.

The separate trusted Reader PR #11 remains unchanged at
`e2a0b508301c57dbbc7203feff26c1bd8129dbbc`. Its overlapping files are ReaderContent
and readerStore; this change does not edit claims, native tickets, EOF/settle ACK,
progress identity, permissions, HTTP/Cookie/TLS policy or host close drain. The
new file fence observes transport promises; native authority remains governed by
the existing host protocol. The fixed candidate combination still requires
coordinated integration and native testing before acceptance of Moke #157.
