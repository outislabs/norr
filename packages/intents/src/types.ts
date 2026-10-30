import type { ExecutedSwap, SwapBounds } from "@norr/core";

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
}

/** One vault's custody wallet. The provider (OutLayer today) sits behind this. */
export interface Custody {
  /** The vault's Intents account id. */
  accountId(): Promise<string>;
  swap(bounds: SwapBounds): Promise<SwapStatus>;
  status(requestId: string): Promise<SwapStatus>;
}

/** Independent view of what happened, from 1Click rather than the custody provider. */
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
