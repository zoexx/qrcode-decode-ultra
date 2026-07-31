/// <reference lib="webworker" />
import { registerBuiltins } from "../engines/builtins.js";
import { serveWorker } from "./serve.js";

// This worker serves the zero-WASM fast path only. `wechat` is never in this
// build — core must not statically import the optional package — so the main
// thread strips that id before `init` and drives the tier's own worker instead
// (see `qrcode-decode-ultra-wechat/worker`).
registerBuiltins();
serveWorker();
