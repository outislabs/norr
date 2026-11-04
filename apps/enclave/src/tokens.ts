import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { withLock, writeAtomic } from "./persist";
import type { DataCipher } from "./seal";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** What the owner sees about one token (never the token itself). */
export interface TokenInfo {
  /** First 12 hex characters of the token's hash: enough to name it, useless to use it. */
  id: string;
  vaultId: string;
  label: string;
  /** `token`: pasted into an agent; `oauth`: granted to a connector through the consent screen. */
  kind: "token" | "oauth";
  createdAt: string;
  /** The OAuth client it was granted to, if any. */
  clientId?: string;
  expiresAt?: string;
}

interface Entry extends TokenInfo {
  hash: string;
}

/** Where token hashes are kept. One file per vault in live mode; nothing in mock mode. */
export interface TokenPersistence {
  load(): Entry[];
  save(vaultId: string, entries: Entry[]): void;
}

/**
 * Agent API tokens. Each token maps to exactly one vault. Only SHA-256 hashes are kept, so a leak
 * of this store reveals no usable token. An agent token can trade and read; nothing else.
 */
export class AgentTokens {
  private readonly byHash = new Map<string, Entry>();

  constructor(private readonly persistence?: TokenPersistence, private readonly now: () => number = Date.now) {
    for (const e of persistence?.load() ?? []) this.byHash.set(e.hash, e);
  }

  private persist(vaultId: string): void {
    this.persistence?.save(vaultId, [...this.byHash.values()].filter((e) => e.vaultId === vaultId));
  }

  private add(vaultId: string, token: string, meta: Partial<Pick<TokenInfo, "label" | "kind" | "clientId" | "expiresAt">>): void {
    const hash = sha256(token);
    this.byHash.set(hash, { hash, id: hash.slice(0, 12), vaultId, label: meta.label ?? "Agent token", kind: meta.kind ?? "token", createdAt: new Date(this.now()).toISOString(), ...(meta.clientId ? { clientId: meta.clientId } : {}), ...(meta.expiresAt ? { expiresAt: meta.expiresAt } : {}) });
    this.persist(vaultId);
  }

  /** Issue a new token for a vault. The plaintext is returned once and never stored. */
  issue(vaultId: string, meta: Partial<Pick<TokenInfo, "label" | "kind" | "clientId" | "expiresAt">> = {}): string {
    const token = `norr_agent_${randomBytes(24).toString("base64url")}`;
    this.add(vaultId, token, meta);
    return token;
  }

  /**
   * Register a caller-chosen token. Only the mock-mode demo uses this, so its config does not change
   * on every restart; live mode always issues random tokens. The token must look like an agent token.
   */
  register(vaultId: string, token: string): void {
    if (!/^norr_agent_[A-Za-z0-9_-]{16,}$/.test(token)) throw new Error("agent token must be norr_agent_ followed by at least 16 letters, digits, - or _");
    this.add(vaultId, token, { label: "Mock demo token" });
  }

  vaultFor(token: string): string | undefined {
    const e = this.byHash.get(sha256(token));
    if (!e) return undefined;
    if (e.expiresAt && Date.parse(e.expiresAt) <= this.now()) return undefined;
    return e.vaultId;
  }

  /** The vault's tokens, for the owner (no token values, no hashes beyond a short id). */
  list(vaultId: string): TokenInfo[] {
    return [...this.byHash.values()].filter((e) => e.vaultId === vaultId).map(({ hash: _h, ...info }) => info);
  }

  /** Revoke every token of a vault. */
  revoke(vaultId: string): void {
    for (const [h, e] of this.byHash) if (e.vaultId === vaultId) this.byHash.delete(h);
    this.persist(vaultId);
  }

  /** Revoke one token by its short id, only within this vault. */
  revokeOne(vaultId: string, id: string): boolean {
    for (const [h, e] of this.byHash) {
      if (e.vaultId === vaultId && e.id === id) {
        this.byHash.delete(h);
        this.persist(vaultId);
        return true;
      }
    }
    return false;
  }

  /** Revoke a token given its value (OAuth refresh rotation, revocation endpoint). Returns the vault it belonged to. */
  revokeToken(token: string): string | undefined {
    const h = sha256(token);
    const e = this.byHash.get(h);
    if (!e) return undefined;
    this.byHash.delete(h);
    this.persist(e.vaultId);
    return e.vaultId;
  }
}

/** `<dir>/tokens/<vault>.json`, encrypted and bound to the vault id: hashes and labels only. */
export class FileTokenPersistence implements TokenPersistence {
  private readonly dir: string;
  constructor(dataDir: string, private readonly cipher: DataCipher) {
    this.dir = join(dataDir, "tokens");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  private file(vaultId: string): string {
    return join(this.dir, `${encodeURIComponent(vaultId)}.json`);
  }

  load(): Entry[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => {
        const vaultId = decodeURIComponent(f.slice(0, -5));
        try {
          const rows = JSON.parse(this.cipher.decrypt(JSON.parse(readFileSync(join(this.dir, f), "utf8")), `tokens:${vaultId}`)) as Entry[];
          return rows.filter((r) => r.vaultId === vaultId);
        } catch {
          throw new Error(`Agent tokens for vault ${vaultId} are unreadable. Not starting.`);
        }
      });
  }

  save(vaultId: string, entries: Entry[]): void {
    const f = this.file(vaultId);
    withLock(this.dir, () => {
      if (entries.length === 0) {
        if (existsSync(f)) rmSync(f);
        return;
      }
      writeAtomic(f, JSON.stringify(this.cipher.encrypt(JSON.stringify(entries), `tokens:${vaultId}`)));
    });
  }
}

/** Constant-time string comparison for admin tokens. */
export function safeEqual(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}
