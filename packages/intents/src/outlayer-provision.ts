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
  /**
   * Exactly the contract's arguments (outlayer.near `store_wallet_policy`, contract/src/wallet.rs, checked 2026-11-15):
   * `version`, `locked` and `valid_until` are inside the keystore's signature and must be sent as it answered them.
   * `storage_refund_to` (optional) is left out: the owner gets the storage back.
   */
  args: { wallet_pubkey: string; encrypted_data: string; wallet_signature: string; version: number; locked: boolean; valid_until: number };
  gas: string;
  /** The storage deposit in yoctoNEAR (exact, from the contract's own size formula, plus a small margin; any excess is refunded). */
  deposit: string;
}

/** What the chain says about a wallet's policy (`get_wallet_policy`). */
export interface OnChainPolicy {
  /** The controller: the account that stored the policy first. */
  owner: string;
  frozen: boolean;
  /** The storage deposit already held for this policy, in yoctoNEAR. */
  storageDeposit: string;
}

export interface CustodyProvisioner {
  register(): Promise<RegisteredWallet>;
  /** `existingDeposit` (yoctoNEAR) is what an update already holds on chain: only the difference is attached. */
  preparePolicyStore(wallet: { walletId: string; apiKey: string }, policy: unknown, caller: string, existingDeposit?: bigint): Promise<PolicyStoreCall>;
  /** The policy as the keystore decrypts it, or null when none is stored yet. */
  readPolicy(apiKey: string): Promise<Record<string, unknown> | null>;
  onChainPolicy(walletPubkey: string): Promise<OnChainPolicy | null>;
  /** Drop OutLayer's cached "no policy" flag after the owner stored one. */
  invalidateCache(wallet: { walletId: string; apiKey: string }): Promise<void>;
}

export const POLICY_CONTRACT = "outlayer.near";

/**
 * The required JSON arguments of `store_wallet_policy` on outlayer.near and their types, as the contract declares them
 * (contract/src/wallet.rs, read 2026-11-15; `storage_refund_to: Option<AccountId>` is optional and omitted). A missing
 * one makes the contract panic before anything else ("Failed to deserialize input from JSON. Error: missing field").
 */
export const STORE_WALLET_POLICY_ARGS: readonly (readonly [string, "string" | "u64" | "bool"])[] = [
  ["wallet_pubkey", "string"],
  ["encrypted_data", "string"],
  ["wallet_signature", "string"],
  ["version", "u64"],
  ["locked", "bool"],
  ["valid_until", "u64"],
];
const YOCTO_PER_BYTE = 10n ** 19n; // STORAGE_PRICE_PER_BYTE in contract/src/lib.rs
const MARGIN = 10n ** 21n; // 0.001 NEAR

/**
 * The contract's own storage formula (`calculate_wallet_policy_storage_size`, no beneficiary), in yoctoNEAR, plus a small
 * margin (any excess is refunded to the caller). For an update, the deposit the policy already holds counts toward it, so
 * only the difference is attached.
 */
export function policyStorageDeposit(walletPubkey: string, encryptedData: string, existing = 0n): bigint {
  const key = 4 + walletPubkey.length;
  // The entry, plus the policy's version-and-lock record (`PolicyMeta`: its map entry, the same key, a u64 and a bool).
  const bytes = 40 + key + (4 + 64 + 4 + encryptedData.length + 1 + 8 + 16) + (40 + key + 8 + 1);
  const required = BigInt(bytes) * YOCTO_PER_BYTE;
  return (required > existing ? required - existing : 0n) + MARGIN;
}

/**
 * The contract call from the keystore's `sign-policy` answer (OpenAPI `SignedPolicy`): the signature, the wallet key, and
 * the `version`, `locked` and `valid_until` the signature covers. An answer that says the write waits for approvers (a
 * locked policy) or lacks any of these is refused here with a plain sentence, before the owner is asked to sign.
 */
export function policyStoreCall(sig: Record<string, unknown>, encrypted: string, existingDeposit = 0n): PolicyStoreCall {
  if (sig.status === "pending_approval") throw new Error("OutLayer sign policy: this wallet's policy is locked, so a change needs its approvers' votes first; Norr does not lock policies, so this vault cannot be set up here");
  const signature = str(sig.signature_hex);
  const pub = str(sig.public_key_hex);
  const version = sig.version;
  const locked = sig.locked;
  const validUntil = sig.valid_until;
  if (!signature || !/^[0-9a-f]{128}$/.test(signature) || !pub || !/^[0-9a-f]{64}$/.test(pub)) throw new Error("OutLayer sign policy: unexpected answer (no signature or key)");
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1 || typeof locked !== "boolean" || typeof validUntil !== "number" || !Number.isSafeInteger(validUntil)) {
    throw new Error("OutLayer sign policy: the answer has no version, lock or expiry, which the policy contract now requires");
  }
  const walletPubkey = `ed25519:${pub}`;
  return {
    contractId: POLICY_CONTRACT,
    methodName: "store_wallet_policy",
    args: { wallet_pubkey: walletPubkey, encrypted_data: encrypted, wallet_signature: signature, version, locked, valid_until: validUntil },
    gas: "100000000000000",
    deposit: policyStorageDeposit(walletPubkey, encrypted, existingDeposit).toString(),
  };
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

  async preparePolicyStore(wallet: { walletId: string; apiKey: string }, policy: unknown, caller: string, existingDeposit = 0n): Promise<PolicyStoreCall> {
    const enc = obj(
      await requestJson(this.f, `${this.baseUrl}/wallet/v1/encrypt-policy`, { method: "POST", headers: this.headers(wallet.apiKey), body: JSON.stringify({ ...(policy as object), wallet_id: wallet.walletId }) }, "OutLayer encrypt policy"),
    );
    const encrypted = str(enc.encrypted_base64);
    if (!encrypted) throw new Error("OutLayer encrypt policy: no encrypted data");
    const sig = obj(
      await requestJson(this.f, `${this.baseUrl}/wallet/v1/sign-policy`, { method: "POST", headers: this.headers(wallet.apiKey), body: JSON.stringify({ encrypted_data: encrypted, caller }) }, "OutLayer sign policy"),
    );
    return policyStoreCall(sig, encrypted, existingDeposit);
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
    const view = JSON.parse(Buffer.from(result.result as number[]).toString("utf8")) as { owner?: string; frozen?: boolean; storage_deposit?: string } | null;
    return view?.owner ? { owner: view.owner, frozen: Boolean(view.frozen), storageDeposit: String(view.storage_deposit ?? "0") } : null;
  }

  async invalidateCache(wallet: { walletId: string; apiKey: string }): Promise<void> {
    await requestJson(this.f, `${this.baseUrl}/wallet/v1/invalidate-cache`, { method: "POST", headers: this.headers(wallet.apiKey), body: JSON.stringify({ wallet_id: wallet.walletId }) }, "OutLayer invalidate cache").catch(() => undefined);
  }
}
