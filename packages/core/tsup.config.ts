import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "scanner.worker": "src/worker/scanner.worker.ts",
    "worker-runtime": "src/worker/runtime.ts",
  },
  format: ["esm"],
  target: "es2022",
  platform: "browser",
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  splitting: true,
});
