import type { Mismatch, VerifyResult } from "./verify";

/** Token id to smallest-unit amount, as held in one layer of a vault. */
export type Holdings = Record<string, string>;

export interface ConfidentialIntent {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  minAmountOut: string;
}

/** What the custody provider said it did, if it said. */
export interface ReportedAmounts {
  amountIn?: string;
  amountOut?: string;
}

const big = (v: string | undefined): bigint | null => (v !== undefined && /^\d+$/.test(v) ? BigInt(v) : null);
const held = (h: Holdings, k: string): bigint | null => (h[k] === undefined ? 0n : big(h[k]));

/**
 * Check a confidential swap from balances read before and after it, plus the provider's own report.
 *
 * This is weaker than the public-path check. There is no independent source for the confidential
 * layer (1Click's status endpoint does not know these swaps), so both the balances and the report
 * come from the custody provider. What it still catches: a different token received, too little
 * received, more spent than agreed, a report that disagrees with the balances, and any other asset
 * quietly shrinking. It cannot catch a provider that lies consistently.
 */
export function verifyConfidentialSwap(i: ConfidentialIntent, before: Holdings, after: Holdings, reported?: ReportedAmounts): VerifyResult {
  const mismatches: Mismatch[] = [];
  const bad = (field: Mismatch["field"], intended: string, executed: string) => mismatches.push({ field, intended, executed });

  const inBefore = held(before, i.tokenIn);
  const inAfter = held(after, i.tokenIn);
  const outBefore = held(before, i.tokenOut);
  const outAfter = held(after, i.tokenOut);
  const amountIn = big(i.amountIn);
  const minOut = big(i.minAmountOut);

  if (inBefore === null || inAfter === null || outBefore === null || outAfter === null || amountIn === null || minOut === null) {
    return { ok: false, action: "trip_kill_switch", mismatches: [{ field: "amountOut", intended: "readable balances", executed: "unreadable" }] };
  }

  const spent = inBefore - inAfter;
  const received = outAfter - outBefore;
  if (spent <= 0n || spent > amountIn) bad("amountIn", `1..${i.amountIn}`, spent.toString());
  if (received < minOut) bad("amountOut", `>= ${i.minAmountOut}`, received.toString());

  const rIn = big(reported?.amountIn);
  const rOut = big(reported?.amountOut);
  if ((reported?.amountIn !== undefined && rIn !== spent) || (reported?.amountOut !== undefined && rOut !== received)) {
    bad("reportedAmount", `${spent}/${received} (balances)`, `${reported?.amountIn ?? "-"}/${reported?.amountOut ?? "-"} (reported)`);
  }

  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (k === i.tokenIn || k === i.tokenOut) continue;
    const b = held(before, k);
    const a = held(after, k);
    if (b === null || a === null || a < b) bad("otherAssets", `${k} unchanged or higher`, `${b} to ${a}`);
  }

  return mismatches.length === 0 ? { ok: true } : { ok: false, mismatches, action: "trip_kill_switch" };
}
