import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

// Note: qrcode-decode-ultra-wechat is NOT imported here — the demo lazy-loads it only when
// the "max-accuracy" preset is first used, so its ~2.5MB WASM isn't in the
// initial page load. See App.tsx.

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
