/**
 * The single source of truth for main <-> worker messages. Both sides import
 * these types, so the postMessage contract is compile-checked.
 */
import type { BarcodeFormat } from "../formats.js";
import type { Diagnostic, EngineId, EngineStatus, ScanError, ScanResult } from "../types.js";

export type RequestId = number;

export interface WorkerConfig {
  engineIds: EngineId[];
  formats?: BarcodeFormat[];
  maxCodesPerFrame?: number;
}

// --- main -> worker ---------------------------------------------------------

export interface InitRequest {
  type: "init";
  id: RequestId;
  config: WorkerConfig;
}
export interface PreloadRequest {
  type: "preload";
  id: RequestId;
}
/** The `bitmap` is sent in the postMessage transfer list (zero-copy). */
export interface DecodeRequest {
  type: "decode";
  id: RequestId;
  bitmap: ImageBitmap;
}
export interface DisposeRequest {
  type: "dispose";
  id: RequestId;
}

export type MainToWorker = InitRequest | PreloadRequest | DecodeRequest | DisposeRequest;

// --- worker -> main ---------------------------------------------------------

export interface ReadyResponse {
  type: "ready";
  id: RequestId;
  statuses: EngineStatus[];
}
export interface PreloadedResponse {
  type: "preloaded";
  id: RequestId;
}
export interface ResultResponse {
  type: "result";
  id: RequestId;
  /** Every code the winning engine decoded in this frame (many-codes-per-frame). */
  results: ScanResult[];
  diagnostics: Diagnostic[];
}
export interface ErrorResponse {
  type: "error";
  id: RequestId;
  error: ScanError;
}
export interface DisposedResponse {
  type: "disposed";
  id: RequestId;
}

export type WorkerToMain =
  | ReadyResponse
  | PreloadedResponse
  | ResultResponse
  | ErrorResponse
  | DisposedResponse;
