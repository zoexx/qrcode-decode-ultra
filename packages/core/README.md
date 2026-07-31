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
| `jsqr` | jsQR (pure JS) | ~30 KB | clean QR decodes here with **no WASM load** |
| `wechat` | OpenCV WeChat (CNN + super-resolution) | ~2.5 MB WASM | opt-in strong tier for low-res / small / blurry codes; separate package, lazy-loaded |

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

Multi-code capture is therefore real wherever the native tier is real. Treat
`onResults` as "everything the winning engine saw", not a completeness guarantee.

## Options

```ts
createScanner({
  engines: "fast",          // preset name or EngineId[]
  formats: ["qr_code"],     // restrict formats (default: ["qr_code"])
  worker: true,             // run engines off the main thread (default true)
  maxScansPerSecond: 10,    // live-video throttle, independent of camera fps
  lowResPreloadPx: 480,     // when WeChat is enabled, eagerly preload its WASM once
                            // a live-video frame's smaller dimension drops below this
                            // many pixels (non-blocking); 0 disables. default 480
});
```

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

## Notes

- ESM-only, TypeScript types included. Requires **TypeScript ≥ 5.7** (the
  `FrameImage` type uses a generic `Uint8ClampedArray`).
- **Your image source stays yours.** Nothing you pass to `scanImage` is closed,
  detached, or consumed — an `ImageBitmap` can be scanned as many times as you
  like. (Internally the worker transport transfers a bitmap and closes it on the
  far side, so a caller-supplied one is cloned first.)
- The worker ships as a separate entry, loaded by URL; consumer bundlers (Vite,
  webpack 5) pick it up via the `new Worker(new URL(...))` pattern automatically.
- If `Worker` / `OffscreenCanvas` / `createImageBitmap` are unavailable, or you
  pass `worker: false`, the same engines run in-process with an identical result
  contract.

## License

MIT for this package's code. Bundled jsQR is Apache-2.0; see `NOTICE` and the
repository `THIRD-PARTY-LICENSES.md`.
