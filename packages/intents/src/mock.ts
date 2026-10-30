import { unitsToNumber, usdToUnits, type ExecutedSwap, type RegistryEntry, type SwapBounds } from "@norr/core";
import type { BalanceReader } from "./balances";
import type { Custody, ExecutionAuditor, Quote, QuoteParams, Quoter, SwapStatus, Venue, WithdrawParams } from "./types";

/**
 * Mock rails for NORR_MOCK=1: prices come from the registry, fees are fixed, nothing leaves the process.
 * Two balance layers (public and confidential) behave like the real ones. Test hooks let tests exercise
 * every outcome: no liquidity, price skew, approvals, a tampering gateway, an unreadable audit trail.
 */
export interface MockOptions {
  feeBps?: number;
  /** Return false to simulate no liquidity for an asset (both layers). */
  liquidity?: (assetId: string) => boolean;
  /** Return false to simulate no liquidity for an asset in the confidential layer only. */
  confidentialLiquidity?: (assetId: string) => boolean;
  /** Skew every quoted price (basis points) to exercise the price-sanity check. */
  skewBps?: number;
  requireApproval?: boolean;
  /** Alter what the swap "actually did", to simulate a tampering gateway. */
  tamper?: (executed: ExecutedSwap) => ExecutedSwap;
  /** The independent public-layer status endpoint cannot be reached. */
  unauditable?: boolean;
  /** Make the custody call itself fail. */
  swapError?: Error;
  /** Starting public Intents balances: asset id to smallest units. */
  seed?: Record<string, string>;
  /** Starting confidential balances. */
  confidentialSeed?: Record<string, string>;
  /** The provider's report claims a different output amount than the balances show. */
  misreportAmountOut?: string;
  /** Confidential balance reads succeed this many times, then fail. */
  confidentialReadsBeforeFailure?: number;
}

type Layer = Record<string, bigint>;
interface Record_ {
  venue: Venue;
  done: ExecutedSwap;
  state: "pending_approval" | "success";
  depositAddress?: string;
}

const toLayer = (m: Record<string, string> | undefined): Layer => Object.fromEntries(Object.entries(m ?? {}).map(([k, v]) => [k, BigInt(v)]));
const positive = (l: Layer): Record<string, string> => Object.fromEntries(Object.entries(l).filter(([, v]) => v > 0n).map(([k, v]) => [k, v.toString()]));

export function createMockRails(entries: RegistryEntry[], vaultAccount: string, o: MockOptions = {}) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const feeBps = o.feeBps ?? 30;
  const held: Record<Venue, Layer> = { public: toLayer(o.seed), confidential: toLayer(o.confidentialSeed) };
  const executed = new Map<string, ExecutedSwap>();
  const records = new Map<string, Record_>();
  const swaps: SwapBounds[] = [];
  const venues: Venue[] = [];
  const withdrawals: WithdrawParams[] = [];
  let n = 0;
  let confidentialReads = 0;

  const apply = (venue: Venue, d: ExecutedSwap) => {
    held[venue][d.tokenIn] = (held[venue][d.tokenIn] ?? 0n) - BigInt(d.amountIn);
    held[venue][d.tokenOut] = (held[venue][d.tokenOut] ?? 0n) + BigInt(d.amountOut);
  };

  const quoter: Quoter = {
    async quote(p: QuoteParams): Promise<Quote | null> {
      const a = byId.get(p.tokenIn);
      const b = byId.get(p.tokenOut);
      if (!a || !b || a.priceUsd === null || b.priceUsd === null) return null;
      if (o.liquidity && !(o.liquidity(a.id) && o.liquidity(b.id))) return null;
      if (p.venue === "confidential" && o.confidentialLiquidity && !(o.confidentialLiquidity(a.id) && o.confidentialLiquidity(b.id))) return null;
      const usdIn = unitsToNumber(p.amountIn, a.decimals) * a.priceUsd;
      const usdOut = usdIn * (1 - feeBps / 10_000) * (1 + (o.skewBps ?? 0) / 10_000);
      const amountOut = usdToUnits(usdOut, b.priceUsd, b.decimals);
      return { amountIn: p.amountIn, amountOut, minAmountOut: ((BigInt(amountOut) * 99n) / 100n).toString(), amountInUsd: usdIn, amountOutUsd: usdOut };
    },
  };

  const view = (id: string, r: Record_): SwapStatus => ({
    state: r.state,
    requestId: id,
    depositAddress: r.depositAddress,
    reported: { amountIn: r.done.amountIn, amountOut: o.misreportAmountOut ?? r.done.amountOut },
  });

  const custody: Custody = {
    async accountId() {
      return vaultAccount;
    },

    async swap(bounds: SwapBounds, venue: Venue = "public"): Promise<SwapStatus> {
      if (o.swapError) throw o.swapError;
      swaps.push(bounds);
      venues.push(venue);
      const id = `mock-req-${++n}`;
      if ((held[venue][bounds.tokenIn] ?? 0n) < BigInt(bounds.amountIn)) return { state: "failed", requestId: id, detail: "insufficient balance" };
      const q = await quoter.quote({ tokenIn: bounds.tokenIn, tokenOut: bounds.tokenOut, amountIn: bounds.amountIn, recipient: vaultAccount, venue });
      const real: ExecutedSwap = { tokenIn: bounds.tokenIn, tokenOut: bounds.tokenOut, amountIn: bounds.amountIn, amountOut: q?.amountOut ?? "0", recipient: vaultAccount };
      const done = o.tamper ? o.tamper(real) : real;
      // Only the public layer has an independent record to audit.
      const depositAddress = venue === "public" ? `mock-deposit-${n}` : undefined;
      if (depositAddress) executed.set(depositAddress, done);
      const rec: Record_ = { venue, done, state: o.requireApproval ? "pending_approval" : "success", depositAddress };
      records.set(id, rec);
      if (rec.state === "success") apply(venue, done);
      return view(id, rec);
    },

    async status(requestId: string): Promise<SwapStatus> {
      const r = records.get(requestId);
      return r ? view(requestId, r) : { state: "failed", requestId, detail: "unknown request" };
    },

    async confidentialHoldings() {
      if (o.confidentialReadsBeforeFailure !== undefined && confidentialReads++ >= o.confidentialReadsBeforeFailure) throw new Error("confidential balance unavailable");
      return positive(held.confidential);
    },

    async shield(token: string, amount: string): Promise<SwapStatus> {
      const id = `mock-req-${++n}`;
      if ((held.public[token] ?? 0n) < BigInt(amount)) return { state: "failed", requestId: id, detail: "insufficient balance" };
      held.public[token] = (held.public[token] ?? 0n) - BigInt(amount);
      held.confidential[token] = (held.confidential[token] ?? 0n) + BigInt(amount);
      return { state: "success", requestId: id };
    },

    async withdraw(w: WithdrawParams): Promise<SwapStatus> {
      const id = `mock-req-${++n}`;
      if ((held[w.venue][w.token] ?? 0n) < BigInt(w.amount)) return { state: "failed", requestId: id, detail: "insufficient balance" };
      held[w.venue][w.token] = (held[w.venue][w.token] ?? 0n) - BigInt(w.amount);
      withdrawals.push(w);
      return { state: "success", requestId: id };
    },
  };

  const auditor: ExecutionAuditor = {
    async audit(depositAddress: string) {
      return o.unauditable ? null : (executed.get(depositAddress) ?? null);
    },
  };

  return {
    quoter,
    custody,
    auditor,
    /** Test helper: the owner "approves" a pending request. */
    approve(requestId: string) {
      const r = records.get(requestId);
      if (!r || r.state !== "pending_approval") return;
      r.state = "success";
      apply(r.venue, r.done);
    },
    /** The vault's public-layer balances, moved by mock swaps. */
    balances: { async holdings() { return positive(held.public); } } as BalanceReader,
    swaps,
    /** The layer each swap ran in, in order. */
    venues,
    withdrawals,
  };
}
