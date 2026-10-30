import { describe, expect, it } from "vitest";
import { verifyConfidentialSwap, type Holdings } from "./confidential";

const USDC = "nep141:usdc";
const SOL = "nep141:sol";
const NVDA = "nep141:nvda";
const intent = { tokenIn: USDC, tokenOut: SOL, amountIn: "1500000", minAmountOut: "15635038" };
const before: Holdings = { [USDC]: "1500000", [NVDA]: "7" };
const goodAfter: Holdings = { [SOL]: "15738716", [NVDA]: "7" }; // USDC fully spent (absent = 0)
const fields = (r: ReturnType<typeof verifyConfidentialSwap>) => (r.ok ? [] : r.mismatches.map((m) => m.field).sort());

describe("verifyConfidentialSwap", () => {
  it("passes a swap whose balances and report agree and clear the minimum", () => {
    expect(verifyConfidentialSwap(intent, before, goodAfter, { amountIn: "1500000", amountOut: "15738716" })).toEqual({ ok: true });
  });

  it("passes without a report, and with other assets growing", () => {
    expect(verifyConfidentialSwap(intent, before, { ...goodAfter, [NVDA]: "9", "nep141:new": "5" })).toEqual({ ok: true });
  });

  it("trips when too little was received", () => {
    expect(fields(verifyConfidentialSwap(intent, before, { ...goodAfter, [SOL]: "15635037" }))).toEqual(["amountOut"]);
  });

  it("trips when the wrong token arrived (nothing of the agreed token)", () => {
    expect(fields(verifyConfidentialSwap(intent, before, { [NVDA]: "7", "nep141:evil": "99999" }))).toEqual(["amountOut"]);
  });

  it("trips when more was spent than agreed, or nothing was spent", () => {
    expect(fields(verifyConfidentialSwap({ ...intent, amountIn: "1000000" }, before, goodAfter))).toEqual(["amountIn"]);
    expect(fields(verifyConfidentialSwap(intent, before, { ...before, [SOL]: "15738716" }))).toEqual(["amountIn"]);
  });

  it("trips when the provider's report disagrees with the balances", () => {
    expect(fields(verifyConfidentialSwap(intent, before, goodAfter, { amountOut: "99999999" }))).toEqual(["reportedAmount"]);
    expect(fields(verifyConfidentialSwap(intent, before, goodAfter, { amountIn: "1400000" }))).toEqual(["reportedAmount"]);
  });

  it("trips when an unrelated asset shrinks", () => {
    expect(fields(verifyConfidentialSwap(intent, before, { ...goodAfter, [NVDA]: "6" }))).toEqual(["otherAssets"]);
    expect(fields(verifyConfidentialSwap(intent, before, { [SOL]: "15738716" }))).toEqual(["otherAssets"]); // NVDA vanished
  });

  it("treats unparsable balances as a failure", () => {
    expect(verifyConfidentialSwap(intent, { ...before, [USDC]: "1.5" }, goodAfter).ok).toBe(false);
    expect(verifyConfidentialSwap({ ...intent, minAmountOut: "x" }, before, goodAfter).ok).toBe(false);
  });

  it("reports every problem at once and asks for the kill switch", () => {
    const r = verifyConfidentialSwap(intent, before, { [NVDA]: "1" }, { amountOut: "5" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.action).toBe("trip_kill_switch");
      expect(fields(r)).toEqual(["amountOut", "otherAssets", "reportedAmount"]); // the USDC was spent exactly as agreed, so no amountIn problem
    }
  });
});
