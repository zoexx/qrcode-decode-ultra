/**
 * The canonical format vocabulary: the 13 standard `BarcodeDetector` enum
 * strings (underscore-cased). Every engine translates its own naming into these
 * so the cascade can compare and route formats consistently.
 */
export type BarcodeFormat =
  | "aztec"
  | "codabar"
  | "code_128"
  | "code_39"
  | "code_93"
  | "data_matrix"
  | "ean_8"
  | "ean_13"
  | "itf"
  | "pdf417"
  | "qr_code"
  | "upc_a"
  | "upc_e";

export const ALL_FORMATS: readonly BarcodeFormat[] = [
  "aztec",
  "codabar",
  "code_128",
  "code_39",
  "code_93",
  "data_matrix",
  "ean_8",
  "ean_13",
  "itf",
  "pdf417",
  "qr_code",
  "upc_a",
  "upc_e",
];

const ALL_FORMAT_SET: ReadonlySet<BarcodeFormat> = new Set(ALL_FORMATS);

export function isBarcodeFormat(value: string): value is BarcodeFormat {
  return ALL_FORMAT_SET.has(value as BarcodeFormat);
}

/**
 * Intersect a requested format list with what an engine supports. An empty
 * `requested` means "all formats the engine supports".
 */
export function intersectFormats(
  requested: readonly BarcodeFormat[] | undefined,
  supported: ReadonlySet<BarcodeFormat>,
): BarcodeFormat[] {
  if (!requested || requested.length === 0) {
    return [...supported];
  }
  return requested.filter((f) => supported.has(f));
}
