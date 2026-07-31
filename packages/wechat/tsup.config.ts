import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  target: "es2022",
  platform: "browser",
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  external: ["qrcode-decode-ultra", "qr-scanner-wechat"],
});
