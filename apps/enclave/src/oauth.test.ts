import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TERMS_VERSION } from "./beta";
import { createMockEnclave } from "./mock-enclave";
import { validRedirectUri } from "./oauth";
import { newKey, signNep413 } from "./owner/test-keys";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

function boot() {
  const clock = { t: Date.UTC(2026, 10, 5, 12) };
  const m = createMockEnclave({ now: () => clock.t, publicUrl: "https://api.norr.test", dashboardUrl: "https://app.norr.test" });
  m.deps.settle = { waitMs: 0, intervalMs: 1 };
  const call = (path: string, o: { token?: string; body?: unknown; form?: Record<string, string>; method?: string } = {}) =>
    m.app.request(path, {
      method: o.method ?? (o.body !== undefined || o.form ? "POST" : "GET"),
      headers: { ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), "content-type": o.form ? "application/x-www-form-urlencoded" : "application/json" },
      body: o.form ? new URLSearchParams(o.form).toString() : o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
  return { m, call, clock };
}

async function signIn(call: ReturnType<typeof boot>["call"], account: string) {
  const k = newKey();
  const ch = await (await call("/owner/v1/challenge")).json();
  const r = await (await call("/owner/v1/login", { body: { accountId: account, publicKey: k.publicKey, signature: signNep413(k.privateKey, { message: ch.message, nonce: Buffer.from(ch.nonce, "base64"), recipient: ch.recipient }), nonce: ch.nonce } })).json();
  return r.token as string;
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

/** Register a client and run the browser part up to the code, as the Claude app and the owner would. */
async function codeFor(call: ReturnType<typeof boot>["call"], ownerToken: string, vaultId: string) {
  const reg = await (await call("/oauth/register", { body: { client_name: "Claude", redirect_uris: [REDIRECT] } })).json();
  const p = pkce();
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: p.challenge, code_challenge_method: "S256", state: "xyz", resource: "https://mcp.norr.test/mcp" });
  const auth = await call(`/oauth/authorize?${q}`);
  expect(auth.status).toBe(302);
  const consent = auth.headers.get("location")!;
  expect(consent).toMatch(/^https:\/\/app\.norr\.test\/#\/authorize\/[A-Za-z0-9_-]+$/);
  const rid = consent.split("/").pop()!;
  const shown = await (await call(`/owner/v1/oauth/requests/${rid}`, { token: ownerToken })).json();
  const approved = await (await call(`/owner/v1/oauth/requests/${rid}/approve`, { token: ownerToken, body: { vaultId } })).json();
  const back = new URL(approved.redirect);
  return { clientId: reg.client_id as string, verifier: p.verifier, code: back.searchParams.get("code")!, state: back.searchParams.get("state"), shown, back, rid };
}

describe("OAuth for MCP clients", () => {
  it("publishes its metadata: code flow with PKCE S256, public clients, refresh tokens", async () => {
    const { call } = boot();
    expect(await (await call("/.well-known/oauth-authorization-server")).json()).toMatchObject({
      issuer: "https://api.norr.test",
      authorization_endpoint: "https://api.norr.test/oauth/authorize",
      token_endpoint: "https://api.norr.test/oauth/token",
      registration_endpoint: "https://api.norr.test/oauth/register",
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      grant_types_supported: ["authorization_code", "refresh_token"],
    });
  });

  it("registration → consent for one vault → code → token that works on that vault only → refresh rotates → owner revokes", async () => {
    const { m, call } = boot();
    const owner = await signIn(call, "demo-owner.mock.near");
    const c = await codeFor(call, owner, "demo");
    expect(c.shown).toMatchObject({ clientName: "Claude", redirectHost: "claude.ai", vaults: [{ id: "demo", paused: false }] });
    expect(c.back.origin + c.back.pathname).toBe(REDIRECT);
    expect(c.state).toBe("xyz");

    const t = await (await call("/oauth/token", { form: { grant_type: "authorization_code", code: c.code, redirect_uri: REDIRECT, client_id: c.clientId, code_verifier: c.verifier } })).json();
    expect(t).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "vault" });
    expect(t.access_token).toMatch(/^norr_agent_/);
    expect((await call("/v1/policy", { token: t.access_token })).status).toBe(200);
    expect(m.tokens.vaultFor(t.access_token)).toBe("demo");
    // The code is single use.
    expect((await call("/oauth/token", { form: { grant_type: "authorization_code", code: c.code, redirect_uri: REDIRECT, client_id: c.clientId, code_verifier: c.verifier } })).status).toBe(400);

    // The owner sees it by name in Connect.
    const list = (await (await call("/owner/v1/vaults/demo/tokens", { token: owner })).json()).tokens.filter((x: { kind: string }) => x.kind === "oauth");
    expect(list).toMatchObject([{ label: "Claude", kind: "oauth", clientId: c.clientId }]);

    // Refresh: a new pair; the old access token stops working at once.
    const r = await (await call("/oauth/token", { form: { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: c.clientId } })).json();
    expect(r.access_token).not.toBe(t.access_token);
    expect((await call("/v1/policy", { token: t.access_token })).status).toBe(401);
    expect((await call("/v1/policy", { token: r.access_token })).status).toBe(200);
    expect((await call("/oauth/token", { form: { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: c.clientId } })).status).toBe(400); // rotated out
    expect((await (await call("/owner/v1/vaults/demo/tokens", { token: owner })).json()).tokens.filter((x: { kind: string }) => x.kind === "oauth")).toHaveLength(1);

    // The owner revokes it in the dashboard: access and refresh both end.
    const id = (await (await call("/owner/v1/vaults/demo/tokens", { token: owner })).json()).tokens.find((x: { kind: string }) => x.kind === "oauth").id;
    expect((await call(`/owner/v1/vaults/demo/tokens/${id}`, { token: owner, method: "DELETE" })).status).toBe(200);
    expect((await call("/v1/policy", { token: r.access_token })).status).toBe(401);
    expect((await call("/oauth/token", { form: { grant_type: "refresh_token", refresh_token: r.refresh_token, client_id: c.clientId } })).status).toBe(400);
  });

  it("access tokens expire after an hour", async () => {
    const { call, clock } = boot();
    const owner = await signIn(call, "demo-owner.mock.near");
    const c = await codeFor(call, owner, "demo");
    const t = await (await call("/oauth/token", { form: { grant_type: "authorization_code", code: c.code, redirect_uri: REDIRECT, client_id: c.clientId, code_verifier: c.verifier } })).json();
    clock.t += 3601_000;
    expect((await call("/v1/policy", { token: t.access_token })).status).toBe(401);
  });

  it("refuses: a wrong PKCE verifier, a code for another client, an unregistered redirect, plain http, no PKCE", async () => {
    const { call } = boot();
    const owner = await signIn(call, "demo-owner.mock.near");
    const c = await codeFor(call, owner, "demo");
    expect(await (await call("/oauth/token", { form: { grant_type: "authorization_code", code: c.code, redirect_uri: REDIRECT, client_id: c.clientId, code_verifier: "wrong".repeat(10) } })).json()).toMatchObject({ error: "invalid_grant" });
    const c2 = await codeFor(call, owner, "demo");
    const other = await (await call("/oauth/register", { body: { redirect_uris: [REDIRECT] } })).json();
    expect(await (await call("/oauth/token", { form: { grant_type: "authorization_code", code: c2.code, redirect_uri: REDIRECT, client_id: other.client_id, code_verifier: c2.verifier } })).json()).toMatchObject({ error: "invalid_grant" });
    expect((await call("/oauth/register", { body: { redirect_uris: ["http://evil.example/cb"] } })).status).toBe(400);
    const reg = await (await call("/oauth/register", { body: { redirect_uris: [REDIRECT] } })).json();
    expect((await call(`/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: "https://evil.example/cb", code_challenge: "a".repeat(43), code_challenge_method: "S256" })}`)).status).toBe(400);
    const noPkce = await call(`/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, state: "s" })}`);
    expect(noPkce.status).toBe(302);
    expect(noPkce.headers.get("location")).toBe(`${REDIRECT}?error=invalid_request&state=s`);
    expect(validRedirectUri("http://127.0.0.1:33418/callback")).toBe(true);
    expect(validRedirectUri("https://a.example/cb#frag")).toBe(false);
  });

  it("an owner can only grant their own active vaults; another owner's request id gives nothing", async () => {
    const { call } = boot();
    const alice = await signIn(call, "alice.near");
    const reg = await (await call("/oauth/register", { body: { redirect_uris: [REDIRECT] } })).json();
    const p = pkce();
    const loc = (await call(`/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: p.challenge, code_challenge_method: "S256" })}`)).headers.get("location")!;
    const rid = loc.split("/").pop()!;
    expect((await (await call(`/owner/v1/oauth/requests/${rid}`, { token: alice })).json()).vaults).toEqual([]); // no vault yet
    expect((await call(`/owner/v1/oauth/requests/${rid}/approve`, { token: alice, body: { vaultId: "demo" } })).status).toBe(404); // not hers
    // A vault in setup cannot be granted either.
    const v = await (await call("/owner/v1/vaults", { token: alice, body: { acceptTerms: TERMS_VERSION } })).json();
    expect((await call(`/owner/v1/oauth/requests/${rid}/approve`, { token: alice, body: { vaultId: v.id } })).status).toBe(404);
    const denied = await (await call(`/owner/v1/oauth/requests/${rid}/deny`, { token: alice, body: {} })).json();
    expect(denied.redirect).toBe(`${REDIRECT}?error=access_denied`);
    expect((await call(`/owner/v1/oauth/requests/${rid}`, { token: alice })).status).toBe(404); // used up
  });
});
