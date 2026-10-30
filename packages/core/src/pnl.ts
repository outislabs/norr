/**
 * Realized profit and loss for the daily loss cap. Average-cost accounting per asset.
 * Only the non-cash side of a trade is tracked. Pure; no I/O.
 */

export interface Position {
  qty: number;
  costUsd: number;
}

export type Book = Record<string, Position>;

export interface Fill {
  assetId: string;
  side: "buy" | "sell";
  /** Whole tokens bought or sold. */
  qty: number;
  /** USD paid (buy) or received (sell), fees included. */
  usd: number;
}

/**
 * Apply a fill. A sell realizes `proceeds - average cost` on the part Norr bought. The part it
 * did not buy (assets deposited from elsewhere) has no known cost, so it realizes nothing.
 */
export function applyFill(book: Book, f: Fill): { book: Book; realizedUsd: number } {
  const pos = book[f.assetId] ?? { qty: 0, costUsd: 0 };
  if (f.side === "buy") {
    return { book: { ...book, [f.assetId]: { qty: pos.qty + f.qty, costUsd: pos.costUsd + f.usd } }, realizedUsd: 0 };
  }
  const tracked = Math.min(f.qty, pos.qty);
  const avg = pos.qty > 0 ? pos.costUsd / pos.qty : 0;
  const costRemoved = avg * tracked;
  const proceeds = f.qty > 0 ? f.usd * (tracked / f.qty) : 0;
  return {
    book: { ...book, [f.assetId]: { qty: pos.qty - tracked, costUsd: pos.costUsd - costRemoved } },
    realizedUsd: proceeds - costRemoved,
  };
}

/** Net realized P&L for one UTC day. */
export interface DayPnl {
  day: string;
  netUsd: number;
}

export const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function addRealized(t: DayPnl, ms: number, realizedUsd: number): DayPnl {
  const day = dayKey(ms);
  return t.day === day ? { day, netUsd: t.netUsd + realizedUsd } : { day, netUsd: realizedUsd };
}

/** Loss so far today (never negative). Gains earlier the same day offset losses. */
export const lossToday = (t: DayPnl, ms: number): number => (t.day === dayKey(ms) ? Math.max(0, -t.netUsd) : 0);
