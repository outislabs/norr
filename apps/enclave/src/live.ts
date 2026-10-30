import { HeuristicRiskProvider, ONDO, Registry, extraTokens } from "@norr/core";
import { DexScreenerSignals, NearIntentsBalances, OneClick, OutLayerCustody, ShieldClient } from "@norr/intents";
import { Policy } from "@norr/shared";
import { readFileSync } from "node:fs";
import { createApp } from "./app";
import { BYPASS_BANNER, bypassWarning, resolveShieldMode } from "./shield-mode";
import { MemoryLedger, MemoryVaultStore, newVault } from "./state";
import { AgentTokens } from "./tokens";
import type { TradeDeps } from "./trade";

const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

const need = (env: NodeJS.ProcessEnv, k: string): string => {
  const v = env[k];
  if (!v) throw new Error(`missing environment variable ${k} (see .env.example)`);
  return v;
};

/**
 * Real rails: live 1Click quotes and status, OutLayer custody for one vault, the Shield feed, and
 * DexScreener market data. Needs OUTLAYER_API_KEY, OUTLAYER_ACCOUNT_ID, NORR_POLICY_FILE and, for
 * trading to be allowed at all, SHIELD_API_KEY (without it the Shield check fails closed, unless the
 * dev-only bypass is on). Not exercised against mainnet by the automated tests.
 */
export async function buildLiveDeps(env: NodeJS.ProcessEnv = process.env) {
  // Resolved first, before any network call: an illegal bypass request must stop startup.
  const shieldMode = resolveShieldMode(env);
  if (shieldMode.bypass) console.warn(BYPASS_BANNER);
  // Read all configuration before any network call, so a missing value fails fast.
  const policy = Policy.parse(JSON.parse(readFileSync(need(env, "NORR_POLICY_FILE"), "utf8")));
  const walletAccount = need(env, "OUTLAYER_ACCOUNT_ID");
  const outlayerKey = need(env, "OUTLAYER_API_KEY");
  const oneclick = new OneClick({ apiKey: env.ONECLICK_API_KEY, baseUrl: env.ONECLICK_BASE_URL });
  const [plain, withOndo] = await Promise.all([oneclick.tokens(false), oneclick.tokens(true)]);
  const registry = new Registry({ crypto: plain, equities: [{ issuer: ONDO, tokens: extraTokens(plain, withOndo) }] });
  const quoteAsset = registry.byId(USDC_NEAR);
  if (!quoteAsset) throw new Error("USDC on NEAR is missing from the 1Click token list");

  const now = Date.now;
  const vaults = new MemoryVaultStore([
    newVault(
      {
        id: policy.vaultId,
        policy,
        state: { realizedLossTodayUsd: 0, spentTodayUsd: 0, lastTradeAtMs: null, portfolioValueUsd: 0, equityValueUsd: 0 },
        custody: new OutLayerCustody({ apiKey: outlayerKey, accountId: walletAccount, baseUrl: env.OUTLAYER_BASE_URL }),
        walletAccount,
      },
      now(),
    ),
  ]);

  const shield = env.SHIELD_API_KEY ? new ShieldClient({ apiKey: env.SHIELD_API_KEY }).feed : async () => null;
  const deps: TradeDeps = {
    registry,
    risk: new HeuristicRiskProvider(new DexScreenerSignals().signals),
    shield,
    shieldOnUnavailable: shieldMode.onUnavailable,
    onShieldBypass: (vaultId) => console.warn(bypassWarning(vaultId)),
    quoter: oneclick,
    auditor: oneclick,
    balances: new NearIntentsBalances(),
    vaults,
    ledger: new MemoryLedger(),
    quoteAsset,
    now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  return { deps, vaultId: policy.vaultId, walletAccount, shieldMode, shieldConfigured: Boolean(env.SHIELD_API_KEY) };
}

/** The live HTTP service: the same API as mock mode, on real rails. */
export async function buildLive(env: NodeJS.ProcessEnv = process.env) {
  const l = await buildLiveDeps(env);
  const tokens = new AgentTokens();
  const agentToken = tokens.issue(l.vaultId);
  return {
    app: createApp({ deps: l.deps, tokens, mock: false, adminToken: env.NORR_ADMIN_TOKEN }),
    agentToken,
    vaultId: l.vaultId,
    shieldConfigured: l.shieldConfigured,
    shieldBypass: l.shieldMode.bypass,
  };
}
