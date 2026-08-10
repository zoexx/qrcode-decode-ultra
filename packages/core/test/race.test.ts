import { afterEach, describe, expect, it } from "vitest";
import { createScanner } from "../src/index.js";
import { registerEngine, registerEngineWorker } from "../src/engines/registry.js";
import type { Engine } from "../src/engine.js";
import type { MainToWorker, WorkerToMain } from "../src/worker/protocol.js";
import type { EngineId, FrameImage, RaceReport, ScanResult } from "../src/types.js";

/**
 * Race mode: the same frame goes to BOTH workers at once and the first real
 * decode wins, instead of the strong tier only being consulted on a fast-path
 * miss.
 *
 * The lanes finish hundreds of milliseconds apart, so these tests never assert
 * on elapsed time — the slow lane is *held* and released explicitly, which pins
 * the ordering the implementation depends on without a timing flake.
 */

interface FakeConfig {
  hit: string | null;
  engine: EngineId;
  /** Hold decode replies until `flush()`, modelling the ~250ms WeChat lane. */
  hold: boolean;
  /** Hold the preload reply too, modelling the 2.5MB model still downloading. */
  holdPreload?: boolean;
}

class FakeWorker {
  static spawned: FakeWorker[] = [];
  onmessage: ((e: MessageEvent<WorkerToMain>) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  terminated = false;
  decodeCalls = 0;
  preloadCalls = 0;
  private held: (() => void)[] = [];
  private crashed = false;

  constructor(private readonly config: FakeConfig) {
    FakeWorker.spawned.push(this);
  }

  /** Release every held decode reply. */
  flush(): void {
    const held = this.held;
    this.held = [];
    for (const send of held) send();
  }

  crash(message: string): void {
    this.crashed = true;
    this.onerror?.({ message });
  }

  postMessage(msg: MainToWorker): void {
    if (this.crashed || this.terminated) return;
    const reply = (m: WorkerToMain): void => {
      queueMicrotask(() => this.onmessage?.({ data: m } as MessageEvent<WorkerToMain>));
    };
    switch (msg.type) {
      case "init":
        reply({
          type: "ready",
          id: msg.id,
          statuses: msg.config.engineIds.map((engine) => ({ engine, available: true })),
        });
        return;
      case "preload": {
        this.preloadCalls++;
        const done = (): void => reply({ type: "preloaded", id: msg.id });
        if (this.config.holdPreload) this.held.push(done);
        else done();
        return;
      }
      case "decode": {
        this.decodeCalls++;
        const results: ScanResult[] = this.config.hit
          ? [
              {
                value: this.config.hit,
                format: "qr_code",
                engine: this.config.engine,
                timing: { totalMs: 1, coldStart: false },
              },
            ]
          : [];
        const send = (): void => reply({ type: "result", id: msg.id, results, diagnostics: [] });
        if (this.config.hold) this.held.push(send);
        else send();
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

/** What the *fast* worker (core's own, spawned via global `Worker`) will do. */
const fastConfig: FakeConfig = { hit: null, engine: "jsqr", hold: false };
/** Every source handed to `createImageBitmap`, to check both lanes got one frame. */
let bitmapSources: { data: Uint8ClampedArray }[] = [];

function installWorkerTransport(): void {
  g.Worker = class extends FakeWorker {
    constructor() {
      super(fastConfig);
    }
  } as unknown;
  g.OffscreenCanvas = class {} as unknown;
  g.createImageBitmap = (src: { data: Uint8ClampedArray }) => {
    bitmapSources.push(src);
    return Promise.resolve({ width: 8, height: 8, close() {} });
  };
  g.ImageData = class {
    constructor(
      readonly data: Uint8ClampedArray,
      readonly width: number,
      readonly height: number,
    ) {}
  } as unknown;
}

/** Register the strong tier's worker and hand the test its instance. */
function installStrongTier(config: Partial<FakeConfig> = {}): { worker: FakeWorker } {
  const handle = { worker: null as unknown as FakeWorker };
  registerEngine("wechat", () => inProcessWechat());
  registerEngineWorker("wechat", () => {
    handle.worker = new FakeWorker({ hit: null, engine: "wechat", hold: false, ...config });
    return handle.worker as unknown as Worker;
  });
  return handle as { worker: FakeWorker };
}

function inProcessWechat(): Engine {
  return {
    id: "wechat",
    capabilities: { formats: new Set(["qr_code"]), multi: "inherent" as const },
    isAvailable: () => Promise.resolve(true),
    load: () => Promise.resolve(),
    ready: () => true,
    decode: () => Promise.resolve([]),
    dispose: () => {},
  };
}

/** Let queued microtasks (the fake worker's replies) run to completion. */
function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
  FakeWorker.spawned = [];
  bitmapSources = [];
  fastConfig.hit = null;
  fastConfig.engine = "jsqr";
  fastConfig.hold = false;
});

const FRAME: FrameImage = { data: new Uint8ClampedArray(8 * 8 * 4), width: 8, height: 8 };

describe("two-worker race", () => {
  it("sends the same pixels to both workers in one frame", async () => {
    installWorkerTransport();
    const strong = installStrongTier({ hit: "FROM-WECHAT" });
    fastConfig.hit = "FROM-FAST";

    const scanner = createScanner({ engines: ["jsqr", "wechat"], race: true });
    await scanner.ready();
    bitmapSources = []; // ignore anything from bring-up
    await scanner.scanImage(FRAME);

    expect(FakeWorker.spawned[0]!.decodeCalls).toBe(1); // fast
    expect(strong.worker.decodeCalls).toBe(1); // strong, same frame
    // The fairness invariant: rasterized once, so both lanes decode identical
    // pixels and the two times are actually comparable.
    expect(bitmapSources).toHaveLength(2);
    expect(bitmapSources[0]!.data).toBe(bitmapSources[1]!.data);
    await scanner.dispose();
  });

  it("returns the fast lane's hit without waiting for the strong lane", async () => {
    installWorkerTransport();
    const strong = installStrongTier({ hit: "FROM-WECHAT", hold: true });
    fastConfig.hit = "FROM-FAST";

    const reports: RaceReport[] = [];
    const scanner = createScanner({
      engines: ["jsqr", "wechat"],
      race: true,
      onRace: (r) => reports.push(r),
    });
    const results = await scanner.scanImage(FRAME);

    // Resolved while the strong lane is still held — the whole point.
    expect(results[0]?.value).toBe("FROM-FAST");
    const provisional = reports.at(-1)!;
    expect(provisional.complete).toBe(false);
    expect(provisional.winner).toBe("fast");
    expect(provisional.legs.find((l) => l.lane === "strong")?.outcome).toBe("pending");
    await scanner.dispose();
    strong.worker.flush();
  });

  it("reports the loser's time in a second, complete report", async () => {
    installWorkerTransport();
    const strong = installStrongTier({ hit: "FROM-WECHAT", hold: true });
    fastConfig.hit = "FROM-FAST";

    const reports: RaceReport[] = [];
    const scanner = createScanner({
      engines: ["jsqr", "wechat"],
      race: true,
      onRace: (r) => reports.push(r),
    });
    await scanner.scanImage(FRAME);
    strong.worker.flush();
    await settle();

    const final = reports.at(-1)!;
    expect(final.complete).toBe(true);
    expect(final.winner).toBe("fast"); // the late hit does not change the winner
    // Both lanes measured — that is what makes the race a measurement.
    for (const lane of ["fast", "strong"] as const) {
      const leg = final.legs.find((l) => l.lane === lane)!;
      expect(leg.outcome).toBe("hit");
      expect(typeof leg.ms).toBe("number");
    }
    expect(final.legs.find((l) => l.lane === "strong")?.engine).toBe("wechat");
    await scanner.dispose();
  });

  it("lets the strong lane win a frame the fast path misses", async () => {
    installWorkerTransport();
    installStrongTier({ hit: "ONLY-WECHAT-CAN-READ-THIS" });
    fastConfig.hit = null;

    const reports: RaceReport[] = [];
    const scanner = createScanner({
      engines: ["jsqr", "wechat"],
      race: true,
      onRace: (r) => reports.push(r),
    });
    const results = await scanner.scanImage(FRAME);

    expect(results[0]?.value).toBe("ONLY-WECHAT-CAN-READ-THIS");
    expect(results[0]?.engine).toBe("wechat");
    const final = reports.at(-1)!;
    expect(final.winner).toBe("strong");
    expect(final.legs.find((l) => l.lane === "fast")?.outcome).toBe("miss");
    await scanner.dispose();
  });

  it("skips a lane whose worker is still busy instead of queueing behind it", async () => {
    // The lanes finish hundreds of ms apart. Without this, every fast frame
    // would pile another decode into the slow worker's queue.
    installWorkerTransport();
    const strong = installStrongTier({ hit: "FROM-WECHAT", hold: true });
    fastConfig.hit = "FROM-FAST";

    const reports: RaceReport[] = [];
    const scanner = createScanner({
      engines: ["jsqr", "wechat"],
      race: true,
      onRace: (r) => reports.push(r),
    });
    await scanner.scanImage(FRAME); // strong lane starts, and is held
    await scanner.scanImage(FRAME); // strong is still busy on the older frame

    expect(strong.worker.decodeCalls).toBe(1);
    expect(reports.at(-1)!.legs.find((l) => l.lane === "strong")?.outcome).toBe("busy");
    await scanner.dispose();
    strong.worker.flush();
  });

  it("warms the strong tier at init, since there is no escalation left to preload against", async () => {
    installWorkerTransport();
    const strong = installStrongTier();

    const scanner = createScanner({ engines: ["jsqr", "wechat"], race: true });
    await scanner.ready();
    await settle();

    expect(strong.worker.preloadCalls).toBe(1);
    await scanner.dispose();
  });

  it("marks a lane cold while its engine is still loading", async () => {
    // A frame dispatched mid-download wears the 2.5MB model load in its round
    // trip. The lane still runs — losing a decode to keep a number tidy would be
    // the wrong trade — but the time is flagged as setup, not decode speed.
    installWorkerTransport();
    const strong = installStrongTier({ hit: "FROM-WECHAT", holdPreload: true });
    fastConfig.hit = null;

    const reports: RaceReport[] = [];
    const scanner = createScanner({
      engines: ["jsqr", "wechat"],
      race: true,
      onRace: (r) => reports.push(r),
    });
    await scanner.ready();
    const scan = scanner.scanImage(FRAME);
    await settle();
    strong.worker.flush(); // model lands, then the decode answers
    await scan;

    const cold = reports.at(-1)!.legs.find((l) => l.lane === "strong")!;
    expect(cold.cold).toBe(true);
    expect(reports.at(-1)!.legs.find((l) => l.lane === "fast")?.cold).toBeUndefined();
    await scanner.dispose();
  });

  it("stops marking a lane cold once its engine is loaded", async () => {
    installWorkerTransport();
    installStrongTier({ hit: "FROM-WECHAT" }); // preload answers immediately
    fastConfig.hit = null;

    const reports: RaceReport[] = [];
    const scanner = createScanner({
      engines: ["jsqr", "wechat"],
      race: true,
      onRace: (r) => reports.push(r),
    });
    await scanner.ready();
    await settle(); // let the warm-up settle before the first frame
    await scanner.scanImage(FRAME);

    expect(reports.at(-1)!.legs.find((l) => l.lane === "strong")?.cold).toBeUndefined();
    await scanner.dispose();
  });

  it("keeps scanning on the fast path when the strong worker dies", async () => {
    installWorkerTransport();
    const strong = installStrongTier({ hit: "FROM-WECHAT" });
    fastConfig.hit = "FROM-FAST";

    const scanner = createScanner({ engines: ["jsqr", "wechat"], race: true });
    await scanner.ready();
    strong.worker.crash("out of memory");

    await expect(scanner.scanImage(FRAME)).resolves.toMatchObject([{ value: "FROM-FAST" }]);
    // Tier dropped: the next frame races nothing and still decodes.
    await expect(scanner.scanImage(FRAME)).resolves.toMatchObject([{ value: "FROM-FAST" }]);
    await scanner.dispose();
  });

  it("falls back to the cascade when the tier has no worker to race", async () => {
    // Racing an in-process engine against the fast worker is not a race, just a
    // blocked main thread — so `race` is ignored and nothing is reported.
    installWorkerTransport();
    registerEngine("wechat", () => inProcessWechat());
    registerEngineWorker("wechat", () => {
      throw new Error("no chunk emitted");
    });
    fastConfig.hit = "FROM-FAST";

    const reports: RaceReport[] = [];
    const scanner = createScanner({
      engines: ["jsqr", "wechat"],
      race: true,
      onRace: (r) => reports.push(r),
    });
    const results = await scanner.scanImage(FRAME);

    expect(results[0]?.value).toBe("FROM-FAST");
    expect(reports).toHaveLength(0);
    await scanner.dispose();
  });

  it("stays off entirely when race is not requested", async () => {
    installWorkerTransport();
    const strong = installStrongTier({ hit: "FROM-WECHAT" });
    fastConfig.hit = "FROM-FAST";

    const scanner = createScanner({ engines: ["jsqr", "wechat"] });
    await scanner.scanImage(FRAME);

    // The default cascade never wakes the strong tier for a frame the fast path
    // already decoded — that is what makes racing an opt-in cost.
    expect(strong.worker.decodeCalls).toBe(0);
    await scanner.dispose();
  });
});
