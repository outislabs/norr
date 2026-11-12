import { IntentsApiError } from "@norr/intents";
import { describe, expect, it } from "vitest";
import { BalanceHealth, balanceFailure } from "./errors";
import { createMockEnclave } from "./mock-enclave";
import { tryPortfolio } from "./owner/routes";

const T0 = Date.UTC(2026, 10, 12, 18, 30);
const limit = (retry?: number) => new IntentsApiError(429, "OutLayer confidential balance: limit reached: 1000 per day for custody:*", { code: "operation_limit_reached", limit: 1000, window: "day", ...(retry !== undefined ? { retryAfterSeconds: retry } : {}) });

describe("balanceFailure: the real reason a balance read failed", () => {
  it("OutLayer's operation limit says so, with the ceiling and when it clears (UTC)", () => {
    const f = balanceFailure(limit(5400), T0);
    expect(f).toMatchObject({ code: "operation_limit_reached", source: "custody", retryAfterSeconds: 5400, retryAt: new Date(T0 + 5400_000).toISOString() });
    expect(f.reason).toContain("1000 custody operations per day");
    expect(f.reason).toContain("Retry in about 1.5 hours (20:00 UTC)");
    expect(f.reason).toContain("the vault's money is untouched");
  });

  it("when OutLayer does not say when the limit clears, Norr does not invent a time", () => {
    const f = balanceFailure(limit(), T0);
    expect(f.retryAt).toBeUndefined();
    expect(f.reason).toContain("did not say when it clears");
    expect(f.reason).not.toMatch(/UTC\)/);
  });

  it("a reset on another UTC day carries the date", () => {
    expect(balanceFailure(limit(8 * 3600), T0).reason).toContain("2026-11-13 02:30 UTC");
  });

  it("outage codes, a rejected key and plain rate limiting are told apart", () => {
    expect(balanceFailure(new IntentsApiError(503, "x: y", { code: "chain_unavailable", retryAfterSeconds: 5 }), T0).reason).toMatch(/could not read the chain this second\. Retry in about 5 seconds/);
    expect(balanceFailure(new IntentsApiError(503, "x: y", { code: "confidential_jwt_expired" }), T0).reason).toMatch(/private \(confidential\) balance service/);
    expect(balanceFailure(new IntentsApiError(503, "x: y", { code: "keystore_error" }), T0).code).toBe("keystore_error");
    expect(balanceFailure(new IntentsApiError(503, "x: y", { code: "service_unavailable" }), T0).reason).toMatch(/will not clear by waiting/);
    expect(balanceFailure(new IntentsApiError(401, "OutLayer confidential balance: invalid api key"), T0)).toMatchObject({ code: "key_rejected", source: "custody" });
    const rl = balanceFailure(new IntentsApiError(429, "OutLayer: rate_limited", { code: "rate_limited" }), T0);
    expect(rl.reason).toMatch(/rate-limiting/);
    expect(rl.code).toBe("rate_limited");
  });

  it("an unreachable OutLayer or NEAR RPC names which one", () => {
    expect(balanceFailure(new TypeError("fetch failed"), T0)).toMatchObject({ code: "unreachable", source: "custody" });
    expect(balanceFailure(new IntentsApiError(0, "NEAR RPC: fetch failed"), T0)).toMatchObject({ code: "unreachable", source: "chain" });
    expect(balanceFailure(new IntentsApiError(502, "OutLayer: bad gateway"), T0).reason).toMatch(/OutLayer failed on its side \(HTTP 502\)/);
  });

  it("anything that is not an upstream failure is named as a Norr fault, not blamed on OutLayer", () => {
    const f = balanceFailure(new Error("Cannot read properties of undefined (reading 'holdings')"), T0);
    expect(f).toMatchObject({ code: "norr_error", source: "norr" });
    expect(f.reason).toMatch(/fault on Norr's side/);
  });
});

describe("a failed balance read through the service", () => {
  function boot() {
    const clock = { t: T0 };
    const m = createMockEnclave({ now: () => clock.t });
    m.deps.balanceHealth = new BalanceHealth();
    const vault = m.deps.vaults.get(m.vaultId)!;
    const get = (path: string) => m.app.request(path, { headers: { authorization: `Bearer ${m.agentToken}` } });
    return { m, vault, get, clock };
  }

  it("get_portfolio answers with the real reason, a code, and when to retry", async () => {
    const { vault, get } = boot();
    vault.custody.confidentialHoldings = async () => { throw limit(7200); };
    const res = await get("/v1/portfolio");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/^balances unavailable: OutLayer's operation limit for this vault's wallet is reached/);
    expect(body).toMatchObject({ code: "operation_limit_reached", source: "custody", retryAfterSeconds: 7200, retryAt: new Date(T0 + 7200_000).toISOString() });
    expect(JSON.stringify(body)).not.toMatch(/api[_-]?key|authorization|bearer/i);
  });

  it("a Norr-side fault is reported as one", async () => {
    const { vault, get } = boot();
    vault.custody.confidentialHoldings = async () => { throw new TypeError("x is not a function"); };
    const body = await (await get("/v1/portfolio")).json();
    expect(body).toMatchObject({ code: "norr_error", source: "norr" });
    expect(body.error).toContain("fault on Norr's side");
  });

  it("the owner's vault view carries the same reason; a good read clears it", async () => {
    const { m, vault } = boot();
    const read = vault.custody.confidentialHoldings.bind(vault.custody);
    vault.custody.confidentialHoldings = async () => { throw limit(60); };
    const bad = await tryPortfolio(m.deps, vault);
    expect(bad.portfolio).toBeNull();
    expect(bad.failure).toMatchObject({ code: "operation_limit_reached" });
    expect(m.deps.balanceHealth!.current()?.failure.code).toBe("operation_limit_reached");
    vault.custody.confidentialHoldings = read;
    m.deps.now = () => T0 + 1000;
    const good = await tryPortfolio(m.deps, vault);
    expect(good.portfolio).not.toBeNull();
    expect(good.failure).toBeNull();
    expect(m.deps.balanceHealth!.current()).toBeNull();
  });

  it("the operator alert says why balances are unreadable (no vault named)", async () => {
    const { m, vault } = boot();
    vault.custody.confidentialHoldings = async () => { throw limit(3600); };
    const o = await (await m.app.request("/admin/v1/overview", { headers: { "x-admin-token": m.adminToken } })).json();
    const alert = o.alerts.find((a: { code: string }) => a.code === "BALANCES_UNREADABLE");
    expect(alert.message).toMatch(/could not be read; totals are partial\. Latest reason \(\d\d:\d\d UTC, custody, operation_limit_reached\): OutLayer's operation limit/);
    expect(alert.message).not.toContain(m.vaultId);
  });
});
