import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "../../benchmark/fixtures");

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".json": "application/json",
};

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (MIME[entry.name.slice(entry.name.lastIndexOf("."))]) out.push(full);
  }
  return out;
}

/**
 * Serve `benchmark/fixtures` at `/fixtures`, in dev and in the build.
 *
 * The device report replays the benchmark corpus on the device itself, so the
 * numbers a phone produces are comparable to the README tables — which only
 * holds if it reads the *same* committed fixtures (~300KB) rather than a copy
 * that can drift. `manifest.json` paths are already `fixtures/...`-relative, so
 * mounting the directory under that name needs no rewriting.
 */
function fixtures(): Plugin {
  return {
    name: "qrdu-fixtures",
    configureServer(server) {
      server.middlewares.use("/fixtures", (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
        const file = resolve(FIXTURES, "." + rel);
        // Refuse anything that escapes the fixtures directory.
        if (relative(FIXTURES, file).startsWith("..")) return next();
        const mime = MIME[file.slice(file.lastIndexOf("."))];
        if (!mime) return next();
        readFile(file).then(
          (body) => {
            res.setHeader("content-type", mime);
            res.end(body);
          },
          () => next(),
        );
      });
    },
    async generateBundle() {
      // emitFile rather than a post-build copy, so the fixtures land in whatever
      // outDir is configured and survive `--emptyOutDir`.
      for (const file of await walk(FIXTURES)) {
        this.emitFile({
          type: "asset",
          fileName: join("fixtures", relative(FIXTURES, file)),
          source: await readFile(file),
        });
      }
    },
  };
}

export default defineConfig({
  // Relative, so one build works at a domain root, at a GitHub Pages project
  // sub-path (/qrcode-decode-ultra/), or in a subdirectory of a static host,
  // with no rebuild. Both entries are at the root of the output, so the caveat
  // about nested routes does not apply.
  base: "./",
  plugins: [react(), fixtures()],
  server: { host: true },
  build: {
    rollupOptions: {
      input: {
        index: resolve(HERE, "index.html"),
        report: resolve(HERE, "report.html"),
      },
    },
  },
});
