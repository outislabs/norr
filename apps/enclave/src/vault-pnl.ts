import { pnlReport, type PnlReport } from "@norr/core";
import type { TradeDeps } from "./trade";

export interface VaultPnl extends PnlReport {
  since: string | null;
  /** What the numbers cover, in one sentence, for agents and owners alike. */
  scope: string;
}

/**
 * The vault's P&L since its first trade, from its own ledger (every executed trade, in order) and today's registry
 * prices. The same average-cost rule as the daily loss cap.
 */
export function vaultPnl(deps: Pick<TradeDeps, "ledger" | "registry">, vaultId: string): VaultPnl {
  const fills = deps.ledger
    .list(vaultId)
    .flatMap((r) => {
      if (r.decision.status !== "executed") return [];
      const qty = Number(r.decision.filled.amount);
      if (!(qty > 0)) return [];
      return [{ asset: r.decision.filled.asset, side: r.request.side, qty, usd: qty * r.decision.filled.priceUsd, atMs: r.at }];
    });
  const entries = deps.registry.entries();
  const priceOf = (asset: string): number | null => {
    const e = deps.registry.byId(asset) ?? entries.find((x) => x.symbol === asset);
    return e?.priceUsd ?? null;
  };
  const report = pnlReport(fills, priceOf);
  return {
    ...report,
    since: report.sinceMs === null ? null : new Date(report.sinceMs).toISOString(),
    scope: "Positions Norr bought for this vault, since its first trade. Realized: sells at average cost. Unrealized: what is still held at today's listed price. Deposits have no known cost and are not counted.",
  };
}
