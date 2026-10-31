import { Policy } from "@norr/shared";
import { readFileSync } from "node:fs";

/**
 * The vault's starting policy: inline JSON (NORR_POLICY_JSON, for a container where there is no file to mount)
 * or a file (NORR_POLICY_FILE). It only seeds the vault the first time; after that the saved state, which
 * includes the owner's edits and the kill switch, wins (see persist.ts).
 */
export function loadPolicy(env: NodeJS.ProcessEnv): Policy {
  const inline = env.NORR_POLICY_JSON?.trim();
  if (inline) return Policy.parse(JSON.parse(inline));
  const file = env.NORR_POLICY_FILE?.trim();
  if (!file) throw new Error("missing environment variable NORR_POLICY_FILE or NORR_POLICY_JSON (see .env.example)");
  return Policy.parse(JSON.parse(readFileSync(file, "utf8")));
}

/**
 * Dashboard origins from a comma-separated list. Each must be a bare https origin (http only for localhost),
 * with no path, so an entry cannot accidentally allow more than one site.
 */
export function parseOrigins(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean).map((o) => {
    let u: URL;
    try {
      u = new URL(o);
    } catch {
      throw new Error(`NORR_ALLOWED_ORIGINS: "${o}" is not a URL`);
    }
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (!/^[a-z0-9.-]+$/i.test(u.hostname) || u.origin !== o || (u.protocol !== "https:" && !(local && u.protocol === "http:"))) {
      throw new Error(`NORR_ALLOWED_ORIGINS: "${o}" must be a bare https origin such as https://app.norr.finance (no path, no trailing slash)`);
    }
    return u.origin;
  });
}
