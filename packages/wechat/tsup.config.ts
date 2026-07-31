import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", "wechat.worker": "src/wechat.worker.ts" },
  format: ["esm"],
  target: "es2022",
  platform: "browser",
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  external: ["qrcode-decode-ultra", "qrcode-decode-ultra/worker-runtime", "qr-scanner-wechat"],
});
