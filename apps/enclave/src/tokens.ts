import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * Agent API tokens. Each token maps to exactly one vault. Only SHA-256 hashes are kept, so a leak
 * of this store reveals no usable token. An agent token can trade and read; nothing else.
 */
export class AgentTokens {
  private readonly byHash = new Map<string, string>();

  /** Issue a new token for a vault. The plaintext is returned once and never stored. */
  issue(vaultId: string): string {
    const token = `norr_agent_${randomBytes(24).toString("base64url")}`;
    this.byHash.set(sha256(token), vaultId);
    return token;
  }

  vaultFor(token: string): string | undefined {
    return this.byHash.get(sha256(token));
  }

  /** Revoke every token of a vault. */
  revoke(vaultId: string): void {
    for (const [h, v] of this.byHash) if (v === vaultId) this.byHash.delete(h);
  }
}

/** Constant-time string comparison for admin tokens. */
export function safeEqual(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}
