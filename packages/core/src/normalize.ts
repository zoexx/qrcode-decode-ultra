import type { FrameImage, ImageSource } from "./types.js";

function isFrameImage(src: ImageSource): src is FrameImage {
  return (
    typeof src === "object" &&
    src !== null &&
    "data" in src &&
    "width" in src &&
    "height" in src &&
    (src as { data: unknown }).data instanceof Uint8ClampedArray
  );
}

interface Dims {
  width: number;
  height: number;
}

function dimsOf(src: Exclude<ImageSource, FrameImage | Blob>): Dims {
  if (typeof HTMLVideoElement !== "undefined" && src instanceof HTMLVideoElement) {
    return { width: src.videoWidth, height: src.videoHeight };
  }
  if (typeof HTMLImageElement !== "undefined" && src instanceof HTMLImageElement) {
    return { width: src.naturalWidth, height: src.naturalHeight };
  }
  const anySrc = src as { width: number; height: number };
  return { width: anySrc.width, height: anySrc.height };
}

function makeCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

function get2d(
  canvas: OffscreenCanvas | HTMLCanvasElement,
): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas context unavailable");
  return ctx as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
}

/**
 * Rasterize any supported source to a `FrameImage`. Used by the in-process path
 * and by the worker after it has the transferred `ImageBitmap`. Drawing once and
 * sharing the resulting pixels is also the benchmark's fairness invariant.
 */
export async function toFrameImage(source: ImageSource): Promise<FrameImage> {
  if (isFrameImage(source)) return source;

  let drawable: CanvasImageSource;
  let dims: Dims;
  // Ownership: only a bitmap *we* created here may be closed. A caller-supplied
  // ImageBitmap is a documented `ImageSource` and must survive the scan, so it
  // is never closed — closing it would detach the caller's object.
  let ownsDrawable = false;

  if (typeof Blob !== "undefined" && source instanceof Blob) {
    const bitmap = await createImageBitmap(source);
    drawable = bitmap;
    ownsDrawable = true;
    dims = { width: bitmap.width, height: bitmap.height };
  } else {
    drawable = source as CanvasImageSource;
    dims = dimsOf(source as Exclude<ImageSource, FrameImage | Blob>);
  }

  const closeIfOwned = (): void => {
    if (ownsDrawable && typeof ImageBitmap !== "undefined" && drawable instanceof ImageBitmap) {
      drawable.close();
    }
  };

  if (!dims.width || !dims.height) {
    closeIfOwned(); // don't leak the bitmap we just decoded from the Blob
    throw new Error("Image source has zero dimensions (not loaded yet?)");
  }

  try {
    const canvas = makeCanvas(dims.width, dims.height);
    const ctx = get2d(canvas);
    ctx.drawImage(drawable, 0, 0, dims.width, dims.height);
    return ctx.getImageData(0, 0, dims.width, dims.height);
  } finally {
    closeIfOwned();
  }
}

/**
 * Produce a transferable `ImageBitmap` from a source, for handing to the worker.
 *
 * The returned bitmap is *transferred* to the worker and `close()`d there, so it
 * must always be one we own. A caller-supplied `ImageBitmap` is therefore cloned
 * rather than handed over — otherwise a single `scanImage(bitmap)` would detach
 * and destroy the caller's bitmap, making it unusable for any later scan.
 */
export async function toBitmap(source: ImageSource): Promise<ImageBitmap> {
  if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) {
    return createImageBitmap(source);
  }
  if (isFrameImage(source)) {
    const imageData =
      source instanceof ImageData ? source : new ImageData(source.data, source.width, source.height);
    return createImageBitmap(imageData);
  }
  return createImageBitmap(source as ImageBitmapSource);
}

/** Are the APIs needed for the worker transport present? */
export function workerTransportAvailable(): boolean {
  return (
    typeof Worker !== "undefined" &&
    typeof OffscreenCanvas !== "undefined" &&
    typeof createImageBitmap !== "undefined"
  );
}
