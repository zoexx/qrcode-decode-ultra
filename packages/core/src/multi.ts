import type { Engine, EngineResult } from "./engine.js";
import type { BarcodeFormat } from "./formats.js";
import type { FrameImage, Point } from "./types.js";

/**
 * How an engine can be driven to yield more than one code from a single frame.
 *
 * - `inherent` — `decode()` already returns every code it saw (`native`). Free;
 *   never capped, because there is no extra work to bound.
 * - `mask` — decode, paint the hit out of a scratch copy of the pixels, decode
 *   again. Needs usable `cornerPoints`. Costs one pass per code found, so you
 *   pay only for what is there (`wechat`).
 * - `tile` — run the engine over overlapping crops and dedupe. For engines whose
 *   *detection* breaks down with several codes in view, so masking never gets
 *   started (`jsqr`). Costs a fixed number of passes whether the frame holds ten
 *   codes or one.
 */
export type MultiStrategy = "inherent" | "mask" | "tile";

/** Quiet-zone slack so a masked code's finder patterns cannot survive. */
const MASK_MARGIN = 8;

function maskQuad(frame: FrameImage, quad: readonly Point[]): boolean {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  // Integer bounds: a fractional index into a typed array is silently discarded,
  // which would leave the code in place and loop forever on the same value.
  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - MASK_MARGIN);
  const x1 = Math.min(frame.width - 1, Math.ceil(Math.max(...xs)) + MASK_MARGIN);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)) - MASK_MARGIN);
  const y1 = Math.min(frame.height - 1, Math.ceil(Math.max(...ys)) + MASK_MARGIN);
  if (x1 <= x0 || y1 <= y0) return false;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * frame.width + x) * 4;
      frame.data[i] = 255;
      frame.data[i + 1] = 255;
      frame.data[i + 2] = 255;
      frame.data[i + 3] = 255;
    }
  }
  return true;
}

async function decodeByMasking(
  engine: Engine,
  frame: FrameImage,
  formats: BarcodeFormat[],
  maxCodes: number,
): Promise<EngineResult[]> {
  // Scratch copy — the caller's frame is never mutated.
  const work: FrameImage = {
    data: new Uint8ClampedArray(frame.data) as Uint8ClampedArray<ArrayBuffer>,
    width: frame.width,
    height: frame.height,
  };
  const out: EngineResult[] = [];
  const seen = new Set<string>();

  while (out.length < maxCodes) {
    const hit = (await engine.decode(work, formats))[0];
    if (!hit) break;
    // A repeat means the mask did not take. Stop rather than spin.
    if (seen.has(hit.value)) break;
    seen.add(hit.value);
    out.push(hit);
    if (!hit.cornerPoints?.length || !maskQuad(work, hit.cornerPoints)) break;
  }
  return out;
}

function cropFrame(frame: FrameImage, x: number, y: number, w: number, h: number): FrameImage {
  const data = new Uint8ClampedArray(w * h * 4) as Uint8ClampedArray<ArrayBuffer>;
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * frame.width + x) * 4;
    data.set(frame.data.subarray(from, from + w * 4), row * w * 4);
  }
  return { data, width: w, height: h };
}

function translate(points: readonly Point[] | undefined, dx: number, dy: number): Point[] | undefined {
  return points?.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

async function decodeByTiling(
  engine: Engine,
  frame: FrameImage,
  formats: BarcodeFormat[],
  maxCodes: number,
): Promise<EngineResult[]> {
  const out: EngineResult[] = [];
  const seen = new Set<string>();
  const take = (hit: EngineResult | undefined, dx: number, dy: number): void => {
    if (!hit || seen.has(hit.value)) return;
    seen.add(hit.value);
    // Report geometry in source-frame pixels, not tile-local ones.
    out.push({ ...hit, cornerPoints: translate(hit.cornerPoints, dx, dy) });
  };

  // Whole frame first. A code filling most of the frame fits in no tile at all,
  // so without this, asking for multiple codes would *lose* the single-code case.
  take((await engine.decode(frame, formats))[0], 0, 0);

  // Then tiles small enough to hold roughly one code. Overlap is what decides
  // coverage here — measured on a 10-code sheet, a half-tile step found 8/10
  // while a third-tile step found 10/10; adding more tile *sizes* changed
  // nothing. Codes were being clipped at boundaries, not mis-sized.
  const tile = Math.max(120, Math.floor(Math.min(frame.width, frame.height) / 2));
  const step = Math.max(1, Math.floor(tile / 3));

  for (let y = 0; y < frame.height && out.length < maxCodes; y += step) {
    for (let x = 0; x < frame.width && out.length < maxCodes; x += step) {
      const w = Math.min(tile, frame.width - x);
      const h = Math.min(tile, frame.height - y);
      if (w < 40 || h < 40) continue;
      take((await engine.decode(cropFrame(frame, x, y, w, h), formats))[0], x, y);
    }
  }
  return out;
}

/**
 * Decode a frame, working up to `maxCodes` results out of a single-shot engine.
 *
 * `maxCodes <= 1` is the cheap default and runs the engine exactly once. Above
 * that, an engine's `multi` strategy decides how the extra codes are found —
 * and every strategy but `inherent` costs real extra passes, so this is opt-in
 * via `ScannerOptions.maxCodesPerFrame`.
 */
export function decodeUpTo(
  engine: Engine,
  frame: FrameImage,
  formats: BarcodeFormat[],
  maxCodes: number,
): Promise<EngineResult[]> {
  // `inherent` engines return everything in one pass, so there is no extra work
  // to bound — never truncate free results.
  if (engine.capabilities.multi === "inherent" || maxCodes <= 1) {
    return engine.decode(frame, formats);
  }
  return engine.capabilities.multi === "mask"
    ? decodeByMasking(engine, frame, formats, maxCodes)
    : decodeByTiling(engine, frame, formats, maxCodes);
}
