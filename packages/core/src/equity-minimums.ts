/**
 * Smallest tokenized-stock orders NEAR Intents has been quoting, from free dry quotes (see
 * docs/EQUITY-MINIMUMS.md). These are observed numbers, not a protocol rule: they were measured on
 * Fri 2026-10-30 (US market open), the floor was higher on a weekend, and scheduled re-runs track it.
 * They are shown to agents up front; the live probe below says what quotes right now.
 */

export const MINIMUMS_OBSERVED_ON = "2026-10-30";

/** Tickers that quoted from about $5.05 in the confidential route. */
export const LIQUID_EQUITIES: readonly string[] = ["NVDA", "TSLA", "AAPL", "QQQ", "AMZN", "GOOGL"];

/** $5.00 fails and $5.05 quotes; $5.10 leaves a little room. */
export const LIQUID_MIN_USD = 5.1;
/** Everything else quoted only from $26 (a clean step: $25 fails). */
export const STANDARD_MIN_USD = 26;
/** Below this a position's remainder could not be sold in the observations. */
export const DUST_FLOOR_USD = LIQUID_MIN_USD;

export interface EquityMinimum {
  usd: number;
  group: "liquid" | "standard";
}

export function equityMinimum(ticker: string): EquityMinimum {
  return LIQUID_EQUITIES.includes(ticker.toUpperCase()) ? { usd: LIQUID_MIN_USD, group: "liquid" } : { usd: STANDARD_MIN_USD, group: "standard" };
}

export const MINIMUMS_NOTE =
  `Observed minimum order sizes for tokenized stocks (measured ${MINIMUMS_OBSERVED_ON}); they can be higher outside US market hours or on weekends. ` +
  "If a trade is refused for liquidity, Norr tells you the smallest size that quotes right now.";

/** Sizes tried, smallest first, when a stock trade finds no liquidity. */
const LADDER = [5.1, 5.25, 6, 8, 10, 15, 20, 26, 30, 40, 50, 75, 100];

/** Larger sizes worth probing: above the request, at or under the vault's per-trade limit, at most `limit` of them. */
export function probeSizes(requestedUsd: number, maxUsd: number, limit = 6): number[] {
  return LADDER.filter((s) => s > requestedUsd && s <= maxUsd).slice(0, limit);
}

export function noLiquidityMessage(ticker: string, requestedUsd: number, smallestUsd: number | undefined, maxUsd: number): string {
  const stated = equityMinimum(ticker).usd;
  const head = `No liquidity for $${requestedUsd} of ${ticker} right now. Observed minimum for this ticker: about $${stated}.`;
  if (smallestUsd !== undefined) return `${head} The smallest size that quotes right now is about $${smallestUsd}; try that or more.`;
  return `${head} No size up to $${maxUsd} quotes right now, so it may be outside US market hours or the market is thin. Try again later.`;
}

/** A warning when a sell would leave a remainder too small to sell later. Null when the remainder is zero or large enough. */
export function dustWarning(remainingUsd: number, positionUsd: number, symbol: string): string | null {
  if (!(remainingUsd > 0.005) || remainingUsd >= DUST_FLOOR_USD) return null;
  return (
    `Selling this much ${symbol} would leave about $${remainingUsd.toFixed(2)}, under the $${DUST_FLOOR_USD} minimum that tokenized stocks can be sold in, ` +
    `so the remainder could get stuck. Sell the whole position (about $${positionUsd.toFixed(2)}) or keep at least $${DUST_FLOOR_USD}.`
  );
}
