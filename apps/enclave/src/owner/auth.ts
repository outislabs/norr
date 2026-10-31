import { createHash, randomBytes } from "node:crypto";
import { verifyNep413 } from "./nep413";

/** Does this public key belong to this NEAR account? (Live: an access-key lookup. Mock: always true.) */
export interface AccessKeyChecker {
  hasKey(accountId: string, publicKey: string): Promise<boolean>;
}

/** Live check against a NEAR RPC node (`view_access_key`). Any error counts as "no". */
export class RpcAccessKeyChecker implements AccessKeyChecker {
  constructor(
    private readonly rpcUrl = "https://rpc.mainnet.fastnear.com",
    private readonly f: (url: string, init?: RequestInit) => Promise<Response> = (u, i) => fetch(u, i),
  ) {}

  async hasKey(accountId: string, publicKey: string): Promise<boolean> {
    try {
      const res = await this.f(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey } }),
      });
      const body = (await res.json()) as { result?: { permission?: unknown }; error?: unknown };
      return Boolean(body.result?.permission);
    } catch {
      return false;
    }
  }
}

export interface Challenge {
  nonce: string; // base64, 32 bytes
  message: string;
  recipient: string;
  expiresAt: number;
  /** The dashboard origin this challenge was issued to and is signed for. Absent when the service is not configured with origins. */
  origin?: string;
}

export interface Session {
  accountId: string;
  expiresAt: number;
}

export interface OwnerAuthOptions {
  keys: AccessKeyChecker;
  now?: () => number;
  /** What the wallet is told it is signing for; part of the signed payload. */
  recipient?: string;
  challengeTtlMs?: number;
  sessionTtlMs?: number;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Owner sign-in with a NEAR wallet message signature (NEP-413). The server issues a one-time challenge,
 * the wallet signs it, the server checks the signature and that the signing key belongs to the claimed
 * account, then issues a session token (only its hash is kept).
 */
export class OwnerAuth {
  private readonly challenges = new Map<string, Challenge>();
  private readonly sessions = new Map<string, Session>();
  private readonly now: () => number;
  private readonly recipient: string;
  private readonly challengeTtl: number;
  private readonly sessionTtl: number;

  constructor(private readonly o: OwnerAuthOptions) {
    this.now = o.now ?? Date.now;
    this.recipient = o.recipient ?? "norr";
    this.challengeTtl = o.challengeTtlMs ?? 5 * 60_000;
    this.sessionTtl = o.sessionTtlMs ?? 12 * 3_600_000;
  }

  /** With an origin, the signed message names the site, and the login must come from the same one. */
  challenge(origin?: string): Challenge {
    const nonce = randomBytes(32).toString("base64");
    const issued = new Date(this.now()).toISOString();
    const c: Challenge = {
      nonce,
      recipient: this.recipient,
      message: `Sign in to Norr${origin ? ` at ${origin}` : ""}\nThis proves you control this NEAR account. It does not move funds or give Norr any access to them.\nIssued: ${issued}`,
      expiresAt: this.now() + this.challengeTtl,
      ...(origin ? { origin } : {}),
    };
    this.challenges.set(nonce, c);
    return c;
  }

  /** Returns a session token, or null for any failure (no detail is leaked). Challenges are single-use. */
  async login(req: { accountId: string; publicKey: string; signature: string; nonce: string; callbackUrl?: string }, origin?: string): Promise<{ token: string; accountId: string; expiresAt: number } | null> {
    const c = this.challenges.get(req.nonce);
    this.challenges.delete(req.nonce); // single-use even if the rest fails
    if (!c || c.expiresAt < this.now()) return null;
    if (c.origin !== undefined && c.origin !== origin) return null; // issued to one site, presented by another
    const nonce = Buffer.from(c.nonce, "base64");
    const valid = verifyNep413({ message: c.message, nonce, recipient: c.recipient, callbackUrl: req.callbackUrl }, req.publicKey, req.signature);
    if (!valid) return null;
    if (!(await this.o.keys.hasKey(req.accountId, req.publicKey))) return null;
    const token = `norr_owner_${randomBytes(24).toString("base64url")}`;
    const expiresAt = this.now() + this.sessionTtl;
    this.sessions.set(sha256(token), { accountId: req.accountId, expiresAt });
    return { token, accountId: req.accountId, expiresAt };
  }

  session(token: string): Session | null {
    const s = this.sessions.get(sha256(token));
    if (!s) return null;
    if (s.expiresAt < this.now()) {
      this.sessions.delete(sha256(token));
      return null;
    }
    return s;
  }

  logout(token: string): void {
    this.sessions.delete(sha256(token));
  }
}
