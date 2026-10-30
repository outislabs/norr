// One-off: record the two live NVDAon trades of 2026-10-30 (made with the live runner before it shared
// durable state with the service) in the durable ledger and counters, using the same store methods a
// trade uses. Idempotent: it does nothing if the buy's request id is already in the ledger.
//   pnpm exec tsx scripts/backfill-demo-ledger.mts [--apply]      (dry run without --apply)
import { FileLedger, FileVaultStore, dataDir } from "../apps/enclave/src/persist";
import { DataCipher, FileSealKeys, SealingLedger } from "../apps/enclave/src/seal";
import { newVault } from "../apps/enclave/src/state";
import { Policy } from "../packages/shared/src/index";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

try {
  process.loadEnvFile(".env");
} catch {
  /* no .env */
}
const { values } = parseArgs({ options: { apply: { type: "boolean", default: false } } });

const policy = Policy.parse(JSON.parse(readFileSync(process.env.NORR_POLICY_FILE ?? "config/policy.demo.local.json", "utf8")));
const owner = process.env.NORR_OWNER_ACCOUNT ?? "norrfi.near";
const dir = dataDir(process.env);

// Figures from the OutLayer-reported results (docs/FINDINGS.md). `usd` is the USDC that actually moved (balance before/after). Times are when the requests were created.
const NVDA = "nep141:bnb-0xa9ee28c80f960b889dfbd1902055218cba016f75.omdep.near";
const QTY = 0.029442134021611887;
const trades = [
  {
    at: Date.parse("2026-10-30T17:50:05.410Z"),
    requestId: "11e33ed0-5660-4213-b9ec-1e04f8623f28",
    side: "buy" as const,
    amountUsd: 6,
    reason: "demo vault equity round trip",
    usd: 6.001944,
  },
  {
    at: Date.parse("2026-10-30T18:12:23.071Z"),
    requestId: "8ab7a8e0-97d6-46bf-87f7-f065afebd94e",
    side: "sell" as const,
    amountUsd: 7,
    reason: "demo vault equity round trip, sell everything",
    usd: 5.930068,
  },
];

const cipher = DataCipher.load(process.env, dir);
const vaults = new FileVaultStore(dir, [
  newVault({ id: policy.vaultId, owner, policy, custody: {} as never, walletAccount: "n/a", state: { realizedLossTodayUsd: 0, spentTodayUsd: 0, lastTradeAtMs: null, portfolioValueUsd: 0, equityValueUsd: 0 } }, Date.now()),
], cipher);
const ledger = new SealingLedger(new FileLedger(dir, cipher), new FileSealKeys(dir), cipher, (id) => vaults.get(id)?.owner);

if (ledger.list(policy.vaultId).some((r) => r.decision.status === "executed" && r.decision.txRef === trades[0]!.requestId)) {
  console.log("Already recorded. Nothing to do.");
  process.exit(0);
}
for (const t of trades) {
  console.log(`${values.apply ? "recording" : "would record"}: ${new Date(t.at).toISOString()} ${t.side} NVDA ${t.side === "buy" ? "$" + t.amountUsd : "all"} -> ${t.usd} USDC ${t.side === "buy" ? "spent" : "received"}`);
  if (!values.apply) continue;
  const row = ledger.append({
    vaultId: policy.vaultId,
    at: t.at,
    request: { vaultId: policy.vaultId, side: t.side, asset: "NVDA", amountUsd: t.amountUsd, reason: t.reason },
    decision: { status: "executed", txRef: t.requestId, filled: { asset: "NVDAon", amount: String(QTY), priceUsd: t.usd / QTY }, venue: "confidential", verification: "custody-reported" },
    note: "Backfilled from the live runner's output (run before it shared durable state with the service).",
  });
  if (t.side === "buy") vaults.reserveSpend(policy.vaultId, t.amountUsd, t.at);
  vaults.recordFill(policy.vaultId, { assetId: NVDA, side: t.side, qty: QTY, usd: t.usd }, t.at);
  vaults.recordTrade(policy.vaultId, t.at);
  console.log(`  ledger ${row.id}`);
}
const v = vaults.get(policy.vaultId)!;
console.log(values.apply ? `Counters now: spend today $${v.spend.usd.toFixed(2)}, realized P&L today $${v.pnl.netUsd.toFixed(6)}` : "DRY RUN: nothing written. Re-run with --apply.");
