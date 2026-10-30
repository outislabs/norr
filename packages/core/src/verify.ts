/**
 * Post-trade check against Norr's own quote.
 *
 * OutLayer's gateway builds the route and deposit address and its TEE does not re-check the
 * token or amount (docs/FINDINGS.md). So after each execution Norr compares what happened
 * with what its own 1Click quote said would happen, and trips the kill switch on any mismatch.
 */

/** From Norr's own 1Click quote, requested before executing. Amounts are smallest-unit strings. */
export interface IntendedSwap {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  minAmountOut: string;
  recipient: string;
}

/** From the executed result (status endpoint / ledger). */
export interface ExecutedSwap {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  recipient: string;
}

export interface Mismatch {
  field: "tokenIn" | "tokenOut" | "amountIn" | "amountOut" | "recipient" | "reportedAmount" | "otherAssets";
  intended: string;
  executed: string;
}

export type VerifyResult = { ok: true } | { ok: false; mismatches: Mismatch[]; action: "trip_kill_switch" };

const big = (v: string): bigint | null => (/^\d+$/.test(v) ? BigInt(v) : null);

/** Spending less than intended is fine; spending more, receiving less than the minimum, or any token/recipient change is not. */
export function verifyExecution(intended: IntendedSwap, executed: ExecutedSwap): VerifyResult {
  const mismatches: Mismatch[] = [];

  if (executed.tokenIn !== intended.tokenIn) mismatches.push({ field: "tokenIn", intended: intended.tokenIn, executed: executed.tokenIn });
  if (executed.tokenOut !== intended.tokenOut) mismatches.push({ field: "tokenOut", intended: intended.tokenOut, executed: executed.tokenOut });
  if (executed.recipient.toLowerCase() !== intended.recipient.toLowerCase()) {
    mismatches.push({ field: "recipient", intended: intended.recipient, executed: executed.recipient });
  }

  const inWant = big(intended.amountIn);
  const inGot = big(executed.amountIn);
  if (inWant === null || inGot === null || inGot > inWant) {
    mismatches.push({ field: "amountIn", intended: intended.amountIn, executed: executed.amountIn });
  }

  const outMin = big(intended.minAmountOut);
  const outGot = big(executed.amountOut);
  if (outMin === null || outGot === null || outGot < outMin) {
    mismatches.push({ field: "amountOut", intended: `>= ${intended.minAmountOut}`, executed: executed.amountOut });
  }

  return mismatches.length === 0 ? { ok: true } : { ok: false, mismatches, action: "trip_kill_switch" };
}
