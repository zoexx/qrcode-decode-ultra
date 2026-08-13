import type { Availability } from "qrcode-decode-ultra/worker-runtime";

/**
 * This tier is pure WASM, so a runtime without `WebAssembly` can never run it —
 * a permanent property of the environment, not a failed probe.
 *
 * Its own module rather than living in `index.ts`: `engine.ts` is what the
 * worker bundles and what `LazyWechatEngine` defers to, so importing the main
 * entry from it would both create a cycle and drag `enableWechat()`'s
 * registration side effects into the worker chunk.
 */
export function wasmAvailability(): Availability {
  return typeof WebAssembly !== "undefined"
    ? true
    : { available: false, code: "no-api", detail: "WebAssembly is not available in this runtime" };
}
