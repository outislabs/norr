import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { cors } from "hono/cors";
import { withLock, writeAtomic } from "./persist";
import type { DataCipher } from "./seal";
import type { AgentTokens } from "./tokens";

/**
 * OAuth 2.1 for MCP clients (MCP authorization, spec 2025-06-18): the Norr service is the authorization server; the MCP
 * endpoint is the resource server. A client registers itself (RFC 7591, public clients only), sends the owner to the
 * dashboard's consent screen with PKCE (S256 only), and gets an access token that is an agent token for the one vault the
 * owner picked: the same scope as a pasted token (read, quote, trade; never withdraw or change rules). Each grant shows
 * in the vault's Connect tab and can be revoked there.
 */

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const b64url = (b: Buffer) => b.toString("base64url");
export const ACCESS_TTL_S = 3600;
const REFRESH_TTL_MS = 90 * 24 * 3600_000;
const CODE_TTL_MS = 5 * 60_000;
const REQUEST_TTL_MS = 10 * 60_000;

export interface OAuthClient {
  clientId: string;
  name: string;
  redirectUris: string[];
  createdAt: string;
}

export interface OAuthGrant {
  id: string;
  vaultId: string;
  owner: string;
  clientId: string;
  label: string;
  refreshHash: string;
  refreshExpiresAt: string;
  /** The short id of the current access token (TokenInfo.id), so revoking one revokes the other. */
  accessTokenId: string;
  createdAt: string;
}

interface State {
  clients: OAuthClient[];
  grants: OAuthGrant[];
}

export interface OAuthPersistence {
  load(): State;
  save(s: State): void;
}

export class FileOAuthPersistence implements OAuthPersistence {
  private readonly file: string;
  constructor(dataDir: string, private readonly cipher: DataCipher) {
    const dir = join(dataDir, "oauth");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, "state.json");
  }
  load(): State {
    if (!existsSync(this.file)) return { clients: [], grants: [] };
    try {
      return JSON.parse(this.cipher.decrypt(JSON.parse(readFileSync(this.file, "utf8")), "oauth")) as State;
    } catch {
      throw new Error("OAuth state is unreadable. Not starting.");
    }
  }
  save(s: State): void {
    const dir = join(this.file, "..");
    withLock(dir, () => writeAtomic(this.file, JSON.stringify(this.cipher.encrypt(JSON.stringify(s), "oauth"))));
  }
}

/** A redirect URI a public client may use: https anywhere, or http on the loopback interface (native apps). */
export function validRedirectUri(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

interface AuthRequest {
  id: string;
  clientId: string;
  redirectUri: string;
  state?: string;
  challenge: string;
  expiresAt: number;
}

interface Code {
  hash: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  vaultId: string;
  owner: string;
  expiresAt: number;
}

export interface OAuthConfig {
  /** This service's public URL, e.g. https://api.norr.finance. */
  issuer: string;
  /** Where the consent screen lives, e.g. https://app.norr.finance. */
  dashboardUrl: string;
}

export class OAuthServer {
  private state: State;
  private readonly requests = new Map<string, AuthRequest>();
  private readonly codes = new Map<string, Code>();

  constructor(
    readonly config: OAuthConfig,
    private readonly tokens: AgentTokens,
    private readonly persistence: OAuthPersistence | null,
    private readonly now: () => number = Date.now,
  ) {
    this.state = persistence?.load() ?? { clients: [], grants: [] };
  }

  private save(): void {
    this.persistence?.save(this.state);
  }

  metadata() {
    const i = this.config.issuer;
    return {
      issuer: i,
      authorization_endpoint: `${i}/oauth/authorize`,
      token_endpoint: `${i}/oauth/token`,
      registration_endpoint: `${i}/oauth/register`,
      revocation_endpoint: `${i}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["vault"],
      service_documentation: "https://norr.finance/docs/connect-agent/",
    };
  }

  register(body: { redirect_uris?: unknown; client_name?: unknown }): OAuthClient | { error: string } {
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
    if (uris.length === 0 || uris.length > 5 || !uris.every(validRedirectUri)) return { error: "redirect_uris must be 1 to 5 https URLs (or http on localhost)" };
    if (this.state.clients.length >= 5000) return { error: "registration is closed for now" };
    const name = typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 60) : new URL(uris[0]!).host;
    const c: OAuthClient = { clientId: `norr_client_${b64url(randomBytes(12))}`, name, redirectUris: uris, createdAt: new Date(this.now()).toISOString() };
    this.state.clients.push(c);
    this.save();
    return c;
  }

  client(id: string): OAuthClient | undefined {
    return this.state.clients.find((c) => c.clientId === id);
  }

  /** Validate an authorization request; returns where to send the browser (the consent screen), or an error to show. */
  authorize(q: Record<string, string | undefined>): { redirect: string } | { error: string; redirectToClient?: string } {
    const c = q.client_id ? this.client(q.client_id) : undefined;
    if (!c) return { error: "Unknown client. Add the connector again in your app." };
    if (!q.redirect_uri || !c.redirectUris.includes(q.redirect_uri)) return { error: "This redirect address is not registered for the client." };
    const back = (err: string) => `${q.redirect_uri}${q.redirect_uri!.includes("?") ? "&" : "?"}error=${err}${q.state ? `&state=${encodeURIComponent(q.state)}` : ""}`;
    if (q.response_type !== "code") return { error: "unsupported response type", redirectToClient: back("unsupported_response_type") };
    if (q.code_challenge_method !== "S256" || !q.code_challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) return { error: "PKCE with S256 is required", redirectToClient: back("invalid_request") };
    this.gc();
    if (this.requests.size > 10_000) return { error: "Too many pending sign-ins. Try again in a few minutes." };
    const r: AuthRequest = { id: b64url(randomBytes(18)), clientId: c.clientId, redirectUri: q.redirect_uri, state: q.state, challenge: q.code_challenge, expiresAt: this.now() + REQUEST_TTL_MS };
    this.requests.set(r.id, r);
    return { redirect: `${this.config.dashboardUrl}/#/authorize/${r.id}` };
  }

  /** What the consent screen shows. */
  request(id: string): { clientName: string; redirectHost: string; expiresAt: string } | null {
    const r = this.requests.get(id);
    if (!r || r.expiresAt <= this.now()) return null;
    const c = this.client(r.clientId)!;
    return { clientName: c.name, redirectHost: new URL(r.redirectUri).host, expiresAt: new Date(r.expiresAt).toISOString() };
  }

  /** The owner said yes for one of their vaults (the caller checks ownership). Returns the client's redirect with a code. */
  approve(id: string, owner: string, vaultId: string): { redirect: string } | null {
    const r = this.requests.get(id);
    if (!r || r.expiresAt <= this.now()) return null;
    this.requests.delete(id);
    const code = b64url(randomBytes(32));
    this.codes.set(sha256(code), { hash: sha256(code), clientId: r.clientId, redirectUri: r.redirectUri, challenge: r.challenge, vaultId, owner, expiresAt: this.now() + CODE_TTL_MS });
    return { redirect: `${r.redirectUri}${r.redirectUri.includes("?") ? "&" : "?"}code=${code}${r.state ? `&state=${encodeURIComponent(r.state)}` : ""}` };
  }

  deny(id: string): { redirect: string } | null {
    const r = this.requests.get(id);
    if (!r) return null;
    this.requests.delete(id);
    return { redirect: `${r.redirectUri}${r.redirectUri.includes("?") ? "&" : "?"}error=access_denied${r.state ? `&state=${encodeURIComponent(r.state)}` : ""}` };
  }

  private issue(grant: Omit<OAuthGrant, "refreshHash" | "refreshExpiresAt" | "accessTokenId">) {
    const access = this.tokens.issue(grant.vaultId, { kind: "oauth", label: grant.label, clientId: grant.clientId, expiresAt: new Date(this.now() + ACCESS_TTL_S * 1000).toISOString() });
    const refresh = `norr_refresh_${b64url(randomBytes(32))}`;
    const g: OAuthGrant = { ...grant, refreshHash: sha256(refresh), refreshExpiresAt: new Date(this.now() + REFRESH_TTL_MS).toISOString(), accessTokenId: sha256(access).slice(0, 12) };
    this.state.grants = [...this.state.grants.filter((x) => x.id !== g.id), g];
    this.save();
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: "vault" };
  }

  /** The token endpoint. Errors use OAuth's codes. */
  token(p: Record<string, string | undefined>): { ok: true; body: ReturnType<OAuthServer["issue"]> } | { ok: false; error: string; description: string } {
    const bad = (error: string, description: string) => ({ ok: false as const, error, description });
    const c = p.client_id ? this.client(p.client_id) : undefined;
    if (!c) return bad("invalid_client", "unknown client");
    if (p.grant_type === "authorization_code") {
      const code = p.code ? this.codes.get(sha256(p.code)) : undefined;
      if (code) this.codes.delete(code.hash); // single use, whatever happens next
      if (!code || code.expiresAt <= this.now() || code.clientId !== c.clientId || code.redirectUri !== p.redirect_uri) return bad("invalid_grant", "the code is invalid, expired or not for this client");
      if (!p.code_verifier || b64url(createHash("sha256").update(p.code_verifier).digest()) !== code.challenge) return bad("invalid_grant", "PKCE verification failed");
      return { ok: true, body: this.issue({ id: b64url(randomBytes(12)), vaultId: code.vaultId, owner: code.owner, clientId: c.clientId, label: c.name, createdAt: new Date(this.now()).toISOString() }) };
    }
    if (p.grant_type === "refresh_token") {
      const g = p.refresh_token ? this.state.grants.find((x) => x.refreshHash === sha256(p.refresh_token!)) : undefined;
      if (!g || g.clientId !== c.clientId || Date.parse(g.refreshExpiresAt) <= this.now()) return bad("invalid_grant", "the refresh token is invalid or expired");
      this.tokens.revokeOne(g.vaultId, g.accessTokenId); // rotation: the previous access token stops working
      return { ok: true, body: this.issue(g) };
    }
    return bad("unsupported_grant_type", "use authorization_code or refresh_token");
  }

  /** RFC 7009: revoke an access or refresh token. Always "ok", to leak nothing. */
  revoke(token: string | undefined): void {
    if (!token) return;
    const g = this.state.grants.find((x) => x.refreshHash === sha256(token) || x.accessTokenId === sha256(token).slice(0, 12));
    if (g) this.revokeGrant(g);
    else this.tokens.revokeToken(token);
  }

  /** The owner revoked an OAuth token in the dashboard: end its grant too, so the refresh token stops working. */
  revokeForAccessToken(vaultId: string, tokenId: string): void {
    const g = this.state.grants.find((x) => x.vaultId === vaultId && x.accessTokenId === tokenId);
    if (g) this.revokeGrant(g);
  }

  /** Every grant on a vault (the owner revoked all tokens). */
  revokeVault(vaultId: string): void {
    for (const g of this.state.grants.filter((x) => x.vaultId === vaultId)) this.revokeGrant(g);
  }

  private revokeGrant(g: OAuthGrant): void {
    this.tokens.revokeOne(g.vaultId, g.accessTokenId);
    this.state.grants = this.state.grants.filter((x) => x.id !== g.id);
    this.save();
  }

  private gc(): void {
    const t = this.now();
    for (const [k, r] of this.requests) if (r.expiresAt <= t) this.requests.delete(k);
    for (const [k, c] of this.codes) if (c.expiresAt <= t) this.codes.delete(k);
  }
}

/** Parse a token or revoke request: form-encoded (the standard) or JSON. */
async function params(req: { header(n: string): string | undefined; text(): Promise<string> }): Promise<Record<string, string | undefined>> {
  const text = await req.text().catch(() => "");
  if ((req.header("content-type") ?? "").includes("application/json")) {
    try {
      const o = JSON.parse(text) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "string" ? v : undefined]));
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

/** The public OAuth endpoints. The consent itself is an owner route (owner/routes.ts). */
export function mountOAuth(app: Hono<any>, oauth: OAuthServer, allow: (key: string, limit: number, windowMs: number) => boolean): void {
  for (const p of ["/.well-known/oauth-authorization-server", "/oauth/register", "/oauth/token", "/oauth/revoke"]) app.use(p, cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["content-type", "authorization"] }));
  app.get("/.well-known/oauth-authorization-server", (c) => c.json(oauth.metadata()));
  const ip = (c: { req: { header(n: string): string | undefined } }) => (c.req.header("x-forwarded-for") ?? "").split(",")[0]!.trim() || "unknown";

  app.post("/oauth/register", async (c) => {
    if (!allow(`oauth-register:${ip(c)}`, 20, 3_600_000)) return c.json({ error: "slow_down", error_description: "too many registrations" }, 429);
    const body = (await c.req.json().catch(() => ({}))) as { redirect_uris?: unknown; client_name?: unknown };
    const r = oauth.register(body);
    if ("error" in r) return c.json({ error: "invalid_redirect_uri", error_description: r.error }, 400);
    return c.json({ client_id: r.clientId, client_name: r.name, redirect_uris: r.redirectUris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], client_id_issued_at: Math.floor(Date.parse(r.createdAt) / 1000) }, 201);
  });

  app.get("/oauth/authorize", (c) => {
    if (!allow(`oauth-authorize:${ip(c)}`, 60, 600_000)) return c.text("Too many sign-in attempts. Try again in a few minutes.", 429);
    const r = oauth.authorize(c.req.query());
    if ("redirect" in r) return c.redirect(r.redirect, 302);
    if (r.redirectToClient) return c.redirect(r.redirectToClient, 302);
    return c.text(`Norr could not start the sign-in: ${r.error}`, 400);
  });

  app.post("/oauth/token", async (c) => {
    if (!allow(`oauth-token:${ip(c)}`, 120, 600_000)) return c.json({ error: "slow_down" }, 429);
    const r = oauth.token(await params(c.req));
    c.header("cache-control", "no-store");
    if (!r.ok) return c.json({ error: r.error, error_description: r.description }, r.error === "invalid_client" ? 401 : 400);
    return c.json(r.body);
  });

  app.post("/oauth/revoke", async (c) => {
    oauth.revoke((await params(c.req)).token);
    return c.body(null, 200);
  });
}
