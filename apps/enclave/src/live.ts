import { BalanceHealth } from "./errors";
import { HeuristicRiskProvider, type RegistryEntry } from "@norr/core";
import { DexScreenerSignals, GoPlusClient, NearIntentsBalances, OneClick, OutLayerCustody, OutLayerProvisioner, ShieldClient } from "@norr/intents";
import { FileValueHistory } from "./history";
import { readPortfolio, sampleValue } from "./owner/routes";
import { PricingFeed } from "./pricing";
import { dstackAttestor } from "./attestation";
import { loadPolicy, parseOrigins } from "./config";
import { createApp } from "./app";
import { OwnerAuth, RpcAccessKeyChecker } from "./owner/auth";
import { BYPASS_BANNER, bypassWarning, resolveShieldMode } from "./shield-mode";
import { walletCredentials } from "./wallet-env";
import { FileLedger, FileVaultStore, PerVaultLedger, dataDir } from "./persist";
import { FileTenantStore } from "./tenants";
import { BetaControl } from "./beta";
import { Onboarding } from "./onboarding";
import { FileOAuthPersistence, OAuthServer } from "./oauth";
import { AgentTokens, FileTokenPersistence } from "./tokens";
import { repairBook } from "./book-repair";
import { DataCipher, FileSealKeys, SealingLedger } from "./seal";
import { newVault } from "./state";
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
    onFailure: (n, m) => console.warn(`  pricing: 1Click token list unavailable (attempt ${n}): ${m}. Retrying; trades block if no list is loaded or the last one is over 5 minutes old.`),
    onReady: (n) => console.log(`  pricing: token list loaded (attempt ${n}). Trades are allowed; reference prices reload every minute.`),
    refreshMs: 60_000,
    maxAgeMs: 5 * 60_000,
  });
  const registry = pricing.registry;
  // Until the list loads, USDC is not in the registry; this placeholder keeps read paths working and trades are blocked by the gate.
  const quoteAsset = new Proxy({ id: USDC_NEAR, symbol: "USDC", name: "USDC", class: "crypto", chain: "near", decimals: 6, ticker: "USDC", issuer: null, priceUsd: 1, coingeckoId: null, contractAddress: null } as RegistryEntry, {
    get: (fallback, prop) => ((registry.byId(USDC_NEAR) ?? fallback) as never)[prop as never],
  });

  // Durable: the service and the live runner share this directory, and a restart does not reset the caps.
  const dir = dataDir(env);
  const cipher = DataCipher.load(env, dir);
  const sealKeys = new FileSealKeys(dir);
  const history = new FileValueHistory(dir, cipher);
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
  // Self-serve vaults (public beta): their records and sealed custody keys, each with its own ledger file.
  const tenants = new FileTenantStore(dir, cipher);
  const ledger = new SealingLedger(new PerVaultLedger(dir, cipher, new FileLedger(dir, cipher), () => tenants.ids()), sealKeys, cipher, (id) => vaults.get(id)?.owner);
  ledger.sealExisting(policy.vaultId);
  // Not awaited, like the token list. Once it loads, the one-off cost-book repair runs (book-repair.ts; recorded, never twice).
  void pricing.start().then(() => {
    if (!pricing.ready()) return;
    const r = repairBook({ vaults, ledger, registry, now }, policy.vaultId);
    if (r) console.log(`  cost book: rebuilt from the ledger (${r.fills} executed trades); before/after on /v1/pnl.`);
  });

  const shield = env.SHIELD_API_KEY ? new ShieldClient({ apiKey: env.SHIELD_API_KEY }).feed : async () => null;
  // Scam Shield's inputs: market data (DexScreener) and contract checks (GoPlus), fetched together. Scam Shield scores
  // them, and get_market_data shows the agent the same numbers. Both are read-only and keyless.
  const market = new DexScreenerSignals();
  const goplus = new GoPlusClient();
  const signals = async (asset: Parameters<typeof market.signals>[0]) => {
    const [m, contract] = await Promise.all([market.signals(asset), goplus.check(asset)]);
    return { ...m, contract };
  };
  const deps: TradeDeps = {
    registry,
    risk: new HeuristicRiskProvider(signals),
    marketSignals: signals,
    shield,
    // A deployment setting, reported to owners and agents: with no partner key there is no feed to check.
    incidentFeed: env.SHIELD_API_KEY ? "active" : "not_configured",
    shieldOnUnavailable: shieldMode.onUnavailable,
    onShieldBypass: (vaultId) => console.warn(bypassWarning(vaultId)),
    quoter: oneclick,
    auditor: oneclick,
    funder: oneclick,
    balances: new NearIntentsBalances(),
    balanceHealth: new BalanceHealth(),
    vaults,
    ledger,
    quoteAsset,
    pricingReady: () => pricing.ready(),
    now,
    sleep,
    dashboardUrl: env.NORR_DASHBOARD_URL || parseOrigins(env.NORR_ALLOWED_ORIGINS)[0],
  };
  const beta = BetaControl.fromEnv(env, dir);
  deps.vaultCapUsd = (id) => (tenants.ids().includes(id) ? beta.get().depositCapUsd : undefined);
  const onboarding = new Onboarding({
    tenants,
    provisioner: new OutLayerProvisioner({ baseUrl: env.OUTLAYER_BASE_URL }),
    vaults,
    registry,
    cash: () => quoteAsset,
    beta,
    now,
    custodyFor: (rec, apiKey) => new OutLayerCustody({ apiKey, accountId: rec.walletAccount, baseUrl: env.OUTLAYER_BASE_URL }),
  });
  const restored = onboarding.restore();
  if (restored > 0) console.log(`  self-serve vaults: ${restored} active vault(s) back in service.`);
  return { deps, pricing, history, ledger, sealKeys, vaultId: policy.vaultId, walletAccount, shieldMode, shieldConfigured: Boolean(env.SHIELD_API_KEY), onboarding, beta, dir, cipher };
}

/** The live HTTP service: the same API as mock mode, on real rails. */
export async function buildLive(env: NodeJS.ProcessEnv = process.env) {
  const l = await buildLiveDeps(env);
  // Token hashes are kept across restarts. A token is printed at startup only when the configured vault has none yet;
  // owners issue and revoke tokens in the dashboard.
  const tokens = new AgentTokens(new FileTokenPersistence(l.dir, l.cipher));
  const agentToken = tokens.list(l.vaultId).length === 0 ? tokens.issue(l.vaultId, { label: "Issued at startup" }) : null;
  // OAuth for MCP connectors, when this service knows its public URL. The consent screen is the dashboard.
  const origins = parseOrigins(env.NORR_ALLOWED_ORIGINS);
  const dashboardUrl = env.NORR_DASHBOARD_URL || origins[0];
  const oauth = env.NORR_PUBLIC_URL && dashboardUrl ? new OAuthServer({ issuer: env.NORR_PUBLIC_URL.replace(/\/+$/, ""), dashboardUrl: dashboardUrl.replace(/\/+$/, "") }, tokens, new FileOAuthPersistence(l.dir, l.cipher)) : undefined;
  // A reading every 15 minutes (the store keeps at most one per 10), so the value chart has points when nobody has the dashboard open.
  const sample = async () => {
    for (const v of l.deps.vaults.list()) sampleValue(l.deps, l.history, v.id, await readPortfolio(l.deps, v));
  };
  // Hourly: each reading is a custody balance read per vault, and the custody provider's free tier counts operations per wallet per day.
  setInterval(() => void sample().catch(() => undefined), 60 * 60_000).unref();
  return {
    app: createApp({ deps: l.deps, tokens, mock: false, adminToken: env.NORR_ADMIN_TOKEN, owner: new OwnerAuth({ keys: new RpcAccessKeyChecker() }), allowedOrigins: parseOrigins(env.NORR_ALLOWED_ORIGINS), attestor: dstackAttestor(env), seal: { keys: l.sealKeys, ledger: l.ledger }, history: l.history, onboarding: l.onboarding, beta: l.beta, oauth }),
    agentToken,
    vaultId: l.vaultId,
    shieldConfigured: l.shieldConfigured,
    shieldBypass: l.shieldMode.bypass,
  };
}
