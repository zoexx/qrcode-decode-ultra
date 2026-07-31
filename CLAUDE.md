# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## Commands

pnpm workspace (pnpm 10, Node ≥20). From the repo root:

```bash
pnpm install
pnpm build        # build all packages/* via tsup
pnpm test         # vitest run across all packages
pnpm typecheck    # tsc --noEmit across the whole workspace
pnpm demo         # Vite dev server for apps/demo (webcam + still image)
pnpm benchmark    # regenerate fixtures, run the bench, rewrite the README table
```

Tests live only in `packages/core`:

```bash
pnpm -C packages/core test                           # all core tests
pnpm -C packages/core exec vitest run cascade        # one file by name filter
pnpm -C packages/core exec vitest run -t "first-hit" # one test by title
pnpm -C packages/core test:watch                     # watch mode
```

There is **no linter/formatter** (no ESLint/Prettier/Biome). `pnpm typecheck` +
`pnpm test` are the gates, and `.github/workflows/ci.yml` runs both — note it
builds first, because `apps/demo` and `benchmark` typecheck against
`packages/*/dist`.

## Architecture

**[`DESIGN.md`](DESIGN.md) is the architecture doc and is authoritative** — the
cascade, the `Engine` contract, the split worker transport, backpressure,
registration, and the packaging rule all live there. When the implementation
deviates from it, update it in the same change. Do not restate its content here.

The one-paragraph version: a QR-only, first-hit-wins cascade
(`native → jsqr → wechat`) behind one `Engine` interface, running off the main
thread by default. `runCascade` (`packages/core/src/engine.ts`) is the single
implementation; `runScan` (`decode.ts`) wraps it with timing into `ScanResult[]`.

Where things live:

- `packages/core` (`qrcode-decode-ultra`) — the scanner. Exports `.` and
  `./worker`. Zero WASM.
- `packages/react` (`qrcode-decode-ultra-react`) — one file, `src/index.tsx`:
  `useScanner()` owns getUserMedia + scanner lifecycle, is SSR-safe and
  StrictMode-safe; `<Scanner/>` wraps it. `react>=18` is a peerDep.
- `packages/wechat` (`qrcode-decode-ultra-wechat`) — the opt-in OpenCV tier.
- `apps/demo` — private Vite app; the only end-to-end exercise of the lazy
  `enableWechat()` path.
- `benchmark` — private `tsx` harness. `runner.ts` writes `results/latest.json`
  (gitignored) and injects the table between the `<!--BENCH-->` markers in the
  root README.

## Conventions

- **ESM-only.** TS source imports carry explicit `.js` extensions (e.g.
  `import { runScan } from "./decode.js"`) under `moduleResolution: bundler` +
  `verbatimModuleSyntax`. Match this — never drop the extension.
- **`formats.ts` is a closed vocabulary**: the 13 `BarcodeDetector` underscore
  strings. It stays whole even though the product is QR-only, because `native`
  can technically emit the others; `qr_code` is the default and the only format
  every tier supports. `EngineId` (`native|jsqr|wechat`) is the one shared id set
  across the public API, worker protocol, and benchmark drivers.
- **The public API surface is deliberately small** — `createScanner`,
  `registerEngine`, and types. Cascade internals (`runCascade`, the registry
  helpers, the format helpers) are not re-exported from `index.ts`; don't widen
  it without a reason.
- **Benchmark fairness rule:** every engine receives the *same* `ImageData`,
  decoded once, and a wrong decode is a false positive, not a benign miss.
- Bundled engines (`jsqr`, the WeChat model) are Apache-2.0 and stay so; this
  project's code is MIT. Preserve `NOTICE`, `THIRD-PARTY-LICENSES.md`, and the
  per-package `LICENSE` files when touching dependencies.
