/**
 * Node polyfill for ImageData so QRCode Decode Ultra's engines (and the WeChat WASM) run
 * headlessly — the harness constructs `new ImageData(...)` to build frames. Must
 * be imported before any engine module.
 */
const g = globalThis as unknown as { ImageData?: unknown };

if (typeof g.ImageData === "undefined") {
  g.ImageData = class ImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    colorSpace = "srgb";
    constructor(a: Uint8ClampedArray | number, b: number, c?: number) {
      if (typeof a === "number") {
        this.width = a;
        this.height = b;
        this.data = new Uint8ClampedArray(a * b * 4);
      } else {
        this.data = a;
        this.width = b;
        this.height = c as number;
      }
    }
  };
}
