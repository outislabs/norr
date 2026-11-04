import { obj, requestJson, str, type FetchLike } from "./http";

/**
 * Creating a vault's custody wallet and preparing its policy for the owner to store, on OutLayer
 * (api.outlayer.ai/openapi.json; contract outlayer.near, `contract/src/wallet.rs` in out-layer/outlayer).
 *
 * The owner's own wallet sends `store_wallet_policy`, which makes the owner the wallet's controller for good. Norr only
 * prepares the payload: the keystore encrypts the policy and signs a message that names the owner as the caller, so the
 * payload works for the owner's account and no other.
 */
export interface RegisteredWallet {
  walletId: string;
  /** The wallet's API key. Sealed in the enclave; never returned by any route. */
  apiKey: string;
  /** The wallet's implicit NEAR account (64 hex characters). */
  walletAccount: string;
}

/** The arguments of `store_wallet_policy` on the policy contract, and what to attach. */
export interface PolicyStoreCall {
  contractId: string;
  methodName: "store_wallet_policy";
  args: { wallet_pubkey: string; encrypted_data: string; wallet_signature: string };
  gas: string;
  /** The storage deposit in yoctoNEAR (exact, from the contract's own size formula, plus a small margin; any excess is refunded). */
  deposit: string;
}

/** What the chain says about a wallet's policy (`get_wallet_policy`). */
export interface OnChainPolicy {
  /** The controller: the account that stored the policy first. */
  owner: string;
  frozen: boolean;
}

export interface CustodyProvisioner {
  register(): Promise<RegisteredWallet>;
  preparePolicyStore(wallet: { walletId: string; apiKey: string }, policy: unknown, caller: string): Promise<PolicyStoreCall>;
  /** The policy as the keystore decrypts it, or null when none is stored yet. */
  readPolicy(apiKey: string): Promise<Record<string, unknown> | null>;
  onChainPolicy(walletPubkey: string): Promise<OnChainPolicy | null>;
  /** Drop OutLayer's cached "no policy" flag after the owner stored one. */
  invalidateCache(wallet: { walletId: string; apiKey: string }): Promise<void>;
}

export const POLICY_CONTRACT = "outlayer.near";
const YOCTO_PER_BYTE = 10n ** 19n; // STORAGE_PRICE_PER_BYTE in contract/src/lib.rs
const MARGIN = 10n ** 21n; // 0.001 NEAR

/** The contract's own storage formula (`calculate_wallet_policy_storage_size`, no beneficiary), in yoctoNEAR. */
export function policyStorageDeposit(walletPubkey: string, encryptedData: string): bigint {
  const bytes = 40 + (4 + walletPubkey.length) + (4 + 64 + 4 + encryptedData.length + 1 + 8 + 16);
  return BigInt(bytes) * YOCTO_PER_BYTE + MARGIN;
}

export class OutLayerProvisioner implements CustodyProvisioner {
  private readonly baseUrl: string;
  private readonly rpcUrl: string;
  private readonly f: FetchLike;

  constructor(o: { baseUrl?: string; rpcUrl?: string; fetch?: FetchLike } = {}) {
    this.baseUrl = o.baseUrl ?? "https://api.outlayer.ai";
    this.rpcUrl = o.rpcUrl ?? "https://free.rpc.fastnear.com";
    this.f = o.fetch ?? ((url, init) => fetch(url, init));
  }

  private headers(apiKey?: string): Record<string, string> {
    return { "content-type": "application/json", "user-agent": "norr/0.1", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
  }

  async register(): Promise<RegisteredWallet> {
    const r = obj(await requestJson(this.f, `${this.baseUrl}/register`, { method: "POST", headers: this.headers(), body: "{}" }, "OutLayer register"));
    const walletId = str(r.wallet_id);
    const apiKey = str(r.api_key);
    const walletAccount = str(r.near_account_id);
    if (!walletId || !apiKey || !walletAccount || !/^[0-9a-f]{64}$/.test(walletAccount)) throw new Error("OutLayer register: unexpected answer");
    return { walletId, apiKey, walletAccount };
  }

  async preparePolicyStore(wallet: { walletId: string; apiKey: string }, policy: unknown, caller: string): Promise<PolicyStoreCall> {
    const enc = obj(
      await requestJson(this.f, `${this.baseUrl}/wallet/v1/encrypt-policy`, { method: "POST", headers: this.headers(wallet.apiKey), body: JSON.stringify({ ...(policy as object), wallet_id: wallet.walletId }) }, "OutLayer encrypt policy"),
    );
    const encrypted = str(enc.encrypted_base64);
    if (!encrypted) throw new Error("OutLayer encrypt policy: no encrypted data");
    const sig = obj(
      await requestJson(this.f, `${this.baseUrl}/wallet/v1/sign-policy`, { method: "POST", headers: this.headers(wallet.apiKey), body: JSON.stringify({ encrypted_data: encrypted, caller }) }, "OutLayer sign policy"),
    );
    const signature = str(sig.signature_hex);
    const pub = str(sig.public_key_hex);
    if (!signature || !/^[0-9a-f]{128}$/.test(signature) || !pub || !/^[0-9a-f]{64}$/.test(pub)) throw new Error("OutLayer sign policy: unexpected answer");
    const walletPubkey = `ed25519:${pub}`;
    return {
      contractId: POLICY_CONTRACT,
      methodName: "store_wallet_policy",
      args: { wallet_pubkey: walletPubkey, encrypted_data: encrypted, wallet_signature: signature },
      gas: "100000000000000",
      deposit: policyStorageDeposit(walletPubkey, encrypted).toString(),
    };
  }

  async readPolicy(apiKey: string): Promise<Record<string, unknown> | null> {
    const r = obj(await requestJson(this.f, `${this.baseUrl}/wallet/v1/policy`, { headers: this.headers(apiKey) }, "OutLayer policy"));
    if (r.policy === "none") return null;
    if (r.policy !== "stored") throw new Error("OutLayer policy: the chain could not be read");
    return r;
  }

  async onChainPolicy(walletPubkey: string): Promise<OnChainPolicy | null> {
    const args = Buffer.from(JSON.stringify({ wallet_pubkey: walletPubkey })).toString("base64");
    const body = { jsonrpc: "2.0", id: "norr", method: "query", params: { request_type: "call_function", finality: "final", account_id: POLICY_CONTRACT, method_name: "get_wallet_policy", args_base64: args } };
    const r = obj(await requestJson(this.f, this.rpcUrl, { method: "POST", headers: this.headers(), body: JSON.stringify(body) }, "NEAR RPC get_wallet_policy"));
    const result = obj(r.result);
    if (!Array.isArray(result.result)) throw new Error("NEAR RPC get_wallet_policy: no result");
    const view = JSON.parse(Buffer.from(result.result as number[]).toString("utf8")) as { owner?: string; frozen?: boolean } | null;
    return view?.owner ? { owner: view.owner, frozen: Boolean(view.frozen) } : null;
  }

  async invalidateCache(wallet: { walletId: string; apiKey: string }): Promise<void> {
    await requestJson(this.f, `${this.baseUrl}/wallet/v1/invalidate-cache`, { method: "POST", headers: this.headers(wallet.apiKey), body: JSON.stringify({ wallet_id: wallet.walletId }) }, "OutLayer invalidate cache").catch(() => undefined);
  }
}
