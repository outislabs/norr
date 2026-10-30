import {
  checkPriceSanity,
  impliedPriceUsd,
  isBlock,
  noLiquidity,
  preTradeChecks,
  requireSwapBounds,
  selectBestQuote,
  unitsToNumber,
  usdToUnits,
  verifyExecution,
  type IntendedSwap,
  type Registry,
  type RegistryEntry,
  type RiskProvider,
  type ShieldFeed,
} from "@norr/core";
import { IntentsApiError, type ExecutionAuditor, type Quote, type Quoter, type SwapStatus } from "@norr/intents";
import type { Decision, TradeRequest } from "@norr/shared";
import type { Ledger, VaultStore } from "./state";

export interface TradeDeps {
  registry: Registry;
  risk: RiskProvider;
  /** The Shield incident feed; null when unreachable (fails closed). */
  shield: () => Promise<ShieldFeed | null>;
  quoter: Quoter;
  auditor: ExecutionAuditor;
  vaults: VaultStore;
  ledger: Ledger;
  /** The asset vault cash is held in (USDC). Buys spend it, sells return it. */
  quoteAsset: RegistryEntry;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** How long to wait on a swap before reporting it as pending, and the poll interval. */
  settle?: { waitMs: number; intervalMs: number };
  maxPriceDeviationPct?: number;
}

/** Everything needed to finish verifying a swap that was not final when the agent called. */
export interface PendingSettlement {
  requestId: string;
  intended: IntendedSwap;
  /** Norr's own quote USD amounts, used for the price in the result. */
  quoteUsd: { in: number; out: number };
  symbol: string;
  decimals: number;
  side: "buy" | "sell";
  tokenInDecimals: number;
}

const blocked = (code: Extract<Decision, { status: "blocked" }>["code"], message: string): Decision => ({ status: "blocked", code, message });
const failed = (message: string): Decision => ({ status: "failed", message });

/** Run the trade pipeline (CLAUDE.md section 7). Never throws: every outcome is a Decision. */
export async function executeTrade(deps: TradeDeps, request: TradeRequest): Promise<Decision> {
  const vault = deps.vaults.get(request.vaultId);
  if (!vault) return failed("This vault does not exist.");

  const log = (decision: Decision, extra: { pending?: PendingSettlement; note?: string } = {}) =>
    deps.ledger.append({ vaultId: vault.id, at: deps.now(), request, decision, ...extra });

  // A paused vault does no work and makes no outbound calls.
  if (vault.policy.paused) {
    const d = blocked("PAUSED", "This vault is paused by its owner. No trades are allowed until it is resumed.");
    log(d);
    return d;
  }

  // Steps 2-4: resolve, Shield, risk or eligibility, policy.
  const feed = await deps.shield().catch(() => null);
  const pre = await preTradeChecks({
    request,
    policy: vault.policy,
    state: vault.state,
    registry: deps.registry,
    risk: deps.risk,
    shield: feed,
    nowMs: deps.now(),
  });
  if (isBlock(pre)) {
    const d = blocked(pre.code, pre.message);
    log(d);
    return d;
  }

  // Step 5: Norr requests its own quote for every candidate issuer and picks the best.
  const buy = request.side === "buy";
  const cash = deps.quoteAsset;
  const options = (
    await Promise.all(
      pre.candidates.map(async (c) => {
        if (c.priceUsd === null) return null;
        const tokenIn = buy ? cash.id : c.id;
        const tokenOut = buy ? c.id : cash.id;
        const amountIn = buy ? usdToUnits(request.amountUsd, cash.priceUsd ?? 1, cash.decimals) : usdToUnits(request.amountUsd, c.priceUsd, c.decimals);
        const quote = await deps.quoter.quote({ tokenIn, tokenOut, amountIn, recipient: vault.walletAccount }).catch(() => null);
        return quote ? { candidate: c, tokenIn, tokenOut, amountIn, quote } : null;
      }),
    )
  ).filter((o): o is NonNullable<typeof o> => o !== null);

  const best = selectBestQuote(options.map((o) => ({ assetId: o.candidate.id, issuer: o.candidate.issuer, amountInUsd: o.quote.amountInUsd, amountOutUsd: o.quote.amountOutUsd })));
  const chosen = best && options.find((o) => o.candidate.id === best.assetId);
  if (!chosen) {
    const nl = noLiquidity();
    const d = blocked(nl.code, nl.message);
    log(d);
    return d;
  }

  const { candidate, tokenIn, tokenOut, amountIn, quote } = chosen;
  const tokenInDecimals = buy ? cash.decimals : candidate.decimals;

  // Price sanity: the implied price of the traded asset against its reference price.
  const implied = buy
    ? impliedPriceUsd(quote.amountInUsd, unitsToNumber(quote.amountOut, candidate.decimals))
    : impliedPriceUsd(quote.amountOutUsd, unitsToNumber(amountIn, candidate.decimals));
  const insane = checkPriceSanity(candidate.priceUsd, implied, deps.maxPriceDeviationPct);
  if (insane) {
    const d = blocked(insane.code, insane.message);
    log(d);
    return d;
  }

  // Hard rule: never submit a swap without min_amount_out (taken from Norr's own quote).
  let bounds;
  try {
    bounds = requireSwapBounds({ tokenIn, tokenOut, amountIn, minAmountOut: quote.minAmountOut });
  } catch {
    const d = failed("The quote had no usable minimum output, so the swap was not sent.");
    log(d);
    return d;
  }

  // Step 6: execute through the custody provider.
  let status: SwapStatus;
  try {
    status = await vault.custody.swap(bounds);
  } catch (e) {
    const refused = e instanceof IntentsApiError && e.status === 403;
    const d = failed(
      refused
        ? "The custody policy refused this swap. The owner can review it in the custody dashboard."
        : "The swap could not be confirmed with the custody provider. Check the activity log before retrying.",
    );
    log(d, { note: e instanceof Error ? e.message : String(e) });
    return d;
  }

  const intended: IntendedSwap = { tokenIn, tokenOut, amountIn, minAmountOut: quote.minAmountOut, recipient: vault.walletAccount };
  const ctx: PendingSettlement = {
    requestId: status.requestId,
    intended,
    quoteUsd: { in: quote.amountInUsd, out: quote.amountOutUsd },
    symbol: candidate.symbol,
    decimals: candidate.decimals,
    side: request.side,
    tokenInDecimals,
  };
  const row = log({ status: "pending_approval", requestId: status.requestId, message: "Swap submitted." }, { pending: ctx });
  const decision = await settle(deps, request.vaultId, ctx, status);
  deps.ledger.update(row.id, { decision, pending: decision.status === "pending_approval" ? ctx : undefined });
  return decision;
}

/**
 * Steps 7-8: wait for the swap, then verify it against Norr's own quote using 1Click's
 * independent status. Anything that cannot be verified is treated as a failure and pauses the vault.
 */
export async function settle(deps: TradeDeps, vaultId: string, ctx: PendingSettlement, first: SwapStatus): Promise<Decision> {
  const vault = deps.vaults.get(vaultId);
  if (!vault) return failed("This vault does not exist.");
  const { waitMs, intervalMs } = deps.settle ?? { waitMs: 60_000, intervalMs: 3_000 };

  let st = first;
  const deadline = deps.now() + waitMs;
  while ((st.state === "pending_approval" || st.state === "in_progress") && deps.now() < deadline) {
    await deps.sleep(intervalMs);
    st = await vault.custody.status(ctx.requestId).catch(() => st);
  }

  if (st.state === "pending_approval") {
    return { status: "pending_approval", requestId: ctx.requestId, message: "The vault owner must approve this swap before it runs." };
  }
  if (st.state === "in_progress") {
    return { status: "pending_approval", requestId: ctx.requestId, message: "The swap is still processing. Check the activity log for the result." };
  }
  if (st.state === "failed") {
    return failed(`The swap did not complete${st.detail ? ` (${st.detail})` : ""}. Funds stay in the vault.`);
  }

  // State is success: verify before reporting it.
  const pause = (why: string): Decision => {
    deps.vaults.pause(vaultId, why);
    return failed("The swap ran but Norr could not confirm it matched the agreed terms, so this vault has been paused for the owner to review.");
  };
  if (!st.depositAddress) return pause("no deposit address to audit");
  const executed = await deps.auditor.audit(st.depositAddress).catch(() => null);
  if (!executed) return pause("independent status unavailable");
  const check = verifyExecution(ctx.intended, executed);
  if (!check.ok) return pause(`mismatch: ${check.mismatches.map((m) => m.field).join(", ")}`);

  deps.vaults.recordTrade(vaultId, deps.now());
  const bought = ctx.side === "buy" ? executed.amountOut : executed.amountIn;
  const tokens = unitsToNumber(bought, ctx.decimals);
  const usd = ctx.side === "buy" ? ctx.quoteUsd.in : ctx.quoteUsd.out;
  return { status: "executed", txRef: ctx.requestId, filled: { asset: ctx.symbol, amount: String(tokens), priceUsd: impliedPriceUsd(usd, tokens) } };
}

/** Finish a swap that was pending when the agent called (for example after the owner approved it). */
export async function reconcile(deps: TradeDeps, ledgerId: string): Promise<Decision | null> {
  const row = deps.ledger.get(ledgerId);
  if (!row?.pending) return null;
  const vault = deps.vaults.get(row.vaultId);
  if (!vault) return null;
  const st = await vault.custody.status(row.pending.requestId).catch(() => null);
  if (!st) return null;
  const decision = await settle({ ...deps, settle: { waitMs: 0, intervalMs: 0 } }, row.vaultId, row.pending, st);
  deps.ledger.update(ledgerId, { decision, pending: decision.status === "pending_approval" ? row.pending : undefined });
  return decision;
}

export type { Quote };
