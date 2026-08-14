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
                  # /report.html is the on-device benchmark report
pnpm benchmark    # regenerate fixtures, run the bench, rewrite the README table
```

```bash
pnpm -C benchmark compat          # 3-engine compatibility matrix (macOS only)
pnpm -C benchmark compat:devices  # fold submitted device reports into the README
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
thread in **two** workers — core's own for the fast path, and one shipped by the
WeChat package for the strong tier, both speaking the same protocol via the
shared `serveWorker` / `WorkerClient` pair. `runCascade`
(`packages/core/src/engine.ts`) is the single cascade implementation; `runScan`
(`decode.ts`) wraps it with timing into `ScanResult[]`.

Where things live:

- `packages/core` (`qrcode-decode-ultra`) — the scanner. Exports `.`, `./worker`
  (its own worker chunk) and `./worker-runtime` (what an optional tier imports to
  build a protocol-compatible worker of its own). Zero WASM.
- `packages/react` (`qrcode-decode-ultra-react`) — one file, `src/index.tsx`:
  `useScanner()` owns getUserMedia + scanner lifecycle, is SSR-safe and
  StrictMode-safe; `<Scanner/>` wraps it. `react>=18` is a peerDep.
- `packages/wechat` (`qrcode-decode-ultra-wechat`) — the opt-in OpenCV tier, plus
  its own worker. `enableWechat()` registers both an engine factory and a worker
  factory; the main-thread engine is lazily imported so the ~6MB payload is only
  fetched on the path that actually uses it. **Never put a WeChat decode on the
  main thread** — it measures ~250-325ms, a visible freeze on live video.
- `apps/demo` — private Vite app, two pages, and the only end-to-end exercise of
  the lazy `enableWechat()` path. `index.html` is the camera + still-image demo;
  `report.html` (`src/probe.ts` + `src/DeviceReport.tsx`) is the **device
  report** — it replays `benchmark/fixtures` in whatever browser is open and
  emits the results as pasteable markdown. That is the only way this repo gets
  numbers off a real phone: the Node runner reports `native` as `n/a`, and
  `bench.yml` says of headless Linux CI that "the macOS/Android numbers are the
  real ones" while nothing else produces them. `base` is `"./"` so one build
  works at a domain root or under a Pages project sub-path — **use
  `import.meta.env.BASE_URL` for runtime asset URLs, never a leading slash.**
  Deployed to GitHub Pages by `.github/workflows/pages.yml` on push to main.
- `benchmark` — private `tsx` harness, now in three parts, each answering a
  question the others structurally cannot:
  - `harness/runner.ts` — Node runner (detection accuracy, reproduces anywhere).
    `native` is always `n/a` here.
  - `browser/runner.ts` — headless Chromium via Playwright, for whether `native`
    is real and what a decode costs the main thread.
  - `compat/runner.ts` — the **compatibility matrix**: drives the built
    `apps/demo` report page across Chromium, Firefox *and* WebKit and reads the
    structured `window.qrduReport` each run publishes, so it never reimplements
    what a device report contains. **Must run on macOS** — `native` is an engine
    *and platform* property (Chromium has no Shape Detection backend on Linux at
    all), so a Linux matrix publishes confidently false rows. Its workflow
    (`compat.yml`) pins `macos-latest` for exactly this reason.
  - `compat/devices.ts` — folds `device-report`-labelled GitHub issues (opened by
    the report page's "Report this device" button) into the README's real-device
    table. No backend and nothing automatic: a row exists because someone
    submitted it.

  All write to `results/` (gitignored) and inject between `<!--BENCH-->`,
  `<!--BENCH-BROWSER-->`, `<!--COMPAT-->` and `<!--DEVICES-->` markers in the root
  README. None are merge gates; they run from `bench.yml` / `compat.yml` on demand.

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
  `registerEngine`, `registerEngineWorker`, and types, plus the
  `./worker-runtime` entry for tiers that ship a worker. Everything else stays
  internal (`runCascade`, `createEngines`, `buildStatuses`, `hasEngine`,
  `getEngineWorkerFactory`, `resolveEngineIds`, the format helpers); don't widen
  it without a reason.
- **Benchmark fairness rule:** every engine receives the *same* `ImageData`,
  decoded once, and a wrong decode is a false positive, not a benign miss.
- Bundled engines (`jsqr`, the WeChat model) are Apache-2.0 and stay so; this
  project's code is MIT. Preserve `NOTICE`, `THIRD-PARTY-LICENSES.md`, and the
  per-package `LICENSE` files when touching dependencies.
