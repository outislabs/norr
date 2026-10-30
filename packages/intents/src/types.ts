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

export type SwapState = "pending_approval" | "in_progress" | "success" | "failed";

export interface SwapStatus {
  state: SwapState;
  requestId: string;
  /** Set once the custody gateway has created the 1Click deposit address. */
  depositAddress?: string;
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
}

/** Independent view of what happened, from 1Click rather than the custody provider. Public layer only. */
export interface ExecutionAuditor {
  audit(depositAddress: string): Promise<ExecutedSwap | null>;
}

export class IntentsApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "IntentsApiError";
  }
}
