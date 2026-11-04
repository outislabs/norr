import type { RegistryEntry } from "@norr/core";
import { describe, expect, it } from "vitest";
import { GoPlusClient } from "./goplus";

const entry = (chain: string, contractAddress: string | null): RegistryEntry =>
  ({ id: `nep141:${chain}-x`, symbol: "X", name: "X", class: "crypto", chain, decimals: 6, ticker: "X", issuer: null, priceUsd: 1, coingeckoId: null, contractAddress }) as RegistryEntry;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fake(handler: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  return { calls, f: async (url: string) => (calls.push(url), handler(url)) };
}

describe("GoPlusClient", () => {
  it("looks up an EVM token by chain id and lowercase address, and keeps GoPlus's fields", async () => {
    const usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    const r = fake(() => json({ code: 1, message: "OK", result: { [usdc]: { is_honeypot: "0", trust_list: "1", buy_tax: "0" } } }));
    const c = await new GoPlusClient({ fetch: r.f }).check(entry("base", "0x833589FCD6eDb6E08f4c7C32D4f71b54bdA02913"));
    expect(r.calls[0]).toBe(`https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${usdc}`);
    expect(c).toMatchObject({ status: "ok", family: "evm", chainId: "8453", address: usdc, data: { trust_list: "1" } });
  });

  it("uses the Solana endpoint for Solana mints, keyed as given", async () => {
    const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const r = fake(() => json({ code: 1, message: "ok", result: { [mint]: { mintable: { status: "1" }, trusted_token: 1 } } }));
    const c = await new GoPlusClient({ fetch: r.f }).check(entry("sol", mint));
    expect(r.calls[0]).toBe(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${mint}`);
    expect(c).toMatchObject({ status: "ok", family: "solana", address: mint });
  });

  it("says why a token is not covered, without calling GoPlus", async () => {
    const r = fake(() => json({}));
    const g = new GoPlusClient({ fetch: r.f });
    expect(await g.check(entry("near", "usdc.near"))).toMatchObject({ status: "not_covered", reason: expect.stringContaining("near") });
    expect(await g.check(entry("eth", null))).toMatchObject({ status: "not_covered" });
    expect(await g.check(entry("base", "not-an-address"))).toMatchObject({ status: "not_covered" });
    expect(r.calls).toHaveLength(0);
  });

  it("an empty result is no data; an error, a bad code or a timeout is unreachable and not cached", async () => {
    let mode: "empty" | "500" | "code" = "empty";
    const r = fake(() => (mode === "500" ? json({}, 500) : mode === "code" ? json({ code: 4029, message: "rate limited", result: {} }) : json({ code: 1, result: {} })));
    const g = new GoPlusClient({ fetch: r.f });
    const t = entry("bsc", "0x000000000000000000000000000000000000dead");
    expect(await g.check(t)).toMatchObject({ status: "no_data" });
    const fresh = new GoPlusClient({ fetch: r.f });
    mode = "500";
    expect(await fresh.check(t)).toMatchObject({ status: "unreachable", error: "HTTP 500" });
    mode = "code";
    expect(await fresh.check(t)).toMatchObject({ status: "unreachable", error: expect.stringContaining("4029") });
    const slow = new GoPlusClient({ fetch: () => new Promise((_, rej) => setTimeout(() => rej(new Error("The operation was aborted due to timeout")), 5)), timeoutMs: 1 });
    expect(await slow.check(t)).toMatchObject({ status: "unreachable" });
  });

  it("caches an answer for ten minutes, then asks again", async () => {
    const clock = { t: 0 };
    const r = fake(() => json({ code: 1, result: { "0x1111111111111111111111111111111111111111": { is_honeypot: "0" } } }));
    const g = new GoPlusClient({ fetch: r.f, now: () => clock.t });
    const t = entry("eth", "0x1111111111111111111111111111111111111111");
    await g.check(t);
    await g.check(t);
    expect(r.calls).toHaveLength(1);
    clock.t += 10 * 60_000 + 1;
    await g.check(t);
    expect(r.calls).toHaveLength(2);
  });
});
