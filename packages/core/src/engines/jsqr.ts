import jsQR from "jsqr";
import type { Engine, EngineResult } from "../engine.js";
import type { BarcodeFormat } from "../formats.js";
import type { FrameImage, Point } from "../types.js";

/**
 * jsQR engine — pure JavaScript, QR-only, no WASM payload. It sits ahead of the
 * WeChat tier so a clean QR code decodes without ever loading WASM. Skipped
 * by the cascade for any non-QR format (capabilities is `qr_code` only).
 */
export class JsQrEngine implements Engine {
  readonly id = "jsqr" as const;
  // jsQR's locator degrades badly with several codes in view — it misses even
  // the first one — so masking cannot get started. Tiling is the way in.
  readonly capabilities = { formats: new Set<BarcodeFormat>(["qr_code"]), multi: "tile" as const };

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  load(): Promise<void> {
    return Promise.resolve();
  }

  ready(): boolean {
    return true;
  }

  decode(frame: FrameImage, _formats: BarcodeFormat[]): Promise<EngineResult[]> {
    const code = jsQR(frame.data, frame.width, frame.height, {
      inversionAttempts: "attemptBoth",
    });
    if (!code || code.data === "") {
      return Promise.resolve([]);
    }
    const loc = code.location;
    const cornerPoints: Point[] = [
      loc.topLeftCorner,
      loc.topRightCorner,
      loc.bottomRightCorner,
      loc.bottomLeftCorner,
    ];
    return Promise.resolve([{ value: code.data, format: "qr_code", cornerPoints }]);
  }

  dispose(): void {
    // nothing to release
  }
}
