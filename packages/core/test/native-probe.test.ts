import { afterEach, describe, expect, it } from "vitest";
import { NativeEngine } from "../src/engines/native.js";

const g = globalThis as unknown as { BarcodeDetector?: unknown };

afterEach(() => {
  delete g.BarcodeDetector;
});

describe("native engine probe", () => {
  it("is unavailable when BarcodeDetector is absent", async () => {
    delete g.BarcodeDetector;
    expect(await new NativeEngine().isAvailable()).toBe(false);
  });

  it("rejects a non-native (polyfilled) BarcodeDetector via the [native code] check", async () => {
    class FakeBarcodeDetector {
      static getSupportedFormats(): Promise<string[]> {
        return Promise.resolve(["qr_code"]);
      }
      detect(): Promise<unknown[]> {
        return Promise.resolve([]); // a real polyfill would decode, but we should reject it anyway
      }
    }
    g.BarcodeDetector = FakeBarcodeDetector;
    // looksNative() fails (class source has no "[native code]"), so we never trust it.
    expect(await new NativeEngine().isAvailable()).toBe(false);
  });
});
