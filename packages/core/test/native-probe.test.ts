import { afterEach, describe, expect, it } from "vitest";
import { normalizeAvailability } from "../src/engine.js";
import { NativeEngine } from "../src/engines/native.js";
import { PROBE_PAYLOAD } from "../src/probe-image.js";

const g = globalThis as unknown as { BarcodeDetector?: unknown; ImageData?: unknown };

/**
 * The probe hands `detect()` a real `ImageData`, which bare Node has no global
 * for — without this the two tests that get that far fail as `code: "error"`
 * instead of exercising the decode paths. The fakes ignore the argument; it
 * only has to construct.
 */
if (typeof g.ImageData === "undefined") {
  g.ImageData = class {
    constructor(
      readonly data: Uint8ClampedArray,
      readonly width: number,
      readonly height: number,
    ) {}
  };
}

afterEach(() => {
  delete g.BarcodeDetector;
});

/** Run the probe and flatten it to `{ available, code, detail }`. */
async function probe(): Promise<ReturnType<typeof normalizeAvailability>> {
  return normalizeAvailability(await new NativeEngine().isAvailable());
}

/**
 * A `BarcodeDetector` stand-in that passes the `[native code]` check, so the
 * paths *after* that gate can be tested.
 *
 * It has to be a **bound** function. `looksNative` reads the source via
 * `Function.prototype.toString.call(ctor)`, which ignores an own `toString`
 * property — that tamper-resistance is the point of the check. Bound functions
 * are the one thing in the language that is user-defined yet genuinely
 * stringifies as `function () { [native code] }`.
 */
function nativeLooking(
  impl: { formats?: string[]; formatsThrow?: boolean; detect?: () => Promise<unknown[]> } = {},
): unknown {
  function Impl(this: unknown) {
    /* instances get their detect from the prototype below */
  }
  Impl.prototype.detect = impl.detect ?? (() => Promise.resolve([]));

  const ctor = Impl.bind(null) as unknown as {
    getSupportedFormats(): Promise<string[]>;
  };
  ctor.getSupportedFormats = () =>
    impl.formatsThrow
      ? Promise.reject(new Error("boom"))
      : Promise.resolve(impl.formats ?? ["qr_code"]);
  return ctor;
}

describe("native engine probe", () => {
  it("reports no-api when BarcodeDetector is absent", async () => {
    delete g.BarcodeDetector;
    const result = await probe();
    expect(result.available).toBe(false);
    // iOS Safari and Firefox land here. Nothing was probed, so calling it a
    // failed probe would misdescribe a permanent property of the browser.
    expect(result.code).toBe("no-api");
  });

  it("reports not-native for a polyfilled BarcodeDetector, via the [native code] check", async () => {
    class FakeBarcodeDetector {
      static getSupportedFormats(): Promise<string[]> {
        return Promise.resolve(["qr_code"]);
      }
      detect(): Promise<unknown[]> {
        return Promise.resolve([]); // a real polyfill would decode, but we should reject it anyway
      }
    }
    g.BarcodeDetector = FakeBarcodeDetector;
    const result = await probe();
    expect(result.available).toBe(false);
    expect(result.code).toBe("not-native");
  });

  it("reports format-unsupported when the platform cannot do qr_code", async () => {
    g.BarcodeDetector = nativeLooking({ formats: ["ean_13", "code_128"] });
    const result = await probe();
    expect(result.available).toBe(false);
    expect(result.code).toBe("format-unsupported");
    // The detail names what it *did* report, which is what makes the status actionable.
    expect(result.detail).toContain("ean_13");
  });

  it("reports probe-failed when a detector claiming qr_code decodes the probe frame wrongly", async () => {
    g.BarcodeDetector = nativeLooking({ detect: () => Promise.resolve([]) });
    const result = await probe();
    expect(result.available).toBe(false);
    // The case the probe exists for: the platform claims support and is broken.
    expect(result.code).toBe("probe-failed");
  });

  it("reports error when getSupportedFormats throws", async () => {
    g.BarcodeDetector = nativeLooking({ formatsThrow: true });
    const result = await probe();
    expect(result.available).toBe(false);
    expect(result.code).toBe("error");
    expect(result.detail).toContain("boom");
  });

  it("is available when the detector decodes the probe frame correctly", async () => {
    g.BarcodeDetector = nativeLooking({
      detect: () => Promise.resolve([{ rawValue: PROBE_PAYLOAD, format: "qr_code", cornerPoints: [] }]),
    });
    const result = await probe();
    expect(result.available).toBe(true);
    expect(result.code).toBeUndefined();
  });
});
