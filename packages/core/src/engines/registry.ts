import type { Engine } from "../engine.js";
import type { EngineId, EnginePreset, EngineStatus } from "../types.js";

export type EngineFactory = () => Engine;

/**
 * Engine factory registry. Deliberately holds NO static engine imports — each
 * entry point registers the engines it wants:
 *   - index.ts  registers native + jsqr (the zero-WASM fast path)
 *   - qrcode-decode-ultra-wechat registers "wechat" when the consumer calls
 *     enableWechat()
 * This keeps the heavy WeChat tier out of bundles that don't ask for it.
 */
const FACTORIES = new Map<EngineId, EngineFactory>();

export function registerEngine(id: EngineId, factory: EngineFactory): void {
  FACTORIES.set(id, factory);
}

export function hasEngine(id: EngineId): boolean {
  return FACTORIES.has(id);
}

/** Spawns a worker that serves this engine over the standard worker protocol. */
export type EngineWorkerFactory = () => Worker;

/**
 * Worker factories for optional tiers that ship their own worker chunk. Core's
 * own worker build can only contain engines core statically imports, so a heavy
 * tier in a separate package registers its worker here instead — and the
 * scanner drives it as a second worker rather than running it in-process.
 * Registering one is optional: without it the tier falls back to the main thread.
 */
const WORKER_FACTORIES = new Map<EngineId, EngineWorkerFactory>();

export function registerEngineWorker(id: EngineId, factory: EngineWorkerFactory): void {
  WORKER_FACTORIES.set(id, factory);
}

export function getEngineWorkerFactory(id: EngineId): EngineWorkerFactory | undefined {
  return WORKER_FACTORIES.get(id);
}

export const PRESETS: Record<EnginePreset, EngineId[]> = {
  fast: ["native", "jsqr"],
  "max-accuracy": ["native", "jsqr", "wechat"],
};

const PRESET_NAMES = new Set<string>(Object.keys(PRESETS));

export function resolveEngineIds(engines: EnginePreset | EngineId[] | undefined): EngineId[] {
  if (!engines) return PRESETS.fast;
  if (typeof engines === "string") {
    if (PRESET_NAMES.has(engines)) return PRESETS[engines];
    throw new Error(`Unknown engine preset: ${engines}`);
  }
  return engines;
}

/** Instantiate the registered engines for `ids`, in order. Ids with no
 * registered factory are simply absent from the result — callers report them as
 * an unavailable `EngineStatus` rather than failing. */
export function createEngines(ids: readonly EngineId[]): Engine[] {
  const engines: Engine[] = [];
  for (const id of ids) {
    const factory = FACTORIES.get(id);
    if (factory) engines.push(factory());
  }
  return engines;
}

/**
 * Resolve `EngineStatus[]` for the requested ids, probing each built engine.
 * Shared by the in-process scanner and the worker so both transports report
 * availability identically.
 */
export async function buildStatuses(
  requestedIds: readonly EngineId[],
  engines: readonly Engine[],
): Promise<EngineStatus[]> {
  const byId = new Map(engines.map((e) => [e.id, e]));
  const statuses: EngineStatus[] = [];
  for (const id of requestedIds) {
    const engine = byId.get(id);
    if (!engine) {
      statuses.push({ engine: id, available: false, reason: "not installed" });
      continue;
    }
    try {
      const available = await engine.isAvailable();
      statuses.push(available ? { engine: id, available } : { engine: id, available, reason: "probe failed" });
    } catch (err) {
      statuses.push({ engine: id, available: false, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return statuses;
}
