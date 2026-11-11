import type { OneClickToken } from "@norr/core";
import { checkPriceSanity } from "@norr/core";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("PricingFeed: reference prices stay fresh (stale-reference regression)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A 1Click token list whose SOL price follows `market.sol`, like the live list does. */
  function market(sol: number) {
    const m = { sol, down: false, calls: 0 };
    const source = async () => {
      m.calls++;
      if (m.down) throw new Error("1Click tokens: 503");
      const list = [tok(USDC_ID, "USDC"), { ...tok("nep141:sol.test", "SOL"), decimals: 24, price: m.sol }];
      return { plain: list, withOndo: list };
    };
    return { m, source };
  }

  it("reproduces the bug: a boot-time reference blocks every quote at a constant gap until the list is reloaded", async () => {
    vi.useFakeTimers();
    const { m, source } = market(150);
    const feed = new PricingFeed(source, { cashAssetId: USDC_ID, sleep: async () => {}, refreshMs: 60_000, now: () => Date.now() });
    await feed.start();
    const solRef = () => feed.registry.byId("nep141:sol.test")!.priceUsd;
    expect(solRef()).toBe(150);

    // SOL moves 2.5% after boot. Live quotes now imply $153.75 at any size ($1.50, $4, ...).
    m.sol = 153.75;
    for (let i = 0; i < 3; i++) expect(checkPriceSanity(solRef(), 153.75)).toMatchObject({ code: "PRICE_SANITY" });
    expect(checkPriceSanity(solRef(), 153.75)?.message).toMatch(/2\.5% away/);

    // The old code never reloaded, so this held forever. Now the next tick picks up the live price.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(m.calls).toBe(2);
    expect(solRef()).toBe(153.75);
    expect(checkPriceSanity(solRef(), 153.75)).toBeNull();
    // The 2% limit itself is unchanged: a real 2.5% deviation from a fresh reference still blocks.
    expect(checkPriceSanity(solRef(), 153.75 * 1.025)).toMatchObject({ code: "PRICE_SANITY" });
    feed.stop();
  });

  it("keeps the last list through a short outage, then reports not ready once the reference is older than maxAgeMs", async () => {
    vi.useFakeTimers();
    const { m, source } = market(150);
    const failures: string[] = [];
    const feed = new PricingFeed(source, { cashAssetId: USDC_ID, sleep: async () => {}, refreshMs: 60_000, maxAgeMs: 5 * 60_000, now: () => Date.now(), onFailure: (_n, msg) => failures.push(msg) });
    await feed.start();
    const loadedAt = feed.lastLoadedAt();
    m.down = true;
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(feed.ready()).toBe(true); // 4 min old: still usable
    expect(feed.registry.byId("nep141:sol.test")?.priceUsd).toBe(150);
    expect(feed.lastLoadedAt()).toBe(loadedAt);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(feed.ready()).toBe(false); // 6 min old: trades block with PRICING_UNAVAILABLE, not a misleading PRICE_SANITY
    expect(failures.length).toBeGreaterThanOrEqual(5);

    m.down = false;
    m.sol = 160;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(feed.ready()).toBe(true);
    expect(feed.registry.byId("nep141:sol.test")?.priceUsd).toBe(160);
    feed.stop();
  });

  it("stop() ends the periodic reload", async () => {
    vi.useFakeTimers();
    const { m, source } = market(150);
    const feed = new PricingFeed(source, { cashAssetId: USDC_ID, sleep: async () => {}, refreshMs: 60_000 });
    await feed.start();
    feed.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(m.calls).toBe(1);
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
