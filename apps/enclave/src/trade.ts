import { APPROVAL_TTL_HOURS, approvalInfo } from "./about";
import {
  checkPriceSanity,
  dustWarning,
  impliedPriceUsd,
  isBlock,
  lossToday,
  noLiquidityMessage,
  sumToday,
  noLiquidity,
  preTradeChecks,
  pricingUnavailable,
  vaultCapReached,
  privacyUnavailable,
  probeSizes,
  requireSwapBounds,
  selectBestQuote,
  unitsToNumber,
  usdToUnits,
  verifyConfidentialSwap,
  verifyExecution,
  type CryptoSignals,
  type IncidentFeedStatus,
  type Holdings,
  type IntendedSwap,
  type Registry,
  type RegistryEntry,
  type RiskProvider,
  type ShieldFeed,
  type SwapBounds,
} from "@norr/core";
import { IntentsApiError, type BalanceReader, type DepositQuoter, type ExecutionAuditor, type Quote, type Quoter, type SwapStatus, type Venue } from "@norr/intents";
import type { Decision, TradeRequest } from "@norr/shared";
import { KeyedMutex } from "./mutex";
import { CASH_USD, valueLayers } from "./portfolio";
import type { Ledger, Vault, VaultStore } from "./state";

export interface TradeDeps {
  registry: Registry;
  risk: RiskProvider;
  /** The read-only market data Scam Shield scores (liquidity, market cap, age), for the agent's get_market_data. */
  marketSignals?: (asset: RegistryEntry) => Promise<CryptoSignals>;
  /** The Shield incident feed; null when unreachable (fails closed). */
  shield: () => Promise<ShieldFeed | null>;
  /** Whether this deployment reads the incident feed at all (a partner key is configured). Defaults to "active". */
  incidentFeed?: IncidentFeedStatus;
  /** What to do when the feed is unreachable. Defaults to "block"; "allow" is the dev-only bypass (see shield-mode.ts). */
  shieldOnUnavailable?: "block" | "allow";
  /** Called on every evaluation that used the bypass, so it can be logged loudly. */
  onShieldBypass?: (vaultId: string) => void;
  quoter: Quoter;
  auditor: ExecutionAuditor;
  /** Where the owner gets a deposit address for funding the vault (1Click). When absent, the custody provider is asked. */
  funder?: DepositQuoter;
  vaults: VaultStore;
  ledger: Ledger;
  /** Reads the vault's public-layer Intents balances. Without it, portfolio values in the vault state are used as is. */
  balances?: BalanceReader;
  /** The asset vault cash is held in (USDC). Buys spend it, sells return it. */
  quoteAsset: RegistryEntry;
  /** Live service only: false while the asset list has not loaded yet (1Click was unreachable at boot). Absent means ready. */
  pricingReady?: () => boolean;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** How long to wait on a swap before reporting it as pending, and the poll interval. */
  settle?: { waitMs: number; intervalMs: number };
  maxPriceDeviationPct?: number;
  /** The owner dashboard's address, for links in answers (e.g. to Approvals). */
  dashboardUrl?: string;
  /** Public beta: buys are refused while a self-serve vault holds more than its cap, in USD (docs/MULTI-USER.md). Undefined: no cap. */
  vaultCapUsd?: (vaultId: string) => number | undefined;
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
  /** The buy reserved against the daily spend cap, given back if the swap is known not to have run. */
  spend?: { day: string; usd: number };
  /** The layer the swap runs in. */
  venue: Venue;
  /** Confidential balances read just before a confidential swap, to check it against afterwards. */
  confidentialBefore?: Holdings;
  /** Things to tell the agent with the result, for example a dust warning. */
  warnings?: string[];
  /** The custody provider's request hash, so the owner can match it to the approval screen. */
  requestHash?: string;
  /** When the swap was sent (ms), for the approval's expiry. */
  sentAt?: number;
}

/** A trade that passed every check and has a quote, ready to send (or just to show as a preview). */
export interface TradePlan {
  candidate: RegistryEntry;
  quote: Quote;
  bounds: SwapBounds;
  intended: IntendedSwap;
  side: "buy" | "sell";
  /** The layer chosen: confidential whenever the vault's policy allows it and the funds are there. */
  venue: Venue;
  confidentialBefore?: Holdings;
  /** Dust and similar warnings, shown with a dry-run quote and attached to the result. */
  warnings: string[];
}

const blocked = (code: Extract<Decision, { status: "blocked" }>["code"], message: string): Decision => ({ status: "blocked", code, message });
const failed = (message: string): Decision => ({ status: "failed", message });

/**
 * Options for operator tooling (the live runner); not reachable from the agent API.
 * sellAll sells the vault's whole balance of the asset instead of a USD-sized amount, so no dust is left.
 * The request's amountUsd then acts as a ceiling: a holding worth more than it is refused, so the
 * per-trade policy check cannot be sidestepped.
 */
export interface TradeOptions {
  sellAll?: boolean;
}

/** What a vault holds in each layer, where it could be read. */
export interface Layers {
  public?: Holdings;
  confidential?: Holdings;
}

/** Bring the vault's state up to date: today's realized loss, spend, and balances in both layers. */
export async function refreshState(deps: TradeDeps, vault: Vault): Promise<Layers> {
  const patch: Parameters<VaultStore["refresh"]>[1] = { realizedLossTodayUsd: lossToday(vault.pnl, deps.now()), spentTodayUsd: sumToday(vault.spend, deps.now()) };
  const layers: Layers = {};
  if (deps.balances) layers.public = await deps.balances.holdings(vault.walletAccount).catch(() => undefined);
  layers.confidential = await vault.custody.confidentialHoldings().catch(() => undefined);
  // Update the totals only when every layer was readable; otherwise keep the last known values rather than guess.
  if ((!deps.balances || layers.public) && layers.confidential) {
    const p = valueLayers(layers, deps.registry, [deps.quoteAsset.id]);
    patch.portfolioValueUsd = p.totalUsd;
    patch.equityValueUsd = p.byClass.equity;
  }
  deps.vaults.refresh(vault.id, patch);
  return layers;
}

/**
 * Pipeline steps 1-5: paused, resolve, Shield, risk or eligibility, policy, then Norr's own quote for
 * every candidate issuer, price sanity and the swap guard. Moves no funds, so it also serves previews.
 */
export async function planTrade(deps: TradeDeps, vault: Vault, request: TradeRequest, opts: TradeOptions = {}): Promise<({ plan: TradePlan } | { decision: Decision }) & { shieldBypassed: boolean; note?: string }> {
  // A paused vault does no work and makes no outbound calls.
  if (vault.policy.paused) {
    return { decision: blocked("PAUSED", "This vault is paused by its owner. No trades are allowed until it is resumed."), shieldBypassed: false };
  }

  if (deps.pricingReady && !deps.pricingReady()) {
    const b = pricingUnavailable();
    return { decision: blocked(b.code, b.message), shieldBypassed: false };
  }

  const layers = await refreshState(deps, vault);
  const cap = deps.vaultCapUsd?.(vault.id);
  if (cap !== undefined && request.side === "buy") {
    const value = deps.vaults.get(vault.id)?.state.portfolioValueUsd ?? 0;
    if (value > cap) {
      const b = vaultCapReached(value, cap);
      return { decision: blocked(b.code, b.message), shieldBypassed: false };
    }
  }
  // No feed configured on this deployment: nothing to ask, and every answer says so (incidentFeedInfo).
  const feedActive = (deps.incidentFeed ?? "active") === "active";
  const feed = feedActive ? await deps.shield().catch(() => null) : null;
  // The bypass applies only when a configured feed is unreachable. An incident the feed reports still blocks.
  const shieldBypassed = feedActive && feed === null && deps.shieldOnUnavailable === "allow";
  if (shieldBypassed) deps.onShieldBypass?.(vault.id);
  const pre = await preTradeChecks({
    request,
    policy: vault.policy,
    state: vault.state,
    registry: deps.registry,
    risk: deps.risk,
    shield: feed,
    shieldOnUnavailable: deps.shieldOnUnavailable,
    incidentFeed: deps.incidentFeed ?? "active",
    nowMs: deps.now(),
  });
  if (isBlock(pre)) return { decision: blocked(pre.code, pre.message), shieldBypassed };

  // Norr requests its own quote for every candidate issuer and picks the best. Venues are tried in the
  // order the vault's privacy mode allows: confidential first (the default), public only as a fallback.
  const buy = request.side === "buy";
  const cash = deps.quoteAsset;
  const mode = vault.policy.privacy;
  const order: Venue[] = mode === "public" ? ["public"] : mode === "require" ? ["confidential"] : ["confidential", "public"];

  interface Option { candidate: RegistryEntry; tokenIn: string; tokenOut: string; amountIn: string; quote: Quote; venue: Venue }
  interface Attempt {
    chosen?: Option;
    /** A thrown error is a service fault, not "no liquidity" (a null quote); keep them apart. */
    quoteFault?: string;
    shortfall?: string;
    /** A quote was requested somewhere, so a shortfall elsewhere is not the whole story. */
    attempted: boolean;
    unreadable: boolean;
  }

  // One pass over the venues for a given size. With checkFunds off it only asks whether a size quotes
  // (used by the probe), so it ignores what the vault holds.
  const attempt = async (usd: number, checkFunds: boolean): Promise<Attempt> => {
    const a: Attempt = { attempted: false, unreadable: false };
    for (const venue of order) {
      const holdings = layers[venue];
      if (checkFunds && !holdings && venue === "confidential") {
        a.unreadable = true; // cannot tell whether the funds are there, so do not trade confidentially
        continue;
      }
      const options = (
        await Promise.all(
          pre.candidates.map(async (c): Promise<Option | null> => {
            if (c.priceUsd === null) return null;
            const tokenIn = buy ? cash.id : c.id;
            const tokenOut = buy ? c.id : cash.id;
            const sellAll = opts.sellAll === true && !buy;
            const amountIn = sellAll ? (holdings?.[tokenIn] ?? "0") : buy ? usdToUnits(usd, cash.priceUsd ?? 1, cash.decimals) : usdToUnits(usd, c.priceUsd, c.decimals);
            if (sellAll) {
              const heldValue = unitsToNumber(amountIn, c.decimals) * c.priceUsd;
              if (BigInt(amountIn) === 0n) {
                a.shortfall ??= `${venue === "confidential" ? "its confidential balance" : "its public balance"} holds no ${c.symbol}`;
                return null;
              }
              if (heldValue > request.amountUsd) {
                a.shortfall = `${venue === "confidential" ? "its confidential" : "its public"} ${c.symbol} balance is worth about $${heldValue.toFixed(2)}, above the $${request.amountUsd} ceiling given for selling everything`;
                return null;
              }
            }
            if (checkFunds && holdings && BigInt(holdings[tokenIn] ?? "0") < BigInt(amountIn)) {
              const inAsset = buy ? cash : c;
              a.shortfall ??= `${venue === "confidential" ? "its confidential balance" : "its public balance"} holds ${unitsToNumber(holdings[tokenIn] ?? "0", inAsset.decimals)} ${inAsset.symbol}, and this trade needs ${unitsToNumber(amountIn, inAsset.decimals)}`;
              return null;
            }
            a.attempted = true;
            const quote = await deps.quoter.quote({ tokenIn, tokenOut, amountIn, recipient: vault.walletAccount, venue }).catch((e: unknown) => {
              a.quoteFault = e instanceof Error ? e.message : String(e);
              return null;
            });
            return quote ? { candidate: c, tokenIn, tokenOut, amountIn, quote, venue } : null;
          }),
        )
      ).filter((o): o is Option => o !== null);
      const best = selectBestQuote(options.map((o) => ({ assetId: o.candidate.id, issuer: o.candidate.issuer, amountInUsd: o.quote.amountInUsd, amountOutUsd: o.quote.amountOutUsd })));
      a.chosen = best ? options.find((o) => o.candidate.id === best.assetId) : undefined;
      if (a.chosen) break;
    }
    return a;
  };

  const first = await attempt(request.amountUsd, true);
  const chosen = first.chosen;
  if (!chosen) {
    const { quoteFault, shortfall, attempted, unreadable } = first;
    if (mode === "require") {
      const why = unreadable
        ? "Norr could not read the vault's confidential balance."
        : shortfall
          ? `${shortfall}. The owner can fund the vault in the confidential layer.`
          : quoteFault
            ? "pricing is temporarily unavailable."
            : "no confidential liquidity was found for this trade.";
      const b = privacyUnavailable(why);
      return { decision: blocked(b.code, b.message), shieldBypassed, note: quoteFault ? `quote service fault: ${quoteFault}` : undefined };
    }
    if (quoteFault) {
      return {
        decision: failed("Pricing is temporarily unavailable, so no trade was made. Try again in a few minutes."),
        shieldBypassed,
        note: `quote service fault: ${quoteFault}`,
      };
    }
    if (shortfall && !attempted) return { decision: failed(`The vault does not hold enough for this trade: ${shortfall}. Check get_portfolio.`), shieldBypassed };

    // No liquidity. For a stock, find the smallest larger size that quotes right now (free dry quotes).
    if (pre.class === "equity") {
      const ceiling = vault.policy.maxTradeUsd;
      let smallest: number | undefined;
      for (const usd of probeSizes(request.amountUsd, ceiling)) {
        if ((await attempt(usd, false)).chosen) {
          smallest = usd;
          break;
        }
      }
      const d: Decision = { status: "blocked", code: "NO_LIQUIDITY", message: noLiquidityMessage(pre.ticker, request.amountUsd, smallest, ceiling), ...(smallest !== undefined ? { suggestedUsd: smallest } : {}) };
      return { decision: d, shieldBypassed };
    }
    const nl = noLiquidity();
    return { decision: blocked(nl.code, nl.message), shieldBypassed };
  }

  const { candidate, tokenIn, tokenOut, amountIn, quote, venue } = chosen;

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

  // A sell that leaves a remainder too small to sell later gets a warning, not a block.
  const warnings: string[] = [];
  if (!buy && candidate.class === "equity" && candidate.priceUsd !== null) {
    const held = layers[venue]?.[tokenIn];
    if (held !== undefined) {
      const remaining = unitsToNumber((BigInt(held) - BigInt(amountIn)).toString(), candidate.decimals) * candidate.priceUsd;
      const w = dustWarning(remaining, unitsToNumber(held, candidate.decimals) * candidate.priceUsd, candidate.symbol);
      if (w) warnings.push(w);
    }
  }

  return {
    plan: {
      candidate, quote, bounds, side: request.side, venue, warnings,
      confidentialBefore: venue === "confidential" ? layers.confidential : undefined,
      intended: { tokenIn, tokenOut, amountIn, minAmountOut: quote.minAmountOut, recipient: vault.walletAccount },
    },
    shieldBypassed,
  };
}

const mutexes = new WeakMap<object, KeyedMutex>();

/**
 * Run the trade pipeline (CLAUDE.md section 7). Never throws: every outcome is a Decision. Trades for
 * one vault run one at a time, so parallel requests cannot slip past a cap together.
 */
export function executeTrade(deps: TradeDeps, request: TradeRequest, opts: TradeOptions = {}): Promise<Decision> {
  let m = mutexes.get(deps.vaults);
  if (!m) mutexes.set(deps.vaults, (m = new KeyedMutex()));
  return m.run(request.vaultId, () => executeTradeLocked(deps, request, opts));
}

async function executeTradeLocked(deps: TradeDeps, request: TradeRequest, opts: TradeOptions): Promise<Decision> {
  const vault = deps.vaults.get(request.vaultId);
  if (!vault) return failed("This vault does not exist.");

  const log = (decision: Decision, extra: { pending?: PendingSettlement; note?: string } = {}) =>
    deps.ledger.append({ vaultId: vault.id, at: deps.now(), request, decision, ...extra });

  const planned = await planTrade(deps, vault, request, opts);
  const bypassNote = [planned.shieldBypassed ? "SHIELD BYPASS: evaluated without the Shield incident feed (dev-bypass)" : undefined, planned.note].filter(Boolean).join(" | ") || undefined;
  if ("decision" in planned) {
    log(planned.decision, { note: bypassNote });
    return planned.decision;
  }
  const { plan } = planned;

  // A confidential swap is checked against balances read before it. If another confidential swap is still
  // waiting for the owner, the balances could move underneath it, so wait for that one to finish first.
  if (plan.venue === "confidential" && deps.ledger.list(vault.id).some((r) => r.pending?.venue === "confidential")) {
    const d = failed("Another confidential trade is still waiting for the owner's approval. Wait for it to finish, then try again.");
    log(d, { note: bypassNote });
    return d;
  }

  // Step 6: execute through the custody provider. A buy is counted against the daily spend cap before
  // the swap is sent, and given back only if the swap is known not to have run.
  const spend = plan.side === "buy" ? { day: deps.vaults.reserveSpend(vault.id, request.amountUsd, deps.now()), usd: request.amountUsd } : undefined;
  let status: SwapStatus;
  try {
    status = await vault.custody.swap(plan.bounds, plan.venue);
  } catch (e) {
    const refused = e instanceof IntentsApiError && e.status === 403;
    // A policy refusal means nothing ran. Any other error is ambiguous, so the spend stays counted.
    if (refused && spend) deps.vaults.releaseSpend(vault.id, spend.day, spend.usd);
    const d = failed(
      refused
        ? "The custody policy refused this swap. The owner can review it in the custody dashboard."
        : "The swap could not be confirmed with the custody provider. Check the activity log before retrying.",
    );
    log(d, { note: [bypassNote, e instanceof Error ? e.message : String(e)].filter(Boolean).join(" | ") });
    return d;
  }

  const ctx: PendingSettlement = {
    sentAt: deps.now(),
    requestId: status.requestId,
    intended: plan.intended,
    quoteUsd: { in: plan.quote.amountInUsd, out: plan.quote.amountOutUsd },
    assetId: plan.candidate.id,
    symbol: plan.candidate.symbol,
    decimals: plan.candidate.decimals,
    side: plan.side,
    spend,
    venue: plan.venue,
    confidentialBefore: plan.confidentialBefore,
    warnings: plan.warnings,
    requestHash: status.requestHash,
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
    const a = await approvalInfo(deps, vault);
    const expiresAt = new Date((ctx.sentAt ?? deps.now()) + APPROVAL_TTL_HOURS * 3600_000).toISOString();
    return {
      status: "pending_approval",
      requestId: ctx.requestId,
      message: `Sent, and waiting for the vault owner's approval in the ${a.where}${a.url ? ` (${a.url})` : ""}. It runs once they approve, and the approval expires at ${expiresAt} (${APPROVAL_TTL_HOURS} hours). Tell the owner; follow up with get_activity and do not resend.`,
      approval: { where: a.where, url: a.url, expiresAt },
    };
  }
  if (st.state === "in_progress") {
    return { status: "pending_approval", requestId: ctx.requestId, message: "The swap is still processing. Check the activity log for the result." };
  }
  if (st.state === "failed") {
    if (ctx.spend) deps.vaults.releaseSpend(vaultId, ctx.spend.day, ctx.spend.usd); // it did not run
    return failed(`The swap did not complete${st.detail ? ` (${st.detail})` : ""}. Funds stay in the vault.`);
  }

  // State is success: verify before reporting it.
  const pause = (why: string): Decision => {
    deps.vaults.pause(vaultId, why);
    return failed("The swap ran but Norr could not confirm it matched the agreed terms, so this vault has been paused for the owner to review.");
  };
  let units: string; // whole units of the traded asset that were bought or sold
  let cashUnits: string | undefined; // the cash (USDC) that actually moved: spent on a buy, received on a sell
  let verification: "independent" | "custody-reported";
  if (ctx.venue === "confidential") {
    // No independent source exists for the confidential layer, so compare balances read before and after
    // with the provider's own report. Weaker than the public check, and labelled as such in the result.
    const after = await vault.custody.confidentialHoldings().catch(() => null);
    const before = ctx.confidentialBefore;
    if (!after || !before) return pause("confidential balances unavailable");
    const { tokenIn, tokenOut, amountIn, minAmountOut } = ctx.intended;
    const check = verifyConfidentialSwap({ tokenIn, tokenOut, amountIn, minAmountOut }, before, after, st.reported);
    if (!check.ok) return pause(`mismatch: ${check.mismatches.map((m) => m.field).join(", ")}`);
    const moved = (k: string) => BigInt(after[k] ?? "0") - BigInt(before[k] ?? "0");
    units = (ctx.side === "buy" ? moved(tokenOut) : -moved(tokenIn)).toString();
    cashUnits = (ctx.side === "buy" ? -moved(tokenIn) : moved(tokenOut)).toString();
    verification = "custody-reported";
  } else {
    if (!st.depositAddress) return pause("no deposit address to audit");
    const executed = await deps.auditor.audit(st.depositAddress).catch(() => null);
    if (!executed) return pause("independent status unavailable");
    const check = verifyExecution(ctx.intended, executed);
    if (!check.ok) return pause(`mismatch: ${check.mismatches.map((m) => m.field).join(", ")}`);
    units = ctx.side === "buy" ? executed.amountOut : executed.amountIn;
    cashUnits = ctx.side === "buy" ? executed.amountIn : executed.amountOut;
    verification = "independent";
  }

  const now = deps.now();
  const tokens = unitsToNumber(units, ctx.decimals);
  // Book what really moved (USDC at its peg), not the quote's estimate; fall back to the quote if the amount is unusable.
  const cash = cashUnits !== undefined && BigInt(cashUnits) > 0n ? unitsToNumber(cashUnits, deps.quoteAsset.decimals) * CASH_USD : undefined;
  const usd = cash ?? (ctx.side === "buy" ? ctx.quoteUsd.in : ctx.quoteUsd.out);
  deps.vaults.recordTrade(vaultId, now);
  deps.vaults.recordFill(vaultId, { assetId: ctx.assetId, side: ctx.side, qty: tokens, usd }, now);
  return { status: "executed", txRef: ctx.requestId, filled: { asset: ctx.symbol, amount: String(tokens), priceUsd: impliedPriceUsd(usd, tokens) }, venue: ctx.venue, verification, ...(ctx.warnings?.length ? { warnings: ctx.warnings } : {}) };
}

/** Finish a swap that was pending when the agent called (for example after the owner approved it). */
export async function reconcile(deps: TradeDeps, ledgerId: string): Promise<Decision | null> {
  const row = deps.ledger.get(ledgerId);
  if (!row?.pending) return null;
  // Already settled (a row written before cleared fields were persisted): clear the marker, never settle or book it twice.
  if (row.decision.status !== "pending_approval") {
    deps.ledger.update(ledgerId, { pending: undefined });
    return row.decision;
  }
  const vault = deps.vaults.get(row.vaultId);
  if (!vault) return null;
  const st = await vault.custody.status(row.pending.requestId).catch(() => null);
  if (!st) return null;
  const decision = await settle({ ...deps, settle: { waitMs: 0, intervalMs: 0 } }, row.vaultId, row.pending, st);
  deps.ledger.update(ledgerId, { decision, pending: decision.status === "pending_approval" ? row.pending : undefined });
  return decision;
}
