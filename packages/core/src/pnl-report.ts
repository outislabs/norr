import { applyFill, type Book } from "./pnl";

/**
 * Profit and loss since the vault's first trade, per asset: realized (from sells, average cost) and unrealized (what
 * is still held from Norr's buys, at today's price). Replays the vault's executed trades in order with the same rule
 * the daily loss cap uses, so the numbers agree with it. Pure; no I/O.
 *
 * Scope: only positions Norr bought are tracked. Assets deposited from elsewhere have no known cost, so a sell of them
 * realizes nothing and they carry no unrealized P&L. Cash (USDC) is the unit of account, not a position.
 */

export interface TradeFill {
  /** The filled asset (symbol as recorded in the decision). */
  asset: string;
  side: "buy" | "sell";
  /** Whole tokens. */
  qty: number;
  /** USD paid (buy) or received (sell). */
  usd: number;
  atMs: number;
}

export interface AssetPnl {
  asset: string;
  trades: number;
  boughtUsd: number;
  soldUsd: number;
  realizedUsd: number;
  /** Tracked quantity still held (from Norr's own buys). */
  qtyHeld: number;
  costBasisUsd: number;
  avgCostUsd: number | null;
  /** Current price; null when there is none, and then unrealized is null too. */
  priceUsd: number | null;
  marketValueUsd: number | null;
  unrealizedUsd: number | null;
}

export interface PnlReport {
  sinceMs: number | null;
  assets: AssetPnl[];
  totals: { boughtUsd: number; soldUsd: number; realizedUsd: number; unrealizedUsd: number; totalUsd: number; costBasisUsd: number };
  /** Assets held whose current price is unknown: their unrealized P&L is left out of the total. */
  unpriced: string[];
}

const DUST = 1e-12;
const round = (n: number): number => Math.round(n * 1e6) / 1e6;

export function pnlReport(fills: TradeFill[], priceOf: (asset: string) => number | null): PnlReport {
  const ordered = [...fills].sort((a, b) => a.atMs - b.atMs);
  let book: Book = {};
  const per = new Map<string, { trades: number; boughtUsd: number; soldUsd: number; realizedUsd: number }>();
  for (const f of ordered) {
    const r = applyFill(book, { assetId: f.asset, side: f.side, qty: f.qty, usd: f.usd });
    book = r.book;
    const p = per.get(f.asset) ?? { trades: 0, boughtUsd: 0, soldUsd: 0, realizedUsd: 0 };
    p.trades += 1;
    if (f.side === "buy") p.boughtUsd += f.usd;
    else p.soldUsd += f.usd;
    p.realizedUsd += r.realizedUsd;
    per.set(f.asset, p);
  }

  const assets: AssetPnl[] = [];
  const unpriced: string[] = [];
  for (const [asset, p] of per) {
    const pos = book[asset] ?? { qty: 0, costUsd: 0 };
    const qtyHeld = pos.qty > DUST ? pos.qty : 0;
    const costBasisUsd = qtyHeld ? pos.costUsd : 0;
    const price = priceOf(asset);
    const marketValueUsd = qtyHeld === 0 ? 0 : price === null ? null : qtyHeld * price;
    if (qtyHeld > 0 && price === null) unpriced.push(asset);
    assets.push({
      asset,
      trades: p.trades,
      boughtUsd: round(p.boughtUsd),
      soldUsd: round(p.soldUsd),
      realizedUsd: round(p.realizedUsd),
      qtyHeld: round(qtyHeld),
      costBasisUsd: round(costBasisUsd),
      avgCostUsd: qtyHeld ? round(costBasisUsd / qtyHeld) : null,
      priceUsd: price,
      marketValueUsd: marketValueUsd === null ? null : round(marketValueUsd),
      unrealizedUsd: marketValueUsd === null ? null : round(marketValueUsd - costBasisUsd),
    });
  }
  assets.sort((a, b) => Math.abs(b.realizedUsd + (b.unrealizedUsd ?? 0)) - Math.abs(a.realizedUsd + (a.unrealizedUsd ?? 0)) || a.asset.localeCompare(b.asset));

  const sum = (k: "boughtUsd" | "soldUsd" | "realizedUsd" | "costBasisUsd") => round(assets.reduce((s, a) => s + a[k], 0));
  const unrealizedUsd = round(assets.reduce((s, a) => s + (a.unrealizedUsd ?? 0), 0));
  const realizedUsd = sum("realizedUsd");
  return {
    sinceMs: ordered[0]?.atMs ?? null,
    assets,
    totals: { boughtUsd: sum("boughtUsd"), soldUsd: sum("soldUsd"), realizedUsd, unrealizedUsd, totalUsd: round(realizedUsd + unrealizedUsd), costBasisUsd: sum("costBasisUsd") },
    unpriced,
  };
}
