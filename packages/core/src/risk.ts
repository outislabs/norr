import type { RegistryEntry } from "./registry";
import { block, type Block } from "./types";

export type RiskLevel = "low" | "medium" | "high";

export interface RiskResult {
  score: number; // 0-100
  level: RiskLevel;
  reasons: string[];
}

/** Pluggable so richer data can replace the v1 heuristics later. */
export interface RiskProvider {
  assess(asset: RegistryEntry): Promise<RiskResult>;
}

/** Read-only market signals. `null` means unknown, which is scored as a risk. */
export interface CryptoSignals {
  routable: boolean;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  ageDays: number | null;
}

/**
 * Stablecoins and majors, identified by CoinGecko id, which 1Click assigns. Matching on
 * symbol would let a look-alike "USDC" on another chain through.
 */
export const TRUSTED_COINGECKO_IDS: ReadonlySet<string> = new Set([
  "bitcoin", "ethereum", "solana", "near", "wrapped-near", "binancecoin", "ripple", "dogecoin",
  "cardano", "avalanche-2", "chainlink", "litecoin", "sui", "tron", "wrapped-bitcoin",
  "usd-coin", "tether", "dai",
]);

export const levelOf = (score: number): RiskLevel => (score >= 65 ? "high" : score >= 35 ? "medium" : "low");

/** v1 Scam Shield heuristics. Each rule adds to the score and records a reason. */
export function scoreCryptoRisk(asset: RegistryEntry, s: CryptoSignals): RiskResult {
  if (!s.routable) {
    return { score: 100, level: "high", reasons: ["Not routable via NEAR Intents (1Click)."] };
  }
  if (asset.coingeckoId && TRUSTED_COINGECKO_IDS.has(asset.coingeckoId)) {
    return { score: 0, level: "low", reasons: ["Known stablecoin or major asset."] };
  }

  let score = 0;
  const reasons: string[] = [];
  const add = (n: number, why: string) => {
    score += n;
    reasons.push(why);
  };

  if (s.liquidityUsd === null) add(25, "Liquidity is unknown.");
  else if (s.liquidityUsd < 50_000) add(40, `Very low liquidity ($${Math.round(s.liquidityUsd).toLocaleString("en-US")}).`);
  else if (s.liquidityUsd < 250_000) add(20, `Low liquidity ($${Math.round(s.liquidityUsd).toLocaleString("en-US")}).`);

  if (s.marketCapUsd === null) add(25, "Market cap is unknown.");
  else if (s.marketCapUsd < 1_000_000) add(30, `Tiny market cap ($${Math.round(s.marketCapUsd).toLocaleString("en-US")}).`);
  else if (s.marketCapUsd < 10_000_000) add(10, "Small market cap (under $10M).");

  if (s.ageDays === null) add(15, "Token age is unknown.");
  else if (s.ageDays < 7) add(40, `Very new token (${s.ageDays} days old).`);
  else if (s.ageDays < 30) add(20, `New token (${s.ageDays} days old).`);

  score = Math.min(100, score);
  if (reasons.length === 0) reasons.push("No risk signals found.");
  return { score, level: levelOf(score), reasons };
}

/** v1 provider. `signals` is a read-only data source injected by the enclave. */
export class HeuristicRiskProvider implements RiskProvider {
  constructor(private readonly signals: (asset: RegistryEntry) => Promise<CryptoSignals>) {}

  async assess(asset: RegistryEntry): Promise<RiskResult> {
    return scoreCryptoRisk(asset, await this.signals(asset));
  }
}

/** High is always blocked. Medium passes only if the owner opted in. */
export function gateRisk(r: RiskResult, allowMedium: boolean): Block | null {
  if (r.level === "low" || (r.level === "medium" && allowMedium)) return null;
  const why = r.reasons.join(" ");
  return r.level === "high"
    ? block("SCAM_RISK", `Blocked as high risk (score ${r.score}). ${why}`)
    : block("SCAM_RISK", `Blocked as medium risk (score ${r.score}); this vault does not allow medium-risk tokens. ${why}`);
}

export const EQUITY_DISCLAIMER =
  "Tokenized stocks and ETFs are structured notes that track the underlying security. " +
  "Holders have no shareholder rights. They are offered to non-US persons only, and other restrictions may apply.";

/** Equities need the owner's non-US confirmation first. */
export function checkEquityEligibility(nonUsConfirmed: boolean): Block | null {
  return nonUsConfirmed
    ? null
    : block("INELIGIBLE", `Tokenized equities are disabled until the owner confirms non-US status. ${EQUITY_DISCLAIMER}`);
}

/** Price per token implied by a quote. */
export const impliedPriceUsd = (usd: number, tokens: number): number => (tokens > 0 ? usd / tokens : Number.NaN);

/** Block if the quote's price strays too far from the reference price. */
export function checkPriceSanity(referenceUsd: number | null, impliedUsd: number, maxDeviationPct = 2): Block | null {
  if (referenceUsd === null || !(referenceUsd > 0) || !Number.isFinite(impliedUsd)) {
    return block("PRICE_SANITY", "No reliable reference price to check this quote against.");
  }
  const dev = (Math.abs(impliedUsd - referenceUsd) / referenceUsd) * 100;
  return dev > maxDeviationPct
    ? block("PRICE_SANITY", `Quoted price is ${dev.toFixed(1)}% away from the reference price (limit ${maxDeviationPct}%).`)
    : null;
}
