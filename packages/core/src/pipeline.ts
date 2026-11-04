import type { Policy, TradeRequest, Asset } from "@norr/shared";
import { evaluatePolicy } from "./policy";
import type { Registry, RegistryEntry } from "./registry";
import { checkEquityEligibility, gateRisk, type RiskProvider, type RiskResult } from "./risk";
import { checkShield, type IncidentFeedStatus, type ShieldFeed } from "./shield";
import { block, type Block, type VaultState } from "./types";

export interface PreTradeInput {
  request: TradeRequest;
  policy: Policy;
  state: VaultState;
  registry: Registry;
  risk: RiskProvider;
  shield: ShieldFeed | null;
  shieldOnUnavailable?: "block" | "allow";
  /** "not_configured" (no partner key): the feed step is skipped; the answer says so (see incidentFeedInfo). */
  incidentFeed?: IncidentFeedStatus;
  nowMs: number;
}

export interface PreTradePass {
  ok: true;
  class: Asset["class"];
  ticker: string;
  /** Versions that passed every check; the enclave quotes these and routes to the best. */
  candidates: RegistryEntry[];
  risk: Record<string, RiskResult>;
}

const RANK = { low: 0, medium: 1, high: 2 } as const;

/**
 * Steps 2-4 of the trade pipeline, before any quote is requested: paused, resolve, equity
 * eligibility, Shield, risk, policy. PAUSED goes first, a deliberate change from the
 * spec order: a paused vault should do no work and make no outbound calls. Price sanity
 * and NO_LIQUIDITY need a quote, so they run afterwards (checkPriceSanity, selectBestQuote).
 */
export async function preTradeChecks(i: PreTradeInput): Promise<PreTradePass | Block> {
  if (i.policy.paused) {
    return block("PAUSED", "This vault is paused by its owner. No trades are allowed until it is resumed.");
  }

  const res = i.registry.resolve(i.request.asset);
  if (!res) return block("UNKNOWN_ASSET", `"${i.request.asset}" is not a tradable asset. Use list_assets to see what is available.`);

  if (res.class === "equity") {
    const eligibility = checkEquityEligibility(i.policy.nonUsConfirmed);
    if (eligibility) return eligibility;
  }

  // 1. Scam risk: the vault's own bar for which tokens are acceptable.
  const survivors: { entry: RegistryEntry; risk: RiskResult }[] = [];
  let riskFailure: Block | null = null;
  for (const entry of res.candidates) {
    // Equities are gated by eligibility and price sanity, not Scam Shield.
    const risk: RiskResult = res.class === "crypto" ? await i.risk.assess(entry) : { score: 0, level: "low", reasons: [] };
    const failure = gateRisk(risk, i.policy.allowMediumRisk);
    if (failure) riskFailure ??= failure;
    else survivors.push({ entry, risk });
  }
  if (survivors.length === 0) return riskFailure!;

  // If several look-alike candidates survive, keep only the safest band.
  const safest = (xs: typeof survivors) => {
    const best = Math.min(...xs.map((s) => RANK[s.risk.level]));
    return xs.filter((s) => RANK[s.risk.level] === best);
  };
  const policyFor = (symbol: string) => evaluatePolicy(i.policy, i.request, { class: res.class, ticker: res.ticker, symbol }, i.state, i.nowMs);

  // 2. The vault's rules (size, daily caps, allowlists, cooldown, stock share), so a trade that breaks one is refused
  //    with that rule's reason, whatever the incident feed says.
  let kept = safest(survivors);
  const policyFailure = policyFor(kept[0]!.entry.symbol);
  if (policyFailure) return policyFailure;

  // 3. The NEAR Intents incident feed, last, for trades that pass every rule. Still fail-closed: an active incident, or a
  //    feed that cannot be read, blocks the candidate. Skipped only when the deployment has no feed configured.
  if (i.incidentFeed === "not_configured") {
    return { ok: true, class: res.class, ticker: res.ticker, candidates: kept.map((s) => s.entry), risk: Object.fromEntries(kept.map((s) => [s.entry.id, s.risk])) };
  }
  let shieldFailure: Block | null = null;
  const clear = survivors.filter((s) => {
    const f = checkShield(i.shield, s.entry, { onUnavailable: i.shieldOnUnavailable });
    if (f) shieldFailure ??= f;
    return !f;
  });
  if (clear.length === 0) return shieldFailure!;
  const clearKept = safest(clear);
  if (clearKept[0]!.entry.symbol !== kept[0]!.entry.symbol) {
    const again = policyFor(clearKept[0]!.entry.symbol);
    if (again) return again;
  }
  kept = clearKept;

  return {
    ok: true,
    class: res.class,
    ticker: res.ticker,
    candidates: kept.map((s) => s.entry),
    risk: Object.fromEntries(kept.map((s) => [s.entry.id, s.risk])),
  };
}

export const isBlock = (r: PreTradePass | Block): r is Block => r.ok === false;

/** Confidential trading was required (or the only option) and is not possible right now. */
export const privacyUnavailable = (detail: string): Block =>
  block("PRIVACY_UNAVAILABLE", `This vault trades confidentially only, and that is not possible right now: ${detail}`);

/** The asset list has not loaded (the market data service was unreachable at startup); the service is retrying. */
export const pricingUnavailable = (): Block =>
  block("PRICING_UNAVAILABLE", "Pricing is unavailable right now: the market data service could not be reached at startup. Norr is retrying in the background. Try again in a minute.");

/** Public beta: a self-serve vault holds more than its cap, so buys pause (sells still work). */
export const vaultCapReached = (valueUsd: number, capUsd: number): Block =>
  block("VAULT_CAP", `This vault holds about $${valueUsd.toFixed(2)}, above the beta limit of $${capUsd}. Buys are paused until it holds less; sells still work.`);

/** No candidate returned a quote. */
export const noLiquidity = (): Block =>
  block("NO_LIQUIDITY", "No liquidity is available for this trade right now. Smaller trades in tokenized stocks can fail; try a larger amount or another asset.");
