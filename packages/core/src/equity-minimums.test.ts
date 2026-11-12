import { describe, expect, it } from "vitest";
import { LIQUID_EQUITIES, checkBoughtPosition, checkPositionSize, dustExits, equityMinimum, minSellUsd, noLiquidityMessage, probeSizes, topUpUsd } from "./equity-minimums";

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

describe("never leave a stock position that cannot be sold", () => {
  const sell = (amountUsd: number, heldUsd: number, sellAll = false, ticker = "NVDA") => checkPositionSize({ side: "sell", ticker, symbol: `${ticker}on`, amountUsd, heldUsd, sellAll, maxTradeUsd: 50 });
  const buy = (amountUsd: number, heldUsd: number, ticker = "NVDA") => checkPositionSize({ side: "buy", ticker, symbol: `${ticker}on`, amountUsd, heldUsd, sellAll: false, maxTradeUsd: 50 });

  it("the minimum sell size is the ticker's minimum order: ~$5.10 liquid, $26 otherwise", () => {
    expect(minSellUsd("NVDA")).toBe(5.1);
    expect(minSellUsd("MSFT")).toBe(26);
  });

  it("refuses a partial sell that leaves a remainder below the minimum, offering sell all (seen live: $3.88 of NVDAon left)", () => {
    const b = sell(36, 39.88)!;
    expect(b.code).toBe("BELOW_MIN_SELL");
    expect(b.message).toContain("would leave about $3.88, below the minimum sell size of ~$5.10");
    expect(b.message).toContain("Sell all (about $39.88) instead, or sell between $5.10 and $34.78");
    expect(b.message).not.toMatch(/liquidity/i);
    expect(b.exits).toEqual([expect.objectContaining({ kind: "sell_all", usd: 39.88 })]);
  });

  it("refuses a sell smaller than the minimum, and says sell all when a partial cannot work", () => {
    const b = sell(3, 8)!;
    expect(b.message).toBe("$3.00 of NVDA is below the minimum sell size of ~$5.10: NEAR Intents solvers do not quote NVDA orders smaller than that. Sell all (about $8.00).");
  });

  it("allows a full exit, a partial that leaves enough, and a sell that leaves nothing", () => {
    expect(sell(10, 10, true)).toBeNull();
    expect(sell(20, 40)).toBeNull();
    expect(sell(40, 40)).toBeNull();
    expect(sell(39.995, 40)).toBeNull(); // the remainder is rounding
    expect(sell(10, 0)).toBeNull(); // nothing held: the funds check answers
  });

  it("existing dust (after a price drop): any sell is refused with both exits, sell all included", () => {
    for (const b of [sell(3, 3.2, true)!, sell(3, 3.2)!]) {
      expect(b.message).toContain("position is worth about $3.20, below the minimum sell size of ~$5.10");
      expect(b.message).toContain("top up and sell all (buy about $5.10, then sell everything), or the owner withdraws it to their wallet");
      expect(b.exits.map((e) => e.kind)).toEqual(["top_up_and_sell_all", "withdraw"]);
      expect(b.exits[1]).toMatchObject({ ownerOnly: true });
    }
  });

  it("refuses a buy that would leave a position below the minimum, with the size that works", () => {
    const b = buy(3, 0)!;
    expect(b.message).toContain("would leave a position of about $3.00, below the minimum sell size of ~$5.10");
    expect(b.suggestedUsd).toBe(5.26);
    expect(buy(2.2, 3.2)).toBeNull(); // tops an existing position up past the minimum
    expect(buy(40, 0)).toBeNull();
    expect(buy(20, 0, "MSFT")!.message).toContain("~$26.00");
  });

  it("after the quote: a buy whose fees leave the position just under the minimum is refused", () => {
    const b = checkBoughtPosition({ ticker: "NVDA", amountUsd: 5.1, heldUsd: 0, receivedUsd: 5.05 })!;
    expect(b.message).toContain("deliver about $5.05 after fees");
    expect(b.suggestedUsd).toBeGreaterThan(5.1);
    expect(checkBoughtPosition({ ticker: "NVDA", amountUsd: 6, heldUsd: 0, receivedUsd: 5.94 })).toBeNull();
  });

  it("the top-up is at least one minimum order and leaves the position above the minimum", () => {
    expect(topUpUsd(3.2, 5.1)).toBe(5.1);
    expect(topUpUsd(0.2, 26)).toBe(27.13); // (26 × 1.03 − 0.20) / 0.98 = 27.122…, rounded up to the cent
    for (const held of [0.01, 1, 3, 5]) expect(held + topUpUsd(held, 5.1) * 0.98).toBeGreaterThan(5.1);
  });

  it("says when the top-up is above the vault's largest trade", () => {
    expect(dustExits({ ticker: "MSFT", symbol: "MSFTon", heldUsd: 1, minUsd: 26, maxTradeUsd: 20 })[0]!.how).toContain("above this vault's largest trade ($20)");
  });
});
