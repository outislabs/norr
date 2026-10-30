import type { Policy, TradeRequest } from "@norr/shared";
import { ONDO, Registry, XSTOCKS, type OneClickToken } from "./registry";
import { HeuristicRiskProvider, type CryptoSignals } from "./risk";
import type { VaultState } from "./types";

const tok = (symbol: string, blockchain: string, price: number, coingeckoId?: string): OneClickToken => ({
  assetId: `nep141:${blockchain}-${symbol.toLowerCase()}.test`, symbol, blockchain, decimals: 18, price, coingeckoId,
});

export const SOL = tok("SOL", "sol", 150, "solana");
export const USDC_NEAR = tok("USDC", "near", 1, "usd-coin");
export const USDC_FAKE = tok("USDC", "hood", 1); // look-alike: same symbol, no trusted CoinGecko id
export const RUG = tok("RUGCOIN", "sol", 0.0001);
export const NVDA_ON = tok("NVDAon", "bsc", 211);
export const NVDA_X = tok("NVDAx", "sol", 211);
export const TSLA_ON = tok("TSLAon", "bsc", 370);

export const registry = () =>
  new Registry({
    crypto: [SOL, USDC_NEAR, USDC_FAKE, RUG],
    equities: [
      { issuer: ONDO, tokens: [NVDA_ON, TSLA_ON] },
      { issuer: XSTOCKS, tokens: [NVDA_X] },
    ],
  });

export const signalsByAsset: Record<string, CryptoSignals> = {
  [RUG.assetId]: { routable: true, liquidityUsd: 4_000, marketCapUsd: 50_000, ageDays: 2 },
  [USDC_FAKE.assetId]: { routable: true, liquidityUsd: 1_000, marketCapUsd: 10_000, ageDays: 1 },
};
export const riskProvider = () =>
  new HeuristicRiskProvider(async (a) => signalsByAsset[a.id] ?? { routable: true, liquidityUsd: 5e6, marketCapUsd: 1e9, ageDays: 900 });

export const policy = (over: Partial<Policy> = {}): Policy => ({
  vaultId: "alpha.norr.near", maxTradeUsd: 50, dailySpendCapUsd: 500, dailyLossCapUsd: 20, maxEquityPct: 60,
  allowedCrypto: "any_safe", allowedEquities: ["NVDA", "TSLA"], cooldownSec: 0, paused: false,
  nonUsConfirmed: true, allowMediumRisk: false, ...over,
});

export const state = (over: Partial<VaultState> = {}): VaultState => ({
  realizedLossTodayUsd: 0, spentTodayUsd: 0, lastTradeAtMs: null, portfolioValueUsd: 1000, equityValueUsd: 0, ...over,
});

export const request = (over: Partial<TradeRequest> = {}): TradeRequest => ({
  vaultId: "alpha.norr.near", side: "buy", asset: "NVDA", amountUsd: 40, reason: "test", ...over,
});
