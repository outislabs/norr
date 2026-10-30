import { HeuristicRiskProvider, ONDO, Registry, XSTOCKS, type OneClickToken, type RegistryEntry, type ShieldFeed } from "@norr/core";
import { createMockRails, type MockOptions, type Quoter } from "@norr/intents";
import type { Policy, TradeRequest } from "@norr/shared";
import { MemoryLedger, MemoryVaultStore, newVault, type Vault } from "./state";
import type { TradeDeps } from "./trade";

const tok = (symbol: string, blockchain: string, price: number, decimals: number, coingeckoId?: string): OneClickToken => ({
  assetId: `nep141:${symbol.toLowerCase()}.${blockchain}`, symbol, blockchain, decimals, price, coingeckoId,
});

export const USDC = tok("USDC", "near", 1, 6, "usd-coin");
export const SOL = tok("SOL", "sol", 100, 9, "solana");
export const RUG = tok("RUGCOIN", "sol", 0.0001, 6);
export const NVDA_ON = tok("NVDAon", "bsc", 200, 18);
export const NVDA_X = tok("NVDAx", "sol", 200, 18);
export const TSLA_ON = tok("TSLAon", "bsc", 370, 18);
export const MSFT_ON = tok("MSFTon", "bsc", 520, 18);

export const makeRegistry = () =>
  new Registry({
    crypto: [USDC, SOL, RUG],
    equities: [
      { issuer: ONDO, tokens: [NVDA_ON, TSLA_ON, MSFT_ON] },
      { issuer: XSTOCKS, tokens: [NVDA_X] },
    ],
  });

export const WALLET = "vault-wallet-account";

export const policy = (over: Partial<Policy> = {}): Policy => ({
  vaultId: "v1", maxTradeUsd: 50, dailySpendCapUsd: 1000, dailyLossCapUsd: 20, maxEquityPct: 100,
  allowedCrypto: "any_safe", allowedEquities: ["NVDA", "TSLA", "MSFT"], cooldownSec: 0, paused: false,
  nonUsConfirmed: true, allowMediumRisk: false, privacy: "prefer", ...over,
});

export const req = (over: Partial<TradeRequest> = {}): TradeRequest => ({
  vaultId: "v1", side: "buy", asset: "NVDA", amountUsd: 40, reason: "test", ...over,
});

export interface Harness {
  deps: TradeDeps;
  vaults: MemoryVaultStore;
  ledger: MemoryLedger;
  rails: ReturnType<typeof createMockRails>;
  clock: { t: number };
  shieldCalls: { n: number };
}

/** Whole-flow test harness on mock rails. */
export function harness(opts: { mock?: MockOptions; policy?: Partial<Policy>; shield?: ShieldFeed | null; quoter?: (q: Quoter) => Quoter; settle?: { waitMs: number; intervalMs: number } } = {}): Harness {
  const registry = makeRegistry();
  const entries: RegistryEntry[] = registry.entries();
  const rails = createMockRails(entries, WALLET, { seed: { [USDC.assetId]: "1000000000" }, ...opts.mock });
  const clock = { t: 1_000_000 };
  const shieldCalls = { n: 0 };
  const vault: Vault = newVault(
    {
      id: "v1", policy: policy(opts.policy), custody: rails.custody, walletAccount: WALLET,
      state: { realizedLossTodayUsd: 0, spentTodayUsd: 0, lastTradeAtMs: null, portfolioValueUsd: 1000, equityValueUsd: 0 },
    },
    1_000_000,
  );
  const vaults = new MemoryVaultStore([vault]);
  const ledger = new MemoryLedger();
  const risk = new HeuristicRiskProvider(async (a) =>
    a.symbol === "RUGCOIN" ? { routable: true, liquidityUsd: 3_000, marketCapUsd: 40_000, ageDays: 2 } : { routable: true, liquidityUsd: 5e6, marketCapUsd: 1e9, ageDays: 900 },
  );
  const deps: TradeDeps = {
    registry, risk, vaults, ledger, auditor: rails.auditor, balances: rails.balances,
    quoter: opts.quoter ? opts.quoter(rails.quoter) : rails.quoter,
    quoteAsset: registry.byId(USDC.assetId)!,
    shield: async () => { shieldCalls.n++; return opts.shield === undefined ? { status: "operational" } : opts.shield; },
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; },
    settle: opts.settle ?? { waitMs: 0, intervalMs: 1 },
  };
  return { deps, vaults, ledger, rails, clock, shieldCalls };
}
