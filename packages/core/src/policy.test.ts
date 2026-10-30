import { describe, expect, it } from "vitest";
import { policy, request, state } from "./fixtures";
import { evaluatePolicy, type PolicyTarget } from "./policy";

const now = 1_000_000;
const nvda: PolicyTarget = { class: "equity", ticker: "NVDA", symbol: "NVDAon" };
const sol: PolicyTarget = { class: "crypto", ticker: "SOL", symbol: "SOL" };
const run = (p = policy(), r = request(), t = nvda, s = state()) => evaluatePolicy(p, r, t, s, now);

describe("policy", () => {
  it("passes a compliant trade", () => expect(run()).toBeNull());

  it("PAUSED", () => expect(run(policy({ paused: true }))).toMatchObject({ code: "PAUSED" }));

  it("OVER_TRADE_LIMIT applies to buys and sells, at the boundary", () => {
    expect(run(policy({ maxTradeUsd: 50 }), request({ amountUsd: 50 }))).toBeNull();
    expect(run(policy({ maxTradeUsd: 50 }), request({ amountUsd: 150, asset: "TSLA" }))).toMatchObject({ code: "OVER_TRADE_LIMIT" });
    expect(run(policy({ maxTradeUsd: 50 }), request({ side: "sell", amountUsd: 51 }))).toMatchObject({ code: "OVER_TRADE_LIMIT" });
  });

  it("DAILY_LOSS_CAP blocks buys but never sells", () => {
    const s = state({ realizedLossTodayUsd: 20 });
    expect(run(policy({ dailyLossCapUsd: 20 }), request(), nvda, s)).toMatchObject({ code: "DAILY_LOSS_CAP" });
    expect(run(policy({ dailyLossCapUsd: 20 }), request({ side: "sell" }), nvda, s)).toBeNull();
    expect(run(policy({ dailyLossCapUsd: 20 }), request(), nvda, state({ realizedLossTodayUsd: 19.99 }))).toBeNull();
  });

  it("COOLDOWN reports the remaining wait and clears afterwards", () => {
    const p = policy({ cooldownSec: 30 });
    const b = run(p, request(), nvda, state({ lastTradeAtMs: now - 10_000 }));
    expect(b).toMatchObject({ code: "COOLDOWN" });
    expect(b!.message).toContain("20s");
    expect(run(p, request(), nvda, state({ lastTradeAtMs: now - 30_000 }))).toBeNull();
    expect(run(p, request(), nvda, state({ lastTradeAtMs: null }))).toBeNull();
  });

  it("ASSET_NOT_ALLOWED for equities and for explicit crypto lists", () => {
    expect(run(policy({ allowedEquities: ["TSLA"] }))).toMatchObject({ code: "ASSET_NOT_ALLOWED" });
    expect(run(policy({ allowedCrypto: ["USDC"] }), request({ asset: "SOL" }), sol)).toMatchObject({ code: "ASSET_NOT_ALLOWED" });
    expect(run(policy({ allowedCrypto: ["sol"] }), request({ asset: "SOL" }), sol)).toBeNull();
    expect(run(policy({ allowedCrypto: "any_safe" }), request({ asset: "SOL" }), sol)).toBeNull();
  });

  it("EQUITY_LIMIT counts the new buy, ignores sells, and blocks on an empty vault", () => {
    const p = policy({ maxEquityPct: 10, maxTradeUsd: 500 });
    expect(run(p, request({ amountUsd: 100 }), nvda, state({ portfolioValueUsd: 1000 }))).toBeNull(); // exactly 10%
    expect(run(p, request({ amountUsd: 101 }), nvda, state({ portfolioValueUsd: 1000 }))).toMatchObject({ code: "EQUITY_LIMIT" });
    expect(run(p, request({ side: "sell", amountUsd: 400 }), nvda, state({ portfolioValueUsd: 1000, equityValueUsd: 900 }))).toBeNull();
    expect(run(p, request(), nvda, state({ portfolioValueUsd: 0 }))).toMatchObject({ code: "EQUITY_LIMIT" });
  });

  it("reports the first failing rule in the documented order", () => {
    const p = policy({ paused: true, maxTradeUsd: 1 });
    expect(run(p, request({ amountUsd: 999 }))).toMatchObject({ code: "PAUSED" });
  });
});

describe("daily spend cap", () => {
  const p = (cap: number) => policy({ dailySpendCapUsd: cap, maxTradeUsd: 100 });
  const sp = (spent: number) => state({ spentTodayUsd: spent });

  it("allows a buy that lands exactly on the cap, and blocks one cent over", () => {
    expect(run(p(150), request({ amountUsd: 50 }), nvda, sp(100))).toBeNull();
    expect(run(p(150), request({ amountUsd: 50.01 }), nvda, sp(100))).toMatchObject({ code: "DAILY_SPEND_CAP" });
  });

  it("splitting a big trade cannot get around it: each part adds to the same total", () => {
    let spent = 0;
    const codes: (string | null)[] = [];
    for (let i = 0; i < 5; i++) {
      const b = run(p(150), request({ amountUsd: 40 }), nvda, sp(spent));
      codes.push(b ? b.code : null);
      if (!b) spent += 40;
    }
    expect(codes).toEqual([null, null, null, "DAILY_SPEND_CAP", "DAILY_SPEND_CAP"]); // 40+40+40 = 120, the fourth would be 160
  });

  it("the message says how much is left, or that the cap is used up", () => {
    const left = run(p(150), request({ amountUsd: 60 }), nvda, sp(100))!;
    expect(left.message).toContain("$50.00 left today");
    expect(left.message).toContain("$160.00");
    const used = run(p(150), request({ amountUsd: 5 }), nvda, sp(150))!;
    expect(used.message).toContain("whole daily spending cap");
    expect(used.message).toContain("selling is still allowed");
  });

  it("never blocks a sell, so the agent can always reduce risk", () => {
    expect(run(p(150), request({ side: "sell", amountUsd: 90 }), nvda, sp(150))).toBeNull();
  });

  it("a cap of 0 blocks all buying but not selling", () => {
    expect(run(p(0), request({ amountUsd: 1 }), nvda, sp(0))).toMatchObject({ code: "DAILY_SPEND_CAP" });
    expect(run(p(0), request({ side: "sell", amountUsd: 1 }), nvda, sp(0))).toBeNull();
  });

  it("checks the per-trade limit first, so an oversized trade is told to shrink, not to wait", () => {
    expect(run(policy({ maxTradeUsd: 50, dailySpendCapUsd: 10 }), request({ amountUsd: 80 }), nvda, sp(0))).toMatchObject({ code: "OVER_TRADE_LIMIT" });
  });
});
