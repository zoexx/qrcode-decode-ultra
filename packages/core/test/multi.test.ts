import { describe, expect, it, vi } from "vitest";
import { decodeUpTo, type MultiStrategy } from "../src/multi.js";
import type { Engine, EngineResult } from "../src/engine.js";
import type { FrameImage } from "../src/types.js";

/**
 * `maxCodesPerFrame` buys extra codes out of engines that only ever return one.
 * The two strategies have opposite cost shapes and opposite failure modes, so
 * both are pinned here — including that neither runs at the default.
 */

function blank(width: number, height: number): FrameImage {
  return { data: new Uint8ClampedArray(width * height * 4).fill(255), width, height };
}

/**
 * A decoder fake that reads the frame it is handed, rather than matching against
 * absolute coordinates — so cropping and masking behave the way they really do.
 * Each code is a solid square whose grey level identifies it.
 */
const MARK = { 10: "A", 20: "B", 30: "C" } as const;

function paint(frame: FrameImage, x: number, y: number, size: number, mark: number): void {
  for (let yy = y; yy < y + size; yy++) {
    for (let xx = x; xx < x + size; xx++) {
      const i = (yy * frame.width + xx) * 4;
      frame.data[i] = frame.data[i + 1] = frame.data[i + 2] = mark;
    }
  }
}

/** Find the first fully-contained square. A square touching the frame edge is
 * "clipped" and does not decode — which is why tiles must overlap. */
function findSquare(frame: FrameImage): { value: string; x: number; y: number; size: number } | null {
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const v = frame.data[(y * frame.width + x) * 4]!;
      if (v === 255) continue;
      let w = 0;
      while (x + w < frame.width && frame.data[(y * frame.width + x + w) * 4] === v) w++;
      let h = 0;
      while (y + h < frame.height && frame.data[((y + h) * frame.width + x) * 4] === v) h++;
      if (x === 0 || y === 0 || x + w >= frame.width || y + h >= frame.height) return null; // clipped
      const value = MARK[v as keyof typeof MARK];
      return value ? { value, x, y, size: Math.min(w, h) } : null;
    }
  }
  return null;
}

function pixelEngine(multi: MultiStrategy, opts: { maxWidth?: number } = {}): Engine {
  return {
    id: "wechat",
    capabilities: { formats: new Set(["qr_code"]), multi },
    isAvailable: () => Promise.resolve(true),
    load: () => Promise.resolve(),
    ready: () => true,
    decode: (frame: FrameImage): Promise<EngineResult[]> => {
      // Models jsQR: detection collapses when too much is in view at once.
      if (opts.maxWidth && frame.width > opts.maxWidth) return Promise.resolve([]);
      const s = findSquare(frame);
      if (!s) return Promise.resolve([]);
      return Promise.resolve([
        {
          value: s.value,
          format: "qr_code",
          cornerPoints: [
            { x: s.x, y: s.y },
            { x: s.x + s.size, y: s.y },
            { x: s.x + s.size, y: s.y + s.size },
            { x: s.x, y: s.y + s.size },
          ],
        } satisfies EngineResult,
      ]);
    },
    dispose: () => {},
  };
}

describe("decodeUpTo", () => {
  it("runs the engine exactly once at the default of 1", async () => {
    const engine = pixelEngine("mask");
    const spy = vi.spyOn(engine, "decode");
    const frame = blank(200, 200);
    paint(frame, 10, 10, 20, 10);

    expect(await decodeUpTo(engine, frame, ["qr_code"], 1)).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1); // no extra passes unless asked
  });

  it("never adds passes for an `inherent` engine, whatever the cap", async () => {
    const engine = pixelEngine("inherent");
    const spy = vi.spyOn(engine, "decode");
    const frame = blank(200, 200);
    paint(frame, 10, 10, 20, 10);

    await decodeUpTo(engine, frame, ["qr_code"], 10);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("masking finds every code and stops on its own", async () => {
    const engine = pixelEngine("mask");
    const frame = blank(200, 200);
    paint(frame, 10, 10, 20, 10);
    paint(frame, 100, 10, 20, 20);
    paint(frame, 10, 100, 20, 30);

    const out = await decodeUpTo(engine, frame, ["qr_code"], 10);
    expect(out.map((r) => r.value).sort()).toEqual(["A", "B", "C"]);
  });

  it("masking honours the cap", async () => {
    const engine = pixelEngine("mask");
    const frame = blank(200, 200);
    paint(frame, 10, 10, 20, 10);
    paint(frame, 100, 10, 20, 20);
    paint(frame, 10, 100, 20, 30);

    expect(await decodeUpTo(engine, frame, ["qr_code"], 2)).toHaveLength(2);
  });

  it("never mutates the caller's frame", async () => {
    const engine = pixelEngine("mask");
    const frame = blank(200, 200);
    paint(frame, 10, 10, 20, 10);
    const before = new Uint8ClampedArray(frame.data);

    await decodeUpTo(engine, frame, ["qr_code"], 5);
    expect(Array.from(frame.data)).toEqual(Array.from(before));
  });

  it("terminates instead of spinning when a hit carries no geometry to mask", async () => {
    const engine: Engine = {
      ...pixelEngine("mask"),
      decode: () => Promise.resolve([{ value: "A", format: "qr_code" as const }]), // no cornerPoints
    };
    const spy = vi.spyOn(engine, "decode");
    const out = await decodeUpTo(engine, blank(100, 100), ["qr_code"], 10);
    expect(out).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1); // would loop forever without the guard
  });

  it("tiling still finds a code too large for any tile (whole-frame pass first)", async () => {
    // Regression: sizing tiles off the frame means a code filling most of it
    // fits in no tile, so multi-code mode used to LOSE the single-code case.
    const engine = pixelEngine("tile");
    const frame = blank(200, 200);
    paint(frame, 10, 10, 170, 10);

    expect(await decodeUpTo(engine, frame, ["qr_code"], 12)).toHaveLength(1);
  });

  it("tiling finds codes a whole-frame pass would miss, in source coordinates", async () => {
    // This engine only ever sees a code when the crop is small enough to hold
    // just that one — exactly how jsQR behaves with several codes in view.
    const engine = pixelEngine("tile", { maxWidth: 250 });
    const frame = blank(400, 200);
    paint(frame, 20, 20, 20, 10);
    paint(frame, 300, 20, 20, 20);

    expect(await decodeUpTo(engine, frame, ["qr_code"], 1)).toHaveLength(0); // whole-frame miss
    const out = await decodeUpTo(engine, frame, ["qr_code"], 5);
    expect(out.map((r) => r.value).sort()).toEqual(["A", "B"]);
    // Geometry must be translated back out of tile-local space.
    const a = out.find((r) => r.value === "A")!;
    expect(a.cornerPoints?.[0]).toEqual({ x: 20, y: 20 });
  });
});
