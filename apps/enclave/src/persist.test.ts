import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Custody } from "@norr/intents";
import { describe, expect, it } from "vitest";
import { resolveBuildInfo } from "./build-info";
import { WALLET, harness, policy, req } from "./fixtures";
import { FileLedger, FileVaultStore } from "./persist";
import { DataCipher } from "./seal";
import { newVault, type Vault } from "./state";
import { executeTrade } from "./trade";

const T0 = Date.UTC(2026, 10, 3, 12);
const CIPHER = DataCipher.random();
const tmp = () => mkdtempSync(join(tmpdir(), "norr-persist-"));
const fresh = (over: Parameters<typeof policy>[0] = {}, custody: Custody = {} as Custody): Vault =>
  newVault({ id: "v1", owner: "owner.test.near", policy: policy(over), custody, walletAccount: WALLET, state: { realizedLossTodayUsd: 0, spentTodayUsd: 0, lastTradeAtMs: null, portfolioValueUsd: 0, equityValueUsd: 0 } }, T0);

describe("FileVaultStore: counters, kill switch and owner edits survive a restart", () => {
  it("restores spend, realized P&L, positions, cooldown, pause and policy edits into a freshly built vault", () => {
    const dir = tmp();
    const a = new FileVaultStore(dir, [fresh()], CIPHER);
    a.reserveSpend("v1", 6, T0);
    a.recordFill("v1", { assetId: "nvda", side: "buy", qty: 0.03, usd: 6 }, T0);
    a.recordFill("v1", { assetId: "nvda", side: "sell", qty: 0.03, usd: 5.9 }, T0);
    a.recordTrade("v1", T0);
    a.setPolicy("v1", policy({ maxTradeUsd: 12 }));
    a.pause("v1", "mismatch after a swap");

    const b = new FileVaultStore(dir, [fresh({ maxTradeUsd: 50 })], CIPHER); // a restart: the vault is rebuilt from config
    const v = b.get("v1")!;
    expect(v.spend).toMatchObject({ usd: 6 });
    expect(v.pnl.netUsd).toBeCloseTo(-0.1, 6);
    expect(v.state.lastTradeAtMs).toBe(T0);
    expect(v.policy).toMatchObject({ maxTradeUsd: 12, paused: true, vaultId: "v1" });
    expect(b.pauseReasons.get("v1")).toBe("mismatch after a swap");
  });

  it("two processes share it: what one writes the other reads at once", () => {
    const dir = tmp();
    const service = new FileVaultStore(dir, [fresh()], CIPHER);
    const runner = new FileVaultStore(dir, [fresh()], CIPHER);
    runner.reserveSpend("v1", 6, T0);
    expect(service.get("v1")!.spend.usd).toBe(6);
    service.reserveSpend("v1", 4, T0);
    expect(runner.get("v1")!.spend.usd).toBe(10);
    service.resume("v1");
    runner.pause("v1", "stop");
    expect(service.get("v1")!.policy.paused).toBe(true);
  });

  it("refuses to start on an unreadable state file instead of resetting the caps", () => {
    const dir = tmp();
    new FileVaultStore(dir, [fresh()], CIPHER);
    writeFileSync(join(dir, "vaults", "v1.json"), "{ not json");
    expect(() => new FileVaultStore(dir, [fresh()], CIPHER)).toThrow(/unreadable.*reset the vault's caps/s);
  });

  it("a restart does not reopen the daily spend cap (end to end through the trade pipeline)", async () => {
    const dir = tmp();
    const h = harness({ policy: { dailySpendCapUsd: 100, cooldownSec: 0 } });
    const live = h.vaults.get("v1")!;
    h.deps.vaults = new FileVaultStore(dir, [live], CIPHER);
    for (let i = 0; i < 2; i++) expect((await executeTrade(h.deps, req({ asset: "SOL", amountUsd: 50 }))).status).toBe("executed");
    expect(await executeTrade(h.deps, req({ asset: "SOL", amountUsd: 5 }))).toMatchObject({ status: "blocked", code: "DAILY_SPEND_CAP" });

    // Restart: a brand-new vault object and store over the same directory.
    h.deps.vaults = new FileVaultStore(dir, [fresh({ dailySpendCapUsd: 100, cooldownSec: 0 }, live.custody)], CIPHER);
    h.clock.t += 1_000;
    expect(await executeTrade(h.deps, req({ asset: "SOL", amountUsd: 5 }))).toMatchObject({ status: "blocked", code: "DAILY_SPEND_CAP" });
  });

  it("keeps the state files owner-only", () => {
    const dir = tmp();
    new FileVaultStore(dir, [fresh()], CIPHER);
    new FileLedger(dir, CIPHER).append({ vaultId: "v1", at: T0, request: req(), decision: { status: "failed", message: "x" } });
    expect(statSync(join(dir, "vaults", "v1.json")).mode & 0o077).toBe(0);
    expect(statSync(join(dir, "ledger.jsonl")).mode & 0o077).toBe(0);
  });
});

describe("FileLedger", () => {
  const entry = (n: number) => ({ vaultId: "v1", at: T0 + n, request: req(), decision: { status: "failed" as const, message: `m${n}` } });

  it("keeps entries and updates across instances and restarts, with ids that never collide", () => {
    const dir = tmp();
    const a = new FileLedger(dir, CIPHER);
    const b = new FileLedger(dir, CIPHER);
    const r1 = a.append(entry(1));
    const r2 = b.append(entry(2));
    expect(r1.id).not.toBe(r2.id);
    a.update(r2.id, { note: "settled" });
    const c = new FileLedger(dir, CIPHER); // a restart
    expect(c.list("v1").map((r) => r.decision)).toEqual([entry(1).decision, entry(2).decision]);
    expect(c.get(r2.id)?.note).toBe("settled");
    expect(c.list("other")).toEqual([]);
  });

  it("refuses to read a damaged log instead of treating it as empty", () => {
    const dir = tmp();
    const l = new FileLedger(dir, CIPHER);
    l.append(entry(1));
    writeFileSync(join(dir, "ledger.jsonl"), "garbage\n");
    expect(() => l.list("v1")).toThrow(/unreadable at line 1/);
  });
});

describe("resolveBuildInfo", () => {
  it("prefers the hash baked into a build", () => {
    expect(resolveBuildInfo({ NORR_COMMIT: "abc123" })).toEqual({ commit: "abc123", dirty: false, source: "env" });
  });

  it("falls back to the local git checkout", () => {
    const i = resolveBuildInfo({});
    expect(["git", "unknown"]).toContain(i.source); // a copy of the repo without .git has no hash to report
    if (i.source === "git") expect(i.commit).toMatch(/^[0-9a-f]{40}$/);
    else expect(i.commit).toBeNull();
    expect(typeof i.dirty).toBe("boolean");
  });
});

describe("encryption at rest", () => {
  it("writes nothing readable: no policy, amounts or decisions appear in the files", () => {
    const dir = tmp();
    const store = new FileVaultStore(dir, [fresh({ maxTradeUsd: 4321 })], CIPHER);
    store.reserveSpend("v1", 777, T0);
    new FileLedger(dir, CIPHER).append({ vaultId: "v1", at: T0, request: req({ asset: "MARKER_ASSET" }), decision: { status: "failed", message: "MARKER_MESSAGE" } });
    const files = [readFileSync(join(dir, "vaults", "v1.json"), "utf8"), readFileSync(join(dir, "ledger.jsonl"), "utf8")].join("\n");
    for (const secret of ["4321", "777", "MARKER_ASSET", "MARKER_MESSAGE", "maxTradeUsd", "policy"]) expect(files).not.toContain(secret);
  });

  it("reads files an earlier version left in the clear, and rewrites them encrypted", () => {
    const dir = tmp();
    mkdirSync(join(dir, "vaults"), { recursive: true });
    const plainState = { policy: policy({ maxTradeUsd: 4321 }), pauseReason: null, lastTradeAtMs: null, book: {}, pnl: { day: "2026-11-03", netUsd: 0 }, spend: { day: "2026-11-03", usd: 6 } };
    writeFileSync(join(dir, "vaults", "v1.json"), JSON.stringify(plainState));
    const op = { op: "append", entry: { id: "led-old", vaultId: "v1", at: T0, request: req({ asset: "OLD_ASSET" }), decision: { status: "failed", message: "old" } } };
    writeFileSync(join(dir, "ledger.jsonl"), `${JSON.stringify(op)}\n`);

    const store = new FileVaultStore(dir, [fresh()], CIPHER);
    const ledger = new FileLedger(dir, CIPHER);
    expect(store.get("v1")!.spend.usd).toBe(6);
    expect(store.get("v1")!.policy.maxTradeUsd).toBe(4321);
    expect(ledger.get("led-old")?.request.asset).toBe("OLD_ASSET");
    expect(readFileSync(join(dir, "ledger.jsonl"), "utf8")).not.toContain("OLD_ASSET");
    expect(readFileSync(join(dir, "vaults", "v1.json"), "utf8")).not.toContain("maxTradeUsd");
  });

  it("fails closed with the wrong data key instead of starting empty", () => {
    const dir = tmp();
    new FileVaultStore(dir, [fresh()], CIPHER);
    new FileLedger(dir, CIPHER).append({ vaultId: "v1", at: T0, request: req(), decision: { status: "failed", message: "x" } });
    const wrong = DataCipher.random();
    expect(() => new FileVaultStore(dir, [fresh()], wrong)).toThrow(/unreadable/);
    expect(() => new FileLedger(dir, wrong)).toThrow(/unreadable.*data key is wrong/s);
  });

  it("DataCipher: takes NORR_DATA_KEY when set, else makes a development key once and warns", () => {
    const dir = tmp();
    const key = Buffer.alloc(32, 7).toString("base64");
    const a = DataCipher.load({ NORR_DATA_KEY: key }, dir, () => {});
    expect(a.decrypt(DataCipher.load({ NORR_DATA_KEY: key }, dir, () => {}).encrypt("hi", "aad"), "aad")).toBe("hi");
    const warnings: string[] = [];
    const b = DataCipher.load({}, dir, (m) => warnings.push(m));
    const c = DataCipher.load({}, dir, (m) => warnings.push(m));
    expect(c.decrypt(b.encrypt("hi", "aad"), "aad")).toBe("hi"); // same key the second time
    expect(warnings).toHaveLength(1);
    expect(() => b.decrypt({ ...b.encrypt("hi", "aad") }, "other-aad")).toThrow(); // bound to its context
    expect(() => new DataCipher(Buffer.alloc(16))).toThrow(/32 bytes/);
  });
});
