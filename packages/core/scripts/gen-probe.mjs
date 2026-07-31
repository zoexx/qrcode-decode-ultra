// Regenerates the baked QR module matrix used by the native engine's probe.
// Run: pnpm -C packages/core gen:probe
import QRCode from "qrcode";
import { readFileSync, writeFileSync } from "node:fs";

const PAYLOAD = "qrdu-probe";
const qr = QRCode.create(PAYLOAD, { errorCorrectionLevel: "M" });
const size = qr.modules.size;
const data = qr.modules.data; // length size*size, 1 = dark module

const nbytes = Math.ceil((size * size) / 8);
const bytes = new Uint8Array(nbytes);
for (let i = 0; i < size * size; i++) {
  if (data[i]) bytes[i >> 3] |= 1 << (7 - (i & 7));
}
const b64 = Buffer.from(bytes).toString("base64");

const file = new URL("../src/probe-image.ts", import.meta.url);
let src = readFileSync(file, "utf8");
src = src.replace(/export const PROBE_PAYLOAD = "[^"]*";/, `export const PROBE_PAYLOAD = "${PAYLOAD}";`);
src = src.replace(/export const PROBE_SIZE = \d+;/, `export const PROBE_SIZE = ${size};`);
src = src.replace(
  /export const PROBE_MATRIX_BASE64 = "[^"]*";/,
  `export const PROBE_MATRIX_BASE64 = "${b64}";`,
);
writeFileSync(file, src);

console.log(`probe payload=${PAYLOAD} size=${size} modules, ${nbytes} bytes, base64 len ${b64.length}`);
