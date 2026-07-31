# QRCode Decode Ultra

[![ci](https://github.com/zoexx/qrcode-decode-ultra/actions/workflows/ci.yml/badge.svg)](https://github.com/zoexx/qrcode-decode-ultra/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A browser **QR scanner** that decodes clean codes at jsQR speed with **zero
WASM**, runs **off the main thread**, and escalates to an **opt-in OpenCV WeChat
super-resolution tier** only for the codes the fast path misses.

```bash
npm i qrcode-decode-ultra              # core — zero WASM, framework-agnostic
npm i qrcode-decode-ultra-react        # optional: useScanner() + <Scanner/>
npm i qrcode-decode-ultra-wechat       # optional: the 2.5 MB strong tier
```

## The problem

Browser QR scanning makes you pick one:

- **Fast and tiny, but brittle.** jsQR is ~30 KB of pure JS and reads a clean,
  well-lit code instantly. It misses the codes people actually photograph —
  small, far away, motion-blurred, badly lit.
- **Accurate, but heavy for everyone.** The engines that *do* read those codes
  are megabytes of WASM, downloaded by every user on every visit — including the
  majority scanning a crisp code at arm's length.
- **Blocking.** Most scanners run the decode loop on the main thread, so the UI
  stutters while the camera is live.
- **One code per frame.** A sheet of labels or a wall of tickets becomes one
  scan per code.

You can't pick correctly up front, because which tier a frame *needs* is only
knowable after the cheap one has failed. So don't pick — cascade.

## How it works

Engines run in a fixed order and the **first one to decode anything wins**: its
results return immediately and no later tier is consulted. Cost climbs at each
step, so the common case never pays for the hard case.

```mermaid
flowchart TD
    F(["frame — Blob · video · canvas · ImageBitmap"])
    N["1 · native<br/>platform BarcodeDetector<br/>0 KB · every code in frame"]
    J["2 · jsQR<br/>pure JavaScript<br/>~30 KB · no WASM"]
    W["3 · WeChat<br/>OpenCV CNN + super-resolution<br/>~2.5 MB WASM"]
    R(["ScanResult[]"])

    subgraph worker ["Web Worker — default, zero WASM"]
        N
        J
    end

    subgraph main ["main thread — opt-in, separate package"]
        W
    end

    F --> N
    N -- hit --> R
    N -- miss --> J
    J -- hit --> R
    J -. miss .-> W
    W --> R
```

- **The default install is zero-WASM.** `native + jsQR` only. The WeChat tier
  lives in a package you install separately, so its 2.5 MB is never in a default
  bundle — and never in the worker build.
- **Native is probed, not trusted.** `'BarcodeDetector' in self` isn't enough:
  the constructor can exist while `detect()` silently returns `[]`, and an
  unrelated ponyfill can shadow it. So the engine runs a live decode of a
  baked-in synthetic QR and checks for `[native code]` before it's allowed to
  win. Where it is real (Android Chrome, Chromium on macOS/ChromeOS) it is both
  the strongest and the cheapest tier — Chromium's macOS backend calls Apple's
  Vision framework, Android's rides ML Kit.
- **The escalation warms itself.** A live frame whose smaller dimension drops
  below `lowResPreloadPx` (default 480) kicks off the WeChat load in the
  background, so the 2.5 MB is already resident on the frame that finally needs
  it instead of stalling on a cold download.
- **Backpressure, not a queue.** One in-flight decode at a time; a frame arriving
  mid-decode is dropped rather than queued, so the scanner never works on stale
  video.

For the transport split, worker protocol, and `Engine` contract, see
[`DESIGN.md`](DESIGN.md).

## Quick start

```ts
import { createScanner } from "qrcode-decode-ultra";

const scanner = createScanner();

// Still image — every code the winning engine found in the frame.
const results = await scanner.scanImage(fileOrBlob);
for (const r of results) console.log(r.value, "via", r.engine);
```

Live camera — `onResult` is the primary code, `onResults` is all of them:

```ts
const controller = scanner.scanVideo(videoEl, {
  onResult: (r) => console.log("primary:", r.value),
  onResults: (rs) => console.log(`${rs.length} code(s) this frame`),
});
await controller.start();
```

React:

```tsx
import { Scanner } from "qrcode-decode-ultra-react";

<Scanner facingMode="environment" onResult={(r) => console.log(r.value)} />;
```

Full API: [`packages/core/README.md`](packages/core/README.md).

## Scope

**QR only.** No 1D barcodes, no DataMatrix / Aztec / PDF417. That focus is what
makes the two-tier design tractable; if you need general barcodes, use a
ZXing-based library.

**Codes per frame** depends on which tier won, because tiers are never unioned:

| Tier | Codes per frame |
|------|-----------------|
| `native` | **every** code present |
| `jsqr` | one |
| `wechat` | one |

So multi-code capture is real wherever the native tier is real. Treat
`onResults` as "everything the winning engine saw", not a completeness guarantee.

## Packages

| Package | What |
|---------|------|
| [`qrcode-decode-ultra`](packages/core) | Framework-agnostic scanner: cascade, worker, still-image + camera APIs. Zero WASM. |
| [`qrcode-decode-ultra-react`](packages/react) | `useScanner()` hook + `<Scanner/>` component. SSR-safe, owns the camera. |
| [`qrcode-decode-ultra-wechat`](packages/wechat) | Opt-in OpenCV WeChat tier for low-res / hard codes. Installed separately. |

## Benchmark

Every engine receives the *same* `ImageData`, decoded once, and a wrong decode
counts as a **false positive, not a benign miss** — so detection rate can't be
farmed with garbage. Reproduce with `pnpm build && pnpm benchmark` (the harness
imports the built package): it regenerates the fixtures, re-runs, and rewrites the
table below.

<!--BENCH-->

_Benchmark: 5 images per category, Node runner (Darwin 25.5.0/x64, node v24.17.0), generated 2026-07-30T22:52:53.972Z._

**Detection rate by category** (higher is better):

| Engine | clean | rotated | blur | low_light | inverted | downscale_32 | damaged | torture | Overall |
|---|---|---|---|---|---|---|---|---|---|
| qrcode-decode-ultra-fast | 100% | 100% | 100% | 100% | 100% | 0% | 80% | 40% | 78% |
| qrcode-decode-ultra-max | 100% | 100% | 100% | 100% | 100% | 60% | 100% | 80% | 93% |
| jsqr | 100% | 100% | 100% | 100% | 100% | 0% | 80% | 40% | 78% |
| native | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |

**Speed & cold start**:

| Engine | cold-start (ms) | median decode (ms) | overall detection |
|---|---|---|---|
| qrcode-decode-ultra-fast | 1 | 10.5 | 78% |
| qrcode-decode-ultra-max | 1217 | 19.8 | 93% |
| jsqr | 0 | 14.6 | 78% |
| native | n/a | n/a | n/a — no platform BarcodeDetector in Node — native needs a real browser |

> Native `BarcodeDetector` is reported `n/a` here because there is no platform backend off-browser; it is not a loss. The honest comparison the cascade lives in is the WASM/JS one above. The WeChat tier's value is its per-category win on hard codes (blur / low-light / downscale / torture) weighed against its cold-start cost.

<!--/BENCH-->

Read the per-category row, not the aggregate. The zero-WASM fast path already
saturates the ordinary categories — clean, rotated, blurred, low-light, inverted.
What the 2.5 MB actually buys is the hard columns (`downscale_32`, `damaged`,
`torture`), weighed against the cold-start figure sitting right beside them. That
pairing is the honest answer to "is the WeChat tier worth it, and for which
codes".

## Development

```bash
pnpm install
pnpm build       # build all packages via tsup
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit across the workspace
pnpm demo        # Vite dev server: webcam + still image
pnpm benchmark   # regenerate fixtures, run, rewrite the table above
```

There is no linter or formatter — `pnpm typecheck` and `pnpm test` are the gates,
and CI runs both.

## License

MIT for QRCode Decode Ultra's own code. The engines it builds on — jsQR, and the
OpenCV WeChat model behind `qrcode-decode-ultra-wechat` — are Apache-2.0 and
remain so; their notices are preserved, not relicensed. See [`NOTICE`](NOTICE)
and [`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md).
