import { describe, expect, it } from "vitest";
import { JsQrEngine } from "../src/engines/jsqr.js";
import { getProbeFrame, PROBE_PAYLOAD } from "../src/probe-image.js";

describe("baked probe image + jsQR", () => {
  it("jsQR decodes the baked probe QR to the expected payload", async () => {
    const frame = getProbeFrame();
    const engine = new JsQrEngine();
    const results = await engine.decode(frame, ["qr_code"]);
    expect(results).toHaveLength(1);
    expect(results[0]?.value).toBe(PROBE_PAYLOAD);
    expect(results[0]?.format).toBe("qr_code");
  });

  it("the probe frame has a sane size (modules + quiet zone, scaled)", () => {
    const frame = getProbeFrame(8, 4);
    // 21 modules + 4*2 quiet = 29 modules * 8px = 232
    expect(frame.width).toBe(232);
    expect(frame.height).toBe(232);
    expect(frame.data.length).toBe(232 * 232 * 4);
  });
});
