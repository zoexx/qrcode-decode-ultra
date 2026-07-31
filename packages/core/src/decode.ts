import type { Engine } from "./engine.js";
import { runCascade } from "./engine.js";
import type { BarcodeFormat } from "./formats.js";
import type { Diagnostic, FrameImage, ScanResult } from "./types.js";

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Run the cascade over one frame and shape the winning engine's hits into
 * `ScanResult`s with timing. Shared by the in-process scanner and the worker so
 * both transports produce an identical result contract.
 */
export async function runScan(
  engines: readonly Engine[],
  frame: FrameImage,
  formats: BarcodeFormat[] | undefined,
  onDiagnostic?: (d: Diagnostic) => void,
): Promise<ScanResult[]> {
  const t0 = now();
  const outcome = await runCascade(engines, frame, formats, onDiagnostic);
  const totalMs = now() - t0;
  if (!outcome.engine) return [];
  const engineId = outcome.engine;
  return outcome.results.map((r) => ({
    value: r.value,
    format: r.format,
    engine: engineId,
    cornerPoints: r.cornerPoints,
    timing: { totalMs, coldStart: outcome.coldStart },
  }));
}
