import { describe, expect, it } from "vitest";
import { pnlReport, type TradeFill } from "./pnl-report";

const f = (asset: string, side: "buy" | "sell", qty: number, usd: number, atMs: number): TradeFill => ({ asset, side, qty, usd, atMs });

describe("pnlReport", () => {
  it("realizes on sells at average cost and values what is left at today's price", () => {
    const r = pnlReport(
      [f("SOL", "buy", 1, 100, 1), f("SOL", "buy", 1, 120, 2), f("SOL", "sell", 1, 130, 3)],
      () => 150,
    );
    const sol = r.assets[0]!;
    // Average cost 110: selling one for 130 realizes 20; one left, cost 110, worth 150: unrealized 40.
    expect(sol).toMatchObject({ asset: "SOL", trades: 3, boughtUsd: 220, soldUsd: 130, realizedUsd: 20, qtyHeld: 1, costBasisUsd: 110, avgCostUsd: 110, priceUsd: 150, marketValueUsd: 150, unrealizedUsd: 40 });
    expect(r.totals).toEqual({ boughtUsd: 220, soldUsd: 130, realizedUsd: 20, unrealizedUsd: 40, totalUsd: 60, costBasisUsd: 110 });
    expect(r.sinceMs).toBe(1);
  });

  it("orders by time, whatever order the ledger gives", () => {
    const inOrder = pnlReport([f("X", "buy", 2, 20, 1), f("X", "sell", 1, 15, 2)], () => 10);
    const shuffled = pnlReport([f("X", "sell", 1, 15, 2), f("X", "buy", 2, 20, 1)], () => 10);
    expect(shuffled).toEqual(inOrder);
    expect(inOrder.assets[0]!.realizedUsd).toBe(5);
  });

  it("a closed position has realized P&L only; selling more than Norr bought realizes only the tracked part", () => {
    const r = pnlReport([f("NVDAon", "buy", 0.2, 40, 1), f("NVDAon", "sell", 0.3, 63, 2)], () => 210);
    // Tracked 0.2 of the 0.3 sold: proceeds 42 against cost 40.
    expect(r.assets[0]).toMatchObject({ realizedUsd: 2, qtyHeld: 0, costBasisUsd: 0, avgCostUsd: null, marketValueUsd: 0, unrealizedUsd: 0 });
  });

  it("leaves out, and names, holdings with no current price", () => {
    const r = pnlReport([f("ODD", "buy", 5, 10, 1), f("SOL", "buy", 1, 100, 2)], (a) => (a === "SOL" ? 90 : null));
    expect(r.unpriced).toEqual(["ODD"]);
    expect(r.assets.find((a) => a.asset === "ODD")).toMatchObject({ priceUsd: null, marketValueUsd: null, unrealizedUsd: null });
    expect(r.totals.unrealizedUsd).toBe(-10);
  });

  it("an empty ledger reports zeros and no start", () => {
    expect(pnlReport([], () => 1)).toEqual({ sinceMs: null, assets: [], totals: { boughtUsd: 0, soldUsd: 0, realizedUsd: 0, unrealizedUsd: 0, totalUsd: 0, costBasisUsd: 0 }, unpriced: [] });
  });
});
