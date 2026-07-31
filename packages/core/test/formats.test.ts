import { describe, expect, it } from "vitest";
import { ALL_FORMATS, intersectFormats, isBarcodeFormat } from "../src/formats.js";

describe("formats", () => {
  it("has 13 standard formats", () => {
    expect(ALL_FORMATS).toHaveLength(13);
  });

  it("intersectFormats returns all supported when none requested", () => {
    const supported = new Set(ALL_FORMATS);
    expect(intersectFormats(undefined, supported)).toHaveLength(13);
    expect(intersectFormats([], supported)).toHaveLength(13);
  });

  it("intersectFormats narrows to the overlap", () => {
    const supported = new Set<(typeof ALL_FORMATS)[number]>(["qr_code"]);
    expect(intersectFormats(["qr_code", "ean_13"], supported)).toEqual(["qr_code"]);
  });

  it("isBarcodeFormat guards unknown strings", () => {
    expect(isBarcodeFormat("qr_code")).toBe(true);
    expect(isBarcodeFormat("nope")).toBe(false);
  });
});
