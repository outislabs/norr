import { describe, expect, it } from "vitest";
import type { Decision } from "@norr/shared";
import { exitPosition } from "./exit";
import { createMockEnclave } from "./mock-enclave";
import { MSFT_ON, NVDA_ON, NVDA_X, TSLA_ON, USDC, harness, req } from "./fixtures";
import { executeTrade, planTrade } from "./trade";

/** Simulates the observed floors: NVDA and TSLA from $5.10, MSFT from $26. */
const floors = (id: string) => (id === NVDA_ON.assetId || id === NVDA_X.assetId || id === TSLA_ON.assetId ? 5.1 : id === MSFT_ON.assetId ? 26 : 0);
/** A thinner moment (a weekend): NVDA quotes only from $8. */
const thin = (id: string) => (id === NVDA_ON.assetId || id === NVDA_X.assetId ? 8 : 0);

type Blocked = Extract<Decision, { status: "blocked" }>;
const asBlocked = (d: Decision): Blocked => {
  if (d.status !== "blocked") throw new Error(`expected blocked, got ${JSON.stringify(d)}`);
  return d;
};
/** NVDAon units for a USD value at the fixture price ($200). */
const nvda = (usd: number) => (BigInt(Math.round((usd / 200) * 1e6)) * 10n ** 12n).toString();

describe("buys never leave a stock position too small to sell", () => {
  it("a $5 NVDA buy is refused with the real reason (below the ~$5.10 minimum sell size) and the size that works; nothing is sent", async () => {
    const h = harness({ mock: { minOrderUsd: floors } });
    const d = asBlocked(await executeTrade(h.deps, req({ amountUsd: 5 })));
    expect(d).toMatchObject({ code: "BELOW_MIN_SELL", suggestedUsd: 5.26 });
    expect(d.message).toContain("below the minimum sell size of ~$5.10");
    expect(d.message).not.toMatch(/liquidity/i);
    expect(h.rails.swaps).toHaveLength(0);
    expect(h.vaults.get("v1")!.spend.usd).toBe(0);
    expect((await executeTrade(h.deps, req({ amountUsd: d.suggestedUsd! }))).status).toBe("executed");
  });

  it("a thinner ticker (MSFT) states its own minimum, ~$26", async () => {
    const h = harness({ mock: { minOrderUsd: floors } });
    const d = asBlocked(await executeTrade(h.deps, req({ asset: "MSFT", amountUsd: 10 })));
    expect(d.code).toBe("BELOW_MIN_SELL");
    expect(d.message).toContain("~$26.00");
  });

  it("a buy whose fees would leave the position just under the minimum is refused after the quote", async () => {
    const h = harness({ mock: { feeBps: 100 } }); // 1%: $5.10 in, about $5.05 out
    const d = asBlocked(await executeTrade(h.deps, req({ amountUsd: 5.1 })));
    expect(d.code).toBe("BELOW_MIN_SELL");
    expect(d.message).toContain("after fees");
    expect(h.rails.swaps).toHaveLength(0);
  });
});

describe("above the minimum, the smallest size that quotes right now (thin liquidity)", () => {
  it("a $6 NVDA buy when only $8+ quotes: NO_LIQUIDITY with the size that quotes, which then trades", async () => {
    const h = harness({ mock: { minOrderUsd: thin } });
    const d = asBlocked(await executeTrade(h.deps, req({ amountUsd: 6 })));
    expect(d).toMatchObject({ code: "NO_LIQUIDITY", suggestedUsd: 8 });
    expect(d.message).toContain("smallest size that quotes right now is about $8");
    expect((await executeTrade(h.deps, req({ amountUsd: 8 }))).status).toBe("executed");
  });

  it("says so honestly when nothing up to the vault's per-trade limit quotes", async () => {
    const h = harness({ policy: { maxTradeUsd: 20 }, mock: { minOrderUsd: (id) => (id === NVDA_ON.assetId || id === NVDA_X.assetId ? 100 : 0) } });
    const d = asBlocked(await executeTrade(h.deps, req({ amountUsd: 10 })));
    expect(d.code).toBe("NO_LIQUIDITY");
    expect(d.suggestedUsd).toBeUndefined();
    expect(d.message).toContain("No size up to $20 quotes right now");
  });

  it("confidential-only vault: a stock size question is answered with the minimum, never 'no confidential liquidity'", async () => {
    const h = harness({ policy: { privacy: "require" }, mock: { minOrderUsd: thin, confidentialSeed: { [USDC.assetId]: "100000000" } } });
    const d = asBlocked(await executeTrade(h.deps, req({ amountUsd: 6 })));
    expect(d).toMatchObject({ code: "NO_LIQUIDITY", suggestedUsd: 8 });
    expect(d.message).not.toMatch(/confidential liquidity/i);
  });

  it("crypto with no liquidity keeps the plain message and runs no probe", async () => {
    const h = harness({ mock: { liquidity: (id) => !id.includes("sol") } });
    const d = asBlocked(await executeTrade(h.deps, req({ asset: "SOL", amountUsd: 5 })));
    expect(d.code).toBe("NO_LIQUIDITY");
    expect(d.suggestedUsd).toBeUndefined();
  });

  it("a pricing outage is still a retry-later failure, not a liquidity answer, even for stocks", async () => {
    const h = harness({ quoter: () => ({ quote: async () => { throw new Error("down"); } }) });
    expect((await executeTrade(h.deps, req({ amountUsd: 40 }))).status).toBe("failed");
  });
});

describe("sells never leave a remainder too small to sell", () => {
  const holding = async () => {
    const h = harness();
    await executeTrade(h.deps, req({ amountUsd: 40 })); // about $39.88 of NVDAon after the fee
    h.clock.t += 60_000;
    return h;
  };

  it("a partial sell leaving about $3.88 is refused (seen live), offering sell all; nothing is sent", async () => {
    const h = await holding();
    const swaps = h.rails.swaps.length;
    const d = asBlocked(await executeTrade(h.deps, req({ side: "sell", amountUsd: 36 })));
    expect(d.code).toBe("BELOW_MIN_SELL");
    expect(d.message).toMatch(/would leave about \$3\.\d\d, below the minimum sell size of ~\$5\.10/);
    expect(d.message).not.toMatch(/liquidity/i);
    expect(d.exits).toEqual([expect.objectContaining({ kind: "sell_all" })]);
    expect(h.rails.swaps).toHaveLength(swaps);
    // The dry run says the same.
    expect(await planTrade(h.deps, h.vaults.get("v1")!, req({ side: "sell", amountUsd: 36 }))).toMatchObject({ decision: { code: "BELOW_MIN_SELL" } });
  });

  it("sell all (from the agent request itself) empties the position", async () => {
    const h = await holding();
    const d = await executeTrade(h.deps, req({ side: "sell", amountUsd: 41, sellAll: true }));
    expect(d.status).toBe("executed");
    expect(BigInt((await h.rails.balances.holdings(h.vaults.get("v1")!.walletAccount))[NVDA_ON.assetId] ?? "0")).toBe(0n);
  });

  it("a partial that leaves enough, and crypto, are not affected", async () => {
    const h = await holding();
    expect((await executeTrade(h.deps, req({ side: "sell", amountUsd: 20 }))).status).toBe("executed");
    await executeTrade(h.deps, req({ asset: "SOL", amountUsd: 30 }));
    h.clock.t += 60_000;
    expect((await executeTrade(h.deps, req({ side: "sell", asset: "SOL", amountUsd: 29 }))).status).toBe("executed");
  });
});

describe("a position already too small to sell (after a price drop): exits", () => {
  const dusty = (policy = {}) => harness({ policy, mock: { minOrderUsd: floors, seed: { [USDC.assetId]: "1000000000", [NVDA_ON.assetId]: nvda(3.2) } } });

  it("any sell, sell all included, is refused with the real reason and both ways out", async () => {
    const h = dusty();
    for (const r of [req({ side: "sell", amountUsd: 3 }), req({ side: "sell", amountUsd: 4, sellAll: true })]) {
      const d = asBlocked(await executeTrade(h.deps, r));
      expect(d.code).toBe("BELOW_MIN_SELL");
      expect(d.message).toContain("position is worth about $3.20, below the minimum sell size of ~$5.10");
      expect(d.message).not.toMatch(/liquidity/i);
      expect(d.exits?.map((e) => e.kind)).toEqual(["top_up_and_sell_all", "withdraw"]);
      expect(d.exits?.[1]).toMatchObject({ ownerOnly: true });
    }
    expect(h.rails.swaps).toHaveLength(0);
  });

  it("top up and sell all: buys just enough, then sells everything, and the position is gone", async () => {
    const h = dusty();
    const r = await exitPosition(h.deps, "v1", "NVDA", "clean up");
    expect(r.status).toBe("done");
    expect(r.steps.map((s) => [s.step, s.decision.status])).toEqual([["top_up", "executed"], ["sell_all", "executed"]]);
    expect(r.steps[0]!.usd).toBe(5.1);
    expect(BigInt((await h.rails.balances.holdings(h.vaults.get("v1")!.walletAccount))[NVDA_ON.assetId] ?? "0")).toBe(0n);
    expect(h.vaults.get("v1")!.spend.usd).toBeCloseTo(5.1); // the top-up counts against the daily spend cap like any buy
  });

  it("within the rules: a paused vault does nothing, and a top-up above the largest trade stops before buying", async () => {
    const paused = dusty({ paused: true });
    const p = await exitPosition(paused.deps, "v1", "NVDA", "");
    expect(p.status).toBe("stopped");
    expect(p.steps[0]?.decision).toMatchObject({ code: "PAUSED" });
    const small = dusty({ maxTradeUsd: 5 });
    const s = await exitPosition(small.deps, "v1", "NVDA", "");
    expect(s.status).toBe("stopped");
    expect(s.steps[0]?.decision).toMatchObject({ code: "OVER_TRADE_LIMIT" });
    expect(small.rails.swaps).toHaveLength(0);
  });

  it("within the approvals: the top-up waits for the owner and nothing is sold yet", async () => {
    const h = harness({ mock: { requireApproval: true, seed: { [USDC.assetId]: "1000000000", [NVDA_ON.assetId]: nvda(3.2) } } });
    const r = await exitPosition(h.deps, "v1", "NVDA", "");
    expect(r.status).toBe("waiting");
    expect(r.message).toContain("call this again");
    expect(r.steps.map((s) => s.step)).toEqual(["top_up"]);
  });

  it("nothing held: says so and trades nothing", async () => {
    const h = harness();
    expect(await exitPosition(h.deps, "v1", "NVDA", "")).toMatchObject({ status: "stopped", steps: [] });
  });
});

describe("over the agent API (mock enclave)", () => {
  function boot() {
    const clock = { t: Date.UTC(2026, 10, 3, 12) };
    const m = createMockEnclave({ now: () => clock.t });
    m.deps.sleep = async (ms) => { clock.t += ms; };
    m.deps.settle = { waitMs: 0, intervalMs: 1 };
    const call = (path: string, body?: unknown) =>
      m.app.request(path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${m.agentToken}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    /** NVDA falls by half: the reference price and the mock rails' prices are the same entry. */
    const halve = () => {
      const e = m.deps.registry.resolve("NVDA")!.candidates[0]!;
      (e as { priceUsd: number }).priceUsd = e.priceUsd! / 2;
    };
    return { m, call, clock, halve };
  }

  it("list_assets still states each ticker's minimum", async () => {
    const { call } = boot();
    const all = await (await call("/v1/assets?class=equity")).json();
    const by = Object.fromEntries(all.equities.map((e: { ticker: string; minimumUsd: number }) => [e.ticker, e.minimumUsd]));
    expect(by).toMatchObject({ NVDA: 5.1, TSLA: 5.1, SPY: 26 });
  });

  it("get_quote refuses a partial sell that would leave dust, with the reason", async () => {
    const { call, clock } = boot();
    await call("/v1/trade", { side: "buy", asset: "NVDA", amountUsd: 40 });
    clock.t += 11_000;
    const q = await (await call("/v1/quote", { side: "sell", asset: "NVDA", amountUsd: 37 })).json();
    expect(q).toMatchObject({ status: "blocked", code: "BELOW_MIN_SELL" });
    expect(q.exits[0].kind).toBe("sell_all");
  });

  it("after a price drop: get_portfolio marks the position and lists the exits; trade explains; exit_position gets out", async () => {
    const { call, clock, halve } = boot();
    expect((await (await call("/v1/trade", { side: "buy", asset: "NVDA", amountUsd: 6 })).json()).status).toBe("executed");
    clock.t += 11_000;
    halve(); // about $6 becomes about $3
    const p = await (await call("/v1/portfolio")).json();
    const pos = p.holdings.find((h: { symbol: string }) => h.symbol === "NVDAon");
    expect(pos).toMatchObject({ belowMinSell: true, minSellUsd: 5.1, ticker: "NVDA" });
    expect(pos.exits.map((e: { kind: string }) => e.kind)).toEqual(["top_up_and_sell_all", "withdraw"]);
    expect(p.holdings.find((h: { symbol: string }) => h.symbol === "USDC").belowMinSell).toBeUndefined();

    const t = await (await call("/v1/trade", { side: "sell", asset: "NVDA", amountUsd: 3, sellAll: true })).json();
    expect(t).toMatchObject({ status: "blocked", code: "BELOW_MIN_SELL" });
    expect(t.message).toContain("below the minimum sell size of ~$5.10");

    // The demo vault has a 10 s cooldown between trades: the top-up runs, the sale waits for it.
    const x = await (await call("/v1/exit", { asset: "NVDA", reason: "stuck after the drop" })).json();
    expect(x).toMatchObject({ status: "waiting", steps: [{ step: "top_up", decision: { status: "executed" } }, { step: "sell_all", decision: { code: "COOLDOWN" } }] });
    expect(x.message).toContain("Call this again");
    clock.t += 11_000;
    // Called again: the position is above the minimum now, so it goes straight to selling all of it.
    const y = await (await call("/v1/exit", { asset: "NVDA", reason: "stuck after the drop" })).json();
    expect(y).toMatchObject({ status: "done", steps: [{ step: "sell_all", decision: { status: "executed" } }] });
    const after = await (await call("/v1/portfolio")).json();
    expect(after.holdings.find((h: { symbol: string }) => h.symbol === "NVDAon")).toBeUndefined();
  });

  it("/v1/exit validates its input", async () => {
    const { call } = boot();
    expect((await call("/v1/exit", { reason: "x" })).status).toBe(400);
  });
});
