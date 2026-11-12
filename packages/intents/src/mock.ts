import { unitsToNumber, usdToUnits, type ExecutedSwap, type RegistryEntry, type SwapBounds } from "@norr/core";
import type { BalanceReader } from "./balances";
import type { Custody, DepositOffer, DepositParams, DepositQuoter, DepositRequest, ExecutionAuditor, Quote, QuoteParams, Quoter, SwapStatus, Venue, WithdrawParams } from "./types";

/**
 * Mock rails for NORR_MOCK=1: prices come from the registry, fees are fixed, nothing leaves the process.
 * Two balance layers (public and confidential) behave like the real ones. Test hooks let tests exercise
 * every outcome: no liquidity, price skew, approvals, a tampering gateway, an unreadable audit trail.
 */
export interface MockOptions {
  /** The custody policy's address whitelist (default: the mock policy has no address rule). */
  addressList?: string[];
  /** Make reading the custody policy fail with this message. */
  addressPolicyError?: string;
  feeBps?: number;
  /** Return false to simulate no liquidity for an asset (both layers). */
  liquidity?: (assetId: string) => boolean;
  /** Return false to simulate no liquidity for an asset in the confidential layer only. */
  confidentialLiquidity?: (assetId: string) => boolean;
  /** Smallest order (USD) that quotes for an asset, either side of the pair. Simulates the real minimums. */
  minOrderUsd?: (assetId: string) => number;
  /** Skew every quoted price (basis points) to exercise the price-sanity check. */
  skewBps?: number;
  requireApproval?: boolean | (() => boolean);
  /** Distinguishes approval ids when several mock vaults run side by side (8 hex characters). Default "00000000". */
  approvalPrefix?: string;
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
  state: "pending_approval" | "success" | "failed";
  depositAddress?: string;
  /** Mock stand-in for the custody provider's approval record (see approvalDetail). */
  approvalId?: string;
  createdAt?: number;
  /** A shield (public into confidential, same token) rather than a swap. */
  shield?: boolean;
  /** A withdrawal to a whitelisted account rather than a swap. */
  withdraw?: WithdrawParams;
}

const toLayer = (m: Record<string, string> | undefined): Layer => Object.fromEntries(Object.entries(m ?? {}).map(([k, v]) => [k, BigInt(v)]));
const positive = (l: Layer): Record<string, string> => Object.fromEntries(Object.entries(l).filter(([, v]) => v > 0n).map(([k, v]) => [k, v.toString()]));

export function createMockRails(entries: RegistryEntry[], vaultAccount: string, o: MockOptions = {}) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const feeBps = o.feeBps ?? 30;
  /** The owner's approval requirement can change while the mock runs (the vault's custody mode is switched). */
  const needsApproval = (): boolean => (typeof o.requireApproval === "function" ? o.requireApproval() : Boolean(o.requireApproval));
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
      if (o.minOrderUsd && usdIn < Math.max(o.minOrderUsd(a.id), o.minOrderUsd(b.id))) return null;
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
      const rec: Record_ = { venue, done, state: needsApproval() ? "pending_approval" : "success", depositAddress, ...(needsApproval() ? { approvalId: `${o.approvalPrefix ?? "00000000"}-0000-4000-8000-${String(n).padStart(12, "0")}`, createdAt: Date.now() } : {}) };
      records.set(id, rec);
      if (rec.state === "success") apply(venue, done);
      return view(id, rec);
    },

    async addressPolicy() {
      if (o.addressPolicyError) throw new Error(o.addressPolicyError);
      return o.addressList ? { mode: "whitelist" as const, list: o.addressList } : { mode: "none" as const, list: [] };
    },

    async approvalMode() {
      return needsApproval() ? ("owner" as const) : ("none" as const);
    },

    async status(requestId: string): Promise<SwapStatus> {
      const r = records.get(requestId);
      return r ? view(requestId, r) : { state: "failed", requestId, detail: "unknown request" };
    },

    async pendingApprovals() {
      return [...records].filter(([, r]) => r.state === "pending_approval" && r.approvalId).map(([id, r]) => ({ approvalId: r.approvalId!, requestId: id, type: r.venue === "confidential" ? "confidential" : "swap", expiresAt: new Date((r.createdAt ?? Date.now()) + 24 * 3600_000).toISOString() }));
    },

    async confidentialHoldings() {
      if (o.confidentialReadsBeforeFailure !== undefined && confidentialReads++ >= o.confidentialReadsBeforeFailure) throw new Error("confidential balance unavailable");
      return positive(held.confidential);
    },

    async shield(token: string, amount: string): Promise<SwapStatus> {
      const id = `mock-req-${++n}`;
      if ((held.public[token] ?? 0n) < BigInt(amount)) return { state: "failed", requestId: id, detail: "insufficient balance" };
      if (needsApproval()) {
        records.set(id, { venue: "confidential", shield: true, done: { tokenIn: token, tokenOut: token, amountIn: amount, amountOut: amount, recipient: vaultAccount }, state: "pending_approval", approvalId: `${o.approvalPrefix ?? "00000000"}-0000-4000-8000-${String(n).padStart(12, "0")}`, createdAt: Date.now() });
        return { state: "pending_approval", requestId: id };
      }
      held.public[token] = (held.public[token] ?? 0n) - BigInt(amount);
      held.confidential[token] = (held.confidential[token] ?? 0n) + BigInt(amount);
      return { state: "success", requestId: id };
    },

    async requestConfidentialDeposit(_token: string, amount: string): Promise<DepositRequest> {
      const k = ++n;
      return { intentId: `mock-intent-${k}`, depositAddress: `mock${k.toString(16).padStart(60, "0")}`, amount, minAmountOut: ((BigInt(amount) * 99n) / 100n).toString() };
    },

    async withdraw(w: WithdrawParams): Promise<SwapStatus> {
      const id = `mock-req-${++n}`;
      if ((held[w.venue][w.token] ?? 0n) < BigInt(w.amount)) return { state: "failed", requestId: id, detail: "insufficient balance" };
      if (w.venue === "confidential" && needsApproval()) {
        records.set(id, { venue: "confidential", withdraw: w, done: { tokenIn: w.token, tokenOut: w.token, amountIn: w.amount, amountOut: w.amount, recipient: w.to }, state: "pending_approval", approvalId: `${o.approvalPrefix ?? "00000000"}-0000-4000-8000-${String(n).padStart(12, "0")}`, createdAt: Date.now() });
        return { state: "pending_approval", requestId: id };
      }
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

  const funder: DepositQuoter = {
    async requestDeposit(p: DepositParams): Promise<DepositOffer> {
      const k = ++n;
      // Same asset: what goes in comes out. Another asset: Norr's own estimate stands in for the route.
      const out = (p.originAsset ?? p.token) === p.token ? p.amount : (p.expectedOut ?? p.amount);
      // The address has the shape of the origin chain's (1Click issues it there): NEAR-style, EVM, or Solana base58.
      const origin = p.originAsset ?? p.token;
      const depositAddress = origin === p.token ? `mockdep${k.toString(16).padStart(56, "0")}` : /(^|[:.-])sol([.-]|$)/.test(origin) ? `MockDep${"1".repeat(30)}${k.toString().padStart(5, "1").replace(/0/g, "2")}` : `0x${k.toString(16).padStart(40, "0")}`;
      return { depositAddress, amountIn: p.amount, amountOut: out, minAmountOut: ((BigInt(out) * 99n) / 100n).toString(), deadline: new Date(Date.now() + 30 * 60_000).toISOString() };
    },
  };

  return {
    quoter,
    funder,
    custody,
    auditor,
    /** Test helper: the owner "approves" a pending request. */
    approve(requestId: string) {
      const r = records.get(requestId);
      if (!r || r.state !== "pending_approval") return;
      r.state = "success";
      if (r.withdraw) {
        held[r.withdraw.venue][r.withdraw.token] = (held[r.withdraw.venue][r.withdraw.token] ?? 0n) - BigInt(r.withdraw.amount);
        withdrawals.push(r.withdraw);
      } else if (r.shield) {
        held.public[r.done.tokenIn] = (held.public[r.done.tokenIn] ?? 0n) - BigInt(r.done.amountIn);
        held.confidential[r.done.tokenIn] = (held.confidential[r.done.tokenIn] ?? 0n) + BigInt(r.done.amountIn);
      } else apply(r.venue, r.done);
    },
    /** Test helper: the owner rejects a pending request; nothing moves. */
    reject(requestId: string) {
      const r = records.get(requestId);
      if (r && r.state === "pending_approval") r.state = "failed";
    },
    /**
     * The mock's version of the custody provider's public approval record: the canonical operation (what the owner
     * signs the hash of) and the request it releases. Shaped like OutLayer's GET /wallet/v1/approval/{id}.
     */
    approvalDetail(approvalId: string) {
      const hit = [...records].find(([, r]) => r.approvalId === approvalId);
      if (!hit) return null;
      const [requestId, r] = hit;
      const op = r.withdraw
        ? { kind: "confidential", flow: "withdraw", token: r.withdraw.token, amount: r.withdraw.amount, to: r.withdraw.to, chain: r.withdraw.chain }
        : r.shield
        ? { kind: "confidential", flow: "shield", token: r.done.tokenIn, amount: r.done.amountIn }
        : { type: r.venue === "confidential" ? "confidential_swap" : "swap", token_in: r.done.tokenIn, amount_in: r.done.amountIn, token_out: r.done.tokenOut, recipient: r.done.recipient };
      return { requestId, status: r.state === "pending_approval" ? "pending" : r.state === "success" ? "approved" : "rejected", opCanonical: JSON.stringify(op), requestType: r.venue === "confidential" ? "confidential" : "swap", expiresAt: new Date((r.createdAt ?? Date.now()) + 24 * 3600_000).toISOString() };
    },
    /** Test helper: a direct deposit on NEAR "arrives" in the vault's public layer. */
    creditPublic(token: string, amount: string) {
      held.public[token] = (held.public[token] ?? 0n) + BigInt(amount);
    },
    /** Test helper: the owner's deposit "arrives" in the confidential layer. */
    creditConfidential(token: string, amount: string) {
      held.confidential[token] = (held.confidential[token] ?? 0n) + BigInt(amount);
    },
    /** The vault's public-layer balances, moved by mock swaps. */
    balances: { async holdings() { return positive(held.public); } } as BalanceReader,
    swaps,
    /** The layer each swap ran in, in order. */
    venues,
    withdrawals,
  };
}
