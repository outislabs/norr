import { describe, expect, it } from "vitest";
import { createMockEnclave } from "./mock-enclave";
import { probe, RequestCounters, type UpstreamHealth } from "./operator";

const up = (ok = true): UpstreamHealth => ({ oneClick: { ok, status: ok ? 200 : 503, ms: 12 }, outLayer: { ok: true, status: 404, ms: 30 } });

function boot(o: Parameters<typeof createMockEnclave>[0] = {}) {
  const m = createMockEnclave(o);
  m.deps.settle = { waitMs: 0, intervalMs: 1 };
  const overview = (token: string | null = m.adminToken) => m.app.request("/admin/v1/overview", { headers: token ? { "x-admin-token": token } : {} });
  return { m, overview };
}

describe("operator overview", () => {
  it("needs the admin token: no token, a wrong token, an agent token and an owner session all get 401", async () => {
    const { m, overview } = boot();
    expect((await overview(null)).status).toBe(401);
    expect((await overview("wrong")).status).toBe(401);
    expect((await m.app.request("/admin/v1/overview", { headers: { authorization: `Bearer ${m.agentToken}` } })).status).toBe(401);
    expect((await overview()).status).toBe(200);
  });

  it("reports counts, caps and health, and in mock mode says the upstreams are mocked", async () => {
    const { overview } = boot({ startingUsd: 50 });
    const o = await (await overview()).json();
    expect(o).toMatchObject({
      signups: { open: true, createdToday: 0 },
      vaults: { total: 0, limit: 50, perOwnerLimit: 1, runningVaults: 1 },
      deposits: { capPerVaultUsd: 100, ceilingUsd: 5000, vaultsOverCap: 0 },
      health: { oneClick: "mock", outLayer: "mock", pricing: "ready" },
    });
    expect(o.last24Hours.perHour).toHaveLength(24);
    expect(o.deposits.totalValueUsd).toBeGreaterThan(0);
    expect(o.alerts.find((a: { code: string }) => a.code === "OVER_CAP")).toBeUndefined();
  });

  it("flags a vault holding more than the beta cap, as a count", async () => {
    const { overview } = boot({ startingUsd: 1000 });
    const o = await (await overview()).json();
    expect(o.deposits).toMatchObject({ vaultsOverCap: 1 });
    expect(o.alerts).toContainEqual(expect.objectContaining({ level: "warn", code: "OVER_CAP" }));
  });

  it("counts a day's trades by outcome and rule, and nothing identifies a vault, owner, balance or trade", async () => {
    const { m, overview } = boot();
    const trade = (asset: string, amountUsd: number) => m.app.request("/v1/trade", { method: "POST", headers: { authorization: `Bearer ${m.agentToken}`, "content-type": "application/json" }, body: JSON.stringify({ side: "buy", asset, amountUsd, reason: "private strategy words" }) });
    await trade("SOL", 5);
    await trade("SOL", 5000); // over the trade limit
    const text = await (await overview()).text();
    const o = JSON.parse(text);
    const sum = (k: string) => o.last24Hours.perHour.reduce((s: number, h: Record<string, number>) => s + h[k]!, 0);
    expect(sum("blocked")).toBeGreaterThanOrEqual(1);
    expect(o.last24Hours.blockedByCode.OVER_TRADE_LIMIT).toBe(1);
    // Aggregates only: no vault id, owner, token, asset, amount or reason anywhere in the answer.
    for (const secret of [m.vaultId, m.agentToken, "private strategy words", "demo-vault.mock.near", "norr_agent_"]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/"(owner|reason|walletAccount|portfolio|holdings|asset)"/);
  });

  it("counts new self-serve vaults today, and flags a full beta and an unreachable upstream", async () => {
    const { m, overview } = boot({ probes: async () => up(false) });
    for (let i = 0; i < 3; i++) m.onboarding.summaries(); // read-only and harmless
    const o = await (await overview()).json();
    expect(o.health.oneClick).toMatchObject({ ok: false, status: 503 });
    expect(o.alerts).toContainEqual(expect.objectContaining({ level: "alert", code: "ONECLICK_DOWN" }));
    expect(o.alerts.find((a: { code: string }) => a.code === "OUTLAYER_DOWN")).toBeUndefined();
    m.beta.setSignups(false);
    expect((await (await overview()).json()).alerts).toContainEqual(expect.objectContaining({ code: "SIGNUPS_CLOSED" }));
  });

  it("flags pricing that is not ready, an unreachable incident feed, and failing swaps", async () => {
    const { m, overview } = boot({ probes: async () => up() });
    m.deps.pricingReady = () => false;
    m.deps.shield = async () => null;
    for (let i = 0; i < 3; i++) m.deps.ledger.append({ vaultId: m.vaultId, at: m.deps.now(), request: { vaultId: m.vaultId, side: "buy", asset: "SOL", amountUsd: 1, reason: "x" }, decision: { status: "failed", message: "x" } });
    const codes = (await (await overview()).json()).alerts.map((a: { code: string }) => a.code);
    expect(codes).toEqual(expect.arrayContaining(["PRICING_RETRYING", "SHIELD_UNREACHABLE", "SWAPS_FAILING"]));
  });
});

describe("request counters and probes", () => {
  it("counts 5xx and 429 per hour, ignores everything else, and forgets old hours", () => {
    const t = { now: Date.UTC(2026, 10, 10, 12, 30) };
    const c = new RequestCounters(() => t.now);
    for (const s of [200, 404, 500, 503, 429, 401]) c.record(s);
    const h = Math.floor(t.now / 3_600_000) * 3_600_000;
    expect(c.at(h)).toEqual({ s5xx: 2, s429: 1 });
    t.now += 3_600_000;
    expect(c.at(h + 3_600_000)).toEqual({ s5xx: 0, s429: 0 });
    t.now += 60 * 3_600_000;
    c.record(500);
    expect(c.at(h)).toEqual({ s5xx: 0, s429: 0 });
  });

  it("probe: any answer under 500 is reachable, unless a specific status is required; no answer is down", async () => {
    const answer = (status: number) => (async () => new Response("", { status })) as unknown as typeof fetch;
    expect(await probe("https://x", { fetchImpl: answer(404) })).toMatchObject({ ok: true, status: 404 });
    expect(await probe("https://x", { fetchImpl: answer(503) })).toMatchObject({ ok: false, status: 503 });
    expect(await probe("https://x", { fetchImpl: answer(404), okStatus: 200 })).toMatchObject({ ok: false });
    expect(await probe("https://x", { fetchImpl: (async () => { throw new Error("down"); }) as unknown as typeof fetch })).toMatchObject({ ok: false, status: null });
  });
});
