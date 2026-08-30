# Readest Reader agent notes

This package is the Reader-only frontend/native library extracted from Readest for Moke.

- Keep the only routable page at `src/pages/reader.moke.tsx`.
- Do not reintroduce Readest library, account, API, billing, worker or release surfaces.
- Preserve the public Moke contract in `../../contract/moke-reader.v1.json`; breaking changes require a new version and a coordinated Moke PR.
- Moke embeds `src-tauri` as `readestlib` with default features disabled. Keep plugin/protocol/invoke registration APIs backward compatible.
- Never commit credentials, cookies, private server URLs, signing material, generated `public/vendor` assets, `.env*.local`, build output or Tauri generated projects.

Validation from the repository root:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm check:rust
```
