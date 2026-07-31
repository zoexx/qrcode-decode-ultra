/// <reference lib="webworker" />
import type { Engine } from "../engine.js";
import { registerBuiltins } from "../engines/builtins.js";
import { buildStatuses, createEngines } from "../engines/registry.js";
import { runScan } from "../decode.js";
import type { BarcodeFormat } from "../formats.js";
import type { Diagnostic, EngineId, EngineStatus } from "../types.js";
import type { MainToWorker, WorkerConfig, WorkerToMain } from "./protocol.js";

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

// The worker has its own module graph; register the cascade engines here too.
registerBuiltins();

let engines: Engine[] = [];
let requestedIds: EngineId[] = [];
let formats: BarcodeFormat[] | undefined;
let disposing = false;

function post(message: WorkerToMain): void {
  ctx.postMessage(message);
}

function frameFromBitmap(bitmap: ImageBitmap): ImageData {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const c2d = canvas.getContext("2d", { willReadFrequently: true });
  if (!c2d) throw new Error("OffscreenCanvas 2D context unavailable in worker");
  c2d.drawImage(bitmap, 0, 0);
  return c2d.getImageData(0, 0, bitmap.width, bitmap.height);
}

async function handleInit(config: WorkerConfig): Promise<EngineStatus[]> {
  // The main thread strips `wechat` before init (it runs in-process), so the
  // worker only ever sees the fast-path ids.
  requestedIds = config.engineIds;
  formats = config.formats;
  engines = createEngines(config.engineIds);
  return buildStatuses(requestedIds, engines);
}

ctx.onmessage = async (event: MessageEvent<MainToWorker>) => {
  const msg = event.data;

  if (disposing && msg.type !== "dispose") return;

  switch (msg.type) {
    case "init": {
      try {
        const statuses = await handleInit(msg.config);
        post({ type: "ready", id: msg.id, statuses });
      } catch (err) {
        post({ type: "error", id: msg.id, error: { code: "internal", message: String(err) } });
      }
      return;
    }

    case "preload": {
      try {
        await Promise.all(
          engines.map(async (e) => {
            if (await e.isAvailable()) await e.load();
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
        const results = await runScan(engines, frame, formats, (d) => diagnostics.push(d));
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
