import type { BarcodeFormat } from "./formats.js";
import { intersectFormats } from "./formats.js";
import { decodeUpTo, type MultiStrategy } from "./multi.js";
import type { Diagnostic, EngineId, FrameImage, Point, UnavailableCode } from "./types.js";

export interface EngineResult {
  value: string;
  format: BarcodeFormat;
  cornerPoints?: Point[];
}

export interface EngineCapabilities {
  /** Formats this engine can return (post-normalization). */
  formats: ReadonlySet<BarcodeFormat>;
  /** How this engine can yield more than one code per frame. See `MultiStrategy`. */
  multi: MultiStrategy;
}

/** An engine that cannot run here, and why. */
export interface Unavailable {
  available: false;
  code: UnavailableCode;
  /** Overrides the default text for `code`. Use for anything code alone can't say. */
  detail?: string;
}

/**
 * What `isAvailable()` resolves to.
 *
 * A bare boolean is still valid, so an engine with nothing to explain — `jsqr`
 * is always available — just returns `true`. Returning `Unavailable` instead of
 * `false` is how an engine says *why*, which is the difference between "this
 * browser never had the API" and "the API is here and broken".
 */
export type Availability = boolean | Unavailable;

/** Collapse either form to a single shape. */
export function normalizeAvailability(a: Availability): { available: boolean; code?: UnavailableCode; detail?: string } {
  if (typeof a === "boolean") {
    // A bare `false` cannot say more than this.
    return a ? { available: true } : { available: false, code: "probe-failed" };
  }
  return { available: false, code: a.code, detail: a.detail };
}

/** Default human-readable text per cause. `detail` overrides it when present. */
const REASON: Record<UnavailableCode, string> = {
  "not-installed": "not installed — no engine is registered for this id",
  "no-api": "not implemented in this browser",
  "not-native": "shadowed by a non-native polyfill",
  "format-unsupported": "present, but does not support the probed format",
  "probe-failed": "present, but decoded the probe frame incorrectly",
  "worker-failed": "its worker could not be started",
  error: "availability check threw",
};

export function reasonText(code: UnavailableCode, detail?: string): string {
  return detail ?? REASON[code];
}

/**
 * Can this engine actually run? Always use this instead of
 * `if (await engine.isAvailable())` — an `Unavailable` object is itself truthy,
 * so the bare check silently passes exactly the engines it should reject.
 */
export async function engineUsable(engine: Engine): Promise<boolean> {
  return normalizeAvailability(await engine.isAvailable()).available;
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
   * WASM engines report whether they can instantiate. Anything other than
   * `true` removes the engine from the cascade without throwing — return an
   * `Unavailable` rather than a bare `false` so the reason survives to
   * `EngineStatus`.
   */
  isAvailable(): Promise<Availability>;
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
  maxCodes = 1,
): Promise<CascadeOutcome> {
  let coldStart = false;

  for (const engine of engines) {
    const formats = intersectFormats(requestedFormats, engine.capabilities.formats);
    if (formats.length === 0) {
      onDiagnostic?.({ engine: engine.id, kind: "skipped", detail: "no requested format supported" });
      continue;
    }

    try {
      const availability = normalizeAvailability(await engine.isAvailable());
      if (!availability.available) {
        onDiagnostic?.({
          engine: engine.id,
          kind: "unavailable",
          detail: availability.code ? reasonText(availability.code, availability.detail) : undefined,
        });
        continue;
      }
      if (!engine.ready()) {
        await engine.load();
        coldStart = true;
      }
      const results = await decodeUpTo(engine, frame, formats, maxCodes);
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

export type { MultiStrategy } from "./multi.js";
