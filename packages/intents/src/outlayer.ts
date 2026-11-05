import { requireSwapBounds, type SwapBounds } from "@norr/core";
import { obj, requestJson, str, type FetchLike } from "./http";
import type { Custody, CustodyApproval, DepositRequest, SwapState, SwapStatus, Venue, WithdrawParams } from "./types";

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
 * Known (docs/FINDINGS.md): its swap endpoints accept `min_amount_out` but do not enforce it,
 * and the gateway, not its TEE, builds the route, so callers must verify after execution.
 * The confidential layer cannot be audited independently (1Click's status endpoint does not know it).
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

  private post(path: string, body: unknown, label: string): Promise<unknown> {
    return requestJson(this.f, `${this.baseUrl}${path}`, { method: "POST", headers: this.headers, body: JSON.stringify(body) }, label);
  }

  private started(res: Record<string, unknown>): SwapStatus {
    const requestId = str(res.request_id);
    if (!requestId) return { state: "failed", requestId: "", detail: "OutLayer returned no request id" };
    return { state: mapState(str(res.status)), requestId, requestHash: str(res.request_hash) };
  }

  async swap(bounds: SwapBounds, venue: Venue = "public"): Promise<SwapStatus> {
    // Hard rule: no swap leaves without a minimum output, even if a caller forgot the check.
    const b = requireSwapBounds(bounds);
    const path = venue === "confidential" ? "/wallet/v1/confidential/swap" : "/wallet/v1/intents/swap";
    const res = obj(await this.post(path, { token_in: b.tokenIn, token_out: b.tokenOut, amount_in: b.amountIn, min_amount_out: b.minAmountOut }, `OutLayer ${venue} swap`));
    return this.started(res);
  }

  /** GET /wallet/v1/pending_approvals: the approvals waiting on this wallet, listed to the wallet's own key. */
  async pendingApprovals(): Promise<CustodyApproval[]> {
    const res = obj(await requestJson(this.f, `${this.baseUrl}/wallet/v1/pending_approvals`, { headers: this.headers }, "OutLayer pending approvals"));
    const rows = Array.isArray(res.approvals) ? res.approvals : [];
    return rows.flatMap((r) => {
      const a = obj(r);
      const approvalId = str(a.approval_id);
      return approvalId ? [{ approvalId, requestId: str(a.request_id) ?? null, type: str(a.type) ?? "unknown", expiresAt: str(a.expires_at) ?? "" }] : [];
    });
  }

  /** GET /wallet/v1/policy, read with the wallet's key: is there an approval rule, and are confidential ops exempt? */
  async approvalMode(): Promise<"owner" | "autonomous" | "none"> {
    const r = obj(await requestJson(this.f, `${this.baseUrl}/wallet/v1/policy`, { headers: this.headers }, "OutLayer policy"));
    if (r.policy === "none") return "none";
    const a = obj(r.approval);
    const required = typeof a.threshold === "number" ? a.threshold : Number(obj(a.threshold).required ?? 0);
    if (!(required > 0) || !Array.isArray(a.approvers) || a.approvers.length === 0) return "none";
    const excluded = Array.isArray(a.excluded_types) ? a.excluded_types : [];
    return excluded.includes("confidential") ? "autonomous" : "owner";
  }

  async status(requestId: string): Promise<SwapStatus> {
    const res = obj(
      await requestJson(this.f, `${this.baseUrl}/wallet/v1/requests/${encodeURIComponent(requestId)}`, { headers: this.headers }, "OutLayer request"),
    );
    const result = obj(res.result);
    const details = obj(result.swap_details);
    const state = mapState(str(res.status));
    const amountIn = str(details.amountIn) ?? str(result.amount);
    const amountOut = str(details.amountOut) ?? str(result.amount_out);
    return {
      state,
      requestId,
      depositAddress: str(result.deposit_address),
      detail: state === "failed" ? str(result.error) ?? str(res.status) : undefined,
      reported: amountIn !== undefined || amountOut !== undefined ? { amountIn, amountOut } : undefined,
    };
  }

  async confidentialHoldings(): Promise<Record<string, string>> {
    const res = obj(await requestJson(this.f, `${this.baseUrl}/wallet/v1/confidential/balance`, { headers: this.headers }, "OutLayer confidential balance"));
    const out: Record<string, string> = {};
    if (!Array.isArray(res.balances)) throw new Error("OutLayer confidential balance: unexpected response");
    for (const row of res.balances) {
      const r = obj(row);
      const token = str(r.token);
      const balance = str(r.balance);
      if (token && balance && balance !== "0") out[token] = balance;
    }
    return out;
  }

  async shield(token: string, amount: string): Promise<SwapStatus> {
    return this.started(obj(await this.post("/wallet/v1/confidential/shield", { token, amount }, "OutLayer shield")));
  }

  async requestConfidentialDeposit(token: string, amount: string): Promise<DepositRequest> {
    const res = obj(await this.post("/wallet/v1/confidential/deposit/cross-chain", { source_asset: token, amount }, "OutLayer confidential deposit address"));
    const depositAddress = str(res.deposit_address);
    const intentId = str(res.intent_id);
    if (!depositAddress || !intentId) throw new Error("OutLayer confidential deposit address: unexpected response");
    return { intentId, depositAddress, amount: str(res.amount) ?? amount, minAmountOut: str(res.min_amount_out) ?? amount, expiresAt: str(res.expires_at) };
  }

  async withdraw(w: WithdrawParams): Promise<SwapStatus> {
    const path = w.venue === "confidential" ? "/wallet/v1/confidential/withdraw" : "/wallet/v1/intents/withdraw";
    return this.started(obj(await this.post(path, { to: w.to, amount: w.amount, token: w.token, chain: w.chain }, `OutLayer ${w.venue} withdraw`)));
  }
}
