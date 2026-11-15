import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MockProvisioner } from "./mock-provision";
import { OutLayerProvisioner, policyStorageDeposit, policyStoreCall, STORE_WALLET_POLICY_ARGS } from "./outlayer-provision";

const here = dirname(fileURLToPath(import.meta.url));
/** The contract's own signature and the keystore's answer schema, copied from OutLayer's sources on 2026-11-15. */
const contract = readFileSync(join(here, "fixtures/store_wallet_policy.contract.txt"), "utf8");
const signedPolicy = JSON.parse(readFileSync(join(here, "fixtures/signed-policy.schema.json"), "utf8")) as { required: string[]; properties: Record<string, { type: string }> };

const answer = { signature_hex: "ab".repeat(64), public_key_hex: "cd".repeat(32), version: 1, locked: false, valid_until: 1_795_000_000, policy_hash: "ef".repeat(32) };

describe("store_wallet_policy matches OutLayer's current contract (the 2026-11-15 'missing field `version`' failure)", () => {
  it("Norr's list of required arguments is exactly the contract's non-optional parameters, with the same types", () => {
    const params = [...contract.matchAll(/^\s+(\w+): ([\w<>]+),$/gm)].map((m) => [m[1]!, m[2]!] as const);
    const required = params.filter(([, t]) => !t.startsWith("Option<"));
    const asJson = (t: string) => (t === "String" ? "string" : t === "bool" ? "bool" : t === "u64" ? "u64" : `unknown ${t}`);
    expect(STORE_WALLET_POLICY_ARGS.map(([n, t]) => [n, t])).toEqual(required.map(([n, t]) => [n, asJson(t)]));
    expect(params.find(([n]) => n === "storage_refund_to")?.[1]).toBe("Option<AccountId>"); // the one optional argument, left out
  });

  it("the call built from a keystore answer of the documented shape carries every required argument, with JSON types the contract reads", () => {
    for (const f of signedPolicy.required) expect(answer, f).toHaveProperty(f);
    const call = policyStoreCall(answer, "ENC");
    for (const [field, type] of STORE_WALLET_POLICY_ARGS) {
      const v = (call.args as Record<string, unknown>)[field];
      expect(v, field).toBeDefined();
      expect(typeof v, field).toBe(type === "string" ? "string" : type === "bool" ? "boolean" : "number");
    }
    expect(call.args).toEqual({ wallet_pubkey: `ed25519:${answer.public_key_hex}`, encrypted_data: "ENC", wallet_signature: answer.signature_hex, version: 1, locked: false, valid_until: 1_795_000_000 });
    expect(Object.keys(call.args)).not.toContain("storage_refund_to");
  });

  it("refuses, in plain words, an answer without version, lock or expiry, and a locked policy waiting for approvers", () => {
    const { version: _v, ...old } = answer;
    expect(() => policyStoreCall(old, "ENC")).toThrow(/no version, lock or expiry, which the policy contract now requires/);
    expect(() => policyStoreCall({ ...answer, valid_until: "soon" }, "ENC")).toThrow(/no version, lock or expiry/);
    expect(() => policyStoreCall({ status: "pending_approval", approval_id: "a", request_id: "r" }, "ENC")).toThrow(/locked, so a change needs its approvers' votes/);
  });

  it("the storage deposit includes the contract's new version-and-lock record", () => {
    const key = "ed25519:" + "cd".repeat(32);
    const entry = 40 + (4 + key.length) + (4 + 64 + 4 + 3 + 1 + 8 + 16);
    const meta = 40 + (4 + key.length) + 8 + 1;
    expect(policyStorageDeposit(key, "ENC")).toBe(BigInt(entry + meta) * 10n ** 19n + 10n ** 21n);
  });

  it("OutLayerProvisioner passes the keystore's version, lock and deadline through to the call", async () => {
    const f = async (url: string) => new Response(JSON.stringify(url.endsWith("/encrypt-policy") ? { encrypted_base64: "ENC", wallet_pubkey: "x", policy_hash: "h" } : answer));
    const call = await new OutLayerProvisioner({ fetch: f }).preparePolicyStore({ walletId: "w", apiKey: "k" }, { rules: {} }, "alice.near");
    expect(call.args).toMatchObject({ version: 1, locked: false, valid_until: 1_795_000_000 });
  });
});

describe("the mock contract is as strict as the real one", () => {
  const setup = async () => {
    const p = new MockProvisioner();
    const w = await p.register();
    const call = await p.preparePolicyStore(w, { rules: {} }, "alice.near");
    return { p, w, call };
  };

  it("rejects the old three-argument call with the panic seen live", async () => {
    const { p, call } = await setup();
    const { version: _v, locked: _l, valid_until: _u, ...old } = call.args;
    expect(() => p.storeWalletPolicy("alice.near", old)).toThrow("Failed to deserialize input from JSON. Error: missing field `version`");
  });

  it("stores the v2 call once; the same signature cannot be filed twice, an expired one is refused, and a re-prepared one works", async () => {
    const { p, w, call } = await setup();
    p.storeWalletPolicy("alice.near", call.args);
    expect(() => p.storeWalletPolicy("alice.near", call.args)).toThrow(/policy version is 1, this signature was made for 1: sign the policy again/);
    const next = await p.preparePolicyStore(w, { rules: { x: 1 } }, "alice.near");
    expect(next.args.version).toBe(2);
    p.nowSec = () => next.args.valid_until + 1;
    expect(() => p.storeWalletPolicy("alice.near", next.args)).toThrow(/signature expired/);
    p.nowSec = () => next.args.valid_until;
    p.storeWalletPolicy("alice.near", next.args);
    expect((await p.onChainPolicy(call.args.wallet_pubkey))?.owner).toBe("alice.near");
  });

  it("a signature for one account does not work for another", async () => {
    const { p, call } = await setup();
    expect(() => p.storeWalletPolicy("mallory.near", call.args)).toThrow(/Invalid Ed25519 wallet signature/);
  });
});
