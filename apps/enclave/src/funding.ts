/**
 * Confidential deposit requests the owner has asked for. Kept in memory: losing one on a restart only means
 * asking for a new address (an address already handed out still works, and the money still arrives).
 */
export interface FundingRequest {
  id: string;
  vaultId: string;
  token: string;
  /** Smallest units the owner was asked to send. */
  amount: string;
  /** The least that counts as arrived. */
  minAmount: string;
  address: string;
  intentId: string;
  /** Where the address came from: Norr's own 1Click quote, or the custody provider. */
  source: "1click" | "custody";
  /** The vault's confidential balance of the token when the address was requested. */
  baseline: string;
  requestedAt: number;
  /** Norr's conservative deadline for sending, not the provider's (which is far later). */
  expiresAt: number;
}

/** How long the owner is told to take. Short on purpose: a stale quote is not worth a retry loop. */
export const FUNDING_WINDOW_MS = 30 * 60_000;
/** Open requests per vault, so the dashboard cannot be used to spam the custody provider. */
export const MAX_OPEN_FUNDING = 3;

export class FundingTracker {
  private readonly byId = new Map<string, FundingRequest>();

  add(r: FundingRequest): void {
    this.byId.set(r.id, r);
  }

  get(id: string): FundingRequest | undefined {
    return this.byId.get(id);
  }

  /** Requests whose window has not passed yet. */
  open(vaultId: string, nowMs: number): FundingRequest[] {
    return [...this.byId.values()].filter((r) => r.vaultId === vaultId && r.expiresAt > nowMs);
  }
}

export type FundingState = "waiting" | "arrived" | "expired";

/**
 * Has the money landed? Inferred from the vault's confidential balance against what it was when the address was
 * requested. The balance is the custody provider's report; a trade in the meantime could blur it, so
 * the result is a best reading, not a receipt.
 */
export function fundingState(r: FundingRequest, currentBalance: string, nowMs: number): { state: FundingState; received: string } {
  const delta = BigInt(currentBalance) - BigInt(r.baseline);
  const received = delta > 0n ? delta : 0n;
  if (received >= BigInt(r.minAmount)) return { state: "arrived", received: received.toString() };
  return { state: nowMs >= r.expiresAt ? "expired" : "waiting", received: received.toString() };
}
