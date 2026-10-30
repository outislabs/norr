import { unitsToNumber, type Registry } from "@norr/core";

export interface Holding {
  assetId: string;
  symbol: string;
  class: "crypto" | "equity";
  amount: number;
  valueUsd: number;
}

export interface Portfolio {
  holdings: Holding[];
  totalUsd: number;
  byClass: { crypto: number; equity: number };
}

/** Values Intents balances at the registry's reference prices. Unknown or unpriced assets are left out. */
export function valuePortfolio(units: Record<string, string>, registry: Registry): Portfolio {
  const holdings: Holding[] = [];
  for (const [assetId, raw] of Object.entries(units)) {
    const e = registry.byId(assetId);
    if (!e || e.priceUsd === null) continue;
    const amount = unitsToNumber(raw, e.decimals);
    holdings.push({ assetId, symbol: e.symbol, class: e.class, amount, valueUsd: amount * e.priceUsd });
  }
  holdings.sort((a, b) => b.valueUsd - a.valueUsd);
  const byClass = { crypto: 0, equity: 0 };
  for (const h of holdings) byClass[h.class] += h.valueUsd;
  return { holdings, totalUsd: byClass.crypto + byClass.equity, byClass };
}
