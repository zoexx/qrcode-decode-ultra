import {
  registerEngine,
  type BarcodeFormat,
  type Engine,
  type EngineResult,
  type FrameImage,
  type Point,
} from "qrcode-decode-ultra";
import { ready, scan } from "qr-scanner-wechat";

/**
 * OpenCV WeChat QRCode engine — high accuracy on small / blurry / damaged /
 * low-light codes via a CNN detector + super-resolution. ~2.5MB WASM, loaded
 * lazily only when the cascade reaches this tier. QR / data-matrix oriented.
 *
 * This is the opt-in strong tier: it lives in its own package so a default
 * QRCode Decode Ultra install stays zero-WASM. Call `enableWechat()` once, then use the
 * "max-accuracy" preset (or include "wechat" in an explicit engine list).
 *
 * Runs in-process: the qrcode-decode-ultra worker build never includes it, so the
 * scanner runs the worker fast path (native + jsQR) and escalates to this engine
 * on the main thread on a miss (low-res / hard codes), preloading it on low-res
 * frames so the escalation doesn't stall.
 */
export class WechatEngine implements Engine {
  readonly id = "wechat" as const;
  readonly capabilities = { formats: new Set<BarcodeFormat>(["qr_code"]) };

  private loadPromise: Promise<void> | null = null;
  private loaded = false;

  isAvailable(): Promise<boolean> {
    return Promise.resolve(typeof WebAssembly !== "undefined");
  }

  load(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = ready().then(() => {
        this.loaded = true;
      });
    }
    return this.loadPromise;
  }

  ready(): boolean {
    return this.loaded;
  }

  async decode(frame: FrameImage, _formats: BarcodeFormat[]): Promise<EngineResult[]> {
    // qr-scanner-wechat accepts an ImageDataLike { data, width, height } — which
    // is exactly the shape of a QRCode Decode Ultra FrameImage, so no canvas round-trip.
    const result = await scan({ data: frame.data, width: frame.width, height: frame.height });
    if (!result || !result.text) return [];

    const rect = result.rect;
    const cornerPoints: Point[] | undefined = rect
      ? [
          { x: rect.x, y: rect.y },
          { x: rect.x + rect.width, y: rect.y },
          { x: rect.x + rect.width, y: rect.y + rect.height },
          { x: rect.x, y: rect.y + rect.height },
        ]
      : undefined;

    return [{ value: result.text, format: "qr_code", cornerPoints }];
  }

  dispose(): void {
    this.loaded = false;
    this.loadPromise = null;
  }
}

/**
 * Register the WeChat engine with QRCode Decode Ultra's core. Call this once before creating
 * a scanner that uses the "wechat" engine or the "max-accuracy" preset.
 *
 * ```ts
 * import { createScanner } from "qrcode-decode-ultra";
 * import { enableWechat } from "qrcode-decode-ultra-wechat";
 * enableWechat();
 * const scanner = createScanner({ engines: "max-accuracy", worker: false });
 * ```
 */
export function enableWechat(): void {
  registerEngine("wechat", () => new WechatEngine());
}
