import { describe, expect, it, vi } from "vitest";
import { canApprove, checkApproval, resolveApprovalsBase, sendVote, sha256Hex, voteMessage, type ApprovalDetail } from "./approvals";

const op = { type: "confidential_swap", token_in: "nep141:usdc", amount_in: "5500000", token_out: "nep141:nvdaon", recipient: "vault.near" };
const intended = { tokenIn: "nep141:usdc", amountIn: "5500000", tokenOut: "nep141:nvdaon", minAmountOut: "25836007497342384" };
async function detail(over: Partial<ApprovalDetail> = {}): Promise<ApprovalDetail> {
  const op_canonical = JSON.stringify(op);
  return { id: "a1", status: "pending", request_type: "confidential", op_canonical, request_hash: await sha256Hex(op_canonical), wallet_pubkey: "ed25519:W", expires_at: new Date(Date.now() + 3600_000).toISOString(), ...over };
}

describe("in-dashboard approvals", () => {
  it("builds OutLayer's vote message and resolves where votes go", () => {
    expect(voteMessage("approve", "a1", "ed25519:W", "abc")).toBe("approve:a1:ed25519:W:abc");
    expect(voteMessage("reject", "a1", "ed25519:W", "abc")).toBe("reject:a1:ed25519:W:abc");
    expect(resolveApprovalsBase("https://api.outlayer.ai/", "/api")).toBe("https://api.outlayer.ai");
    expect(resolveApprovalsBase("service:/mock-outlayer", "https://api.norr.finance")).toBe("https://api.norr.finance/mock-outlayer");
  });

  it("allows Approve only when the hash is the operation's and the operation is what Norr asked for", async () => {
    const d = await detail();
    const ok = await checkApproval(d, intended);
    expect(ok).toMatchObject({ hashMatches: true, matchesNorr: true, problems: [] });
    expect(canApprove(ok, d)).toBe(true);
  });

  it("blocks a hash that is not the operation's", async () => {
    const d = await detail({ request_hash: "0".repeat(64) });
    const c = await checkApproval(d, intended);
    expect(c.hashMatches).toBe(false);
    expect(canApprove(c, d)).toBe(false);
    expect(c.problems.join(" ")).toMatch(/not the hash of the operation/);
  });

  it("blocks an operation that differs from Norr's record, even with a correct hash", async () => {
    for (const changed of [{ amountIn: "9900000" }, { tokenOut: "nep141:other" }, { tokenIn: "nep141:wrap.near" }]) {
      const d = await detail();
      const c = await checkApproval(d, { ...intended, ...changed });
      expect(c.matchesNorr).toBe(false);
      expect(canApprove(c, d)).toBe(false);
    }
  });

  it("blocks expired, settled and keyless approvals, and ones with no canonical operation", async () => {
    for (const over of [{ expires_at: new Date(Date.now() - 1000).toISOString() }, { status: "approved" as const }, { wallet_pubkey: null }, { op_canonical: null }]) {
      const d = await detail(over);
      expect(canApprove(await checkApproval(d, intended), d)).toBe(false);
    }
  });

  it("sends the vote in OutLayer's shape, and surfaces its error", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ approval_id: "a1", status: "approved", approved: 1, required: 1 }), { status: 200 }));
    expect(await sendVote("https://api.outlayer.ai", "approve", "a1", { signature: "sig", publicKey: "ed25519:K", accountId: "owner.near" }, "bm9uY2U=", f as unknown as typeof fetch)).toMatchObject({ status: "approved" });
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe("https://api.outlayer.ai/wallet/v1/approve/a1");
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ signature: "sig", public_key: "ed25519:K", account_id: "owner.near", nonce: "bm9uY2U=" });
    const bad = vi.fn(async () => new Response(JSON.stringify({ error: "invalid_signature", message: "signature does not verify" }), { status: 401 }));
    await expect(sendVote("https://x", "approve", "a1", { signature: "s", publicKey: "k", accountId: "a" }, "n", bad as unknown as typeof fetch)).rejects.toThrow("signature does not verify");
  });
});
