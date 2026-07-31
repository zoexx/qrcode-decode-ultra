export type Category =
  | "clean"
  | "rotated"
  | "blur"
  | "low_light"
  | "inverted"
  | "downscale_32"
  | "damaged"
  | "torture";

export const CATEGORIES: Category[] = [
  "clean",
  "rotated",
  "blur",
  "low_light",
  "inverted",
  "downscale_32",
  "damaged",
  "torture",
];

export interface ManifestRow {
  /** path relative to the benchmark dir, forward-slashed */
  image: string;
  /** decoded text the engine must match exactly */
  expected: string;
  category: Category;
  /** always "qr_code" — the synthetic set is QR */
  format: string;
  source: "synthetic";
  license: "Unlicense";
  sha256: string;
}
