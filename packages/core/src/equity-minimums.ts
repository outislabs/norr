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

export interface EquityMinimum {
  usd: number;
  group: "liquid" | "standard";
}

export function equityMinimum(ticker: string): EquityMinimum {
  return LIQUID_EQUITIES.includes(ticker.toUpperCase()) ? { usd: LIQUID_MIN_USD, group: "liquid" } : { usd: STANDARD_MIN_USD, group: "standard" };
}

export const MINIMUMS_NOTE =
  `Observed minimum order sizes for tokenized stocks (measured ${MINIMUMS_OBSERVED_ON}); minimums vary with available liquidity. ` +
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
  return `${head} No size up to $${maxUsd} quotes right now, because available liquidity is thin right now. Try again later or a larger size.`;
}

/**
 * Never leave a stock position the vault cannot sell. NEAR Intents solvers do not quote tokenized-stock orders below the
 * ticker's minimum (about $5.10 for the liquid ones), so a position worth less than that cannot be sold as it is. These
 * checks refuse the trades that would create one, and offer ways out of one that exists (after a price drop, say).
 * They replace the earlier dust warning, which let the trade run and left the remainder stuck.
 */

export type ExitKind = "sell_all" | "top_up_and_sell_all" | "withdraw";
export interface ExitOption {
  kind: ExitKind;
  usd?: number;
  ownerOnly?: boolean;
  how: string;
}

/** The smallest stock order that can be sold: the ticker's observed minimum order. */
export const minSellUsd = (ticker: string): number => equityMinimum(ticker).usd;

/** Money in messages: two decimals. */
const money = (n: number): string => n.toFixed(2);
/** Round up to whole cents (a hair of float noise does not add a cent). */
const up = (n: number): number => Math.ceil(n * 100 - 1e-6) / 100;

/** Below this a holding is rounding, not a position. */
export const NEGLIGIBLE_USD = 0.01;

/**
 * The buy that makes a too-small position sellable: at least one minimum order (smaller buys do not quote either), and
 * enough that the position ends a few percent above the minimum after fees and a small price move.
 */
export function topUpUsd(heldUsd: number, minUsd: number): number {
  return up(Math.max(minUsd, (minUsd * 1.03 - heldUsd) / 0.98));
}

/** The ways out of a position worth `heldUsd`, below `minUsd`. */
export function dustExits(a: { ticker: string; symbol: string; heldUsd: number; minUsd: number; maxTradeUsd?: number }): ExitOption[] {
  const t = topUpUsd(a.heldUsd, a.minUsd);
  const overLimit = a.maxTradeUsd !== undefined && t > a.maxTradeUsd;
  return [
    {
      kind: "top_up_and_sell_all",
      usd: t,
      how:
        `Buy about $${money(t)} of ${a.symbol} so the position is worth about $${money(a.heldUsd + t)}, then sell all of it. ` +
        `Use exit_position with asset "${a.ticker}" (it does both), or trade buy $${money(t)} then trade sell with sellAll true. Both run within the vault's rules and approvals.` +
        (overLimit ? ` The top-up is above this vault's largest trade ($${a.maxTradeUsd}), so the owner would have to raise that rule first.` : ""),
    },
    {
      kind: "withdraw",
      ownerOnly: true,
      how: `Only the vault owner can do this: in the Norr dashboard, Withdraw, choose ${a.symbol}, Max. The tokens go to the owner's own NEAR account; withdrawals are private: they never name the vault.`,
    },
  ];
}

export interface MinSellBlock {
  ok: false;
  code: "BELOW_MIN_SELL";
  message: string;
  exits: ExitOption[];
  /** For a buy: the smallest size that leaves a sellable position. */
  suggestedUsd?: number;
}

const minBlock = (message: string, exits: ExitOption[], suggestedUsd?: number): MinSellBlock => ({ ok: false, code: "BELOW_MIN_SELL", message, exits, ...(suggestedUsd !== undefined ? { suggestedUsd } : {}) });

const sellAllExit = (symbol: string, heldUsd: number): ExitOption => ({
  kind: "sell_all",
  usd: up(heldUsd),
  how: `Sell the whole position: trade sell ${symbol} with sellAll true and amountUsd ${money(up(heldUsd * 1.02))} (a ceiling; the whole balance is sold).`,
});

export interface PositionSizeInput {
  side: "buy" | "sell";
  ticker: string;
  symbol: string;
  amountUsd: number;
  /** What the vault holds of this stock where the trade would run, at the reference price. */
  heldUsd: number;
  sellAll: boolean;
  maxTradeUsd?: number;
}

/**
 * Before quoting a stock trade: refuse one that would leave (or try to sell) a position below the minimum sell size,
 * and say the real reason. Null when the trade leaves nothing stuck.
 */
export function checkPositionSize(i: PositionSizeInput): MinSellBlock | null {
  const min = minSellUsd(i.ticker);
  const minText = `the minimum sell size of ~$${money(min)}`;
  const why = `NEAR Intents solvers do not quote ${i.ticker} orders smaller than that`;
  if (i.side === "buy") {
    const after = i.heldUsd + i.amountUsd;
    if (after >= min) return null;
    const need = up(Math.max(min, min * 1.03 - i.heldUsd));
    return minBlock(`Buying $${money(i.amountUsd)} of ${i.ticker} would leave a position of about $${money(after)}, below ${minText}: ${why}, so it could not be sold later. Buy at least $${money(need)}.`, [], need);
  }
  if (i.heldUsd < NEGLIGIBLE_USD) return null; // nothing held: the funds check says so
  if (i.heldUsd < min) {
    return minBlock(
      `This vault's ${i.symbol} position is worth about $${money(i.heldUsd)}, below ${minText}: ${why}, so it cannot be sold as it is. ` +
        `Ways out: top up and sell all (buy about $${money(topUpUsd(i.heldUsd, min))}, then sell everything), or the owner withdraws it to their wallet.`,
      dustExits({ ticker: i.ticker, symbol: i.symbol, heldUsd: i.heldUsd, minUsd: min, maxTradeUsd: i.maxTradeUsd }),
    );
  }
  if (i.sellAll) return null;
  const partialRoom = i.heldUsd >= 2 * min ? `, or sell between $${money(min)} and $${money(i.heldUsd - min)}` : "";
  if (i.amountUsd < min) {
    return minBlock(`$${money(i.amountUsd)} of ${i.ticker} is below ${minText}: ${why}. Sell all (about $${money(i.heldUsd)})${partialRoom}.`, [sellAllExit(i.symbol, i.heldUsd)]);
  }
  const remainder = i.heldUsd - i.amountUsd;
  if (remainder >= NEGLIGIBLE_USD && remainder < min) {
    return minBlock(
      `Selling $${money(i.amountUsd)} of ${i.ticker} would leave about $${money(remainder)}, below ${minText}: ${why}, so the remainder could not be sold later. Sell all (about $${money(i.heldUsd)}) instead${partialRoom}.`,
      [sellAllExit(i.symbol, i.heldUsd)],
    );
  }
  return null;
}

/**
 * After the quote, for a buy: the position it really leaves (held plus what the quote delivers). Fees can put a buy of
 * exactly the minimum just under it. Null when the result can be sold.
 */
export function checkBoughtPosition(i: { ticker: string; amountUsd: number; heldUsd: number; receivedUsd: number }): MinSellBlock | null {
  const min = minSellUsd(i.ticker);
  const after = i.heldUsd + i.receivedUsd;
  if (after >= min || !(i.receivedUsd > 0)) return null;
  const need = up(i.amountUsd + (min * 1.01 - after) / (i.receivedUsd / i.amountUsd));
  return minBlock(
    `Buying $${money(i.amountUsd)} of ${i.ticker} would deliver about $${money(i.receivedUsd)} after fees, leaving a position of about $${money(after)}, below the minimum sell size of ~$${money(min)}, so it could not be sold later. Buy at least $${money(need)}.`,
    [],
    need,
  );
}
