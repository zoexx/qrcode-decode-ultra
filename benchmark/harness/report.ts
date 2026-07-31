import { readFile, writeFile } from "node:fs/promises";
import { CATEGORIES, type Category } from "./types.js";

export interface CategoryStat {
  detectionRate: number; // 0..1
  msMedian: number;
  total: number;
  tp: number;
}

export interface EngineReport {
  engine: string;
  available: boolean;
  reason?: string;
  coldStartMs: number;
  perCategory: Partial<Record<Category, CategoryStat>>;
  overall: { detectionRate: number; msMedian: number };
}

export interface BenchReport {
  generatedAt: string;
  env: { os: string; arch: string; node: string; runner: "node" };
  engines: EngineReport[];
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function cell(e: EngineReport, c: Category): string {
  if (!e.available) return "n/a";
  const s = e.perCategory[c];
  return s ? pct(s.detectionRate) : "-";
}

export function renderMarkdown(report: BenchReport): string {
  const lines: string[] = [];
  lines.push(
    `_Benchmark: ${report.engines[0]?.perCategory ? Object.values(report.engines[0].perCategory)[0]?.total ?? "?" : "?"} images per category, Node runner (${report.env.os}/${report.env.arch}, node ${report.env.node}), generated ${report.generatedAt}._`,
  );
  lines.push("");
  lines.push("**Detection rate by category** (higher is better):");
  lines.push("");
  lines.push(`| Engine | ${CATEGORIES.join(" | ")} | Overall |`);
  lines.push(`|---|${CATEGORIES.map(() => "---").join("|")}|---|`);
  for (const e of report.engines) {
    const cells = CATEGORIES.map((c) => cell(e, c));
    const overall = e.available ? pct(e.overall.detectionRate) : "n/a";
    lines.push(`| ${e.engine} | ${cells.join(" | ")} | ${overall} |`);
  }
  lines.push("");
  lines.push("**Speed & cold start**:");
  lines.push("");
  lines.push("| Engine | cold-start (ms) | median decode (ms) | overall detection |");
  lines.push("|---|---|---|---|");
  for (const e of report.engines) {
    if (!e.available) {
      lines.push(`| ${e.engine} | n/a | n/a | n/a — ${e.reason ?? ""} |`);
      continue;
    }
    lines.push(
      `| ${e.engine} | ${e.coldStartMs.toFixed(0)} | ${e.overall.msMedian.toFixed(1)} | ${pct(e.overall.detectionRate)} |`,
    );
  }
  lines.push("");
  lines.push(
    "> Native `BarcodeDetector` is reported `n/a` here because there is no platform backend off-browser; it is not a loss. The honest comparison the cascade lives in is the WASM/JS one above. The WeChat tier's value is its per-category win on hard codes (blur / low-light / downscale / torture) weighed against its cold-start cost.",
  );
  return lines.join("\n");
}

export async function injectIntoReadme(readmePath: string, markdown: string): Promise<void> {
  const start = "<!--BENCH-->";
  const end = "<!--/BENCH-->";
  let content: string;
  try {
    content = await readFile(readmePath, "utf8");
  } catch {
    return;
  }
  const s = content.indexOf(start);
  const e = content.indexOf(end);
  if (s === -1 || e === -1) return;
  const before = content.slice(0, s + start.length);
  const after = content.slice(e);
  const block = `\n\n${markdown}\n\n`;
  await writeFile(readmePath, `${before}${block}${after}`);
}
