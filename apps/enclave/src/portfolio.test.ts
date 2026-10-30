import { Registry } from "@norr/core";
import { describe, expect, it } from "vitest";
import { CASH_USD, valueLayers } from "./portfolio";

const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const registry = (price: number) => new Registry({ crypto: [{ assetId: USDC, symbol: "USDC", blockchain: "near", decimals: 6, price }], equities: [] });

describe("cash valuation", () => {
  it("values the cash asset at its peg, so one balance shows one value however the market price drifts", () => {
    const units = { confidential: { [USDC]: "7928124" } };
    for (const price of [0.9985, 0.9996, 1, 1.0004]) {
      const p = valueLayers(units, registry(price), [USDC]);
      expect(p.totalUsd).toBeCloseTo(7.928124 * CASH_USD, 9);
    }
  });

  it("without a peg the market price is used (other assets are never pegged)", () => {
    expect(valueLayers({ confidential: { [USDC]: "7928124" } }, registry(0.9996)).totalUsd).toBeCloseTo(7.928124 * 0.9996, 9);
  });
});
