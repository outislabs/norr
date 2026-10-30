import { BlockCode } from "@norr/shared";
import { IntentsApiError, type Quoter } from "@norr/intents";
import { describe, expect, it } from "vitest";
import { NVDA_ON, NVDA_X, SOL, USDC, harness, req } from "./fixtures";
import { executeTrade, reconcile } from "./trade";

const blockedCode = (d: { status: string; code?: string }) => (d.status === "blocked" ? d.code : d.status);

describe("executeTrade: happy paths", () => {
  it("buys $40 of NVDA, sends min_amount_out from Norr's own quote, verifies, and records the trade", async () => {
    const h = harness();
    const d = await executeTrade(h.deps, req());
    expect(d.status).toBe("executed");
    if (d.status === "executed") {
      expect(d.filled.asset).toBe("NVDAon");
      expect(Number(d.filled.amount)).toBeCloseTo(0.1994, 3); // $40 less 30 bps at $200
      expect(d.filled.priceUsd).toBeCloseTo(200 / 0.997, 4); // effective price: includes the 30 bps fee
    }
    expect(h.rails.swaps).toHaveLength(1);
    expect(BigInt(h.rails.swaps[0]!.minAmountOut)).toBeGreaterThan(0n);
    expect(h.vaults.get("v1")!.state.lastTradeAtMs).toBe(h.clock.t);
    expect(h.ledger.list("v1")).toHaveLength(1);
  });

  it("sells $20 of SOL back into USDC", async () => {
    const h = harness();
    expect((await executeTrade(h.deps, req({ asset: "SOL", amountUsd: 30 }))).status).toBe("executed");
    const d = await executeTrade(h.deps, req({ side: "sell", asset: "SOL", amountUsd: 20 }));
    expect(d.status).toBe("executed");
    expect(h.rails.swaps[1]).toMatchObject({ tokenIn: SOL.assetId, tokenOut: USDC.assetId });
  });

  it("routes a ticker to the issuer with the better quote", async () => {
    const worseX: (q: Quoter) => Quoter = (q) => ({
      quote: async (p) => {
        const r = await q.quote(p);
        return r && p.tokenOut === NVDA_X.assetId ? { ...r, amountOutUsd: r.amountOutUsd * 0.98 } : r;
      },
    });
    const h = harness({ quoter: worseX });
    await executeTrade(h.deps, req());
    expect(h.rails.swaps[0]!.tokenOut).toBe(NVDA_ON.assetId);

    const worseOn: (q: Quoter) => Quoter = (q) => ({
      quote: async (p) => {
        const r = await q.quote(p);
        return r && p.tokenOut === NVDA_ON.assetId ? { ...r, amountOutUsd: r.amountOutUsd * 0.98 } : r;
      },
    });
    const h2 = harness({ quoter: worseOn });
    await executeTrade(h2.deps, req());
    expect(h2.rails.swaps[0]!.tokenOut).toBe(NVDA_X.assetId);
  });

  it("every swap sent carries a positive min_amount_out", async () => {
    const h = harness();
    await executeTrade(h.deps, req({ amountUsd: 10 }));
    await executeTrade(h.deps, req({ asset: "SOL", amountUsd: 5 }));
    await executeTrade(h.deps, req({ asset: "SOL", side: "sell", amountUsd: 4 })); // less than the 5 bought, which fees shrank
    expect(h.rails.swaps).toHaveLength(3);
    for (const s of h.rails.swaps) expect(s.minAmountOut).toMatch(/^[1-9]\d*$/);
  });
});

describe("executeTrade: blocks (no swap is ever sent)", () => {
  const cases: [string, Parameters<typeof harness>[0], Parameters<typeof req>[0]][] = [
    ["PAUSED", { policy: { paused: true } }, {}],
    ["OVER_TRADE_LIMIT", {}, { asset: "TSLA", amountUsd: 150 }],
    ["SCAM_RISK", {}, { asset: "RUGCOIN", amountUsd: 5 }],
    ["INELIGIBLE", { policy: { nonUsConfirmed: false } }, {}],
    ["UNKNOWN_ASSET", {}, { asset: "NOPE" }],
    ["SHIELD_INCIDENT", { shield: null }, {}],
    ["NO_LIQUIDITY", { mock: { liquidity: (id) => id !== NVDA_ON.assetId && id !== NVDA_X.assetId } }, {}],
    ["PRICE_SANITY", { mock: { skewBps: 500 } }, {}],
  ];
  for (const [code, opts, r] of cases) {
    it(code, async () => {
      const h = harness(opts);
      const d = await executeTrade(h.deps, req(r));
      expect(blockedCode(d)).toBe(code);
      expect(BlockCode.options).toContain(code);
      expect(h.rails.swaps).toHaveLength(0);
      expect(h.ledger.list("v1")[0]!.decision.status).toBe("blocked");
    });
  }

  it("a paused vault makes no Shield call", async () => {
    const h = harness({ policy: { paused: true } });
    await executeTrade(h.deps, req());
    expect(h.shieldCalls.n).toBe(0);
  });

  it("an unknown vault fails cleanly", async () => {
    const h = harness();
    expect((await executeTrade(h.deps, req({ vaultId: "nope" }))).status).toBe("failed");
  });
});

describe("executeTrade: post-trade verification", () => {
  it("pauses the vault when the gateway swaps into a different token", async () => {
    const h = harness({ mock: { tamper: (e) => ({ ...e, tokenOut: "nep141:evil.near" }) } });
    const d = await executeTrade(h.deps, req());
    expect(d.status).toBe("failed");
    expect(h.vaults.get("v1")!.policy.paused).toBe(true);
    expect(h.vaults.pauseReasons.get("v1")).toContain("tokenOut");
    expect(blockedCode(await executeTrade(h.deps, req()))).toBe("PAUSED");
  });

  it("pauses when the output is below Norr's quoted minimum", async () => {
    const h = harness({ mock: { tamper: (e) => ({ ...e, amountOut: "1" }) } });
    expect((await executeTrade(h.deps, req())).status).toBe("failed");
    expect(h.vaults.pauseReasons.get("v1")).toContain("amountOut");
  });

  it("pauses when more was spent than agreed, or the recipient changed", async () => {
    const a = harness({ mock: { tamper: (e) => ({ ...e, amountIn: (BigInt(e.amountIn) + 1n).toString() }) } });
    await executeTrade(a.deps, req());
    expect(a.vaults.pauseReasons.get("v1")).toContain("amountIn");
    const b = harness({ mock: { tamper: (e) => ({ ...e, recipient: "attacker" }) } });
    await executeTrade(b.deps, req());
    expect(b.vaults.pauseReasons.get("v1")).toContain("recipient");
  });

  it("fails closed when the independent status cannot be read", async () => {
    const h = harness({ mock: { unauditable: true } });
    const d = await executeTrade(h.deps, req());
    expect(d.status).toBe("failed");
    expect(h.vaults.get("v1")!.policy.paused).toBe(true);
    expect(h.vaults.get("v1")!.state.lastTradeAtMs).toBeNull();
  });
});

describe("executeTrade: custody outcomes", () => {
  it("reports pending_approval, then settles and verifies after the owner approves", async () => {
    const h = harness({ mock: { requireApproval: true } });
    const d = await executeTrade(h.deps, req());
    expect(d.status).toBe("pending_approval");
    const row = h.ledger.list("v1")[0]!;
    expect(row.pending).toBeDefined();
    expect(await reconcile(h.deps, row.id)).toMatchObject({ status: "pending_approval" });

    h.rails.approve((d as { requestId: string }).requestId);
    const settled = await reconcile(h.deps, row.id);
    expect(settled?.status).toBe("executed");
    expect(h.ledger.get(row.id)!.decision.status).toBe("executed");
    expect(h.ledger.get(row.id)!.pending).toBeUndefined();
    expect(h.vaults.get("v1")!.state.lastTradeAtMs).not.toBeNull();
  });

  it("an approved-but-tampered swap still pauses the vault on reconcile", async () => {
    const h = harness({ mock: { requireApproval: true, tamper: (e) => ({ ...e, tokenOut: "x" }) } });
    const d = await executeTrade(h.deps, req());
    h.rails.approve((d as { requestId: string }).requestId);
    expect((await reconcile(h.deps, h.ledger.list("v1")[0]!.id))?.status).toBe("failed");
    expect(h.vaults.get("v1")!.policy.paused).toBe(true);
  });

  it("a custody policy refusal (403) gives the agent a safe message and does not pause", async () => {
    const h = harness({ mock: { swapError: new IntentsApiError(403, "OutLayer swap: Address 'x' is not in whitelist") } });
    const d = await executeTrade(h.deps, req());
    expect(d).toMatchObject({ status: "failed" });
    expect((d as { message: string }).message).toContain("custody policy refused");
    expect((d as { message: string }).message).not.toContain("whitelist");
    expect(h.ledger.list("v1")[0]!.note).toContain("whitelist");
    expect(h.vaults.get("v1")!.policy.paused).toBe(false);
  });

  it("an unexpected custody error does not claim funds are safe", async () => {
    const h = harness({ mock: { swapError: new Error("socket hang up") } });
    const d = await executeTrade(h.deps, req());
    expect((d as { message: string }).message).toContain("could not be confirmed");
  });
});

describe("realized loss feeds the daily loss cap", () => {
  it("a round trip loses the fees; once past the cap, buying is blocked but selling still works", async () => {
    const h = harness({ policy: { dailyLossCapUsd: 0.2, maxTradeUsd: 100 } });
    expect((await executeTrade(h.deps, req({ asset: "SOL", amountUsd: 50 }))).status).toBe("executed");
    // Sell the whole position (about 0.4985 SOL at $100): fees of about 0.3% each way lose about $0.30.
    expect((await executeTrade(h.deps, req({ side: "sell", asset: "SOL", amountUsd: 49.85 }))).status).toBe("executed");
    const vault = h.vaults.get("v1")!;
    expect(vault.pnl.netUsd).toBeLessThan(-0.2);

    h.clock.t += 60_000;
    const again = await executeTrade(h.deps, req({ asset: "SOL", amountUsd: 5 }));
    expect(again).toMatchObject({ status: "blocked", code: "DAILY_LOSS_CAP" });
    expect(h.vaults.get("v1")!.state.realizedLossTodayUsd).toBeGreaterThan(0.2);
  });

  it("the loss resets on the next UTC day", async () => {
    const h = harness({ policy: { dailyLossCapUsd: 0.2, maxTradeUsd: 100 } });
    await executeTrade(h.deps, req({ asset: "SOL", amountUsd: 50 }));
    await executeTrade(h.deps, req({ side: "sell", asset: "SOL", amountUsd: 49.85 }));
    h.clock.t += 26 * 3_600_000;
    expect((await executeTrade(h.deps, req({ asset: "SOL", amountUsd: 5 }))).status).toBe("executed");
  });
});

describe("balances and portfolio-aware limits", () => {
  it("the equity limit uses live balances: the first NVDA buy fits 10%, a second does not", async () => {
    const h = harness({ policy: { maxEquityPct: 10, maxTradeUsd: 100 } });
    expect((await executeTrade(h.deps, req({ amountUsd: 90 }))).status).toBe("executed"); // 9% of $1000
    h.clock.t += 60_000;
    expect(await executeTrade(h.deps, req({ amountUsd: 20 }))).toMatchObject({ status: "blocked", code: "EQUITY_LIMIT" });
  });

  it("selling more than the vault holds fails at custody without pausing it", async () => {
    const h = harness();
    const d = await executeTrade(h.deps, req({ side: "sell", asset: "SOL", amountUsd: 10 }));
    expect(d.status).toBe("failed");
    expect(h.vaults.get("v1")!.policy.paused).toBe(false);
  });
});

describe("quote outages are not 'no liquidity'", () => {
  const throwing: (q: Quoter) => Quoter = () => ({ quote: async () => { throw new IntentsApiError(400, "1Click quote: Quoting for this pair is not available"); } });

  it("a failing quote service gives a retry-later failure, not NO_LIQUIDITY, and sends nothing", async () => {
    const h = harness({ quoter: throwing });
    const d = await executeTrade(h.deps, req());
    expect(d.status).toBe("failed");
    expect((d as { message: string }).message).toContain("temporarily unavailable");
    expect(h.rails.swaps).toHaveLength(0);
    expect(h.ledger.list("v1")[0]!.note).toContain("Quoting for this pair is not available");
    expect(h.vaults.get("v1")!.policy.paused).toBe(false); // an outage is not tampering
  });

  it("a null quote is still NO_LIQUIDITY", async () => {
    const h = harness({ mock: { liquidity: () => false } });
    expect(await executeTrade(h.deps, req())).toMatchObject({ status: "blocked", code: "NO_LIQUIDITY" });
  });

  it("if one issuer's quote fails but another quotes, the trade routes through the other", async () => {
    const flaky: (q: Quoter) => Quoter = (q) => ({ quote: async (p) => { if (p.tokenOut === NVDA_ON.assetId) throw new Error("boom"); return q.quote(p); } });
    const h = harness({ quoter: flaky });
    expect((await executeTrade(h.deps, req())).status).toBe("executed");
    expect(h.rails.swaps[0]!.tokenOut).toBe(NVDA_X.assetId);
  });
});

describe("daily spend cap", () => {
  const capped = { maxTradeUsd: 50, dailySpendCapUsd: 120, cooldownSec: 0 };

  it("splitting a $160 buy into $40 pieces is stopped at the daily cap, and the agent is told how much is left", async () => {
    const h = harness({ policy: capped });
    for (let i = 0; i < 3; i++) expect((await executeTrade(h.deps, req({ amountUsd: 40 }))).status).toBe("executed");
    const fourth = await executeTrade(h.deps, req({ amountUsd: 40 }));
    expect(fourth).toMatchObject({ status: "blocked", code: "DAILY_SPEND_CAP" });
    expect((fourth as { message: string }).message).toContain("whole daily spending cap");
    expect(h.rails.swaps).toHaveLength(3);
  });

  it("tells the agent the amount that would still fit", async () => {
    const h = harness({ policy: capped });
    await executeTrade(h.deps, req({ amountUsd: 50 }));
    await executeTrade(h.deps, req({ amountUsd: 50 }));
    const d = await executeTrade(h.deps, req({ amountUsd: 40 }));
    expect(d).toMatchObject({ code: "DAILY_SPEND_CAP" });
    expect((d as { message: string }).message).toContain("$20.00 left today");
    expect((await executeTrade(h.deps, req({ amountUsd: 20 }))).status).toBe("executed");
  });

  it("sells are never blocked by it", async () => {
    const h = harness({ policy: { ...capped, dailySpendCapUsd: 50 } });
    await executeTrade(h.deps, req({ asset: "SOL", amountUsd: 50 }));
    expect(await executeTrade(h.deps, req({ asset: "SOL", amountUsd: 5 }))).toMatchObject({ code: "DAILY_SPEND_CAP" });
    expect((await executeTrade(h.deps, req({ side: "sell", asset: "SOL", amountUsd: 20 }))).status).toBe("executed");
  });

  it("five parallel $50 buys cannot slip past a $120 cap together", async () => {
    const h = harness({ policy: capped });
    const results = await Promise.all(Array.from({ length: 5 }, () => executeTrade(h.deps, req({ amountUsd: 50 }))));
    expect(results.filter((d) => d.status === "executed")).toHaveLength(2);
    expect(results.filter((d) => d.status === "blocked" && d.code === "DAILY_SPEND_CAP")).toHaveLength(3);
    expect(h.rails.swaps).toHaveLength(2);
  });

  it("resets on the next UTC day", async () => {
    const h = harness({ policy: { ...capped, dailySpendCapUsd: 50 } });
    expect((await executeTrade(h.deps, req({ amountUsd: 50 }))).status).toBe("executed");
    expect(await executeTrade(h.deps, req({ amountUsd: 10 }))).toMatchObject({ code: "DAILY_SPEND_CAP" });
    h.clock.t += 24 * 3_600_000;
    expect((await executeTrade(h.deps, req({ amountUsd: 50 }))).status).toBe("executed");
  });

  it("a swap that did not run gives its spend back: custody policy refusal (403) and an immediate custody failure", async () => {
    const refused = harness({ policy: { ...capped, dailySpendCapUsd: 50 }, mock: { swapError: new IntentsApiError(403, "OutLayer swap: refused") } });
    expect((await executeTrade(refused.deps, req({ amountUsd: 50 }))).status).toBe("failed");
    expect(refused.vaults.get("v1")!.spend.usd).toBe(0);

    const broke = harness({ policy: { ...capped, dailySpendCapUsd: 50 }, mock: { seed: {} } }); // no cash: custody reports failure
    expect((await executeTrade(broke.deps, req({ asset: "SOL", amountUsd: 50 }))).status).toBe("failed");
    expect(broke.vaults.get("v1")!.spend.usd).toBe(0);
  });

  it("an ambiguous error keeps the spend counted, since the swap may have run", async () => {
    const h = harness({ policy: { ...capped, dailySpendCapUsd: 50 }, mock: { swapError: new Error("socket hang up") } });
    await executeTrade(h.deps, req({ amountUsd: 50 }));
    expect(h.vaults.get("v1")!.spend.usd).toBe(50);
  });

  it("a swap waiting for owner approval counts, so a second buy cannot be queued behind it", async () => {
    const h = harness({ policy: { ...capped, dailySpendCapUsd: 50 }, mock: { requireApproval: true } });
    expect((await executeTrade(h.deps, req({ amountUsd: 40 }))).status).toBe("pending_approval");
    expect(await executeTrade(h.deps, req({ amountUsd: 40 }))).toMatchObject({ status: "blocked", code: "DAILY_SPEND_CAP" });
    expect(h.rails.swaps).toHaveLength(1);
  });

  it("a verified-bad swap keeps its spend (the money moved) and pauses the vault", async () => {
    const h = harness({ policy: capped, mock: { tamper: (e) => ({ ...e, tokenOut: "x" }) } });
    await executeTrade(h.deps, req({ amountUsd: 40 }));
    expect(h.vaults.get("v1")!.spend.usd).toBe(40);
    expect(h.vaults.get("v1")!.policy.paused).toBe(true);
  });
});

describe("trade() gives Norr's own reason even when the agent skipped every pre-check", () => {
  it("blocks directly, with a reason that names the rule, without check_asset or get_quote having been called", async () => {
    const h = harness({ policy: { maxTradeUsd: 50, dailySpendCapUsd: 100, cooldownSec: 0 } });
    const tsla = await executeTrade(h.deps, req({ asset: "TSLA", amountUsd: 150 }));
    expect(tsla).toMatchObject({ status: "blocked", code: "OVER_TRADE_LIMIT" });
    expect((tsla as { message: string }).message).toMatch(/\$150.*\$50/);
    const rug = await executeTrade(h.deps, req({ asset: "RUGCOIN", amountUsd: 5 }));
    expect(rug).toMatchObject({ status: "blocked", code: "SCAM_RISK" });
    expect((rug as { message: string }).message).toMatch(/liquidity|market cap|new token/i);
    expect(h.rails.swaps).toHaveLength(0);
  });
});
