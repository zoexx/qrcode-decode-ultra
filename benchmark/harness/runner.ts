import "./setup.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { classify } from "./decode-contract.js";
import { allDrivers, type Frame } from "./engines.js";
import {
  injectIntoReadme,
  renderMarkdown,
  type BenchReport,
  type CategoryStat,
  type EngineReport,
} from "./report.js";
import { CATEGORIES, type Category, type ManifestRow } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = join(HERE, "..");
const ROOT = join(BENCH, "..");
const REPS = 5;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

async function loadFrame(rel: string): Promise<Frame> {
  const { data, info } = await sharp(join(BENCH, rel))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
}

interface CatAcc {
  tp: number;
  total: number;
  times: number[];
}

async function main(): Promise<void> {
  const manifest = JSON.parse(
    await readFile(join(BENCH, "fixtures", "manifest.json"), "utf8"),
  ) as ManifestRow[];

  const frames = new Map<string, Frame>();
  for (const row of manifest) frames.set(row.image, await loadFrame(row.image));

  const engineReports: EngineReport[] = [];

  for (const driver of allDrivers()) {
    const warm = await driver.warmup();
    if (!warm.available) {
      console.log(`- ${driver.id}: n/a (${warm.reason ?? "unavailable"})`);
      engineReports.push({
        engine: driver.id,
        available: false,
        reason: warm.reason,
        coldStartMs: 0,
        perCategory: {},
        overall: { detectionRate: 0, msMedian: 0 },
      });
      continue;
    }

    // untimed warm-up pass to prime JIT / module caches
    const firstRow = manifest[0];
    if (firstRow) await driver.decode(frames.get(firstRow.image)!);

    const byCat = new Map<Category, CatAcc>();
    let allTp = 0;
    let allTotal = 0;
    const allTimes: number[] = [];

    for (const row of manifest) {
      const frame = frames.get(row.image)!;
      const times: number[] = [];
      let value: string | null = null;
      for (let k = 0; k < REPS; k++) {
        const t0 = performance.now();
        const v = await driver.decode(frame);
        times.push(performance.now() - t0);
        if (k === 0) value = v;
      }
      const ms = median(times);
      const outcome = classify(row.expected, value);

      let acc = byCat.get(row.category);
      if (!acc) {
        acc = { tp: 0, total: 0, times: [] };
        byCat.set(row.category, acc);
      }
      acc.total++;
      acc.times.push(ms);
      if (outcome === "tp") acc.tp++;

      allTotal++;
      allTimes.push(ms);
      if (outcome === "tp") allTp++;
    }

    const perCategory: Partial<Record<Category, CategoryStat>> = {};
    for (const c of CATEGORIES) {
      const acc = byCat.get(c);
      if (acc) {
        perCategory[c] = {
          detectionRate: acc.tp / acc.total,
          msMedian: median(acc.times),
          total: acc.total,
          tp: acc.tp,
        };
      }
    }

    const overallRate = allTotal > 0 ? allTp / allTotal : 0;
    console.log(
      `- ${driver.id}: overall ${Math.round(overallRate * 100)}% detection, cold-start ${warm.coldStartMs.toFixed(0)}ms`,
    );
    engineReports.push({
      engine: driver.id,
      available: true,
      coldStartMs: warm.coldStartMs,
      perCategory,
      overall: { detectionRate: overallRate, msMedian: median(allTimes) },
    });
  }

  const report: BenchReport = {
    generatedAt: new Date().toISOString(),
    env: { os: `${os.type()} ${os.release()}`, arch: os.arch(), node: process.version, runner: "node" },
    engines: engineReports,
  };

  await mkdir(join(BENCH, "results"), { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  await writeFile(join(BENCH, "results", `${stamp}.json`), JSON.stringify(report, null, 2));
  await writeFile(join(BENCH, "results", "latest.json"), JSON.stringify(report, null, 2));

  const markdown = renderMarkdown(report);
  await injectIntoReadme(join(ROOT, "README.md"), markdown);

  console.log(`\n${markdown}\n`);
  console.log("wrote benchmark/results/latest.json and updated README.md");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
