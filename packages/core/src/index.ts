import { registerBuiltins } from "./engines/builtins.js";

// Register the zero-WASM fast path (native + jsQR) for this entry.
registerBuiltins();

export { createScanner } from "./scanner.js";
/** The extension points: `qrcode-decode-ultra-wechat` uses these to add its
 * tier, and optionally the worker that keeps the tier off the main thread. */
export { registerEngine, registerEngineWorker } from "./engines/registry.js";
export type { EngineWorkerFactory } from "./engines/registry.js";

export type { BarcodeFormat } from "./formats.js";
export type { Engine, EngineResult, EngineCapabilities, MultiStrategy } from "./engine.js";
export type {
  EngineId,
  EnginePreset,
  Point,
  FrameImage,
  ImageSource,
  ScanResult,
  ScannerOptions,
  RaceLane,
  RaceLegOutcome,
  RaceLeg,
  RaceReport,
  EngineStatus,
  Diagnostic,
  DiagnosticKind,
  ScanError,
  ScanVideoOptions,
  ScanController,
  Scanner,
} from "./types.js";
