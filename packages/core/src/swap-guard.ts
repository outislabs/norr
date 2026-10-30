/**
 * Hard rule: Norr never submits a swap without a minimum output amount.
 * Every swap request must pass through `requireSwapBounds` before it leaves the service.
 */

export interface SwapBounds {
  tokenIn: string;
  tokenOut: string;
  /** Smallest-unit decimal string. */
  amountIn: string;
  /** Smallest-unit decimal string, greater than zero. */
  minAmountOut: string;
}

const POSITIVE_INT = /^[1-9]\d*$/;

/** Throws unless the swap names both tokens and carries a positive `amountIn` and `minAmountOut`. */
export function requireSwapBounds<T extends Partial<SwapBounds>>(r: T): T & SwapBounds {
  if (!r.tokenIn || !r.tokenOut) throw new Error("swap refused: tokenIn and tokenOut are required");
  if (r.tokenIn === r.tokenOut) throw new Error("swap refused: tokenIn and tokenOut are the same");
  if (!r.amountIn || !POSITIVE_INT.test(r.amountIn)) throw new Error("swap refused: amountIn must be a positive integer string");
  if (!r.minAmountOut || !POSITIVE_INT.test(r.minAmountOut)) {
    throw new Error("swap refused: minAmountOut is required and must be a positive integer string");
  }
  return r as T & SwapBounds;
}
