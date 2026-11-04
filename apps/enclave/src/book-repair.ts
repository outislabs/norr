import { applyFill, type Book } from "@norr/core";
import type { Ledger, LedgerEntry, VaultStore } from "./state";

/**
 * One-off repair of a vault's cost book (2026-11-04). Before the ledger fix in e5e0917, a settled confidential swap kept
 * its pending marker on disk and was settled again on owner reads, adding the same fill to the book each time. The
 * ledger was right (one row per trade), so the book is rebuilt from it with the same average-cost rule. The P&L report
 * and the activity view already replay the ledger this way; only the book the loss cap uses had drifted.
 */
export interface BookRepair {
  at: string;
  /** Position by symbol before and after: quantity, cost and average cost. */
  before: Record<string, Position>;
  after: Record<string, Position>;
  /** Executed ledger rows the book was rebuilt from. */
  fills: number;
}

export interface Position {
  qty: number;
  costUsd: number;
  avgCostUsd: number | null;
}

export type RebuildResult = { ok: true; book: Book } | { ok: false; reason: string };

/** The book an executed-trade ledger implies. `idOf` maps a filled symbol (e.g. "NVDAon") to its asset id. */
export function bookFromLedger(rows: LedgerEntry[], idOf: (symbol: string) => string | undefined): RebuildResult & { fills: number } {
  let book: Book = {};
  let fills = 0;
  for (const r of rows) {
    if (r.decision.status !== "executed") continue;
    const { asset, amount, priceUsd } = r.decision.filled;
    const assetId = idOf(asset);
    if (!assetId) return { ok: false, reason: `no asset id for ${asset}`, fills };
    const qty = Number(amount);
    if (!(qty > 0) || !Number.isFinite(priceUsd)) return { ok: false, reason: `unusable fill in ${r.id}`, fills };
    book = applyFill(book, { assetId, side: r.request.side, qty, usd: qty * priceUsd }).book;
    fills++;
  }
  return { ok: true, book, fills };
}

/** A readable view of a book, by symbol, for the before/after record. */
export function describeBook(book: Book, symbolOf: (assetId: string) => string): Record<string, Position> {
  const out: Record<string, Position> = {};
  for (const [id, p] of Object.entries(book)) {
    if (p.qty === 0 && p.costUsd === 0) continue;
    out[symbolOf(id)] = { qty: p.qty, costUsd: p.costUsd, avgCostUsd: p.qty > 0 ? p.costUsd / p.qty : null };
  }
  return out;
}

/** What the repair needs from the service. */
export interface BookRepairDeps {
  vaults: VaultStore;
  ledger: Ledger;
  registry: { byId(id: string): { symbol: string } | undefined; entries(): { id: string; symbol: string }[] };
  now: () => number;
}

/**
 * Run the repair for one vault, once. A symbol maps to the asset id the book already uses for it, or else to the only
 * registry entry with that symbol; anything ambiguous or unknown leaves the book untouched (and the repair unrecorded,
 * so it can run again after a fix).
 */
export function repairBook(deps: BookRepairDeps, vaultId: string): BookRepair | null {
  const symbolOf = (id: string) => deps.registry.byId(id)?.symbol ?? id;
  return deps.vaults.repairBookOnce(vaultId, (v) => {
    const idOf = (symbol: string): string | undefined => {
      const held = Object.keys(v.book).filter((id) => symbolOf(id) === symbol);
      if (held.length === 1) return held[0];
      const listed = deps.registry.entries().filter((e) => e.symbol === symbol);
      return listed.length === 1 ? listed[0]!.id : undefined;
    };
    const r = bookFromLedger(deps.ledger.list(vaultId), idOf);
    if (!r.ok) return null;
    return { book: r.book, record: { at: new Date(deps.now()).toISOString(), before: describeBook(v.book, symbolOf), after: describeBook(r.book, symbolOf), fills: r.fills } };
  });
}
