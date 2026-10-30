import type { Decision, Policy, TradeRequest } from "@norr/shared";
import type { PendingSettlement } from "./trade";
import type { VaultState } from "@norr/core";
import type { Custody } from "@norr/intents";

/** One Norr vault: its private policy and state, and the custody wallet behind it. */
export interface Vault {
  id: string;
  policy: Policy;
  state: VaultState;
  custody: Custody;
  /** The vault's Intents account id (the custody wallet's account). */
  walletAccount: string;
}

export interface VaultStore {
  get(id: string): Vault | undefined;
  /** The kill switch. Also used when a post-trade check fails. */
  pause(id: string, reason: string): void;
  recordTrade(id: string, atMs: number): void;
}

export interface LedgerEntry {
  id: string;
  vaultId: string;
  at: number;
  request: TradeRequest;
  decision: Decision;
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

  pause(id: string, reason: string): void {
    const v = this.vaults.get(id);
    if (!v) return;
    v.policy = { ...v.policy, paused: true };
    this.pauseReasons.set(id, reason);
  }

  recordTrade(id: string, atMs: number): void {
    const v = this.vaults.get(id);
    if (v) v.state = { ...v.state, lastTradeAtMs: atMs };
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
