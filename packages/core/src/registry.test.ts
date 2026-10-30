import { describe, expect, it } from "vitest";
import { NVDA_ON, NVDA_X, SOL, TSLA_ON, USDC_FAKE, USDC_NEAR, registry } from "./fixtures";
import { extraTokens, selectBestQuote } from "./registry";

describe("registry", () => {
  const r = registry();

  it("maps a ticker to every issuer's version (multi-issuer)", () => {
    const res = r.resolve("NVDA")!;
    expect(res.class).toBe("equity");
    expect(res.candidates.map((c) => c.issuer).sort()).toEqual(["ondo", "xstocks"]);
    expect(res.candidates.every((c) => c.ticker === "NVDA")).toBe(true);
  });

  it("resolves an exact issuer symbol to that issuer only, case-insensitively", () => {
    expect(r.resolve("nvdaon")!.candidates.map((c) => c.id)).toEqual([NVDA_ON.assetId]);
    expect(r.resolve("NVDAx")!.candidates.map((c) => c.id)).toEqual([NVDA_X.assetId]);
  });

  it("resolves by asset id and by crypto symbol", () => {
    expect(r.resolve(TSLA_ON.assetId)!.ticker).toBe("TSLA");
    expect(r.resolve("sol")!.candidates.map((c) => c.id)).toEqual([SOL.assetId]);
  });

  it("returns every chain's version of a shared crypto symbol", () => {
    expect(r.resolve("USDC")!.candidates.map((c) => c.id).sort()).toEqual([USDC_FAKE.assetId, USDC_NEAR.assetId].sort());
  });

  it("returns null for unknown or empty queries", () => {
    expect(r.resolve("DOGEWIFHAT9")).toBeNull();
    expect(r.resolve("   ")).toBeNull();
  });

  it("filters by class and keeps prices", () => {
    expect(r.entries("equity")).toHaveLength(3);
    expect(r.byId(SOL.assetId)!.priceUsd).toBe(150);
  });

  it("extraTokens keeps only tokens missing from the plain list", () => {
    expect(extraTokens([SOL], [SOL, NVDA_ON]).map((t) => t.symbol)).toEqual(["NVDAon"]);
  });

  it("selectBestQuote picks the most USD out and ignores empty quotes", () => {
    const q = (assetId: string, out: number) => ({ assetId, issuer: null, amountInUsd: 100, amountOutUsd: out });
    expect(selectBestQuote([q("a", 98.1), q("b", 99.4), q("c", 0)])!.assetId).toBe("b");
    expect(selectBestQuote([])).toBeNull();
    expect(selectBestQuote([q("a", Number.NaN)])).toBeNull();
  });
});
