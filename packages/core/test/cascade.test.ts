import { describe, expect, it, vi } from "vitest";
import { runCascade, type Engine, type EngineResult } from "../src/engine.js";
import type { BarcodeFormat } from "../src/formats.js";
import type { EngineId, FrameImage } from "../src/types.js";

const FRAME: FrameImage = { data: new Uint8ClampedArray(4), width: 1, height: 1 };

function fakeEngine(
  id: EngineId,
  formats: BarcodeFormat[],
  decode: () => Promise<EngineResult[]>,
): Engine {
  return {
    id,
    capabilities: { formats: new Set(formats), multi: "inherent" as const },
    isAvailable: () => Promise.resolve(true),
    load: () => Promise.resolve(),
    ready: () => true,
    decode,
    dispose: () => {},
  };
}

describe("runCascade", () => {
  it("returns the first engine that decodes, and stops there", async () => {
    const second = vi.fn(() => Promise.resolve([{ value: "B", format: "qr_code" as const }]));
    const third = vi.fn(() => Promise.resolve([{ value: "C", format: "qr_code" as const }]));
    const outcome = await runCascade(
      [
        fakeEngine("native", ["qr_code"], () => Promise.resolve([])),
        fakeEngine("jsqr", ["qr_code"], second),
        fakeEngine("wechat", ["qr_code"], third),
      ],
      FRAME,
      ["qr_code"],
    );
    expect(outcome.engine).toBe("jsqr");
    expect(outcome.results[0]?.value).toBe("B");
    expect(third).not.toHaveBeenCalled();
  });

  it("skips an engine that cannot handle any requested format", async () => {
    const jsqr = vi.fn(() => Promise.resolve([{ value: "Q", format: "qr_code" as const }]));
    const diags: string[] = [];
    const outcome = await runCascade(
      [
        // jsqr is QR-only; requesting ean_13 must skip it
        fakeEngine("jsqr", ["qr_code"], jsqr),
        fakeEngine("wechat", ["ean_13"], () =>
          Promise.resolve([{ value: "123", format: "ean_13" as const }]),
        ),
      ],
      FRAME,
      ["ean_13"],
      (d) => diags.push(`${d.engine}:${d.kind}`),
    );
    expect(jsqr).not.toHaveBeenCalled();
    expect(outcome.engine).toBe("wechat");
    expect(diags).toContain("jsqr:skipped");
  });

  it("treats an engine error as a miss and falls through", async () => {
    const diags: string[] = [];
    const outcome = await runCascade(
      [
        fakeEngine("jsqr", ["qr_code"], () => Promise.reject(new Error("boom"))),
        fakeEngine("wechat", ["qr_code"], () =>
          Promise.resolve([{ value: "ok", format: "qr_code" as const }]),
        ),
      ],
      FRAME,
      ["qr_code"],
      (d) => diags.push(`${d.engine}:${d.kind}`),
    );
    expect(outcome.engine).toBe("wechat");
    expect(diags).toContain("jsqr:engine-error");
  });

  it("returns ALL codes the winning engine decoded (many-codes-per-frame)", async () => {
    const jsqr = vi.fn(() => Promise.resolve([{ value: "Z", format: "qr_code" as const }]));
    const outcome = await runCascade(
      [
        fakeEngine("native", ["qr_code"], () =>
          Promise.resolve([
            { value: "A", format: "qr_code" as const },
            { value: "B", format: "qr_code" as const },
            { value: "C", format: "qr_code" as const },
          ]),
        ),
        // first-hit-wins still holds: a later engine never runs once native hits.
        fakeEngine("jsqr", ["qr_code"], jsqr),
      ],
      FRAME,
      ["qr_code"],
    );
    expect(outcome.engine).toBe("native");
    expect(outcome.results.map((r) => r.value)).toEqual(["A", "B", "C"]);
    expect(jsqr).not.toHaveBeenCalled();
  });

  it("returns engine null when nothing decodes", async () => {
    const outcome = await runCascade(
      [fakeEngine("jsqr", ["qr_code"], () => Promise.resolve([]))],
      FRAME,
      ["qr_code"],
    );
    expect(outcome.engine).toBeNull();
    expect(outcome.results).toHaveLength(0);
  });
});
