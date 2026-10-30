import { describe, expect, it, vi } from "vitest";
import { buildLive } from "./live";
import { assertNoBypassInMock, resolveShieldMode } from "./shield-mode";
import { harness, req } from "./fixtures";
import { executeTrade } from "./trade";

describe("resolveShieldMode: fail closed unless explicitly in dev", () => {
  it("defaults to enforce (block) when nothing is set", () => {
    expect(resolveShieldMode({})).toEqual({ onUnavailable: "block", bypass: false });
    expect(resolveShieldMode({ SHIELD_MODE: "enforce" })).toEqual({ onUnavailable: "block", bypass: false });
    expect(resolveShieldMode({ SHIELD_MODE: "enforce", NORR_ENV: "dev" }).bypass).toBe(false);
  });

  it("allows the bypass only with SHIELD_MODE=dev-bypass AND NORR_ENV=dev", () => {
    expect(resolveShieldMode({ SHIELD_MODE: "dev-bypass", NORR_ENV: "dev" })).toEqual({ onUnavailable: "allow", bypass: true });
  });

  it.each([[undefined], ["demo"], ["production"], ["prod"], ["DEV"], [" dev"], [""], ["staging"]])("refuses the bypass when NORR_ENV is %j", (envName) => {
    const env: NodeJS.ProcessEnv = { SHIELD_MODE: "dev-bypass" };
    if (envName !== undefined) env.NORR_ENV = envName;
    expect(() => resolveShieldMode(env)).toThrow(/never allowed in demo or production|only allowed when NORR_ENV=dev/);
  });

  it("rejects unknown modes and near-miss spellings instead of guessing", () => {
    for (const m of ["Dev-Bypass", "bypass", "off", "true", "1", ""]) {
      expect(() => resolveShieldMode({ SHIELD_MODE: m, NORR_ENV: "dev" })).toThrow(/unknown SHIELD_MODE/);
    }
  });

  it("mock/demo mode refuses any non-default Shield mode", () => {
    expect(() => assertNoBypassInMock({})).not.toThrow();
    expect(() => assertNoBypassInMock({ SHIELD_MODE: "enforce" })).not.toThrow();
    expect(() => assertNoBypassInMock({ SHIELD_MODE: "dev-bypass", NORR_ENV: "dev" })).toThrow(/not allowed in mock/);
  });

  it("the live service refuses to start with an illegal bypass, before any network call", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    for (const env of [{ SHIELD_MODE: "dev-bypass" }, { SHIELD_MODE: "dev-bypass", NORR_ENV: "demo" }, { SHIELD_MODE: "dev-bypass", NORR_ENV: "production" }]) {
      await expect(buildLive(env)).rejects.toThrow(/NORR_ENV=dev/);
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("trading with the Shield feed down", () => {
  it("fails closed by default: SHIELD_INCIDENT with a retry message, no swap sent", async () => {
    const h = harness({ shield: null });
    const d = await executeTrade(h.deps, req());
    expect(d).toMatchObject({ status: "blocked", code: "SHIELD_INCIDENT" });
    expect(h.rails.swaps).toHaveLength(0);
  });

  it("with the bypass on, the trade proceeds and a loud warning is logged for EVERY trade", async () => {
    const h = harness({ shield: null });
    const warn = vi.fn();
    h.deps.shieldOnUnavailable = "allow";
    h.deps.onShieldBypass = warn;
    expect((await executeTrade(h.deps, req({ amountUsd: 10 }))).status).toBe("executed");
    h.clock.t += 60_000;
    expect((await executeTrade(h.deps, req({ asset: "SOL", amountUsd: 5 }))).status).toBe("executed");
    h.clock.t += 60_000;
    await executeTrade(h.deps, req({ asset: "TSLA", amountUsd: 500 })); // blocked for another reason: still evaluated without the feed
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith("v1");
    for (const row of h.ledger.list("v1")) expect(row.note).toContain("SHIELD BYPASS");
  });

  it("the bypass never overrides a real incident", async () => {
    // Incidents on both chains Norr could route NVDA through: the feed is reachable, so nothing is bypassed.
    const h = harness({ shield: { status: "incidents", incidents: [{ scopeType: "chain", scopeValue: "bsc" }, { scopeType: "chain", scopeValue: "sol" }] } });
    const warn = vi.fn();
    h.deps.shieldOnUnavailable = "allow";
    h.deps.onShieldBypass = warn;
    expect(await executeTrade(h.deps, req())).toMatchObject({ status: "blocked", code: "SHIELD_INCIDENT" });
    expect(h.rails.swaps).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a reachable, healthy feed never triggers the warning even when the bypass is on", async () => {
    const h = harness();
    const warn = vi.fn();
    h.deps.shieldOnUnavailable = "allow";
    h.deps.onShieldBypass = warn;
    expect((await executeTrade(h.deps, req())).status).toBe("executed");
    expect(warn).not.toHaveBeenCalled();
    expect(h.ledger.list("v1")[0]!.note).toBeUndefined();
  });
});
