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

## 3. Two workers, one protocol

`worker/protocol.ts` is the single source of truth for both sides: typed
discriminated unions, id-correlated request/response.

- main → worker: `init`, `preload`, `decode`, `dispose`
- worker → main: `ready`, `preloaded`, `result`, `error`, `disposed`

**Core's worker build contains the fast path only — `native + jsqr`.** It is a
pre-built artifact, emitted by tsup when *core* publishes, so it can only hold
what core statically imports — and core deliberately does not depend on
`qrcode-decode-ultra-wechat` (§6). That constraint is real, but it applies to
*that* worker, not to workers in general.

So the strong tier ships **its own** worker. `qrcode-decode-ultra-wechat` does
have `qr-scanner-wechat` as a static dependency, so its own build can emit a
self-contained worker chunk; `enableWechat()` registers a factory for it
(`registerEngineWorker`), and the scanner drives it as a second worker:

1. **Fast path.** The main thread hands core's worker an `ImageBitmap`; the
   worker draws it to an `OffscreenCanvas`, `getImageData()` once, runs
   `native → jsqr`, replies with a hit or a miss, and `close()`s the bitmap.
2. **Escalation.** On a miss, the same frame goes to the tier's worker over the
   identical protocol — so `WorkerClient` and the worker-side server
   (`serveWorker`) are shared verbatim; the only difference between the two
   workers is which engines their module graph registered.

Both tiers need the *same* pixels, and a live `<video>` advances between grabs,
so when an escalation is possible the scanner rasterizes the source once and
derives each worker's bitmap from that single frame.

**Why two workers rather than one.** Putting WeChat on the main thread — the
obvious simplification — is not viable. Measured in headless Chromium
(`pnpm benchmark:browser`), an escalated decode on the main thread blocks for a
~290 ms task and drops 17 animation frames; through the workers it produces no
long task and drops none. In Node the same decode measures ~250-325 ms
(per-category medians), with a 0.6-1.2 s model load on top. At the
default 10 scans/second that is a near-continuous main-thread block for as long
as the user is pointing at a hard code. `maxScansPerSecond` throttles when
decodes *start*; it does nothing about the block itself.

**The optional tier can never break the fast path.** Bring-up of the strong
tier's worker is fully contained: `new Worker(...)` alone throws synchronously
under a CSP `worker-src` denial, a cross-origin URL, or a bundler that never
emitted the chunk. Any such failure degrades to `available: false` (or to the
in-process engine), never a rejected `ready()`. The two `init` round trips are
also issued concurrently, so the fast path never waits on megabytes of WASM to
start decoding.

Two related rules keep a dead worker from wedging live video:

- `WorkerClient` latches a `dead` state on `onerror` and on dispose, and every
  later `send()` fails fast against it. A post to a worker that will never answer
  would otherwise leave a promise pending forever — and `scanVideo`'s `inFlight`
  flag never clears, so the loop silently stops decoding while still reporting
  `running: true`.
- A tier worker that dies mid-session is dropped and the scan continues on the
  fast path, reported through `onDiagnostic`. A fatal death of the *fast* worker
  stops the controller after one `onError`, rather than re-failing every frame.

Worker errors reach the consumer as the `ScanError` they already are — code and
message intact — rather than being flattened by `String(err)`.

**Fallbacks to the main thread.** There are exactly three, and all of them run
the same `Engine[]` through the same `runScan`, so the result contract never
changes — only the transport does:

1. `worker: false`.
2. No worker transport: `Worker` / `OffscreenCanvas` / `createImageBitmap`
   missing.
3. A tier registered an engine factory but **no** worker factory — e.g. a
   consumer calling `registerEngine("wechat", …)` by hand, or a version of the
   tier package predating `registerEngineWorker`. The scanner still runs it,
   in-process, rather than dropping the tier.

The tier's in-process engine loads its payload lazily, so a consumer who never
takes any of these paths never downloads it: the bytes live in the worker chunk
instead.

**Source ownership.** Every `ImageSource` stays the caller's. The library never
closes, detaches, or consumes a source it was handed — notably an `ImageBitmap`,
which survives any number of scans. Internally the worker transport *transfers* a
bitmap and closes it on the far side, so a caller-supplied `ImageBitmap` is
cloned before it is sent; only bitmaps the library created itself (e.g. decoded
from a `Blob`) are closed.

### Racing the two workers

`race: true` sends every frame to **both** workers at once instead of consulting
the strong tier only on a fast-path miss. The first real decode wins and returns;
nothing waits for the other lane.

The default stays the sequential cascade, because racing is not free: the WeChat
tier decodes every frame rather than only the ones the fast path missed, and that
decode costs ~250 ms of CPU whether or not it was needed. What it buys is a hard
code decoded in the *fastest* tier's time rather than the sum of the tiers ahead
of it, plus a per-frame measurement — `onRace` — of which tier is actually
winning on this device.

Five rules make it work rather than merely run:

- **One rasterization, two bitmaps.** The lanes share the frame's pixels (the
  same fairness invariant as the benchmark), but each needs its own
  `ImageBitmap`, because the transport transfers a bitmap and closes it on the
  far side.
- **First hit wins; the loser is measured, not awaited.** The lanes finish
  hundreds of milliseconds apart, so "await both" would hand every frame back at
  the slow lane's speed and make racing strictly worse than the cascade. The
  straggler runs on only to be timed: `onRace` fires twice, once provisionally
  when the winner is known and once complete when the last leg lands.
- **Late results are telemetry, never delivered.** A code the slow lane finds
  after the fast lane already returned belongs to a frame the caller has moved
  on from; surfacing it would report a decode of pixels no longer on screen.
- **A busy lane is skipped, never queued.** `WorkerClient` tracks decodes in
  flight, and a lane whose worker is still on an older frame is reported `busy`
  and left alone — otherwise every fast frame would pile another decode into the
  slow worker's message queue, a backlog that only grows.
- **A cold lane is flagged, not hidden.** A frame dispatched while the 2.5 MB
  model is still downloading wears that load in its round trip. The lane still
  runs — dropping a decode to keep a number tidy is the wrong trade — but the leg
  is marked `cold`, so a 20-second model load is never passed off as a decode
  time. Race mode also warms the strong tier at init, since racing leaves no
  "escalation moment" for preload-on-low-res to fire at.

Failure policy is the cascade's, unchanged: a dead strong lane is dropped and
scanning continues on the fast path; a dead fast lane surfaces as a `ScanError`,
but only if the strong lane didn't rescue that frame.

Racing needs two live workers. With `worker: false`, no worker transport, or a
tier that registered an engine but no worker, `race` is ignored and the
sequential cascade runs — racing an in-process engine against a worker is not a
race, just a blocked main thread.

## 4. More than one code per frame

`native` returns every code it sees in one pass. The other two decode one code
per call and have no multi API, so `maxCodesPerFrame` (default 1, off) drives
them through one of two strategies, declared per engine as
`capabilities.multi`:

- **`mask`** (`wechat`) — decode, paint the hit out of a scratch copy of the
  pixels using its `cornerPoints`, decode again. Terminates on its own and costs
  one pass per code actually present. Guards: a hit with no geometry, a
  degenerate box, or a repeated value all stop the loop rather than spin.
- **`tile`** (`jsqr`) — jsQR's *locator* collapses when several codes are in
  view: measured on a ten-code sheet it misses even the first one, so masking
  can never get started. Instead the frame is decoded whole, then in overlapping
  tiles. Overlap is what decides coverage — a half-tile step found 8/10 while a
  third-tile step found 10/10, and adding more tile *sizes* changed nothing.
  The whole-frame pass is not an optimisation: tiles are sized off the frame, so
  a code filling most of it fits in no tile, and without that pass multi-code
  mode would lose the single-code case.

`inherent` engines are never capped — there is no extra work to bound, and
truncating free results would be a regression. The caller's frame is never
mutated; masking works on a copy, and tile geometry is translated back into
source coordinates.

Tiling stays a heuristic: tile size is guessed from the frame, so codes much
smaller than half the shorter side can still be missed. That is the honest limit
of doing this without a finder-pattern detector of our own.

## 5. Live video: backpressure, preload, teardown

These live in the `scanVideo` loop in `scanner.ts`, not in the worker client —
the client just does one round trip.

**Backpressure** (what makes "doesn't jank" true):

1. One in-flight decode, ever.
2. Coalesce to latest — a frame arriving mid-decode is dropped, never queued.
3. A `maxScansPerSecond` throttle, independent of camera fps.

**Preload-on-low-res.** A cheap `min(videoWidth, videoHeight) < lowResPreloadPx`
check (default 480) warms the WeChat tier early — a `preload` message to its
worker, or the in-process engine's `load()` — idempotent,
non-blocking, once per scanner — so the 2.5 MB is warm *before* the frame where
escalation finally fires. Frame resolution is a *proxy* for QR-apparent-size (a
tiny QR in a 4K frame reads as "high-res" by this measure); it is the cheap,
zero-extra-work signal available without doing detection first.
`lowResPreloadPx: 0` disables it. Still images skip the preload and simply load
WeChat on demand when the cascade reaches it.

**Teardown.** Main posts `dispose` to every worker it spawned; each stops
accepting new messages, disposes its engines and replies `disposed` — a decode
already in flight is allowed to finish and closes its own bitmap. Main then
`terminate()`s (on `disposed`, or after a 200 ms timeout) and disposes the
in-process engine if one was built.

## 6. Engine registration and bundle size

`engines/registry.ts` holds a `Map<EngineId, EngineFactory>` with **no static
engine imports**. Each entry point registers only what it needs, so heavy tiers
stay out of bundles that never ask for them:

- `index.ts` → `registerBuiltins()` (native + jsqr)
- `worker/scanner.worker.ts` has its own module graph and calls
  `registerBuiltins()` again (native + jsqr only)
- `qrcode-decode-ultra-wechat` registers `wechat` at runtime, when the consumer
  calls `enableWechat()`
- that same call also registers a **worker factory** via `registerEngineWorker`,
  and the tier's own worker registers `wechat` inside its own module graph

A requested id with no registered factory is reported as an unavailable
`EngineStatus`, not an error. The main thread strips `wechat` out of core's
worker list and resolves that tier's status from its own worker's `init`.

`qrcode-decode-ultra/worker-runtime` is the entry an optional tier imports to
build such a worker: it exposes `registerEngine` + `serveWorker` and nothing
else, so a tier's worker bundle carries no jsQR it will never run.

Because `index.ts` and the worker entry both call `registerBuiltins()` as a
top-level statement, core declares `sideEffects` as those two files rather than
`false` — a bundler told the module is side-effect-free would be free to drop the
registration and leave the registry empty.

## 7. Packaging

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

## 8. Licensing

- QRCode Decode Ultra's own code: **MIT**.
- Bundled engines are **Apache-2.0** and stay Apache-2.0 — redistributable inside
  an MIT project, but notices must be preserved and they cannot be relicensed:
  - `jsqr` — Apache-2.0 (not MIT; a common mistake).
  - OpenCV core + Tencent `wechat_qrcode` module and its model weights — all
    Apache-2.0 (© 2021 THL A29 Limited, a Tencent company), reached via the MIT
    `qr-scanner-wechat` wrapper.
- Compliance ships as `LICENSE` (MIT) in each published package, `NOTICE`, and
  `THIRD-PARTY-LICENSES.md`.
