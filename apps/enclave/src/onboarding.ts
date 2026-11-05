import { randomBytes } from "node:crypto";
import { buildCustodyPolicy, custodyPolicyProblems, describeCustodyPolicy, equityMinimum, presetPolicy, type CustodyPolicy, type PolicyAsset, type Registry, type RegistryEntry } from "@norr/core";
import type { Custody, CustodyProvisioner, PolicyStoreCall } from "@norr/intents";
import type { Policy } from "@norr/shared";
import type { BetaControl } from "./beta";
import { upstreamReason } from "./errors";
import { newVault, type Vault, type VaultStore } from "./state";
import type { TenantRecord, TenantStore } from "./tenants";

/**
 * Self-serve vaults (docs/MULTI-USER.md): create a custody wallet for a signed-in owner, prepare the safe default
 * custody policy for the owner's wallet to store on chain, and activate the vault once the chain and the custody
 * provider both show that policy with the owner as controller.
 */
export interface OnboardingDeps {
  tenants: TenantStore;
  provisioner: CustodyProvisioner;
  vaults: VaultStore;
  registry: Registry;
  /** The cash asset (USDC). */
  cash: () => RegistryEntry;
  beta: BetaControl;
  /** The custody client for a vault, from its sealed key. */
  custodyFor: (rec: TenantRecord, apiKey: string) => Custody;
  now: () => number;
}

/** What a new vault's Norr rules start as. The owner can tighten or change them in Rules. */
export const BETA_RULES = { maxTradeUsd: 10, dailySpendCapUsd: 30, dailyLossCapUsd: 10, cooldownSec: 30 } as const;
/** Crypto a new vault may hold, with the chain of the version the custody policy allows. */
const BETA_CRYPTO: Record<string, string> = { SOL: "sol", ETH: "eth", BTC: "btc" };
/** Stocks a new vault may trade: only those whose observed minimum order fits the default trade limit (SPY's $26 does not). */
const BETA_EQUITY_CANDIDATES = ["NVDA", "TSLA", "QQQ", "AAPL", "SPY"];
export const BETA_EQUITIES = BETA_EQUITY_CANDIDATES.filter((t) => equityMinimum(t).usd <= BETA_RULES.maxTradeUsd);

export function betaRules(vaultId: string, nonUsConfirmed: boolean): Policy {
  return {
    ...presetPolicy("cautious", vaultId),
    ...BETA_RULES,
    allowedCrypto: ["USDC", ...Object.keys(BETA_CRYPTO)],
    allowedEquities: [...BETA_EQUITIES],
    privacy: "require",
    nonUsConfirmed,
  };
}

/** The assets the custody policy allows: cash, the beta crypto on its home chain, and every issuer's version of the beta stocks. */
export function policyAssets(registry: Registry, cash: RegistryEntry): PolicyAsset[] {
  const out: PolicyAsset[] = [];
  const add = (e: RegistryEntry) => {
    if (e.priceUsd && e.priceUsd > 0) out.push({ id: e.id, decimals: e.decimals, priceUsd: e.priceUsd });
  };
  add({ ...cash, priceUsd: cash.priceUsd ?? 1 });
  for (const e of registry.entries("crypto")) if (BETA_CRYPTO[e.symbol] === e.chain) add(e);
  for (const e of registry.entries("equity")) if (e.ticker && BETA_EQUITIES.includes(e.ticker)) add(e);
  return out.slice(0, 16); // keeps the stored policy under the contract's 16 KB log limit
}

export class OnboardingError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 429 | 502 | 503, message: string) {
    super(message);
  }
}

/** A vault name: 1 to 40 visible characters, trimmed; no control characters. Null when it does not qualify. */
export function cleanVaultName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const n = raw.replace(/\s+/g, " ").trim();
  if (n.length < 1 || n.length > 40 || /[\u0000-\u001f\u007f<>]/.test(n)) return null;
  return n;
}

export interface CreateInput {
  name?: string;
  acceptTerms: string;
  nonUsConfirmed?: boolean;
}

export class Onboarding {
  constructor(private readonly d: OnboardingDeps) {}

  /** Every self-serve vault id (active or not), for the per-vault ledger. */
  ids(): string[] {
    return this.d.tenants.ids();
  }

  mine(owner: string): TenantRecord[] {
    return this.d.tenants.list().filter((r) => r.owner === owner);
  }

  /** A setup record the owner holds, or a 404 (no hint that it exists for someone else). */
  private owned(owner: string, id: string): TenantRecord {
    const r = this.d.tenants.get(id);
    if (!r || r.owner !== owner) throw new OnboardingError(404, "not found");
    return r;
  }

  async create(owner: string, input: CreateInput): Promise<TenantRecord> {
    const beta = this.d.beta.get();
    if (!beta.signupsOpen && !(beta.allowlist ?? []).includes(owner)) throw new OnboardingError(403, "New vaults are paused for now. Existing vaults keep working.");
    if (input.acceptTerms !== beta.termsVersion) throw new OnboardingError(400, `Read and accept the terms and risk disclosure (version ${beta.termsVersion}) first.`);
    const all = this.d.tenants.list();
    if (all.filter((r) => r.owner === owner).length >= beta.maxVaultsPerOwner) throw new OnboardingError(409, `The beta allows ${beta.maxVaultsPerOwner} vault per account.`);
    if (all.length >= beta.maxVaults) throw new OnboardingError(403, "The beta is full for now. Try again later.");
    const name = input.name === undefined ? null : cleanVaultName(input.name);
    if (input.name !== undefined && !name) throw new OnboardingError(400, "A vault name is 1 to 40 characters, without < or >.");
    let wallet;
    try {
      wallet = await this.d.provisioner.register();
    } catch (e) {
      throw new OnboardingError(502, `No vault was created: the custody provider did not register a wallet. ${upstreamReason(e, "OutLayer register")}`);
    }
    const now = new Date(this.d.now()).toISOString();
    const rec: TenantRecord = {
      id: `v_${randomBytes(10).toString("hex")}`,
      ...(name ? { name } : {}),
      owner,
      walletId: wallet.walletId,
      walletAccount: wallet.walletAccount,
      status: "setup",
      createdAt: now,
      terms: { version: beta.termsVersion, acceptedAt: now },
      nonUsConfirmed: input.nonUsConfirmed === true,
    };
    // The key first: a record never exists without its key.
    this.d.tenants.setKey(rec.id, wallet.apiKey);
    this.d.tenants.put(rec);
    return rec;
  }

  /** The default policy for this vault, in words and as JSON, and the call the owner's wallet sends to store it. */
  async prepare(owner: string, id: string, o: { autonomous: boolean }): Promise<{ policy: CustodyPolicy; summary: string[]; call: PolicyStoreCall; controller: string }> {
    const rec = this.owned(owner, id);
    if (rec.status !== "setup") throw new OnboardingError(409, "This vault is already active. Its custody policy is changed by you, as controller, at the custody provider.");
    const key = this.d.tenants.key(rec.id);
    if (!key) throw new OnboardingError(503, "This vault's custody key is missing.");
    const policy = buildCustodyPolicy({
      owner: rec.owner,
      walletAccount: rec.walletAccount,
      assets: policyAssets(this.d.registry, this.d.cash()),
      maxTradeUsd: BETA_RULES.maxTradeUsd,
      dailyCapUsd: BETA_RULES.dailySpendCapUsd,
      autonomous: o.autonomous,
    });
    let call: PolicyStoreCall;
    try {
      call = await this.d.provisioner.preparePolicyStore({ walletId: rec.walletId, apiKey: key }, policy, rec.owner);
    } catch (e) {
      throw new OnboardingError(502, `The custody provider did not prepare the policy. ${upstreamReason(e, "OutLayer")}`);
    }
    this.d.tenants.put({ ...rec, custody: { policy, walletPubkey: call.args.wallet_pubkey, autonomous: o.autonomous, maxTradeUsd: BETA_RULES.maxTradeUsd, dailyCapUsd: BETA_RULES.dailySpendCapUsd, preparedAt: new Date(this.d.now()).toISOString() } });
    return { policy, summary: describeCustodyPolicy(policy, BETA_RULES.maxTradeUsd, BETA_RULES.dailySpendCapUsd), call, controller: rec.owner };
  }

  /** Check the chain and the custody provider; activate only if both show the prepared policy with the owner in control. */
  async activate(owner: string, id: string): Promise<{ status: "active" } | { status: "setup"; problems: string[] }> {
    const rec = this.owned(owner, id);
    if (rec.status === "active") return { status: "active" };
    if (!rec.custody) return { status: "setup", problems: ["Prepare the custody policy first."] };
    const key = this.d.tenants.key(rec.id);
    if (!key) throw new OnboardingError(503, "This vault's custody key is missing.");
    let chain;
    try {
      chain = await this.d.provisioner.onChainPolicy(rec.custody.walletPubkey);
    } catch (e) {
      throw new OnboardingError(503, `Could not read the policy contract on chain. ${upstreamReason(e, "NEAR RPC")}`);
    }
    if (!chain) return { status: "setup", problems: ["The policy is not on chain yet. Sign the transaction in your wallet, then check again."] };
    if (chain.owner !== rec.owner) return { status: "setup", problems: [`The wallet's policy is controlled by ${chain.owner}, not by you. This vault cannot be used; create a new one.`] };
    await this.d.provisioner.invalidateCache({ walletId: rec.walletId, apiKey: key });
    let stored;
    try {
      stored = await this.d.provisioner.readPolicy(key);
    } catch (e) {
      throw new OnboardingError(503, `Could not read the stored policy from the custody provider. ${upstreamReason(e, "OutLayer policy")}`);
    }
    const problems = custodyPolicyProblems(rec.custody.policy, stored ? { ...stored, frozen: chain.frozen || stored.frozen } : null);
    if (problems.length > 0) return { status: "setup", problems };
    const active: TenantRecord = { ...rec, status: "active", activatedAt: new Date(this.d.now()).toISOString() };
    this.d.tenants.put(active);
    this.d.vaults.add(this.vaultOf(active, key));
    return { status: "active" };
  }

  /** Rename a vault still in setup (an active vault is renamed in the vault store). */
  renameSetup(owner: string, id: string, name: string): void {
    const rec = this.owned(owner, id);
    this.d.tenants.put({ ...rec, name });
  }

  /** At startup: put every active self-serve vault back into service (its saved state wins over the defaults). */
  restore(): number {
    let n = 0;
    for (const rec of this.d.tenants.list()) {
      if (rec.status !== "active" || this.d.vaults.get(rec.id)) continue;
      const key = this.d.tenants.key(rec.id);
      if (!key) continue;
      this.d.vaults.add(this.vaultOf(rec, key));
      n++;
    }
    return n;
  }

  private vaultOf(rec: TenantRecord, key: string): Vault {
    return newVault(
      {
        id: rec.id,
        ...(rec.name ? { name: rec.name } : {}),
        owner: rec.owner,
        policy: betaRules(rec.id, rec.nonUsConfirmed),
        state: { realizedLossTodayUsd: 0, spentTodayUsd: 0, lastTradeAtMs: null, portfolioValueUsd: 0, equityValueUsd: 0 },
        custody: this.d.custodyFor(rec, key),
        walletAccount: rec.walletAccount,
      },
      this.d.now(),
    );
  }

  /** What the dashboard shows for a vault still in setup (no key, no policy internals beyond what the owner signs). */
  view(r: TenantRecord) {
    return {
      id: r.id,
      name: r.name ?? null,
      status: r.status,
      walletAccount: r.walletAccount,
      createdAt: r.createdAt,
      terms: r.terms,
      nonUsConfirmed: r.nonUsConfirmed,
      custody: r.custody ? { prepared: true, autonomous: r.custody.autonomous, walletPubkey: r.custody.walletPubkey, preparedAt: r.custody.preparedAt } : { prepared: false },
    };
  }
}
