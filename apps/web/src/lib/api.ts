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
import type { AppInfo, AttestationEvidence } from "@norr/shared";
import type { SealedReason } from "./seal";
/** A token and chain the vault can be funded from; whatever is sent arrives as USDC in the vault's confidential balance. */
export interface FundingSource { assetId: string; symbol: string; chain: string; chainName: string; family: "near" | "evm" | "solana"; evmChainId?: number; decimals: number; contract: string | null; priceUsd: number }
export interface FundingOffer {
  id: string;
  address: string;
  /** The USD amount asked for (older services: also the USDC amount). */
  amountUsdc: number;
  amountUsd?: number;
  minArrivingUsdc?: number;
  /** What exactly to send, and on which chain. Absent from older services (USDC on NEAR). */
  send?: { amount: string; units: string; symbol: string; chain: string; chainName: string; family: "near" | "evm" | "solana"; evmChainId?: number; contract: string | null; decimals: number };
  asset: { symbol: string; chain: string; contract: string };
  refundTo?: string;
  expiresAt: string;
}
export interface FundingStatus { state: "waiting" | "arrived" | "expired"; receivedUsdc: number; balanceUsdc: number; expiresAt: string; reportedBy: string; independentlyConfirmed?: boolean }
export interface VerifyInfo { mode: "mock" | "live"; attested: boolean; note: string; commit: string | null; dirty?: boolean; source?: "env" | "git" | "unknown" }
export interface ServiceStatus { mock: boolean; pricing: "ready" | "retrying"; shield: "ok" | "incidents" | "unavailable"; enclave: boolean; vaults: { total: number; paused: number } }
export interface ValuePoint { t: number; totalUsd: number; cryptoUsd: number; equityUsd: number }
export interface AssetPnl { asset: string; trades: number; boughtUsd: number; soldUsd: number; realizedUsd: number; qtyHeld: number; costBasisUsd: number; avgCostUsd: number | null; priceUsd: number | null; marketValueUsd: number | null; unrealizedUsd: number | null }
export interface VaultPnl { since: string | null; scope: string; assets: AssetPnl[]; totals: { boughtUsd: number; soldUsd: number; realizedUsd: number; unrealizedUsd: number; totalUsd: number; costBasisUsd: number }; unpriced: string[] }
export interface AuditItem { at: string; owner: string; action: string; vaultId?: string }

export interface ApiOptions {
  /** Base path of the Norr service, for example "/api" in development. */
  base: string;
  getToken: () => string | null;
  /** Called when the service says the session is no longer valid. */
  onUnauthorized: () => void;
  fetch?: typeof fetch;
}

/** What a failed connection says. The demo service runs on demand, so being unreachable is a normal state, not an error. */
export const OFFLINE_MESSAGE = "Norr is offline right now.";

/** True when an error (or a useAsync error string) means the service could not be reached at all. */
export const isOffline = (e: unknown): boolean => e === OFFLINE_MESSAGE || (e instanceof ApiError && e.status === 0);

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
      throw new ApiError(0, OFFLINE_MESSAGE);
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
    fundingSources: () => call<{ sources: FundingSource[] }>("/owner/v1/funding/sources"),
    requestFunding: (id: string, r: { amountUsd: number; source?: string; refundTo?: string }) => call<FundingOffer>(`/owner/v1/vaults/${encodeURIComponent(id)}/funding`, { body: { amountUsd: r.amountUsd, amountUsdc: r.amountUsd /* services before 2026-11-03 read this name */, ...(r.source ? { source: r.source } : {}), ...(r.refundTo ? { refundTo: r.refundTo } : {}) } }),
    fundingStatus: (id: string, fid: string) => call<FundingStatus>(`/owner/v1/vaults/${encodeURIComponent(id)}/funding/${encodeURIComponent(fid)}`),
    sealKey: () => call<{ publicKey: string | null }>("/owner/v1/seal-key"),
    enrollSealKey: (publicKey: string) => call<{ publicKey: string; resealed: number }>("/owner/v1/seal-key", { method: "PUT", body: { publicKey } }),
    /** Public endpoints: the service proves what it is to anyone, so no session is needed. */
    attestation: (nonceHex: string) => call<AttestationEvidence & { attested: true; commit: string | null }>(`/attestation?nonce=${nonceHex}`),
    appInfo: () => call<AppInfo & { attested: true }>("/info"),
    status: () => call<ServiceStatus>("/owner/v1/status"),
    pnl: (id: string) => call<VaultPnl>(`/owner/v1/vaults/${encodeURIComponent(id)}/pnl`),
    history: (id: string) => call<{ points: ValuePoint[] }>(`/owner/v1/vaults/${encodeURIComponent(id)}/history`),
    audit: () => call<{ audit: AuditItem[] }>("/owner/v1/audit"),
    verify: () => call<VerifyInfo>("/owner/v1/verify"),
  };
}
export type Api = ReturnType<typeof createApi>;
