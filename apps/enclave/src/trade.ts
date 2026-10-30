import {
  checkPriceSanity,
  impliedPriceUsd,
  isBlock,
  lossToday,
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
  type SwapBounds,
} from "@norr/core";
import { IntentsApiError, type BalanceReader, type ExecutionAuditor, type Quote, type Quoter, type SwapStatus } from "@norr/intents";
import type { Decision, TradeRequest } from "@norr/shared";
import { valuePortfolio } from "./portfolio";
import type { Ledger, Vault, VaultStore } from "./state";

export interface TradeDeps {
  registry: Registry;
  risk: RiskProvider;
  /** The Shield incident feed; null when unreachable (fails closed). */
  shield: () => Promise<ShieldFeed | null>;
  /** What to do when the feed is unreachable. Defaults to "block"; "allow" is the dev-only bypass (see shield-mode.ts). */
  shieldOnUnavailable?: "block" | "allow";
  /** Called on every evaluation that used the bypass, so it can be logged loudly. */
  onShieldBypass?: (vaultId: string) => void;
  quoter: Quoter;
  auditor: ExecutionAuditor;
  vaults: VaultStore;
  ledger: Ledger;
  /** Reads the vault's Intents balances. Without it, portfolio values in the vault state are used as is. */
  balances?: BalanceReader;
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
  /** Norr's own quote USD amounts, used for the price in the result and for P&L. */
  quoteUsd: { in: number; out: number };
  assetId: string;
  symbol: string;
  decimals: number;
  side: "buy" | "sell";
}

/** A trade that passed every check and has a quote, ready to send (or just to show as a preview). */
export interface TradePlan {
  candidate: RegistryEntry;
  quote: Quote;
  bounds: SwapBounds;
  intended: IntendedSwap;
  side: "buy" | "sell";
}

const blocked = (code: Extract<Decision, { status: "blocked" }>["code"], message: string): Decision => ({ status: "blocked", code, message });
const failed = (message: string): Decision => ({ status: "failed", message });

/** Bring the vault's state up to date: today's realized loss and, when readable, balances. */
export async function refreshState(deps: TradeDeps, vault: Vault): Promise<void> {
  const patch: Parameters<VaultStore["refresh"]>[1] = { realizedLossTodayUsd: lossToday(vault.pnl, deps.now()) };
  if (deps.balances) {
    try {
      const p = valuePortfolio(await deps.balances.holdings(vault.walletAccount), deps.registry);
      patch.portfolioValueUsd = p.totalUsd;
      patch.equityValueUsd = p.byClass.equity;
    } catch {
      // Balances unreadable: keep the last known values rather than guess.
    }
  }
  deps.vaults.refresh(vault.id, patch);
}

/**
 * Pipeline steps 1-5: paused, resolve, Shield, risk or eligibility, policy, then Norr's own quote for
 * every candidate issuer, price sanity and the swap guard. Moves no funds, so it also serves previews.
 */
export async function planTrade(deps: TradeDeps, vault: Vault, request: TradeRequest): Promise<({ plan: TradePlan } | { decision: Decision }) & { shieldBypassed: boolean }> {
  // A paused vault does no work and makes no outbound calls.
  if (vault.policy.paused) {
    return { decision: blocked("PAUSED", "This vault is paused by its owner. No trades are allowed until it is resumed."), shieldBypassed: false };
  }

  await refreshState(deps, vault);
  const feed = await deps.shield().catch(() => null);
  // The bypass applies only when the feed is unreachable. An incident the feed reports still blocks.
  const shieldBypassed = feed === null && deps.shieldOnUnavailable === "allow";
  if (shieldBypassed) deps.onShieldBypass?.(vault.id);
  const pre = await preTradeChecks({
    request,
    policy: vault.policy,
    state: vault.state,
    registry: deps.registry,
    risk: deps.risk,
    shield: feed,
    shieldOnUnavailable: deps.shieldOnUnavailable,
    nowMs: deps.now(),
  });
  if (isBlock(pre)) return { decision: blocked(pre.code, pre.message), shieldBypassed };

  // Norr requests its own quote for every candidate issuer and picks the best.
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
    return { decision: blocked(nl.code, nl.message), shieldBypassed };
  }

  const { candidate, tokenIn, tokenOut, amountIn, quote } = chosen;

  // Price sanity: the implied price of the traded asset against its reference price.
  const implied = buy
    ? impliedPriceUsd(quote.amountInUsd, unitsToNumber(quote.amountOut, candidate.decimals))
    : impliedPriceUsd(quote.amountOutUsd, unitsToNumber(amountIn, candidate.decimals));
  const insane = checkPriceSanity(candidate.priceUsd, implied, deps.maxPriceDeviationPct);
  if (insane) return { decision: blocked(insane.code, insane.message), shieldBypassed };

  // Hard rule: never submit a swap without min_amount_out (taken from Norr's own quote).
  let bounds: SwapBounds;
  try {
    bounds = requireSwapBounds({ tokenIn, tokenOut, amountIn, minAmountOut: quote.minAmountOut });
  } catch {
    return { decision: failed("The quote had no usable minimum output, so the swap was not sent."), shieldBypassed };
  }

  return {
    plan: { candidate, quote, bounds, side: request.side, intended: { tokenIn, tokenOut, amountIn, minAmountOut: quote.minAmountOut, recipient: vault.walletAccount } },
    shieldBypassed,
  };
}

/** Run the trade pipeline (CLAUDE.md section 7). Never throws: every outcome is a Decision. */
export async function executeTrade(deps: TradeDeps, request: TradeRequest): Promise<Decision> {
  const vault = deps.vaults.get(request.vaultId);
  if (!vault) return failed("This vault does not exist.");

  const log = (decision: Decision, extra: { pending?: PendingSettlement; note?: string } = {}) =>
    deps.ledger.append({ vaultId: vault.id, at: deps.now(), request, decision, ...extra });

  const planned = await planTrade(deps, vault, request);
  const bypassNote = planned.shieldBypassed ? "SHIELD BYPASS: evaluated without the Shield incident feed (dev-bypass)" : undefined;
  if ("decision" in planned) {
    log(planned.decision, { note: bypassNote });
    return planned.decision;
  }
  const { plan } = planned;

  // Step 6: execute through the custody provider.
  let status: SwapStatus;
  try {
    status = await vault.custody.swap(plan.bounds);
  } catch (e) {
    const refused = e instanceof IntentsApiError && e.status === 403;
    const d = failed(
      refused
        ? "The custody policy refused this swap. The owner can review it in the custody dashboard."
        : "The swap could not be confirmed with the custody provider. Check the activity log before retrying.",
    );
    log(d, { note: [bypassNote, e instanceof Error ? e.message : String(e)].filter(Boolean).join(" | ") });
    return d;
  }

  const ctx: PendingSettlement = {
    requestId: status.requestId,
    intended: plan.intended,
    quoteUsd: { in: plan.quote.amountInUsd, out: plan.quote.amountOutUsd },
    assetId: plan.candidate.id,
    symbol: plan.candidate.symbol,
    decimals: plan.candidate.decimals,
    side: plan.side,
  };
  const row = log({ status: "pending_approval", requestId: status.requestId, message: "Swap submitted." }, { pending: ctx, note: bypassNote });
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

  const now = deps.now();
  const tokens = unitsToNumber(ctx.side === "buy" ? executed.amountOut : executed.amountIn, ctx.decimals);
  const usd = ctx.side === "buy" ? ctx.quoteUsd.in : ctx.quoteUsd.out;
  deps.vaults.recordTrade(vaultId, now);
  deps.vaults.recordFill(vaultId, { assetId: ctx.assetId, side: ctx.side, qty: tokens, usd }, now);
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
