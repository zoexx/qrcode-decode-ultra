/**
 * The measurement half of the device report — everything that runs on the
 * device, with no React in it.
 *
 * This exists because the repo's other two benchmark runners structurally
 * cannot see a phone. `benchmark/harness/runner.ts` is Node, so `native` is
 * always `n/a` and every timing is a laptop's. `benchmark/browser/runner.ts` is
 * headless Chromium on a CI box, where `bench.yml` itself notes that `native`
 * reports unavailable on Linux and "the macOS/Android numbers are the real
 * ones" — numbers nothing in the repo produces. This does, by replaying the
 * same committed fixture corpus in the browser the user is actually holding.
 */
import { createScanner, type EngineId, type EngineStatus, type Scanner } from "qrcode-decode-ultra";

/** A row of `benchmark/fixtures/manifest.json`. */
interface ManifestRow {
  image: string;
  expected: string;
  category: string;
}

export interface Environment {
  userAgent: string;
  platform: string;
  screen: string;
  devicePixelRatio: number;
  /** `navigator.hardwareConcurrency` — how many workers the device can truly overlap. */
  cores: number | null;
  /** `navigator.deviceMemory`, in GB. Chromium-only; null on Safari. */
  memoryGb: number | null;
  secureContext: boolean;
  features: Record<string, boolean>;
}

export interface BlockingSample {
  /** Longest single task that occupied the main thread (ms). */
  longestTaskMs: number;
  /** Total time in tasks over 50ms — the browser's own "blocking time". */
  totalBlockingMs: number;
  /** Longest gap between animation frames (ms). 16.7 = nothing lost. */
  longestFrameGapMs: number;
  /** Frames a 60fps camera preview would have missed. */
  framesDropped: number;
  /** Wall-clock for the operation itself. */
  wallMs: number;
  /** Whether the decode actually produced the expected value. */
  decoded: boolean;
  /** False when the browser has no `longtask` observer (all of Safari), in
   * which case the task figures are absent and the frame gap tells the story. */
  longTaskSupported: boolean;
}

export interface CategoryScore {
  hit: number;
  total: number;
}

export interface PresetDetection {
  /** Per-category hit counts, in manifest order. */
  byCategory: Record<string, CategoryScore>;
  /** How many fixtures each tier decoded — the cascade's real shape here. */
  wins: Partial<Record<EngineId, number>>;
  /** Median decode wall-clock per tier, over the fixtures that tier won. */
  medianMs: Partial<Record<EngineId, number>>;
  /** A wrong decode, not just a miss. The repo counts these as failures. */
  falsePositives: number;
}

export interface CameraReport {
  /** What the camera actually gave us, which is rarely what was requested. */
  width: number | null;
  height: number | null;
  frameRate: number | null;
  facingMode: string | null;
  deviceLabel: string;
  /** Number of video inputs the device exposes. */
  videoInputs: number;
  /** Advanced controls, where the browser reports them (Chromium mostly). */
  torch: boolean;
  zoom: boolean;
  focusModes: string[];
}

export interface DeviceReport {
  generatedAt: string;
  env: Environment;
  engines: EngineStatus[];
  /** What the platform detector says it can read, or null when there is none. */
  nativeFormats: string[] | null;
  /** Wall-clock for `preload()` on the max-accuracy cascade — on a phone this
   * is the 2.5MB-gzipped model over a real network, not a warm disk cache. */
  wechatLoadMs: number | null;
  detection: Record<string, PresetDetection> | null;
  blocking: Record<string, BlockingSample> | null;
  camera: CameraReport | null;
  cameraError: string | null;
}

const BASE = import.meta.env.BASE_URL;

/** Decodes per blocking sample; the reported figures span all of them. */
const DECODES = 5;

/** The fixture the fast path genuinely cannot read, so the strong tier runs. */
const ESCALATING_CATEGORY = "downscale_32";

/** A camera-sized frame, so a blocking measurement has real pixels to move. */
const FRAME = { width: 1280, height: 720, qrPx: 320 };

function has(name: string): boolean {
  return typeof (globalThis as Record<string, unknown>)[name] !== "undefined";
}

export function environment(): Environment {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    userAgent: nav.userAgent,
    platform: nav.platform || "unknown",
    screen: `${screen.width}x${screen.height}`,
    devicePixelRatio: window.devicePixelRatio || 1,
    cores: nav.hardwareConcurrency ?? null,
    memoryGb: nav.deviceMemory ?? null,
    secureContext: window.isSecureContext,
    features: {
      WebAssembly: has("WebAssembly"),
      Worker: has("Worker"),
      OffscreenCanvas: has("OffscreenCanvas"),
      createImageBitmap: has("createImageBitmap"),
      BarcodeDetector: has("BarcodeDetector"),
      getUserMedia: !!navigator.mediaDevices?.getUserMedia,
      // Not required by this library (nothing here uses SharedArrayBuffer), but
      // worth recording: it is the usual reason a WASM tier behaves differently
      // across hosts.
      crossOriginIsolated: !!window.crossOriginIsolated,
    },
  };
}

/**
 * What the platform detector claims to support.
 *
 * Deliberately separate from the engine's own probe: `native.isAvailable()`
 * does a real synthetic decode (see `probe-image.ts`) because the constructor
 * existing proves nothing. This records the *claim* so a device where the two
 * disagree — the interesting failure — is visible in the report.
 */
export async function nativeFormats(): Promise<string[] | null> {
  const ctor = (globalThis as { BarcodeDetector?: { getSupportedFormats(): Promise<string[]> } })
    .BarcodeDetector;
  if (!ctor) return null;
  try {
    return await ctor.getSupportedFormats();
  } catch {
    return null;
  }
}

export async function loadManifest(): Promise<ManifestRow[]> {
  const res = await fetch(`${BASE}fixtures/manifest.json`);
  if (!res.ok) throw new Error(`fixtures/manifest.json -> HTTP ${res.status}`);
  return (await res.json()) as ManifestRow[];
}

/** OffscreenCanvas where it exists (Safari only got it in 16.4), DOM canvas otherwise. */
function canvas2d(width: number, height: number): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  if (has("OffscreenCanvas")) {
    const ctx = new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true });
    if (ctx) return ctx;
  }
  const el = document.createElement("canvas");
  el.width = width;
  el.height = height;
  const ctx = el.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d canvas context on this device");
  return ctx;
}

/**
 * Load a fixture as `ImageData`, optionally centred on a camera-sized canvas.
 *
 * Decoded once and handed to every preset, which is the repo's benchmark
 * fairness rule: same pixels to each engine, and a wrong decode is a false
 * positive rather than a benign miss.
 */
async function frameOf(row: ManifestRow, pad?: typeof FRAME): Promise<ImageData> {
  const blob = await (await fetch(BASE + row.image)).blob();
  const bitmap = await createImageBitmap(blob);
  const width = pad?.width ?? bitmap.width;
  const height = pad?.height ?? bitmap.height;
  const qr = pad?.qrPx ?? bitmap.width;
  const ctx = canvas2d(width, height);
  if (pad) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(bitmap, Math.round((width - qr) / 2), Math.round((height - qr) / 2), qr, qr);
  bitmap.close();
  return ctx.getImageData(0, 0, width, height);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Run `op` while watching the main thread. `longtask` is the browser's own
 * definition of "this janked"; the rAF gap is the same story from the animation
 * side, and is the only one of the two that Safari reports.
 */
async function withBlockingMetrics<T>(op: () => Promise<T>): Promise<[T, Omit<BlockingSample, "decoded">]> {
  const tasks: number[] = [];
  let longTaskSupported = true;
  const observer = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) tasks.push(e.duration);
  });
  try {
    observer.observe({ entryTypes: ["longtask"] });
  } catch {
    longTaskSupported = false;
  }

  const gaps: number[] = [];
  let last = performance.now();
  let raf = requestAnimationFrame(function tick() {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
    raf = requestAnimationFrame(tick);
  });

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
      longTaskSupported,
    },
  ];
}

/** Registers the WeChat tier. Idempotent, and only ever fetched on this path. */
async function enableWechat(): Promise<void> {
  const mod = await import("qrcode-decode-ultra-wechat");
  mod.enableWechat();
}

export interface Progress {
  (done: number, total: number, label: string): void;
}

/**
 * Replay the whole fixture corpus through both presets.
 *
 * One scanner per preset, reused across fixtures — building one per image would
 * spawn a worker pair per decode and measure teardown instead of decoding.
 */
export async function runDetection(
  rows: ManifestRow[],
  onProgress: Progress,
): Promise<{ detection: Record<string, PresetDetection>; wechatLoadMs: number | null }> {
  await enableWechat();

  const presets = ["fast", "max-accuracy"] as const;
  const detection: Record<string, PresetDetection> = {};
  let wechatLoadMs: number | null = null;

  // Decode every fixture once, up front, and hand the same ImageData to both
  // presets — the fairness rule, and it keeps PNG decoding out of the timings.
  const frames: { row: ManifestRow; frame: ImageData }[] = [];
  for (const [i, row] of rows.entries()) {
    onProgress(i, rows.length, `loading ${row.category}`);
    frames.push({ row, frame: await frameOf(row) });
  }

  for (const preset of presets) {
    const scanner: Scanner = createScanner({ engines: preset });
    try {
      // Warm the tier before timing anything, and record what that cost — on a
      // phone this is the real download, which belongs in the report as its own
      // number rather than smeared into the first decode.
      const t0 = performance.now();
      await scanner.preload();
      if (preset === "max-accuracy") wechatLoadMs = performance.now() - t0;

      const score: PresetDetection = { byCategory: {}, wins: {}, medianMs: {}, falsePositives: 0 };
      const times: Partial<Record<EngineId, number[]>> = {};

      for (const [i, { row, frame }] of frames.entries()) {
        onProgress(i, frames.length, `${preset} · ${row.category}`);
        const cat = (score.byCategory[row.category] ??= { hit: 0, total: 0 });
        cat.total++;

        let results;
        try {
          results = await scanner.scanImage(frame);
        } catch {
          continue;
        }

        const hit = results.find((r) => r.value === row.expected);
        if (hit) {
          cat.hit++;
          score.wins[hit.engine] = (score.wins[hit.engine] ?? 0) + 1;
          (times[hit.engine] ??= []).push(hit.timing.totalMs);
        } else if (results.length) {
          // Decoded something, but not the right thing.
          score.falsePositives++;
        }

        // Yield to the event loop so the progress bar can actually paint —
        // otherwise the page looks frozen for the length of the whole sweep.
        await new Promise((r) => setTimeout(r, 0));
      }

      for (const [engine, ms] of Object.entries(times)) {
        score.medianMs[engine as EngineId] = median(ms as number[]);
      }
      detection[preset] = score;
    } finally {
      await scanner.dispose();
    }
  }

  return { detection, wechatLoadMs };
}

/**
 * What an escalated decode costs the main thread, with and without the worker.
 *
 * This is the measurement that justifies the project's hardest rule — never put
 * a WeChat decode on the main thread. On a laptop that rule is backed by a
 * ~250-325ms figure; the whole question this page exists to answer is what the
 * same decode costs on a mid-range phone.
 */
export async function runBlocking(rows: ManifestRow[], onProgress: Progress): Promise<Record<string, BlockingSample>> {
  await enableWechat();

  const row = rows.find((r) => r.category === ESCALATING_CATEGORY);
  if (!row) throw new Error(`no ${ESCALATING_CATEGORY} fixture in the manifest`);
  const frame = await frameOf(row, FRAME);

  const out: Record<string, BlockingSample> = {};
  for (const useWorker of [true, false]) {
    const label = useWorker ? "worker (default)" : "main thread";
    onProgress(useWorker ? 0 : 1, 2, label);
    const scanner = createScanner({ engines: "max-accuracy", worker: useWorker });
    try {
      await scanner.preload();
      let decoded = false;
      const [, sample] = await withBlockingMetrics(async () => {
        for (let i = 0; i < DECODES; i++) {
          const results = await scanner.scanImage(frame);
          decoded = results.some((r) => r.value === row.expected);
        }
      });
      out[label] = { ...sample, decoded, wallMs: sample.wallMs / DECODES };
    } finally {
      await scanner.dispose();
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}

/**
 * What the rear camera actually provides — which is rarely what was asked for,
 * and is the input the whole cascade is fed on a real device.
 */
export async function probeCamera(): Promise<CameraReport> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  });
  try {
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error("getUserMedia returned a stream with no video track");
    const settings = track.getSettings();
    // getCapabilities is Chromium-only; Safari has no such method.
    const caps: MediaTrackCapabilities & { torch?: boolean; zoom?: unknown; focusMode?: string[] } =
      typeof track.getCapabilities === "function" ? track.getCapabilities() : {};
    // Labels are only populated once permission has been granted, so enumerate
    // after getUserMedia rather than before.
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      width: settings.width ?? null,
      height: settings.height ?? null,
      frameRate: settings.frameRate ? Math.round(settings.frameRate) : null,
      facingMode: settings.facingMode ?? null,
      deviceLabel: track.label || "unnamed",
      videoInputs: devices.filter((d) => d.kind === "videoinput").length,
      torch: !!caps.torch,
      zoom: !!caps.zoom,
      focusModes: caps.focusMode ?? [],
    };
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}

function pct(hit: number, total: number): string {
  return total ? `${Math.round((hit / total) * 100)}%` : "—";
}

/** The report as a markdown block, for pasting into an issue or the README. */
export function toMarkdown(r: DeviceReport): string {
  const L: string[] = [];
  L.push(`## qrcode-decode-ultra device report`, "");
  L.push(`_Generated ${r.generatedAt}_`, "");

  L.push(`| Device | |`, `|---|---|`);
  L.push(`| user agent | \`${r.env.userAgent}\` |`);
  L.push(`| platform | ${r.env.platform} |`);
  L.push(`| screen | ${r.env.screen} @ ${r.env.devicePixelRatio}x |`);
  L.push(`| cores | ${r.env.cores ?? "unknown"} |`);
  L.push(`| memory | ${r.env.memoryGb ? `${r.env.memoryGb} GB` : "unreported"} |`);
  L.push(`| secure context | ${r.env.secureContext ? "yes" : "no"} |`);
  const off = Object.entries(r.env.features).filter(([, v]) => !v).map(([k]) => k);
  L.push(`| missing features | ${off.length ? off.join(", ") : "none"} |`);
  L.push("");

  L.push(`**Engines**`, "");
  L.push(`| Engine | Available | Reason |`, `|---|---|---|`);
  for (const e of r.engines) {
    L.push(`| \`${e.engine}\` | ${e.available ? "yes" : "no"} | ${e.reason ?? ""} |`);
  }
  L.push("");
  L.push(
    `Platform \`BarcodeDetector\` reports: ${
      r.nativeFormats ? (r.nativeFormats.length ? r.nativeFormats.map((f) => `\`${f}\``).join(", ") : "no formats") : "not present"
    }`,
    "",
  );
  if (r.wechatLoadMs != null) {
    L.push(`WeChat tier load (fetch + instantiate): **${Math.round(r.wechatLoadMs)} ms**`, "");
  }

  if (r.detection) {
    const cats = Object.keys(Object.values(r.detection)[0]?.byCategory ?? {});
    L.push(`**Detection rate by category**`, "");
    L.push(`| Preset | ${cats.join(" | ")} | Overall |`);
    L.push(`|---|${cats.map(() => "---").join("|")}|---|`);
    for (const [preset, score] of Object.entries(r.detection)) {
      let hit = 0;
      let total = 0;
      const cells = cats.map((c) => {
        const s = score.byCategory[c] ?? { hit: 0, total: 0 };
        hit += s.hit;
        total += s.total;
        return `${s.hit}/${s.total}`;
      });
      L.push(`| ${preset} | ${cells.join(" | ")} | ${pct(hit, total)} |`);
    }
    L.push("");

    L.push(`**Which tier won, and how fast** (median ms over the fixtures it decoded)`, "");
    L.push(`| Preset | Tier | Fixtures won | Median |`, `|---|---|---|---|`);
    for (const [preset, score] of Object.entries(r.detection)) {
      for (const [engine, wins] of Object.entries(score.wins)) {
        const ms = score.medianMs[engine as EngineId];
        L.push(`| ${preset} | \`${engine}\` | ${wins} | ${ms != null ? `${ms.toFixed(1)} ms` : "—"} |`);
      }
      if (score.falsePositives) L.push(`| ${preset} | **false positives** | ${score.falsePositives} | |`);
    }
    L.push("");
  }

  if (r.blocking) {
    L.push(
      `**Main-thread cost of an escalated decode** — a \`${ESCALATING_CATEGORY}\` fixture composited into a ${FRAME.width}x${FRAME.height} frame, ${DECODES} consecutive decodes, model already loaded.`,
      "",
    );
    L.push(`| Transport | per decode | longest task | total blocking | longest frame gap | frames dropped |`);
    L.push(`|---|---|---|---|---|---|`);
    for (const [name, s] of Object.entries(r.blocking)) {
      const task = s.longTaskSupported ? `${s.longestTaskMs.toFixed(0)} ms` : "n/a";
      const blocking = s.longTaskSupported ? `${s.totalBlockingMs.toFixed(0)} ms` : "n/a";
      L.push(
        `| ${name} | ${s.wallMs.toFixed(0)} ms | ${task} | ${blocking} | ${s.longestFrameGapMs.toFixed(0)} ms | ${s.framesDropped} |`,
      );
    }
    if (Object.values(r.blocking).some((s) => !s.longTaskSupported)) {
      L.push("", "> `n/a` where the browser has no `longtask` observer (Safari). The frame gap is the measurement that survives.");
    }
    L.push("");
  }

  if (r.camera) {
    const c = r.camera;
    L.push(`**Rear camera**`, "");
    L.push(`| | |`, `|---|---|`);
    L.push(`| resolution | ${c.width ?? "?"}x${c.height ?? "?"} |`);
    L.push(`| frame rate | ${c.frameRate ?? "?"} fps |`);
    L.push(`| facing mode | ${c.facingMode ?? "unreported"} |`);
    L.push(`| label | ${c.deviceLabel} |`);
    L.push(`| video inputs | ${c.videoInputs} |`);
    L.push(`| torch / zoom | ${c.torch ? "torch" : "no torch"} · ${c.zoom ? "zoom" : "no zoom"} |`);
    L.push(`| focus modes | ${c.focusModes.length ? c.focusModes.join(", ") : "unreported"} |`);
    L.push("");
  } else if (r.cameraError) {
    L.push(`**Rear camera**: not probed — ${r.cameraError}`, "");
  }

  return L.join("\n");
}
