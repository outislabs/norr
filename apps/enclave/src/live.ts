import { HeuristicRiskProvider, type RegistryEntry } from "@norr/core";
import { DexScreenerSignals, NearIntentsBalances, OneClick, OutLayerCustody, ShieldClient } from "@norr/intents";
import { PricingFeed } from "./pricing";
import { dstackAttestor } from "./attestation";
import { loadPolicy, parseOrigins } from "./config";
import { createApp } from "./app";
import { OwnerAuth, RpcAccessKeyChecker } from "./owner/auth";
import { BYPASS_BANNER, bypassWarning, resolveShieldMode } from "./shield-mode";
import { walletCredentials } from "./wallet-env";
import { FileLedger, FileVaultStore, dataDir } from "./persist";
import { DataCipher, FileSealKeys, SealingLedger } from "./seal";
import { newVault } from "./state";
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
export async function buildLiveDeps(env: NodeJS.ProcessEnv = process.env, opts: { pricingRetryBaseMs?: number } = {}) {
  // Resolved first, before any network call: an illegal bypass request must stop startup.
  const shieldMode = resolveShieldMode(env);
  if (shieldMode.bypass) console.warn(BYPASS_BANNER);
  // Read all configuration before any network call, so a missing value fails fast.
  const policy = loadPolicy(env);
  const { apiKey: outlayerKey, accountId: walletAccount } = walletCredentials(env);
  const oneclick = new OneClick({ apiKey: env.ONECLICK_API_KEY, baseUrl: env.ONECLICK_BASE_URL });
  // Not awaited: 1Click being down must not stop the service from starting (see pricing.ts).
  const now = Date.now;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const pricing = new PricingFeed(async () => {
    const [plain, withOndo] = await Promise.all([oneclick.tokens(false), oneclick.tokens(true)]);
    return { plain, withOndo };
  }, {
    cashAssetId: USDC_NEAR,
    sleep,
    baseDelayMs: opts.pricingRetryBaseMs,
    onFailure: (n, m) => console.warn(`  pricing: 1Click token list unavailable (attempt ${n}): ${m}. Trades are blocked until it loads; retrying.`),
    onReady: (n) => console.log(`  pricing: token list loaded (attempt ${n}). Trades are allowed.`),
  });
  void pricing.start();
  const registry = pricing.registry;
  // Until the list loads, USDC is not in the registry; this placeholder keeps read paths working and trades are blocked by the gate.
  const quoteAsset = new Proxy({ id: USDC_NEAR, symbol: "USDC", name: "USDC", class: "crypto", chain: "near", decimals: 6, ticker: "USDC", issuer: null, priceUsd: 1, coingeckoId: null, contractAddress: null } as RegistryEntry, {
    get: (fallback, prop) => ((registry.byId(USDC_NEAR) ?? fallback) as never)[prop as never],
  });

  // Durable: the service and the live runner share this directory, and a restart does not reset the caps.
  const dir = dataDir(env);
  const cipher = DataCipher.load(env, dir);
  const sealKeys = new FileSealKeys(dir);
  const vaults = new FileVaultStore(dir, [
    newVault(
      {
        id: policy.vaultId,
        owner: need(env, "NORR_OWNER_ACCOUNT"),
        policy,
        state: { realizedLossTodayUsd: 0, spentTodayUsd: 0, lastTradeAtMs: null, portfolioValueUsd: 0, equityValueUsd: 0 },
        custody: new OutLayerCustody({ apiKey: outlayerKey, accountId: walletAccount, baseUrl: env.OUTLAYER_BASE_URL }),
        walletAccount,
      },
      now(),
    ),
  ], cipher);
  // The agent's reasoning is never stored in the clear: sealed to the owner's key (or, until they enroll one, to the service key).
  const ledger = new SealingLedger(new FileLedger(dir, cipher), sealKeys, cipher, (id) => vaults.get(id)?.owner);
  ledger.sealExisting(policy.vaultId);

  const shield = env.SHIELD_API_KEY ? new ShieldClient({ apiKey: env.SHIELD_API_KEY }).feed : async () => null;
  const deps: TradeDeps = {
    registry,
    risk: new HeuristicRiskProvider(new DexScreenerSignals().signals),
    shield,
    shieldOnUnavailable: shieldMode.onUnavailable,
    onShieldBypass: (vaultId) => console.warn(bypassWarning(vaultId)),
    quoter: oneclick,
    auditor: oneclick,
    funder: oneclick,
    balances: new NearIntentsBalances(),
    vaults,
    ledger,
    quoteAsset,
    pricingReady: () => pricing.ready(),
    now,
    sleep,
  };
  return { deps, pricing, ledger, sealKeys, vaultId: policy.vaultId, walletAccount, shieldMode, shieldConfigured: Boolean(env.SHIELD_API_KEY) };
}

/** The live HTTP service: the same API as mock mode, on real rails. */
export async function buildLive(env: NodeJS.ProcessEnv = process.env) {
  const l = await buildLiveDeps(env);
  const tokens = new AgentTokens();
  const agentToken = tokens.issue(l.vaultId);
  return {
    app: createApp({ deps: l.deps, tokens, mock: false, adminToken: env.NORR_ADMIN_TOKEN, owner: new OwnerAuth({ keys: new RpcAccessKeyChecker() }), allowedOrigins: parseOrigins(env.NORR_ALLOWED_ORIGINS), attestor: dstackAttestor(env), seal: { keys: l.sealKeys, ledger: l.ledger } }),
    agentToken,
    vaultId: l.vaultId,
    shieldConfigured: l.shieldConfigured,
    shieldBypass: l.shieldMode.bypass,
  };
}
