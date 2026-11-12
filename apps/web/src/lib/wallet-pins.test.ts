import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WALLET_IDS, checkLock } from "./walletpins";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "../../public/near-connect");
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { wallets: { id: string; name: string; executor: string; icon: string; features: Record<string, boolean | undefined>; permissions: Record<string, unknown> }[] };

describe("the wallets NEAR Connect offers are pinned copies served from this origin", () => {
  it("every executor and icon in the manifest matches the SHA-256 in lock.json, and nothing is unpinned", () => {
    expect(checkLock(dir)).toEqual([]);
  });

  it("offers exactly the wallets that can sign a message and need nothing we lack", () => {
    expect(manifest.wallets.map((w) => w.id).sort()).toEqual([...WALLET_IDS].sort());
    for (const w of manifest.wallets) expect(w.features.signMessage, w.id).toBe(true); // sign-in is a NEP-413 signature
    // WalletConnect-based wallets need a Reown project id and relay origins we do not have.
    for (const w of manifest.wallets) expect(w.permissions.walletConnect, w.id).toBeFalsy();
  });

  it("loads nothing from a third party at runtime: executors are same-origin paths; icons are same-origin or inline", () => {
    for (const w of manifest.wallets) {
      expect(w.executor, w.id).toMatch(/^\/near-connect\/[a-z-]+\.js$/);
      expect(w.icon.startsWith("/near-connect/") || w.icon.startsWith("data:"), `${w.id} icon: ${w.icon.slice(0, 40)}`).toBe(true);
    }
  });

  it("notices a changed executor (someone editing a wallet's code without re-pinning it)", () => {
    const copy = mkdtempSync(join(tmpdir(), "near-connect-"));
    cpSync(dir, copy, { recursive: true });
    expect(checkLock(copy)).toEqual([]);
    writeFileSync(join(copy, "hot-wallet.js"), readFileSync(join(copy, "hot-wallet.js"), "utf8") + "\n// tampered");
    expect(checkLock(copy)).toEqual(["hot-wallet: hot-wallet.js does not match the pinned SHA-256"]);
  });

  it("notices a file added without being pinned, and a manifest pointing off-origin", () => {
    const copy = mkdtempSync(join(tmpdir(), "near-connect-"));
    cpSync(dir, copy, { recursive: true });
    writeFileSync(join(copy, "extra.js"), "alert(1)");
    const m = JSON.parse(readFileSync(join(copy, "manifest.json"), "utf8"));
    m.wallets[0].executor = "https://evil.example/hot.js";
    writeFileSync(join(copy, "manifest.json"), JSON.stringify(m));
    const problems = checkLock(copy);
    expect(problems).toContain("extra.js: file is not pinned in lock.json");
    expect(problems.some((p) => p.includes("manifest executor is https://evil.example/hot.js"))).toBe(true);
  });
});
