import { createHash, randomBytes } from "node:crypto";
import { verifyNep413 } from "./nep413";

/** Does this public key belong to this NEAR account? (Live: an access-key lookup. Mock: always true.) */
export interface AccessKeyChecker {
  hasKey(accountId: string, publicKey: string): Promise<boolean>;
  /**
   * The same question with a third answer: "unavailable" when NEAR could not be asked (a timeout, a rate limit, a node
   * error). Sign-in must not report that as "your key is not on your account".
   */
  keyStatus?(accountId: string, publicKey: string): Promise<"yes" | "no" | "unavailable">;
}

/** NEAR RPC nodes asked in turn, until one gives a definite answer. */
export const ACCESS_KEY_RPCS = ["https://rpc.mainnet.fastnear.com", "https://free.rpc.fastnear.com"];

/**
 * Live check against NEAR RPC (`view_access_key`). A definite "no" is the node saying the key or the account does not
 * exist; anything else (no answer, HTTP 429/5xx, a node error) is "unavailable", and the next node is asked.
 */
export class RpcAccessKeyChecker implements AccessKeyChecker {
  private readonly rpcUrls: string[];
  constructor(
    rpcUrl: string | string[] = ACCESS_KEY_RPCS,
    private readonly f: (url: string, init?: RequestInit) => Promise<Response> = (u, i) => fetch(u, i),
  ) {
    this.rpcUrls = Array.isArray(rpcUrl) ? rpcUrl : [rpcUrl];
  }

  async hasKey(accountId: string, publicKey: string): Promise<boolean> {
    return (await this.keyStatus(accountId, publicKey)) === "yes";
  }

  async keyStatus(accountId: string, publicKey: string): Promise<"yes" | "no" | "unavailable"> {
    for (const url of this.rpcUrls) {
      try {
        const res = await this.f(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey } }),
          signal: AbortSignal.timeout(6000),
        });
        if (!res.ok) continue;
        const body = (await res.json()) as { result?: { permission?: unknown; error?: unknown }; error?: { cause?: { name?: string }; name?: string } };
        if (body.result?.permission) return "yes";
        const cause = body.error?.cause?.name ?? "";
        // A definite answer: this key, or this account, is not on chain.
        if (/UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT|INVALID_ACCOUNT/.test(cause)) return "no";
        // Older nodes answer a missing key inside `result` as an error string.
        if (typeof body.result?.error === "string" && /does not exist/i.test(body.result.error)) return "no";
      } catch {
        /* no answer from this node: ask the next */
      }
    }
    return "unavailable";
  }
}

/** Why a sign-in was refused, by the check that refused it. */
export type LoginFailure = "challenge_unknown" | "challenge_expired" | "origin_mismatch" | "bad_signature" | "key_not_on_account" | "key_check_unavailable";

/** The plain sentence for each failure: which check failed, and what to do. Nothing in it is secret. */
export function loginFailureText(code: LoginFailure, accountId: string, publicKey: string, ttlMinutes: number): string {
  const key = publicKey.length > 24 ? `${publicKey.slice(0, 16)}…` : publicKey;
  switch (code) {
    case "challenge_unknown":
      return "Norr does not know this sign-in challenge: it was already used, or the service restarted after issuing it. Sign in again (one more signature).";
    case "challenge_expired":
      return `The sign-in challenge expired (each one lasts ${ttlMinutes} minutes). Sign in again (one more signature).`;
    case "origin_mismatch":
      return "This sign-in was started on a different site than the one finishing it. Open app.norr.finance directly and sign in there.";
    case "bad_signature":
      return "The signature does not match Norr's challenge for the key your wallet reported: the wallet signed something else. Sign in again; if it keeps happening, try another wallet and tell us which one failed.";
    case "key_not_on_account":
      return `The key that signed (${key}) is not an access key of ${accountId} on NEAR. Check that your wallet is signing as ${accountId}.`;
    case "key_check_unavailable":
      return "Norr could not reach NEAR to check that your key belongs to your account (the NEAR RPC did not answer). Nothing is wrong with your signature: try again in a moment.";
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

export interface LoginRequest {
  accountId: string;
  publicKey: string;
  signature: string;
  nonce: string;
  callbackUrl?: string;
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
    // Ten minutes: on a phone, choosing a wallet, switching to its app and back can take a while. Still single-use and bound to the site.
    this.challengeTtl = o.challengeTtlMs ?? 10 * 60_000;
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

  /** Returns a session token, or null for any failure. Challenges are single-use. */
  async login(req: LoginRequest, origin?: string): Promise<{ token: string; accountId: string; expiresAt: number } | null> {
    const r = await this.attempt(req, origin);
    return r.ok ? r.session : null;
  }

  /**
   * Sign-in, saying which check refused it. A challenge is used up by any attempt the owner's side got wrong, so a
   * signature cannot be tried twice; but when Norr itself could not finish the check (NEAR RPC unreachable), the
   * challenge stays valid, so the same signature can be sent again without a new wallet prompt.
   */
  async attempt(req: LoginRequest, origin?: string): Promise<{ ok: true; session: { token: string; accountId: string; expiresAt: number } } | { ok: false; code: LoginFailure; message: string }> {
    const fail = (code: LoginFailure) => ({ ok: false as const, code, message: loginFailureText(code, req.accountId, req.publicKey, Math.round(this.challengeTtl / 60_000)) });
    const c = this.challenges.get(req.nonce);
    if (!c) return fail("challenge_unknown");
    if (c.expiresAt < this.now()) {
      this.challenges.delete(req.nonce);
      return fail("challenge_expired");
    }
    if (c.origin !== undefined && c.origin !== origin) {
      this.challenges.delete(req.nonce);
      return fail("origin_mismatch"); // issued to one site, presented by another
    }
    const nonce = Buffer.from(c.nonce, "base64");
    // Some wallets include a callback URL in what they sign (NEP-413 allows it); the signature is checked with the one
    // the wallet reported, and without one.
    const payload = { message: c.message, nonce, recipient: c.recipient };
    const valid = verifyNep413({ ...payload, callbackUrl: req.callbackUrl }, req.publicKey, req.signature) || (req.callbackUrl !== undefined && verifyNep413(payload, req.publicKey, req.signature));
    if (!valid) {
      this.challenges.delete(req.nonce);
      return fail("bad_signature");
    }
    const status = this.o.keys.keyStatus ? await this.o.keys.keyStatus(req.accountId, req.publicKey) : (await this.o.keys.hasKey(req.accountId, req.publicKey)) ? "yes" : "no";
    if (status === "unavailable") return fail("key_check_unavailable"); // Norr's side: the challenge stays usable
    this.challenges.delete(req.nonce);
    if (status === "no") return fail("key_not_on_account");
    const token = `norr_owner_${randomBytes(24).toString("base64url")}`;
    const expiresAt = this.now() + this.sessionTtl;
    this.sessions.set(sha256(token), { accountId: req.accountId, expiresAt });
    return { ok: true, session: { token, accountId: req.accountId, expiresAt } };
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
