import { unitsToNumber, usdToUnits, type ExecutedSwap, type RegistryEntry, type SwapBounds } from "@norr/core";
import type { BalanceReader } from "./balances";
import type { Custody, ExecutionAuditor, Quote, QuoteParams, Quoter, SwapStatus } from "./types";

/**
 * Mock rails for NORR_MOCK=1: prices come from the registry, fees are fixed, nothing leaves the process.
 * Test hooks (`liquidity`, `requireApproval`, `tamper`, `unauditable`) let tests exercise every outcome.
 */
export interface MockOptions {
  feeBps?: number;
  /** Return false to simulate no liquidity for an asset. */
  liquidity?: (assetId: string) => boolean;
  /** Skew every quoted price (basis points) to exercise the price-sanity check. */
  skewBps?: number;
  requireApproval?: boolean;
  /** Alter what the swap "actually did", to simulate a tampering gateway. */
  tamper?: (executed: ExecutedSwap) => ExecutedSwap;
  /** The independent status endpoint cannot be reached. */
  unauditable?: boolean;
  /** Make the custody call itself fail. */
  swapError?: Error;
  /** Starting Intents balances for the vault: asset id to smallest units. */
  seed?: Record<string, string>;
}

export function createMockRails(entries: RegistryEntry[], vaultAccount: string, o: MockOptions = {}) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const feeBps = o.feeBps ?? 30;
  const executed = new Map<string, ExecutedSwap>();
  const requests = new Map<string, SwapStatus>();
  const swaps: SwapBounds[] = [];
  const held: Record<string, bigint> = Object.fromEntries(Object.entries(o.seed ?? {}).map(([k, v]) => [k, BigInt(v)]));
  let n = 0;

  const quoter: Quoter = {
    async quote(p: QuoteParams): Promise<Quote | null> {
      const a = byId.get(p.tokenIn);
      const b = byId.get(p.tokenOut);
      if (!a || !b || a.priceUsd === null || b.priceUsd === null) return null;
      if (o.liquidity && !(o.liquidity(a.id) && o.liquidity(b.id))) return null;
      const usdIn = unitsToNumber(p.amountIn, a.decimals) * a.priceUsd;
      const usdOut = (usdIn * (1 - feeBps / 10_000)) * (1 + (o.skewBps ?? 0) / 10_000);
      const amountOut = usdToUnits(usdOut, b.priceUsd, b.decimals);
      return {
        amountIn: p.amountIn,
        amountOut,
        minAmountOut: ((BigInt(amountOut) * 99n) / 100n).toString(),
        amountInUsd: usdIn,
        amountOutUsd: usdOut,
      };
    },
  };

  const custody: Custody = {
    async accountId() {
      return vaultAccount;
    },
    async swap(bounds: SwapBounds): Promise<SwapStatus> {
      if (o.swapError) throw o.swapError;
      swaps.push(bounds);
      const id = `mock-req-${++n}`;
      if ((held[bounds.tokenIn] ?? 0n) < BigInt(bounds.amountIn)) {
        const st: SwapStatus = { state: "failed", requestId: id, detail: "insufficient balance" };
        requests.set(id, st);
        return st;
      }
      const q = await quoter.quote({ tokenIn: bounds.tokenIn, tokenOut: bounds.tokenOut, amountIn: bounds.amountIn, recipient: vaultAccount });
      const depositAddress = `mock-deposit-${n}`;
      const real: ExecutedSwap = {
        tokenIn: bounds.tokenIn,
        tokenOut: bounds.tokenOut,
        amountIn: bounds.amountIn,
        amountOut: q?.amountOut ?? "0",
        recipient: vaultAccount,
      };
      const done = o.tamper ? o.tamper(real) : real;
      executed.set(depositAddress, done);
      if (!o.requireApproval) {
        held[done.tokenIn] = (held[done.tokenIn] ?? 0n) - BigInt(done.amountIn);
        held[done.tokenOut] = (held[done.tokenOut] ?? 0n) + BigInt(done.amountOut);
      }
      const st: SwapStatus = o.requireApproval
        ? { state: "pending_approval", requestId: id, depositAddress }
        : { state: "success", requestId: id, depositAddress };
      requests.set(id, st);
      return st;
    },
    async status(requestId: string): Promise<SwapStatus> {
      return requests.get(requestId) ?? { state: "failed", requestId, detail: "unknown request" };
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
      const st = requests.get(requestId);
      if (!st) return;
      requests.set(requestId, { ...st, state: "success" });
      const done = st.depositAddress ? executed.get(st.depositAddress) : undefined;
      if (done) {
        held[done.tokenIn] = (held[done.tokenIn] ?? 0n) - BigInt(done.amountIn);
        held[done.tokenOut] = (held[done.tokenOut] ?? 0n) + BigInt(done.amountOut);
      }
    },
    /** The vault's balances, moved by mock swaps. */
    balances: {
      async holdings() {
        return Object.fromEntries(Object.entries(held).filter(([, v]) => v > 0n).map(([k, v]) => [k, v.toString()]));
      },
    } as BalanceReader,
    swaps,
  };
}
