/**
 * Generate the synthetic benchmark set: clean QR codes degraded along one axis
 * each, with the payload as ground truth. Our own content -> Unlicense ->
 * trivially redistributable. Committed so the benchmark is reproducible.
 *
 * Run: pnpm gen   (from benchmark/)
 */
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import sharp from "sharp";
import { CATEGORIES, type Category, type ManifestRow } from "../harness/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = join(HERE, "..");
const IMG_DIR = join(BENCH, "fixtures", "synthetic", "images");

const PAYLOADS = [
  "https://github.com/zoexx/qrcode-decode-ultra",
  "QRDU-0001",
  "hello qrcode-decode-ultra",
  "https://example.com/order/8f21c4",
  "ABC-987-XYZ-42",
];

type ErrorCorrectionLevel = "L" | "M" | "Q" | "H";

async function renderQR(text: string, ecc: ErrorCorrectionLevel, size: number): Promise<Buffer> {
  return QRCode.toBuffer(text, { errorCorrectionLevel: ecc, margin: 2, width: size, type: "png" });
}

const WHITE = { r: 255, g: 255, b: 255 };

/** Each degradation takes a clean PNG buffer (+ its render size) and returns a PNG. */
const DEGRADE: Record<Category, (png: Buffer, size: number) => Promise<Buffer>> = {
  clean: async (png) => png,
  rotated: async (png) => sharp(png).rotate(15, { background: WHITE }).png().toBuffer(),
  blur: async (png) => sharp(png).blur(2.5).png().toBuffer(),
  low_light: async (png) => sharp(png).modulate({ brightness: 0.35 }).png().toBuffer(),
  inverted: async (png) => sharp(png).negate({ alpha: false }).png().toBuffer(),
  downscale_32: async (png) => sharp(png).resize(32, 32, { kernel: "cubic" }).png().toBuffer(),
  damaged: async (png, size) => {
    const block = Math.round(size * 0.16);
    const patch = await sharp({
      create: { width: block, height: block, channels: 3, background: WHITE },
    })
      .png()
      .toBuffer();
    const at = Math.round(size * 0.28);
    return sharp(png).composite([{ input: patch, top: at, left: at }]).png().toBuffer();
  },
  torture: async (png) =>
    sharp(png)
      .resize(72, 72, { kernel: "cubic" })
      .blur(1.1)
      .rotate(12, { background: WHITE })
      .jpeg({ quality: 30 })
      .toBuffer(),
};

// Some categories need more error-correction headroom or a larger render.
function settingsFor(category: Category): { ecc: ErrorCorrectionLevel; size: number } {
  switch (category) {
    case "damaged":
      return { ecc: "H", size: 256 };
    case "downscale_32":
      return { ecc: "M", size: 256 };
    case "torture":
      return { ecc: "Q", size: 256 };
    default:
      return { ecc: "M", size: 256 };
  }
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function main(): Promise<void> {
  await rm(IMG_DIR, { recursive: true, force: true });
  const rows: ManifestRow[] = [];

  for (const category of CATEGORIES) {
    const { ecc, size } = settingsFor(category);
    await mkdir(join(IMG_DIR, category), { recursive: true });
    for (let i = 0; i < PAYLOADS.length; i++) {
      const payload = PAYLOADS[i]!;
      const clean = await renderQR(payload, ecc, size);
      const degraded = await DEGRADE[category](clean, size);
      const name = `${category}-${i}.png`;
      const rel = `fixtures/synthetic/images/${category}/${name}`;
      await writeFile(join(BENCH, rel), degraded);
      rows.push({
        image: rel,
        expected: payload,
        category,
        format: "qr_code",
        source: "synthetic",
        license: "Unlicense",
        sha256: sha256(degraded),
      });
    }
  }

  const manifestPath = join(BENCH, "fixtures", "manifest.json");
  await writeFile(manifestPath, JSON.stringify(rows, null, 2));
  console.log(`generated ${rows.length} images across ${CATEGORIES.length} categories`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
