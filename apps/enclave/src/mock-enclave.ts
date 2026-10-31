import { HeuristicRiskProvider, ONDO, Registry, presetPolicy, type CryptoSignals, type OneClickToken, type ShieldFeed } from "@norr/core";
import { createMockRails } from "@norr/intents";
import { createApp } from "./app";
import { OwnerAuth, type AccessKeyChecker } from "./owner/auth";
import { DataCipher, MemorySealKeys, SealingLedger } from "./seal";
import { MemoryLedger, MemoryVaultStore, newVault } from "./state";
import { AgentTokens } from "./tokens";
import type { TradeDeps } from "./trade";

const tok = (symbol: string, blockchain: string, price: number, decimals: number, coingeckoId?: string): OneClickToken => ({
  assetId: `nep141:${symbol.toLowerCase()}.${blockchain}.mock`, symbol, blockchain, decimals, price, coingeckoId,
});

/** A small demo catalog. Prices are fixed; nothing here talks to a network. */
export const DEMO = {
  USDC: tok("USDC", "near", 1, 6, "usd-coin"),
  SOL: tok("SOL", "sol", 100, 9, "solana"),
  wNEAR: tok("wNEAR", "near", 4.5, 24, "wrapped-near"),
  RUG: tok("RUGPULL", "sol", 0.0002, 6),
  NVDAon: tok("NVDAon", "bsc", 208, 18),
  TSLAon: tok("TSLAon", "bsc", 370, 18),
  SPYon: tok("SPYon", "bsc", 768, 18),
};

const RUG_SIGNALS: CryptoSignals = { routable: true, liquidityUsd: 3_200, marketCapUsd: 41_000, ageDays: 2 };
const HEALTHY: CryptoSignals = { routable: true, liquidityUsd: 5_000_000, marketCapUsd: 900_000_000, ageDays: 800 };

/** The mock vault's owner account. Mock mode accepts any key for it: no funds, localhost only. */
export const MOCK_OWNER = "demo-owner.mock.near";

export interface MockEnclave {
  app: ReturnType<typeof createApp>;
  deps: TradeDeps;
  vaults: MemoryVaultStore;
  tokens: AgentTokens;
  agentToken: string;
  adminToken: string;
  vaultId: string;
  ownerAuth: OwnerAuth;
  /** The mock rails, so tests can simulate an owner deposit arriving. */
  rails: ReturnType<typeof createMockRails>;
  sealKeys: MemorySealKeys;
  sealing: SealingLedger;
}

/**
 * The whole Norr service on mock rails (NORR_MOCK=1): no 1Click, no custody provider, no TEE, no funds.
 * It starts with a demo vault holding its cash in the confidential layer, on the Balanced preset,
 * owner-confirmed for equities, so trades run confidentially by default.
 */
export function createMockEnclave(o: { startingUsd?: number; shield?: ShieldFeed | null; now?: () => number; agentToken?: string; keys?: AccessKeyChecker } = {}): MockEnclave {
  const registry = new Registry({ crypto: [DEMO.USDC, DEMO.SOL, DEMO.wNEAR, DEMO.RUG], equities: [{ issuer: ONDO, tokens: [DEMO.NVDAon, DEMO.TSLAon, DEMO.SPYon] }] });
  const now = o.now ?? Date.now;
  const vaultId = "demo";
  const walletAccount = "demo-vault.mock.near";
  const rails = createMockRails(registry.entries(), walletAccount, { confidentialSeed: { [DEMO.USDC.assetId]: String(Math.round((o.startingUsd ?? 1000) * 1e6)) } });

  const vaults = new MemoryVaultStore([
    newVault(
      {
        id: vaultId,
        owner: MOCK_OWNER,
        policy: { ...presetPolicy("balanced", vaultId), nonUsConfirmed: true },
        state: { realizedLossTodayUsd: 0, spentTodayUsd: 0, lastTradeAtMs: null, portfolioValueUsd: 0, equityValueUsd: 0 },
        custody: rails.custody,
        walletAccount,
      },
      now(),
    ),
  ]);
  // Mock mode keeps the same rule as live: the agent's reasoning is only ever stored sealed.
  const sealKeys = new MemorySealKeys();
  const sealing = new SealingLedger(new MemoryLedger(), sealKeys, DataCipher.random(), (id) => vaults.get(id)?.owner);

  const deps: TradeDeps = {
    registry,
    risk: new HeuristicRiskProvider(async (a) => (a.symbol === "RUGPULL" ? RUG_SIGNALS : HEALTHY)),
    shield: async () => (o.shield === undefined ? { status: "operational" } : o.shield),
    quoter: rails.quoter,
    auditor: rails.auditor,
    funder: rails.funder,
    balances: rails.balances,
    vaults,
    ledger: sealing,
    quoteAsset: registry.byId(DEMO.USDC.assetId)!,
    now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    settle: { waitMs: 5_000, intervalMs: 250 },
  };

  const tokens = new AgentTokens();
  let agentToken: string;
  if (o.agentToken) {
    tokens.register(vaultId, o.agentToken);
    agentToken = o.agentToken;
  } else agentToken = tokens.issue(vaultId);
  const adminToken = `norr_admin_mock_${Math.random().toString(36).slice(2)}`;
  // Mock mode accepts any key for an account (it holds no funds and listens on localhost); live mode checks the chain.
  const ownerAuth = new OwnerAuth({ keys: o.keys ?? { hasKey: async () => true }, now });
  return { app: createApp({ deps, tokens, mock: true, adminToken, owner: ownerAuth, seal: { keys: sealKeys, ledger: sealing } }), deps, vaults, tokens, agentToken, adminToken, vaultId, ownerAuth, rails, sealKeys, sealing };
}
