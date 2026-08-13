/// <reference lib="webworker" />
import type { Engine } from "../engine.js";
import { engineUsable } from "../engine.js";
import { buildStatuses, createEngines } from "../engines/registry.js";
import { runScan } from "../decode.js";
import type { BarcodeFormat } from "../formats.js";
import type { Diagnostic, EngineId, EngineStatus } from "../types.js";
import type { MainToWorker, WorkerConfig, WorkerToMain } from "./protocol.js";

function frameFromBitmap(bitmap: ImageBitmap): ImageData {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const c2d = canvas.getContext("2d", { willReadFrequently: true });
  if (!c2d) throw new Error("OffscreenCanvas 2D context unavailable in worker");
  c2d.drawImage(bitmap, 0, 0);
  return c2d.getImageData(0, 0, bitmap.width, bitmap.height);
}

/**
 * Install the worker-side half of the protocol on this worker's global scope.
 *
 * The loop is engine-agnostic: it builds whatever ids the `init` message asks
 * for out of *this module graph's* registry. That is what lets a second worker
 * — shipped by `qrcode-decode-ultra-wechat`, which registers only `wechat` —
 * reuse this exact server without core ever importing the optional package.
 *
 * Call it once, after registering the engines this worker should serve.
 */
export function serveWorker(): void {
  const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

  let engines: Engine[] = [];
  let requestedIds: EngineId[] = [];
  let formats: BarcodeFormat[] | undefined;
  let maxCodes = 1;
  let disposing = false;

  const post = (message: WorkerToMain): void => ctx.postMessage(message);

  const handleInit = async (config: WorkerConfig): Promise<EngineStatus[]> => {
    requestedIds = config.engineIds;
    formats = config.formats;
    maxCodes = config.maxCodesPerFrame ?? 1;
    engines = createEngines(config.engineIds);
    return buildStatuses(requestedIds, engines);
  };

  ctx.onmessage = async (event: MessageEvent<MainToWorker>) => {
    const msg = event.data;

    if (disposing && msg.type !== "dispose") return;

    switch (msg.type) {
      case "init": {
        try {
          post({ type: "ready", id: msg.id, statuses: await handleInit(msg.config) });
        } catch (err) {
          post({ type: "error", id: msg.id, error: { code: "internal", message: String(err) } });
        }
        return;
      }

      case "preload": {
        try {
          await Promise.all(
            engines.map(async (e) => {
              if (await engineUsable(e)) await e.load();
            }),
          );
          post({ type: "preloaded", id: msg.id });
        } catch (err) {
          post({ type: "error", id: msg.id, error: { code: "internal", message: String(err) } });
        }
        return;
      }

      case "decode": {
        const diagnostics: Diagnostic[] = [];
        try {
          const frame = frameFromBitmap(msg.bitmap);
          const results = await runScan(engines, frame, formats, (d) => diagnostics.push(d), maxCodes);
          post({ type: "result", id: msg.id, results, diagnostics });
        } catch (err) {
          post({ type: "error", id: msg.id, error: { code: "decode", message: String(err) } });
        } finally {
          msg.bitmap.close();
        }
        return;
      }

      case "dispose": {
        disposing = true;
        for (const e of engines) {
          try {
            e.dispose();
          } catch {
            /* ignore */
          }
        }
        engines = [];
        post({ type: "disposed", id: msg.id });
        return;
      }
    }
  };
}
