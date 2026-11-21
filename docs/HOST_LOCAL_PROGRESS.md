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
