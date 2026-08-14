/**
 * Compatibility matrix: the same device report, run across all three browser
 * engines, so "what works where" is measured rather than asserted.
 *
 * This is the third runner, and it answers a different question from the other
 * two. `harness/runner.ts` measures detection accuracy in Node, where `native`
 * cannot exist. `browser/runner.ts` measures main-thread cost in one engine.
 * Neither can tell you that `native` is absent on every iOS browser while
 * `jsqr` picks up the slack — that needs the same corpus run through Chromium,
 * Firefox and WebKit side by side.
 *
 * **It must run on macOS.** `native` is an engine *and platform* property:
 * Chromium calls Apple's Vision framework on macOS and ML Kit on Android, but
 * has no Shape Detection backend at all on Linux or Windows. A matrix generated
 * on a Linux runner would report "Chromium: no native" — true there, wrong
 * everywhere users are, and worse than publishing nothing.
 *
 * It drives the real report page (`apps/demo/report.html`) and reads the
 * structured `window.qrduReport` it publishes, so this file never reimplements
 * what a device report contains.
 *
 * Run: pnpm -C benchmark compat
 */
import { chromium, firefox, webkit, type Browser, type BrowserType, type Page } from "playwright";
import { build, preview, type PreviewServer } from "vite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = join(HERE, "..");
const DEMO = resolve(BENCH, "../apps/demo");
const DEMO_CONFIG = join(DEMO, "vite.config.ts");
const README = resolve(BENCH, "../README.md");

/** Mirrors apps/demo/src/probe.ts. Structural, so a drift shows up as a crash here. */
interface DeviceReport {
  generatedAt: string;
  env: {
    userAgent: string;
    secureContext: boolean;
    features: Record<string, boolean>;
  };
  engines: { engine: string; available: boolean; code?: string; reason?: string }[];
  nativeFormats: string[] | null;
  wechatLoadMs: number | null;
  detection: Record<
    string,
    {
      byCategory: Record<string, { hit: number; total: number }>;
      wins: Record<string, number>;
      medianMs: Record<string, number>;
      falsePositives: number;
    }
  > | null;
  blocking: Record<string, { wallMs: number; longestTaskMs: number; framesDropped: number; longTaskSupported: boolean }> | null;
}

interface Row {
  engine: string;
  version: string;
  report: DeviceReport;
}

const ENGINES: { name: string; type: BrowserType }[] = [
  { name: "Chromium", type: chromium },
  { name: "Firefox", type: firefox },
  { name: "WebKit", type: webkit },
];

/** Duplicated from probe.ts rather than imported: apps/demo is a separate
 * private package with its own React toolchain, and this needs three lines of
 * it. Keep in step with `gradeOf` there. */
function gradeOf(r: DeviceReport): string {
  const usable = (id: string) => r.engines.some((e) => e.engine === id && e.available);
  const f = r.env.features;
  if (!r.engines.some((e) => e.available)) return "blocked";
  if (!(f.Worker && f.OffscreenCanvas && f.createImageBitmap)) return "degraded";
  if (!usable("wechat")) return "basic";
  return usable("native") ? "full" : "strong";
}

function overall(r: DeviceReport, preset: string): string {
  const score = r.detection?.[preset];
  if (!score) return "—";
  let hit = 0;
  let total = 0;
  for (const s of Object.values(score.byCategory)) {
    hit += s.hit;
    total += s.total;
  }
  return total ? `${Math.round((hit / total) * 100)}%` : "—";
}

/** Which tier won the most fixtures under `fast`, and how quickly. */
function leader(r: DeviceReport): string {
  const wins = r.detection?.fast?.wins ?? {};
  const top = Object.entries(wins).sort((a, b) => b[1] - a[1])[0];
  if (!top) return "—";
  const ms = r.detection?.fast?.medianMs?.[top[0]];
  return `\`${top[0]}\`${ms != null ? ` ${ms.toFixed(1)} ms` : ""}`;
}

function statusCell(r: DeviceReport, id: string): string {
  const s = r.engines.find((e) => e.engine === id);
  if (!s) return "—";
  return s.available ? "available" : `\`${s.code ?? "unavailable"}\``;
}

function renderMarkdown(rows: Row[]): string {
  const L: string[] = [];
  L.push(
    `_Compatibility matrix: ${os.type()} ${os.release()} ${os.arch()}, Playwright, generated ${new Date().toISOString()}._`,
    "",
    "| Browser engine | Grade | `native` | `wechat` | fast | max-accuracy | Leading tier (fast) |",
    "|---|---|---|---|---|---|---|",
  );
  for (const row of rows) {
    L.push(
      `| ${row.engine} ${row.version} | \`${gradeOf(row.report)}\` | ${statusCell(row.report, "native")} | ${statusCell(row.report, "wechat")} | ${overall(row.report, "fast")} | ${overall(row.report, "max-accuracy")} | ${leader(row.report)} |`,
    );
  }
  L.push(
    "",
    "> `native` is a property of the engine **and** the platform: Chromium calls Apple's Vision",
    "> framework on macOS and ML Kit on Android, but has no Shape Detection backend on Linux or",
    "> Windows. These rows are macOS. WebKit here is Playwright's build, not Safari on an iPhone —",
    "> the API surface matches, the hardware does not, so read capability from this table and never",
    "> performance. Real-device numbers come from the",
    "> [device report](https://zoexx.github.io/qrcode-decode-ultra/report.html).",
  );
  return L.join("\n");
}

async function injectIntoReadme(markdown: string): Promise<void> {
  const start = "<!--COMPAT-->";
  const end = "<!--/COMPAT-->";
  let content: string;
  try {
    content = await readFile(README, "utf8");
  } catch {
    return;
  }
  const s = content.indexOf(start);
  const e = content.indexOf(end);
  if (s === -1 || e === -1) {
    console.warn(`! no ${start} / ${end} markers in README — skipping injection`);
    return;
  }
  await writeFile(README, `${content.slice(0, s + start.length)}\n\n${markdown}\n\n${content.slice(e)}`);
}

async function runOne(name: string, type: BrowserType, url: string): Promise<Row | null> {
  let browser: Browser | undefined;
  try {
    browser = await type.launch();
  } catch (err) {
    // A missing engine should cost one row, not the whole matrix.
    console.warn(`! ${name}: could not launch — ${err instanceof Error ? err.message : String(err)}`);
    console.warn(`  (run: pnpm -C benchmark exec playwright install ${name.toLowerCase()})`);
    return null;
  }
  try {
    const page: Page = await browser.newPage();
    page.on("pageerror", (e) => console.error(`  ${name} page error:`, e.message));
    await page.goto(`${url}report.html`, { waitUntil: "load" });
    await page.getByRole("button", { name: /Run device report/i }).click();
    // The blocking pass is the last stage, so its presence means a complete run.
    await page.waitForFunction(
      () => Boolean((window as { qrduReport?: { blocking?: unknown } }).qrduReport?.blocking),
      undefined,
      { timeout: 600_000 },
    );
    const report = (await page.evaluate(() => (window as { qrduReport?: unknown }).qrduReport)) as DeviceReport;
    const version = browser.version().split(".")[0] ?? "";
    console.log(
      `- ${name} ${version}: ${gradeOf(report)} · native ${statusCell(report, "native")} · fast ${overall(report, "fast")} · max ${overall(report, "max-accuracy")}`,
    );
    return { engine: name, version, report };
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  console.log("building apps/demo...");
  await build({ configFile: DEMO_CONFIG, root: DEMO, logLevel: "warn" });

  const server: PreviewServer = await preview({ configFile: DEMO_CONFIG, root: DEMO, logLevel: "warn" });
  const url = server.resolvedUrls?.local?.[0];
  if (!url) throw new Error("vite preview did not report a local URL");

  try {
    const rows: Row[] = [];
    for (const { name, type } of ENGINES) {
      const row = await runOne(name, type, url);
      if (row) rows.push(row);
    }
    if (!rows.length) throw new Error("no browser engine produced a report");
    if (rows.length < ENGINES.length) {
      console.warn(`! matrix covers ${rows.length}/${ENGINES.length} engines — the rest failed to launch`);
    }

    const outDir = join(BENCH, "results");
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "compat.json"), JSON.stringify(rows, null, 2));

    const markdown = renderMarkdown(rows);
    await injectIntoReadme(markdown);
    console.log(`\n${markdown}\n`);
    console.log(`wrote ${join(outDir, "compat.json")} and updated the README`);
  } finally {
    await server.httpServer.close();
  }
}

await main();
