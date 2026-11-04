import { HeuristicRiskProvider, ONDO, Registry, presetPolicy, type CryptoSignals, type OneClickToken, type ShieldFeed } from "@norr/core";
import { createMockRails, MockProvisioner } from "@norr/intents";
import { BetaControl, TERMS_URL, TERMS_VERSION } from "./beta";
import { Onboarding } from "./onboarding";
import { MemoryTenantStore } from "./tenants";
import { createHash } from "node:crypto";
import { createApp } from "./app";
import { verifyNep413 } from "./owner/nep413";
import type { Attestor } from "./attestation";
import { OwnerAuth, type AccessKeyChecker } from "./owner/auth";
import { MemoryValueHistory } from "./history";
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
  // Funding sources on other chains (the Fund tab's picker); the contract is Base's real USDC, prices are fixed.
  USDC_BASE: { ...tok("USDC", "base", 1, 6, "usd-coin"), contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
  ETH: tok("ETH", "eth", 2300, 18, "ethereum"),
};

// Fixed, GoPlus-shaped contract checks so mock mode shows them too: the rug keeps live mint and freeze authority.
const RUG_SIGNALS: CryptoSignals = { routable: true, liquidityUsd: 3_200, marketCapUsd: 41_000, ageDays: 2, contract: { status: "ok", source: "goplus", family: "solana", address: "RUGmock1111111111111111111111111111111111111", data: { mintable: { status: "1" }, freezable: { status: "1" } } } };
const HEALTHY: CryptoSignals = { routable: true, liquidityUsd: 5_000_000, marketCapUsd: 900_000_000, ageDays: 800, contract: { status: "ok", source: "goplus", family: "solana", address: "mock", data: { trusted_token: 1 } } };

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
  /** Self-serve vaults on mock rails: the stand-in custody provider and contract, and the beta settings. */
  provisioner: MockProvisioner;
  tenants: MemoryTenantStore;
  onboarding: Onboarding;
  beta: BetaControl;
}

/** Each new mock vault starts with this much pretend USDC in its confidential balance, so it can be tried at once. */
export const MOCK_VAULT_START_USD = 100;

/**
 * The whole Norr service on mock rails (NORR_MOCK=1): no 1Click, no custody provider, no TEE, no funds.
 * It starts with a demo vault holding its cash in the confidential layer, on the Balanced preset,
 * owner-confirmed for equities, so trades run confidentially by default.
 */
export function createMockEnclave(o: { startingUsd?: number; shield?: ShieldFeed | null; now?: () => number; agentToken?: string; keys?: AccessKeyChecker; allowedOrigins?: string[]; attestor?: Attestor | null; requireApproval?: boolean } = {}): MockEnclave {
  const registry = new Registry({ crypto: [DEMO.USDC, DEMO.SOL, DEMO.wNEAR, DEMO.RUG, DEMO.USDC_BASE, DEMO.ETH], equities: [{ issuer: ONDO, tokens: [DEMO.NVDAon, DEMO.TSLAon, DEMO.SPYon] }] });
  const now = o.now ?? Date.now;
  const vaultId = "demo";
  const walletAccount = "demo-vault.mock.near";
  const rails = createMockRails(registry.entries(), walletAccount, { confidentialSeed: { [DEMO.USDC.assetId]: String(Math.round((o.startingUsd ?? 1000) * 1e6)) }, requireApproval: o.requireApproval });

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
    marketSignals: async (a) => (a.symbol === "RUGPULL" ? RUG_SIGNALS : HEALTHY),
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

  // Self-serve vaults: a mock custody provider and contract; each new vault gets its own rails once it is active.
  const provisioner = new MockProvisioner();
  const tenants = new MemoryTenantStore();
  const beta = new BetaControl({ signupsOpen: true, depositCapUsd: 100, maxVaults: 50, maxVaultsPerOwner: 1, termsVersion: TERMS_VERSION, termsUrl: TERMS_URL });
  const tenantRails = new Map<string, { rails: ReturnType<typeof createMockRails>; owner: string; walletPubkey: string }>();
  const onboarding = new Onboarding({
    tenants,
    provisioner,
    vaults,
    registry,
    cash: () => deps.quoteAsset,
    beta,
    now,
    custodyFor: (rec) => {
      const r = createMockRails(registry.entries(), rec.walletAccount, {
        confidentialSeed: { [DEMO.USDC.assetId]: String(MOCK_VAULT_START_USD * 1e6) },
        requireApproval: !(rec.custody?.autonomous ?? false),
        approvalPrefix: rec.id.slice(2, 10),
      });
      tenantRails.set(rec.id, { rails: r, owner: rec.owner, walletPubkey: rec.custody?.walletPubkey ?? `ed25519:${rec.walletAccount}` });
      return r.custody;
    },
  });

  deps.vaultCapUsd = (id) => (tenants.ids().includes(id) ? beta.get().depositCapUsd : undefined);
  const app = createApp({ deps, tokens, mock: true, adminToken, owner: ownerAuth, allowedOrigins: o.allowedOrigins, attestor: o.attestor, seal: { keys: sealKeys, ledger: sealing }, history: new MemoryValueHistory(), onboarding, beta });
  mountMockApprovals(app, () => [{ rails, owner: MOCK_OWNER, walletPubkey: MOCK_WALLET_PUBKEY }, ...tenantRails.values()]);
  mountMockChain(app, provisioner, ownerAuth);
  return { app, deps, vaults, tokens, agentToken, adminToken, vaultId, ownerAuth, rails, sealKeys, sealing, provisioner, tenants, onboarding, beta };
}

/** The mock wallet's on-chain key, bound into vote messages the way OutLayer binds the real one. */
export const MOCK_WALLET_PUBKEY = "ed25519:MockWa11etPubkey1111111111111111111111111111";
/** The NEP-413 recipient OutLayer's approval votes use on mainnet (its policy contract), mirrored here. */
export const APPROVAL_RECIPIENT = "outlayer.near";

/**
 * Mock mode only: a stand-in for OutLayer's public approval endpoints, so the dashboard's in-app approval flow can
 * run with no funds. Same shapes and the same rule: a vote is a NEP-413 signature by the owner over
 * "approve|reject:{approval_id}:{wallet_pubkey}:{request_hash}", where request_hash = sha256(op_canonical).
 */
function mountMockApprovals(app: ReturnType<typeof createApp>, allRails: () => { rails: ReturnType<typeof createMockRails>; owner: string; walletPubkey: string }[]) {
  const find = (id: string) => {
    for (const r of allRails()) {
      const d = r.rails.approvalDetail(id);
      if (d) return { d, ...r };
    }
    return null;
  };
  const detail = (id: string) => {
    const hit = find(id);
    if (!hit) return null;
    const { d, rails, owner, walletPubkey } = hit;
    return { rails, owner, walletPubkey, id, wallet_id: "mock-wallet", request_type: d.requestType, request_data: {}, status: d.status, required_approvals: 1, request_hash: createHash("sha256").update(d.opCanonical).digest("hex"), op_canonical: d.opCanonical, op: JSON.parse(d.opCanonical), wallet_pubkey: walletPubkey, expires_at: d.expiresAt, requestId: d.requestId };
  };
  app.get("/mock-outlayer/wallet/v1/approval/:id", (c) => {
    const d = detail(c.req.param("id"));
    if (!d) return c.json({ error: "not_found" }, 404);
    const { requestId: _r, rails: _x, owner: _o, walletPubkey: _w, ...pub } = d;
    return c.json(pub);
  });
  for (const kind of ["approve", "reject"] as const) {
    app.post(`/mock-outlayer/wallet/v1/${kind}/:id`, async (c) => {
      const id = c.req.param("id");
      const d = detail(id);
      if (!d) return c.json({ error: "not_found" }, 404);
      if (d.status !== "pending") return c.json({ error: "conflict", message: "no longer pending" }, 409);
      const b = (await c.req.json().catch(() => null)) as { signature?: string; public_key?: string; account_id?: string; nonce?: string } | null;
      if (!b?.signature || !b.public_key || !b.account_id || !b.nonce) return c.json({ error: "bad_request" }, 400);
      if (b.account_id !== d.owner) return c.json({ error: "not_approver" }, 403);
      const ok = verifyNep413({ message: `${kind}:${id}:${d.wallet_pubkey}:${d.request_hash}`, nonce: Buffer.from(b.nonce, "base64"), recipient: APPROVAL_RECIPIENT }, b.public_key, b.signature);
      if (!ok) return c.json({ error: "invalid_signature" }, 401);
      if (kind === "approve") d.rails.approve(d.requestId);
      else d.rails.reject(d.requestId);
      return c.json(kind === "approve" ? { approval_id: id, status: "approved", approved: 1, required: 1, request_id: d.requestId } : { approval_id: id, status: "rejected" });
    });
  }
}

/**
 * Mock mode only: the owner's wallet sending `store_wallet_policy` to the policy contract. In live mode the dashboard asks
 * the owner's NEAR wallet to sign and send the transaction; here the signed-in owner session stands in for the wallet.
 */
function mountMockChain(app: ReturnType<typeof createApp>, provisioner: MockProvisioner, auth: OwnerAuth) {
  app.post("/mock-outlayer/chain/store_wallet_policy", async (c) => {
    const m = /^Bearer (norr_owner_.+)$/.exec(c.req.header("authorization") ?? "");
    const session = m?.[1] ? auth.session(m[1]) : null;
    if (!session) return c.json({ error: "unauthorized" }, 401);
    const b = (await c.req.json().catch(() => null)) as { args?: { wallet_pubkey: string; encrypted_data: string; wallet_signature: string } } | null;
    if (!b?.args?.wallet_pubkey || !b.args.encrypted_data || !b.args.wallet_signature) return c.json({ error: "bad_request" }, 400);
    try {
      provisioner.storeWalletPolicy(session.accountId, b.args);
      return c.json({ ok: true, signerId: session.accountId });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "rejected" }, 400);
    }
  });
}
