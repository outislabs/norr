import type { ExecutedSwap, SwapBounds } from "@norr/core";

/** Which layer a trade runs in: the public Intents layer, or the confidential layer. */
export type Venue = "public" | "confidential";

/** A 1Click quote reduced to what Norr uses. Amounts are smallest-unit strings. */
export interface Quote {
  amountIn: string;
  amountOut: string;
  /** The quote's own worst-case output. This is what Norr sends as `min_amount_out`. */
  minAmountOut: string;
  amountInUsd: number;
  amountOutUsd: number;
}

export interface QuoteParams {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  /** The vault's own Intents account. Quotes always pay and refund here. */
  recipient: string;
  /** Defaults to "public". "confidential" quotes use CONFIDENTIAL_INTENTS deposit, recipient and refund types. */
  venue?: Venue;
}

/** Norr's own price source. `null` means no liquidity. */
export interface Quoter {
  quote(p: QuoteParams): Promise<Quote | null>;
}

/** What the owner is funding: public USDC on NEAR into the vault's confidential balance. */
export interface DepositParams {
  /** What lands in the vault (USDC on NEAR). */
  token: string;
  /** What the owner sends, on its own chain (USDC on Base, ETH, SOL...). Defaults to `token`. */
  originAsset?: string;
  /** Smallest units of the origin asset the owner will send. */
  amount: string;
  /** Norr's own estimate of what should arrive, in `token` units, from the listed price. A quote far below it is refused. */
  expectedOut?: string;
  /** The vault's own Intents account: the confidential balance the money lands in. Always set by Norr, never by a caller. */
  recipient: string;
  /** Where 1Click returns the money if the deposit cannot complete: the owner's address on the origin chain. */
  refundTo: string;
}

export interface DepositOffer {
  /** The one-time address to send to, from 1Click's own quote. */
  depositAddress: string;
  amountIn: string;
  /** amountIn in the origin token's own decimals, as 1Click formats it ("0.0006"). */
  amountInFormatted?: string;
  amountOut: string;
  minAmountOut: string;
  /** When 1Click starts refunding an incomplete deposit. */
  deadline: string;
}

/** Norr's own source of deposit addresses, independent of the custody provider's policy. */
export interface DepositQuoter {
  requestDeposit(p: DepositParams): Promise<DepositOffer>;
}

export type SwapState = "pending_approval" | "in_progress" | "success" | "failed";

export interface SwapStatus {
  state: SwapState;
  requestId: string;
  /** Set once the custody gateway has created the 1Click deposit address. */
  depositAddress?: string;
  /** The custody provider's hash of the request, shown on its approval screen. Lets an owner match what Norr asked for. */
  requestHash?: string;
  /** Short reason for a failure, safe to log. */
  detail?: string;
  /** Amounts the custody provider says it moved. Not independent evidence. */
  reported?: { amountIn?: string; amountOut?: string };
}

export interface WithdrawParams {
  /** Destination account. Must be on the vault's custody whitelist. */
  to: string;
  token: string;
  amount: string;
  chain: string;
  /** Which layer the funds come out of. */
  venue: Venue;
}

/** One vault's custody wallet. The provider (OutLayer today) sits behind this. */
export interface Custody {
  /** The vault's Intents account id. */
  accountId(): Promise<string>;
  swap(bounds: SwapBounds, venue?: Venue): Promise<SwapStatus>;
  status(requestId: string): Promise<SwapStatus>;
  /** Balances held in the confidential layer: asset id to smallest units. */
  confidentialHoldings(): Promise<Record<string, string>>;
  /** Move funds from the public layer into the confidential layer. Public on-chain; owner-level action. */
  shield(token: string, amount: string): Promise<SwapStatus>;
  /** Send funds out to a whitelisted destination. Owner-level action: never exposed to agents. */
  withdraw(w: WithdrawParams): Promise<SwapStatus>;
  /**
   * Ask for a one-time address to which the owner sends `amount` of a public token; it settles into the
   * vault's confidential balance. Moves no funds by itself. Owner-level action: never exposed to agents.
   */
  requestConfidentialDeposit(token: string, amount: string): Promise<DepositRequest>;
  /**
   * The approvals waiting on this wallet (the provider's multisig). Lists only: approving needs the owner's own
   * signature, which the owner's browser sends to the provider directly; Norr never holds it.
   */
  pendingApprovals?(): Promise<CustodyApproval[]>;
  /** Whether swaps wait for the owner, from the custody provider's own policy: "owner" (approval needed), "autonomous"
   *  (confidential operations exempt), or "none" (no approval configured). */
  approvalMode?(): Promise<"owner" | "autonomous" | "none">;
}

/** One operation waiting for the owner's approval at the custody provider. */
export interface CustodyApproval {
  approvalId: string;
  /** The custody request it would release; Norr matches it to its own record by this id. */
  requestId: string | null;
  type: string;
  expiresAt: string;
}

/** A one-time confidential deposit address. The address always comes from the custody provider, never from a caller. */
export interface DepositRequest {
  intentId: string;
  depositAddress: string;
  /** Smallest units the owner is asked to send. */
  amount: string;
  /** The least that will be credited, in smallest units. */
  minAmountOut: string;
  /** The provider's own expiry, if it gave one. */
  expiresAt?: string;
}

/** Independent view of what happened, from 1Click rather than the custody provider. Public layer only. */
export interface ExecutionAuditor {
  audit(depositAddress: string): Promise<ExecutedSwap | null>;
}

/** What an upstream's error body said besides its message, when it said it (OutLayer sends a machine code and, for a reached limit, how long it lasts). */
export interface UpstreamErrorDetail {
  /** The upstream's machine code, e.g. OutLayer's `operation_limit_reached` or `chain_unavailable`. */
  code?: string;
  /** Seconds until the same request is worth repeating: the body's `retry_after_seconds`, else the `Retry-After` header. */
  retryAfterSeconds?: number;
  /** For a reached limit: the ceiling and the window it is counted over (`day`, ...). */
  limit?: number;
  window?: string;
}

export class IntentsApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail: UpstreamErrorDetail = {},
  ) {
    super(message);
    this.name = "IntentsApiError";
  }
}
