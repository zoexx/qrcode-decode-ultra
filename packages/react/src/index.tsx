import { useCallback, useEffect, useRef, useState, type CSSProperties, type VideoHTMLAttributes } from "react";
import { createScanner } from "qrcode-decode-ultra";
import type {
  BarcodeFormat,
  EngineId,
  EnginePreset,
  Scanner as CoreScanner,
  ScanController,
  ScanError,
  ScanResult,
} from "qrcode-decode-ultra";

export interface UseScannerOptions {
  engines?: EnginePreset | EngineId[];
  formats?: BarcodeFormat[];
  worker?: boolean;
  maxScansPerSecond?: number;
  /**
   * Find up to this many codes per frame. Default 1.
   *
   * Free on `native`, which returns every code it saw in one pass. On `jsqr` and
   * `wechat` it costs extra decode passes per frame — on live video that shows up
   * as a lower effective scan rate, not a frozen UI, since decoding is off the
   * main thread and a busy frame is skipped rather than queued.
   */
  maxCodesPerFrame?: number;
  /** Low-res frame threshold (px) that eagerly preloads the WeChat tier. Default 480. */
  lowResPreloadPx?: number;
  /** Which camera to request. Default "environment" (rear). */
  facingMode?: "environment" | "user";
  /** Specific camera device id (overrides facingMode). */
  deviceId?: string;
  /** Stop after the first successful decode. */
  once?: boolean;
  /** Start the camera automatically on mount. Default true. */
  autoStart?: boolean;
  onResult?: (result: ScanResult) => void;
  /** All codes found in a frame (many-codes-per-frame). Fires alongside `onResult`. */
  onResults?: (results: ScanResult[]) => void;
  onError?: (error: ScanError) => void;
}

export type ScannerStatus = "idle" | "requesting" | "scanning" | "stopped" | "error";

export interface UseScannerReturn {
  /** Attach to your <video> element. */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  status: ScannerStatus;
  /** The first/primary code from the most recent successful frame. */
  result: ScanResult | null;
  /** Every code from the most recent successful frame (many-codes-per-frame). */
  results: ScanResult[];
  error: ScanError | null;
  isScanning: boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * React hook for the cascade. Owns getUserMedia and the scanner lifecycle, is
 * SSR-safe (no browser access at render), and is StrictMode-safe (cleanup fully
 * tears down so the dev double-mount doesn't leak a camera stream or worker).
 */
export function useScanner(options: UseScannerOptions = {}): UseScannerReturn {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerRef = useRef<CoreScanner | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const controllerRef = useRef<ScanController | null>(null);
  const runningRef = useRef(false);

  const [status, setStatus] = useState<ScannerStatus>("idle");
  const [result, setResult] = useState<ScanResult | null>(null);
  const [results, setResults] = useState<ScanResult[]>([]);
  const [error, setError] = useState<ScanError | null>(null);

  // Latest options/callbacks without re-triggering the lifecycle effect.
  const optsRef = useRef(options);
  optsRef.current = options;

  const stop = useCallback(async () => {
    runningRef.current = false;
    try {
      await controllerRef.current?.stop();
    } catch {
      /* ignore */
    }
    controllerRef.current = null;
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
    const video = videoRef.current;
    if (video) video.srcObject = null;
    setStatus((s) => (s === "error" ? s : "stopped"));
  }, []);

  const start = useCallback(async () => {
    if (runningRef.current) return;
    const o = optsRef.current;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      const e: ScanError = { code: "camera", message: "Camera API unavailable in this environment" };
      setError(e);
      setStatus("error");
      o.onError?.(e);
      return;
    }
    runningRef.current = true;
    setError(null);
    setStatus("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: o.deviceId
          ? { deviceId: { exact: o.deviceId } }
          : { facingMode: o.facingMode ?? "environment" },
        audio: false,
      });
      // Unmounted (or stopped) while awaiting permission: release and bail.
      if (!runningRef.current) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      streamRef.current = stream;

      const video = videoRef.current;
      if (!video) throw new Error("video element is not mounted");
      video.srcObject = stream;
      video.setAttribute("playsinline", "true");
      video.muted = true;
      await video.play().catch(() => undefined); // autoplay can reject; frames still flow
      if (!runningRef.current) return;

      if (!scannerRef.current) {
        scannerRef.current = createScanner({
          engines: o.engines,
          formats: o.formats,
          worker: o.worker,
          maxScansPerSecond: o.maxScansPerSecond,
          maxCodesPerFrame: o.maxCodesPerFrame,
          lowResPreloadPx: o.lowResPreloadPx,
        });
      }

      setStatus("scanning");
      const controller = scannerRef.current.scanVideo(video, {
        once: o.once,
        onResult: (r) => {
          setResult(r);
          optsRef.current.onResult?.(r);
          if (o.once) void stop();
        },
        onResults: (rs) => {
          setResults(rs);
          optsRef.current.onResults?.(rs);
        },
        onError: (e) => {
          setError(e);
          setStatus("error");
          optsRef.current.onError?.(e);
        },
      });
      controllerRef.current = controller;
      await controller.start();
    } catch (err) {
      const e: ScanError = {
        code: "camera",
        message: err instanceof Error ? err.message : String(err),
      };
      runningRef.current = false;
      setError(e);
      setStatus("error");
      optsRef.current.onError?.(e);
    }
  }, [stop]);

  useEffect(() => {
    const auto = optsRef.current.autoStart ?? true;
    if (auto) void start();
    return () => {
      void stop();
      void scannerRef.current?.dispose();
      scannerRef.current = null;
    };
  }, [start, stop]);

  return {
    videoRef,
    status,
    result,
    results,
    error,
    isScanning: status === "scanning",
    start,
    stop,
  };
}

export interface ScannerProps extends UseScannerOptions {
  className?: string;
  style?: CSSProperties;
  videoProps?: VideoHTMLAttributes<HTMLVideoElement>;
}

/** Drop-in camera scanner. Renders a <video> and owns the whole lifecycle. */
export function Scanner(props: ScannerProps) {
  const { className, style, videoProps, ...options } = props;
  const { videoRef } = useScanner(options);
  return (
    <video
      ref={videoRef}
      className={className}
      style={style}
      playsInline
      muted
      autoPlay
      {...videoProps}
    />
  );
}

export type { ScanResult, ScanError, BarcodeFormat, EngineId, EnginePreset } from "qrcode-decode-ultra";
