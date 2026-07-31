import { registerEngine } from "./registry.js";
import { JsQrEngine } from "./jsqr.js";
import { NativeEngine } from "./native.js";

let done = false;

/**
 * Register the zero-WASM fast path: native + jsQR. Called by index.ts and by the
 * worker. The WeChat strong tier is registered separately by
 * `qrcode-decode-ultra-wechat` via `enableWechat()`.
 */
export function registerBuiltins(): void {
  if (done) return;
  done = true;
  registerEngine("native", () => new NativeEngine());
  registerEngine("jsqr", () => new JsQrEngine());
}
