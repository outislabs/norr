import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLiveDeps } from "./live";

const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const token = (assetId: string, symbol: string) => ({ assetId, decimals: 6, blockchain: "near", symbol, price: 1 });

/** A stand-in for 1Click whose token list answers 521 (Cloudflare's "origin is down") until `up` is set. */
async function fakeOneClick() {
  const state = { up: false, hits: 0 };
  const server: Server = createServer((req, res) => {
    state.hits++;
    if (!state.up) { res.writeHead(521, { "content-type": "text/html" }); res.end("<!DOCTYPE html><html>Web server is down</html>"); return; }
    const withOndo = req.url?.includes("ondoTokens=true");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([token(USDC, "USDC"), token("nep141:sol.test", "SOL"), ...(withOndo ? [token("nep141:nvdaon.test", "NVDAon")] : [])]));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { state, url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const cleanup: (() => unknown)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); vi.restoreAllMocks(); });

function env(oneclickUrl: string): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "norr-live-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return {
    NORR_OWNER_ACCOUNT: "owner.test.near",
    NORR_POLICY_JSON: JSON.stringify({ vaultId: "demo", maxTradeUsd: 10, dailySpendCapUsd: 30, dailyLossCapUsd: 3, maxEquityPct: 90, allowedCrypto: "any_safe", allowedEquities: ["NVDA"], cooldownSec: 10, paused: false, nonUsConfirmed: true, allowMediumRisk: false, privacy: "require" }),
    NORR_DATA_DIR: dir,
    NORR_DATA_KEY: Buffer.alloc(32, 7).toString("base64"),
    OUTLAYER_API_KEY: "test-key",
    OUTLAYER_ACCOUNT_ID: "test-account",
    ONECLICK_BASE_URL: oneclickUrl,
  };
}

describe("live service boot with 1Click down", () => {
  it("starts anyway, blocks trades as PRICING_UNAVAILABLE, keeps retrying, and trades once 1Click recovers", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const oc = await fakeOneClick();
    cleanup.push(oc.close);

    const l = await buildLiveDeps(env(oc.url), { pricingRetryBaseMs: 20 }); // resolves: no crash
    cleanup.push(() => l.pricing.stop());
    expect(l.deps.pricingReady?.()).toBe(false);
    expect(l.deps.registry.entries()).toHaveLength(0);

    const d = await (await import("./trade")).executeTrade(l.deps, { vaultId: "demo", side: "buy", asset: "SOL", amountUsd: 5, reason: "t" });
    expect(d).toMatchObject({ status: "blocked", code: "PRICING_UNAVAILABLE" });

    // Still failing after several retries: the loop keeps going.
    await vi.waitFor(() => expect(oc.state.hits).toBeGreaterThan(4), { timeout: 3000 });
    expect(l.deps.pricingReady?.()).toBe(false);

    oc.state.up = true;
    await l.pricing.start();
    expect(l.deps.pricingReady?.()).toBe(true);
    expect(l.deps.registry.resolve("SOL")?.class).toBe("crypto");
    expect(l.deps.registry.resolve("NVDA")?.class).toBe("equity");
    expect(l.deps.quoteAsset.id).toBe(USDC);
    expect(l.deps.quoteAsset.decimals).toBe(6);
  });

  it("when 1Click is up at boot, pricing is ready as soon as the first attempt lands", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const oc = await fakeOneClick();
    cleanup.push(oc.close);
    oc.state.up = true;
    const l = await buildLiveDeps(env(oc.url), { pricingRetryBaseMs: 20 });
    await l.pricing.start();
    expect(l.deps.pricingReady?.()).toBe(true);
  });
});
