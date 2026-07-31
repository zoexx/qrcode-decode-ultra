import { useEffect, useMemo, useState } from "react";
import { createScanner } from "qrcode-decode-ultra";
import { useScanner, type ScanResult } from "qrcode-decode-ultra-react";

type Preset = "fast" | "max-accuracy";
type Tab = "camera" | "image";

/**
 * How many codes to look for when the multi toggle is on.
 *
 * On `native` this is free — one pass returns everything. On `jsqr`/`wechat` it
 * bounds the extra passes, and the sweep stops early once it has this many, so
 * the number is a real cost knob rather than just a cap on the output.
 */
const MAX_CODES = 10;

const card: React.CSSProperties = {
  border: "1px solid #ddd",
  borderRadius: 8,
  padding: 12,
  marginTop: 12,
  fontFamily: "monospace",
  fontSize: 13,
  background: "#fafafa",
};

// Keyed to what each tier costs, so which one won is readable at a glance:
// blue = free (platform), green = cheap (~30KB JS), amber = the heavy escalation.
// All three carry white text at >=4.9:1 contrast.
const ENGINE_COLOR: Record<string, string> = {
  native: "#1d4ed8",
  jsqr: "#15803d",
  wechat: "#b45309",
};

function EngineBadge({ engine, dim }: { engine: string; dim?: boolean }) {
  return (
    <span
      style={{
        background: dim ? "#e5e7eb" : (ENGINE_COLOR[engine] ?? "#374151"),
        color: dim ? "#6b7280" : "#fff",
        fontWeight: 700,
        fontSize: 14,
        letterSpacing: 0.4,
        padding: "3px 12px",
        borderRadius: 999,
        fontFamily: "monospace",
      }}
    >
      {engine}
    </span>
  );
}

/** The cascade, in order — the winning tier lights up, the rest stay grey. */
function CascadeLegend({ preset, winner }: { preset: Preset; winner?: string }) {
  const tiers = preset === "max-accuracy" ? ["native", "jsqr", "wechat"] : ["native", "jsqr"];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "12px 0", fontSize: 13 }}>
      {tiers.map((t, i) => (
        <span key={t} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {i > 0 && <span style={{ color: "#9ca3af" }}>→</span>}
          <EngineBadge engine={t} dim={winner !== t} />
        </span>
      ))}
    </div>
  );
}

function ResultCard({ r }: { r: ScanResult }) {
  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ color: "#666" }}>decoded by</span>
        <EngineBadge engine={r.engine} />
        <span style={{ color: "#666", marginLeft: "auto" }}>
          {r.timing.totalMs.toFixed(1)}ms{r.timing.coldStart ? " · cold start" : ""}
        </span>
      </div>
      <div style={{ wordBreak: "break-all" }}>
        <strong>value:</strong> {r.value}
      </div>
      <div>
        <strong>format:</strong> {r.format}
      </div>
    </div>
  );
}

/** "N codes in this frame" — shown once more than one code came back. */
function ResultCount({ n }: { n: number }) {
  if (n === 0) return null;
  return (
    <p style={{ fontSize: 15, fontWeight: 600, margin: "8px 0 0" }}>
      {n} code{n === 1 ? "" : "s"} in this frame
      {n > 1 && (
        <span style={{ fontWeight: 400, color: "#666", fontSize: 13 }}>
          {" "}
          — one scan, not one-at-a-time
        </span>
      )}
    </p>
  );
}

function CameraView({ preset, multi }: { preset: Preset; multi: boolean }) {
  const { videoRef, status, error, result, results } = useScanner({
    engines: preset,
    maxCodesPerFrame: multi ? MAX_CODES : 1,
  });

  return (
    <div>
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        style={{ width: "100%", maxWidth: 480, background: "#000", borderRadius: 8 }}
      />
      <p style={{ fontFamily: "monospace", fontSize: 13, marginBottom: 0 }}>
        status: {status}
        {error ? ` — error: ${error.message}` : ""}
      </p>
      <CascadeLegend preset={preset} winner={result?.engine} />
      <p style={{ color: "#666", fontSize: 12 }}>
        Point the camera at a QR code. A clean QR decodes via native/jsQR with no WASM. In{" "}
        <code>max-accuracy</code>, a low-resolution frame preloads the WeChat tier and a fast-path
        miss escalates to it in its own worker.
      </p>
      {multi && (
        <p style={{ color: "#666", fontSize: 12 }}>
          Multi is on. Where <code>native</code> exists this stays full-rate — it returns every code
          in the same single pass. Without it, the jsQR tile sweep costs whole seconds per frame, so
          the scan rate drops; frames are skipped while one is in flight, never queued.
        </p>
      )}
      <ResultCount n={results.length} />
      {results.map((r, i) => (
        <ResultCard key={i} r={r} />
      ))}
    </div>
  );
}

function ImageView({ preset, multi }: { preset: Preset; multi: boolean }) {
  // Default transport: the fast path runs in core's worker and a miss escalates
  // to the WeChat tier's own worker, same as the camera tab. A WeChat decode is
  // ~250ms, so even for a one-off still image it is worth keeping off the main
  // thread.
  const scanner = useMemo(
    () => createScanner({ engines: preset, maxCodesPerFrame: multi ? MAX_CODES : 1 }),
    [preset, multi],
  );
  const [results, setResults] = useState<ScanResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>("");

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setMsg("");
    setResults([]);
    try {
      // Lazy-load the heavy WeChat tier only when it's actually selected.
      if (preset === "max-accuracy") {
        setMsg("loading WeChat engine (~2.5MB gzipped, first time only)...");
        const wechat = await import("qrcode-decode-ultra-wechat");
        wechat.enableWechat();
      }
      const found = await scanner.scanImage(file);
      setResults(found);
      // Clear the "loading..." notice on success, not just on a miss.
      setMsg(found.length === 0 ? "No code found." : "");
    } catch (err) {
      setMsg(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <input type="file" accept="image/*" onChange={onFile} />
      <CascadeLegend preset={preset} winner={results[0]?.engine} />
      <p style={{ fontFamily: "monospace", fontSize: 13 }}>{busy ? "scanning..." : msg}</p>
      <ResultCount n={results.length} />
      {results.map((r, i) => (
        <ResultCard key={i} r={r} />
      ))}
    </div>
  );
}

export function App() {
  const [preset, setPreset] = useState<Preset>("fast");
  const [tab, setTab] = useState<Tab>("camera");
  const [multi, setMulti] = useState(false);

  // Lazy-register WeChat when max-accuracy is selected, so the camera tab can
  // escalate to it too (the image tab also enables it on first file).
  useEffect(() => {
    if (preset === "max-accuracy") {
      void import("qrcode-decode-ultra-wechat").then((m) => m.enableWechat());
    }
  }, [preset]);

  return (
    <main style={{ maxWidth: 560, margin: "32px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ marginBottom: 4 }}>QRCode Decode Ultra</h1>
      <p style={{ color: "#666", marginTop: 0 }}>
        native &rarr; jsQR fast path in a Web Worker, escalating to the WeChat tier for low-res
        codes.
      </p>

      <div style={{ display: "flex", gap: 8, margin: "16px 0" }}>
        <button onClick={() => setTab("camera")} disabled={tab === "camera"}>
          Camera
        </button>
        <button onClick={() => setTab("image")} disabled={tab === "image"}>
          Image
        </button>
        <span style={{ flex: 1 }} />
        <label style={{ fontSize: 13 }}>
          preset:{" "}
          <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
            <option value="fast">fast (native+jsQR, QR-only, no WASM)</option>
            <option value="max-accuracy">max-accuracy (+WeChat for low-res)</option>
          </select>
        </label>
      </div>

      <label style={{ fontSize: 13, display: "block", marginBottom: 8 }}>
        <input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} /> find
        every code in the frame (<code>maxCodesPerFrame: {MAX_CODES}</code>)
      </label>
      {multi && (
        <p style={{ color: "#666", fontSize: 12, margin: "0 0 8px" }}>
          <code>native</code> returns them all in the same pass, for free. <code>wechat</code> costs
          one extra decode per code found; <code>jsqr</code> sweeps overlapping tiles at a fixed
          cost whether the frame holds ten codes or one.
        </p>
      )}

      {/* Both props are in the key: the hook builds its scanner once, so a
          changed engine list or code cap only takes effect on a fresh mount. */}
      {tab === "camera" ? (
        <CameraView key={`${preset}-${multi}`} preset={preset} multi={multi} />
      ) : (
        <ImageView preset={preset} multi={multi} />
      )}
    </main>
  );
}
