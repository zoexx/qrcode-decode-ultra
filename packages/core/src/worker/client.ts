import type { Diagnostic, EngineStatus, ScanError, ScanResult } from "../types.js";
import type { MainToWorker, RequestId, WorkerConfig, WorkerToMain } from "./protocol.js";

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

  constructor() {
    // Consumer bundlers (Vite, webpack 5) detect this literal and emit the
    // worker chunk; native ESM resolves it relative to the built module.
    this.worker = new Worker(new URL("./scanner.worker.js", import.meta.url), { type: "module" });
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
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private send<T>(message: MainToWorker, transfer?: Transferable[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(message.id, { resolve: resolve as Pending["resolve"], reject });
      this.worker.postMessage(message, transfer ?? []);
    });
  }

  init(config: WorkerConfig): Promise<EngineStatus[]> {
    return this.send<EngineStatus[]>({ type: "init", id: this.nextId++, config });
  }

  preload(): Promise<void> {
    return this.send<void>({ type: "preload", id: this.nextId++ });
  }

  decode(bitmap: ImageBitmap): Promise<DecodeOutcome> {
    return this.send<DecodeOutcome>({ type: "decode", id: this.nextId++, bitmap }, [bitmap]);
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
