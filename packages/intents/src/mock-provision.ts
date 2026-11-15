import { createHash, createHmac, randomBytes } from "node:crypto";
import { policyStoreCall, policyStorageDeposit, STORE_WALLET_POLICY_ARGS, type CustodyProvisioner, type OnChainPolicy, type PolicyStoreCall, type RegisteredWallet } from "./outlayer-provision";

interface MockWallet extends RegisteredWallet {
  walletPubkey: string;
}

/**
 * A stand-in for OutLayer's wallet registration, its keystore (encrypt and sign a policy) and the policy contract, with
 * the contract's rules: the keystore signs a message that names the caller, the signature must verify for the account
 * that sends the call, and the first account to store a policy becomes the controller; only it can update it.
 * "Encryption" here is plain base64: mock mode holds no funds.
 */
export class MockProvisioner implements CustodyProvisioner {
  private readonly wallets = new Map<string, MockWallet>();
  private readonly chain = new Map<string, { owner: string; data: string; frozen: boolean; deposit: bigint }>();
  /** The contract's `PolicyMeta`: writes so far under each key (survives nothing else; mock only). */
  private readonly versions = new Map<string, number>();
  /** Unix seconds, for the signature's `valid_until` (tests move it). */
  nowSec = () => Math.floor(Date.now() / 1000);
  private readonly secret = randomBytes(32);
  registrations = 0;
  failRegister = false;

  async register(): Promise<RegisteredWallet> {
    if (this.failRegister) throw new Error("mock register failed");
    this.registrations++;
    const walletAccount = randomBytes(32).toString("hex");
    const w: MockWallet = { walletId: crypto.randomUUID(), apiKey: `wk_mock_${randomBytes(16).toString("hex")}`, walletAccount, walletPubkey: `ed25519:${walletAccount}` };
    this.wallets.set(w.apiKey, w);
    return { walletId: w.walletId, apiKey: w.apiKey, walletAccount };
  }

  private byKey(apiKey: string): MockWallet {
    const w = this.wallets.get(apiKey);
    if (!w) throw new Error("mock: unknown wallet key");
    return w;
  }

  /** The message the contract rebuilds (`policy_store_message`, v2): key, version, lock, deadline, data, caller. */
  private sign(walletPubkey: string, version: number, locked: boolean, validUntil: number, data: string, caller: string): string {
    const msg = `store_wallet_policy:v2:${walletPubkey}:${version}:${locked ? 1 : 0}:${validUntil}:${data.length}:${data}:${caller}`;
    return createHmac("sha512", this.secret).update(createHash("sha256").update(msg).digest()).digest("hex");
  }

  async preparePolicyStore(wallet: { walletId: string; apiKey: string }, policy: unknown, caller: string, existingDeposit = 0n): Promise<PolicyStoreCall> {
    const w = this.byKey(wallet.apiKey);
    if (w.walletId !== wallet.walletId) throw new Error("mock: wallet id does not match the key");
    const data = Buffer.from(JSON.stringify(policy)).toString("base64");
    // What the keystore's sign-policy answers (SignedPolicy): the chain's version plus one, the lock, seven days to file it.
    const version = (this.versions.get(w.walletPubkey) ?? 0) + 1;
    const locked = Boolean((policy as { approval?: { locked?: unknown } }).approval?.locked);
    const validUntil = this.nowSec() + 7 * 86_400;
    return policyStoreCall(
      { signature_hex: this.sign(w.walletPubkey, version, locked, validUntil, data, caller), public_key_hex: w.walletPubkey.slice("ed25519:".length), version, locked, valid_until: validUntil, policy_hash: createHash("sha256").update(JSON.stringify(policy)).digest("hex") },
      data,
      existingDeposit,
    );
  }

  /**
   * The contract call, as `caller` sending it from their own wallet. Throws what the contract would panic with: first the
   * JSON arguments as near-sdk reads them (a missing field is the panic seen live on 2026-11-15), then the version, the
   * deadline and the signature, in the contract's order.
   */
  storeWalletPolicy(caller: string, raw: unknown): void {
    const args = (raw ?? {}) as Record<string, unknown>;
    for (const [field, type] of STORE_WALLET_POLICY_ARGS) {
      const v = args[field];
      if (v === undefined) throw new Error(`Smart contract panicked: Failed to deserialize input from JSON. Error: missing field \`${field}\``);
      const ok = type === "string" ? typeof v === "string" : type === "bool" ? typeof v === "boolean" : typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
      if (!ok) throw new Error(`Smart contract panicked: Failed to deserialize input from JSON. Error: invalid type for \`${field}\`, expected ${type}`);
    }
    const a = args as { wallet_pubkey: string; encrypted_data: string; wallet_signature: string; version: number; locked: boolean; valid_until: number };
    const current = this.versions.get(a.wallet_pubkey) ?? 0;
    if (a.version !== current + 1) throw new Error(`Smart contract panicked: policy version is ${current}, this signature was made for ${a.version}: sign the policy again`);
    if (this.nowSec() > a.valid_until) throw new Error(`Smart contract panicked: this policy signature expired at ${a.valid_until} (unix seconds; now ${this.nowSec()}): sign the policy again`);
    if (a.wallet_signature !== this.sign(a.wallet_pubkey, a.version, a.locked, a.valid_until, a.encrypted_data, caller)) throw new Error("Smart contract panicked: Invalid Ed25519 wallet signature");
    const existing = this.chain.get(a.wallet_pubkey);
    if (existing && existing.owner !== caller) throw new Error(`Smart contract panicked: Only the original controller (${existing.owner}) can update this wallet policy`);
    this.chain.set(a.wallet_pubkey, { owner: caller, data: a.encrypted_data, frozen: existing?.frozen ?? false, deposit: policyStorageDeposit(a.wallet_pubkey, a.encrypted_data) });
    this.versions.set(a.wallet_pubkey, a.version);
  }

  freeze(walletPubkey: string): void {
    const e = this.chain.get(walletPubkey);
    if (e) e.frozen = true;
  }

  async readPolicy(apiKey: string): Promise<Record<string, unknown> | null> {
    const w = this.byKey(apiKey);
    const e = this.chain.get(w.walletPubkey);
    if (!e) return null;
    return { ...(JSON.parse(Buffer.from(e.data, "base64").toString("utf8")) as object), policy: "stored", frozen: e.frozen, wallet_id: w.walletId };
  }

  async onChainPolicy(walletPubkey: string): Promise<OnChainPolicy | null> {
    const e = this.chain.get(walletPubkey);
    return e ? { owner: e.owner, frozen: e.frozen, storageDeposit: e.deposit.toString() } : null;
  }

  async invalidateCache(): Promise<void> {}
}
