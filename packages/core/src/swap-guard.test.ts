import { describe, expect, it } from "vitest";
import { requireSwapBounds } from "./swap-guard";

const ok = { tokenIn: "nep141:usdc", tokenOut: "nep141:sol.omft.near", amountIn: "1500000", minAmountOut: "15275062" };

describe("requireSwapBounds", () => {
  it("passes a fully bounded swap through unchanged", () => {
    expect(requireSwapBounds(ok)).toEqual(ok);
  });

  it("refuses a swap with no minAmountOut", () => {
    const { minAmountOut: _omit, ...rest } = ok;
    expect(() => requireSwapBounds(rest)).toThrow(/minAmountOut is required/);
  });

  it.each(["", "0", "-5", "1.5", "abc", "0015"])("refuses minAmountOut %j", (v) => {
    expect(() => requireSwapBounds({ ...ok, minAmountOut: v })).toThrow(/minAmountOut/);
  });

  it("refuses bad amountIn and bad token pairs", () => {
    expect(() => requireSwapBounds({ ...ok, amountIn: "0" })).toThrow(/amountIn/);
    expect(() => requireSwapBounds({ ...ok, tokenOut: ok.tokenIn })).toThrow(/same/);
    expect(() => requireSwapBounds({ ...ok, tokenIn: "" })).toThrow(/required/);
  });
});
