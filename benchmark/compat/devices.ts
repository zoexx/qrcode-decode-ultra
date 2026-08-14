/**
 * Fold submitted device reports into the README's real-device table.
 *
 * The compatibility matrix (`compat/runner.ts`) covers browser *engines*, which
 * is capability. It cannot cover hardware: Android Chrome's `native` rides ML
 * Kit rather than the macOS Vision backend, and no headless runner can tell you
 * what a WeChat decode costs a mid-range phone. Those rows only come from people
 * running the device report on real devices.
 *
 * The report page's "Report this device" button opens a prefilled issue tagged
 * `device-report`. This reads those issues via `gh` and rewrites the table.
 * Deliberately no backend, no telemetry, and nothing automatic — a row exists
 * only because somebody chose to submit it.
 *
 * Run: pnpm -C benchmark compat:devices
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const README = resolve(HERE, "../../README.md");
const REPO = "zoexx/qrcode-decode-ultra";

interface Issue {
  number: number;
  title: string;
  body: string;
  author: { login: string };
}

interface DeviceRow {
  device: string;
  grade: string;
  native: string;
  wechatLoadMs: string;
  mainThreadMs: string;
  workerMs: string;
  issue: number;
  author: string;
}

/** Pull a single-cell value out of a two-column markdown table in the body. */
function cell(body: string, label: string): string | null {
  const row = new RegExp(`^\\|\\s*${label}\\s*\\|\\s*(.+?)\\s*\\|\\s*$`, "im").exec(body);
  return row?.[1]?.trim() ?? null;
}

function parse(issue: Issue): DeviceRow | null {
  const body = issue.body ?? "";
  // The grade line is the report's headline: **Compatibility: `strong`** — ...
  const grade = /\*\*Compatibility:\s*`([a-z]+)`\*\*/i.exec(body)?.[1];
  if (!grade) return null;

  // Engines table row: | `native` | no | `no-api` | ... |
  const nativeRow = /^\|\s*`native`\s*\|\s*(\w+)\s*\|\s*`?([\w-]*)`?\s*\|/im.exec(body);
  const native = nativeRow?.[1] === "yes" ? "available" : `\`${nativeRow?.[2] || "unavailable"}\``;

  const blocking = (transport: string): string => {
    const row = new RegExp(`^\\|\\s*${transport}[^|]*\\|\\s*([\\d.]+)\\s*ms`, "im").exec(body);
    return row?.[1] ? `${row[1]} ms` : "—";
  };

  return {
    // Strip the "device report: " prefix and the trailing grade the page adds.
    device: issue.title.replace(/^device report:\s*/i, "").replace(/\s*—\s*\w+$/, ""),
    grade,
    native,
    wechatLoadMs: /WeChat tier load[^*]*\*\*(\d+) ms\*\*/i.exec(body)?.[1] ?? "—",
    mainThreadMs: blocking("main thread"),
    workerMs: blocking("worker \\(default\\)"),
    issue: issue.number,
    author: issue.author?.login ?? "unknown",
  };
}

function render(rows: DeviceRow[]): string {
  if (!rows.length) {
    return "_No device reports submitted yet — run the [device report](https://zoexx.github.io/qrcode-decode-ultra/report.html) on your phone and press **Report this device**._";
  }
  const L: string[] = [];
  L.push(
    `_${rows.length} submitted device report${rows.length === 1 ? "" : "s"}, last folded in ${new Date().toISOString().slice(0, 10)}._`,
    "",
    "| Device | Grade | `native` | WeChat load | Escalated decode (worker) | (main thread) | Report |",
    "|---|---|---|---|---|---|---|",
  );
  for (const r of rows) {
    L.push(
      `| ${r.device} | \`${r.grade}\` | ${r.native} | ${r.wechatLoadMs === "—" ? "—" : `${r.wechatLoadMs} ms`} | ${r.workerMs} | ${r.mainThreadMs} | [#${r.issue}](https://github.com/${REPO}/issues/${r.issue}) |`,
    );
  }
  L.push("", "> Submitted by device owners, not measured in CI. Thanks to everyone who ran one.");
  return L.join("\n");
}

async function main(): Promise<void> {
  const { stdout } = await exec("gh", [
    "issue",
    "list",
    "--repo",
    REPO,
    "--label",
    "device-report",
    "--state",
    "all",
    "--limit",
    "200",
    "--json",
    "number,title,body,author",
  ]);

  const issues = JSON.parse(stdout) as Issue[];
  const rows = issues
    .map(parse)
    .filter((r): r is DeviceRow => r !== null)
    // Oldest first, so the table is stable as new reports arrive.
    .sort((a, b) => a.issue - b.issue);

  const skipped = issues.length - rows.length;
  if (skipped > 0) console.warn(`! skipped ${skipped} issue(s) with no parseable report body`);

  const markdown = render(rows);
  const start = "<!--DEVICES-->";
  const end = "<!--/DEVICES-->";
  const content = await readFile(README, "utf8");
  const s = content.indexOf(start);
  const e = content.indexOf(end);
  if (s === -1 || e === -1) throw new Error(`no ${start} / ${end} markers in README`);
  await writeFile(README, `${content.slice(0, s + start.length)}\n\n${markdown}\n\n${content.slice(e)}`);

  console.log(markdown);
  console.log(`\nfolded ${rows.length} device report(s) into the README`);
}

await main();
