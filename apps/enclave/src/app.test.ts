import { describe, expect, it } from "vitest";
import { createMockEnclave, DEMO } from "./mock-enclave";

const T0 = Date.UTC(2026, 10, 3, 12);
function boot(o: Parameters<typeof createMockEnclave>[0] = {}) {
  const clock = { t: T0 };
  const m = createMockEnclave({ now: () => clock.t, ...o });
  // Tests must not wait on real timers.
  m.deps.sleep = async (ms) => { clock.t += ms; };
  m.deps.settle = { waitMs: 0, intervalMs: 1 };
  const call = (path: string, init: { method?: string; token?: string | null; body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    const token = init.token === undefined ? m.agentToken : init.token;
    if (token) headers.authorization = `Bearer ${token}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    return m.app.request(path, { method: init.method ?? (init.body !== undefined ? "POST" : "GET"), headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
  };
  return { m, call, clock };
}

describe("auth", () => {
  it("health is open; everything under /v1 needs a valid agent token", async () => {
    const { m, call } = boot();
    expect((await call("/health", { token: null })).status).toBe(200);
    for (const [token, want] of [[null, 401], ["nope", 401], [m.agentToken, 200]] as const) {
      expect((await call("/v1/policy", { token })).status).toBe(want);
    }
  });

  it("a revoked token stops working at once", async () => {
    const { m, call } = boot();
    m.tokens.revoke(m.vaultId);
    expect((await call("/v1/policy")).status).toBe(401);
  });

  it("stores only hashes: the plaintext token is not recoverable from the store", () => {
    const { m } = boot();
    expect(JSON.stringify([...(m.tokens as unknown as { byHash: Map<string, string> }).byHash])).not.toContain(m.agentToken);
  });
});

describe("read endpoints", () => {
  it("lists crypto and equities grouped by ticker, with the equity notice", async () => {
    const { call } = boot();
    const all = await (await call("/v1/assets")).json();
    expect(all.crypto.map((a: { symbol: string }) => a.symbol)).toContain("SOL");
    expect(all.equities.map((e: { ticker: string }) => e.ticker)).toEqual(expect.arrayContaining(["NVDA", "TSLA", "SPY"]));
    expect(all.equityNotice).toContain("non-US");
    expect(Object.keys(await (await call("/v1/assets?class=crypto")).json())).toEqual(["crypto"]);
    expect((await call("/v1/assets?class=bonds")).status).toBe(400);
  });

  it("check_asset: a rug token is high risk; an equity shows eligibility and the notice; unknown is not found", async () => {
    const { call } = boot();
    const rug = await (await call("/v1/assets/check?asset=RUGPULL")).json();
    expect(rug.versions[0].risk.level).toBe("high");
    const nvda = await (await call("/v1/assets/check?asset=NVDA")).json();
    expect(nvda).toMatchObject({ found: true, class: "equity", eligible: true });
    expect(nvda.notice).toBeTruthy();
    expect((await (await call("/v1/assets/check?asset=ZZZ")).json()).found).toBe(false);
    expect((await call("/v1/assets/check")).status).toBe(400);
  });

  it("policy view is the agent's planning view (no vault id, no custody details)", async () => {
    const { call } = boot();
    const p = await (await call("/v1/policy")).json();
    expect(p).toMatchObject({ maxTradeUsd: 50, equitiesEnabled: true, paused: false });
    expect(Object.keys(p)).not.toContain("vaultId");
  });
});

describe("the demo flow, end to end on mock rails", () => {
  it("buy $40 NVDA, $150 TSLA blocked, $5 rug blocked, $5 USDC to SOL, then the kill switch", async () => {
    const { m, call, clock } = boot();

    const nvda = await (await call("/v1/trade", { body: { side: "buy", asset: "NVDA", amountUsd: 40, reason: "momentum" } })).json();
    expect(nvda.status).toBe("executed");
    expect(nvda.filled.asset).toBe("NVDAon");

    const tsla = await (await call("/v1/trade", { body: { side: "buy", asset: "TSLA", amountUsd: 150, reason: "big" } })).json();
    expect(tsla).toMatchObject({ status: "blocked", code: "OVER_TRADE_LIMIT" });

    const rug = await (await call("/v1/trade", { body: { side: "buy", asset: "RUGPULL", amountUsd: 5, reason: "ape" } })).json();
    expect(rug).toMatchObject({ status: "blocked", code: "SCAM_RISK" });
    expect(rug.message).toContain("liquidity");

    clock.t += 60_000; // past the Balanced preset's cooldown
    const sol = await (await call("/v1/trade", { body: { side: "buy", asset: "SOL", amountUsd: 5, reason: "diversify" } })).json();
    expect(sol.status).toBe("executed");

    const pf = await (await call("/v1/portfolio")).json();
    expect(pf.byClass.equity).toBeCloseTo(40 * 0.997, 1);
    expect(pf.holdings.map((h: { symbol: string }) => h.symbol)).toEqual(expect.arrayContaining(["USDC", "NVDAon", "SOL"]));

    expect((await call(`/owner/vaults/${m.vaultId}/pause`, { method: "POST", headers: { "x-admin-token": m.adminToken } })).status).toBe(200);
    const paused = await (await call("/v1/trade", { body: { side: "buy", asset: "SOL", amountUsd: 5, reason: "again" } })).json();
    expect(paused).toMatchObject({ status: "blocked", code: "PAUSED" });
  });

  it("quote is a dry run: it prices the trade and moves nothing", async () => {
    const { call } = boot();
    const q = await (await call("/v1/quote", { body: { side: "buy", asset: "NVDA", amountUsd: 40 } })).json();
    expect(q).toMatchObject({ status: "quote", asset: "NVDAon", outAsset: "NVDAon" });
    expect(q.minimumOut).toBeLessThan(q.estimatedOut);
    const pf = await (await call("/v1/portfolio")).json();
    expect(pf.byClass.equity).toBe(0);
  });

  it("a quote for a blocked trade returns the block", async () => {
    const { call } = boot();
    expect(await (await call("/v1/quote", { body: { side: "buy", asset: "TSLA", amountUsd: 500 } })).json()).toMatchObject({ code: "OVER_TRADE_LIMIT" });
  });

  it("activity shows decisions but never the agent's private reasoning", async () => {
    const { call } = boot();
    await call("/v1/trade", { body: { side: "buy", asset: "SOL", amountUsd: 5, reason: "SECRET-STRATEGY-42" } });
    const text = await (await call("/v1/activity")).text();
    expect(text).toContain("SOL");
    expect(text).not.toContain("SECRET-STRATEGY-42");
  });

  it("a Shield incident on the chain blocks trades with a clear reason", async () => {
    const { call } = boot({ shield: { status: "incidents", incidents: [{ scopeType: "chain", scopeValue: "sol", publicDescription: "Bridge halted." }] } });
    const d = await (await call("/v1/trade", { body: { side: "buy", asset: "SOL", amountUsd: 5 } })).json();
    expect(d).toMatchObject({ status: "blocked", code: "SHIELD_INCIDENT" });
    expect(d.message).toContain("Bridge halted.");
  });
});

describe("what the API refuses to do", () => {
  it("ignores any destination or recipient in the body: swaps always pay the vault", async () => {
    const { m, call } = boot();
    const d = await (await call("/v1/trade", { body: { side: "buy", asset: "SOL", amountUsd: 5, recipient: "attacker.near", destination: "attacker.near", vaultId: "other" } })).json();
    expect(d.status).toBe("executed"); // verifyExecution would have paused the vault if funds had gone elsewhere
    expect(m.vaults.get("demo")!.policy.paused).toBe(false);
    expect(m.vaults.pauseReasons.size).toBe(0);
  });

  it("has no route to withdraw, change policy or issue tokens", async () => {
    const { call } = boot();
    const attempts: [string, string][] = [["POST", "/v1/withdraw"], ["POST", "/v1/policy"], ["PUT", "/v1/policy"], ["POST", "/v1/tokens"], ["POST", "/owner/vaults/demo/pause"]];
    for (const [method, path] of attempts) {
      const r = await call(path, { method, body: {} });
      expect([404, 405, 401]).toContain(r.status);
    }
  });

  it("rejects malformed trades", async () => {
    const { call } = boot();
    for (const body of [{}, { side: "hold", asset: "SOL", amountUsd: 5 }, { side: "buy", asset: "SOL", amountUsd: -5 }, { side: "buy", asset: "", amountUsd: 5 }]) {
      expect((await call("/v1/trade", { body })).status).toBe(400);
    }
    const bad = await call("/v1/trade", { method: "POST", headers: { "content-type": "application/json" }, body: undefined });
    expect(bad.status).toBe(400);
  });

  it("owner controls need the admin token, and are absent when none is configured", async () => {
    const { m, call } = boot();
    expect((await call("/owner/vaults/demo/pause", { method: "POST", headers: { "x-admin-token": "wrong" } })).status).toBe(401);
    expect(m.vaults.get("demo")!.policy.paused).toBe(false);
    const { createApp } = await import("./app");
    const bare = createApp({ deps: m.deps, tokens: m.tokens, mock: true });
    expect((await bare.request("/owner/vaults/demo/pause", { method: "POST", headers: { "x-admin-token": m.adminToken } })).status).toBe(404);
  });

  it("an internal error never leaks details", async () => {
    const { m, call } = boot();
    m.deps.registry.resolve = () => { throw new Error("secret internals"); };
    const r = await call("/v1/assets/check?asset=SOL");
    expect(r.status).toBe(500);
    expect(await r.text()).not.toContain("secret internals");
  });
});

describe("demo catalog", () => {
  it("uses fixed mock prices", () => {
    expect(DEMO.NVDAon.price).toBe(208);
  });
});
