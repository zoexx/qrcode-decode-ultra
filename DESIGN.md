# Architecture

How QRCode Decode Ultra is put together, and why. The [README](README.md) covers
what it does; this covers the contracts the implementation has to keep. When the
code deviates from this document, update this document in the same change.

## 1. The cascade

Engines run in a fixed order. Each declares which formats it can return, and the
cascade skips an engine that can't handle any requested format.

| Order | Engine id | Backing | Payload | Role |
|-------|-----------|---------|---------|------|
| 0 | `native` | platform `BarcodeDetector` | 0 | zero-payload fast path, where it genuinely works |
| 1 | `jsqr` | `jsqr` (pure JS) | ~30 KB JS | the happy path for clean QR; no WASM at all |
| 2 | `wechat` | `qr-scanner-wechat` (OpenCV) | ~2.5 MB WASM | opt-in strong tier for low-res / hard codes; separate package |

**First-hit-wins.** The first engine to decode anything returns, and no later
tier is consulted. These decoders all validate error-correction internally, so a
returned result is already a verified decode — which is why there is no
cross-engine voting and **no `confidence` score** on the public result. A
confidence float would be a partly-hardcoded number consumers write thresholds
against, and it would break whenever an engine changed.

**Native is probed, not trusted.** `'BarcodeDetector' in self` is necessary but
not sufficient:

- Pre-Chrome-113 on macOS Ventura, the constructor exists but `detect()`
  silently returns `[]`.
- A `barcode-detector` ponyfill from an unrelated dependency can install a
  non-native `BarcodeDetector` on `globalThis`.

So `NativeEngine.isAvailable()` runs a one-time live decode of a baked-in
synthetic QR (`probe-image.ts`) and checks `BarcodeDetector.toString()` for
`[native code]`. If either check fails, native drops out and `jsqr` becomes the
de-facto first tier. On Windows / Linux / iOS / Firefox native is simply absent.

Where native *is* real it is the strongest and cheapest tier at once, because it
is not a reimplementation: Chromium's macOS backend calls Apple's Vision
framework (`VNDetectBarcodesRequest`), and on Android the same API rides Google
Play Services / ML Kit. There is no portable artifact to vendor from either — you
can only call them — which is exactly why the cascade probes for them and lets
them win first.

### Presets

A preset is just an ordered `EngineId[]`; there is no per-preset code path.

- `fast` (default) — `['native', 'jsqr']`. Zero WASM, smallest possible build.
- `max-accuracy` — `['native', 'jsqr', 'wechat']`. Requires
  `qrcode-decode-ultra-wechat` installed and `enableWechat()` called; otherwise
  `wechat` is reported missing and the scanner behaves as `fast`.

## 2. The `Engine` interface

One interface, so the worker path and the in-process fallback share the same
cascade code and native is "just another engine".

```ts
interface Engine {
  readonly id: EngineId;
  readonly capabilities: { formats: ReadonlySet<BarcodeFormat> };
  isAvailable(): Promise<boolean>;   // native runs its live probe here
  load(): Promise<void>;             // lazy, idempotent — no double WASM download
  ready(): boolean;
  decode(frame: FrameImage, formats: BarcodeFormat[]): Promise<EngineResult[]>;
  dispose(): void;
}
```

Two rules carry the whole design:

- **`decode` returns `[]` on a miss and never throws.** Throwing is reserved for
  genuine engine failure, and `runCascade` catches it as a fall-through to the
  next tier — an engine can never take the scan down.
- **`decode` takes one normalized `FrameImage`.** Every engine accepts that shape
  (native `detect()` accepts `ImageData`, jsQR wants `data/width/height`,
  `qr-scanner-wechat` accepts `{data,width,height}`), so the source is rasterized
  to pixels exactly once — which is also the benchmark's fairness invariant.

`ImageData` is structurally assignable to `FrameImage`, so a real `getImageData()`
result is a valid frame and tests can build one without a DOM.

## 3. Split transport

`worker/protocol.ts` is the single source of truth for both sides: typed
discriminated unions, id-correlated request/response.

- main → worker: `init`, `preload`, `decode`, `dispose`
- worker → main: `ready`, `preloaded`, `result`, `error`, `disposed`

**The worker runs the fast path only — `native + jsqr`.** WeChat is never in the
worker build, because core must not statically import the optional
`qrcode-decode-ultra-wechat` package. So the scanner runs a split transport:

1. **Fast path in the worker.** The main thread produces an `ImageBitmap`; the
   worker draws it to an `OffscreenCanvas`, calls `getImageData()` once, runs
   `native → jsqr`, replies with a hit or a miss, and `close()`s the bitmap. The
   common case stays entirely off the main thread.
2. **WeChat escalation in-process.** When the worker reports a miss *and* the
   WeChat tier is enabled, the main thread runs the in-process `WechatEngine` on
   the same frame. WeChat decodes are rare (only frames the fast path missed) and
   heavy regardless, and the one-in-flight backpressure bounds them, so one
   occasional main-thread decode is acceptable.

   Because the main thread needs the pixels for that possible second pass, when
   WeChat is enabled the scanner rasterizes the source to `ImageData` once on the
   main thread and sends a bitmap *copy* to the worker. When WeChat is off it
   keeps the zero-copy `ImageBitmap` transfer — the fast path pays nothing for a
   tier it doesn't use.

**No-worker fallback.** If `Worker` / `OffscreenCanvas` / `createImageBitmap` are
unavailable (or `worker: false`), the scanner instantiates the same `Engine[]` —
including WeChat when enabled — on the main thread and calls the same `runScan`.
Same result contract; only the transport differs.

**Source ownership.** Every `ImageSource` stays the caller's. The library never
closes, detaches, or consumes a source it was handed — notably an `ImageBitmap`,
which survives any number of scans. Internally the worker transport *transfers* a
bitmap and closes it on the far side, so a caller-supplied `ImageBitmap` is
cloned before it is sent; only bitmaps the library created itself (e.g. decoded
from a `Blob`) are closed.

## 4. Live video: backpressure, preload, teardown

These live in the `scanVideo` loop in `scanner.ts`, not in the worker client —
the client just does one round trip.

**Backpressure** (what makes "doesn't jank" true):

1. One in-flight decode, ever.
2. Coalesce to latest — a frame arriving mid-decode is dropped, never queued.
3. A `maxScansPerSecond` throttle, independent of camera fps.

**Preload-on-low-res.** A cheap `min(videoWidth, videoHeight) < lowResPreloadPx`
check (default 480) fires the WeChat engine's `load()` early — idempotent,
non-blocking, once per scanner — so the 2.5 MB is warm *before* the frame where
escalation finally fires. Frame resolution is a *proxy* for QR-apparent-size (a
tiny QR in a 4K frame reads as "high-res" by this measure); it is the cheap,
zero-extra-work signal available without doing detection first.
`lowResPreloadPx: 0` disables it. Still images skip the preload and simply load
WeChat on demand when the cascade reaches it.

**Teardown.** Main posts `dispose`; the worker stops accepting new messages,
disposes its engines and replies `disposed` — a decode already in flight is
allowed to finish and closes its own bitmap. Main then `terminate()`s (on
`disposed`, or after a 200 ms timeout) and disposes the in-process WeChat engine.

## 5. Engine registration and bundle size

`engines/registry.ts` holds a `Map<EngineId, EngineFactory>` with **no static
engine imports**. Each entry point registers only what it needs, so heavy tiers
stay out of bundles that never ask for them:

- `index.ts` → `registerBuiltins()` (native + jsqr)
- `worker/scanner.worker.ts` has its own module graph and calls
  `registerBuiltins()` again (native + jsqr only)
- `qrcode-decode-ultra-wechat` registers `wechat` at runtime, when the consumer
  calls `enableWechat()`

A requested id with no registered factory is reported as an unavailable
`EngineStatus`, not an error. The main thread strips `wechat` out of the worker's
engine list and reports that tier's status itself.

Because `index.ts` and the worker entry both call `registerBuiltins()` as a
top-level statement, core declares `sideEffects` as those two files rather than
`false` — a bundler told the module is side-effect-free would be free to drop the
registration and leave the registry empty.

## 6. Packaging

```
qrcode-decode-ultra/            # pnpm workspace, ESM-only
├── packages/
│   ├── core/      qrcode-decode-ultra          framework-agnostic
│   ├── react/     qrcode-decode-ultra-react    useScanner() + <Scanner/>, peerDep react>=18
│   └── wechat/    qrcode-decode-ultra-wechat   opt-in strong tier (never a core dep)
├── apps/demo/                  private — Vite app, webcam + still image
└── benchmark/                  private — Node/tsx harness + synthetic fixtures
```

**The packaging rule:** `qrcode-decode-ultra-wechat` is its own package — NOT a
dependency and NOT an `optionalDependencies` of core. `optionalDependencies` are
installed by default, which would silently pull 2.5 MB into every install and
defeat the zero-WASM default. A consumer adds the strong tier by explicitly
installing the package and calling `enableWechat()`; core discovers it at runtime
through the registry.

ESM-only (CJS is dead weight for a worker/WASM/`import.meta.url` library), built
with tsup. The default core build is already zero-WASM, so there is no separate
`./lite` entry — the default *is* lite. The worker ships as a separate chunk,
loaded by URL via `new Worker(new URL("./scanner.worker.js", import.meta.url))`,
which bundlers (Vite, webpack 5) detect and emit automatically.

## 7. Licensing

- QRCode Decode Ultra's own code: **MIT**.
- Bundled engines are **Apache-2.0** and stay Apache-2.0 — redistributable inside
  an MIT project, but notices must be preserved and they cannot be relicensed:
  - `jsqr` — Apache-2.0 (not MIT; a common mistake).
  - OpenCV core + Tencent `wechat_qrcode` module and its model weights — all
    Apache-2.0 (© 2021 THL A29 Limited, a Tencent company), reached via the MIT
    `qr-scanner-wechat` wrapper.
- Compliance ships as `LICENSE` (MIT) in each published package, `NOTICE`, and
  `THIRD-PARTY-LICENSES.md`.
