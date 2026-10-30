import { describe, expect, it } from "vitest";
import { NearIntentsBalances } from "./balances";
import { DexScreenerSignals } from "./dexscreener";
import type { FetchLike } from "./http";
import { ShieldClient } from "./shield";
import type { RegistryEntry } from "@norr/core";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const entry = (over: Partial<RegistryEntry> = {}): RegistryEntry => ({
  id: "nep141:x", symbol: "X", name: "X", class: "crypto", chain: "sol", decimals: 6, ticker: "X", issuer: null, priceUsd: 1, coingeckoId: null, contractAddress: "MintAddr1", ...over,
});
function rec(respond: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f: FetchLike = async (url, init) => { calls.push({ url, init }); return respond(url, init); };
  return { f, calls };
}

describe("DexScreenerSignals", () => {
  const day = 86_400_000;
  const now = 100 * day;
  const pairs = [
    { baseToken: { address: "MintAddr1" }, liquidity: { usd: 100_000 }, marketCap: 2_000_000, fdv: 9_000_000, pairCreatedAt: now - 40 * day },
    { baseToken: { address: "mintaddr1" }, liquidity: { usd: 50_000 }, fdv: 3_000_000, pairCreatedAt: now - 10 * day },
    { baseToken: { address: "OtherMint" }, liquidity: { usd: 9e9 }, marketCap: 9e12, pairCreatedAt: 0 },
  ];

  it("sums liquidity over the token's own pools, takes the largest market cap and the oldest pool", async () => {
    const r = rec(() => json(pairs));
    const s = await new DexScreenerSignals({ fetch: r.f, now: () => now }).signals(entry());
    expect(s).toEqual({ routable: true, liquidityUsd: 150_000, marketCapUsd: 3_000_000, ageDays: 40 });
    expect(r.calls[0]!.url).toBe("https://api.dexscreener.com/tokens/v1/solana/MintAddr1");
  });

  it("returns unknown signals, without any request, for unmapped chains or missing contracts", async () => {
    const r = rec(() => json(pairs));
    const d = new DexScreenerSignals({ fetch: r.f });
    const unknown = { routable: true, liquidityUsd: null, marketCapUsd: null, ageDays: null };
    expect(await d.signals(entry({ chain: "btc" }))).toEqual(unknown);
    expect(await d.signals(entry({ contractAddress: null }))).toEqual(unknown);
    expect(r.calls).toHaveLength(0);
  });

  it("treats a failed lookup as unknown and does not cache it", async () => {
    let fail = true;
    const r = rec(() => (fail ? json({ message: "boom" }, 500) : json(pairs)));
    const d = new DexScreenerSignals({ fetch: r.f, now: () => now });
    expect((await d.signals(entry())).liquidityUsd).toBeNull();
    fail = false;
    expect((await d.signals(entry())).liquidityUsd).toBe(150_000);
  });

  it("caches a good lookup for the TTL", async () => {
    let t = now;
    const r = rec(() => json(pairs));
    const d = new DexScreenerSignals({ fetch: r.f, now: () => t, ttlMs: 60_000 });
    await d.signals(entry());
    await d.signals(entry());
    expect(r.calls).toHaveLength(1);
    t += 61_000;
    await d.signals(entry());
    expect(r.calls).toHaveLength(2);
  });

  it("returns unknown when no pool lists the token as its base", async () => {
    const r = rec(() => json([pairs[2]]));
    expect((await new DexScreenerSignals({ fetch: r.f }).signals(entry())).liquidityUsd).toBeNull();
  });
});

describe("ShieldClient", () => {
  it("reads an operational feed and sends the bearer key", async () => {
    const r = rec(() => json({ status: "operational" }));
    expect(await new ShieldClient({ apiKey: "shield_k", fetch: r.f }).feed()).toEqual({ status: "operational" });
    expect((r.calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer shield_k");
    expect(r.calls[0]!.url).toBe("https://shield.chaindefuser.com/incident");
  });

  it("parses incidents", async () => {
    const r = rec(() => json({ status: "incidents", incidents: [{ scopeType: "chain", scopeValue: "sol", direction: "both", publicDescription: "Paused." }] }));
    expect(await new ShieldClient({ apiKey: "k", fetch: r.f }).feed()).toEqual({
      status: "incidents",
      incidents: [{ scopeType: "chain", scopeValue: "sol", direction: "both", publicDescription: "Paused." }],
    });
  });

  it("fails closed (null) on HTTP errors, bad key type, and unreadable incidents", async () => {
    expect(await new ShieldClient({ apiKey: "k", fetch: rec(() => json({ message: "Invalid key_type" }, 401)).f }).feed()).toBeNull();
    expect(await new ShieldClient({ apiKey: "k", fetch: rec(() => json({ status: "incidents", incidents: [{ scopeType: "weird", scopeValue: "x" }] })).f }).feed()).toBeNull();
    expect(await new ShieldClient({ apiKey: "k", fetch: rec(() => json({ hello: 1 })).f }).feed()).toBeNull();
    expect(await new ShieldClient({ apiKey: "k", fetch: async () => { throw new Error("network"); } }).feed()).toBeNull();
  });

  it("caches a good read briefly but never a failure", async () => {
    let t = 0;
    let ok = true;
    const r = rec(() => (ok ? json({ status: "operational" }) : json({}, 500)));
    const c = new ShieldClient({ apiKey: "k", fetch: r.f, now: () => t, ttlMs: 15_000 });
    await c.feed();
    await c.feed();
    expect(r.calls).toHaveLength(1);
    t = 16_000;
    ok = false;
    expect(await c.feed()).toBeNull();
  });
});

describe("NearIntentsBalances", () => {
  const view = (result: unknown) => json({ result: { result: [...Buffer.from(JSON.stringify(result))] } });

  it("lists owned tokens then batch-reads their balances, dropping zeros", async () => {
    const calls: string[] = [];
    const r = rec((_u, init) => {
      const body = JSON.parse(String(init!.body));
      calls.push(body.params.method_name);
      return body.params.method_name === "mt_tokens_for_owner"
        ? view([{ token_id: "nep141:usdc" }, { token_id: "nep141:sol" }])
        : view(["1997728", "0"]);
    });
    expect(await new NearIntentsBalances({ fetch: r.f }).holdings("acct")).toEqual({ "nep141:usdc": "1997728" });
    expect(calls).toEqual(["mt_tokens_for_owner", "mt_batch_balance_of"]);
  });

  it("returns an empty object for an account with no tokens, and throws on a failed view", async () => {
    expect(await new NearIntentsBalances({ fetch: rec(() => view([])).f }).holdings("a")).toEqual({});
    await expect(new NearIntentsBalances({ fetch: rec(() => json({ error: { message: "x" } })).f }).holdings("a")).rejects.toThrow();
  });
});
