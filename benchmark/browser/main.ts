/**
 * In-page half of the browser benchmark. Playwright calls these through
 * `window.bench`; everything that must run in a real browser lives here.
 *
 * The Node runner (`benchmark/harness/runner.ts`) measures detection accuracy
 * with `worker: false`, because that comparison reproduces anywhere. It cannot
 * measure the two things that only exist in a browser: whether the platform
 * `BarcodeDetector` works at all, and how long the main thread is blocked.
 */
import { createScanner, type ScanResult } from "qrcode-decode-ultra";
import { enableWechat } from "qrcode-decode-ultra-wechat";

interface ManifestRow {
  image: string;
  expected: string;
  category: string;
}

/** Main-thread cost of one operation, as a user would feel it. */
export interface BlockingSample {
  /** Longest single task that occupied the main thread (ms). */
  longestTaskMs: number;
  /** Total time spent in tasks >50ms — the browser's "blocking time". */
  totalBlockingMs: number;
  /** Longest gap between animation frames (ms). 16.7 = no frames lost. */
  longestFrameGapMs: number;
  /** Frames a 60fps animation would have missed. */
  framesDropped: number;
  /** Wall-clock for the operation itself. */
  wallMs: number;
}

/** A QR of `qrPx` square, centred in a `width`x`height` frame — "small code, big camera frame". */
export interface Pad {
  width: number;
  height: number;
  qrPx: number;
}

/** Decodes per blocking sample; the reported task/blocking figures span all of them. */
const DECODES = 5;

const manifestPromise = fetch("/manifest.json").then((r) => r.json() as Promise<ManifestRow[]>);

/**
 * Load a fixture, optionally centred on a larger blank canvas.
 *
 * The padding matters for the blocking measurement: the fixtures that escalate
 * to WeChat are tiny by construction (`downscale_32` is 32x32), so rasterising
 * one costs nothing and would flatter the worker transport. Compositing it into
 * a camera-sized frame reproduces the real case — a small QR seen from across a
 * room — where the main thread genuinely has pixels to move.
 */
async function frameOf(row: ManifestRow, pad?: Pad): Promise<ImageData> {
  // manifest paths are repo-relative ("fixtures/synthetic/..."); the fixtures
  // directory is served at the root.
  const url = "/" + row.image.replace(/^fixtures\//, "");
  const blob = await (await fetch(url)).blob();
  const bitmap = await createImageBitmap(blob);
  const width = pad?.width ?? bitmap.width;
  const height = pad?.height ?? bitmap.height;
  const qr = pad?.qrPx ?? bitmap.width;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  if (pad) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
  }
  ctx.drawImage(bitmap, Math.round((width - qr) / 2), Math.round((height - qr) / 2), qr, qr);
  bitmap.close();
  return ctx.getImageData(0, 0, width, height);
}

/**
 * Run `op` while watching the main thread. `longtask` entries are the browser's
 * own definition of "this janked" (>50ms); the rAF gap is the same story from
 * the animation side, which is what a user actually sees on a live preview.
 */
async function withBlockingMetrics<T>(op: () => Promise<T>): Promise<[T, BlockingSample]> {
  const tasks: number[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) tasks.push(e.duration);
  });
  try {
    observer.observe({ entryTypes: ["longtask"] });
  } catch {
    /* longtask unsupported — gaps below still tell the story */
  }

  const gaps: number[] = [];
  let last = performance.now();
  let raf = 0;
  const tick = (): void => {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  const t0 = performance.now();
  const result = await op();
  const wallMs = performance.now() - t0;

  cancelAnimationFrame(raf);
  observer.disconnect();

  const longestFrameGapMs = gaps.length ? Math.max(...gaps) : 0;
  return [
    result,
    {
      longestTaskMs: tasks.length ? Math.max(...tasks) : 0,
      totalBlockingMs: tasks.reduce((a, d) => a + Math.max(0, d - 50), 0),
      longestFrameGapMs,
      framesDropped: Math.max(0, Math.round(longestFrameGapMs / 16.7) - 1),
      wallMs,
    },
  ];
}

const bench = {
  /** Does this browser actually have a working platform BarcodeDetector? */
  async nativeStatus(): Promise<{ available: boolean; reason?: string }> {
    const scanner = createScanner({ engines: ["native"], worker: false });
    const statuses = await scanner.ready();
    await scanner.dispose();
    return { available: statuses[0]?.available ?? false, reason: statuses[0]?.reason };
  },

  /** Per-category detection for a preset, in a real browser (so `native` counts). */
  async detection(preset: "fast" | "max-accuracy"): Promise<Record<string, { hit: number; total: number; engines: string[] }>> {
    if (preset === "max-accuracy") enableWechat();
    const rows = await manifestPromise;
    const scanner = createScanner({ engines: preset });
    await scanner.ready();
    const out: Record<string, { hit: number; total: number; engines: string[] }> = {};
    for (const row of rows) {
      const bucket = (out[row.category] ??= { hit: 0, total: 0, engines: [] });
      bucket.total++;
      let results: ScanResult[] = [];
      try {
        results = await scanner.scanImage(await frameOf(row));
      } catch {
        /* count as a miss */
      }
      // A wrong decode is a false positive, not a benign miss — same rule as the
      // Node harness.
      const r = results[0];
      if (r && r.value.normalize("NFC").trim() === row.expected.normalize("NFC").trim()) {
        bucket.hit++;
        if (!bucket.engines.includes(r.engine)) bucket.engines.push(r.engine);
      }
    }
    await scanner.dispose();
    return out;
  },

  /**
   * The headline: what an *escalated* decode costs the main thread, with and
   * without the worker transport.
   *
   * Measured on the raw fixture, not a composite. A probe over QR sizes from 32
   * to 256px inside a 720p frame found no size where the fast path misses and
   * WeChat succeeds — native reads a cleanly-rendered small code from ~48px up,
   * and a `downscale_32` source has already lost the information that upscaling
   * would need. So the frames where this tier genuinely earns its keep are the
   * genuinely low-resolution ones, and those are what we time. `transportCost`
   * below covers what a full-size camera frame costs the main thread.
   */
  async blocking(
    category: string,
    useWorker: boolean,
    pad?: Pad,
  ): Promise<BlockingSample & { decoded: boolean }> {
    enableWechat();
    const rows = await manifestPromise;
    const scanner = createScanner({ engines: "max-accuracy", worker: useWorker });
    await scanner.ready();
    await scanner.preload(); // exclude the one-time model load from the sample

    // The strong tier does not read every fixture in a hard category (60% on
    // downscale_32), so pick one it actually decodes — otherwise this times a
    // failed search and reports it as the cost of decoding.
    let frame: ImageData | null = null;
    let decoded = false;
    for (const row of rows.filter((r) => r.category === category)) {
      const candidate = await frameOf(row, pad);
      const hit = await scanner.scanImage(candidate);
      if (hit[0]?.value.normalize("NFC").trim() === row.expected.normalize("NFC").trim()) {
        frame = candidate;
        decoded = true;
        break;
      }
    }
    if (!frame) {
      await scanner.dispose();
      throw new Error(`no ${category} fixture decodes — cannot measure decode cost`);
    }

    const [, sample] = await withBlockingMetrics(async () => {
      for (let i = 0; i < DECODES; i++) await scanner.scanImage(frame);
    });
    await scanner.dispose();
    // `decoded` guards against measuring a cheap early-out instead of a decode.
    return { ...sample, decoded };
  },

  /**
   * Find a frame that is genuinely the case we claim to measure: too small for
   * the fast path, still readable by the strong tier. Used to pick the constant
   * in runner.ts rather than guessing at it.
   */
  async probe(category: string, sizes: number[]): Promise<{ qrPx: number; fast: boolean; max: boolean }[]> {
    enableWechat();
    const rows = await manifestPromise;
    const row = rows.find((r) => r.category === category)!;
    const fast = createScanner({ engines: "fast", worker: false });
    const max = createScanner({ engines: "max-accuracy", worker: false });
    const ok = (rs: ScanResult[]): boolean =>
      rs[0]?.value.normalize("NFC").trim() === row.expected.normalize("NFC").trim();
    const out = [];
    for (const qrPx of sizes) {
      const frame = await frameOf(row, { width: 1280, height: 720, qrPx });
      out.push({ qrPx, fast: ok(await fast.scanImage(frame)), max: ok(await max.scanImage(frame)) });
    }
    await fast.dispose();
    await max.dispose();
    return out;
  },

  /**
   * What a full-size camera frame costs the main thread *per frame*, separate
   * from any decode. With workers the main thread still rasterises the source
   * and creates the transferable bitmap; on a 32x32 fixture that is free and
   * would flatter the design, so measure it at 720p where it is real.
   */
  async transportCost(useWorker: boolean, pad: Pad): Promise<BlockingSample & { decoded: boolean }> {
    const rows = await manifestPromise;
    const row = rows.find((r) => r.category === "clean")!;
    const frame = await frameOf(row, pad);
    const scanner = createScanner({ engines: "fast", worker: useWorker });
    await scanner.ready();
    const warm = await scanner.scanImage(frame);
    const [, sample] = await withBlockingMetrics(async () => {
      for (let i = 0; i < DECODES; i++) await scanner.scanImage(frame);
    });
    await scanner.dispose();
    return { ...sample, decoded: warm.length > 0, wallMs: sample.wallMs / DECODES };
  },

  /** Cold-start cost of bringing the strong tier up, on each transport. */
  async coldStart(useWorker: boolean): Promise<BlockingSample> {
    enableWechat();
    const scanner = createScanner({ engines: "max-accuracy", worker: useWorker });
    const [, sample] = await withBlockingMetrics(async () => {
      await scanner.ready();
      await scanner.preload();
    });
    await scanner.dispose();
    return sample;
  },
};

declare global {
  interface Window {
    bench: typeof bench;
  }
}
window.bench = bench;
