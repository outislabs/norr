/** Converts between USD, token amounts and smallest-unit strings. Pure; no I/O. */

/** Smallest-unit string for `usd` worth of a token priced at `priceUsd`, rounded down. */
export function usdToUnits(usd: number, priceUsd: number, decimals: number): string {
  if (!(usd > 0) || !(priceUsd > 0)) throw new Error("usdToUnits: usd and priceUsd must be positive");
  const tokens = usd / priceUsd;
  // Doubles keep about 15 digits, so scale by at most 1e9 and pad the rest with zeros.
  const d = Math.min(decimals, 9);
  const scaled = BigInt(Math.floor(tokens * 10 ** d));
  return (scaled * 10n ** BigInt(decimals - d)).toString();
}

/** Whole-token amount for display and price maths. Not for moving money. */
export function unitsToNumber(units: string, decimals: number): number {
  return Number(units) / 10 ** decimals;
}

/** Exact smallest-unit string for a decimal text such as "1.25". Null when it is not a plain positive amount or has more places than the token allows. */
export function parseUnits(text: string, decimals: number): string | null {
  const m = /^(\d{1,30})(?:\.(\d{1,30}))?$/.exec(text.trim());
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > decimals) return null;
  const units = BigInt(m[1]! + frac.padEnd(decimals, "0"));
  return units > 0n ? units.toString() : null;
}

/** The inverse, exact: "1250000" with 6 decimals is "1.25". For showing an amount the owner will sign. */
export function formatUnits(units: string, decimals: number): string {
  const s = BigInt(units).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
