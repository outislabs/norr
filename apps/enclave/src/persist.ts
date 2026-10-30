import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Book, DayPnl, DaySum, Fill } from "@norr/core";
import { Policy } from "@norr/shared";
import { MemoryVaultStore, type Ledger, type LedgerEntry, type Vault } from "./state";

/**
 * Durable state for the live service and the live runner. Both open the same data directory, so a
 * trade made by either shows up in the other, and a restart does not reset the caps (a reset would
 * let a vault spend its daily cap again, so unreadable state stops startup instead of being ignored).
 *
 * Not encrypted yet: the files are 0600 and the directory is gitignored, but the planned privacy layer
 * (encrypted owner-only log inside the TEE) is what makes this private; see docs/PRIVACY.md.
 */

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** A directory lock (mkdir is atomic) so two processes do not interleave read-modify-write cycles. */
function withLock<T>(dir: string, fn: () => T): T {
  const lock = join(dir, ".lock");
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (Date.now() > deadline) {
        rmSync(lock, { recursive: true, force: true }); // stale: a holder never keeps it for seconds
        continue;
      }
      sleepSync(10);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

interface SavedVault {
  policy: Policy;
  pauseReason: string | null;
  lastTradeAtMs: number | null;
  book: Book;
  pnl: DayPnl;
  spend: DaySum;
}

/** The vault store with its mutable state kept in `<dir>/vaults/<id>.json`, re-read before every use. */
export class FileVaultStore extends MemoryVaultStore {
  private readonly dir: string;

  /**
   * Saved state wins over the policy the vault was created with: owner edits and the kill switch
   * must survive a restart. To start from the policy file again, delete the vault's state file.
   */
  constructor(dir: string, vaults: Vault[]) {
    super(vaults);
    this.dir = join(dir, "vaults");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    for (const v of vaults) withLock(this.dir, () => (this.load(v.id) ? undefined : this.save(v.id)));
  }

  private path(id: string): string {
    return join(this.dir, `${encodeURIComponent(id)}.json`);
  }

  /** Copy the saved state into the in-memory vault. Returns false when nothing was saved yet. */
  private load(id: string): boolean {
    const v = super.get(id);
    const file = this.path(id);
    if (!v || !existsSync(file)) return false;
    let saved: SavedVault;
    try {
      saved = JSON.parse(readFileSync(file, "utf8")) as SavedVault;
      saved.policy = { ...Policy.parse(saved.policy), vaultId: v.id };
    } catch (e) {
      throw new Error(`Saved state for vault "${id}" is unreadable (${file}). Not starting, because ignoring it would reset the vault's caps. Fix or restore the file. (${e instanceof Error ? e.message : String(e)})`);
    }
    v.policy = saved.policy;
    v.book = saved.book;
    v.pnl = saved.pnl;
    v.spend = saved.spend;
    v.state = { ...v.state, lastTradeAtMs: saved.lastTradeAtMs };
    if (saved.pauseReason !== null) this.pauseReasons.set(id, saved.pauseReason);
    else this.pauseReasons.delete(id);
    return true;
  }

  private save(id: string): void {
    const v = super.get(id);
    if (!v) return;
    const saved: SavedVault = { policy: v.policy, pauseReason: this.pauseReasons.get(id) ?? null, lastTradeAtMs: v.state.lastTradeAtMs, book: v.book, pnl: v.pnl, spend: v.spend };
    writeAtomic(this.path(id), JSON.stringify(saved, null, 2));
  }

  /** Reload, apply one change, write back, all under the lock. */
  private mutate(id: string, change: () => void): void {
    withLock(this.dir, () => {
      this.load(id);
      change();
      this.save(id);
    });
  }

  override get(id: string): Vault | undefined {
    withLock(this.dir, () => this.load(id));
    return super.get(id);
  }

  override list(): Vault[] {
    return super.list().map((v) => this.get(v.id)!);
  }

  override setPolicy(id: string, policy: Policy): void {
    this.mutate(id, () => super.setPolicy(id, policy));
  }

  override pause(id: string, reason: string): void {
    this.mutate(id, () => super.pause(id, reason));
  }

  override resume(id: string): void {
    this.mutate(id, () => super.resume(id));
  }

  override recordTrade(id: string, atMs: number): void {
    this.mutate(id, () => super.recordTrade(id, atMs));
  }

  override recordFill(id: string, fill: Fill, atMs: number): void {
    this.mutate(id, () => super.recordFill(id, fill, atMs));
  }

  override reserveSpend(id: string, usd: number, atMs: number): string {
    let day = "";
    this.mutate(id, () => (day = super.reserveSpend(id, usd, atMs)));
    return day;
  }

  override releaseSpend(id: string, day: string, usd: number): void {
    this.mutate(id, () => super.releaseSpend(id, day, usd));
  }
}

type LedgerOp = { op: "append"; entry: LedgerEntry } | { op: "update"; id: string; patch: Partial<Omit<LedgerEntry, "id">> };

/**
 * An append-only ledger in `<dir>/ledger.jsonl`. Updates are written as further lines and folded in
 * on read; every read re-reads the file, so the service sees entries the live runner wrote.
 */
export class FileLedger implements Ledger {
  private readonly file: string;

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, "ledger.jsonl");
    if (!existsSync(this.file)) writeFileSync(this.file, "", { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }

  private write(op: LedgerOp): void {
    withLock(this.dir, () => appendFileSync(this.file, `${JSON.stringify(op)}\n`));
  }

  private rows(): LedgerEntry[] {
    const byId = new Map<string, LedgerEntry>();
    const lines = readFileSync(this.file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      let op: LedgerOp;
      try {
        op = JSON.parse(line) as LedgerOp;
      } catch {
        throw new Error(`Ledger ${this.file} is unreadable at line ${i + 1}. Not continuing, because the log feeds the caps.`);
      }
      if (op.op === "append") byId.set(op.entry.id, op.entry);
      else {
        const row = byId.get(op.id);
        if (row) byId.set(op.id, { ...row, ...op.patch });
      }
    });
    return [...byId.values()];
  }

  append(entry: Omit<LedgerEntry, "id">): LedgerEntry {
    const row: LedgerEntry = { ...entry, id: `led-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}` };
    this.write({ op: "append", entry: row });
    return row;
  }

  update(id: string, patch: Partial<Omit<LedgerEntry, "id">>): void {
    this.write({ op: "update", id, patch });
  }

  get(id: string): LedgerEntry | undefined {
    return this.rows().find((r) => r.id === id);
  }

  list(vaultId: string): LedgerEntry[] {
    return this.rows().filter((r) => r.vaultId === vaultId);
  }
}

/** Where the live service and runner keep their durable state. */
export const dataDir = (env: NodeJS.ProcessEnv): string => env.NORR_DATA_DIR || join(process.cwd(), "data");
