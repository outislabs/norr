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
