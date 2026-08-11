# QRCode Decode Ultra

[![ci](https://github.com/zoexx/qrcode-decode-ultra/actions/workflows/ci.yml/badge.svg)](https://github.com/zoexx/qrcode-decode-ultra/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A browser **QR scanner** that decodes clean codes at jsQR speed with **zero
WASM**, runs **off the main thread**, and escalates to an **opt-in OpenCV WeChat
super-resolution tier** only for the codes the fast path misses.

![A QR code on a phone screen, read from a live webcam. A meter beside the video compares the fast worker against the WeChat worker frame by frame, showing which one decoded first and how long each took.](docs/demo.gif)

<sup>**Race mode** (opt-in) sends the same frame to both workers at once so you
can see which tier wins on your own hardware. It is a measuring tool, not the
default: normally the tiers *cascade*, and the WeChat worker never wakes for a
code `jsqr` already read.</sup>

```bash
npm i qrcode-decode-ultra              # core — zero WASM, framework-agnostic
npm i qrcode-decode-ultra-react        # optional: useScanner() + <Scanner/>
npm i qrcode-decode-ultra-wechat       # optional: strong tier, ~2.5 MB gzipped
```

## The problem

Browser QR scanning makes you pick up front. jsQR is ~45 KB gzipped of pure JS and reads
a clean, well-lit code instantly — but it misses the codes people actually
photograph: small, far away, motion-blurred, badly lit. The engines that *do*
read those are megabytes of WASM, downloaded by every visitor including the
majority scanning a crisp code at arm's length. And most scanners run the decode
loop on the main thread, so the UI stutters while the camera is live.

You can't pick correctly up front, because which tier a frame *needs* is only
knowable after the cheap one has failed. So don't pick — cascade.

## How it works

Engines run in a fixed order and the **first one to decode anything wins**: its
results return immediately and no later tier is consulted. Cost climbs at each
step, so the common case never pays for the hard case.

```mermaid
flowchart TD
    F(["frame — Blob · video · canvas · ImageBitmap"])
    N["`1 · native
    platform BarcodeDetector
    0 KB · every code in frame`"]
    J["`2 · jsQR
    pure JavaScript
    ~45 KB gzipped · no WASM`"]
    W["`3 · WeChat
    OpenCV CNN + super-resolution
    ~2.5 MB gzipped`"]
    R(["ScanResult[]"])

    subgraph fast ["fast worker — default, zero WASM"]
        N
        J
    end

    subgraph strong ["strong worker — opt-in, separate package"]
        W
    end

    F --> N
    N -- hit --> R
    N -- miss --> J
    J -- hit --> R
    J -. miss .-> W
    W --> R
```

- **The default install is zero-WASM.** `native + jsQR` only; the WeChat tier is
  a package you install separately, so its payload is never in a default bundle.
- **Nothing heavy touches the main thread by default.** Both tiers run in
  workers; the main thread only rasterizes the frame and routes it. Measured in
  headless Chromium on an escalated decode: on the main thread, a ~290 ms
  blocking task and 17 dropped animation frames; in workers, no long task and no
  dropped frames. (`worker: false`, or no `Worker`/`OffscreenCanvas`, falls back
  to in-process — see [`DESIGN.md`](DESIGN.md).)
- **Native is probed, not trusted.** `'BarcodeDetector' in self` isn't enough —
  the constructor can exist while `detect()` silently returns `[]`, and a
  ponyfill can shadow it — so the engine decodes a baked-in synthetic QR and
  checks for `[native code]` before native may win. Where it is real (Android
  Chrome, Chromium on macOS/ChromeOS) it is cheaper *and* stronger than the jsQR
  tier behind it: Chromium's macOS backend calls Apple's Vision framework,
  Android's rides ML Kit. Not the strongest tier overall — see `downscale_32`
  below.
- **The escalation warms itself.** A live frame whose smaller dimension drops
  below `lowResPreloadPx` (default 480) starts the WeChat load in the background,
  so it is in flight — usually done — before the frame that needs it.
- **Backpressure, not a queue.** One in-flight decode at a time; a frame arriving
  mid-decode is dropped, never queued, so the scanner never works on stale video.
- **Or race the two workers.** `race: true` sends each frame to both at once and
  takes the first real decode, so a hard code costs the *fastest* tier's time
  rather than the sum of the tiers ahead of it. Opt-in: it spends a ~250 ms
  WeChat decode on every frame, and needs both workers — without the WeChat
  worker registered the scanner silently keeps the cascade. `onRace` reports each
  lane's time per frame, which is how you learn which tier wins on a given device.

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

**Codes per frame depends on which tier won**, because tiers are never unioned.
`native` returns every code in the frame in one free pass. `jsqr` and `wechat`
return one unless you raise `maxCodesPerFrame`, which buys the extra codes with
extra decode passes (~2.1s for ten codes on `jsqr`, ~2.6s on `wechat`) — so it is
a still-image feature and defaults to off. Treat `onResults` as "everything the
winning engine saw", not a completeness guarantee. Details:
[`packages/core/README.md`](packages/core/README.md#many-codes-per-frame).

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

_Benchmark: 5 images per category, Node runner (Darwin 25.5.0/x64, node v24.17.0), generated 2026-07-31T03:40:17.923Z._

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
| qrcode-decode-ultra-fast | 1 | 8.5 | 78% |
| qrcode-decode-ultra-max | 747 | 14.8 | 93% |
| jsqr | 0 | 10.7 | 78% |
| native | n/a | n/a | n/a — no platform BarcodeDetector in Node — native needs a real browser |

> Native `BarcodeDetector` is reported `n/a` here because there is no platform backend off-browser; it is not a loss. The honest comparison the cascade lives in is the WASM/JS one above. The WeChat tier's value is its per-category win on the hard columns (downscale / damaged / torture) weighed against its cold-start cost — the fast path already saturates clean, rotated, blur, low-light and inverted.

<!--/BENCH-->

Read the per-category row, not the aggregate — the cold-start column beside it is
what the hard columns cost.

### In a real browser

The Node runner above cannot see two things: whether the platform
`BarcodeDetector` actually works, and what a decode costs the *main thread*.
Both need a browser, so there is a second harness —
`pnpm build && pnpm benchmark:browser` (Playwright + headless Chromium).

Workers do not make decoding faster; the transport adds a transfer and a round
trip. What they buy is main-thread availability, so blocking is the metric.

<!--BENCH-BROWSER-->

_Browser benchmark: chromium 151.0.7922.34, Darwin 25.5.0/x64, generated 2026-07-31T02:44:07.523Z._

**Main-thread cost of an escalated decode** — a `downscale_32` fixture, the case the fast path genuinely cannot read, so the WeChat tier runs. Figures span 5 consecutive decodes with the model already loaded.

| Transport | longest task | total blocking | longest frame gap | frames dropped |
|---|---|---|---|---|
| main thread (worker: false) | 288 ms | 516 ms | 299 ms | 17 |
| workers (default) | 0.0 ms | 0.0 ms | 17.8 ms | 0 |

> A task over 50ms is what the browser itself calls blocking; over ~100ms a tap feels unresponsive. `frames dropped` is what a 60fps camera preview loses.

**Per-frame cost at 720p** — a clean code in a 1280x720 frame read by the fast path, no escalation. The gap between the two rows is what the worker transport costs: one bitmap transfer plus a round trip. Absolute wall-clock is inflated by headless software rasterisation, so read the difference, not the magnitude. Both rows report a 0.0 ms longest task because a fast-path decode is split across awaits, which `longtask` cannot see — blocking is the escalated-decode table above, not this one.

| Transport | per frame | longest task | frames dropped |
|---|---|---|---|
| main thread (worker: false) | 146 ms | 0.0 ms | 0 |
| workers (default) | 167 ms | 0.0 ms | 0 |

**Native `BarcodeDetector` on this platform**: available

**Detection rate by category, in-browser** (the `fast` row now includes native):

| Preset | clean | rotated | blur | low_light | inverted | downscale_32 | damaged | torture | Overall |
|---|---|---|---|---|---|---|---|---|---|
| fast | 100% | 100% | 100% | 100% | 100% | 0% | 100% | 40% | 80% |
| max-accuracy | 100% | 100% | 100% | 100% | 100% | 60% | 100% | 80% | 93% |

> Engines that won at least one frame here: native, wechat.

<!--/BENCH-BROWSER-->

## Development

```bash
pnpm install
pnpm build       # build all packages via tsup
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit across the workspace
pnpm demo        # Vite dev server: webcam + still image
pnpm benchmark   # regenerate fixtures, run, rewrite the table above
```

`pnpm typecheck` and `pnpm test` are the gates and CI runs both; there is no
linter or formatter. See [`CLAUDE.md`](CLAUDE.md) for the fuller command list.

## License

MIT for QRCode Decode Ultra's own code. The engines it builds on — jsQR, and the
OpenCV WeChat model behind `qrcode-decode-ultra-wechat` — are Apache-2.0 and
remain so; their notices are preserved, not relicensed. See [`NOTICE`](NOTICE)
and [`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md).
