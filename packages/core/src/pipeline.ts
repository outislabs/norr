import type { Policy, TradeRequest, Asset } from "@norr/shared";
import { evaluatePolicy } from "./policy";
import type { Registry, RegistryEntry } from "./registry";
import { checkEquityEligibility, gateRisk, type RiskProvider, type RiskResult } from "./risk";
import { checkShield, type ShieldFeed } from "./shield";
import { block, type Block, type VaultState } from "./types";

export interface PreTradeInput {
  request: TradeRequest;
  policy: Policy;
  state: VaultState;
  registry: Registry;
  risk: RiskProvider;
  shield: ShieldFeed | null;
  shieldOnUnavailable?: "block" | "allow";
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

  const survivors: { entry: RegistryEntry; risk: RiskResult }[] = [];
  let firstFailure: Block | null = null;
  for (const entry of res.candidates) {
    const shieldFailure = checkShield(i.shield, entry, { onUnavailable: i.shieldOnUnavailable });
    if (shieldFailure) {
      firstFailure ??= shieldFailure;
      continue;
    }
    // Equities are gated by eligibility and price sanity, not Scam Shield.
    const risk: RiskResult = res.class === "crypto" ? await i.risk.assess(entry) : { score: 0, level: "low", reasons: [] };
    const riskFailure = gateRisk(risk, i.policy.allowMediumRisk);
    if (riskFailure) firstFailure ??= riskFailure;
    else survivors.push({ entry, risk });
  }
  if (survivors.length === 0) return firstFailure!;

  // If several look-alike candidates survive, keep only the safest band.
  const best = Math.min(...survivors.map((s) => RANK[s.risk.level]));
  const kept = survivors.filter((s) => RANK[s.risk.level] === best);

  const symbol = kept[0]!.entry.symbol;
  const policyFailure = evaluatePolicy(i.policy, i.request, { class: res.class, ticker: res.ticker, symbol }, i.state, i.nowMs);
  if (policyFailure) return policyFailure;

  return {
    ok: true,
    class: res.class,
    ticker: res.ticker,
    candidates: kept.map((s) => s.entry),
    risk: Object.fromEntries(kept.map((s) => [s.entry.id, s.risk])),
  };
}

export const isBlock = (r: PreTradePass | Block): r is Block => r.ok === false;

/** No candidate returned a quote. */
export const noLiquidity = (): Block =>
  block("NO_LIQUIDITY", "No liquidity is available for this trade right now. Smaller trades in tokenized stocks can fail; try a larger amount or another asset.");
