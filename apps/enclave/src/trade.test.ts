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
    const d = await executeTrade(h.deps, req({ side: "sell", asset: "SOL", amountUsd: 20 }));
    expect(d.status).toBe("executed");
    expect(h.rails.swaps[0]).toMatchObject({ tokenIn: SOL.assetId, tokenOut: USDC.assetId });
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
    await executeTrade(h.deps, req({ asset: "SOL", side: "sell", amountUsd: 5 }));
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
