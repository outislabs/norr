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
