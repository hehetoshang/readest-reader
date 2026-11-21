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
