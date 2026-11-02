import type { OneClickToken } from "@norr/core";
import { describe, expect, it } from "vitest";
import { harness, req } from "./fixtures";
import { createMockEnclave } from "./mock-enclave";
import { PricingFeed } from "./pricing";
import { executeTrade, planTrade } from "./trade";

const USDC_ID = "nep141:usdc.test";
const tok = (assetId: string, symbol: string): OneClickToken => ({ assetId, symbol, decimals: 6, blockchain: "near", price: 1 });
const lists = { plain: [tok(USDC_ID, "USDC"), tok("nep141:sol.test", "SOL")], withOndo: [tok(USDC_ID, "USDC"), tok("nep141:sol.test", "SOL"), tok("nep141:nvdaon.test", "NVDAon")] };

/** A token source that fails `failures` times, then works. */
function flaky(failures: number) {
  const calls = { n: 0 };
  return { calls, source: async () => { if (calls.n++ < failures) throw new Error("1Click tokens: <!DOCTYPE html> 521"); return lists; } };
}

describe("PricingFeed: 1Click down at boot, back later", () => {
  it("starts empty and not ready, retries with growing delays, and loads once 1Click answers", async () => {
    const f = flaky(3);
    const delays: number[] = [];
    const failures: string[] = [];
    const feed = new PricingFeed(f.source, { cashAssetId: USDC_ID, sleep: async (ms) => { delays.push(ms); }, baseDelayMs: 1000, maxDelayMs: 3000, onFailure: (_n, m) => failures.push(m) });
    expect(feed.ready()).toBe(false);
    expect(feed.registry.entries()).toHaveLength(0);
    await feed.start();
    expect(feed.ready()).toBe(true);
    expect(f.calls.n).toBe(4);
    expect(delays).toEqual([1000, 2000, 3000]); // doubles, capped
    expect(failures).toHaveLength(3);
    expect(feed.registry.byId(USDC_ID)).toBeDefined();
    expect(feed.registry.resolve("NVDA")?.class).toBe("equity");
  });

  it("does not retry after it has loaded, and start() is idempotent", async () => {
    const f = flaky(0);
    const feed = new PricingFeed(f.source, { cashAssetId: USDC_ID, sleep: async () => {} });
    await Promise.all([feed.start(), feed.start()]);
    await feed.start();
    expect(f.calls.n).toBe(1);
  });

  it("treats a list without USDC as a failure and keeps retrying", async () => {
    let n = 0;
    const feed = new PricingFeed(async () => (n++ < 1 ? { plain: [tok("nep141:sol.test", "SOL")], withOndo: [] } : lists), { cashAssetId: USDC_ID, sleep: async () => {} });
    await feed.start();
    expect(n).toBe(2);
    expect(feed.ready()).toBe(true);
  });

  it("a failure message is trimmed and single-line, so it is safe to log", async () => {
    const msgs: string[] = [];
    let n = 0;
    const feed = new PricingFeed(async () => { if (n++ === 0) throw new Error(`boom\n${"x".repeat(500)}`); return lists; }, { cashAssetId: USDC_ID, sleep: async () => {}, onFailure: (_n, m) => msgs.push(m) });
    await feed.start();
    expect(msgs[0]).not.toContain("\n");
    expect(msgs[0]!.length).toBeLessThanOrEqual(160);
  });

  it("stop() ends the loop while 1Click is still down", async () => {
    const f = flaky(1000);
    let feed!: PricingFeed;
    feed = new PricingFeed(f.source, { cashAssetId: USDC_ID, sleep: async () => { if (f.calls.n >= 3) feed.stop(); } });
    await feed.start();
    expect(feed.ready()).toBe(false);
    expect(f.calls.n).toBe(3);
  });
});

describe("trading while pricing is unavailable", () => {
  it("blocks with PRICING_UNAVAILABLE and makes no outbound calls, then trades once pricing recovers", async () => {
    const h = harness();
    const state = { ready: false };
    h.deps.pricingReady = () => state.ready;
    const d = await executeTrade(h.deps, req());
    expect(d).toMatchObject({ status: "blocked", code: "PRICING_UNAVAILABLE" });
    if (d.status === "blocked") expect(d.message).toMatch(/retrying/i);
    expect(h.shieldCalls.n).toBe(0);
    expect(h.rails.swaps).toHaveLength(0);
    expect(await planTrade(h.deps, h.vaults.get("v1")!, req())).toMatchObject({ decision: { status: "blocked", code: "PRICING_UNAVAILABLE" } });

    state.ready = true;
    expect((await executeTrade(h.deps, req())).status).toBe("executed");
  });

  it("a paused vault still reports PAUSED first", async () => {
    const h = harness({ policy: { paused: true } });
    h.deps.pricingReady = () => false;
    expect(await executeTrade(h.deps, req())).toMatchObject({ status: "blocked", code: "PAUSED" });
  });

  it("the service answers health and the asset list while pricing is down, and says so", async () => {
    const m = createMockEnclave();
    const get = (path: string, token: string | null = m.agentToken) => m.app.request(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    expect(await (await get("/health", null)).json()).toMatchObject({ ok: true, pricing: "ready" });

    m.deps.pricingReady = () => false;
    const health = await get("/health", null);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, pricing: "retrying" });
    const assets = (await (await get("/v1/assets")).json()) as { notice?: string };
    expect(assets.notice).toMatch(/not loaded/i);
    const trade = await m.app.request("/v1/trade", { method: "POST", headers: { authorization: `Bearer ${m.agentToken}`, "content-type": "application/json" }, body: JSON.stringify({ side: "buy", asset: "SOL", amountUsd: 5, reason: "t" }) });
    expect(await trade.json()).toMatchObject({ status: "blocked", code: "PRICING_UNAVAILABLE" });

    m.deps.pricingReady = () => true;
    expect(((await (await get("/v1/assets")).json()) as { notice?: string }).notice).toBeUndefined();
  });
});
