# TB-496 font restoration port

PR15 builds on `316403849f9be08402aefb6f4cb4e63c2a90f14b`, with main baseline `ab068bd8afcaadd757a2ca4f724113a4b1067ba2`. The font restoration closure below is ported from the fixed PR14 commit `81f909e0c5319b8ee09dd7527750426dce025cac`, under the TB-496 coordination decision. This is a selective source port, not a merge of PR14. Vendors and the Moke bridge contract remain unchanged.

| File / function | Source and reason |
| --- | --- |
| `src/styles/fonts.ts` / `mountAdditionalFonts` | Direct PR14 port: retain stylesheet completion and allow cancellation before awaiting font faces. |
| `src/app/reader/utils/initialLocation.ts` / `preserveInitialLocation` | Direct PR14 port: retain the saved location through stylesheets and fonts, then re-anchor the live renderer. Cancel for user navigation, close, or replaced documents. |
| Same file / `preserveReadingContext` | Direct PR14 port: the latest reading action owns its font layout cycle; passive reflow must not replace that intent. |
| `src/app/reader/components/FoliateViewer.tsx` | Apply only PR14 restoration wiring, stylesheet tracking and provisional progress gates; retain PR15 input-state cleanup and volume/click fixes. |
| `src/types/view.ts` / `wrappedFoliateView` | Direct PR14 lifecycle dependency: serialize renderer navigation behind initialization, expose reading-action/close cancellation, and settle queued callers on close. |
| `src/app/reader/hooks/useMokeCommandListener.ts` | Direct PR14 dependency: a late one-shot host launch restore must yield after a newer reading action. Explicit subsequent commands retain their existing behavior. |
| `readerNavigation.test.ts`, `mokeRestoreNavigation.test.tsx` | Direct PR14 regression port for mixed/slow navigation, failures, close and superseded launch restores. |
| `tests/browser/initial-location.mjs` | Direct PR14 browser regression port for late CSS/font bytes, actual glyph visibility, both viewports, user takeover and latest navigation. |
| `package.json` | Add the focused `test:initial-location` command alongside PR15's existing input and fade lanes. |

The Reader app paths in this table are relative to `apps/readest-app/`. PR14 README/package metadata is not copied. No PR14 commit history, unrelated change, Moke source/pin, or vendor change is brought into PR15.

Run `pnpm test:initial-location`, `pnpm test:page-turn-input`, `pnpm test:reader-browser`, `pnpm test`, `pnpm typecheck`, `pnpm lint` and `pnpm build`. The browser restoration lane uses synthetic original chapters and a controlled font; it does not establish production-font EPUB integration. TB-496 additionally retains the original EPUB/config and byte-exact production font regression, its pre-fix failures, real glyph geometry, and isolated-disk persistence evidence as issue attachments. Host IPC/OS/files remain explicit test substitutes, and CLI evidence does not replace Playwright MCP or Android/e-ink hardware validation.

When PR14 and PR15 later converge, review these overlapping files together. Keep one set of restoration owners, event listeners, navigation wrappers and progress gates. Do not stack two wrappers or re-anchor twice, and preserve cancellation before user takeover as well as normal subsequent saves. This port does not change PR14's frozen review input or carry its QA conclusions to PR15; validate the combined commit and final Moke pin independently.
