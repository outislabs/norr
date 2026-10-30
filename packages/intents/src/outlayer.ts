import { requireSwapBounds, type SwapBounds } from "@norr/core";
import { obj, requestJson, str, type FetchLike } from "./http";
import type { Custody, SwapState, SwapStatus } from "./types";

export interface OutLayerOptions {
  baseUrl?: string;
  /** The wallet's API key. Held by the Norr service only; never given to an agent. */
  apiKey: string;
  /** The wallet's Intents account (its implicit NEAR account id). */
  accountId: string;
  fetch?: FetchLike;
}

const FAILED = /fail|reject|denied|expired|cancel|revert/i;

/** Maps OutLayer's request status strings. Unknown states count as in progress, never as success. */
export function mapState(raw: string | undefined): SwapState {
  if (raw === "success") return "success";
  if (raw === "pending_approval") return "pending_approval";
  if (raw && FAILED.test(raw)) return "failed";
  return "in_progress";
}

/**
 * OutLayer Agent Custody for one vault. Limits are set by the owner in OutLayer's dashboard.
 * Known (docs/FINDINGS.md): its swap endpoint accepts `min_amount_out` but does not enforce it,
 * and the gateway, not its TEE, builds the route, so callers must verify after execution.
 */
export class OutLayerCustody implements Custody {
  private readonly baseUrl: string;
  private readonly f: FetchLike;
  private readonly headers: Record<string, string>;

  constructor(private readonly o: OutLayerOptions) {
    this.baseUrl = o.baseUrl ?? "https://api.outlayer.ai";
    this.f = o.fetch ?? ((url, init) => fetch(url, init));
    this.headers = { "content-type": "application/json", "user-agent": "norr/0.1", authorization: `Bearer ${o.apiKey}` };
  }

  async accountId(): Promise<string> {
    return this.o.accountId;
  }

  async swap(bounds: SwapBounds): Promise<SwapStatus> {
    // Hard rule: no swap leaves without a minimum output, even if a caller forgot the check.
    const b = requireSwapBounds(bounds);
    const res = obj(
      await requestJson(
        this.f,
        `${this.baseUrl}/wallet/v1/intents/swap`,
        { method: "POST", headers: this.headers, body: JSON.stringify({ token_in: b.tokenIn, token_out: b.tokenOut, amount_in: b.amountIn, min_amount_out: b.minAmountOut }) },
        "OutLayer swap",
      ),
    );
    const requestId = str(res.request_id);
    if (!requestId) return { state: "failed", requestId: "", detail: "OutLayer returned no request id" };
    return { state: mapState(str(res.status)), requestId };
  }

  async status(requestId: string): Promise<SwapStatus> {
    const res = obj(
      await requestJson(this.f, `${this.baseUrl}/wallet/v1/requests/${encodeURIComponent(requestId)}`, { headers: this.headers }, "OutLayer request"),
    );
    const result = obj(res.result);
    const state = mapState(str(res.status));
    return {
      state,
      requestId,
      depositAddress: str(result.deposit_address),
      detail: state === "failed" ? str(result.error) ?? str(res.status) : undefined,
    };
  }
}
