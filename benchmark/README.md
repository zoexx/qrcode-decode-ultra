# Benchmark

A reproducible detection-rate + speed benchmark for the QRCode Decode Ultra
cascade against standalone jsQR and native `BarcodeDetector`. Built to be re-run
by anyone: `pnpm benchmark` regenerates the fixtures and rewrites the table in
the root README.

```bash
pnpm benchmark           # generate fixtures + run + write results + update the root README
pnpm gen                 # just (re)generate the synthetic fixtures
pnpm report              # just run against existing fixtures
pnpm benchmark:browser   # the browser half (Playwright + headless Chromium)
```

Both write into `results/` (gitignored) and inject their table into the root
README. The browser harness needs the packages built first (`pnpm build`) and a
one-time `pnpm exec playwright install chromium`.

## How it works

- **Synthetic fixtures** (`scripts/gen-synthetic.ts`): clean QR codes degraded
  along one axis each — rotation, blur, low-light, inversion, downscale-to-32px,
  damage within ECC, and a JPEG "torture" pass. Our own content, so they are
  dedicated to the public domain (Unlicense) and committed, each with its payload
  and sha256 as ground truth in `fixtures/manifest.json`. One degradation per
  image is the point: it makes a "we win on blur / downscale" claim falsifiable
  per category rather than only in aggregate.
- **Fairness** (`harness/decode-contract.ts`): every engine gets the *same*
  decoded `ImageData`, with one success predicate for all of them (NFC + trim,
  exact match). A wrong value is a **false positive, not a benign miss**, so
  detection rate can't be farmed with garbage.
- **Engines** (`harness/engines.ts`): `qrcode-decode-ultra-fast` (native + jsQR)
  and `qrcode-decode-ultra-max` (+ WeChat) — the ablation that isolates the
  WeChat delta against our own zero-WASM baseline — plus standalone `jsqr` and
  `native` for reference. Native is reported `n/a` off-browser rather than 0%; it
  is not a loss.
- **Runner** (`harness/runner.ts`): Node, N=5 reps per image, reports the median
  and times cold-start (model/WASM load) separately. Writes `results/latest.json`
  (gitignored) and injects the per-category table into the root README between
  the `<!--BENCH-->` markers.

This is a **Node** runner: it exercises exactly the WASM/JS comparison the
cascade lives in, which reproduces identically anywhere, and it is honest that
native `BarcodeDetector` needs a real browser.

## The browser half (`browser/`)

Two questions the Node runner structurally cannot answer:

- **Is `native` real here?** It is reported `n/a` off-browser, which leaves the
  cascade's first tier unmeasured. In Chromium on macOS it is available and wins
  most frames, which is why the in-browser `fast` row beats the Node one.
- **What does a decode cost the main thread?** Workers do not make decoding
  faster — the transport adds a transfer and a round trip. They buy main-thread
  availability, so the metric is `longtask` duration and dropped animation
  frames, not throughput.

`browser/main.ts` runs in the page and is driven by `browser/runner.ts` through
Playwright. Two guards keep the blocking number honest: the harness picks a
fixture the strong tier actually decodes (it reads only ~60% of `downscale_32`,
so a fixed choice can silently time a *failed* search), and it hard-fails if the
sample never decoded.

A note on frame size, since it is a real caveat: the fixtures that escalate are
tiny by construction, so rasterising one is free and would flatter the worker
transport. Compositing a small QR into a 720p frame does not fix this — a probe
across QR sizes from 32 to 256px found no size where the fast path misses and
WeChat succeeds, because native reads a cleanly-rendered small code from ~48px
up and a `downscale_32` source has already lost what upscaling would need. So
the two costs are measured separately: escalated-decode blocking on the raw
fixture, and per-frame transport cost on a full 720p frame.

## Reading the result

The headline is the **per-category** breakdown, never the aggregate. The low-res
categories (`downscale_32`, `blur`, `low_light`) are where the WeChat tier earns
its 2.5 MB, and its cold-start and per-decode costs sit in adjacent columns —
that pairing is the honest "is the 2.5 MB worth it, and for which codes" answer.
Current numbers live in the [root README](../README.md#benchmark).
