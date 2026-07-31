# qrcode-decode-ultra-react

React binding for [QRCode Decode Ultra](https://github.com/zoexx/qrcode-decode-ultra) —
a `useScanner()` hook and a `<Scanner/>` component. Owns the camera
(`getUserMedia`), is SSR-safe, and tears down cleanly under React StrictMode.

```bash
npm install qrcode-decode-ultra-react qrcode-decode-ultra react
```

## Component

```tsx
import { Scanner } from "qrcode-decode-ultra-react";

<Scanner
  engines="fast"                // default; or "max-accuracy" / ["jsqr"]
  facingMode="environment"
  once
  onResult={(r) => console.log(r.value, "via", r.engine)}
  onError={(e) => console.error(e.message)}
  style={{ width: "100%", maxWidth: 480 }}
/>;
```

## Hook

For full control over markup:

```tsx
import { useScanner } from "qrcode-decode-ultra-react";

function MyScanner() {
  const { videoRef, status, result, results, error, start, stop } = useScanner({
    engines: "fast",
    onResult: (r) => console.log("primary:", r.value),
    onResults: (rs) => console.log(`${rs.length} code(s) this frame`),
  });

  return (
    <>
      <video ref={videoRef} playsInline muted autoPlay />
      <p>{status}</p>
      {results.map((r) => (
        <p key={r.value}>{r.value}</p>
      ))}
      {error && <p>error: {error.message}</p>}
    </>
  );
}
```

`status` is `"idle" | "requesting" | "scanning" | "stopped" | "error"`. Set
`autoStart: false` to drive the camera yourself via `start()` / `stop()`.

`result` is the primary code from the latest successful frame; `results` is every
code from that frame. How many you get depends on which cascade tier won — see
[many codes per frame](https://github.com/zoexx/qrcode-decode-ultra/tree/main/packages/core#many-codes-per-frame).

Beyond the camera options above (`facingMode`, `deviceId`, `once`, `autoStart`),
the hook accepts the same scanner options as core — `engines`, `formats`,
`worker`, `maxScansPerSecond`, `lowResPreloadPx` — and passes them straight
through.

## SSR / Next.js

The hook never touches the camera or a Worker at render — only inside effects and
event handlers — so it is safe to render on the server. In the Next.js App
Router, mark the component `"use client"`.

## License

MIT. See the repository `NOTICE` and `THIRD-PARTY-LICENSES.md`.
