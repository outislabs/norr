import { describe, expect, it } from "vitest";
import { DUST_FLOOR_USD, LIQUID_EQUITIES, dustWarning, equityMinimum, noLiquidityMessage, probeSizes } from "./equity-minimums";

describe("stated minimums", () => {
  it("liquid tickers are $5.10, everything else $26, case-insensitively", () => {
    for (const t of LIQUID_EQUITIES) expect(equityMinimum(t)).toEqual({ usd: 5.1, group: "liquid" });
    expect(equityMinimum("nvda")).toEqual({ usd: 5.1, group: "liquid" });
    for (const t of ["MSFT", "INTC", "HOOD", "SPY", "WHATEVER"]) expect(equityMinimum(t)).toEqual({ usd: 26, group: "standard" });
  });
});

describe("probeSizes", () => {
  it("returns larger ladder sizes in order, capped by the vault limit and by a count", () => {
    expect(probeSizes(5, 50)).toEqual([5.1, 5.25, 6, 8, 10, 15]);
    expect(probeSizes(5, 8)).toEqual([5.1, 5.25, 6, 8]);
    expect(probeSizes(10, 50, 3)).toEqual([15, 20, 26]);
  });
  it("is empty when nothing larger fits under the limit", () => {
    expect(probeSizes(50, 50)).toEqual([]);
    expect(probeSizes(5, 5)).toEqual([]);
  });
  it("never suggests the size that was already tried", () => {
    expect(probeSizes(5.25, 50)[0]).toBe(6);
  });
});

describe("noLiquidityMessage", () => {
  it("names the observed minimum and the smallest size that quotes", () => {
    const m = noLiquidityMessage("NVDA", 5, 5.1, 50);
    expect(m).toContain("$5 of NVDA");
    expect(m).toContain("about $5.1.");
    expect(m).toContain("smallest size that quotes right now is about $5.1;");
  });
  it("says so honestly when nothing quotes", () => {
    const m = noLiquidityMessage("MSFT", 10, undefined, 50);
    expect(m).toContain("about $26");
    expect(m).toContain("No size up to $50 quotes right now");
  });
});

describe("dustWarning", () => {
  it("warns when a small non-zero remainder would be stranded", () => {
    const w = dustWarning(3.88, 39.88, "NVDAon")!;
    expect(w).toContain("$3.88");
    expect(w).toContain("$5.1 minimum");
    expect(w).toContain("$39.88");
  });
  it("is silent for a full exit, a large enough remainder, or the exact floor", () => {
    expect(dustWarning(0, 40, "X")).toBeNull();
    expect(dustWarning(0.001, 40, "X")).toBeNull();
    expect(dustWarning(DUST_FLOOR_USD, 40, "X")).toBeNull();
    expect(dustWarning(19.9, 40, "X")).toBeNull();
  });
});
