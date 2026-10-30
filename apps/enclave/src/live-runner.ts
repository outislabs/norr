import { unitsToNumber } from "@norr/core";
import type { Decision, TradeRequest } from "@norr/shared";
import { planTrade, reconcile, executeTrade, type TradeDeps } from "./trade";

export interface RunArgs {
  vaultId: string;
  side: "buy" | "sell";
  asset: string;
  amountUsd: number;
  reason: string;
  /** Without this the run is a dry run: it plans and prints, and sends nothing. */
  confirmMainnet: boolean;
  /** Hard ceiling for this run, on top of the vault's own limits. */
  maxUsd: number;
  /** How long to wait for the owner's approval before giving up (the swap stays pending). */
  waitMinutes: number;
}

export interface RunResult {
  exitCode: 0 | 1 | 2 | 3;
  decision?: Decision;
}

/**
 * One manually driven live trade. Dry by default; executes only with confirmMainnet. It never
 * loops, retries a swap, or places more than one trade per call.
 */
export async function runLiveTrade(deps: TradeDeps, a: RunArgs, log: (line: string) => void): Promise<RunResult> {
  const vault = deps.vaults.get(a.vaultId);
  if (!vault) {
    log(`No such vault: ${a.vaultId}`);
    return { exitCode: 1 };
  }
  if (!(a.amountUsd > 0) || a.amountUsd > a.maxUsd) {
    log(`Refusing: $${a.amountUsd} is outside the per-run cap of $${a.maxUsd} (NORR_LIVE_MAX_USD).`);
    return { exitCode: 1 };
  }

  const request: TradeRequest = { vaultId: a.vaultId, side: a.side, asset: a.asset, amountUsd: a.amountUsd, reason: a.reason };
  const planned = await planTrade(deps, vault, request);
  log(`Vault ${a.vaultId} | wallet ${vault.walletAccount.slice(0, 8)}…${vault.walletAccount.slice(-4)} | ${a.side.toUpperCase()} $${a.amountUsd} ${a.asset}`);

  if ("decision" in planned) {
    log(`WOULD NOT RUN. ${JSON.stringify(planned.decision)}`);
    return { exitCode: 2, decision: planned.decision };
  }
  const { plan } = planned;
  const out = plan.side === "buy" ? plan.candidate : deps.quoteAsset;
  const inn = plan.side === "buy" ? deps.quoteAsset : plan.candidate;
  log("PLAN (the quote is re-requested at execution, so numbers may differ slightly):");
  log(`  sends     ${unitsToNumber(plan.bounds.amountIn, inn.decimals)} ${inn.symbol}   (${plan.bounds.tokenIn})`);
  log(`  receives  ~${unitsToNumber(plan.quote.amountOut, out.decimals)} ${out.symbol}   (${plan.bounds.tokenOut})`);
  log(`  minimum   ${unitsToNumber(plan.bounds.minAmountOut, out.decimals)} ${out.symbol}`);
  log(`  issuer    ${plan.candidate.issuer ?? "n/a"} | recipient is the vault's own Intents account`);
  log(`  request   POST /wallet/v1/intents/swap ${JSON.stringify({ token_in: plan.bounds.tokenIn, token_out: plan.bounds.tokenOut, amount_in: plan.bounds.amountIn, min_amount_out: plan.bounds.minAmountOut })}`);

  if (!a.confirmMainnet) {
    log("DRY RUN: nothing was sent. Re-run with --confirm-mainnet only after the owner has confirmed this exact trade.");
    return { exitCode: 0 };
  }

  log("EXECUTING on mainnet…");
  let decision = await executeTrade(deps, request);
  log(`  result: ${JSON.stringify(decision)}`);

  if (decision.status === "pending_approval") {
    const row = deps.ledger.list(a.vaultId).at(-1);
    log(`  Waiting for the owner's approval of request ${decision.requestId} (up to ${a.waitMinutes} min). Approve at https://app.outlayer.ai/wallet/approvals`);
    const until = deps.now() + a.waitMinutes * 60_000;
    while (row && decision.status === "pending_approval" && deps.now() < until) {
      await deps.sleep(10_000);
      decision = (await reconcile(deps, row.id)) ?? decision;
    }
    log(`  final: ${JSON.stringify(decision)}`);
  }
  return { exitCode: decision.status === "executed" ? 0 : decision.status === "pending_approval" ? 3 : 2, decision };
}
