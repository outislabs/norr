import { describe, expect, it } from "vitest";
import { BlockCode, Decision, Policy, TradeRequest } from "./index";

describe("shared schemas", () => {
  it("accepts a valid policy and rejects a negative trade limit", () => {
    const base = {
      vaultId: "alpha.norr.near", maxTradeUsd: 5, dailyLossCapUsd: 10, maxEquityPct: 50,
      allowedCrypto: "any_safe", allowedEquities: ["NVDA"], cooldownSec: 30, paused: false,
      nonUsConfirmed: true, allowMediumRisk: false,
    };
    expect(Policy.safeParse(base).success).toBe(true);
    expect(Policy.safeParse({ ...base, maxTradeUsd: -1 }).success).toBe(false);
  });

  it("rejects a non-positive trade amount", () => {
    const r = { vaultId: "v", side: "buy", asset: "NVDA", amountUsd: 0, reason: "x" };
    expect(TradeRequest.safeParse(r).success).toBe(false);
  });

  it("defines all twelve block codes (no market-closed) and validates a blocked decision", () => {
    expect(BlockCode.options).toHaveLength(12);
    expect(BlockCode.options).toContain("NO_LIQUIDITY");
    expect(BlockCode.options).not.toContain("MARKET_CLOSED");
    const d = { status: "blocked", code: "PAUSED", message: "Vault is paused" };
    expect(Decision.safeParse(d).success).toBe(true);
    expect(Decision.safeParse({ ...d, code: "NOPE" }).success).toBe(false);
    expect(Decision.safeParse({ status: "pending_approval", requestId: "r1", message: "Waiting for the owner." }).success).toBe(true);
  });
});
