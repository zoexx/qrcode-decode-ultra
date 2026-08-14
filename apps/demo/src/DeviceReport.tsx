import { useCallback, useRef, useState } from "react";
import { createScanner, type EngineId } from "qrcode-decode-ultra";
import {
  axesOf,
  environment,
  gradeOf,
  GRADE_TEXT,
  loadManifest,
  nativeFormats,
  probeCamera,
  runBlocking,
  runDetection,
  toMarkdown,
  type CompatAxes,
  type DeviceReport as Report,
} from "./probe.js";
import "./styles.css";
import "./report.css";

/** Must match the per-engine colours in styles.css. */
const ENGINE_COLOR: Record<string, string> = {
  native: "#6aa5ff",
  jsqr: "#4ade80",
  wechat: "#fbbf4c",
};

function Chip({ engine }: { engine: string }) {
  return (
    <span className="chip" data-engine={engine}>
      {engine}
    </span>
  );
}

function Rate({ hit, total }: { hit: number; total: number }) {
  const ratio = total ? hit / total : 0;
  return (
    <div className="rate">
      <div className="rate-bar">
        <div className="rate-fill" style={{ width: `${ratio * 100}%` }} data-full={hit === total} />
      </div>
      <span className="rate-text">
        {hit}/{total}
      </span>
    </div>
  );
}

/**
 * A short device name for an issue title. Deliberately crude — the full UA is
 * in the body; this only has to make a list of issues skimmable.
 */
function shortDevice(ua: string): string {
  const browser =
    /Firefox\/[\d.]+/.exec(ua)?.[0] ??
    /Edg\/[\d.]+/.exec(ua)?.[0] ??
    /Chrome\/[\d.]+/.exec(ua)?.[0] ??
    /Version\/([\d.]+).*Safari/.exec(ua)?.[0].replace(/Version\/([\d.]+).*/, "Safari $1") ??
    "unknown browser";
  const platform = /iPhone|iPad|Android|Macintosh|Windows|Linux|CrOS/.exec(ua)?.[0] ?? "unknown";
  return `${platform} · ${browser}`;
}

const AXIS_LABEL: Record<keyof CompatAxes, string> = {
  decode: "decodes at all",
  nativeTier: "platform native tier",
  strongTier: "wechat strong tier",
  offMainThread: "off the main thread",
  camera: "live camera",
};

/**
 * The headline. A grade is only useful next to the axes that produced it —
 * "strong" means nothing until you can see that it is `native` that is missing.
 */
function GradeBanner({ report }: { report: Report }) {
  const axes = axesOf(report.env, report.engines);
  const grade = gradeOf(axes);
  return (
    <section className="grade" data-grade={grade}>
      <div className="grade-head">
        <span className="grade-label">Compatibility</span>
        <b className="grade-value">{grade}</b>
      </div>
      <p className="grade-text">{GRADE_TEXT[grade]}</p>
      <div className="axes">
        {(Object.keys(AXIS_LABEL) as (keyof CompatAxes)[]).map((key) => (
          <span key={key} className="axis" data-ok={axes[key]}>
            {AXIS_LABEL[key]}
          </span>
        ))}
      </div>
    </section>
  );
}

function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="card">
      <h2>
        {title}
        {sub && <span className="card-sub">{sub}</span>}
      </h2>
      {children}
    </section>
  );
}

function EnvTable({ env }: { env: Report["env"] }) {
  const missing = Object.entries(env.features)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  return (
    <>
      <dl className="kv">
        <div>
          <dt>platform</dt>
          <dd>{env.platform}</dd>
        </div>
        <div>
          <dt>screen</dt>
          <dd>
            {env.screen} @ {env.devicePixelRatio}x
          </dd>
        </div>
        <div>
          <dt>cores</dt>
          <dd>{env.cores ?? "unknown"}</dd>
        </div>
        <div>
          <dt>memory</dt>
          <dd>{env.memoryGb ? `${env.memoryGb} GB` : "unreported"}</dd>
        </div>
      </dl>
      <p className="ua">{env.userAgent}</p>
      <div className="features">
        {Object.entries(env.features).map(([name, ok]) => (
          <span key={name} className="feature" data-ok={ok}>
            {name}
          </span>
        ))}
      </div>
      {!env.secureContext && (
        <p className="warn">
          Not a secure context — the camera will not start here. Use HTTPS or localhost.
        </p>
      )}
      {missing.includes("BarcodeDetector") && (
        <p className="note">
          No platform <code>BarcodeDetector</code>, so the <code>native</code> tier sits out and{" "}
          <code>jsqr</code> leads the cascade. Expected on iOS, Firefox, and desktop Linux.
        </p>
      )}
    </>
  );
}

export function DeviceReport() {
  const [report, setReport] = useState<Report | null>(null);
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const cameraRef = useRef<Report["camera"]>(null);
  const cameraErrRef = useRef<string | null>(null);

  const build = useCallback((partial: Partial<Report>): Report => {
    const next: Report = {
      generatedAt: new Date().toISOString(),
      env: environment(),
      engines: [],
      nativeFormats: null,
      wechatLoadMs: null,
      detection: null,
      blocking: null,
      camera: cameraRef.current,
      cameraError: cameraErrRef.current,
      ...partial,
    };
    // The CI compatibility matrix reads this instead of scraping the DOM.
    window.qrduReport = next;
    return next;
  }, []);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    setReport(null);
    setProgress(0);
    try {
      setStage("probing engines");
      // enableWechat is registered inside runDetection too, but the availability
      // list has to include the strong tier or the report reads as fast-only.
      const wechat = await import("qrcode-decode-ultra-wechat");
      wechat.enableWechat();
      const scanner = createScanner({ engines: "max-accuracy" });
      const engines = await scanner.ready();
      await scanner.dispose();
      const formats = await nativeFormats();
      setReport(build({ engines, nativeFormats: formats }));

      setStage("loading fixtures");
      const rows = await loadManifest();

      const onProgress = (done: number, total: number, label: string) => {
        setProgress(total ? done / total : 0);
        setStage(label);
      };

      const { detection, wechatLoadMs } = await runDetection(rows, onProgress);
      setReport(build({ engines, nativeFormats: formats, detection, wechatLoadMs }));

      setStage("measuring main-thread cost");
      setProgress(0);
      const blocking = await runBlocking(rows, onProgress);
      setReport(build({ engines, nativeFormats: formats, detection, wechatLoadMs, blocking }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
      setStage("");
      setProgress(0);
    }
  }, [build]);

  const addCamera = useCallback(async () => {
    try {
      cameraRef.current = await probeCamera();
      cameraErrRef.current = null;
    } catch (err) {
      cameraRef.current = null;
      cameraErrRef.current = err instanceof Error ? err.message : String(err);
    }
    setReport((prev) =>
      prev ? { ...prev, camera: cameraRef.current, cameraError: cameraErrRef.current } : build({}),
    );
  }, [build]);

  const markdown = report ? toMarkdown(report) : "";

  /**
   * A prefilled "new issue" link. The title carries the grade and a short device
   * name so the matrix can be assembled from issue titles alone, and the
   * `device-report` label is what the aggregation script filters on.
   *
   * Long bodies are dropped rather than truncated: GitHub silently cuts an
   * over-long querystring, and half a report in an issue is worse than a prompt
   * to paste the whole one.
   */
  const issueUrl = (() => {
    const base = "https://github.com/zoexx/qrcode-decode-ultra/issues/new";
    if (!report) return base;
    const axes = axesOf(report.env, report.engines);
    const title = `device report: ${shortDevice(report.env.userAgent)} — ${gradeOf(axes)}`;
    const params = new URLSearchParams({ title, labels: "device-report" });
    const withBody = new URLSearchParams(params);
    withBody.set("body", markdown);
    const url = `${base}?${withBody}`;
    return url.length < 6000 ? url : `${base}?${params}`;
  })();

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("Clipboard blocked — select the text below and copy manually.");
    }
  }, [markdown]);

  const cats = report?.detection ? Object.keys(Object.values(report.detection)[0]?.byCategory ?? {}) : [];

  return (
    <main className="shell report-shell">
      <header className="topbar">
        <div className="headings">
          <div className="masthead">
            <span className="dot" data-live={running} />
            <h1>Device report</h1>
          </div>
          <p className="tagline">
            Replays the committed benchmark fixtures <b>on this device</b>, then hands you the
            numbers as markdown. The Node and headless-CI runners cannot see a phone — this can.
          </p>
        </div>
        <div className="controls">
          <a className="tab" href="./index.html">
            ← Live demo
          </a>
        </div>
      </header>

      <div className="actions">
        <button className="run" onClick={() => void run()} disabled={running}>
          {running ? "Running…" : report ? "Run again" : "Run device report"}
        </button>
        <button className="run secondary" onClick={() => void addCamera()} disabled={running}>
          {report?.camera ? "Re-probe camera" : "Add camera probe"}
        </button>
        <span className="hint">
          The sweep takes ~10-60s and downloads the 2.5MB WeChat model. The camera probe asks for
          permission, reads the track settings, and stops the stream immediately.
        </span>
      </div>

      {running && (
        <div className="progress">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progress * 100}%` }} />
          </div>
          <span className="progress-label">{stage}</span>
        </div>
      )}

      {error && <p className="warn">{error}</p>}

      {report && (
        <div className="report">
          <GradeBanner report={report} />

          <Section title="Device">
            <EnvTable env={report.env} />
          </Section>

          <Section title="Engines" sub="availability is a real decode probe, not a feature check">
            <ul className="engines">
              {report.engines.map((e) => (
                <li key={e.engine}>
                  <Chip engine={e.engine} />
                  <span className="engine-state" data-ok={e.available}>
                    {e.available ? "available" : "unavailable"}
                  </span>
                  {e.code && <code className="engine-code">{e.code}</code>}
                  {e.reason && <span className="engine-reason">{e.reason}</span>}
                </li>
              ))}
            </ul>
            {report.engines.some((e) => e.code === "no-api") && (
              <p className="note">
                <code>no-api</code> is a property of the browser, not a fault on this device — that
                tier can never run here, and the cascade is designed to carry on without it.
              </p>
            )}
            {report.engines.some((e) => e.code === "probe-failed") && (
              <p className="warn">
                <code>probe-failed</code> means the platform claims to support QR and decoded a
                known-good frame incorrectly. That is a browser bug worth reporting — please open an
                issue with this report attached.
              </p>
            )}
            <p className="note">
              Platform <code>BarcodeDetector</code> reports:{" "}
              {report.nativeFormats
                ? report.nativeFormats.length
                  ? report.nativeFormats.join(", ")
                  : "no formats"
                : "not present on this device"}
            </p>
            {report.wechatLoadMs != null && (
              <p className="note">
                WeChat tier load — fetch and instantiate —{" "}
                <b style={{ color: ENGINE_COLOR.wechat }}>{Math.round(report.wechatLoadMs)} ms</b> on
                this device and this network.
              </p>
            )}
          </Section>

          {report.detection && (
            <Section title="Detection rate" sub={`${cats.length} categories, same pixels to every tier`}>
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Preset</th>
                      {cats.map((c) => (
                        <th key={c}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(report.detection).map(([preset, score]) => (
                      <tr key={preset}>
                        <th scope="row">{preset}</th>
                        {cats.map((c) => {
                          const s = score.byCategory[c] ?? { hit: 0, total: 0 };
                          return (
                            <td key={c}>
                              <Rate hit={s.hit} total={s.total} />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h3>Which tier actually won</h3>
              <div className="wins">
                {Object.entries(report.detection).map(([preset, score]) => (
                  <div key={preset} className="wins-group">
                    <span className="wins-preset">{preset}</span>
                    {Object.entries(score.wins).length === 0 && <span className="muted">nothing decoded</span>}
                    {Object.entries(score.wins).map(([engine, n]) => (
                      <span key={engine} className="win">
                        <Chip engine={engine} />
                        {n} fixtures
                        <span className="muted">
                          {" · "}
                          {score.medianMs[engine as EngineId]?.toFixed(1) ?? "—"} ms median
                        </span>
                      </span>
                    ))}
                    {score.falsePositives > 0 && (
                      <span className="win danger">{score.falsePositives} false positives</span>
                    )}
                  </div>
                ))}
              </div>
            </Section>
          )}

          {report.blocking && (
            <Section title="Main-thread cost" sub="one escalated decode, worker vs main thread">
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Transport</th>
                      <th>per decode</th>
                      <th>longest task</th>
                      <th>longest frame gap</th>
                      <th>frames dropped</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(report.blocking).map(([name, s]) => (
                      <tr key={name} data-bad={!s.longTaskSupported ? undefined : s.longestTaskMs > 100}>
                        <th scope="row">{name}</th>
                        <td>{s.wallMs.toFixed(0)} ms</td>
                        <td>{s.longTaskSupported ? `${s.longestTaskMs.toFixed(0)} ms` : "n/a"}</td>
                        <td>{s.longestFrameGapMs.toFixed(0)} ms</td>
                        <td>{s.framesDropped}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="note">
                A task over 50ms is what the browser itself calls blocking; over ~100ms a tap feels
                unresponsive. <code>frames dropped</code> is what a 60fps preview loses. The gap
                between these two rows is the entire reason the WeChat tier ships its own worker.
                {Object.values(report.blocking).some((s) => !s.longTaskSupported) && (
                  <> Safari has no <code>longtask</code> observer, so read the frame gap instead.</>
                )}
              </p>
            </Section>
          )}

          {(report.camera || report.cameraError) && (
            <Section title="Rear camera" sub="what the device actually hands the cascade">
              {report.camera ? (
                <dl className="kv">
                  <div>
                    <dt>resolution</dt>
                    <dd>
                      {report.camera.width ?? "?"}x{report.camera.height ?? "?"}
                    </dd>
                  </div>
                  <div>
                    <dt>frame rate</dt>
                    <dd>{report.camera.frameRate ?? "?"} fps</dd>
                  </div>
                  <div>
                    <dt>facing</dt>
                    <dd>{report.camera.facingMode ?? "unreported"}</dd>
                  </div>
                  <div>
                    <dt>video inputs</dt>
                    <dd>{report.camera.videoInputs}</dd>
                  </div>
                  <div>
                    <dt>torch</dt>
                    <dd>{report.camera.torch ? "yes" : "no / unreported"}</dd>
                  </div>
                  <div>
                    <dt>focus modes</dt>
                    <dd>{report.camera.focusModes.join(", ") || "unreported"}</dd>
                  </div>
                </dl>
              ) : (
                <p className="warn">{report.cameraError}</p>
              )}
            </Section>
          )}

          <Section title="Share this report" sub="real-device rows are the ones CI cannot produce">
            <div className="copyrow">
              <button className="run" onClick={() => void copy()}>
                {copied ? "Copied" : "Copy markdown"}
              </button>
              <a className="run secondary" href={issueUrl} target="_blank" rel="noreferrer">
                Report this device
              </a>
            </div>
            <p className="hint">
              Opens a prefilled GitHub issue. Nothing is sent anywhere until you press submit there
              — this page has no backend and makes no network calls of its own.
            </p>
            <textarea className="md" readOnly value={markdown} rows={14} spellCheck={false} />
          </Section>
        </div>
      )}
    </main>
  );
}
