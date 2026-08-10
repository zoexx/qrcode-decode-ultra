import type { BarcodeFormat } from "./formats.js";

/** The bundled engines. One id set, shared by the public API, the worker
 * protocol, and the benchmark drivers. */
export type EngineId = "native" | "jsqr" | "wechat";

export type EnginePreset = "fast" | "max-accuracy";

export interface Point {
  x: number;
  y: number;
}

/**
 * A normalized raster frame. `ImageData` is structurally assignable to this, so
 * a real `ImageData` (from `getImageData`) is a valid `FrameImage`, and tests
 * can build one without the DOM.
 */
export interface FrameImage {
  // ArrayBuffer-backed (not SharedArrayBuffer) so it satisfies the ImageData
  // constructor and a real `ImageData` is structurally a valid FrameImage.
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

/** Anything `scanImage` will normalize to a `FrameImage`. */
export type ImageSource =
  | FrameImage
  | ImageData
  | ImageBitmap
  | Blob
  | HTMLImageElement
  | HTMLCanvasElement
  | HTMLVideoElement
  | OffscreenCanvas;

export interface ScanResult {
  value: string;
  format: BarcodeFormat;
  /** Which engine produced this result. */
  engine: EngineId;
  /** Corner points in source pixels, when the engine provides them. */
  cornerPoints?: Point[];
  timing: {
    totalMs: number;
    /** True if an engine ran `load()` during this scan (first-scan spike). For
     * `wechat` that is the model download; for `native` just detector setup. */
    coldStart: boolean;
  };
}

export interface ScannerOptions {
  /** A preset name or an explicit ordered engine list. Default: "fast". */
  engines?: EnginePreset | EngineId[];
  /** Restrict to these formats (intersected per engine). Default: ["qr_code"]. */
  formats?: BarcodeFormat[];
  /** Run engines in a Web Worker. Default true; false runs in-process. */
  worker?: boolean;
  /** Live-video decode throttle, independent of camera fps. Default 10. */
  maxScansPerSecond?: number;
  /**
   * Let the single-shot engines (`jsqr`, `wechat`) find more than one code in a
   * frame, up to this many. Default 1 — off, because it is not free: `wechat`
   * costs one extra decode per code found, and `jsqr` must scan the frame in
   * overlapping tiles, which costs the same whether the frame holds ten codes or
   * one. Intended for still images; leaving it at 1 keeps live video cheap.
   *
   * `native` is unaffected — it returns every code it sees in a single pass, at
   * no extra cost, so its results are never truncated by this.
   */
  maxCodesPerFrame?: number;
  /**
   * When the WeChat tier is enabled, a live-video frame whose smaller dimension
   * is below this many pixels eagerly (non-blocking) preloads the WeChat WASM,
   * so the escalation decode doesn't stall on a cold 2.5MB download. Default
   * 480; set 0 to disable. No effect unless `wechat` is in the engine list.
   */
  lowResPreloadPx?: number;
  /**
   * Send every frame to **both** workers at once and take the first real decode,
   * instead of only escalating to the strong tier on a fast-path miss. Default
   * false.
   *
   * The default cascade is strictly cheaper: it never wakes the WeChat tier for
   * a frame the fast path already decoded. Racing spends a ~250ms WeChat decode
   * on every frame to buy two things the cascade cannot give you — a decode for
   * a hard code in the time the *fastest* engine takes rather than the sum of
   * the tiers ahead of it, and a per-frame measurement of which tier is actually
   * winning on this device (`onRace`).
   *
   * Requires both workers: the `wechat` tier must be in the engine list, have
   * registered a worker (`enableWechat()`), and the worker transport must be
   * available. Anything less and the scanner silently keeps the sequential
   * cascade — running the strong tier in-process alongside the fast path would
   * be no race at all, just a blocked main thread.
   */
  race?: boolean;
  /**
   * Per-frame race telemetry, for both `scanImage` and `scanVideo`. Fires only
   * while `race` is on, twice per frame when the lanes finish apart (see
   * `RaceReport.complete`).
   */
  onRace?: (report: RaceReport) => void;
}

/**
 * Which worker ran one leg of a raced frame.
 *
 * - `fast` — core's own worker, running the `native → jsqr` cascade.
 * - `strong` — the WeChat tier's own worker.
 */
export type RaceLane = "fast" | "strong";

/**
 * `busy` means the lane was skipped because its worker was still decoding an
 * older frame — the race never queues work behind a slow lane. `pending` only
 * appears in the provisional report, for the lane that had not answered yet
 * when the winner was already known.
 */
export type RaceLegOutcome = "hit" | "miss" | "error" | "busy" | "pending";

export interface RaceLeg {
  lane: RaceLane;
  /** The engines this lane can run, in cascade order. */
  engines: EngineId[];
  outcome: RaceLegOutcome;
  /** Round trip for this lane in ms, measured on the main thread from dispatch
   * to reply. Absent while `pending`, and for a `busy` lane that never ran. */
  ms?: number;
  /** The engine that actually decoded, when `outcome` is `"hit"`. */
  engine?: EngineId;
  /**
   * This lane was still loading its engine when the frame was dispatched, so
   * `ms` is a one-time setup cost (for `wechat`, the 2.5MB model download) with a
   * decode on the end of it — not what this lane costs per frame. Treat a cold
   * leg as unusable for "which tier is faster here".
   */
  cold?: boolean;
  /** Why the lane failed, when `outcome` is `"error"`. */
  detail?: string;
}

/** One frame, sent to both workers at once. See `ScannerOptions.race`. */
export interface RaceReport {
  legs: RaceLeg[];
  /** The lane whose results were returned, or `null` if nothing decoded. */
  winner: RaceLane | null;
  /** Wall clock from dispatch to the moment this report was emitted. */
  totalMs: number;
  /**
   * `false` for the provisional report emitted the instant a winner is known
   * while the other lane is still running; `true` once every leg has landed.
   * A frame therefore reports twice when one lane finishes well after the other
   * — which is the normal case, and the point of measuring.
   */
  complete: boolean;
}

export interface EngineStatus {
  engine: EngineId;
  /** Usable in this environment right now (native passed its probe, WASM can load). */
  available: boolean;
  /** Present when not available, for diagnostics. */
  reason?: string;
}

export type DiagnosticKind = "engine-error" | "unavailable" | "skipped";

export interface Diagnostic {
  engine: EngineId;
  kind: DiagnosticKind;
  detail?: string;
}

export interface ScanError {
  code: "worker-died" | "camera" | "decode" | "internal";
  message: string;
  engine?: EngineId;
}

export interface ScanVideoOptions {
  /** The first/primary code in the frame. Always fires when anything decodes. */
  onResult: (result: ScanResult) => void;
  /**
   * Every code found in the frame (many-codes-per-frame). Fires alongside
   * `onResult` on each successful frame. The `native` tier returns every code
   * present; the pure-JS `jsqr` fallback returns a single code.
   */
  onResults?: (results: ScanResult[]) => void;
  onError?: (error: ScanError) => void;
  onDiagnostic?: (d: Diagnostic) => void;
  /** Stop after the first successful decode. */
  once?: boolean;
}

export interface ScanController {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly running: boolean;
}

export interface Scanner {
  /** Resolve which engines are usable here (runs the native probe). No heavy download. */
  ready(): Promise<EngineStatus[]>;
  /** Eagerly load the engines the cascade will use, so the first scan isn't cold. */
  preload(): Promise<void>;
  /** Decode a still image. Returns every code found in the frame (the `native`
   * tier returns all; the pure-JS `jsqr` fallback returns a single code). */
  scanImage(source: ImageSource): Promise<ScanResult[]>;
  /** Live camera scanning. Results arrive via `options.onResult`. */
  scanVideo(video: HTMLVideoElement, options: ScanVideoOptions): ScanController;
  dispose(): Promise<void>;
}
