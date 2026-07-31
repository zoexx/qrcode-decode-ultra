import type { BarcodeFormat } from "./formats.js";
import { intersectFormats } from "./formats.js";
import type { Diagnostic, EngineId, FrameImage, Point } from "./types.js";

export interface EngineResult {
  value: string;
  format: BarcodeFormat;
  cornerPoints?: Point[];
}

export interface EngineCapabilities {
  /** Formats this engine can return (post-normalization). */
  formats: ReadonlySet<BarcodeFormat>;
}

/**
 * One decode engine. The worker path and the in-process fallback both drive
 * engines through this single interface, which is why native is "just another
 * engine" and the two transports share `runCascade`.
 */
export interface Engine {
  readonly id: EngineId;
  readonly capabilities: EngineCapabilities;
  /**
   * Cheap availability gate. Native runs its live synthetic-decode probe here;
   * WASM engines report whether they can instantiate. Returning false removes
   * the engine from the cascade without throwing.
   */
  isAvailable(): Promise<boolean>;
  /** Lazy + idempotent. Concurrent calls share one in-flight load. */
  load(): Promise<void>;
  ready(): boolean;
  /**
   * Decode a single normalized frame. MUST return `[]` for "nothing found" and
   * MUST NOT throw on a miss — throwing is reserved for genuine engine failure.
   */
  decode(frame: FrameImage, formats: BarcodeFormat[]): Promise<EngineResult[]>;
  dispose(): void;
}

export interface CascadeOutcome {
  results: EngineResult[];
  engine: EngineId | null;
  /** True if any engine ran `load()` during this cascade pass. */
  coldStart: boolean;
}

/**
 * First-hit-wins cascade. Tries engines in order; skips an engine that can't
 * handle any requested format; returns as soon as one engine decodes something.
 * Engine errors are reported via `onDiagnostic` and treated as a miss, never
 * fatal — the cascade falls through to the next engine.
 */
export async function runCascade(
  engines: readonly Engine[],
  frame: FrameImage,
  requestedFormats: BarcodeFormat[] | undefined,
  onDiagnostic?: (d: Diagnostic) => void,
): Promise<CascadeOutcome> {
  let coldStart = false;

  for (const engine of engines) {
    const formats = intersectFormats(requestedFormats, engine.capabilities.formats);
    if (formats.length === 0) {
      onDiagnostic?.({ engine: engine.id, kind: "skipped", detail: "no requested format supported" });
      continue;
    }

    try {
      if (!(await engine.isAvailable())) {
        onDiagnostic?.({ engine: engine.id, kind: "unavailable" });
        continue;
      }
      if (!engine.ready()) {
        await engine.load();
        coldStart = true;
      }
      const results = await engine.decode(frame, formats);
      if (results.length > 0) {
        return { results, engine: engine.id, coldStart };
      }
    } catch (err) {
      onDiagnostic?.({
        engine: engine.id,
        kind: "engine-error",
        detail: err instanceof Error ? err.message : String(err),
      });
      // fall through to the next engine
    }
  }

  return { results: [], engine: null, coldStart };
}
