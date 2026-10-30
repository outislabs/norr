import { describe, expect, it } from "vitest";
import { createMockEnclave } from "./mock-enclave";
import { MSFT_ON, NVDA_ON, NVDA_X, TSLA_ON, harness, req } from "./fixtures";
import { executeTrade, planTrade } from "./trade";

/** Simulates the observed floors: NVDA and TSLA from $5.10, MSFT from $26. */
const floors = (id: string) => (id === NVDA_ON.assetId || id === NVDA_X.assetId || id === TSLA_ON.assetId ? 5.1 : id === MSFT_ON.assetId ? 26 : 0);

describe("the smallest size that quotes right now", () => {
  it("a $5 NVDA buy under the $5.10 floor is blocked with the smallest size that quotes, and nothing is sent", async () => {
    const h = harness({ mock: { minOrderUsd: floors } });
    const d = await executeTrade(h.deps, req({ amountUsd: 5 }));
    expect(d).toMatchObject({ status: "blocked", code: "NO_LIQUIDITY", suggestedUsd: 5.1 });
    expect((d as { message: string }).message).toContain("$5 of NVDA");
    expect((d as { message: string }).message).toContain("smallest size that quotes right now is about $5.1");
    expect(h.rails.swaps).toHaveLength(0);
    expect(h.vaults.get("v1")!.spend.usd).toBe(0); // probes are dry quotes: nothing is reserved or spent
  });

  it("the suggested size actually trades", async () => {
    const h = harness({ mock: { minOrderUsd: floors } });
    const blocked = await executeTrade(h.deps, req({ amountUsd: 5 }));
    const retry = await executeTrade(h.deps, req({ amountUsd: (blocked as { suggestedUsd: number }).suggestedUsd }));
    expect(retry.status).toBe("executed");
  });

  it("a thinner ticker (MSFT, $26 floor) suggests $26 and states that minimum", async () => {
    const h = harness({ mock: { minOrderUsd: floors } });
    const d = await executeTrade(h.deps, req({ asset: "MSFT", amountUsd: 10 }));
    expect(d).toMatchObject({ code: "NO_LIQUIDITY", suggestedUsd: 26 });
    expect((d as { message: string }).message).toContain("Observed minimum for this ticker: about $26");
  });

  it("says so honestly when nothing up to the vault's per-trade limit quotes", async () => {
    const h = harness({ policy: { maxTradeUsd: 20 }, mock: { minOrderUsd: floors } });
    const d = await executeTrade(h.deps, req({ asset: "MSFT", amountUsd: 10 }));
    expect(d).toMatchObject({ status: "blocked", code: "NO_LIQUIDITY" });
    expect((d as { suggestedUsd?: number }).suggestedUsd).toBeUndefined();
    expect((d as { message: string }).message).toContain("No size up to $20 quotes right now");
  });

  it("crypto with no liquidity keeps the plain message and runs no probe", async () => {
    const h = harness({ mock: { liquidity: (id) => !id.includes("sol") } });
    const d = await executeTrade(h.deps, req({ asset: "SOL", amountUsd: 5 }));
    expect(d).toMatchObject({ status: "blocked", code: "NO_LIQUIDITY" });
    expect((d as { suggestedUsd?: number }).suggestedUsd).toBeUndefined();
  });

  it("a pricing outage is still a retry-later failure, not a liquidity answer, even for stocks", async () => {
    const h = harness({ quoter: () => ({ quote: async () => { throw new Error("down"); } }) });
    expect((await executeTrade(h.deps, req({ amountUsd: 5 }))).status).toBe("failed");
  });
});

describe("dust warning before sells", () => {
  const holdThenSell = async (sellUsd: number) => {
    const h = harness();
    await executeTrade(h.deps, req({ amountUsd: 40 })); // about $39.88 of NVDAon after the fee
    h.clock.t += 60_000;
    const vault = h.vaults.get("v1")!;
    const planned = await planTrade(h.deps, vault, req({ side: "sell", amountUsd: sellUsd }));
    const d = await executeTrade(h.deps, req({ side: "sell", amountUsd: sellUsd }));
    return { planned, d };
  };

  it("warns, in the dry run and in the result, when a sell would leave under $5.10", async () => {
    const { planned, d } = await holdThenSell(36);
    expect("plan" in planned && planned.plan.warnings[0]).toContain("would leave about $3.88");
    expect(d.status).toBe("executed"); // a warning, not a block
    expect((d as { warnings?: string[] }).warnings?.[0]).toContain("Sell the whole position");
  });

  it("is silent for a sell that leaves enough, and for a full exit", async () => {
    const keeps = await holdThenSell(20);
    expect("plan" in keeps.planned && keeps.planned.plan.warnings).toEqual([]);
    expect((keeps.d as { warnings?: string[] }).warnings).toBeUndefined();

    const exit = await holdThenSell(39.88);
    expect("plan" in exit.planned && exit.planned.plan.warnings).toEqual([]);
    expect(exit.d.status).toBe("executed");
  });

  it("does not warn about crypto", async () => {
    const h = harness();
    await executeTrade(h.deps, req({ asset: "SOL", amountUsd: 30 }));
    h.clock.t += 60_000;
    const planned = await planTrade(h.deps, h.vaults.get("v1")!, req({ side: "sell", asset: "SOL", amountUsd: 29 }));
    expect("plan" in planned && planned.plan.warnings).toEqual([]);
  });
});

describe("minimums stated up front over the API", () => {
  const T0 = Date.UTC(2026, 10, 3, 12);
  function boot() {
    const clock = { t: T0 };
    const m = createMockEnclave({ now: () => clock.t });
    m.deps.sleep = async (ms) => { clock.t += ms; };
    m.deps.settle = { waitMs: 0, intervalMs: 1 };
    const call = (path: string, body?: unknown) =>
      m.app.request(path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${m.agentToken}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { m, call, clock };
  }

  it("list_assets shows each ticker's minimum and a note that it varies", async () => {
    const { call } = boot();
    const all = await (await call("/v1/assets?class=equity")).json();
    const by = Object.fromEntries(all.equities.map((e: { ticker: string; minimumUsd: number }) => [e.ticker, e.minimumUsd]));
    expect(by).toMatchObject({ NVDA: 5.1, TSLA: 5.1 }); // SPY is in the demo catalog and is a "standard" ticker:
    expect(by.SPY).toBe(26);
    expect(all.equityMinimumNote).toContain("outside US market hours");
  });

  it("get_quote shows the stated minimum and carries the dust warning", async () => {
    const { call, clock } = boot();
    const q = await (await call("/v1/quote", { side: "buy", asset: "NVDA", amountUsd: 40 })).json();
    expect(q).toMatchObject({ status: "quote", statedMinimumUsd: 5.1 });
    expect(q.warnings).toBeUndefined();
    await call("/v1/trade", { side: "buy", asset: "NVDA", amountUsd: 40 });
    clock.t += 11_000;
    const sell = await (await call("/v1/quote", { side: "sell", asset: "NVDA", amountUsd: 37 })).json();
    expect(sell.warnings[0]).toContain("would leave about");
  });

  it("crypto quotes carry no stated minimum", async () => {
    const { call } = boot();
    const q = await (await call("/v1/quote", { side: "buy", asset: "SOL", amountUsd: 5 })).json();
    expect(q.statedMinimumUsd).toBeUndefined();
  });
});
