import { IntentsApiError } from "@norr/intents";

/**
 * A failure from an upstream service (1Click, the custody provider, NEAR RPC, GoPlus) as one plain sentence for the
 * owner: which service, what it answered, and what to do. Upstream messages carry the server's text but never request
 * headers (packages/intents/src/http.ts), so they hold no keys and can be shown.
 */
export function upstreamReason(e: unknown, fallbackService: string): string {
  const raw = e instanceof Error ? e.message : String(e);
  // "1Click deposit quote: Quoting for this pair is not available" → service "1Click deposit quote", text after it.
  const m = /^([^:]{3,60}):\s*(.*)$/s.exec(raw);
  const service = m ? m[1]! : fallbackService;
  const said = (m ? m[2]! : raw).trim().slice(0, 240);
  const status = e instanceof IntentsApiError ? e.status : undefined;
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network|socket/i.test(raw) || status === 0) return `${service}: could not be reached (${said}). Try again shortly.`;
  if (status === 429 || /rate.?limit|too many requests/i.test(said)) return `${service} is limiting requests right now (HTTP 429). Wait a minute and try again.`;
  if (/not allowed by policy|policy_denied|not in whitelist/i.test(said)) return `The vault's custody policy refused this (the custody provider answered "${said}").`;
  if (status !== undefined && status >= 500) return `${service} failed on its side (HTTP ${status}: "${said}"). Try again shortly.`;
  return `${service} refused it${status ? ` (HTTP ${status})` : ""}: "${said}".`;
}

/** Why a balance read failed, in the words the owner or agent should see, plus the machine fields for a program. */
export interface BalanceFailure {
  /** OutLayer's code when it sent one (`operation_limit_reached`, `chain_unavailable`, ...), else a Norr label. */
  code: string;
  /** Who failed: the custody provider, the NEAR RPC, or Norr itself. */
  source: "custody" | "chain" | "norr";
  reason: string;
  /** Seconds until a retry is worth it, when the upstream said. */
  retryAfterSeconds?: number;
  /** When that is, as an ISO time (UTC). */
  retryAt?: string;
}

const utc = (ms: number, now: number): string => {
  const d = new Date(ms);
  const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
  return d.getUTCDate() === new Date(now).getUTCDate() ? hm : `${d.toISOString().slice(0, 10)} ${hm}`;
};
const span = (s: number): string => (s < 90 ? `${s} seconds` : s < 5400 ? `${Math.round(s / 60)} minutes` : `${(s / 3600).toFixed(1).replace(/\.0$/, "")} hours`);

/**
 * Turns a failed balance read into the real reason. The vague "balances unavailable" hid whether OutLayer's operation
 * limit, an OutLayer or NEAR outage, a rejected key or a fault in Norr itself was behind it. Unknown failures are named
 * as unknown, with the upstream's own words (which carry no keys or balances), never guessed at.
 * `now` is only used to turn "retry in N seconds" into a clock time.
 */
export function balanceFailure(e: unknown, now: number): BalanceFailure {
  const raw = e instanceof Error ? e.message : String(e);
  const status = e instanceof IntentsApiError ? e.status : undefined;
  const d = e instanceof IntentsApiError ? e.detail : {};
  const code = d.code;
  const wait = d.retryAfterSeconds;
  const when = wait !== undefined ? { retryAfterSeconds: wait, retryAt: new Date(now + wait * 1000).toISOString() } : {};
  const retryText = wait !== undefined ? ` Retry in about ${span(wait)} (${utc(now + wait * 1000, now)}).` : "";
  const fromChain = /NEAR RPC|rpc|nearblocks|fastnear/i.test(raw) && !/OutLayer/i.test(raw);
  const source: BalanceFailure["source"] = fromChain ? "chain" : e instanceof IntentsApiError || /fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|timeout|socket/i.test(raw) ? "custody" : "norr";
  const out = (c: string, s: BalanceFailure["source"], reason: string): BalanceFailure => ({ code: c, source: s, reason, ...when });

  if (status === 429 && (code === "operation_limit_reached" || /limit reached/i.test(raw))) {
    const ceiling = d.limit !== undefined ? `${d.limit} custody operations per ${d.window ?? "day"}` : "its custody operation limit";
    const clears = wait !== undefined ? retryText : " OutLayer did not say when it clears; the count is over a rolling 24 hours, so it frees up gradually within a day.";
    return out("operation_limit_reached", "custody", `OutLayer's operation limit for this vault's wallet is reached (${ceiling}).${clears} Balance reads do not count toward it by OutLayer's spec, so something else (trades, dry-runs, approvals) used it up; the vault's money is untouched.`);
  }
  if (status === 429) return out(code ?? "rate_limited", "custody", `OutLayer is rate-limiting requests from Norr right now (HTTP 429${code ? `, ${code}` : ""}).${retryText || " Wait a minute and try again."}`);
  if (status === 401 || status === 403) return out(code ?? "key_rejected", "custody", `OutLayer rejected the vault's wallet key (HTTP ${status}). The vault needs the owner's attention; nothing was moved.`);
  if (code === "confidential_jwt_expired") return out(code, "custody", `OutLayer could not refresh its login to the private (confidential) balance service.${retryText || " Try again shortly."}`);
  if (code === "chain_unavailable") return out(code, "custody", `OutLayer could not read the chain this second.${retryText || " Try again shortly."}`);
  if (code === "keystore_error") return out(code, "custody", `OutLayer's key service was unreachable.${retryText || " Try again shortly."}`);
  if (code === "upstream_unavailable" || code === "route_unavailable") return out(code, "custody", `OutLayer's own backend is not answering (${code}).${retryText || " Try again shortly."}`);
  if (code === "service_unavailable") return out(code, "custody", "OutLayer reports that confidential balances are not enabled on its deployment. This will not clear by waiting.");
  if (status !== undefined && status >= 500) return out(code ?? `http_${status}`, fromChain ? "chain" : "custody", `${fromChain ? "The NEAR RPC" : "OutLayer"} failed on its side (HTTP ${status}).${retryText || " Try again shortly."}`);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network|socket|timeout/i.test(raw) || status === 0) return out("unreachable", fromChain ? "chain" : "custody", `${fromChain ? "The NEAR RPC" : "OutLayer"} could not be reached (${raw.slice(0, 160)}). Try again shortly.`);
  if (e instanceof IntentsApiError) return out(code ?? `http_${status}`, source, `${raw.slice(0, 240)}.`);
  // Not an upstream failure: a fault in Norr's own code or an answer it could not read. Say so, with the message.
  return out("norr_error", "norr", `Norr could not read the balances: ${raw.slice(0, 200)}. This is a fault on Norr's side, not the vault's money or OutLayer's limit.`);
}

/** The most recent balance-read failure and when it happened, kept in memory only for the operator view. */
export class BalanceHealth {
  private last: { at: number; failure: BalanceFailure } | null = null;
  private lastOkAt: number | null = null;
  failed(failure: BalanceFailure, at: number): void {
    this.last = { at, failure };
  }
  ok(at: number): void {
    this.lastOkAt = at;
  }
  /** The latest failure, or null when none happened since the last good read. */
  current(): { at: number; failure: BalanceFailure } | null {
    return this.last && (this.lastOkAt === null || this.lastOkAt < this.last.at) ? this.last : null;
  }
}
