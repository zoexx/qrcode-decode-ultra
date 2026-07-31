import { afterEach, describe, expect, it } from "vitest";
import { toBitmap, toFrameImage } from "../src/normalize.js";

/**
 * `ImageBitmap` is a documented member of the public `ImageSource` union, and the
 * worker transport *transfers* the bitmap it is handed and `close()`s it on the
 * other side. These tests pin the ownership rule that makes those two facts
 * compatible: qrcode-decode-ultra only ever closes a bitmap it created itself.
 */

class FakeImageBitmap {
  closed = false;
  constructor(
    readonly width = 8,
    readonly height = 8,
  ) {}
  close(): void {
    this.closed = true;
  }
}

class FakeOffscreenCanvas {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  getContext(): unknown {
    return {
      drawImage: () => {},
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4).fill(255),
        width: w,
        height: h,
      }),
    };
  }
}

const g = globalThis as unknown as Record<string, unknown>;
const saved = {
  ImageBitmap: g.ImageBitmap,
  OffscreenCanvas: g.OffscreenCanvas,
  createImageBitmap: g.createImageBitmap,
};

/** Bitmaps manufactured by the stubbed `createImageBitmap` — i.e. the ones the
 * library owns and is allowed to close. */
let created: FakeImageBitmap[] = [];

function install(): void {
  created = [];
  g.ImageBitmap = FakeImageBitmap;
  g.OffscreenCanvas = FakeOffscreenCanvas;
  g.createImageBitmap = (src: { width?: number; height?: number } | undefined) => {
    const bmp = new FakeImageBitmap(src?.width ?? 8, src?.height ?? 8);
    created.push(bmp);
    return Promise.resolve(bmp);
  };
}

afterEach(() => {
  Object.assign(g, saved);
});

describe("ImageBitmap ownership", () => {
  it("toFrameImage does not close a caller-supplied ImageBitmap", async () => {
    install();
    const callerBitmap = new FakeImageBitmap(16, 16);

    const frame = await toFrameImage(callerBitmap as unknown as ImageBitmap);

    expect(frame.width).toBe(16);
    expect(callerBitmap.closed).toBe(false);
  });

  it("toBitmap clones a caller-supplied ImageBitmap instead of handing it over", async () => {
    install();
    const callerBitmap = new FakeImageBitmap(16, 16);

    const forWorker = await toBitmap(callerBitmap as unknown as ImageBitmap);

    // The worker transfers + closes what it gets, so it must not be the caller's.
    expect(forWorker).not.toBe(callerBitmap);
    (forWorker as unknown as FakeImageBitmap).close();
    expect(callerBitmap.closed).toBe(false);
  });

  it("a caller's ImageBitmap survives repeated scans", async () => {
    install();
    const callerBitmap = new FakeImageBitmap(16, 16);

    for (let i = 0; i < 3; i++) {
      const forWorker = await toBitmap(callerBitmap as unknown as ImageBitmap);
      (forWorker as unknown as FakeImageBitmap).close(); // simulate the worker
      await toFrameImage(callerBitmap as unknown as ImageBitmap);
    }

    expect(callerBitmap.closed).toBe(false);
  });

  it("still closes a bitmap it created itself from a Blob", async () => {
    install();

    await toFrameImage(new Blob([new Uint8Array([1, 2, 3])]));

    expect(created).toHaveLength(1);
    expect(created[0]!.closed).toBe(true);
  });

  it("does not leak a self-created bitmap when the source has zero dimensions", async () => {
    install();
    g.createImageBitmap = (): Promise<FakeImageBitmap> => {
      const bmp = new FakeImageBitmap(0, 0);
      created.push(bmp);
      return Promise.resolve(bmp);
    };

    await expect(toFrameImage(new Blob([new Uint8Array([1])]))).rejects.toThrow(/zero dimensions/);
    expect(created[0]!.closed).toBe(true);
  });
});
