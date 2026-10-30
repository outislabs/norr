import type { ExecutedSwap, OneClickToken } from "@norr/core";
import { obj, requestJson, str, type FetchLike } from "./http";
import { IntentsApiError, type ExecutionAuditor, type Quote, type QuoteParams, type Quoter } from "./types";

export interface OneClickOptions {
  baseUrl?: string;
  apiKey?: string;
  fetch?: FetchLike;
  now?: () => number;
  slippageBps?: number;
}

/** 1Click client: token list, dry quotes (Norr's own price source) and the independent status check. */
export class OneClick implements Quoter, ExecutionAuditor {
  private readonly baseUrl: string;
  private readonly f: FetchLike;
  private readonly now: () => number;
  private readonly slippageBps: number;
  private readonly headers: Record<string, string>;

  constructor(o: OneClickOptions = {}) {
    this.baseUrl = o.baseUrl ?? "https://1click.chaindefuser.com";
    this.f = o.fetch ?? ((url, init) => fetch(url, init));
    this.now = o.now ?? Date.now;
    this.slippageBps = o.slippageBps ?? 100;
    // 1Click sits behind Cloudflare, which rejects some default user agents.
    this.headers = { "content-type": "application/json", "user-agent": "norr/0.1", ...(o.apiKey ? { "x-api-key": o.apiKey } : {}) };
  }

  /** Plain list, or the list with Ondo tokens added (`ondoTokens=true`). */
  async tokens(withOndo = false): Promise<OneClickToken[]> {
    const url = `${this.baseUrl}/v0/tokens${withOndo ? "?ondoTokens=true" : ""}`;
    const body = await requestJson(this.f, url, { headers: this.headers }, "1Click tokens");
    if (!Array.isArray(body)) throw new IntentsApiError(502, "1Click tokens: unexpected response");
    return body.map((t) => {
      const o = obj(t);
      return {
        assetId: String(o.assetId),
        decimals: Number(o.decimals),
        blockchain: String(o.blockchain),
        symbol: String(o.symbol),
        price: typeof o.price === "number" ? o.price : undefined,
        coingeckoId: str(o.coingeckoId),
        contractAddress: str(o.contractAddress),
      };
    });
  }

  async quote(p: QuoteParams): Promise<Quote | null> {
    const body = {
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: this.slippageBps,
      originAsset: p.tokenIn,
      depositType: "INTENTS",
      destinationAsset: p.tokenOut,
      amount: p.amountIn,
      recipient: p.recipient,
      recipientType: "INTENTS",
      refundTo: p.recipient,
      refundType: "INTENTS",
      deadline: new Date(this.now() + 3_600_000).toISOString(),
    };
    try {
      const res = obj(await requestJson(this.f, `${this.baseUrl}/v0/quote`, { method: "POST", headers: this.headers, body: JSON.stringify(body) }, "1Click quote"));
      const q = obj(res.quote);
      if (!str(q.amountOut) || !str(q.minAmountOut)) throw new IntentsApiError(502, "1Click quote: unexpected response");
      return {
        amountIn: String(q.amountIn),
        amountOut: String(q.amountOut),
        minAmountOut: String(q.minAmountOut),
        amountInUsd: Number(q.amountInUsd),
        amountOutUsd: Number(q.amountOutUsd),
      };
    } catch (e) {
      if (e instanceof IntentsApiError && e.status === 400 && /no liquidity/i.test(e.message)) return null;
      throw e;
    }
  }

  /** What 1Click says happened for a deposit address. Null unless the swap succeeded. */
  async audit(depositAddress: string): Promise<ExecutedSwap | null> {
    const url = `${this.baseUrl}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`;
    const res = obj(await requestJson(this.f, url, { headers: this.headers }, "1Click status"));
    if (res.status !== "SUCCESS") return null;
    const req = obj(obj(res.quoteResponse).quoteRequest);
    const sd = obj(res.swapDetails);
    const tokenIn = str(req.originAsset);
    const tokenOut = str(req.destinationAsset);
    const recipient = str(req.recipient);
    const amountIn = str(sd.amountIn);
    const amountOut = str(sd.amountOut);
    if (!tokenIn || !tokenOut || !recipient || !amountIn || !amountOut) return null;
    return { tokenIn, tokenOut, amountIn, amountOut, recipient };
  }
}
