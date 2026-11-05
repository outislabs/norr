import { describe, expect, it } from "vitest";
import { BlockCode, Decision, Policy, TradeRequest } from "./index";

describe("shared schemas", () => {
  it("accepts a valid policy and rejects a negative trade limit", () => {
    const base = {
      vaultId: "alpha.norr.near", maxTradeUsd: 5, dailySpendCapUsd: 20, dailyLossCapUsd: 10, maxEquityPct: 50,
      allowedCrypto: "any_safe", allowedEquities: ["NVDA"], cooldownSec: 30, paused: false,
      nonUsConfirmed: true, allowMediumRisk: false,
    };
    expect(Policy.safeParse(base).success).toBe(true);
    expect(Policy.safeParse({ ...base, maxTradeUsd: -1 }).success).toBe(false);
    expect(Policy.safeParse({ ...base, dailySpendCapUsd: -1 }).success).toBe(false);
    const { dailySpendCapUsd: _omit, ...without } = base;
    expect(Policy.safeParse(without).success).toBe(false); // the cap is mandatory
    expect(Policy.parse(base).privacy).toBe("prefer"); // confidential is the default path
    expect(Policy.safeParse({ ...base, privacy: "sometimes" }).success).toBe(false);
    expect(["public", "prefer", "require"].every((p) => Policy.safeParse({ ...base, privacy: p }).success)).toBe(true);
    expect(Policy.safeParse({ ...base, dailySpendCapUsd: 0 }).success).toBe(true); // 0 means no buying
  });

  it("rejects a non-positive trade amount", () => {
    const r = { vaultId: "v", side: "buy", asset: "NVDA", amountUsd: 0, reason: "x" };
    expect(TradeRequest.safeParse(r).success).toBe(false);
  });

  it("defines all fourteen block codes (no market-closed) and validates a blocked decision", () => {
    expect(BlockCode.options).toHaveLength(17);
    expect(BlockCode.options).toContain("NO_LIQUIDITY");
    expect(BlockCode.options).toContain("DAILY_SPEND_CAP");
    expect(BlockCode.options).toContain("PRIVACY_UNAVAILABLE");
    expect(BlockCode.options).toContain("PRICING_UNAVAILABLE");
    expect(BlockCode.options).not.toContain("MARKET_CLOSED");
    const d = { status: "blocked", code: "PAUSED", message: "Vault is paused" };
    expect(Decision.safeParse(d).success).toBe(true);
    expect(Decision.safeParse({ ...d, code: "NOPE" }).success).toBe(false);
    expect(Decision.safeParse({ status: "pending_approval", requestId: "r1", message: "Waiting for the owner." }).success).toBe(true);
  });
});
