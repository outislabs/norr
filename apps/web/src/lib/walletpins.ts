import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The pinned NEAR Connect wallet files (apps/web/public/near-connect): which wallets, and the check that the committed
 * files still match their SHA-256 in lock.json. Used by scripts/vendor-near-connect-wallets.mts (which writes them) and by
 * the test that keeps them honest. Node only: nothing in the app bundle imports this.
 */

export const WALLET_IDS = ["hot-wallet", "meteor-wallet", "intear-wallet", "ledger", "mynearwallet", "okx-wallet", "near-mobile", "nightly-wallet", "hana-wallet", "near-cli"] as const;

export const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

export interface LockEntry {
  id: string;
  name: string;
  version: string;
  executorUrl: string;
  executor: string;
  executorSha256: string;
  executorBytes: number;
  iconUrl: string;
  icon: string | null;
  iconSha256: string | null;
}
export interface Lock {
  note: string;
  fetchedAt: string;
  manifestRepo: string;
  manifestCommit: string;
  manifestVersion: string;
  wallets: LockEntry[];
}

/** Verify the committed files against the lock. Offline. Returns the problems found. */
export function checkLock(dir: string): string[] {
  const problems: string[] = [];
  let lock: Lock;
  try {
    lock = JSON.parse(readFileSync(join(dir, "lock.json"), "utf8"));
  } catch (e) {
    return [`lock.json unreadable: ${e instanceof Error ? e.message : String(e)}`];
  }
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { wallets: { id: string; executor: string; icon: string }[] };
  const files = new Set(readdirSync(dir));
  for (const w of lock.wallets) {
    const exec = readFileSync(join(dir, w.executor));
    if (sha256(exec) !== w.executorSha256) problems.push(`${w.id}: ${w.executor} does not match the pinned SHA-256`);
    if (w.icon && w.iconSha256 && sha256(readFileSync(join(dir, w.icon))) !== w.iconSha256) problems.push(`${w.id}: ${w.icon} does not match the pinned SHA-256`);
    const m = manifest.wallets.find((x) => x.id === w.id);
    if (!m) problems.push(`${w.id}: missing from manifest.json`);
    else {
      if (m.executor !== `/near-connect/${w.executor}`) problems.push(`${w.id}: manifest executor is ${m.executor}, expected the local copy`);
      if (w.icon && m.icon !== `/near-connect/${w.icon}`) problems.push(`${w.id}: manifest icon is not the local copy`);
    }
    files.delete(w.executor);
    if (w.icon) files.delete(w.icon);
  }
  for (const m of manifest.wallets) if (!lock.wallets.some((w) => w.id === m.id)) problems.push(`${m.id}: in manifest.json but not pinned in lock.json`);
  files.delete("lock.json");
  files.delete("manifest.json");
  for (const f of files) problems.push(`${f}: file is not pinned in lock.json`);
  return problems;
}
