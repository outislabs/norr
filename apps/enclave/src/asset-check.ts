import { checkShield, EQUITY_DISCLAIMER, incidentFeedInfo, type RiskResult } from "@norr/core";
import type { ContractRef, RegistryEntry } from "@norr/core";
import type { TradeDeps } from "./trade";

/**
 * The safety report for a contract NEAR Intents does not route: the same Scam Shield inputs (market data, GoPlus on that
 * exact contract), so an owner or agent can see what it is, with the plain answer that Norr cannot trade it privately.
 */
export async function contractReport(deps: TradeDeps, ref: ContractRef) {
  const probe: RegistryEntry = { id: `${ref.chain}:${ref.address}`, symbol: "?", name: "", class: "crypto", chain: ref.chain, decimals: 0, ticker: "?", issuer: null, priceUsd: null, coingeckoId: null, contractAddress: ref.address };
  const signals = await deps.marketSignals?.(probe).catch(() => null);
  const risk = await deps.risk.assess(probe).catch(() => null);
  return {
    message: `${ref.chain}:${ref.address} is not available on NEAR Intents yet, so it can't be traded privately. Norr does not trade it. The safety report below is for information only.`,
    contract: ref,
    safety: { liquidityUsd: signals?.liquidityUsd ?? null, marketCapUsd: signals?.marketCapUsd ?? null, ageDays: signals?.ageDays ?? null, risk: risk ? { level: risk.level, score: risk.score, reasons: risk.reasons, contract: risk.contract ?? null } : null },
  };
}

/**
 * The verdict on one asset before trading: Scam Shield (market data and GoPlus contract checks) for crypto,
 * eligibility for stocks, and the incident feed when this deployment has one. The same answer for the agent
 * (check_asset) and for the owner (the dashboard's Check a token).
 */
export async function assetCheck(deps: TradeDeps, query: string, nonUsConfirmed: boolean) {
  const feedStatus = deps.incidentFeed ?? "active";
  const found = deps.registry.lookup(query);
  if (found.kind === "not_routable") return { found: false as const, routable: false as const, ...(await contractReport(deps, found.ref)), incidentFeed: incidentFeedInfo(feedStatus) };
  if (found.kind === "unknown") return { found: false as const, message: `"${query}" is not a tradable asset. Name it by chain and contract address (for example base:0x…) to check a specific token.`, incidentFeed: incidentFeedInfo(feedStatus) };
  const res = found.resolution;
  const active = feedStatus === "active";
  const feed = active ? await deps.shield().catch(() => null) : null;
  const versions = await Promise.all(
    res.candidates.map(async (e) => {
      const shield = active ? checkShield(feed, e) : null;
      const risk: RiskResult | null = res.class === "crypto" ? await deps.risk.assess(e) : null;
      return { symbol: e.symbol, issuer: e.issuer, chain: e.chain, contract: e.contractAddress, id: e.id, shieldBlocked: shield?.message ?? null, risk };
    }),
  );
  return {
    found: true as const,
    class: res.class,
    ticker: res.ticker,
    versions,
    ...(res.ambiguous ? { ambiguous: true, message: `Several different tokens are called ${res.ticker}. Trades need the chain and contract address of the one you mean (each version below lists them).` } : {}),
    ...(res.byContract ? { byContract: true } : {}),
    ...(res.class === "equity" ? { eligible: nonUsConfirmed, notice: EQUITY_DISCLAIMER } : {}),
    incidentFeed: incidentFeedInfo(feedStatus),
  };
}
