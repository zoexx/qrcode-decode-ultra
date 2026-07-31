import { runScan } from "./decode.js";
import type { Engine } from "./engine.js";
import { buildStatuses, createEngines, hasEngine, resolveEngineIds } from "./engines/registry.js";
import type { BarcodeFormat } from "./formats.js";
import { toBitmap, toFrameImage, workerTransportAvailable } from "./normalize.js";
import type {
  Diagnostic,
  EngineId,
  EngineStatus,
  ImageSource,
  ScanController,
  Scanner,
  ScannerOptions,
  ScanResult,
  ScanVideoOptions,
} from "./types.js";
import { WorkerClient } from "./worker/client.js";

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

class QRScanner implements Scanner {
  private readonly engineIds: EngineId[];
  private readonly formats: BarcodeFormat[];
  private readonly maxScansPerSecond: number;
  private readonly lowResPreloadPx: number;
  private readonly useWorker: boolean;
  private readonly wechatRequested: boolean;

  private client: WorkerClient | null = null;
  private engines: Engine[] | null = null;
  /**
   * The in-process WeChat engine, when the `wechat` tier is enabled. In worker
   * mode it runs on the main thread on a fast-path miss (WeChat is never in the
   * worker build); in in-process mode it is also a member of `engines`.
   */
  private wechat: Engine | null = null;
  private wechatPreloadStarted = false;
  private initPromise: Promise<EngineStatus[]> | null = null;
  private disposed = false;

  constructor(options: ScannerOptions = {}) {
    this.engineIds = resolveEngineIds(options.engines);
    this.formats = options.formats ?? ["qr_code"];
    this.maxScansPerSecond = options.maxScansPerSecond ?? 10;
    this.lowResPreloadPx = options.lowResPreloadPx ?? 480;
    this.useWorker = options.worker !== false && workerTransportAvailable();
    this.wechatRequested = this.engineIds.includes("wechat");
  }

  ready(): Promise<EngineStatus[]> {
    return this.ensureInit();
  }

  private ensureInit(): Promise<EngineStatus[]> {
    if (this.disposed) return Promise.reject(new Error("Scanner disposed"));
    if (!this.initPromise) {
      this.initPromise = this.useWorker ? this.initWorker() : this.initInProcess();
    }
    return this.initPromise;
  }

  private async initWorker(): Promise<EngineStatus[]> {
    this.client = new WorkerClient();
    // WeChat is never in the worker build; it runs in-process on a miss.
    const workerIds = this.engineIds.filter((id) => id !== "wechat");
    if (this.wechatRequested && hasEngine("wechat")) {
      this.wechat = createEngines(["wechat"])[0] ?? null;
    }
    const workerStatuses = await this.client.init({ engineIds: workerIds, formats: this.formats });
    return this.mergeWechatStatus(workerStatuses);
  }

  /** Re-assemble statuses in requested order, inserting the in-process WeChat
   * status the worker never sees. */
  private async mergeWechatStatus(workerStatuses: EngineStatus[]): Promise<EngineStatus[]> {
    const byId = new Map<EngineId, EngineStatus>(workerStatuses.map((s) => [s.engine, s]));
    if (this.wechatRequested) {
      if (this.wechat) {
        try {
          const available = await this.wechat.isAvailable();
          byId.set(
            "wechat",
            available ? { engine: "wechat", available } : { engine: "wechat", available, reason: "probe failed" },
          );
        } catch (err) {
          byId.set("wechat", {
            engine: "wechat",
            available: false,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        byId.set("wechat", { engine: "wechat", available: false, reason: "not installed" });
      }
    }
    return this.engineIds.map((id) => byId.get(id) ?? { engine: id, available: false, reason: "not installed" });
  }

  private async initInProcess(): Promise<EngineStatus[]> {
    this.engines = createEngines(this.engineIds);
    this.wechat = this.engines.find((e) => e.id === "wechat") ?? null;
    return buildStatuses(this.engineIds, this.engines);
  }

  async preload(): Promise<void> {
    await this.ensureInit();
    if (this.client) {
      await this.client.preload();
      if (this.wechat && (await this.wechat.isAvailable())) await this.wechat.load();
      return;
    }
    await Promise.all(
      (this.engines ?? []).map(async (e) => {
        if (await e.isAvailable()) await e.load();
      }),
    );
  }

  scanImage(source: ImageSource): Promise<ScanResult[]> {
    return this.decodeSource(source);
  }

  private async decodeSource(
    source: ImageSource,
    onDiagnostic?: (d: Diagnostic) => void,
  ): Promise<ScanResult[]> {
    await this.ensureInit();

    if (this.client) {
      // Worker fast path. When WeChat is enabled we must keep the pixels on the
      // main thread for a possible escalation, so rasterize once here and send a
      // bitmap copy to the worker; otherwise keep the zero-copy transfer.
      if (this.wechat) {
        const frame = await toFrameImage(source);
        const bitmap = await toBitmap(frame);
        const outcome = await this.client.decode(bitmap);
        outcome.diagnostics.forEach((d) => onDiagnostic?.(d));
        if (outcome.results.length > 0) return outcome.results;
        return runScan([this.wechat], frame, this.formats, onDiagnostic);
      }
      const bitmap = await toBitmap(source);
      const outcome = await this.client.decode(bitmap);
      outcome.diagnostics.forEach((d) => onDiagnostic?.(d));
      return outcome.results;
    }

    // In-process: `engines` already includes WeChat when enabled.
    const frame = await toFrameImage(source);
    return runScan(this.engines!, frame, this.formats, onDiagnostic);
  }

  /**
   * Preload-on-low-res: a live frame whose smaller dimension is below the
   * threshold warms the WeChat WASM (idempotent, non-blocking) so the escalation
   * decode doesn't stall on a cold download. Fires at most once per scanner.
   */
  private maybePreloadWechat(width: number, height: number): void {
    if (!this.wechat || this.wechatPreloadStarted || this.lowResPreloadPx <= 0) return;
    const minDim = Math.min(width, height);
    if (minDim <= 0 || minDim >= this.lowResPreloadPx) return;
    this.wechatPreloadStarted = true;
    void (async () => {
      try {
        if (await this.wechat!.isAvailable()) await this.wechat!.load();
      } catch {
        /* best-effort; the cascade will attempt the load again on escalation */
      }
    })();
  }

  scanVideo(video: HTMLVideoElement, options: ScanVideoOptions): ScanController {
    const minInterval = 1000 / this.maxScansPerSecond;
    let running = false;
    let inFlight = false;
    let lastDecode = 0;
    let rafId = 0;

    const schedule = (): void => {
      if (typeof requestAnimationFrame === "function") rafId = requestAnimationFrame(tick);
      else rafId = setTimeout(tick, minInterval) as unknown as number;
    };

    const tick = async (): Promise<void> => {
      if (!running) return;
      // One in-flight decode, throttled; skip-while-busy never queues stale frames.
      if (inFlight || now() - lastDecode < minInterval || video.readyState < 2) {
        schedule();
        return;
      }
      // Cheap low-res check off the video dims; warms WeChat before it's needed.
      this.maybePreloadWechat(video.videoWidth, video.videoHeight);
      inFlight = true;
      lastDecode = now();
      try {
        const results = await this.decodeSource(video, options.onDiagnostic);
        if (results.length > 0 && running) {
          // many-codes-per-frame: deliver all, then the first as the primary.
          options.onResults?.(results);
          options.onResult(results[0]!);
          if (options.once) {
            await controller.stop();
            return;
          }
        }
      } catch (err) {
        options.onError?.({ code: "decode", message: err instanceof Error ? err.message : String(err) });
      } finally {
        inFlight = false;
        if (running) schedule();
      }
    };

    const controller: ScanController = {
      get running() {
        return running;
      },
      async start() {
        if (running) return;
        running = true;
        schedule();
      },
      async stop() {
        running = false;
        if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafId);
        else clearTimeout(rafId);
      },
    };
    return controller;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.client) {
      await this.client.dispose();
      this.client = null;
    }
    for (const e of this.engines ?? []) {
      try {
        e.dispose();
      } catch {
        /* ignore */
      }
    }
    this.engines = null;
    if (this.wechat) {
      try {
        this.wechat.dispose();
      } catch {
        /* ignore */
      }
      this.wechat = null;
    }
  }
}

export function createScanner(options?: ScannerOptions): Scanner {
  return new QRScanner(options);
}
