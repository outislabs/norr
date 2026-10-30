import { describe, expect, it } from "vitest";
import { verifyExecution, type ExecutedSwap, type IntendedSwap } from "./verify";

const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const SOL = "nep141:sol.omft.near";
const intended: IntendedSwap = { tokenIn: USDC, tokenOut: SOL, amountIn: "1500000", minAmountOut: "14809988", recipient: "2005d442.near" };
const executed = (over: Partial<ExecutedSwap> = {}): ExecutedSwap => ({
  tokenIn: USDC, tokenOut: SOL, amountIn: "1500000", amountOut: "14959584", recipient: "2005d442.near", ...over,
});

describe("verifyExecution", () => {
  it("passes when the execution matches Norr's own quote", () => {
    expect(verifyExecution(intended, executed())).toEqual({ ok: true });
  });

  it("allows spending less than intended and receiving more than the minimum", () => {
    expect(verifyExecution(intended, executed({ amountIn: "1400000", amountOut: "99999999" }))).toEqual({ ok: true });
  });

  it("trips on a substituted output token or input token", () => {
    const r = verifyExecution(intended, executed({ tokenOut: "nep141:evil.near" }));
    expect(r).toMatchObject({ ok: false, action: "trip_kill_switch" });
    expect(!r.ok && r.mismatches.map((m) => m.field)).toEqual(["tokenOut"]);
    expect(verifyExecution(intended, executed({ tokenIn: SOL })).ok).toBe(false);
  });

  it("trips when more was spent than intended", () => {
    const r = verifyExecution(intended, executed({ amountIn: "1500001" }));
    expect(!r.ok && r.mismatches.map((m) => m.field)).toEqual(["amountIn"]);
  });

  it("trips when the output is below the quoted minimum", () => {
    const r = verifyExecution(intended, executed({ amountOut: "14809987" }));
    expect(!r.ok && r.mismatches.map((m) => m.field)).toEqual(["amountOut"]);
  });

  it("trips on a different recipient, matching case-insensitively otherwise", () => {
    expect(verifyExecution(intended, executed({ recipient: "attacker.near" })).ok).toBe(false);
    expect(verifyExecution(intended, executed({ recipient: "2005D442.NEAR" })).ok).toBe(true);
  });

  it("treats unparsable amounts as mismatches and reports every problem at once", () => {
    const r = verifyExecution(intended, executed({ amountIn: "1.5", amountOut: "n/a", tokenOut: "x" }));
    expect(!r.ok && r.mismatches.map((m) => m.field).sort()).toEqual(["amountIn", "amountOut", "tokenOut"]);
  });
});
