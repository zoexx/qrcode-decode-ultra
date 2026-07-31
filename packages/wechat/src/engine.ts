import {
  type BarcodeFormat,
  type Engine,
  type EngineResult,
  type FrameImage,
  type Point,
} from "qrcode-decode-ultra/worker-runtime";
import { ready, scan } from "qr-scanner-wechat";

/**
 * OpenCV WeChat QRCode engine — high accuracy on small / blurry / damaged /
 * low-light codes via a CNN detector + super-resolution. QR-oriented.
 *
 * This is the opt-in strong tier: it lives in its own package so a default
 * QRCode Decode Ultra install stays zero-WASM. Call `enableWechat()` once, then
 * use the "max-accuracy" preset (or put "wechat" in an explicit engine list).
 *
 * **Where this runs.** Normally inside this package's own worker
 * (`wechat.worker.ts`) — core's worker build can never contain it, so the tier
 * ships its own and the scanner drives it as a second worker. It is also the
 * in-process fallback for `worker: false` and for environments with no worker
 * transport, where `LazyWechatEngine` defers importing this module so the
 * payload is only fetched on the path that actually uses it.
 *
 * It has to stay off the main thread wherever possible: ~6MB to fetch
 * (~2.5MB gzipped), 0.6-1.2s to load, and ~250-325ms per escalated decode.
 */
export class WechatEngine implements Engine {
  readonly id = "wechat" as const;
  // Returns one code plus a usable rect, so extra codes come from masking the
  // hit out and rescanning — you pay one pass per code actually present.
  readonly capabilities = { formats: new Set<BarcodeFormat>(["qr_code"]), multi: "mask" as const };

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
