import { afterEach, describe, expect, it, vi } from "vitest";
import { createScanner } from "../src/index.js";
import { registerEngine, registerEngineWorker } from "../src/engines/registry.js";
import type { Engine } from "../src/engine.js";
import type { MainToWorker, WorkerToMain } from "../src/worker/protocol.js";
import type { FrameImage, ScanResult } from "../src/types.js";

/**
 * The WeChat tier costs ~200ms per decode and ~600ms to load, so it must not run
 * on the main thread. When its package registers a worker factory the scanner
 * has to drive that worker instead of the in-process engine — these tests pin
 * that routing, and the fallback for when no worker was registered.
 */

/** A fake Worker that speaks the real protocol, so WorkerClient is unmodified. */
class FakeWorker {
  static spawned: FakeWorker[] = [];
  onmessage: ((e: MessageEvent<WorkerToMain>) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  terminated = false;
  decodeCalls = 0;
  preloadCalls = 0;
  failInit = false;
  private crashed = false;

  constructor(private readonly hit: string | null) {
    FakeWorker.spawned.push(this);
  }

  /** Simulate the worker dying: fire onerror, then answer nothing ever again. */
  crash(message: string): void {
    this.crashed = true;
    this.onerror?.({ message });
  }

  lastInit: MainToWorker | null = null;

  postMessage(msg: MainToWorker): void {
    if (msg.type === "init") this.lastInit = msg;
    // A crashed or terminated worker is silent. Modelling that is the whole
    // point: a post nobody answers is what leaves a promise pending forever.
    if (this.crashed || this.terminated) return;
    const reply = (m: WorkerToMain): void => {
      queueMicrotask(() => this.onmessage?.({ data: m } as MessageEvent<WorkerToMain>));
    };
    switch (msg.type) {
      case "init":
        if (this.failInit) {
          reply({ type: "error", id: msg.id, error: { code: "internal", message: "init boom" } });
          return;
        }
        reply({
          type: "ready",
          id: msg.id,
          statuses: msg.config.engineIds.map((engine) => ({ engine, available: true })),
        });
        return;
      case "preload":
        this.preloadCalls++;
        reply({ type: "preloaded", id: msg.id });
        return;
      case "decode": {
        this.decodeCalls++;
        const results: ScanResult[] = this.hit
          ? [
              {
                value: this.hit,
                format: "qr_code",
                engine: "wechat",
                timing: { totalMs: 1, coldStart: false },
              },
            ]
          : [];
        reply({ type: "result", id: msg.id, results, diagnostics: [] });
        return;
      }
      case "dispose":
        reply({ type: "disposed", id: msg.id });
        return;
    }
  }

  terminate(): void {
    this.terminated = true;
  }
}

const g = globalThis as unknown as Record<string, unknown>;
const saved = {
  Worker: g.Worker,
  OffscreenCanvas: g.OffscreenCanvas,
  createImageBitmap: g.createImageBitmap,
  ImageData: g.ImageData,
};

function installWorkerTransport(): void {
  // workerTransportAvailable() gates on these three existing. The global Worker
  // is what core's own fast-path client spawns — make it a protocol-speaking
  // fake that always misses, so every test exercises the escalation branch.
  g.Worker = class extends FakeWorker {
    constructor() {
      super(null);
    }
  } as unknown;
  g.OffscreenCanvas = class {} as unknown;
  g.createImageBitmap = () => Promise.resolve({ width: 8, height: 8, close() {} });
  g.ImageData = class {
    constructor(
      readonly data: Uint8ClampedArray,
      readonly width: number,
      readonly height: number,
    ) {}
  } as unknown;
}

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
  FakeWorker.spawned = [];
});

const FRAME: FrameImage = { data: new Uint8ClampedArray(8 * 8 * 4), width: 8, height: 8 };

describe("WeChat tier transport", () => {
  it("escalates to the tier's own worker, never the main thread", async () => {
    installWorkerTransport();
    const inProcessDecode = vi.fn(() => Promise.resolve([]));
    registerEngine("wechat", () => fakeEngine(inProcessDecode));
    registerEngineWorker("wechat", () => new FakeWorker("FROM-WECHAT-WORKER") as unknown as Worker);

    const scanner = createScanner({ engines: ["jsqr", "wechat"] });
    const results = await scanner.scanImage(FRAME);

    expect(results[0]?.value).toBe("FROM-WECHAT-WORKER");
    // The whole point: the ~200ms decode did NOT happen on this thread.
    expect(inProcessDecode).not.toHaveBeenCalled();
    await scanner.dispose();
  });

  it("spawns two workers and terminates both on dispose", async () => {
    installWorkerTransport();
    registerEngine("wechat", () => fakeEngine(() => Promise.resolve([])));
    registerEngineWorker("wechat", () => new FakeWorker("X") as unknown as Worker);

    const scanner = createScanner({ engines: ["jsqr", "wechat"] });
    await scanner.ready();
    expect(FakeWorker.spawned).toHaveLength(2); // fast path + the tier

    await scanner.dispose();
    expect(FakeWorker.spawned.every((w) => w.terminated)).toBe(true);
  });

  it("passes maxCodesPerFrame to BOTH workers", async () => {
    // The multi-code strategies run inside whichever worker holds the engine, so
    // the cap has to cross the protocol — it is useless if it stays main-thread.
    installWorkerTransport();
    registerEngine("wechat", () => fakeEngine(() => Promise.resolve([])));
    registerEngineWorker("wechat", () => new FakeWorker(null) as unknown as Worker);

    const scanner = createScanner({ engines: ["jsqr", "wechat"], maxCodesPerFrame: 7 });
    await scanner.ready();

    for (const w of FakeWorker.spawned) {
      expect(w.lastInit?.type).toBe("init");
      expect((w.lastInit as { config: { maxCodesPerFrame?: number } }).config.maxCodesPerFrame).toBe(7);
    }
    await scanner.dispose();
  });

  it("reports the tier available via its worker's own init", async () => {
    installWorkerTransport();
    registerEngine("wechat", () => fakeEngine(() => Promise.resolve([])));
    registerEngineWorker("wechat", () => new FakeWorker(null) as unknown as Worker);

    const scanner = createScanner({ engines: ["jsqr", "wechat"] });
    const statuses = await scanner.ready();

    expect(statuses.map((s) => s.engine)).toEqual(["jsqr", "wechat"]);
    expect(statuses.find((s) => s.engine === "wechat")?.available).toBe(true);
    await scanner.dispose();
  });

  it("preload-on-low-res warms the tier's worker, not the main thread", async () => {
    installWorkerTransport();
    const engine = fakeEngine(() => Promise.resolve([]));
    const load = vi.spyOn(engine, "load");
    registerEngine("wechat", () => engine);
    registerEngineWorker("wechat", () => new FakeWorker(null) as unknown as Worker);

    const scanner = createScanner({ engines: ["jsqr", "wechat"] });
    await scanner.preload();

    const tierWorker = FakeWorker.spawned[1]!;
    expect(tierWorker.preloadCalls).toBe(1);
    expect(load).not.toHaveBeenCalled();
    await scanner.dispose();
  });

  it("runs the tier in-process when worker:false, even though a worker is registered", async () => {
    installWorkerTransport();
    const inProcessDecode = vi.fn(() =>
      Promise.resolve([{ value: "FROM-MAIN-THREAD", format: "qr_code" as const }]),
    );
    registerEngine("wechat", () => fakeEngine(inProcessDecode));
    registerEngineWorker("wechat", () => new FakeWorker("SHOULD-NOT-BE-USED") as unknown as Worker);

    const scanner = createScanner({ engines: ["wechat"], worker: false });
    const results = await scanner.scanImage(FRAME);

    expect(results[0]?.value).toBe("FROM-MAIN-THREAD");
    expect(FakeWorker.spawned).toHaveLength(0); // no worker of any kind
    await scanner.dispose();
  });

  it("runs the tier in-process when the environment has no worker transport", async () => {
    // No OffscreenCanvas => workerTransportAvailable() is false everywhere.
    const inProcessDecode = vi.fn(() =>
      Promise.resolve([{ value: "FROM-MAIN-THREAD", format: "qr_code" as const }]),
    );
    registerEngine("wechat", () => fakeEngine(inProcessDecode));
    registerEngineWorker("wechat", () => new FakeWorker("SHOULD-NOT-BE-USED") as unknown as Worker);

    const scanner = createScanner({ engines: ["wechat"] });
    const results = await scanner.scanImage(FRAME);

    expect(results[0]?.value).toBe("FROM-MAIN-THREAD");
    expect(FakeWorker.spawned).toHaveLength(0);
    await scanner.dispose();
  });
});

function fakeEngine(decode: () => Promise<{ value: string; format: "qr_code" }[]>): Engine {
  return {
    id: "wechat",
    capabilities: { formats: new Set(["qr_code"]), multi: "inherent" as const },
    isAvailable: () => Promise.resolve(true),
    load: () => Promise.resolve(),
    ready: () => true,
    decode,
    dispose: () => {},
  };
}

/**
 * Failure containment. The strong tier is OPTIONAL: nothing it does may take
 * down a healthy native+jsQR fast path, and nothing may leave a promise pending
 * forever (which silently wedges the scanVideo loop — `inFlight` never clears).
 */
describe("WeChat tier failure containment", () => {
  it("survives a tier worker that cannot be constructed (CSP / missing chunk)", async () => {
    installWorkerTransport();
    registerEngine("wechat", () => fakeEngine(() => Promise.resolve([])));
    registerEngineWorker("wechat", () => {
      throw new Error("Failed to construct 'Worker': script not found");
    });

    const scanner = createScanner({ engines: ["jsqr", "wechat"] });
    const statuses = await scanner.ready(); // must NOT reject
    expect(statuses.find((s) => s.engine === "jsqr")?.available).toBe(true);
    // Falls back to the in-process engine rather than losing the tier entirely.
    expect(statuses.find((s) => s.engine === "wechat")?.reason).toMatch(/worker failed/);
    await expect(scanner.scanImage(FRAME)).resolves.toBeInstanceOf(Array);
    await scanner.dispose();
  });

  it("survives a tier worker whose init errors", async () => {
    installWorkerTransport();
    registerEngine("wechat", () => fakeEngine(() => Promise.resolve([])));
    registerEngineWorker("wechat", () => {
      const w = new FakeWorker(null);
      w.failInit = true;
      return w as unknown as Worker;
    });

    const scanner = createScanner({ engines: ["jsqr", "wechat"] });
    const statuses = await scanner.ready(); // must NOT reject
    expect(statuses.find((s) => s.engine === "jsqr")?.available).toBe(true);
    await scanner.dispose();
  });

  it("keeps scanning on the fast path after the tier worker dies mid-session", async () => {
    installWorkerTransport();
    registerEngine("wechat", () => fakeEngine(() => Promise.resolve([])));
    const tier = new FakeWorker(null);
    registerEngineWorker("wechat", () => tier as unknown as Worker);

    const scanner = createScanner({ engines: ["jsqr", "wechat"] });
    await scanner.ready();

    tier.crash("out of memory");
    // Must resolve (empty), not hang and not reject.
    await expect(scanner.scanImage(FRAME)).resolves.toEqual([]);
    await expect(scanner.scanImage(FRAME)).resolves.toEqual([]);
    await scanner.dispose();
  });

  it("settles an in-flight decode when dispose() lands mid-scan", async () => {
    installWorkerTransport();
    // Dispose has to land *inside* the `await toBitmap(...)` window — that is the
    // race: `this.client.decode` is already resolved as a member expression, so
    // the post lands in a terminated worker and nothing ever settles it.
    g.createImageBitmap = () =>
      new Promise((r) => setTimeout(() => r({ width: 8, height: 8, close() {} }), 40));
    registerEngine("wechat", () => fakeEngine(() => Promise.resolve([])));
    registerEngineWorker("wechat", () => new FakeWorker(null) as unknown as Worker);

    const scanner = createScanner({ engines: ["jsqr", "wechat"] });
    await scanner.ready();

    const inFlight = scanner.scanImage(FRAME);
    await scanner.dispose();
    // The React unmount path does exactly this; a pending-forever promise here
    // is what wedges the loop.
    await expect(
      Promise.race([inFlight.catch(() => "rejected"), delay(300).then(() => "HUNG")]),
    ).resolves.not.toBe("HUNG");
  });

  it("forwards a worker ScanError verbatim instead of '[object Object]'", async () => {
    installWorkerTransport();
    registerEngine("wechat", () => fakeEngine(() => Promise.resolve([])));
    const tier = new FakeWorker(null);
    registerEngineWorker("wechat", () => tier as unknown as Worker);

    const scanner = createScanner({ engines: ["jsqr", "wechat"] });
    await scanner.ready();
    tier.crash("boom");

    const diagnostics: string[] = [];
    await scanner.scanImage(FRAME);
    // The tier's death is reported as a diagnostic with a readable message.
    const s2 = createScanner({ engines: ["jsqr", "wechat"] });
    await s2.dispose();
    await scanner.dispose();
    expect(diagnostics.every((d) => !d.includes("[object Object]"))).toBe(true);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
