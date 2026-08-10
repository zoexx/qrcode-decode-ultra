import { runScan } from "./decode.js";
import type { Engine } from "./engine.js";
import {
  buildStatuses,
  createEngines,
  getEngineWorkerFactory,
  hasEngine,
  resolveEngineIds,
} from "./engines/registry.js";
import type { BarcodeFormat } from "./formats.js";
import { toBitmap, toFrameImage, workerTransportAvailable } from "./normalize.js";
import type {
  Diagnostic,
  EngineId,
  FrameImage,
  ScanError,
  EngineStatus,
  ImageSource,
  RaceLane,
  RaceLeg,
  RaceReport,
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

/**
 * `WorkerClient` rejects with an already-shaped `ScanError` (a plain object, not
 * an `Error`), so `String(err)` would hand the consumer "[object Object]" and
 * throw away the `code`. Forward those verbatim; wrap anything else.
 */
function toScanError(err: unknown, fallback: ScanError["code"]): ScanError {
  if (typeof err === "object" && err !== null && "code" in err && "message" in err) {
    return err as ScanError;
  }
  return { code: fallback, message: err instanceof Error ? err.message : String(err) };
}

class QRScanner implements Scanner {
  private readonly engineIds: EngineId[];
  private readonly formats: BarcodeFormat[];
  private readonly maxScansPerSecond: number;
  private readonly maxCodesPerFrame: number;
  private readonly lowResPreloadPx: number;
  private readonly useWorker: boolean;
  private readonly wechatRequested: boolean;
  private readonly raceRequested: boolean;
  private readonly onRace?: (report: RaceReport) => void;

  private client: WorkerClient | null = null;
  private engines: Engine[] | null = null;
  /**
   * The WeChat tier's own worker, when its package registered one. Preferred
   * over `wechat` below: a WeChat decode costs ~200ms+, which is a visible
   * freeze if it lands on the main thread during live video.
   */
  private wechatClient: WorkerClient | null = null;
  /**
   * The in-process WeChat engine — used when the tier registered no worker, or
   * when the worker transport is unavailable. In in-process mode it is also a
   * member of `engines`.
   */
  private wechat: Engine | null = null;
  private wechatPreloadStarted = false;
  /**
   * Non-null while the strong tier is still loading. A frame dispatched during
   * that window pays the load as part of its round trip, so the race reports the
   * leg as `cold` rather than passing a 20-second model download off as a decode
   * time. The lane still runs — losing a decode to keep a number tidy would be
   * the wrong trade.
   */
  private warmingStrong: Promise<void> | null = null;
  private initPromise: Promise<EngineStatus[]> | null = null;
  private disposed = false;

  constructor(options: ScannerOptions = {}) {
    this.engineIds = resolveEngineIds(options.engines);
    this.formats = options.formats ?? ["qr_code"];
    this.maxScansPerSecond = options.maxScansPerSecond ?? 10;
    this.maxCodesPerFrame = Math.max(1, Math.floor(options.maxCodesPerFrame ?? 1));
    this.lowResPreloadPx = options.lowResPreloadPx ?? 480;
    this.useWorker = options.worker !== false && workerTransportAvailable();
    this.wechatRequested = this.engineIds.includes("wechat");
    this.raceRequested = options.race === true;
    this.onRace = options.onRace;
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
    // Core's worker build never contains `wechat`; strip it and serve the tier
    // from its own worker (preferred) or, failing that, in-process.
    const workerIds = this.engineIds.filter((id) => id !== "wechat");
    // Post the fast path's init immediately. It must never wait on the optional
    // tier: booting the WeChat worker means fetching megabytes of WASM, and
    // native+jsqr needs none of it to start decoding.
    const fastStatuses = this.client.init({
      engineIds: workerIds,
      formats: this.formats,
      maxCodesPerFrame: this.maxCodesPerFrame,
    });
    const wechatStatus = this.wechatRequested ? await this.initWechatTier() : null;
    // Racing runs the strong tier from the very first frame, so there is no
    // "escalation moment" left to preload against — warm it now instead.
    if (this.raceRequested) this.warmStrongTier();
    return this.mergeWechatStatus(await fastStatuses, wechatStatus);
  }

  /**
   * Bring up the strong tier, preferring its own worker. Every failure here is
   * contained: the tier is optional, so it must never take down a healthy fast
   * path. `new Worker(...)` alone can throw synchronously on a CSP `worker-src`
   * denial, a cross-origin URL, or a bundler that never emitted the chunk.
   */
  private async initWechatTier(): Promise<EngineStatus> {
    const spawn = getEngineWorkerFactory("wechat");
    if (spawn) {
      try {
        this.wechatClient = new WorkerClient(spawn);
        const statuses = await this.wechatClient.init({
          engineIds: ["wechat"],
          formats: this.formats,
          maxCodesPerFrame: this.maxCodesPerFrame,
        });
        const status = statuses[0] ?? { engine: "wechat" as const, available: false, reason: "not installed" };
        if (status.available) return status;
        // Came up but cannot decode here — drop it rather than pay a round trip
        // per frame for a guaranteed miss.
        await this.wechatClient.dispose().catch(() => undefined);
        this.wechatClient = null;
        return status;
      } catch (err) {
        await this.wechatClient?.dispose().catch(() => undefined);
        this.wechatClient = null;
        const reason = `worker failed: ${err instanceof Error ? err.message : String(err)}`;
        // Fall back to the main thread rather than losing the tier entirely.
        if (hasEngine("wechat")) {
          this.wechat = createEngines(["wechat"])[0] ?? null;
          const status = await this.probeInProcessWechat();
          return status.available ? { ...status, reason } : status;
        }
        return { engine: "wechat", available: false, reason };
      }
    }
    if (hasEngine("wechat")) {
      this.wechat = createEngines(["wechat"])[0] ?? null;
      return this.probeInProcessWechat();
    }
    return { engine: "wechat", available: false, reason: "not installed" };
  }

  private async probeInProcessWechat(): Promise<EngineStatus> {
    if (!this.wechat) return { engine: "wechat", available: false, reason: "not installed" };
    try {
      const available = await this.wechat.isAvailable();
      return available ? { engine: "wechat", available } : { engine: "wechat", available, reason: "probe failed" };
    } catch (err) {
      return { engine: "wechat", available: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Re-assemble statuses in requested order, inserting the WeChat status the
   * fast-path worker never sees. */
  private mergeWechatStatus(
    workerStatuses: EngineStatus[],
    wechatStatus: EngineStatus | null,
  ): EngineStatus[] {
    const byId = new Map<EngineId, EngineStatus>(workerStatuses.map((s) => [s.engine, s]));
    if (wechatStatus) byId.set("wechat", wechatStatus);
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
      await Promise.all([this.client.preload(), this.wechatClient?.preload()]);
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
      // Both tiers need the *same* pixels, and a live <video> moves between
      // grabs, so when an escalation is possible we rasterize once here and
      // derive each worker's bitmap from that one frame. With no escalation
      // configured, keep the zero-copy path straight from the source.
      const escalates = this.wechatClient !== null || this.wechat !== null;
      const frame = escalates ? await toFrameImage(source) : null;

      // Race mode needs two live workers; with only an in-process strong tier
      // there is nothing to race against, so fall through to the cascade.
      if (frame && this.raceRequested && this.wechatClient) {
        return this.decodeRaced(this.client, this.wechatClient, frame, onDiagnostic);
      }

      const bitmap = await toBitmap(frame ?? source);
      if (this.disposed) return [];
      const outcome = await this.client.decode(bitmap);
      outcome.diagnostics.forEach((d) => onDiagnostic?.(d));
      if (outcome.results.length > 0) return outcome.results;

      // Fast-path miss: escalate to the strong tier, in its own worker when it
      // shipped one (a WeChat decode is ~250ms+ and would freeze the UI here).
      if (this.wechatClient) {
        try {
          const esc = await this.wechatClient.decode(await toBitmap(frame!));
          esc.diagnostics.forEach((d) => onDiagnostic?.(d));
          return esc.results;
        } catch (err) {
          // The optional tier died (OOM on a 6MB WASM heap is the realistic
          // case). Drop it and keep scanning on the healthy fast path rather
          // than failing every subsequent frame.
          this.wechatClient = null;
          onDiagnostic?.({
            engine: "wechat",
            kind: "engine-error",
            detail: toScanError(err, "decode").message,
          });
          return outcome.results;
        }
      }
      if (this.wechat) {
        return runScan([this.wechat], frame!, this.formats, onDiagnostic);
      }
      return outcome.results;
    }

    // In-process: `engines` already includes WeChat when enabled.
    const frame = await toFrameImage(source);
    return runScan(this.engines!, frame, this.formats, onDiagnostic, this.maxCodesPerFrame);
  }

  /**
   * Both workers, one frame, first real decode wins.
   *
   * The two lanes are nowhere near each other in cost — the fast path answers in
   * single-digit milliseconds, WeChat in ~250ms — so "await both" would hand
   * every frame back at the slow lane's speed and make racing strictly worse
   * than the cascade. Instead the caller gets the first hit and the straggler is
   * left running only to be measured: it reports through `onRace` a second time
   * when it lands, and its worker is skipped — never queued behind — on any
   * frame that starts while it is still busy.
   *
   * Late results are telemetry only. A code the slow lane finds after the fast
   * lane already returned belongs to a frame the caller has moved on from, and
   * delivering it would surface a decode of pixels no longer on screen.
   */
  private async decodeRaced(
    fast: WorkerClient,
    strong: WorkerClient,
    frame: FrameImage,
    onDiagnostic?: (d: Diagnostic) => void,
  ): Promise<ScanResult[]> {
    const t0 = now();
    const fastEngines = this.engineIds.filter((id) => id !== "wechat");
    const legs = new Map<RaceLane, RaceLeg>([
      ["fast", { lane: "fast", engines: fastEngines, outcome: "pending" }],
      ["strong", { lane: "strong", engines: ["wechat"], outcome: "pending" }],
    ]);
    let winner: RaceLane | null = null;
    const emit = (complete: boolean): void => {
      if (this.disposed) return;
      this.onRace?.({ legs: [...legs.values()], winner, totalMs: now() - t0, complete });
    };

    // A dead fast path still has to reach the caller as an error — but only if
    // the strong lane didn't rescue this frame.
    let fastError: unknown = null;

    type LaneResult = { lane: RaceLane; results: ScanResult[] };

    const runLane = async (
      lane: RaceLane,
      client: WorkerClient,
      engines: EngineId[],
      cold: boolean,
    ): Promise<LaneResult> => {
      const started = now();
      try {
        // Each lane rasterizes its own bitmap from the one frame: the transport
        // transfers a bitmap and closes it on the far side, so the lanes cannot
        // share one — but they do share the pixels, which is what makes the two
        // times comparable at all.
        const outcome = await client.decode(await toBitmap(frame));
        outcome.diagnostics.forEach((d) => onDiagnostic?.(d));
        legs.set(lane, {
          lane,
          engines,
          outcome: outcome.results.length > 0 ? "hit" : "miss",
          ms: now() - started,
          engine: outcome.results[0]?.engine,
          cold: cold || undefined,
        });
        return { lane, results: outcome.results };
      } catch (err) {
        const detail = toScanError(err, "decode").message;
        legs.set(lane, { lane, engines, outcome: "error", ms: now() - started, detail, cold: cold || undefined });
        if (lane === "strong") {
          // Same policy as the cascade: drop the optional tier and keep scanning
          // on the healthy fast path rather than failing every later frame.
          this.wechatClient = null;
          onDiagnostic?.({ engine: "wechat", kind: "engine-error", detail });
        } else {
          fastError = err;
        }
        return { lane, results: [] };
      }
    };

    const lanes: Promise<LaneResult>[] = [];
    const dispatch = (lane: RaceLane, client: WorkerClient, engines: EngineId[]): void => {
      if (client.busy) {
        legs.set(lane, { lane, engines, outcome: "busy" });
        return;
      }
      // The strong tier's model may still be downloading; a frame dispatched now
      // wears that load in its round trip.
      lanes.push(runLane(lane, client, engines, lane === "strong" && this.warmingStrong !== null));
    };
    dispatch("fast", fast, fastEngines);
    dispatch("strong", strong, ["wechat"]);

    // Both lanes still working on older frames: nothing to decode, and nothing
    // queued. The scanVideo loop simply tries again on the next tick.
    if (lanes.length === 0) {
      emit(true);
      return [];
    }

    // Settle in arrival order and stop at the first lane that actually decoded.
    // `runLane` never rejects, so nothing here can leave a rejection unhandled.
    const remaining = new Map(lanes.map((p, i) => [i, p.then((v) => ({ ...v, index: i }))]));
    let results: ScanResult[] = [];
    while (remaining.size > 0) {
      const settled = await Promise.race(remaining.values());
      remaining.delete(settled.index);
      if (settled.results.length > 0) {
        winner = settled.lane;
        results = settled.results;
        break;
      }
    }

    if (remaining.size > 0) {
      // Report what is known now, then again once the straggler lands — that
      // second report is the actual head-to-head measurement.
      emit(false);
      void Promise.all(remaining.values()).then(() => emit(true));
    } else {
      emit(true);
    }

    if (results.length === 0 && fastError !== null) throw fastError;
    return results;
  }

  /**
   * Preload-on-low-res: a live frame whose smaller dimension is below the
   * threshold warms the WeChat WASM (idempotent, non-blocking) so the escalation
   * decode doesn't stall on a cold download. Fires at most once per scanner.
   */
  private maybePreloadWechat(width: number, height: number): void {
    if (this.lowResPreloadPx <= 0) return;
    const minDim = Math.min(width, height);
    if (minDim <= 0 || minDim >= this.lowResPreloadPx) return;
    this.warmStrongTier();
  }

  /**
   * Warm the strong tier in the background — idempotent, non-blocking, once per
   * scanner, and best-effort: if it fails, the cascade simply loads it again
   * when it gets there.
   */
  private warmStrongTier(): void {
    if (this.wechatPreloadStarted) return;
    if (!this.wechatClient && !this.wechat) return;
    this.wechatPreloadStarted = true;
    const warming = (async () => {
      try {
        if (this.wechatClient) {
          await this.wechatClient.preload();
        } else if (this.wechat && (await this.wechat.isAvailable())) {
          await this.wechat.load();
        }
      } catch {
        /* best-effort; the cascade will attempt the load again on escalation */
      }
    })();
    this.warmingStrong = warming;
    // Never rejects (the body catches), so this cannot go unhandled.
    void warming.then(() => {
      if (this.warmingStrong === warming) this.warmingStrong = null;
    });
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
        const error = toScanError(err, "decode");
        options.onError?.(error);
        // A dead worker never recovers; report once and stop rather than
        // re-failing on every subsequent frame.
        if (error.code === "worker-died") {
          void controller.stop();
          return;
        }
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
    await Promise.all([this.client?.dispose(), this.wechatClient?.dispose()]);
    this.client = null;
    this.wechatClient = null;
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
