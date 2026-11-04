import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Custody } from "@norr/intents";
import { describe, expect, it } from "vitest";
import { bookFromLedger, repairBook } from "./book-repair";
import { createApp } from "./app";
import { NVDA_ON, SOL, WALLET, harness, policy, req } from "./fixtures";
import { FileLedger, FileVaultStore } from "./persist";
import { DataCipher } from "./seal";
import { newVault } from "./state";

const T0 = Date.UTC(2026, 10, 4, 12);
const fill = (qty: number, usd: number) => ({ assetId: NVDA_ON.assetId, side: "buy" as const, qty, usd });
const executed = (symbol: string, amount: number, priceUsd: number, side: "buy" | "sell" = "buy") => ({
  vaultId: "v1", at: T0, request: req({ side, asset: symbol, amountUsd: amount * priceUsd }),
  decision: { status: "executed" as const, txRef: "t", filled: { asset: symbol, amount: String(amount), priceUsd } },
});

describe("one-off cost-book repair (duplicate fills from re-settled swaps)", () => {
  it("rebuilds the book from the ledger: duplicates go, the real position and average cost stay, and it records before/after", () => {
    const h = harness();
    h.ledger.append(executed("NVDAon", 0.026128, 210.6272));
    // The bug: the same settled swap booked three times.
    for (let i = 0; i < 3; i++) h.vaults.recordFill("v1", fill(0.026128, 0.026128 * 210.6272), T0);
    const r = repairBook({ vaults: h.vaults, ledger: h.ledger, registry: h.deps.registry, now: () => T0 }, "v1")!;
    expect(r.fills).toBe(1);
    expect(r.before.NVDAon!.qty).toBeCloseTo(0.078384, 9);
    expect(r.after.NVDAon!.qty).toBeCloseTo(0.026128, 9);
    expect(r.after.NVDAon!.avgCostUsd).toBeCloseTo(r.before.NVDAon!.avgCostUsd!, 9); // the duplicates were at the same price
    expect(h.vaults.get("v1")!.book[NVDA_ON.assetId]!.costUsd).toBeCloseTo(5.5033, 3);
    // Once only: a later run changes nothing, even if the book moves on with real trades.
    h.vaults.recordFill("v1", fill(0.01, 2), T0);
    expect(repairBook({ vaults: h.vaults, ledger: h.ledger, registry: h.deps.registry, now: () => T0 }, "v1")).toBeNull();
    expect(h.vaults.get("v1")!.book[NVDA_ON.assetId]!.qty).toBeCloseTo(0.036128, 9);
  });

  it("replays buys and sells in order with the average-cost rule", () => {
    const r = bookFromLedger([executed("NVDAon", 0.1, 200), executed("NVDAon", 0.1, 220), executed("NVDAon", 0.05, 230, "sell")] as never, () => NVDA_ON.assetId);
    expect(r.ok && r.book[NVDA_ON.assetId]).toMatchObject({ qty: 0.15000000000000002, costUsd: 31.5 });
  });

  it("leaves the book untouched when a symbol cannot be mapped to one asset", () => {
    const h = harness();
    h.ledger.append(executed("NOPE", 1, 1));
    h.vaults.recordFill("v1", fill(1, 1), T0);
    expect(repairBook({ vaults: h.vaults, ledger: h.ledger, registry: h.deps.registry, now: () => T0 }, "v1")).toBeNull();
    expect(h.vaults.get("v1")!.book[NVDA_ON.assetId]!.qty).toBe(1);
    expect(h.vaults.get("v1")!.bookRepair).toBeUndefined();
  });

  it("is saved with the vault: after a restart it does not run again", () => {
    const dir = mkdtempSync(join(tmpdir(), "norr-repair-"));
    const cipher = DataCipher.random();
    const vault = () => newVault({ id: "v1", owner: "o.near", policy: policy(), custody: {} as Custody, walletAccount: WALLET, state: { realizedLossTodayUsd: 0, spentTodayUsd: 0, lastTradeAtMs: null, portfolioValueUsd: 0, equityValueUsd: 0 } }, T0);
    const h = harness();
    const a = new FileVaultStore(dir, [vault()], cipher);
    const ledger = new FileLedger(dir, cipher);
    ledger.append(executed("SOL", 0.5, 100));
    a.recordFill("v1", { assetId: SOL.assetId, side: "buy", qty: 0.5, usd: 50 }, T0);
    a.recordFill("v1", { assetId: SOL.assetId, side: "buy", qty: 0.5, usd: 50 }, T0);
    expect(repairBook({ vaults: a, ledger, registry: h.deps.registry, now: () => T0 }, "v1")!.after.SOL!.qty).toBe(0.5);
    const b = new FileVaultStore(dir, [vault()], cipher);
    expect(b.get("v1")!.book[SOL.assetId]!.qty).toBe(0.5);
    expect(b.get("v1")!.bookRepair!.before.SOL!.qty).toBe(1);
    expect(repairBook({ vaults: b, ledger, registry: h.deps.registry, now: () => T0 }, "v1")).toBeNull();
  });

  it("the agent's P&L answer carries the correction record once it has run", async () => {
    const h = harness();
    h.ledger.append(executed("NVDAon", 0.026128, 210.6272));
    h.vaults.recordFill("v1", fill(0.026128, 5.5), T0);
    h.vaults.recordFill("v1", fill(0.026128, 5.5), T0);
    repairBook({ vaults: h.vaults, ledger: h.ledger, registry: h.deps.registry, now: () => T0 }, "v1");
    const app = createApp({ deps: h.deps, tokens: { vaultFor: (t: string) => (t === "tok" ? "v1" : undefined) } as never, mock: true });
    const body = await (await app.request("/v1/pnl", { headers: { authorization: "Bearer tok" } })).json();
    expect(body.costBookRepair).toMatchObject({ fills: 1, before: { NVDAon: { qty: 0.052256 } }, after: { NVDAon: { qty: 0.026128 } } });
  });
});
