import type { Availability, Engine, EngineResult } from "../engine.js";
import type { BarcodeFormat } from "../formats.js";
import { ALL_FORMATS, isBarcodeFormat } from "../formats.js";
import type { FrameImage, Point } from "../types.js";
import { getProbeFrame, PROBE_PAYLOAD } from "../probe-image.js";

// Minimal typing for the platform BarcodeDetector (not in lib.dom).
interface NativeBarcode {
  rawValue: string;
  format: string;
  cornerPoints: Point[];
}
interface NativeDetector {
  detect(source: ImageBitmapSource): Promise<NativeBarcode[]>;
}
interface NativeDetectorCtor {
  new (options?: { formats?: string[] }): NativeDetector;
  getSupportedFormats(): Promise<string[]>;
}

function getCtor(): NativeDetectorCtor | null {
  const g = globalThis as unknown as { BarcodeDetector?: NativeDetectorCtor };
  return typeof g.BarcodeDetector === "function" ? g.BarcodeDetector : null;
}

function looksNative(ctor: NativeDetectorCtor): boolean {
  try {
    return Function.prototype.toString.call(ctor).includes("[native code]");
  } catch {
    return false;
  }
}

function toImageData(frame: FrameImage): ImageData {
  return new ImageData(frame.data, frame.width, frame.height);
}

/**
 * Native `BarcodeDetector` engine. Zero payload, but only real on some platforms
 * (Android Chrome; macOS/ChromeOS Chromium partial) and absent or broken on
 * others (Windows/Linux/Firefox/iOS). `isAvailable()` therefore does a real
 * synthetic-decode probe, not a feature check — see probe-image.ts.
 */
export class NativeEngine implements Engine {
  readonly id = "native" as const;
  // Optimistic; the real supported set is discovered by the probe and applied at decode.
  // `detect()` already returns every code in the frame, in one pass.
  readonly capabilities = { formats: new Set<BarcodeFormat>(ALL_FORMATS), multi: "inherent" as const };

  private probe: Promise<Availability> | null = null;
  private supported: Set<BarcodeFormat> = new Set();
  private detector: NativeDetector | null = null;

  isAvailable(): Promise<Availability> {
    if (!this.probe) this.probe = this.runProbe();
    return this.probe;
  }

  /**
   * Each exit reports its own cause. They are genuinely different situations:
   * `no-api` is permanent and universal for the browser (iOS Safari, Firefox),
   * while `probe-failed` is a platform that claims QR support and gets a
   * known-good frame wrong — rare, machine-specific, and worth reporting
   * upstream. One shared "probe failed" string made those indistinguishable.
   */
  private async runProbe(): Promise<Availability> {
    const ctor = getCtor();
    if (!ctor) return { available: false, code: "no-api" };
    if (!looksNative(ctor)) return { available: false, code: "not-native" };

    let supportedNames: string[];
    try {
      supportedNames = await ctor.getSupportedFormats();
    } catch (err) {
      return {
        available: false,
        code: "error",
        detail: `getSupportedFormats() threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    this.supported = new Set(supportedNames.filter(isBarcodeFormat) as BarcodeFormat[]);
    if (!this.supported.has("qr_code")) {
      // We probe with a QR; if the platform can't do QR we can't validate it.
      return {
        available: false,
        code: "format-unsupported",
        detail: supportedNames.length
          ? `no qr_code support — reports ${supportedNames.join(", ")}`
          : "reports no supported formats",
      };
    }

    try {
      const detector = new ctor({ formats: ["qr_code"] });
      const found = await detector.detect(toImageData(getProbeFrame()));
      // The crux: constructor + getSupportedFormats can both succeed while
      // detect() silently returns []. Only a correct decode promotes native.
      if (found.some((b) => b.rawValue === PROBE_PAYLOAD)) return true;
      return {
        available: false,
        code: "probe-failed",
        detail: found.length
          ? `probe frame decoded as ${JSON.stringify(found[0]?.rawValue ?? "")}, expected ${JSON.stringify(PROBE_PAYLOAD)}`
          : "probe frame returned no codes despite reporting qr_code support",
      };
    } catch (err) {
      return {
        available: false,
        code: "error",
        detail: `detect() threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async load(): Promise<void> {
    if (this.detector) return;
    const ctor = getCtor();
    if (!ctor) throw new Error("BarcodeDetector unavailable");
    const formats = this.supported.size > 0 ? [...this.supported] : undefined;
    this.detector = new ctor(formats ? { formats } : undefined);
  }

  ready(): boolean {
    return this.detector !== null;
  }

  async decode(frame: FrameImage, formats: BarcodeFormat[]): Promise<EngineResult[]> {
    const wanted = formats.filter((f) => this.supported.has(f));
    if (wanted.length === 0) return [];
    if (!this.detector) await this.load();

    const found = await this.detector!.detect(toImageData(frame));
    const results: EngineResult[] = [];
    for (const b of found) {
      if (!isBarcodeFormat(b.format)) continue;
      if (!wanted.includes(b.format)) continue;
      results.push({ value: b.rawValue, format: b.format, cornerPoints: b.cornerPoints });
    }
    return results;
  }

  dispose(): void {
    this.detector = null;
  }
}
