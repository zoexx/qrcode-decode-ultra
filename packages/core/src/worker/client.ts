import type { EngineWorkerFactory } from "../engines/registry.js";
import type { Diagnostic, EngineStatus, ScanError, ScanResult } from "../types.js";
import type { MainToWorker, RequestId, WorkerConfig, WorkerToMain } from "./protocol.js";

function defaultWorkerFactory(): Worker {
  // Consumer bundlers (Vite, webpack 5) detect this literal and emit the worker
  // chunk; native ESM resolves it relative to the built module.
  return new Worker(new URL("./scanner.worker.js", import.meta.url), { type: "module" });
}

export interface DecodeOutcome {
  /** Every code the winning engine decoded in this frame. */
  results: ScanResult[];
  diagnostics: Diagnostic[];
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
};

/**
 * Main-thread handle to the decode worker. Owns id-correlated request/response
 * and the dispose handshake. Backpressure (one-in-flight / coalesce / throttle)
 * lives in the scanVideo loop, not here — this client just does one round trip.
 */
export class WorkerClient {
  private worker: Worker;
  private nextId: RequestId = 1;
  private pending = new Map<RequestId, Pending>();
  private disposing = false;
  /**
   * Set once the worker can no longer answer (crashed, or disposed). Every later
   * `send()` fails fast against it. Without this a post to a dead worker creates
   * a pending entry nothing will ever settle — which silently wedges the
   * `scanVideo` loop: `inFlight` never clears and frames stop being decoded
   * while the controller still reports `running`.
   */
  private dead: ScanError | null = null;
  /**
   * Decodes posted but not yet answered. The race path reads this to skip a lane
   * whose worker is still chewing on an older frame: the two lanes finish
   * hundreds of milliseconds apart, so without the check every fast frame would
   * pile another decode into the slow worker's message queue — a backlog that
   * only grows, and answers about frames long gone.
   */
  private decodesInFlight = 0;

  /**
   * @param workerFactory spawns the worker to drive. Defaults to core's own
   * fast-path worker; the WeChat tier passes the factory its package registered,
   * so one client implementation drives both workers over the same protocol.
   */
  constructor(workerFactory: EngineWorkerFactory = defaultWorkerFactory) {
    this.worker = workerFactory();
    this.worker.onmessage = (event: MessageEvent<WorkerToMain>) => this.onMessage(event.data);
    this.worker.onerror = (event) => this.onFatal(event.message || "worker error");
  }

  private onMessage(msg: WorkerToMain): void {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);

    switch (msg.type) {
      case "ready":
        pending.resolve(msg.statuses);
        break;
      case "preloaded":
      case "disposed":
        pending.resolve(undefined);
        break;
      case "result":
        pending.resolve({ results: msg.results, diagnostics: msg.diagnostics } satisfies DecodeOutcome);
        break;
      case "error":
        pending.reject(msg.error);
        break;
    }
  }

  private onFatal(message: string): void {
    const error: ScanError = { code: "worker-died", message };
    this.dead = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  /** True once this worker has crashed or been disposed; it will never answer. */
  get isDead(): boolean {
    return this.dead !== null || this.disposing;
  }

  /** True while a decode is in flight. See `decodesInFlight`. */
  get busy(): boolean {
    return this.decodesInFlight > 0;
  }

  private send<T>(message: MainToWorker, transfer?: Transferable[]): Promise<T> {
    // Fail fast rather than posting into a dead or terminating worker. `disposing`
    // is checked too: dispose() can land between a caller resolving `this.client`
    // and awaiting its bitmap argument, and terminate() silently drops the message.
    if (this.dead) return Promise.reject(this.dead);
    if (this.disposing && message.type !== "dispose") {
      return Promise.reject({ code: "worker-died", message: "disposed" } satisfies ScanError);
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.set(message.id, { resolve: resolve as Pending["resolve"], reject });
      try {
        this.worker.postMessage(message, transfer ?? []);
      } catch (err) {
        this.pending.delete(message.id);
        reject({ code: "worker-died", message: err instanceof Error ? err.message : String(err) } satisfies ScanError);
      }
    });
  }

  init(config: WorkerConfig): Promise<EngineStatus[]> {
    return this.send<EngineStatus[]>({ type: "init", id: this.nextId++, config });
  }

  preload(): Promise<void> {
    return this.send<void>({ type: "preload", id: this.nextId++ });
  }

  decode(bitmap: ImageBitmap): Promise<DecodeOutcome> {
    this.decodesInFlight++;
    const pending = this.send<DecodeOutcome>({ type: "decode", id: this.nextId++, bitmap }, [bitmap]);
    const settle = (): void => {
      this.decodesInFlight--;
    };
    // Both branches are handled here, so this bookkeeping chain can never
    // surface as an unhandled rejection; the caller still gets `pending` itself.
    void pending.then(settle, settle);
    return pending;
  }

  async dispose(): Promise<void> {
    if (this.disposing) return;
    this.disposing = true;
    const id = this.nextId++;
    const handshake = this.send<void>({ type: "dispose", id });
    // Wait for the worker to confirm it released engines/bitmaps, but never hang.
    await Promise.race([handshake.catch(() => undefined), delay(200)]);
    this.worker.terminate();
    this.onFatal("disposed");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
