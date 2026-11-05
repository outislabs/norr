import { addRealized, addToDay, applyFill, dayKey, emptyDay, releaseFromDay, type Book, type DayPnl, type DaySum, type Fill, type VaultState } from "@norr/core";
import type { Custody } from "@norr/intents";
import type { Decision, Policy, TradeRequest } from "@norr/shared";
import type { BookRepair } from "./book-repair";
import type { SealedReason } from "./seal";
import type { PendingSettlement } from "./trade";

/** One Norr vault: its private policy and state, and the custody wallet behind it. */
export interface Vault {
  id: string;
  /** What the owner calls it ("Claude's NVDA fund"). Shown instead of the id. */
  name?: string;
  /** The NEAR account that owns this vault: the only account that can sign in to manage it. */
  owner: string;
  policy: Policy;
  state: VaultState;
  custody: Custody;
  /** The vault's Intents account id (the custody wallet's account). */
  walletAccount: string;
  /** Average-cost positions for realized P&L. */
  book: Book;
  /** Net realized P&L for the current UTC day. */
  pnl: DayPnl;
  /** Buys today (UTC), reserved when a swap is sent, for the daily spend cap. */
  spend: DaySum;
  /** Set once the one-off cost-book repair has run (see book-repair.ts); it never runs again. */
  bookRepair?: BookRepair;
}

export interface VaultStore {
  /** Add a vault (a self-serve vault once activated). Saved state for its id, if any, wins over what is passed. */
  add(v: Vault): void;
  get(id: string): Vault | undefined;
  list(): Vault[];
  /** Replace the vault's Norr policy (owner action). The vault id cannot change. */
  setPolicy(id: string, policy: Policy): void;
  /** The owner's name for the vault. */
  setName(id: string, name: string): void;
  /** The kill switch. Also used when a post-trade check fails. */
  pause(id: string, reason: string): void;
  resume(id: string): void;
  recordTrade(id: string, atMs: number): void;
  /** Update positions and the day's realized P&L after a verified fill. */
  recordFill(id: string, fill: Fill, atMs: number): void;
  refresh(id: string, patch: Partial<VaultState>): void;
  /** Count a buy against today's spend cap. Returns the UTC day it was counted on, for a later release. */
  reserveSpend(id: string, usd: number, atMs: number): string;
  /** Give a reservation back when the swap definitely did not run. */
  releaseSpend(id: string, day: string, usd: number): void;
  /** Run the one-off cost-book repair if it has not run yet. `rebuild` returns the corrected book and its record, or null to leave it. */
  repairBookOnce(id: string, rebuild: (v: Vault) => { book: Book; record: BookRepair } | null): BookRepair | null;
}

export interface LedgerEntry {
  id: string;
  vaultId: string;
  at: number;
  request: TradeRequest;
  decision: Decision;
  /** The agent's stated reasoning, sealed so only the owner can read it. `request.reason` is always empty once stored. */
  sealedReason?: SealedReason;
  /** Set while a swap waits for owner approval, so it can be settled later. */
  pending?: PendingSettlement;
  /** Why a vault was paused, if this entry caused it. Owner-readable only. */
  note?: string;
}

export interface Ledger {
  append(entry: Omit<LedgerEntry, "id">): LedgerEntry;
  update(id: string, patch: Partial<Omit<LedgerEntry, "id">>): void;
  get(id: string): LedgerEntry | undefined;
  list(vaultId: string): LedgerEntry[];
}

export const newVault = (v: Omit<Vault, "book" | "pnl" | "spend">, nowMs: number): Vault => ({ ...v, book: {}, pnl: { day: dayKey(nowMs), netUsd: 0 }, spend: emptyDay(nowMs) });

export class MemoryVaultStore implements VaultStore {
  private readonly vaults = new Map<string, Vault>();
  readonly pauseReasons = new Map<string, string>();

  constructor(vaults: Vault[] = []) {
    for (const v of vaults) this.vaults.set(v.id, v);
  }

  add(v: Vault): void {
    this.vaults.set(v.id, v);
  }

  get(id: string): Vault | undefined {
    return this.vaults.get(id);
  }

  list(): Vault[] {
    return [...this.vaults.values()];
  }

  setPolicy(id: string, policy: Policy): void {
    const v = this.vaults.get(id);
    if (v) v.policy = { ...policy, vaultId: v.id };
  }

  setName(id: string, name: string): void {
    const v = this.vaults.get(id);
    if (v) v.name = name;
  }

  pause(id: string, reason: string): void {
    const v = this.vaults.get(id);
    if (!v) return;
    v.policy = { ...v.policy, paused: true };
    this.pauseReasons.set(id, reason);
  }

  resume(id: string): void {
    const v = this.vaults.get(id);
    if (!v) return;
    v.policy = { ...v.policy, paused: false };
    this.pauseReasons.delete(id);
  }

  repairBookOnce(id: string, rebuild: (v: Vault) => { book: Book; record: BookRepair } | null): BookRepair | null {
    const v = this.vaults.get(id);
    if (!v || v.bookRepair) return null;
    const r = rebuild(v);
    if (!r) return null;
    v.book = r.book;
    v.bookRepair = r.record;
    return r.record;
  }

  recordTrade(id: string, atMs: number): void {
    const v = this.vaults.get(id);
    if (v) v.state = { ...v.state, lastTradeAtMs: atMs };
  }

  recordFill(id: string, fill: Fill, atMs: number): void {
    const v = this.vaults.get(id);
    if (!v) return;
    const r = applyFill(v.book, fill);
    v.book = r.book;
    v.pnl = addRealized(v.pnl, atMs, r.realizedUsd);
  }

  reserveSpend(id: string, usd: number, atMs: number): string {
    const v = this.vaults.get(id);
    if (!v) return dayKey(atMs);
    v.spend = addToDay(v.spend, atMs, usd);
    return v.spend.day;
  }

  releaseSpend(id: string, day: string, usd: number): void {
    const v = this.vaults.get(id);
    if (v) v.spend = releaseFromDay(v.spend, day, usd);
  }

  refresh(id: string, patch: Partial<VaultState>): void {
    const v = this.vaults.get(id);
    if (v) v.state = { ...v.state, ...patch };
  }
}

export class MemoryLedger implements Ledger {
  private readonly rows: LedgerEntry[] = [];
  private seq = 0;

  append(entry: Omit<LedgerEntry, "id">): LedgerEntry {
    const row = { ...entry, id: `led-${++this.seq}` };
    this.rows.push(row);
    return row;
  }

  update(id: string, patch: Partial<Omit<LedgerEntry, "id">>): void {
    const i = this.rows.findIndex((r) => r.id === id);
    const row = this.rows[i];
    if (row) this.rows[i] = { ...row, ...patch };
  }

  get(id: string): LedgerEntry | undefined {
    return this.rows.find((r) => r.id === id);
  }

  list(vaultId: string): LedgerEntry[] {
    return this.rows.filter((r) => r.vaultId === vaultId);
  }
}
