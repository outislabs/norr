import { createHash, createHmac, randomBytes } from "node:crypto";
import { POLICY_CONTRACT, policyStorageDeposit, type CustodyProvisioner, type OnChainPolicy, type PolicyStoreCall, type RegisteredWallet } from "./outlayer-provision";

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

  private sign(walletPubkey: string, data: string, caller: string): string {
    const msg = `store_wallet_policy:v1:${walletPubkey}:${data.length}:${data}:${caller}`;
    return createHmac("sha512", this.secret).update(createHash("sha256").update(msg).digest()).digest("hex");
  }

  async preparePolicyStore(wallet: { walletId: string; apiKey: string }, policy: unknown, caller: string, existingDeposit = 0n): Promise<PolicyStoreCall> {
    const w = this.byKey(wallet.apiKey);
    if (w.walletId !== wallet.walletId) throw new Error("mock: wallet id does not match the key");
    const data = Buffer.from(JSON.stringify(policy)).toString("base64");
    return {
      contractId: POLICY_CONTRACT,
      methodName: "store_wallet_policy",
      args: { wallet_pubkey: w.walletPubkey, encrypted_data: data, wallet_signature: this.sign(w.walletPubkey, data, caller) },
      gas: "100000000000000",
      deposit: policyStorageDeposit(w.walletPubkey, data, existingDeposit).toString(),
    };
  }

  /** The contract call, as `caller` sending it from their own wallet. Throws what the contract would panic with. */
  storeWalletPolicy(caller: string, args: { wallet_pubkey: string; encrypted_data: string; wallet_signature: string }): void {
    if (args.wallet_signature !== this.sign(args.wallet_pubkey, args.encrypted_data, caller)) throw new Error("Invalid Ed25519 wallet signature");
    const existing = this.chain.get(args.wallet_pubkey);
    if (existing && existing.owner !== caller) throw new Error(`Only the original controller (${existing.owner}) can update this wallet policy`);
    this.chain.set(args.wallet_pubkey, { owner: caller, data: args.encrypted_data, frozen: existing?.frozen ?? false, deposit: policyStorageDeposit(args.wallet_pubkey, args.encrypted_data) });
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
