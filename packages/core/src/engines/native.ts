import type { Engine, EngineResult } from "../engine.js";
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

  private probe: Promise<boolean> | null = null;
  private supported: Set<BarcodeFormat> = new Set();
  private detector: NativeDetector | null = null;

  isAvailable(): Promise<boolean> {
    if (!this.probe) this.probe = this.runProbe();
    return this.probe;
  }

  private async runProbe(): Promise<boolean> {
    const ctor = getCtor();
    if (!ctor || !looksNative(ctor)) return false;

    let supportedNames: string[];
    try {
      supportedNames = await ctor.getSupportedFormats();
    } catch {
      return false;
    }
    this.supported = new Set(supportedNames.filter(isBarcodeFormat) as BarcodeFormat[]);
    if (!this.supported.has("qr_code")) {
      // We probe with a QR; if the platform can't do QR we can't validate it.
      return false;
    }

    try {
      const detector = new ctor({ formats: ["qr_code"] });
      const found = await detector.detect(toImageData(getProbeFrame()));
      // The crux: constructor + getSupportedFormats can both succeed while
      // detect() silently returns []. Only a correct decode promotes native.
      return found.some((b) => b.rawValue === PROBE_PAYLOAD);
    } catch {
      return false;
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
