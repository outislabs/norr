import { describe, expect, it } from "vitest";
import { createMockEnclave } from "./mock-enclave";
import { NVDA_ON, NVDA_X, SOL, USDC, harness, req } from "./fixtures";
import { executeTrade, reconcile } from "./trade";

const cash = (usd: number) => ({ [USDC.assetId]: String(Math.round(usd * 1e6)) });
const notNvda = (id: string) => id !== NVDA_ON.assetId && id !== NVDA_X.assetId;
const confidentialFunded = { seed: cash(0), confidentialSeed: cash(1000) };

describe("venue choice", () => {
  it("prefers the confidential layer when the funds are there: public balance untouched, result labelled", async () => {
    const h = harness({ mock: { confidentialSeed: cash(500) } }); // public also holds $1,000
    const d = await executeTrade(h.deps, req());
    expect(d).toMatchObject({ status: "executed", venue: "confidential", verification: "custody-reported" });
    expect(h.rails.venues).toEqual(["confidential"]);
    expect(await h.rails.balances.holdings("x")).toEqual(cash(1000)); // the public layer did not move
    expect(BigInt((await h.rails.custody.confidentialHoldings())[USDC.assetId]!)).toBe(460_000_000n); // $40 left the confidential layer
  });

  it("falls back to the public layer when the vault holds nothing confidential, and says so", async () => {
    const h = harness();
    const d = await executeTrade(h.deps, req());
    expect(d).toMatchObject({ status: "executed", venue: "public", verification: "independent" });
    expect(h.rails.venues).toEqual(["public"]);
  });

  it("public mode never touches the confidential layer, even if it is funded", async () => {
    const h = harness({ policy: { privacy: "public" }, mock: { confidentialSeed: cash(500) } });
    expect(await executeTrade(h.deps, req())).toMatchObject({ venue: "public" });
    expect(h.rails.venues).toEqual(["public"]);
  });

  it("falls back to public when confidential has no liquidity for the asset (prefer), but not under require", async () => {
    const prefer = harness({ mock: { confidentialSeed: cash(500), confidentialLiquidity: notNvda } });
    expect(await executeTrade(prefer.deps, req())).toMatchObject({ status: "executed", venue: "public" });

    const require = harness({ policy: { privacy: "require" }, mock: { confidentialSeed: cash(500), confidentialLiquidity: notNvda } });
    const d = await executeTrade(require.deps, req());
    expect(d).toMatchObject({ status: "blocked", code: "PRIVACY_UNAVAILABLE" });
    expect(require.rails.swaps).toHaveLength(0);
  });

  it("require: no confidential funds is blocked with a funding hint and nothing is sent", async () => {
    const h = harness({ policy: { privacy: "require" } });
    const d = await executeTrade(h.deps, req());
    expect(d).toMatchObject({ status: "blocked", code: "PRIVACY_UNAVAILABLE" });
    expect((d as { message: string }).message).toMatch(/confidential balance holds 0 USDC.*fund the vault in the confidential layer/);
    expect(h.rails.swaps).toHaveLength(0);
  });

  it("require: an unreadable confidential balance is blocked, not guessed", async () => {
    const h = harness({ policy: { privacy: "require" }, mock: { confidentialSeed: cash(500), confidentialReadsBeforeFailure: 0 } });
    const d = await executeTrade(h.deps, req());
    expect(d).toMatchObject({ code: "PRIVACY_UNAVAILABLE" });
    expect((d as { message: string }).message).toContain("could not read");
  });

  it("prefer with an unreadable confidential balance trades publicly rather than guessing", async () => {
    const h = harness({ mock: { confidentialSeed: cash(500), confidentialReadsBeforeFailure: 0 } });
    expect(await executeTrade(h.deps, req())).toMatchObject({ status: "executed", venue: "public" });
  });

  it("sells run in the layer that holds the asset", async () => {
    const h = harness({ mock: confidentialFunded });
    expect((await executeTrade(h.deps, req({ asset: "SOL", amountUsd: 30 }))).status).toBe("executed");
    const sell = await executeTrade(h.deps, req({ side: "sell", asset: "SOL", amountUsd: 20 }));
    expect(sell).toMatchObject({ status: "executed", venue: "confidential" });
    expect(h.rails.venues).toEqual(["confidential", "confidential"]);
    expect(h.rails.swaps[1]).toMatchObject({ tokenIn: SOL.assetId });
  });

  it("the equity limit counts both layers", async () => {
    const h = harness({ policy: { maxEquityPct: 10, maxTradeUsd: 100 }, mock: confidentialFunded });
    expect((await executeTrade(h.deps, req({ amountUsd: 90 }))).status).toBe("executed"); // 9% of $1,000, held confidentially
    h.clock.t += 60_000;
    expect(await executeTrade(h.deps, req({ amountUsd: 20 }))).toMatchObject({ status: "blocked", code: "EQUITY_LIMIT" });
  });
});

describe("a confidential swap that does not match what was agreed pauses the vault", () => {
  const run = async (mock: Parameters<typeof harness>[0] extends infer T ? (T extends { mock?: infer M } ? M : never) : never) => {
    const h = harness({ mock: { ...confidentialFunded, ...mock } });
    const d = await executeTrade(h.deps, req());
    return { h, d };
  };

  it("a different token arrives", async () => {
    const { h, d } = await run({ tamper: (e) => ({ ...e, tokenOut: "nep141:evil.near" }) });
    expect(d.status).toBe("failed");
    expect(h.vaults.get("v1")!.policy.paused).toBe(true);
    expect(h.vaults.pauseReasons.get("v1")).toMatch(/amountOut/);
  });

  it("too little arrives", async () => {
    const { h } = await run({ tamper: (e) => ({ ...e, amountOut: "1" }) });
    expect(h.vaults.pauseReasons.get("v1")).toMatch(/amountOut/);
  });

  it("more is spent than agreed", async () => {
    const { h } = await run({ tamper: (e) => ({ ...e, amountIn: (BigInt(e.amountIn) + 1_000_000n).toString() }) });
    expect(h.vaults.get("v1")!.policy.paused).toBe(true);
  });

  it("the provider's report disagrees with its balances", async () => {
    const { h } = await run({ misreportAmountOut: "999999999999" });
    expect(h.vaults.pauseReasons.get("v1")).toMatch(/reportedAmount/);
  });

  it("the balances cannot be read afterwards (fails closed)", async () => {
    const { h, d } = await run({ confidentialReadsBeforeFailure: 1 });
    expect(d.status).toBe("failed");
    expect(h.vaults.pauseReasons.get("v1")).toContain("confidential balances unavailable");
  });
});

describe("approval and ordering", () => {
  it("a confidential swap waiting for the owner blocks another one, then settles and verifies after approval", async () => {
    const h = harness({ mock: { ...confidentialFunded, requireApproval: true } });
    const first = await executeTrade(h.deps, req());
    expect(first.status).toBe("pending_approval");

    const second = await executeTrade(h.deps, req({ asset: "SOL", amountUsd: 5 }));
    expect(second).toMatchObject({ status: "failed" });
    expect((second as { message: string }).message).toContain("still waiting for the owner");
    expect(h.rails.swaps).toHaveLength(1);

    h.rails.approve((first as { requestId: string }).requestId);
    const row = h.ledger.list("v1")[0]!;
    expect(await reconcile(h.deps, row.id)).toMatchObject({ status: "executed", venue: "confidential", verification: "custody-reported" });
  });

  it("settles a swap once: the next trade is not blocked, and reading the activity again books nothing more (seen live 2026-11-04)", async () => {
    const h = harness({ mock: { ...confidentialFunded, requireApproval: true } });
    const first = await executeTrade(h.deps, req());
    h.rails.approve((first as { requestId: string }).requestId);
    const row = h.ledger.list("v1")[0]!;
    await reconcile(h.deps, row.id);
    const book = structuredClone(h.vaults.get("v1")!.book);
    expect(h.ledger.get(row.id)!.pending).toBeUndefined();
    expect(await reconcile(h.deps, row.id)).toBeNull();
    // A row settled by an earlier version still carrying its marker: cleared, not settled or booked again.
    h.ledger.update(row.id, { pending: row.pending });
    expect(await reconcile(h.deps, row.id)).toMatchObject({ status: "executed" });
    expect(h.ledger.get(row.id)!.pending).toBeUndefined();
    expect(h.vaults.get("v1")!.book).toEqual(book);
    expect((await executeTrade(h.deps, req({ asset: "SOL", amountUsd: 5 }))).status).not.toBe("failed");
  });

  it("a public swap waiting for the owner does not block a confidential one", async () => {
    const h = harness({ policy: { privacy: "prefer" }, mock: { requireApproval: true } });
    expect((await executeTrade(h.deps, req())).status).toBe("pending_approval"); // public: no confidential funds
    expect(h.ledger.list("v1")[0]!.pending?.venue).toBe("public");
  });
});

describe("mock mode starts confidential", () => {
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

  it("the demo flow runs in the confidential layer and the portfolio labels where things are", async () => {
    const { call, clock } = boot();
    const d = await (await call("/v1/trade", { side: "buy", asset: "NVDA", amountUsd: 40 })).json();
    expect(d).toMatchObject({ status: "executed", venue: "confidential", verification: "custody-reported" });
    const pf = await (await call("/v1/portfolio")).json();
    expect(pf.holdings.length).toBeGreaterThan(0);
    expect(pf.holdings.every((h: { layer: string }) => h.layer === "confidential")).toBe(true);
    expect((await (await call("/v1/policy")).json()).privacy).toBe("prefer");
    clock.t += 11_000; // past the Balanced preset's cooldown
    expect((await (await call("/v1/quote", { side: "buy", asset: "SOL", amountUsd: 5 })).json()).venue).toBe("confidential");
  });
});
