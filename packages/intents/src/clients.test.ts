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
    expect(tokens).toEqual([{ assetId: "nep141:a", decimals: 6, blockchain: "near", symbol: "USDC", price: 1, coingeckoId: "usd-coin" }]);
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
