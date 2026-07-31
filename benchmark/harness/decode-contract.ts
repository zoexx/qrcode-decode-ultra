/**
 * The single success predicate, applied identically to every engine. NFC + trim
 * normalization; a WRONG value counts as a false positive, not a benign miss, so
 * an engine can't farm detection rate by emitting garbage.
 */
export type Outcome = "tp" | "fn" | "fp";

function norm(s: string | null): string | null {
  return s == null ? null : s.normalize("NFC").trim();
}

export function classify(expected: string, value: string | null): Outcome {
  const got = norm(value);
  const want = norm(expected);
  if (got == null || got === "") return "fn";
  return got === want ? "tp" : "fp";
}
