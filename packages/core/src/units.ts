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
