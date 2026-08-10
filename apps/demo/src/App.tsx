import { useCallback, useEffect, useRef, useState } from "react";
import { createScanner, type Scanner } from "qrcode-decode-ultra";
import { useScanner, type RaceLeg, type RaceReport, type ScanResult } from "qrcode-decode-ultra-react";
import { ScreenRecorder } from "./ScreenRecorder.js";
import "./styles.css";

type Preset = "fast" | "max-accuracy";
type Tab = "camera" | "image";
/** Frames won per lane, across the session. */
type Tally = { fast: number; strong: number };

/**
 * How many codes to look for when the multi toggle is on.
 *
 * On `native` this is free — one pass returns everything. On `jsqr`/`wechat` it
 * bounds the extra passes, and the sweep stops early once it has this many, so
 * the number is a real cost knob rather than just a cap on the output.
 */
const MAX_CODES = 10;

/**
 * Full width on a race bar, in ms. Fixed rather than "scale to the slowest lane"
 * so the bars mean the same thing from frame to frame — a fast-path win looks
 * like a sliver every time instead of rescaling itself to full width whenever it
 * happens to be alone. Raised only if a lane actually exceeds it.
 */
const RACE_SCALE_MS = 300;

/** Must match the per-engine colours in styles.css — same tier, same colour,
 * whether it appears as a chip, a race bar, or the box drawn over a code. */
const ENGINE_COLOR: Record<string, string> = {
  native: "#6aa5ff",
  jsqr: "#4ade80",
  wechat: "#fbbf4c",
};

function Chip({ engine, dim }: { engine: string; dim?: boolean }) {
  return (
    <span className="chip" data-engine={engine} data-dim={dim || undefined}>
      {engine}
    </span>
  );
}

/** The cascade, in order — the winning tier lights up, the rest stay grey. */
function CascadeLegend({ preset, winner }: { preset: Preset; winner?: string }) {
  const tiers = preset === "max-accuracy" ? ["native", "jsqr", "wechat"] : ["native", "jsqr"];
  return (
    <div className="legend">
      {tiers.map((tier, i) => (
        <span key={tier} className="legend-item">
          {i > 0 && <span className="arrow">→</span>}{" "}
          <Chip engine={tier} dim={winner !== tier} />
        </span>
      ))}
    </div>
  );
}

function laneTime(leg: RaceLeg): { text: string; muted: boolean } {
  if (leg.ms != null && (leg.outcome === "hit" || leg.outcome === "miss")) {
    return { text: leg.ms.toFixed(1), muted: false };
  }
  if (leg.outcome === "busy") return { text: "busy", muted: true };
  if (leg.outcome === "error") return { text: "died", muted: true };
  return { text: "···", muted: true };
}

function Lane({ leg, scale, winner }: { leg: RaceLeg; scale: number; winner: boolean }) {
  const time = laneTime(leg);
  const width = leg.ms != null ? Math.max(2, Math.min(100, (leg.ms / scale) * 100)) : 0;
  return (
    <div
      className="lane"
      data-lane={leg.lane}
      data-state={leg.outcome}
      data-winner={winner || undefined}
      data-cold={leg.cold || undefined}
    >
      <div className="lane-label">
        {leg.engines.map((engine) => (
          <Chip key={engine} engine={engine} dim={leg.outcome === "busy"} />
        ))}
      </div>
      <div className="lane-track">
        <div className="lane-fill" style={{ width: `${width}%` }} />
      </div>
      <div className="lane-ms" data-muted={time.muted || undefined}>
        {time.text}
        {!time.muted && <span>ms</span>}
      </div>
      {/* A cold lane's time is a 2.5MB download with a decode on the end — say so
          rather than let it read as this tier's per-frame cost. */}
      <div className="lane-flag">{leg.cold ? "COLD" : winner ? "WON" : ""}</div>
    </div>
  );
}

/** Idle bars, before the first frame has been raced. */
const IDLE_LEGS: RaceLeg[] = [
  { lane: "fast", engines: ["native", "jsqr"], outcome: "pending" },
  { lane: "strong", engines: ["wechat"], outcome: "pending" },
];

function RaceMeter({ report, tally }: { report: RaceReport | null; tally: Tally }) {
  const legs = report?.legs ?? IDLE_LEGS;
  // A cold lane is off the scale by orders of magnitude (a 2.5MB model load, not
  // a decode); letting it set the scale would squash every real bar to nothing.
  const scale = Math.max(RACE_SCALE_MS, ...legs.map((l) => (l.cold ? 0 : (l.ms ?? 0))));
  return (
    <section className="race">
      <div className="race-head">
        <span className="race-title">Race</span>
        <span className="race-sub">both workers, same frame</span>
        <span className="tally">
          frames won <b>fast {tally.fast}</b> · <b>wechat {tally.strong}</b>
        </span>
      </div>
      {legs.map((leg) => (
        <Lane key={leg.lane} leg={leg} scale={scale} winner={report?.winner === leg.lane} />
      ))}
      <p className="race-foot">
        Both workers get the same pixels. The first real decode wins and is returned immediately —
        the slower lane keeps running only so its time can be measured, and is skipped, never queued,
        on any frame that starts while it is still busy.
        {legs.some((l) => l.cold) && (
          <>
            {" "}
            <b>Cold</b> means that lane was still fetching its 2.5MB model, so its time is a one-time
            load, not a decode. The next frame is the real one.
          </>
        )}
      </p>
    </section>
  );
}

/**
 * Draws the decoded code's `cornerPoints` over the video or image.
 *
 * The source is displayed with its aspect ratio intact, so one scale factor maps
 * source pixels to layout pixels; the canvas is sized in device pixels so the
 * box stays crisp on a retina screen (and in a screen recording).
 */
function CodeOverlay({
  targetRef,
  results,
}: {
  targetRef: React.RefObject<HTMLVideoElement | HTMLImageElement | null>;
  results: ScanResult[];
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const draw = useCallback(() => {
    const el = targetRef.current;
    const canvas = canvasRef.current;
    if (!el || !canvas) return;
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    const sw = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
    const sh = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (!sw || !sh) return;

    const scale = Math.min(cw / sw, ch / sh);
    const dx = (cw - sw * scale) / 2;
    const dy = (ch - sh * scale) / 2;

    for (const result of results) {
      const corners = result.cornerPoints;
      if (!corners || corners.length < 3) continue;
      const points = corners.map((p) => ({ x: dx + p.x * scale, y: dy + p.y * scale }));
      const color = ENGINE_COLOR[result.engine] ?? "#ffffff";

      ctx.beginPath();
      points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = `${color}24`;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.lineJoin = "round";
      ctx.stroke();

      for (const p of points) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }
    }
  }, [results, targetRef]);

  useEffect(() => {
    draw();
    const el = targetRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // The video has no size until metadata lands, and the image none until it
    // decodes — both arrive as a resize, after the first results may already be in.
    const observer = new ResizeObserver(draw);
    observer.observe(el);
    return () => observer.disconnect();
  }, [draw, targetRef]);

  return <canvas ref={canvasRef} className="overlay" aria-hidden="true" />;
}

function ResultCard({ result }: { result: ScanResult }) {
  return (
    <div className="result">
      <div className="result-head">
        decoded by <Chip engine={result.engine} />
        <span className="result-time">
          {result.timing.totalMs.toFixed(1)}ms{result.timing.coldStart ? " · cold start" : ""}
        </span>
      </div>
      <dl>
        <div className="result-row">
          <dt>value</dt>
          <dd>{result.value}</dd>
        </div>
        <div className="result-row">
          <dt>format</dt>
          <dd>{result.format}</dd>
        </div>
      </dl>
    </div>
  );
}

/** "N codes in this frame" — shown once more than one code came back. */
function ResultCount({ n }: { n: number }) {
  if (n === 0) return null;
  return (
    <p className="count">
      {n} code{n === 1 ? "" : "s"} in this frame
      {n > 1 && <span> — one scan, not one-at-a-time</span>}
    </p>
  );
}

/** Count a frame for whichever lane won it, once it has fully landed. */
function useTally(): [Tally, (report: RaceReport) => void] {
  const [tally, setTally] = useState<Tally>({ fast: 0, strong: 0 });
  const count = useCallback((report: RaceReport) => {
    const winner = report.winner;
    // Only the complete report is final, and only it fires exactly once a frame.
    if (!report.complete || !winner) return;
    setTally((t) => ({ ...t, [winner]: t[winner] + 1 }));
  }, []);
  return [tally, count];
}

interface ViewProps {
  preset: Preset;
  multi: boolean;
  race: boolean;
  /**
   * The toggles and their explanatory notes. Owned by `App` because they drive
   * it, but rendered at the top of whichever view is on screen so they sit in
   * the right rail beside the stage rather than pushing it down the page.
   */
  panel: React.ReactNode;
}

const CAMERA_PLACEHOLDER: Record<string, string> = {
  idle: "Starting camera…",
  requesting: "Waiting for camera permission…",
  error: "Camera unavailable",
  stopped: "Camera stopped",
};

function CameraView({
  preset,
  multi,
  race,
  panel,
  onLive,
}: ViewProps & { onLive: (live: boolean) => void }) {
  const [tally, countRace] = useTally();
  const { videoRef, status, error, result, results, race: report } = useScanner({
    engines: preset,
    maxCodesPerFrame: multi ? MAX_CODES : 1,
    race,
    onRace: countRace,
  });

  // Keep the masthead's live dot honest — it should mean "frames are flowing",
  // not "the camera tab is open".
  useEffect(() => {
    onLive(status === "scanning");
    return () => onLive(false);
  }, [status, onLive]);

  // Two siblings, not one wrapper: they are the two columns of `.layout`, so a
  // fragment keeps them as direct grid children.
  return (
    <>
      <section className="stage-col">
        <div className="stage" data-hit={results.length > 0}>
          <video ref={videoRef} playsInline muted autoPlay />
          <CodeOverlay targetRef={videoRef} results={results} />
          {status !== "scanning" && (
            <div className="stage-placeholder">{CAMERA_PLACEHOLDER[status] ?? status}</div>
          )}
        </div>
        <p className="statusline">
          <span>status: {status}</span>
          {error && <span className="err">— {error.message}</span>}
        </p>
      </section>

      <aside className="side">
        {panel}
        {race ? (
          <RaceMeter report={report} tally={tally} />
        ) : (
          <CascadeLegend preset={preset} winner={result?.engine} />
        )}
        <div className="results">
          <ResultCount n={results.length} />
          {results.map((r, i) => (
            <ResultCard key={i} result={r} />
          ))}
        </div>
      </aside>
    </>
  );
}

function ImageView({ preset, multi, race, panel }: ViewProps) {
  const [tally, countRace] = useTally();
  const [report, setReport] = useState<RaceReport | null>(null);
  const [results, setResults] = useState<ScanResult[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const imgRef = useRef<HTMLImageElement | null>(null);

  // Built on first use and thrown away whenever the options change, so a toggle
  // doesn't leak a pair of workers.
  //
  // Lazily, via a ref, rather than `useMemo` + dispose-on-cleanup: StrictMode's
  // dev double-mount runs the cleanup once for real, which would dispose the
  // memoized scanner and leave every later scan throwing "Scanner disposed".
  // Nulling the ref means the next scan simply builds a fresh one.
  const scannerRef = useRef<Scanner | null>(null);
  const signature = `${preset}-${multi}-${race}`;

  useEffect(
    () => () => {
      void scannerRef.current?.dispose();
      scannerRef.current = null;
    },
    [signature],
  );
  useEffect(() => () => (preview ? URL.revokeObjectURL(preview) : undefined), [preview]);

  // Default transport: the fast path runs in core's worker and the WeChat tier in
  // its own, same as the camera tab. A WeChat decode is ~250ms, so even for a
  // one-off still image it is worth keeping off the main thread.
  const getScanner = (): Scanner => {
    scannerRef.current ??= createScanner({
      engines: preset,
      maxCodesPerFrame: multi ? MAX_CODES : 1,
      race,
      onRace: (r) => {
        setReport(r);
        countRace(r);
      },
    });
    return scannerRef.current;
  };

  const scan = async (blob: Blob) => {
    setBusy(true);
    setMessage("");
    setResults([]);
    setReport(null);
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(blob);
    });
    try {
      // Lazy-load the heavy WeChat tier only when it's actually selected.
      if (preset === "max-accuracy") {
        setMessage("loading WeChat engine (~2.5MB gzipped, first time only)...");
        const wechat = await import("qrcode-decode-ultra-wechat");
        wechat.enableWechat();
      }
      const found = await getScanner().scanImage(blob);
      setResults(found);
      // Clear the "loading..." notice on success, not just on a miss.
      setMessage(found.length === 0 ? "No code found." : "");
    } catch (err) {
      setMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void scan(file);
  };

  const onSample = async (name: string) => {
    // Same path as a picked file — scanImage takes any Blob.
    const res = await fetch(name);
    void scan(await res.blob());
  };

  return (
    <>
      <section className="stage-col">
        <div className="pickrow">
          <label className="picker">
            <input type="file" accept="image/*" onChange={onFile} />
            Choose an image…
          </label>
          <span className="samples">
            or try{" "}
            <button type="button" onClick={() => void onSample("/qr-clean.png")}>
              a clean QR
            </button>{" "}
            ·{" "}
            <button type="button" onClick={() => void onSample("/qr-hard.png")}>
              a low-res one
            </button>
          </span>
        </div>

        <div className="stage" data-hit={results.length > 0}>
          {preview ? (
            <>
              <img ref={imgRef} src={preview} alt="" />
              <CodeOverlay targetRef={imgRef} results={results} />
            </>
          ) : (
            <div className="stage-empty">
              Pick a photo of a QR code.
              <br />A low-resolution or damaged one is where the WeChat tier earns its 2.5MB.
            </div>
          )}
        </div>
        <p className="statusline">{busy ? "scanning…" : message}</p>
      </section>

      <aside className="side">
        {panel}
        {race ? (
          <RaceMeter report={report} tally={tally} />
        ) : (
          <CascadeLegend preset={preset} winner={results[0]?.engine} />
        )}
        <div className="results">
          <ResultCount n={results.length} />
          {results.map((r, i) => (
            <ResultCard key={i} result={r} />
          ))}
        </div>
      </aside>
    </>
  );
}

export function App() {
  const [preset, setPreset] = useState<Preset>("fast");
  const [tab, setTab] = useState<Tab>("camera");
  const [multi, setMulti] = useState(false);
  const [race, setRace] = useState(false);
  const [live, setLive] = useState(false);

  // Lazy-register WeChat when max-accuracy is selected, so the camera tab can
  // escalate to it too (the image tab also enables it on first file).
  useEffect(() => {
    if (preset === "max-accuracy") {
      void import("qrcode-decode-ultra-wechat").then((m) => m.enableWechat());
    }
  }, [preset]);

  // Racing needs a second worker to race against, so the two controls move
  // together rather than leaving `race` quietly doing nothing under `fast`.
  const onPreset = (next: Preset) => {
    setPreset(next);
    if (next === "fast") setRace(false);
  };
  const onRace = (next: boolean) => {
    setRace(next);
    if (next) setPreset("max-accuracy");
  };

  const panel = (
    <div className="panel-top">
      <div className="toggles">
        <label className="toggle">
          <input type="checkbox" checked={race} onChange={(e) => onRace(e.target.checked)} />
          <span>
            race both workers <span className="hint">— same frame to each, first decode wins</span>
          </span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} />
          <span>
            find every code in the frame{" "}
            <span className="hint">
              — <code>maxCodesPerFrame: {MAX_CODES}</code>
            </span>
          </span>
        </label>
      </div>

      {multi && (
        <p className="note">
          <code>native</code> returns them all in the same pass, for free. <code>wechat</code> costs
          one extra decode per code found; <code>jsqr</code> sweeps overlapping tiles at a fixed cost
          whether the frame holds ten codes or one.
        </p>
      )}
      {race && (
        <p className="note">
          Racing is opt-in because it is not free: the WeChat tier decodes every frame instead of
          only the ones the fast path missed. The default cascade never wakes it for a code{" "}
          <code>jsqr</code> already read.
        </p>
      )}
    </div>
  );

  return (
    <main className="shell">
      <header className="topbar">
        <div className="headings">
          <div className="masthead">
            <span className="dot" data-live={live} />
            <h1>QRCode Decode Ultra</h1>
          </div>
          <p className="tagline">
            {race ? (
              <>
                One frame, both workers, at the same time. The first real decode wins — and the
                meter shows which tier got there first, on this device, on this code.
              </>
            ) : (
              <>
                <code>native → jsQR</code> fast path in a Web Worker, escalating to the WeChat tier
                in a second worker only when the fast path misses.
              </>
            )}
          </p>
        </div>

        <div className="controls">
          <div className="tabs" role="tablist">
            <button
              className="tab"
              role="tab"
              aria-selected={tab === "camera"}
              onClick={() => setTab("camera")}
            >
              Camera
            </button>
            <button
              className="tab"
              role="tab"
              aria-selected={tab === "image"}
              onClick={() => setTab("image")}
            >
              Image
            </button>
          </div>
          <select
            className="select"
            value={preset}
            onChange={(e) => onPreset(e.target.value as Preset)}
            aria-label="engine preset"
          >
            <option value="fast">fast — native + jsQR, no WASM</option>
            <option value="max-accuracy">max-accuracy — + WeChat</option>
          </select>
          <ScreenRecorder />
        </div>
      </header>

      {/* Every prop is in the key: the scanner is built once per mount, so a
          changed engine list, code cap, or transport only takes effect fresh. */}
      <div className="layout">
        {tab === "camera" ? (
          <CameraView
            key={`${preset}-${multi}-${race}`}
            preset={preset}
            multi={multi}
            race={race}
            panel={panel}
            onLive={setLive}
          />
        ) : (
          <ImageView preset={preset} multi={multi} race={race} panel={panel} />
        )}
      </div>
    </main>
  );
}
