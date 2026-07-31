import {
  registerEngine,
  registerEngineWorker,
  type BarcodeFormat,
  type Engine,
  type EngineResult,
  type FrameImage,
} from "qrcode-decode-ultra";

/**
 * A stand-in for the real engine that defers `import("./engine.js")` — and with
 * it the ~6MB `qr-scanner-wechat` payload — until the cascade actually reaches
 * this tier on the main thread.
 *
 * This matters because the tier normally runs in its own worker: without the
 * indirection, calling `enableWechat()` would pull the entire engine into the
 * main bundle as well, shipping the payload twice for a decode that is never
 * going to happen there.
 */
class LazyWechatEngine implements Engine {
  readonly id = "wechat" as const;
  readonly capabilities = { formats: new Set<BarcodeFormat>(["qr_code"]), multi: "mask" as const };

  private inner: Engine | null = null;
  private loading: Promise<void> | null = null;

  isAvailable(): Promise<boolean> {
    return Promise.resolve(typeof WebAssembly !== "undefined");
  }

  load(): Promise<void> {
    if (!this.loading) {
      this.loading = import("./engine.js").then(async ({ WechatEngine }) => {
        const engine = new WechatEngine();
        await engine.load();
        this.inner = engine;
      });
    }
    return this.loading;
  }

  ready(): boolean {
    return this.inner !== null;
  }

  async decode(frame: FrameImage, formats: BarcodeFormat[]): Promise<EngineResult[]> {
    if (!this.inner) await this.load();
    return this.inner!.decode(frame, formats);
  }

  dispose(): void {
    this.inner?.dispose();
    this.inner = null;
    this.loading = null;
  }
}

/**
 * Register the WeChat tier with QRCode Decode Ultra's core. Call this once
 * before creating a scanner that uses the `wechat` engine or the
 * `max-accuracy` preset.
 *
 * ```ts
 * import { createScanner } from "qrcode-decode-ultra";
 * import { enableWechat } from "qrcode-decode-ultra-wechat";
 * enableWechat();
 * const scanner = createScanner({ engines: "max-accuracy" });
 * ```
 *
 * Registers two things:
 *
 * - the **worker factory**, so the scanner runs this tier in its own worker.
 *   This is the path you want: a WeChat decode costs ~200ms and its model load
 *   ~600ms, both of which would otherwise block the main thread on every
 *   fast-path miss.
 * - the **engine factory**, used only when there is no worker to run it in
 *   (`worker: false`, or an environment without `Worker`/`OffscreenCanvas`).
 *   It loads the payload lazily, so this fallback costs nothing unless taken.
 *
 * Bundlers (Vite, webpack 5) detect the `new Worker(new URL(...))` literal below
 * and emit the worker chunk automatically.
 */
export function enableWechat(): void {
  registerEngine("wechat", () => new LazyWechatEngine());
  registerEngineWorker(
    "wechat",
    () => new Worker(new URL("./wechat.worker.js", import.meta.url), { type: "module" }),
  );
}
