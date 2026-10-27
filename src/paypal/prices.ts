/** Parse an observed USD decimal without float coercion or exponent notation. */
export function usdCents(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  const cents = BigInt(match[1]) * BigInt(100) + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}

export function sameUsdAmount(observed: unknown, expected: unknown): boolean {
  const observedCents = usdCents(observed);
  return observedCents !== null && observedCents === usdCents(expected);
}
