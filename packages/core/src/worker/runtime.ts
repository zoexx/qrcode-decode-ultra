/**
 * `qrcode-decode-ultra/worker-runtime` — the pieces an *optional engine package*
 * needs to ship its own protocol-compatible worker.
 *
 * Deliberately a separate entry from `.`: importing it pulls in the worker
 * server and the registry, but none of the built-in engines, so a tier's worker
 * bundle doesn't carry jsQR it will never run.
 *
 * ```ts
 * // my-tier/src/tier.worker.ts
 * import { registerEngine, serveWorker } from "qrcode-decode-ultra/worker-runtime";
 * registerEngine("wechat", () => new MyEngine());
 * serveWorker();
 * ```
 */
export { serveWorker } from "./serve.js";
export { registerEngine } from "../engines/registry.js";
export type {
  Availability,
  Engine,
  EngineResult,
  EngineCapabilities,
  MultiStrategy,
  Unavailable,
} from "../engine.js";
export type { BarcodeFormat } from "../formats.js";
export type { EngineId, FrameImage, Point, UnavailableCode } from "../types.js";
