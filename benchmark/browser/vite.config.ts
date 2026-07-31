import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const HERE = dirname(fileURLToPath(import.meta.url));

// The fixtures directory is served at the web root, so the manifest's
// repo-relative paths resolve after stripping the leading "fixtures/".
export default defineConfig({
  root: HERE,
  publicDir: join(HERE, "..", "fixtures"),
  build: { outDir: join(HERE, "dist"), emptyOutDir: true },
  // The harness measures the library; don't let a dev-only transform skew it.
  esbuild: { legalComments: "none" },
});
