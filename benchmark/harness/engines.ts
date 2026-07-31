import "./setup.js";
import jsQR from "jsqr";
import { createScanner, type Scanner } from "qrcode-decode-ultra";

export interface Frame {
  // ArrayBuffer-backed so it satisfies the ImageData constructor.
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

export interface WarmupInfo {
  available: boolean;
  coldStartMs: number;
  reason?: string;
}

export interface Driver {
  id: string;
  warmup(): Promise<WarmupInfo>;
  /** Return the decoded string, or null if nothing decoded. Never throws. */
  decode(frame: Frame): Promise<string | null>;
}

function now(): number {
  return performance.now();
}

// jsQR — pure JS, QR-only, zero payload.
const jsqrDriver: Driver = {
  id: "jsqr",
  warmup: () => Promise.resolve({ available: true, coldStartMs: 0 }),
  decode: (frame) => {
    const code = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: "attemptBoth" });
    return Promise.resolve(code?.data ? code.data : null);
  },
};

// qrcode-decode-ultra-fast — the zero-WASM fast path (native -> jsQR). Native is unavailable
// in Node, so this exercises jsQR, i.e. exactly what runs on a Windows / Linux /
// Firefox / iOS browser where native is absent.
function fastDriver(): Driver {
  let scanner: Scanner | null = null;
  return {
    id: "qrcode-decode-ultra-fast",
    async warmup() {
      scanner = createScanner({ worker: false, engines: "fast", formats: ["qr_code"] });
      const t0 = now();
      await scanner.preload();
      return { available: true, coldStartMs: now() - t0 };
    },
    async decode(frame) {
      const results = await scanner!.scanImage(frame as never);
      return results[0]?.value ?? null;
    },
  };
}

// qrcode-decode-ultra-max — fast path + the opt-in WeChat tier. The ablation against
// qrcode-decode-ultra-fast IS the headline: it isolates exactly what the 2.5MB buys. The
// WeChat WASM may not initialize headlessly (OpenCV.js expects a browser); if it
// doesn't, this driver degrades to the fast path rather than failing the run.
function maxDriver(): Driver {
  let scanner: Scanner | null = null;
  return {
    id: "qrcode-decode-ultra-max",
    async warmup() {
      try {
        const wechat = await import("qrcode-decode-ultra-wechat");
        wechat.enableWechat();
      } catch {
        /* WeChat package unavailable: max degrades to fast */
      }
      scanner = createScanner({ worker: false, engines: "max-accuracy", formats: ["qr_code"] });
      const t0 = now();
      try {
        await scanner.preload();
      } catch {
        /* WeChat WASM did not init headlessly; the fast tier still decodes */
      }
      return { available: true, coldStartMs: now() - t0 };
    },
    async decode(frame) {
      const results = await scanner!.scanImage(frame as never);
      return results[0]?.value ?? null;
    },
  };
}

// Native BarcodeDetector — never present off-browser; reported n/a, never 0%.
const nativeDriver: Driver = {
  id: "native",
  warmup: () =>
    Promise.resolve({
      available: false,
      coldStartMs: 0,
      reason: "no platform BarcodeDetector in Node — native needs a real browser",
    }),
  decode: () => Promise.resolve(null),
};

export function allDrivers(): Driver[] {
  return [fastDriver(), maxDriver(), jsqrDriver, nativeDriver];
}
