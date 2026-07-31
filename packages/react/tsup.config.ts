import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.tsx",
  },
  format: ["esm"],
  target: "es2022",
  platform: "browser",
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  splitting: true,
  external: ["react", "react-dom", "react/jsx-runtime", "qrcode-decode-ultra"],
});
