/**
 * Browser benchmark: the numbers the Node runner structurally cannot produce.
 *
 * 1. Whether the platform `BarcodeDetector` is real here — the Node table
 *    reports `native` as `n/a`, which is honest but leaves the cascade's first
 *    tier entirely unmeasured.
 * 2. What a decode costs the *main thread*. Workers do not make decoding
 *    faster — the transport adds a transfer plus a round trip. What they buy is
 *    main-thread availability, so blocking is the metric, not throughput.
 *
 * Run: pnpm -C benchmark benchmark:browser
 */
import { chromium, type Browser, type Page } from "playwright";
import { build, preview, type PreviewServer } from "vite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import type { BlockingSample } from "./main.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = join(HERE, "..");
const CONFIG = join(HERE, "vite.config.ts");

interface BrowserReport {
  generatedAt: string;
  env: { os: string; arch: string; browser: string; runner: "playwright" };
  native: { available: boolean; reason?: string };
  detection: Record<string, Record<string, { hit: number; total: number; engines: string[] }>>;
  blocking: Record<string, BlockingSample & { decoded: boolean }>;
  transport: Record<string, BlockingSample & { decoded: boolean }>;
}

function fmt(n: number): string {
  return n >= 100 ? n.toFixed(0) : n.toFixed(1);
}

function renderMarkdown(r: BrowserReport): string {
  const L: string[] = [];
  L.push(
    `_Browser benchmark: ${r.env.browser}, ${r.env.os}/${r.env.arch}, generated ${r.generatedAt}._`,
    "",
    "**Main-thread cost of an escalated decode** — a `downscale_32` fixture, the case the fast path genuinely cannot read, so the WeChat tier runs. Figures span 5 consecutive decodes with the model already loaded.",
    "",
    "| Transport | longest task | total blocking | longest frame gap | frames dropped |",
    "|---|---|---|---|---|",
  );
  for (const [name, s] of Object.entries(r.blocking)) {
    L.push(
      `| ${name} | ${fmt(s.longestTaskMs)} ms | ${fmt(s.totalBlockingMs)} ms | ${fmt(s.longestFrameGapMs)} ms | ${s.framesDropped} |`,
    );
  }
  L.push(
    "",
    "> A task over 50ms is what the browser itself calls blocking; over ~100ms a tap feels unresponsive. `frames dropped` is what a 60fps camera preview loses.",
    "",
  );

  L.push(
    "**Per-frame cost at 720p** — a clean code in a 1280x720 frame read by the fast path, no escalation. The gap between the two rows is what the worker transport costs: one bitmap transfer plus a round trip. Absolute wall-clock is inflated by headless software rasterisation, so read the difference, not the magnitude. Both rows report a 0.0 ms longest task because a fast-path decode is split across awaits, which `longtask` cannot see — blocking is the escalated-decode table above, not this one.",
    "",
    "| Transport | per frame | longest task | frames dropped |",
    "|---|---|---|---|",
  );
  for (const [name, s] of Object.entries(r.transport)) {
    L.push(`| ${name} | ${fmt(s.wallMs)} ms | ${fmt(s.longestTaskMs)} ms | ${s.framesDropped} |`);
  }
  L.push("");

  L.push("**Native `BarcodeDetector` on this platform**: " + (r.native.available ? "available" : `unavailable — ${r.native.reason ?? "no reason given"}`), "");

  const cats = Object.keys(Object.values(r.detection)[0] ?? {});
  if (cats.length) {
    L.push("**Detection rate by category, in-browser** (the `fast` row now includes native):", "");
    L.push(`| Preset | ${cats.join(" | ")} | Overall |`);
    L.push(`|---|${cats.map(() => "---").join("|")}|---|`);
    for (const [preset, byCat] of Object.entries(r.detection)) {
      let hit = 0;
      let total = 0;
      const cells = cats.map((c) => {
        const s = byCat[c];
        if (!s) return "-";
        hit += s.hit;
        total += s.total;
        return `${Math.round((s.hit / s.total) * 100)}%`;
      });
      L.push(`| ${preset} | ${cells.join(" | ")} | ${Math.round((hit / total) * 100)}% |`);
    }
    L.push("");
    const engines = new Set<string>();
    for (const byCat of Object.values(r.detection)) {
      for (const s of Object.values(byCat)) for (const e of s.engines) engines.add(e);
    }
    L.push(`> Engines that won at least one frame here: ${[...engines].sort().join(", ") || "none"}.`);
  }
  return L.join("\n");
}

/** Replace the block between the browser-benchmark markers in the root README. */
async function injectIntoReadme(readmePath: string, markdown: string): Promise<void> {
  const start = "<!--BENCH-BROWSER-->";
  const end = "<!--/BENCH-BROWSER-->";
  let content: string;
  try {
    content = await readFile(readmePath, "utf8");
  } catch {
    return;
  }
  const s = content.indexOf(start);
  const e = content.indexOf(end);
  if (s === -1 || e === -1) return;
  await writeFile(readmePath, `${content.slice(0, s + start.length)}\n\n${markdown}\n\n${content.slice(e)}`);
}

async function main(): Promise<void> {
  console.log("building the harness page...");
  await build({ configFile: CONFIG, logLevel: "warn" });

  const server: PreviewServer = await preview({ configFile: CONFIG, logLevel: "warn" });
  const url = server.resolvedUrls?.local?.[0];
  if (!url) throw new Error("vite preview did not report a local URL");

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const page: Page = await browser.newPage();
    page.on("pageerror", (e) => console.error("  page error:", e.message));
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction(() => typeof window.bench !== "undefined");

    const native = await page.evaluate(() => window.bench.nativeStatus());
    console.log(`- native BarcodeDetector: ${native.available ? "available" : `n/a (${native.reason})`}`);

    if (process.env.BENCH_PROBE) {
      const sizes = [32, 48, 64, 96, 128, 160, 200, 256];
      for (const cat of ["clean", "downscale_32"]) {
        const rows = await page.evaluate(
          ([c, s]) => window.bench.probe(c as string, s as number[]),
          [cat, sizes] as const,
        );
        console.log(`  ${cat}: ` + rows.map((r) => `${r.qrPx}px fast=${r.fast ? "Y" : "n"} max=${r.max ? "Y" : "n"}`).join("  "));
      }
      return;
    }

    const blocking: BrowserReport["blocking"] = {};
    for (const [label, useWorker] of [
      ["main thread (worker: false)", false],
      ["workers (default)", true],
    ] as const) {
      const s = await page.evaluate((w) => window.bench.blocking("downscale_32", w), useWorker);
      blocking[label] = s;
      if (!s.decoded) throw new Error(`blocking sample for "${label}" never decoded — measuring a miss, not a decode`);
      console.log(`- escalated decode, ${label}: longest task ${fmt(s.longestTaskMs)}ms, dropped ${s.framesDropped} frames`);
    }

    // Separate question: what does a full-size camera frame cost the main thread
    // just to route to a worker? Free on a 32x32 fixture, real at 720p.
    const PAD = { width: 1280, height: 720, qrPx: 256 };
    const transport: BrowserReport["transport"] = {};
    for (const [label, useWorker] of [
      ["main thread (worker: false)", false],
      ["workers (default)", true],
    ] as const) {
      const s = await page.evaluate(
        ([w, pad]) => window.bench.transportCost(w as boolean, pad as never),
        [useWorker, PAD] as const,
      );
      transport[label] = s;
      console.log(`- 720p fast-path frame, ${label}: ${fmt(s.wallMs)}ms/frame, longest task ${fmt(s.longestTaskMs)}ms`);
    }

    const detection: BrowserReport["detection"] = {};
    for (const preset of ["fast", "max-accuracy"] as const) {
      detection[preset] = await page.evaluate((p) => window.bench.detection(p), preset);
    }

    const report: BrowserReport = {
      generatedAt: new Date().toISOString(),
      env: {
        os: `${os.type()} ${os.release()}`,
        arch: os.arch(),
        browser: `chromium ${browser.version()}`,
        runner: "playwright",
      },
      native,
      detection,
      blocking,
      transport,
    };

    await mkdir(join(BENCH, "results"), { recursive: true });
    await writeFile(join(BENCH, "results", "latest-browser.json"), JSON.stringify(report, null, 2));
    const markdown = renderMarkdown(report);
    await injectIntoReadme(join(BENCH, "..", "README.md"), markdown);
    console.log(`\n${markdown}\n`);
    console.log("wrote benchmark/results/latest-browser.json and updated README.md");
  } finally {
    await browser?.close();
    server.httpServer.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
