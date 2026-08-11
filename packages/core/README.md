# qrcode-decode-ultra

Browser QR scanning with a first-hit-wins engine cascade. This package ships the
**zero-WASM fast path** — platform `BarcodeDetector` → jsQR — running in a Web
Worker by default so decoding never janks the UI. Framework-agnostic.

The heavy OpenCV **WeChat** tier is a separate, opt-in package
([`qrcode-decode-ultra-wechat`](https://github.com/zoexx/qrcode-decode-ultra/tree/main/packages/wechat)):
installing this one pulls no WASM at all.

```bash
npm install qrcode-decode-ultra
```

## Quick start

```ts
import { createScanner } from "qrcode-decode-ultra";

const scanner = createScanner(); // fast: native -> jsqr, in a worker

// Still image — every code in the frame
const results = await scanner.scanImage(fileOrBlobOrImageBitmap);
for (const r of results) console.log(r.value, r.format, "via", r.engine);

// Live camera
const controller = scanner.scanVideo(videoEl, {
  onResult: (r) => console.log("primary:", r.value),      // results[0]
  onResults: (rs) => console.log(`${rs.length} code(s)`), // all of them
  once: true,
});
await controller.start();
// ...later
await scanner.dispose();
```

## The cascade

| Engine | Backing | Payload | Notes |
|--------|---------|---------|-------|
| `native` | platform `BarcodeDetector` | 0 | probed before trust — it can be present-but-broken or polyfill-shadowed; absent on Windows/Linux/iOS/Firefox |
| `jsqr` | jsQR (pure JS) | ~45 KB gzipped | clean QR decodes here with **no WASM load** |
| `wechat` | OpenCV WeChat (CNN + super-resolution) | ~2.5 MB WASM | opt-in strong tier for low-res / small / blurry codes; separate package, runs in its own worker, lazy-loaded |

First-hit-wins: the first engine to decode anything returns immediately. Each
decoder validates error-correction internally, so a returned result is already a
verified decode — there is no cross-engine voting and no `confidence` score.

### Presets

```ts
createScanner();                             // fast: native -> jsqr (default), ZERO WASM
createScanner({ engines: "fast" });          // same as default
createScanner({ engines: ["jsqr"] });        // explicit engine list
createScanner({ engines: "max-accuracy" });  // adds WeChat — needs qrcode-decode-ultra-wechat
```

## Many codes per frame

`scanImage` resolves to **every** code the winning engine found; `scanVideo`
delivers the same array to `onResults`, alongside `results[0]` to `onResult`.
Both callbacks fire on the same frame.

Tiers are never unioned — a later tier is never consulted to add codes an earlier
one missed — so per-frame yield depends on which tier won:

| Tier | Codes per frame |
|------|-----------------|
| `native` | **every** code present |
| `jsqr` | one |
| `wechat` | one |

Multi-code capture is free on `native`, which returns every code in one pass.
The other two decode one code per call, so extra codes cost extra passes — set
`maxCodesPerFrame` above 1 to opt in:

| Tier | Codes per frame | With `maxCodesPerFrame: 10` |
|------|-----------------|------------------------------|
| `native` | **every** code, 1 pass | unchanged — never capped, it is already free |
| `jsqr` | one | scans overlapping tiles; **fixed** cost whether the frame holds 10 codes or 1 |
| `wechat` | one | masks each hit out and rescans; costs one pass **per code found** |

Measured on a 1380x592 sheet of ten codes (Node, in-process): `jsqr` 10/10 in
~2.1s, `wechat` 10/10 in ~2.6s. On a single-code image the same setting costs
~190ms (jsqr) and ~440ms (wechat) versus ~45ms / ~260ms at the default.

That is why the default is 1: it keeps live video cheap. Treat this as a
still-image feature, and treat `onResults` as "everything the winning engine
saw", not a completeness guarantee.

jsQR's tiling is a heuristic — tiles are sized off the frame, so codes much
smaller than half the shorter side may still be missed. `wechat` uses its own
detected geometry and has no such limit.

## Options

```ts
createScanner({
  engines: "fast",          // preset name or EngineId[]
  formats: ["qr_code"],     // restrict formats (default: ["qr_code"])
  worker: true,             // run engines off the main thread (default true)
  maxScansPerSecond: 10,    // live-video throttle, independent of camera fps
  maxCodesPerFrame: 1,      // let jsqr/wechat find more than one code (default 1 = off)
  lowResPreloadPx: 480,     // when WeChat is enabled, eagerly preload its WASM once
                            // a live-video frame's smaller dimension drops below this
                            // many pixels (non-blocking); 0 disables. default 480
  race: false,              // send each frame to BOTH workers at once and take the
                            // first real decode, instead of escalating only on a miss
  onRace: (report) => {},   // per-frame race telemetry (only fires while race is on)
});
```

### Racing both workers

By default the WeChat tier is only consulted when the fast path misses. With
`race: true` both workers get the same frame at the same time and the first real
decode returns — so a hard code costs the *fastest* tier's time instead of the
sum of the tiers ahead of it.

It is opt-in because it is not free: WeChat decodes every frame (~250 ms of CPU
each) rather than only the ones that needed it. Needs the `wechat` tier enabled
and a worker transport; otherwise it is ignored and the cascade runs.

```ts
const scanner = createScanner({
  engines: "max-accuracy",
  race: true,
  onRace: (report) => {
    // Fires twice per frame when the lanes finish apart: once the instant a
    // winner is known, then again (complete: true) when the slower lane lands.
    if (!report.complete) return;
    for (const leg of report.legs) {
      // outcome: hit | miss | error | busy | pending
      // `busy`  — that worker was still on an older frame, so it was skipped.
      // `cold`  — its time includes a one-time model load, not just a decode.
      console.log(leg.lane, leg.engines.join("+"), leg.outcome, leg.ms, leg.cold ? "(cold)" : "");
    }
    console.log("winner:", report.winner); // "fast" | "strong" | null
  },
});
```

The winning lane's results are returned immediately; the slower lane keeps
running only to be timed, and anything it finds afterwards is reported through
`onRace` but never delivered as a result — it belongs to a frame you have already
moved past.

## API

```ts
interface Scanner {
  // Which engines are usable here, in requested order. Runs the native probe;
  // downloads nothing. Unusable tiers carry a `reason` ("not installed",
  // "probe failed", or the thrown message).
  ready(): Promise<EngineStatus[]>;

  // Eagerly load the engines the cascade will use, so the first scan isn't cold.
  preload(): Promise<void>;

  // Decode a still image. Resolves to every code the winning engine found, or [].
  scanImage(source: ImageSource): Promise<ScanResult[]>;

  // Live camera. Returns a controller with start() / stop() / running.
  scanVideo(video: HTMLVideoElement, options: ScanVideoOptions): ScanController;

  dispose(): Promise<void>;
}
```

`scanVideo` takes four callbacks — `onResult` (required, the primary code),
`onResults` (every code in the frame), `onError` (fatal: worker death, camera
loss), and `onDiagnostic` (non-fatal: an engine was skipped, unavailable, or
threw) — plus `once` to stop after the first decode.

Each `ScanResult` carries `value`, `format`, the `engine` that produced it,
`cornerPoints` when available, and `timing: { totalMs, coldStart }` — where
`coldStart` is true if a WASM/model load happened during that scan.

## Writing your own tier

`registerEngine` adds an engine to the cascade at runtime — that is how
`qrcode-decode-ultra-wechat` plugs in without core ever depending on it:

```ts
import { registerEngine } from "qrcode-decode-ultra";
registerEngine("wechat", () => new MyEngine()); // implements the Engine interface
```

If your engine is heavy, also register a **worker** for it with
`registerEngineWorker`. The scanner then drives it as a second worker on a
fast-path miss instead of blocking the main thread:

```ts
import { registerEngine, registerEngineWorker } from "qrcode-decode-ultra";

registerEngine("wechat", () => new MyEngine());          // in-process fallback
registerEngineWorker(
  "wechat",
  () => new Worker(new URL("./my.worker.js", import.meta.url), { type: "module" }),
);
```

Build that worker against `qrcode-decode-ultra/worker-runtime`, which gives you
the protocol server and nothing else — no built-in engines, so your worker
bundle stays small:

```ts
// my.worker.ts
import { registerEngine, serveWorker } from "qrcode-decode-ultra/worker-runtime";
registerEngine("wechat", () => new MyEngine());
serveWorker();
```

Registering a worker is optional; without one the engine simply runs in-process.

## Notes

- ESM-only, TypeScript types included. Requires **TypeScript ≥ 5.7** (the
  `FrameImage` type uses a generic `Uint8ClampedArray`).
- **Your image source stays yours.** Nothing you pass to `scanImage` is closed,
  detached, or consumed — an `ImageBitmap` can be scanned as many times as you
  like. (Internally the worker transport transfers a bitmap and closes it on the
  far side, so a caller-supplied one is cloned first.)
- The worker ships as a separate entry, loaded by URL; consumer bundlers (Vite,
  webpack 5) pick it up via the `new Worker(new URL(...))` pattern automatically.
- With the WeChat tier enabled there are **two** workers: this package's fast
  path, plus the tier's own (registered by `enableWechat()`). Both speak the same
  protocol, and `dispose()` tears down both.
- If `Worker` / `OffscreenCanvas` / `createImageBitmap` are unavailable, or you
  pass `worker: false`, the same engines run in-process with an identical result
  contract.

## License

MIT for this package's code. Bundled jsQR is Apache-2.0; see `NOTICE` and the
repository `THIRD-PARTY-LICENSES.md`.
