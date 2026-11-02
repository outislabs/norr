import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./persist";
import type { DataCipher } from "./seal";

/** One reading of a vault's value, taken by the service. Never leaves the service except to the vault's owner. */
export interface ValuePoint {
  /** Epoch ms. */
  t: number;
  totalUsd: number;
  cryptoUsd: number;
  equityUsd: number;
}

export interface ValueHistory {
  /** Adds a reading unless one was taken less than `minGapMs` ago. Returns whether it was kept. */
  record(vaultId: string, p: ValuePoint): boolean;
  list(vaultId: string): ValuePoint[];
}

export const MAX_POINTS = 1000;
export const MIN_GAP_MS = 10 * 60_000;

export class MemoryValueHistory implements ValueHistory {
  protected readonly points = new Map<string, ValuePoint[]>();
  constructor(private readonly minGapMs = MIN_GAP_MS) {}

  record(vaultId: string, p: ValuePoint): boolean {
    const list = this.points.get(vaultId) ?? [];
    const last = list[list.length - 1];
    if (last && p.t - last.t < this.minGapMs) return false;
    list.push(p);
    if (list.length > MAX_POINTS) list.splice(0, list.length - MAX_POINTS);
    this.points.set(vaultId, list);
    this.saved(vaultId, list);
    return true;
  }

  list(vaultId: string): ValuePoint[] {
    return [...(this.points.get(vaultId) ?? [])];
  }

  protected saved(_vaultId: string, _list: ValuePoint[]): void {}
}

/** Same, kept encrypted on disk with the service's data key (a balance history is exactly what must not sit in the clear). */
export class FileValueHistory extends MemoryValueHistory {
  private readonly dir: string;
  constructor(dataDir: string, private readonly cipher: DataCipher, minGapMs?: number) {
    super(minGapMs);
    this.dir = join(dataDir, "history");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  private path(id: string): string {
    return join(this.dir, `${encodeURIComponent(id)}.json`);
  }

  override list(vaultId: string): ValuePoint[] {
    if (!this.points.has(vaultId)) this.points.set(vaultId, this.load(vaultId));
    return super.list(vaultId);
  }

  override record(vaultId: string, p: ValuePoint): boolean {
    this.list(vaultId); // load what is on disk before appending
    return super.record(vaultId, p);
  }

  protected override saved(vaultId: string, list: ValuePoint[]): void {
    writeAtomic(this.path(vaultId), JSON.stringify({ v: 1, ...this.cipher.encrypt(JSON.stringify(list), `history:${vaultId}`) }));
  }

  private load(vaultId: string): ValuePoint[] {
    const file = this.path(vaultId);
    if (!existsSync(file)) return [];
    const box = JSON.parse(readFileSync(file, "utf8")) as { iv: string; ct: string };
    return JSON.parse(this.cipher.decrypt(box, `history:${vaultId}`)) as ValuePoint[];
  }
}
