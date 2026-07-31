/// <reference lib="webworker" />
import { registerEngine, serveWorker } from "qrcode-decode-ultra/worker-runtime";
import { WechatEngine } from "./engine.js";

/**
 * The WeChat tier's own worker.
 *
 * Core's worker build cannot contain this engine — core does not depend on this
 * package, by design — so the tier ships its own protocol-compatible worker and
 * the scanner drives it as a second worker on a fast-path miss. That keeps the
 * ~200ms WeChat decode and the ~600ms model load off the main thread, which is
 * the difference between a smooth camera preview and a visible freeze.
 *
 * This bundle carries WeChat only: no native probe, no jsQR.
 */
registerEngine("wechat", () => new WechatEngine());
serveWorker();
