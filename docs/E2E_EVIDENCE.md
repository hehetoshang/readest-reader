# Moke ↔ Readest Reader E2E evidence

Date: 2026-08-30

## Revisions under test

- readest-reader branch: `feat/standalone-reader`
- Moke integration branch: coordinated PR (submodule points at the revision containing this file)
- extraction baseline: `b2b5d2f16ae5c76f8b71fec55ba1eef9713cf195`

## Environment

- Linux x86_64
- WebKitGTK 4.1 / 2.50.6
- Xvfb 1280×800
- Node.js 22.22.3, pnpm 11.1.1
- Rust 1.97.1
- Moke Tauri host with the opt-in `reader-e2e` WebDriver feature
- real reachable Talebook demo instance in guest mode (no credential or cookie recorded)
- real 405 KiB EPUB (`sample-alice.epub`) placed inside Moke's isolated E2E AppData `books` directory

## Command outline

```bash
# Build frontend/native boundaries
git submodule update --init --recursive
cd readest && pnpm install --frozen-lockfile && pnpm build && cd ..
pnpm build:reader
cargo build --manifest-path src-tauri/Cargo.toml --features reader-e2e

# Under Xvfb, start the Moke and Reader dev servers plus the Tauri binary,
# then drive the localhost WebDriver endpoint. All processes use an isolated
# XDG data/config root and are terminated at the end of the lane.
```

The automation performed these observable phases (only sanitized fields retained):

```jsonl
{"phase":"server-connected","path":"/shelf"}
{"phase":"session-authenticated","path":"/shelf"}
{"phase":"book-open-command","source":"real-epub","via":"moke-tauri-ipc"}
{"phase":"reader-rendered","path":"/readest/reader","textLength":142,"viewerCount":1}
{"phase":"error-observed","code":"progress.network","operation":"progress.save","retryable":true}
{"phase":"e2e-complete","connection":true,"realEpubOpened":true,"chapterRendered":true,"errorObservable":true}
```

## What this proves

1. The real Moke application established a connection to a real Talebook deployment.
2. Moke's actual Tauri `open_reader` IPC opened a real EPUB from an approved AppData path.
3. The independent Reader dev surface loaded at `/readest/reader`; Foliate created a viewer and rendered chapter text.
4. A forced unreachable progress endpoint produced the stable, sanitized `reader:error` browser event while Reader remained rendered.
5. The E2E log contained no password, cookie, authorization header or token. A 1280×800 Reader screenshot was delivered with the issue result rather than committed to source.
