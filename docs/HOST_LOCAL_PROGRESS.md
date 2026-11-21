# Host local reading progress v1

This extension consumes Moke TB-517's `moke.readest.host-local-progress.v1` and keeps the existing `moke.readest.host-launch.v1` claim and `moke.readest.progress.v1` position. The Moke implementation can bind it to `prepareClaimedProgress` in `src/lib/reader-local-session.ts`. The host derives the progress identity from its original launch snapshot before providing the extension to the claimed Reader document.

## Claim and command mapping

The existing `moke_reader_claim` reply may include `localProgress` with these fields.

| Field | Value |
| --- | --- |
| `schema` | `moke.readest.host-local-progress.v1` |
| `accountId` | Confirmed stable Talebook account ID, or `null` for local-only ownership |
| `format` | `epub` |
| `fileVersion` | Opaque host version bound to the exact opened resource |
| `returnTarget` | `desktop-window` or `mobile-library`, fixed when the host creates the launch |
| `restore` | `null` or the host-selected `{ id, position }` |

The original canonical library base and book ID come from the base claim. The Reader uses account and file version to scope its local book configuration. Durable host storage and conditional eligibility are owned by Moke. The Reader sends the position alongside the original `launchId` and `claimToken` and leaves account, address, format, file version and conditional metadata out of every frame.

| IPC command | Additional arguments and acknowledgement |
| --- | --- |
| `moke_reader_acknowledge_restore` | `receipt: { id, navigationGeneration: 1, outcome }`. Call `acknowledgeRestore` and return its boolean. |
| `moke_reader_begin_navigation` | `navigationGeneration`. Call `beginNavigation` and return its boolean. |
| `moke_reader_progress` | `sequence`, `navigationGeneration`, `payload`. Call `capture({ sequence, navigationGeneration, position: payload })`. Acknowledge `saved` or `duplicate` as `localProgressStatus` on the existing reservation reply, with the accepted `lastSequence`. Return `write-failed` with the preceding accepted sequence only when the transaction definitively failed. Rejected stale/invalid frames must never advance the accepted sequence. |
| `moke_reader_closing` | `lastSequence`. Verify `drain(lastSequence)` and original resource ticket completion before reporting `returned/complete`. The targeted `moke:reader-drain-ready` event asks Reader to observe the same claim and final sequence again. |

Reader retries only a typed, definite local write failure, at most twice with the original frame and sequence. A lost acknowledgement or transport failure leaves completion uncertain. Moke remains the sole remote writer. Anonymous records and sample books may be retained locally. Eligibility for conditional delivery stays with the host's verified account and file identity.

## Restore and return

The Reader restores the EPUB CFI or section against the opened publication. It suppresses restore relocations as new reading positions and waits for initial font layout before acknowledging. A later turn or jump supersedes the initial generation and cancels its pending reanchor. Reader-side coalescing retains the generation of the original relocate through the render frame.

An explicit close stops new navigation, flushes the final rendered frame and drains accepted writes. Desktop requests native window close after confirmation. The single-WebView mobile path asks the host to navigate to `/library` through the existing `moke_navigate` command after the same confirmation. The host must bind that navigation to its confirmed return lifecycle. A destroyed page cannot produce a successful receipt. Production mobile and native capability gates are part of the Moke integration.

Legacy local paths and formats outside the claimed EPUB lane continue to use Reader-local progress and existing presentation settings. Earlier unscoped progress keys remain in local storage. Unversioned TB-455 claims retain their original relay shape. Reader makes no direct Talebook progress POST.

## Downloaded EPUB claims

Moke can opt in to the additive `hostDownloadedEpub` contract advertised in the Reader manifest when its native download authority is available. Keep the base claim, original canonical library address, book ID, document generations, epoch, and `localProgress` envelope. Send the following resource in place of the online URL fields.

```json
{
  "kind": "downloaded-epub",
  "size": 246810,
  "fileVersion": "verified-epub-version"
}
```

`size` is the positive exact byte count. `fileVersion` must equal `localProgress.fileVersion`, and `localProgress.accountId` must identify the confirmed account. Seed restore only from the scope of the verified original library, account, book, format and byte version. Use the same version for an online claim only when the host verifies that it represents the same EPUB. When the host cannot establish ownership or file version before launch, it may use the ordinary local-file entry and its device-only progress. Rejected or expired managed launches stop on the claimed lane, so any retry or local open starts a fresh host action.

The host selects the file from its protected native download index. Bind the reservation to the actual original library entry, verified account, book ID, EPUB bytes/version, native window and WebView, and both document generations. Pin an immutable file snapshot or enforce equivalent consistency across ranges, including during deletion or replacement. Validate the account, current documents, claim token, file binding, and launch phase natively before accepting each command and before returning bytes from asynchronous reads. Account/library switch, invalidation, document replacement, or revocation must render the old claim unusable. Dispose of the old Reader document on revocation to discard bytes already in its memory.

| Command | Wire contract |
| --- | --- |
| `moke_reader_claim` | Same `{ launchId }` and caller validation as the online claim. Same-document replay returns the existing claim under the existing lifecycle. |
| `moke_reader_download_read` | `{ launchId, claimToken, offset, length }`. Safe integers, byte offset zero-based, length 1–1,048,576 inclusive, and `offset + length <= size`. Validate arguments natively before allocation. Return exactly `length` raw bytes (Tauri IPC binary response, including an equivalent byte-array transport fallback). A repeat for the same active claim and range can return the same bytes. Reject stale/mismatched or failed reads with a sanitized error such as `reader_download_unavailable`. |
| Restore receipt, navigation, progress, closing | Same requests, sequence rules and acknowledgements as the host-local contract above. Persist once per accepted frame and replay only the confirmed duplicate acknowledgement for the same frame. |

Download read arguments carry no file path, URL, account, or file version. Reader supplies EPUB metadata from the validated claim and performs its normal EPUB parsing through bounded ranges. A claimed download uses no HTTP dispatch/settle commands, asset URLs, or filesystem scope grants. Online EPUBs retain the original exact-URL ticket lifecycle.

The host registers each accepted download range against the reservation before opening or reading bytes. A success reply acknowledges the complete read and its terminal accounting. Closing/revocation stops acceptance of new reads and drains or cancels every admitted native read, then releases the pinned resource before reporting `returned/complete`. Reader waits for its dispatched reads and pending writes before observing closing. An invalid reply, IPC loss, or rejected read makes the Reader launch uncertain with no automatic read replay or success acknowledgement. Native recovery/revocation owns cleanup after document destruction or transport loss. The ordinary host closing/drain-ready hint still verifies the final accepted sequence.

## Legacy mobile online EPUB progress

`legacyMobileProgress` in the packaged Reader manifest advertises the optional
`moke.readest.legacy-mobile-progress.v1` contract. It adds progress delivery to
the existing single-WebView online EPUB entry on OHOS, Android and iOS. Moke
opts in by adding `mokeLegacyProgressId` to the existing online Reader URL after
creating a native pending launch. Keep the current file URL and return route.
The lookup is an opaque ID of at most 128 characters. It grants no authority.
Managed launches continue using `mokeLaunchId` and the existing managed contract.

Moke creates the reservation from its current verified connection and open-book
operation. Bind it to the complete original canonical Talebook base URL
(including its path prefix), saved entry and revision, verified stable account,
book ID, exact opened EPUB source, the live main WebView and the expected Reader
document generation. Validate the actual IPC caller and its exact Reader launch
at claim time. Reuse that native binding on every capture, save and return.
Session replacement, logout, a different source or book, and document
replacement cancel the reservation. A query value, reported book ID or Reader
view key supplies no identity or permission.

All arguments and reply properties use camelCase except fields inside the
existing `moke.readest.progress.v1` position payload.

| Command | Request | Reply |
| --- | --- | --- |
| `moke_reader_legacy_progress_claim` | `{ schema, launchId }` | `{ schema, launchId, status: "claimed" \| "local-only", onlineClaim }` from the verified native launch. A missing, unsupported, unverified or expired launch returns unavailable or rejects. |
| `moke_reader_legacy_progress_capture` | `{ schema, launchId, claimToken, documentGeneration, sequence, payload }` | `{ schema, launchId, documentGeneration, sequence, status, lastSequence }` with the durable watermark defined below. |
| `moke_reader_legacy_progress_close` | `{ schema, launchId, claimToken, documentGeneration, lastSequence }` | `{ schema, launchId, documentGeneration, status: "ready", lastSequence }` only after the exact final sequence is durable and the same document's return is armed. Sequence 0 means that no position was submitted. |

`onlineClaim` is the existing `moke.readest.host-launch.v1` online reservation
and sealed resource, without the `localProgress` member. Its `launchId` matches
the outer ID. Reader uses the inner `claimToken` and `documentGeneration` for
progress and the existing `moke_reader_resource_dispatch` and
`moke_reader_resource_settle` commands for HTTP. The legacy lane does not call
the managed progress or closing commands. Moke must bind both sets of
commands to the same native reservation and exact caller. Keep the existing
exact-URL, original/effective base, size, ETag and resource ticket validation.
Reader also checks that the visible launch address, file and book match that
sealed claim. Query metadata alone cannot open an HTTP resource.

The capture payload has the usual progress schema, Reader marker and timestamp,
Reader book/view identifiers and present location, section, chapter, page,
total pages, percentage and fraction fields. Compare any legacy
`moke_book_id` with the sealed book ID and construct the stored/remote identity
from the reservation. Bound and validate the position and counters natively.
Moke owns persistence and any Talebook write. An ACK means the host durably
accepted the position or its eligible work for the original account. A remote
POST can execute independently under that verified scope. The legacy contract
does not attest to a file fingerprint or remote version for conditional writes.

Reader keeps its immediate local snapshot. It stages genuine primary-view
relocations and coalesces changed positions for 1.2 seconds. A repeated anchor,
startup restoration and annotation preview do not create a new host write.
Hidden `visibilitychange` and `pagehide` synchronously commit any pending render
frame and invoke capture in the same event task. This can overlap a preceding
capture waiting for its reply. The host must order admission and durable
commit by sequence, allow gaps, and prevent an older completion or retry from
overwriting a newer position. Deduplicate by reservation and sequence,
requiring identical payload for a replay at the same sequence.

- `saved` and `duplicate` echo the frame's sequence as `lastSequence` at
  acceptance. `duplicate` acknowledges a previously accepted identical frame.
- `superseded` reports a higher durable `lastSequence` in the same launch
  and allows an earlier in-flight capture to settle.
- `write-failed` is a definite failed transaction with `lastSequence` below
  the frame's sequence. Reader can retry that identical frame twice.
- Revocation, a missing or inconsistent receipt, or IPC failure prevents a
  confirmed return. A timeout is ambiguous and does not cause a replay. The
  latest local snapshot is retained. Host recovery retires the reservation.

On explicit close, Reader finishes requested navigation, flushes the final
rendered position, stops the book and finishes local saving. It submits the
pending frame, freezes capture, waits for the submitted frames, stops new
resource reads and cancels active reads before calling close with the highest
issued sequence. Moke checks that exact durable sequence and current document,
stops admitting captures and resource requests, and waits for every admitted
resource ticket to settle before arming one return to `/library`. On Android/OHOS, Reader sends the existing
`moke_navigate({ path: "/library" })` only after the ready receipt. Bind
scheduled native navigation to the armed document and consume the permit
at actual dispatch. On iOS, Reader assigns `/library` in the same WebView
after the receipt. Bind the actual local document navigation to the same
permit and consume it once. Release the reservation when the permitted
return commits. A destroyed or replaced document cannot confirm close.
The host owns cleanup for document loss, including final work already
admitted for the verified original session. Hidden alone does not close.

When the read source is verified but the stable account is unconfirmed, Moke
can return `local-only` with the same sealed read contract. Reader uses its
local snapshot and ordinary Back with zero native progress commands. When
support or a verified read source is absent, a host-authorized local copy can
use the existing local-file entry and ordinary Back. An unauthenticated
remote URL follows the existing unavailable-book recovery. Local/downloaded
files, desktop Reader windows and managed claims are outside this opt-in. A
claimed Reader does not use unbound Back if its save or close is unconfirmed.

### Integration check

The Reader replacement-host matrix runs with
`pnpm --filter @readest/readest-app exec vitest run --maxWorkers=1 src/__tests__/services/mokeLegacyProgress.test.ts`.
It covers OHOS, Android and iOS, each with debounce, close, pagehide and
hidden visibility. The real Reader bridge must deliver the final frame
once to the host substitute. It also checks fallback, stale documents,
same-frame retry and Back ordering.

In Moke, first run the unchanged control from the fixed #48 checkout:

```powershell
$env:MOKE_READER_TEST_ROOT = (Resolve-Path ../readest-reader).Path
node --test --experimental-strip-types tests/reader-single-webview-progress.test.mjs
```

That control expects the historical Reader to POST directly. The published
gitlink passed 16 of 16 including the 12 online cases. With Reader #16 and
the fixed host, the 12 online cases are expected to see zero POSTs. For the
matching-host run, update that test to arm the real legacy launch path and
route its command mock through Moke's actual capture/persistence handler.
Keep its per-platform/per-trigger assertion of a single POST to the full
original prefixed address with the last position and verified account.
Assert zero Reader-owned POSTs and zero captures from unverified or stale
launches, and gate Back on the exact close receipt. The physical-device
run verifies the native caller, genuine lifecycle events and return.
