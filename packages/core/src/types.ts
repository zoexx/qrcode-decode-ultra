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
