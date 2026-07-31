import { describe, expect, it } from "vitest";
// The default entry registers native + jsQR (the zero-WASM fast path), so this
// test runs in Node without any WASM.
import { createScanner } from "../src/index.js";
import { registerEngine } from "../src/engines/registry.js";
import type { Engine } from "../src/engine.js";
import { getProbeFrame, PROBE_PAYLOAD } from "../src/probe-image.js";

describe("scanner (in-process, jsqr)", () => {
  it("reports jsqr available", async () => {
    const scanner = createScanner({ worker: false, engines: ["jsqr"] });
    const statuses = await scanner.ready();
    expect(statuses.find((s) => s.engine === "jsqr")?.available).toBe(true);
    await scanner.dispose();
  });

  it("decodes a QR via jsqr with no cold start", async () => {
    const scanner = createScanner({ worker: false, engines: ["jsqr"] });
    const results = await scanner.scanImage(getProbeFrame());
    expect(results[0]?.value).toBe(PROBE_PAYLOAD);
    expect(results[0]?.engine).toBe("jsqr");
    expect(results[0]?.timing.coldStart).toBe(false);
    await scanner.dispose();
  });

  it("returns [] for a blank frame", async () => {
    const scanner = createScanner({ worker: false, engines: ["jsqr"] });
    const blank = { data: new Uint8ClampedArray(64 * 64 * 4).fill(255), width: 64, height: 64 };
    const results = await scanner.scanImage(blank);
    expect(results).toHaveLength(0);
    await scanner.dispose();
  });

  it("scanImage returns every code the winning engine finds (many-codes-per-frame)", async () => {
    // Register a fake multi-code engine under the `wechat` id (the default
    // registry never provides one, so this can't collide with other tests).
    const multi: Engine = {
      id: "wechat",
      capabilities: { formats: new Set(["qr_code"]) },
      isAvailable: () => Promise.resolve(true),
      load: () => Promise.resolve(),
      ready: () => true,
      decode: () =>
        Promise.resolve([
          { value: "one", format: "qr_code" },
          { value: "two", format: "qr_code" },
        ]),
      dispose: () => {},
    };
    registerEngine("wechat", () => multi);

    const scanner = createScanner({ worker: false, engines: ["wechat"] });
    const results = await scanner.scanImage(getProbeFrame());
    expect(results.map((r) => r.value)).toEqual(["one", "two"]);
    expect(results.every((r) => r.engine === "wechat")).toBe(true);
    await scanner.dispose();
  });
});
