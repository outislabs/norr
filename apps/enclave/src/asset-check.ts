import { checkShield, EQUITY_DISCLAIMER, incidentFeedInfo, type RiskResult } from "@norr/core";
import type { TradeDeps } from "./trade";

/**
 * The verdict on one asset before trading: Scam Shield (market data and GoPlus contract checks) for crypto,
 * eligibility for stocks, and the incident feed when this deployment has one. The same answer for the agent
 * (check_asset) and for the owner (the dashboard's Check a token).
 */
export async function assetCheck(deps: TradeDeps, query: string, nonUsConfirmed: boolean) {
  const feedStatus = deps.incidentFeed ?? "active";
  const res = deps.registry.resolve(query);
  if (!res) return { found: false as const, message: `"${query}" is not a tradable asset.`, incidentFeed: incidentFeedInfo(feedStatus) };
  const active = feedStatus === "active";
  const feed = active ? await deps.shield().catch(() => null) : null;
  const versions = await Promise.all(
    res.candidates.map(async (e) => {
      const shield = active ? checkShield(feed, e) : null;
      const risk: RiskResult | null = res.class === "crypto" ? await deps.risk.assess(e) : null;
      return { symbol: e.symbol, issuer: e.issuer, chain: e.chain, shieldBlocked: shield?.message ?? null, risk };
    }),
  );
  return {
    found: true as const,
    class: res.class,
    ticker: res.ticker,
    versions,
    ...(res.class === "equity" ? { eligible: nonUsConfirmed, notice: EQUITY_DISCLAIMER } : {}),
    incidentFeed: incidentFeedInfo(feedStatus),
  };
}
