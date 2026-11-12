/**
 * Pins the wallets the dashboard offers (NEAR Connect) as files served from the dashboard's own origin.
 *
 * Why: NEAR Connect fetches each wallet's "executor" script at runtime from whatever URL the wallet's manifest names
 * and runs it inside the page. Those URLs are on ten different hosts, mostly `main` branches of repositories we do not
 * control. The dashboard is where the owner signs approvals and the policy transaction, so live third-party code is
 * not acceptable there. This script downloads the executors once, records their SHA-256 in
 * `apps/web/public/near-connect/lock.json`, and rewrites the manifest to point at the local copies. Updating a wallet
 * is a reviewed commit (`git diff` on the lock), not something that happens to users.
 *
 * Usage:
 *   tsx scripts/vendor-near-connect-wallets.mts            download the current upstream manifest and executors, write files
 *   tsx scripts/vendor-near-connect-wallets.mts --check    offline: verify the committed files match lock.json
 *
 * Which wallets: those that can sign a message (sign-in is a NEP-413 signature) and need nothing we do not have.
 * WalletConnect-based entries (`wallet-connect`, `unity-wallet`) are left out: they need a Reown project id and relay
 * origins. `trezu-wallet` and `ethereum-wallets` cannot sign messages.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WALLET_IDS, checkLock, sha256, type Lock } from "../apps/web/src/lib/walletpins";

const UPSTREAM = "hot-dao/near-selector";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "../apps/web/public/near-connect");

async function get(url: string): Promise<Uint8Array> {
  const r = await fetch(url, { headers: { "user-agent": "norr-wallet-vendoring" } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

const extOf = (url: string, type: string | null): string => {
  const fromUrl = /\.(png|svg|jpg|jpeg|webp|ico)(?:$|\?)/i.exec(new URL(url).pathname + "?")?.[1]?.toLowerCase();
  if (fromUrl) return fromUrl === "jpeg" ? "jpg" : fromUrl;
  return type?.includes("svg") ? "svg" : type?.includes("jpeg") ? "jpg" : type?.includes("webp") ? "webp" : "png";
};

async function vendor() {
  const commit = ((await (await fetch(`https://api.github.com/repos/${UPSTREAM}/commits/main`, { headers: { "user-agent": "norr-wallet-vendoring" } })).json()) as { sha: string }).sha;
  const upstream = JSON.parse(new TextDecoder().decode(await get(`https://raw.githubusercontent.com/${UPSTREAM}/${commit}/repository/manifest.json`))) as { version: string; wallets: Record<string, unknown>[] & { id: string }[] };
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const wallets: Record<string, unknown>[] = [];
  const lock: Lock = { note: "Pinned copies of the wallets' NEAR Connect executors, served from this origin. Regenerate with scripts/vendor-near-connect-wallets.mts and review the diff.", fetchedAt: new Date().toISOString(), manifestRepo: UPSTREAM, manifestCommit: commit, manifestVersion: upstream.version, wallets: [] };
  for (const id of WALLET_IDS) {
    const w = upstream.wallets.find((x) => x.id === id) as Record<string, any> | undefined;
    if (!w) throw new Error(`${id} is no longer in the upstream manifest`);
    if (!w.features?.signMessage) throw new Error(`${id} no longer lists signMessage`);
    const exec = await get(w.executor);
    const executor = `${id}.js`;
    writeFileSync(join(out, executor), exec);
    let icon: string | null = null;
    let iconSha: string | null = null;
    let iconPath: string = w.icon;
    if (typeof w.icon === "string" && /^https?:/.test(w.icon)) {
      const r = await fetch(w.icon, { headers: { "user-agent": "norr-wallet-vendoring" } });
      if (!r.ok) throw new Error(`${w.icon}: HTTP ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      icon = `${id}.${extOf(w.icon, r.headers.get("content-type"))}`;
      writeFileSync(join(out, icon), bytes);
      iconSha = sha256(bytes);
      iconPath = `/near-connect/${icon}`;
    }
    wallets.push({ ...w, executor: `/near-connect/${executor}`, icon: iconPath });
    lock.wallets.push({ id, name: w.name, version: w.version, executorUrl: w.executor, executor, executorSha256: sha256(exec), executorBytes: exec.length, iconUrl: w.icon, icon, iconSha256: iconSha });
    console.log(`${id.padEnd(15)} v${w.version}  ${(exec.length / 1024).toFixed(0).padStart(5)} KiB  ${sha256(exec).slice(0, 12)}`);
  }
  writeFileSync(join(out, "manifest.json"), JSON.stringify({ version: upstream.version, wallets }, null, 2) + "\n");
  writeFileSync(join(out, "lock.json"), JSON.stringify(lock, null, 2) + "\n");
  console.log(`\nWrote ${WALLET_IDS.length} wallets from ${UPSTREAM}@${commit.slice(0, 10)} to apps/web/public/near-connect/`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--check")) {
    const problems = checkLock(out);
    for (const p of problems) console.error(`x ${p}`);
    console.log(problems.length ? `\n${problems.length} problem(s)` : "near-connect wallet files match lock.json");
    process.exit(problems.length ? 1 : 0);
  }
  await vendor();
}
