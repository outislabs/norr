import type { Decision, Policy } from "@norr/shared";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface Challenge { nonce: string; message: string; recipient: string; expiresAt: number }
export interface SessionInfo { token: string; accountId: string; expiresAt: number }
export interface VaultSummary {
  id: string;
  walletAccount: string;
  policy: Policy;
  paused: boolean;
  state: { spentTodayUsd: number; realizedLossTodayUsd: number; lastTradeAt: string | null };
}
export interface Holding { symbol: string; class: "crypto" | "equity"; amount: number; valueUsd: number; layer?: "public" | "confidential" }
export interface Portfolio { holdings: Holding[]; totalUsd: number; byClass: { crypto: number; equity: number } }
export interface ActivityItem { id: string; executed: { usd: number; realizedUsd: number | null } | null; at: string; side: "buy" | "sell"; asset: string; amountUsd: number; sealedReason: SealedReason | null; decision: Decision; note: string | null; pending: boolean }
export interface PendingItem {
  ledgerId: string;
  requestId: string;
  requestHash: string | null;
  venue: "public" | "confidential";
  sends: { symbol: string; amount: number | null };
  receivesAtLeast: { symbol: string; amount: number | null };
  recipient: string;
  check: string;
}
import type { SealedReason } from "./seal";
export interface FundingOffer { id: string; address: string; amountUsdc: number; asset: { symbol: string; chain: string; contract: string }; expiresAt: string }
export interface FundingStatus { state: "waiting" | "arrived" | "expired"; receivedUsdc: number; balanceUsdc: number; expiresAt: string; reportedBy: string }
export interface VerifyInfo { mode: "mock" | "live"; attested: boolean; note: string; commit: string | null; dirty?: boolean; source?: "env" | "git" | "unknown" }
export interface AuditItem { at: string; owner: string; action: string; vaultId?: string }

export interface ApiOptions {
  /** Base path of the Norr service, for example "/api" in development. */
  base: string;
  getToken: () => string | null;
  /** Called when the service says the session is no longer valid. */
  onUnauthorized: () => void;
  fetch?: typeof fetch;
}

/** Typed client for the owner API. The token travels only in the Authorization header. */
export function createApi(o: ApiOptions) {
  const f = o.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
  async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const token = o.getToken();
    let res: Response;
    try {
      res = await f(`${o.base}${path}`, {
        method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch {
      throw new ApiError(0, "Cannot reach the Norr service. Is it running?");
    }
    const body: unknown = await res.json().catch(() => null);
    if (res.status === 401 && token) o.onUnauthorized();
    if (!res.ok) {
      const b = body as { error?: string; issues?: string[] } | null;
      const detail = b?.issues?.length ? `: ${b.issues.join("; ")}` : "";
      throw new ApiError(res.status, `${b?.error ?? `Request failed (${res.status})`}${detail}`);
    }
    return body as T;
  }
  return {
    health: () => call<{ ok: boolean; mock: boolean; mockOwner?: string }>("/health"),
    challenge: () => call<Challenge>("/owner/v1/challenge"),
    login: (b: { accountId: string; publicKey: string; signature: string; nonce: string }) => call<SessionInfo>("/owner/v1/login", { body: b }),
    logout: () => call<{ ok: boolean }>("/owner/v1/logout", { body: {} }),
    me: () => call<{ accountId: string; vaults: number; mock: boolean }>("/owner/v1/me"),
    vaults: () => call<{ vaults: VaultSummary[] }>("/owner/v1/vaults"),
    vault: (id: string) => call<VaultSummary & { portfolio: Portfolio | null }>(`/owner/v1/vaults/${encodeURIComponent(id)}`),
    setPolicy: (id: string, p: Policy) => call<{ policy: Policy }>(`/owner/v1/vaults/${encodeURIComponent(id)}/policy`, { method: "PUT", body: p }),
    pause: (id: string) => call<{ paused: boolean }>(`/owner/v1/vaults/${encodeURIComponent(id)}/pause`, { body: {} }),
    resume: (id: string) => call<{ paused: boolean }>(`/owner/v1/vaults/${encodeURIComponent(id)}/resume`, { body: {} }),
    pauseAll: () => call<{ paused: string[] }>("/owner/v1/pause-all", { body: {} }),
    activity: (id: string) => call<{ activity: ActivityItem[] }>(`/owner/v1/vaults/${encodeURIComponent(id)}/activity`),
    pending: (id: string) => call<{ pending: PendingItem[] }>(`/owner/v1/vaults/${encodeURIComponent(id)}/pending`),
    issueToken: (id: string) => call<{ token: string; note: string }>(`/owner/v1/vaults/${encodeURIComponent(id)}/tokens`, { body: {} }),
    revokeTokens: (id: string) => call<{ revoked: boolean }>(`/owner/v1/vaults/${encodeURIComponent(id)}/tokens`, { method: "DELETE" }),
    requestFunding: (id: string, amountUsdc: number) => call<FundingOffer>(`/owner/v1/vaults/${encodeURIComponent(id)}/funding`, { body: { amountUsdc } }),
    fundingStatus: (id: string, fid: string) => call<FundingStatus>(`/owner/v1/vaults/${encodeURIComponent(id)}/funding/${encodeURIComponent(fid)}`),
    sealKey: () => call<{ publicKey: string | null }>("/owner/v1/seal-key"),
    enrollSealKey: (publicKey: string) => call<{ publicKey: string; resealed: number }>("/owner/v1/seal-key", { method: "PUT", body: { publicKey } }),
    audit: () => call<{ audit: AuditItem[] }>("/owner/v1/audit"),
    verify: () => call<VerifyInfo>("/owner/v1/verify"),
  };
}
export type Api = ReturnType<typeof createApi>;
