import { unitsToNumber, type Registry } from "@norr/core";

export type Layer = "public" | "confidential";

export interface Holding {
  assetId: string;
  symbol: string;
  class: "crypto" | "equity";
  amount: number;
  valueUsd: number;
  /** Which layer holds it. */
  layer?: Layer;
}

export interface Portfolio {
  holdings: Holding[];
  totalUsd: number;
  byClass: { crypto: number; equity: number };
}

/** What one unit of the vault's cash asset (USDC) is worth in USD. Cash is valued at its peg, not at a market price that drifts by a hair between reads. */
export const CASH_USD = 1;

/**
 * Values Intents balances at the registry's reference prices. Unknown or unpriced assets are left out.
 * Asset ids in `pegged` (the vault's cash asset) are valued at CASH_USD, so the same balance always shows the same value.
 */
export function valuePortfolio(units: Record<string, string>, registry: Registry, layer?: Layer, pegged: readonly string[] = []): Portfolio {
  const holdings: Holding[] = [];
  for (const [assetId, raw] of Object.entries(units)) {
    const e = registry.byId(assetId);
    if (!e || e.priceUsd === null) continue;
    const amount = unitsToNumber(raw, e.decimals);
    holdings.push({ assetId, symbol: e.symbol, class: e.class, amount, valueUsd: amount * (pegged.includes(assetId) ? CASH_USD : e.priceUsd), ...(layer ? { layer } : {}) });
  }
  holdings.sort((a, b) => b.valueUsd - a.valueUsd);
  const byClass = { crypto: 0, equity: 0 };
  for (const h of holdings) byClass[h.class] += h.valueUsd;
  return { holdings, totalUsd: byClass.crypto + byClass.equity, byClass };
}

/** Both layers together, each holding labelled with where it sits. */
export function valueLayers(layers: { public?: Record<string, string>; confidential?: Record<string, string> }, registry: Registry, pegged: readonly string[] = []): Portfolio {
  const parts = [
    ...(layers.public ? valuePortfolio(layers.public, registry, "public", pegged).holdings : []),
    ...(layers.confidential ? valuePortfolio(layers.confidential, registry, "confidential", pegged).holdings : []),
  ].sort((a, b) => b.valueUsd - a.valueUsd);
  const byClass = { crypto: 0, equity: 0 };
  for (const h of parts) byClass[h.class] += h.valueUsd;
  return { holdings: parts, totalUsd: byClass.crypto + byClass.equity, byClass };
}
