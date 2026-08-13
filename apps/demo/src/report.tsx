import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DeviceReport } from "./DeviceReport.js";

// As in main.tsx, qrcode-decode-ultra-wechat is NOT imported here — the report
// pulls it only when a run starts, so simply opening the page on a phone does
// not spend 2.5MB of someone's data plan.

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DeviceReport />
  </StrictMode>,
);
