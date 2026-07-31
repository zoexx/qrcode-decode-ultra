import { registerBuiltins } from "./engines/builtins.js";

// Register the zero-WASM fast path (native + jsQR) for this entry.
registerBuiltins();

export { createScanner } from "./scanner.js";
/** The extension point: `qrcode-decode-ultra-wechat` uses this to add its tier. */
export { registerEngine } from "./engines/registry.js";

export type { BarcodeFormat } from "./formats.js";
export type { Engine, EngineResult, EngineCapabilities } from "./engine.js";
export type {
  EngineId,
  EnginePreset,
  Point,
  FrameImage,
  ImageSource,
  ScanResult,
  ScannerOptions,
  EngineStatus,
  Diagnostic,
  DiagnosticKind,
  ScanError,
  ScanVideoOptions,
  ScanController,
  Scanner,
} from "./types.js";
