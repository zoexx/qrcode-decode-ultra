import { useEffect, useMemo, useState } from "react";
import { createScanner } from "qrcode-decode-ultra";
import { useScanner, type ScanResult } from "qrcode-decode-ultra-react";

type Preset = "fast" | "max-accuracy";
type Tab = "camera" | "image";

const card: React.CSSProperties = {
  border: "1px solid #ddd",
  borderRadius: 8,
  padding: 12,
  marginTop: 12,
  fontFamily: "monospace",
  fontSize: 13,
  background: "#fafafa",
};

function ResultCard({ r }: { r: ScanResult }) {
  return (
    <div style={card}>
      <div>
        <strong>value:</strong> {r.value}
      </div>
      <div>
        <strong>format:</strong> {r.format} &nbsp; <strong>engine:</strong> {r.engine}
      </div>
      <div>
        <strong>time:</strong> {r.timing.totalMs.toFixed(1)}ms{" "}
        {r.timing.coldStart ? "(cold start — WASM loaded)" : ""}
      </div>
    </div>
  );
}

function CameraView({ preset }: { preset: Preset }) {
  const [result, setResult] = useState<ScanResult | null>(null);
  const { videoRef, status, error } = useScanner({
    engines: preset,
    onResult: setResult,
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
      <p style={{ fontFamily: "monospace", fontSize: 13 }}>
        status: {status}
        {error ? ` — error: ${error.message}` : ""}
      </p>
      <p style={{ color: "#666", fontSize: 12 }}>
        Point the camera at a QR code. A clean QR decodes via native/jsQR with no WASM. In{" "}
        <code>max-accuracy</code>, a low-resolution frame preloads the WeChat tier and a fast-path
        miss escalates to it (in-process).
      </p>
      {result ? <ResultCard r={result} /> : null}
    </div>
  );
}

function ImageView({ preset }: { preset: Preset }) {
  // worker:false so the in-process WeChat engine (max-accuracy) runs the whole
  // cascade on the main thread; still images don't need a worker anyway.
  const scanner = useMemo(() => createScanner({ engines: preset, worker: false }), [preset]);
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
        setMsg("loading WeChat engine (~2.5MB, first time only)...");
        const wechat = await import("qrcode-decode-ultra-wechat");
        wechat.enableWechat();
      }
      const found = await scanner.scanImage(file);
      setResults(found);
      if (found.length === 0) setMsg("No code found.");
    } catch (err) {
      setMsg(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <input type="file" accept="image/*" onChange={onFile} />
      <p style={{ fontFamily: "monospace", fontSize: 13 }}>{busy ? "scanning..." : msg}</p>
      {results.map((r, i) => (
        <ResultCard key={i} r={r} />
      ))}
    </div>
  );
}

export function App() {
  const [preset, setPreset] = useState<Preset>("fast");
  const [tab, setTab] = useState<Tab>("camera");

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

      {/* key={preset} remounts the camera hook so the new engine list takes effect */}
      {tab === "camera" ? <CameraView key={preset} preset={preset} /> : <ImageView preset={preset} />}
    </main>
  );
}
