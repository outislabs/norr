import { describe, expect, it } from "vitest";
import { addRealized, applyFill, dayKey, lossToday, type Book } from "./pnl";

const buy = (qty: number, usd: number) => ({ assetId: "NVDA", side: "buy" as const, qty, usd });
const sell = (qty: number, usd: number) => ({ assetId: "NVDA", side: "sell" as const, qty, usd });

describe("average-cost P&L", () => {
  it("a buy realizes nothing and builds the position", () => {
    const r = applyFill({}, buy(0.2, 40));
    expect(r.realizedUsd).toBe(0);
    expect(r.book.NVDA).toEqual({ qty: 0.2, costUsd: 40 });
  });

  it("selling at a loss realizes the loss; at a gain, the gain", () => {
    const { book } = applyFill({}, buy(0.2, 40));
    expect(applyFill(book, sell(0.2, 38)).realizedUsd).toBeCloseTo(-2, 9);
    expect(applyFill(book, sell(0.2, 45)).realizedUsd).toBeCloseTo(5, 9);
  });

  it("a partial sell uses the average cost and leaves the rest", () => {
    let book: Book = applyFill({}, buy(0.2, 40)).book;
    book = applyFill(book, buy(0.2, 50)).book; // avg cost 225 per token
    const r = applyFill(book, sell(0.1, 20)); // cost 22.5
    expect(r.realizedUsd).toBeCloseTo(-2.5, 9);
    expect(r.book.NVDA!.qty).toBeCloseTo(0.3, 9);
    expect(r.book.NVDA!.costUsd).toBeCloseTo(67.5, 9);
  });

  it("selling more than Norr bought realizes only the tracked part", () => {
    const { book } = applyFill({}, buy(0.1, 20));
    const r = applyFill(book, sell(0.3, 54)); // 0.1 tracked of 0.3 => proceeds 18 vs cost 20
    expect(r.realizedUsd).toBeCloseTo(-2, 9);
    expect(r.book.NVDA!.qty).toBeCloseTo(0, 9);
  });

  it("selling an asset with no tracked position realizes nothing", () => {
    expect(applyFill({}, sell(1, 100)).realizedUsd).toBe(0);
  });
});

describe("daily loss", () => {
  const t0 = Date.UTC(2026, 10, 3, 12);
  it("accumulates within a UTC day, and gains offset losses", () => {
    let d = addRealized({ day: dayKey(t0), netUsd: 0 }, t0, -3);
    expect(lossToday(d, t0)).toBe(3);
    d = addRealized(d, t0 + 1000, 1);
    expect(lossToday(d, t0)).toBe(2);
    d = addRealized(d, t0 + 2000, 10);
    expect(lossToday(d, t0)).toBe(0);
  });

  it("resets on a new UTC day", () => {
    const d = addRealized({ day: dayKey(t0), netUsd: 0 }, t0, -5);
    const tomorrow = t0 + 24 * 3_600_000;
    expect(lossToday(d, tomorrow)).toBe(0);
    expect(addRealized(d, tomorrow, -1)).toEqual({ day: dayKey(tomorrow), netUsd: -1 });
  });
});
