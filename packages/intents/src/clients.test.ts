import { describe, expect, it } from "vitest";
import { OneClick } from "./oneclick";
import { OutLayerCustody, mapState } from "./outlayer";
import { IntentsApiError } from "./types";
import type { FetchLike } from "./http";

const KEY = "test_key_do_not_use_0123456789";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function recorder(respond: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f: FetchLike = async (url, init = {}) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { f, calls };
}

describe("OneClick", () => {
  it("parses the token list and adds ?ondoTokens=true on request", async () => {
    const r = recorder(() => json([{ assetId: "nep141:a", decimals: 6, blockchain: "near", symbol: "USDC", price: 1, coingeckoId: "usd-coin" }]));
    const tokens = await new OneClick({ fetch: r.f }).tokens(true);
    expect(tokens).toEqual([{ assetId: "nep141:a", decimals: 6, blockchain: "near", symbol: "USDC", price: 1, coingeckoId: "usd-coin", contractAddress: undefined }]);
    expect(r.calls[0]!.url).toContain("?ondoTokens=true");
  });

  it("sends a dry EXACT_INPUT quote paying and refunding the vault, with the API key header", async () => {
    const r = recorder(() => json({ quote: { amountIn: "1500000", amountOut: "15430264", minAmountOut: "15275961", amountInUsd: "1.499", amountOutUsd: "1.498" } }));
    const q = await new OneClick({ fetch: r.f, apiKey: "k1", now: () => 0 }).quote({ tokenIn: "nep141:usdc", tokenOut: "nep141:sol", amountIn: "1500000", recipient: "vault.near" });
    expect(q).toEqual({ amountIn: "1500000", amountOut: "15430264", minAmountOut: "15275961", amountInUsd: 1.499, amountOutUsd: 1.498 });
    const sent = JSON.parse(String(r.calls[0]!.init.body));
    expect(sent).toMatchObject({ dry: true, swapType: "EXACT_INPUT", depositType: "INTENTS", recipient: "vault.near", recipientType: "INTENTS", refundTo: "vault.near", refundType: "INTENTS", slippageTolerance: 100 });
    expect((r.calls[0]!.init.headers as Record<string, string>)["x-api-key"]).toBe("k1");
  });

  it("returns null for 'No liquidity' and rethrows other errors", async () => {
    const none = recorder(() => json({ message: "No liquidity available" }, 400));
    expect(await new OneClick({ fetch: none.f }).quote({ tokenIn: "a", tokenOut: "b", amountIn: "1", recipient: "v" })).toBeNull();
    const bad = recorder(() => json({ message: "recipient is not valid" }, 400));
    await expect(new OneClick({ fetch: bad.f }).quote({ tokenIn: "a", tokenOut: "b", amountIn: "1", recipient: "v" })).rejects.toBeInstanceOf(IntentsApiError);
  });

  it("audit returns the executed swap only for SUCCESS", async () => {
    const ok = recorder(() => json({ status: "SUCCESS", quoteResponse: { quoteRequest: { originAsset: "a", destinationAsset: "b", recipient: "v" } }, swapDetails: { amountIn: "10", amountOut: "20" } }));
    expect(await new OneClick({ fetch: ok.f }).audit("dep1")).toEqual({ tokenIn: "a", tokenOut: "b", amountIn: "10", amountOut: "20", recipient: "v" });
    expect(ok.calls[0]!.url).toContain("depositAddress=dep1");
    const pending = recorder(() => json({ status: "PROCESSING" }));
    expect(await new OneClick({ fetch: pending.f }).audit("dep1")).toBeNull();
    const partial = recorder(() => json({ status: "SUCCESS", swapDetails: {} }));
    expect(await new OneClick({ fetch: partial.f }).audit("dep1")).toBeNull();
  });
});

describe("OutLayerCustody", () => {
  const bounds = { tokenIn: "nep141:usdc", tokenOut: "nep141:sol", amountIn: "1500000", minAmountOut: "15275961" };

  it("sends token_in, token_out, amount_in AND min_amount_out with a bearer key", async () => {
    const r = recorder(() => json({ request_id: "req1", status: "pending_approval" }));
    const st = await new OutLayerCustody({ apiKey: KEY, accountId: "acct", fetch: r.f }).swap(bounds);
    expect(st).toEqual({ state: "pending_approval", requestId: "req1" });
    expect(JSON.parse(String(r.calls[0]!.init.body))).toEqual({ token_in: "nep141:usdc", token_out: "nep141:sol", amount_in: "1500000", min_amount_out: "15275961" });
    expect((r.calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(r.calls[0]!.url).toBe("https://api.outlayer.ai/wallet/v1/intents/swap");
  });

  it("refuses to call the API when min_amount_out is missing", async () => {
    const r = recorder(() => json({}));
    const { minAmountOut: _m, ...noMin } = bounds;
    await expect(new OutLayerCustody({ apiKey: KEY, accountId: "a", fetch: r.f }).swap(noMin as never)).rejects.toThrow(/minAmountOut/);
    expect(r.calls).toHaveLength(0);
  });

  it("reads request status and the deposit address", async () => {
    const r = recorder(() => json({ status: "success", result: { deposit_address: "dep9" } }));
    expect(await new OutLayerCustody({ apiKey: KEY, accountId: "a", fetch: r.f }).status("req1")).toEqual({ state: "success", requestId: "req1", depositAddress: "dep9", detail: undefined });
  });

  it("error messages never contain the API key", async () => {
    const r = recorder(() => json({ error: "policy_denied", message: "Address 'x' is not in whitelist" }, 403));
    const err = await new OutLayerCustody({ apiKey: KEY, accountId: "a", fetch: r.f }).swap(bounds).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntentsApiError);
    expect((err as IntentsApiError).status).toBe(403);
    expect(String((err as Error).message)).not.toContain(KEY);
  });

  it("maps unknown states to in_progress, never success", () => {
    expect(mapState("success")).toBe("success");
    expect(mapState("pending_approval")).toBe("pending_approval");
    expect(mapState("rejected")).toBe("failed");
    expect(mapState("expired")).toBe("failed");
    expect(mapState("processing")).toBe("in_progress");
    expect(mapState(undefined)).toBe("in_progress");
    expect(mapState("succeeded")).toBe("in_progress");
  });
});

describe("confidential layer", () => {
  const bounds = { tokenIn: "nep141:usdc", tokenOut: "nep141:sol", amountIn: "1500000", minAmountOut: "15635038" };
  const ol = (r: ReturnType<typeof recorder>) => new OutLayerCustody({ apiKey: "test_key_do_not_use_0123456789", accountId: "acct", fetch: r.f });

  it("1Click: a confidential quote uses CONFIDENTIAL_INTENTS types and confidentiality; a public one does not", async () => {
    const r = recorder(() => json({ quote: { amountIn: "1", amountOut: "2", minAmountOut: "1", amountInUsd: "1", amountOutUsd: "1" } }));
    const oc = new OneClick({ fetch: r.f, now: () => 0 });
    await oc.quote({ tokenIn: "a", tokenOut: "b", amountIn: "1", recipient: "v", venue: "confidential" });
    await oc.quote({ tokenIn: "a", tokenOut: "b", amountIn: "1", recipient: "v" });
    const conf = JSON.parse(String(r.calls[0]!.init.body));
    const pub = JSON.parse(String(r.calls[1]!.init.body));
    expect(conf).toMatchObject({ depositType: "CONFIDENTIAL_INTENTS", recipientType: "CONFIDENTIAL_INTENTS", refundType: "CONFIDENTIAL_INTENTS", confidentiality: "basic", refundTo: "v" });
    expect(pub).toMatchObject({ depositType: "INTENTS", recipientType: "INTENTS", refundType: "INTENTS" });
    expect(pub.confidentiality).toBeUndefined();
  });

  it("OutLayer: a confidential swap goes to the confidential route with min_amount_out; a public one does not", async () => {
    const r = recorder(() => json({ request_id: "r1", status: "pending_approval" }));
    await ol(r).swap(bounds, "confidential");
    await ol(r).swap(bounds);
    expect(r.calls[0]!.url).toBe("https://api.outlayer.ai/wallet/v1/confidential/swap");
    expect(JSON.parse(String(r.calls[0]!.init.body))).toEqual({ token_in: "nep141:usdc", token_out: "nep141:sol", amount_in: "1500000", min_amount_out: "15635038" });
    expect(r.calls[1]!.url).toBe("https://api.outlayer.ai/wallet/v1/intents/swap");
  });

  it("OutLayer: still refuses a confidential swap without a minimum, before any request", async () => {
    const r = recorder(() => json({}));
    const { minAmountOut: _m, ...noMin } = bounds;
    await expect(ol(r).swap(noMin as never, "confidential")).rejects.toThrow(/minAmountOut/);
    expect(r.calls).toHaveLength(0);
  });

  it("1Click: a funding quote is real (not dry), pays the vault's confidential account, refunds to the funder, and returns the one-time address", async () => {
    const r = recorder(() => json({ quote: { depositAddress: "abc123def456", amountIn: "1000000", amountOut: "1000000", minAmountOut: "990000", deadline: "2026-11-01T12:30:00Z" } }));
    const oc = new OneClick({ fetch: r.f, now: () => Date.UTC(2026, 10, 1, 12, 0) });
    expect(await oc.requestDeposit({ token: "nep141:usdc", amount: "1000000", recipient: "vaultacct", refundTo: "funder.near" })).toEqual({ depositAddress: "abc123def456", amountIn: "1000000", amountOut: "1000000", minAmountOut: "990000", deadline: "2026-11-01T12:30:00Z" });
    expect(r.calls[0]!.url).toBe("https://1click.chaindefuser.com/v0/quote");
    expect(JSON.parse(String(r.calls[0]!.init.body))).toMatchObject({
      dry: false, swapType: "EXACT_INPUT", originAsset: "nep141:usdc", destinationAsset: "nep141:usdc", amount: "1000000",
      depositType: "ORIGIN_CHAIN", recipient: "vaultacct", recipientType: "CONFIDENTIAL_INTENTS", refundTo: "funder.near", refundType: "ORIGIN_CHAIN",
      confidentiality: "basic", deadline: "2026-11-01T12:30:00.000Z",
    });
  });

  it("1Click: refuses a funding offer with no address, or one that would lose more than 1%", async () => {
    const quote = (q: object) => new OneClick({ fetch: recorder(() => json({ quote: q })).f });
    const p = { token: "nep141:usdc", amount: "1000000", recipient: "v", refundTo: "f.near" };
    await expect(quote({ amountIn: "1000000", amountOut: "1000000", minAmountOut: "1", deadline: "x" }).requestDeposit(p)).rejects.toThrow(/unexpected/);
    await expect(quote({ depositAddress: "a", amountIn: "1000000", amountOut: "980000", minAmountOut: "970000", deadline: "x" }).requestDeposit(p)).rejects.toThrow(/lose more than 1%/);
  });

  it("1Click: funds from another chain (ETH on Ethereum) into USDC in the vault's confidential account, refunding on the origin chain", async () => {
    const q = { depositAddress: "0xdep", amountIn: "600000000000000", amountInFormatted: "0.0006", amountInUsd: "1.3616", amountOut: "1362236", amountOutUsd: "1.3613", minAmountOut: "1348613", deadline: "d" };
    const r = recorder(() => json({ quote: q }));
    const oc = new OneClick({ fetch: r.f });
    const offer = await oc.requestDeposit({ token: "nep141:usdc", originAsset: "nep141:eth.omft.near", amount: "600000000000000", expectedOut: "1361000", recipient: "vaultacct", refundTo: "0x8ba1f109551bD432803012645Ac136ddd64DBA72" });
    expect(offer).toMatchObject({ depositAddress: "0xdep", amountInFormatted: "0.0006", minAmountOut: "1348613" });
    expect(JSON.parse(String(r.calls[0]!.init.body))).toMatchObject({ originAsset: "nep141:eth.omft.near", destinationAsset: "nep141:usdc", recipient: "vaultacct", recipientType: "CONFIDENTIAL_INTENTS", refundType: "ORIGIN_CHAIN" });
  });

  it("1Click: across assets, refuses a route that loses more than 1% in USD, has no USD values, or pays far below the listed price", async () => {
    const quote = (over: object) => new OneClick({ fetch: recorder(() => json({ quote: { depositAddress: "a", amountIn: "1", amountOut: "1000000", minAmountOut: "990000", deadline: "d", amountInUsd: "1.00", amountOutUsd: "0.999", ...over } })).f });
    const p = { token: "nep141:usdc", originAsset: "nep141:sol.omft.near", amount: "1", recipient: "v", refundTo: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T" };
    await expect(quote({}).requestDeposit(p)).resolves.toBeTruthy();
    await expect(quote({ amountOutUsd: "0.98" }).requestDeposit(p)).rejects.toThrow(/lose more than 1%/);
    await expect(quote({ amountInUsd: undefined }).requestDeposit(p)).rejects.toThrow(/no USD values/);
    await expect(quote({}).requestDeposit({ ...p, expectedOut: "1100000" })).rejects.toThrow(/below the listed price/);
  });

  it("OutLayer: asks for a confidential deposit address with the source asset and amount, and rejects a reply without one", async () => {
    const r = recorder(() => json({ intent_id: "i1", deposit_address: "49e108dd", amount: "8000000", amount_out: "8000000", min_amount_out: "7920000", expires_at: "2026-11-02T17:49:39Z" }));
    expect(await ol(r).requestConfidentialDeposit("nep141:usdc", "8000000")).toEqual({ intentId: "i1", depositAddress: "49e108dd", amount: "8000000", minAmountOut: "7920000", expiresAt: "2026-11-02T17:49:39Z" });
    expect(r.calls[0]!.url).toBe("https://api.outlayer.ai/wallet/v1/confidential/deposit/cross-chain");
    expect(JSON.parse(String(r.calls[0]!.init.body))).toEqual({ source_asset: "nep141:usdc", amount: "8000000" });
    await expect(ol(recorder(() => json({ intent_id: "i1" }))).requestConfidentialDeposit("nep141:usdc", "1")).rejects.toThrow(/unexpected/);
  });

  it("OutLayer: reads confidential holdings, dropping zero and malformed rows", async () => {
    const r = recorder(() => json({ balances: [{ token: "nep141:sol", balance: "15738716" }, { token: "nep141:usdc", balance: "0" }, { token: "x" }, { balance: "5" }], account_id: "acct" }));
    expect(await ol(r).confidentialHoldings()).toEqual({ "nep141:sol": "15738716" });
    expect(r.calls[0]!.url).toBe("https://api.outlayer.ai/wallet/v1/confidential/balance");
    await expect(ol(recorder(() => json({ hello: 1 }))).confidentialHoldings()).rejects.toThrow(/unexpected/);
  });

  it("OutLayer: shield and withdraw send the documented bodies to the right routes", async () => {
    const r = recorder(() => json({ request_id: "r2", status: "pending_approval" }));
    const c = ol(r);
    await c.shield("nep141:usdc", "1500000");
    await c.withdraw({ to: "owner.near", token: "nep141:usdc", amount: "1000000", chain: "near", venue: "confidential" });
    await c.withdraw({ to: "owner.near", token: "nep141:usdc", amount: "1000000", chain: "near", venue: "public" });
    expect(r.calls.map((x) => x.url.replace("https://api.outlayer.ai", ""))).toEqual(["/wallet/v1/confidential/shield", "/wallet/v1/confidential/withdraw", "/wallet/v1/intents/withdraw"]);
    expect(JSON.parse(String(r.calls[0]!.init.body))).toEqual({ token: "nep141:usdc", amount: "1500000" });
    expect(JSON.parse(String(r.calls[1]!.init.body))).toEqual({ to: "owner.near", amount: "1000000", token: "nep141:usdc", chain: "near" });
  });

  it("OutLayer: status carries the amounts the provider reports", async () => {
    const r = recorder(() => json({ status: "success", result: { amount: "1500000", amount_out: "15738716", swap_details: { amountIn: "1500000", amountOut: "15738716" } } }));
    expect((await ol(r).status("r1")).reported).toEqual({ amountIn: "1500000", amountOut: "15738716" });
    const none = recorder(() => json({ status: "pending_approval" }));
    expect((await ol(none).status("r1")).reported).toBeUndefined();
  });
});

describe("requestJson keeps what an error answer says besides its message", () => {
  it("code, retry seconds (body first, else Retry-After), limit and window; never headers", async () => {
    const { requestJson } = await import("./http");
    const body = { error: "operation_limit_reached", message: "limit reached: 1000 per day for custody:*", limit: 1000, window: "day", retry_after_seconds: 5400 };
    const f1 = async () => new Response(JSON.stringify(body), { status: 429, headers: { "retry-after": "10", authorization: "secret" } });
    const e1 = (await requestJson(f1, "https://x", {}, "OutLayer").catch((e: unknown) => e)) as IntentsApiError;
    expect(e1.detail).toEqual({ code: "operation_limit_reached", retryAfterSeconds: 5400, limit: 1000, window: "day" });
    expect(e1.message).not.toContain("secret");
    const f2 = async () => new Response(JSON.stringify({ error: "chain_unavailable", message: "m" }), { status: 503, headers: { "retry-after": "7" } });
    expect(((await requestJson(f2, "https://x", {}, "OutLayer").catch((e: unknown) => e)) as IntentsApiError).detail).toEqual({ code: "chain_unavailable", retryAfterSeconds: 7 });
    const f3 = async () => new Response("oops", { status: 500 });
    expect(((await requestJson(f3, "https://x", {}, "OutLayer").catch((e: unknown) => e)) as IntentsApiError).detail).toEqual({});
  });
});

describe("OutLayerCustody.addressPolicy reads the wallet's own address rule", () => {
  const read = (body: unknown) => new OutLayerCustody({ apiKey: "k", accountId: "a", fetch: async () => new Response(JSON.stringify(body)) }).addressPolicy();
  it("returns the whitelist as stored, 'none' when there is no policy or no address rule, and refuses to guess when the answer does not say", async () => {
    expect(await read({ policy: "stored", rules: { addresses: { mode: "whitelist", list: ["legalalienx.near", "w.near"] } } })).toEqual({ mode: "whitelist", list: ["legalalienx.near", "w.near"] });
    expect(await read({ policy: "none" })).toEqual({ mode: "none", list: [] });
    expect(await read({ policy: "stored", rules: {} })).toEqual({ mode: "none", list: [] });
    await expect(read({ version: 1 })).rejects.toThrow(/did not say what the policy is/);
  });
});
