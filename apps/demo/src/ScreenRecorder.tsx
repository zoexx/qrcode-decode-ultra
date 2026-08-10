import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A record button for capturing the demo itself.
 *
 * `getDisplayMedia` into a `MediaRecorder`, and a download when you stop. It
 * exists because the thing worth recording — the race meter reacting to real
 * frames — only happens live, so the recording has to come from the same page.
 *
 * Video only: no audio is requested, so the browser never asks for a microphone
 * and the capture prompt stays a single decision.
 */

/**
 * Container/codec preference. VP9 is the best quality-per-byte Chrome offers to
 * `MediaRecorder`, and a QR demo is mostly fine black-and-white detail, which is
 * exactly what a softer codec smears. The rest are fallbacks; `""` (let the
 * browser decide) is last.
 */
const MIME_CANDIDATES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
  "video/mp4",
];

function pickMimeType(): string {
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

function stamp(): string {
  // 2026-08-09T14-31-07 — sorts correctly and survives every filesystem.
  return new Date().toISOString().slice(0, 19).replace(/:/g, "-");
}

function clock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function save(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `qrcode-decode-ultra-${stamp()}.${blob.type.includes("mp4") ? "mp4" : "webm"}`;
  a.click();
  // Revoked late rather than immediately: the download reads from the URL after
  // the click returns, and a large recording takes a moment to flush to disk.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

type RecorderState = "idle" | "starting" | "recording";

export function ScreenRecorder() {
  const [state, setState] = useState<RecorderState>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const supported =
    typeof MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function";

  useEffect(() => {
    if (state !== "recording") return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [state]);

  // A recording outlives any single render, so stop it if the page tears down.
  useEffect(
    () => () => {
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  const stop = useCallback(() => {
    // Fires `onstop`, which is where the file is written and the tracks released.
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }, []);

  const start = useCallback(async () => {
    setError("");
    setState("starting");
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: false,
      });

      const release = () => {
        stream.getTracks().forEach((t) => t.stop());
        recorderRef.current = null;
        streamRef.current = null;
      };

      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        // Generous: fine QR detail and small type are what a low bitrate ruins.
        videoBitsPerSecond: 8_000_000,
      });

      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => {
        if (chunks.length > 0) save(new Blob(chunks, { type: recorder.mimeType || "video/webm" }));
        release();
        setState("idle");
      };

      // Stopping from the browser's own "stop sharing" bar ends the track rather
      // than calling back here, so mirror it into a normal stop.
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        if (recorder.state === "recording") recorder.stop();
      });

      recorderRef.current = recorder;
      streamRef.current = stream;
      // Timesliced so a crash mid-take leaves recoverable chunks rather than one
      // buffer that was never flushed.
      recorder.start(1000);
      setSeconds(0);
      setState("recording");
    } catch (err) {
      setState("idle");
      // Dismissing the picker throws the same error as denying permission; it is
      // a decision, not a failure, so it gets no error banner.
      const name = err instanceof DOMException ? err.name : "";
      if (name !== "NotAllowedError" && name !== "AbortError") {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, []);

  if (!supported) return null;

  const recording = state === "recording";
  return (
    <div className="rec">
      <button
        type="button"
        className="rec-btn"
        data-on={recording || undefined}
        disabled={state === "starting"}
        onClick={() => (recording ? stop() : void start())}
        title={
          recording
            ? "Stop recording and download the file"
            : "Record the screen or this tab — the browser will ask which"
        }
      >
        <span className="rec-dot" />
        {recording ? `Stop ${clock(seconds)}` : "Record"}
      </button>
      {error && <span className="rec-err">{error}</span>}
    </div>
  );
}
