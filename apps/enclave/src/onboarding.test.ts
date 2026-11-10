import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { MemoryVaultStore } from "./state";
import { describe, expect, it } from "vitest";
import { createMockEnclave, MOCK_VAULT_START_USD } from "./mock-enclave";
import { Onboarding } from "./onboarding";
import { newKey, signNep413 } from "./owner/test-keys";
import { DataCipher } from "./seal";
import { FileTenantStore } from "./tenants";
import { AgentTokens, FileTokenPersistence } from "./tokens";
import { TERMS_VERSION } from "./beta";
import { upstreamReason } from "./errors";
import { IntentsApiError } from "@norr/intents";

type Mock = ReturnType<typeof createMockEnclave>;

function boot() {
  const m = createMockEnclave();
  m.deps.settle = { waitMs: 0, intervalMs: 1 };
  const call = (path: string, o: { token?: string; body?: unknown; method?: string; headers?: Record<string, string> } = {}) =>
    m.app.request(path, {
      method: o.method ?? (o.body !== undefined ? "POST" : "GET"),
      headers: { ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), "content-type": "application/json", ...(o.headers ?? {}) },
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
  return { m, call };
}

async function signIn(m: Mock, call: ReturnType<typeof boot>["call"], account: string) {
  const k = newKey();
  const ch = await (await call("/owner/v1/challenge")).json();
  const r = await (await call("/owner/v1/login", { body: { accountId: account, publicKey: k.publicKey, signature: signNep413(k.privateKey, { message: ch.message, nonce: Buffer.from(ch.nonce, "base64"), recipient: ch.recipient }), nonce: ch.nonce } })).json();
  return { token: r.token as string, key: k, account };
}

/** Sign in, create, prepare, store as the owner's wallet, activate. */
async function activeVault(m: Mock, call: ReturnType<typeof boot>["call"], account: string, autonomous = false) {
  const s = await signIn(m, call, account);
  const created = await (await call("/owner/v1/vaults", { token: s.token, body: { acceptTerms: TERMS_VERSION, nonUsConfirmed: true } })).json();
  const prep = await (await call(`/owner/v1/vaults/${created.id}/custody-policy`, { token: s.token, body: { autonomous, ...(autonomous ? { confirmAutonomous: true } : {}) } })).json();
  expect((await call("/mock-outlayer/chain/store_wallet_policy", { token: s.token, body: { args: prep.call.args } })).status).toBe(200);
  expect(await (await call(`/owner/v1/vaults/${created.id}/activate`, { token: s.token, body: {} })).json()).toEqual({ status: "active" });
  const agent = (await (await call(`/owner/v1/vaults/${created.id}/tokens`, { token: s.token, body: { label: "test agent" } })).json()).token as string;
  return { ...s, id: created.id as string, prep, agent };
}

describe("self-serve vaults: create, policy signed by the owner's wallet, activate", () => {
  it("walks a new owner from the empty state to a vault the agent can trade, with the owner as controller and only approver", async () => {
    const { m, call } = boot();
    expect(await (await call("/beta")).json()).toMatchObject({ selfServe: true, signupsOpen: true, depositCapUsd: 100, maxVaultsPerOwner: 1, termsVersion: TERMS_VERSION });
    const alice = await signIn(m, call, "alice.near");
    expect(await (await call("/owner/v1/vaults", { token: alice.token })).json()).toEqual({ vaults: [] }); // the empty state
    expect((await call("/owner/v1/vaults", { token: alice.token, body: { acceptTerms: "old" } })).status).toBe(400);
    const res = await call("/owner/v1/vaults", { token: alice.token, body: { acceptTerms: TERMS_VERSION } });
    expect(res.status).toBe(201);
    const v = await res.json();
    expect(v).toMatchObject({ status: "setup", custody: { prepared: false }, terms: { version: TERMS_VERSION } });
    expect(JSON.stringify(v)).not.toMatch(/wk_/); // the custody key is never returned
    expect((await call("/owner/v1/vaults", { token: alice.token, body: { acceptTerms: TERMS_VERSION } })).status).toBe(409); // one per account

    // Nothing works on a vault in setup: no tokens, no funding, no agent.
    expect((await call(`/owner/v1/vaults/${v.id}/tokens`, { token: alice.token, body: {} })).status).toBe(404);
    expect((await call(`/owner/v1/vaults/${v.id}/funding`, { token: alice.token, body: { amountUsd: 5 } })).status).toBe(404);

    const prep = await (await call(`/owner/v1/vaults/${v.id}/custody-policy`, { token: alice.token, body: {} })).json();
    expect(prep.controller).toBe("alice.near");
    expect(prep.policy.rules.transaction_types).toEqual(["confidential"]);
    expect(prep.policy.rules.addresses.list).toEqual(["alice.near", v.walletAccount]);
    expect(prep.policy.approval).toEqual({ threshold: { required: 1 }, approvers: [{ id: "alice.near", role: "admin" }] });
    expect(prep.call).toMatchObject({ contractId: "outlayer.near", methodName: "store_wallet_policy", gas: "100000000000000" });
    expect(BigInt(prep.call.deposit)).toBeGreaterThan(0n);
    expect(prep.summary.join(" ")).toMatch(/waits for your approval/);

    expect(await (await call(`/owner/v1/vaults/${v.id}/activate`, { token: alice.token, body: {} })).json()).toMatchObject({ status: "setup", problems: [expect.stringMatching(/not on chain yet/)] });
    // Someone else's wallet cannot store it: the keystore signed it for Alice only.
    const mallory = await signIn(m, call, "mallory.near");
    expect(await (await call("/mock-outlayer/chain/store_wallet_policy", { token: mallory.token, body: { args: prep.call.args } })).json()).toMatchObject({ error: "Invalid Ed25519 wallet signature" });
    expect((await call("/mock-outlayer/chain/store_wallet_policy", { token: alice.token, body: { args: prep.call.args } })).status).toBe(200);
    expect(await (await call(`/owner/v1/vaults/${v.id}/activate`, { token: alice.token, body: {} })).json()).toEqual({ status: "active" });
    expect(await m.provisioner.onChainPolicy(prep.call.args.wallet_pubkey)).toMatchObject({ owner: "alice.near", frozen: false });
    expect((await call(`/owner/v1/vaults/${v.id}/custody-policy`, { token: alice.token, body: {} })).status).toBe(409); // active: only Alice, as controller, changes it

    // Active: the beta rules, an agent token, and a trade that waits for Alice's approval (not autonomous).
    const vault = await (await call(`/owner/v1/vaults/${v.id}`, { token: alice.token })).json();
    expect(vault).toMatchObject({ status: "active", policy: { maxTradeUsd: 10, dailySpendCapUsd: 30, privacy: "require", nonUsConfirmed: false } });
    expect(vault.portfolio.totalUsd).toBeCloseTo(MOCK_VAULT_START_USD, 6);
    const agent = (await (await call(`/owner/v1/vaults/${v.id}/tokens`, { token: alice.token, body: { label: "Claude" } })).json()).token;
    expect(await (await call(`/owner/v1/vaults/${v.id}/tokens`, { token: alice.token })).json()).toMatchObject({ tokens: [{ label: "Claude", kind: "token", vaultId: v.id }] });
    const trade = await (await call("/v1/trade", { token: agent, body: { side: "buy", asset: "SOL", amountUsd: 5 } })).json();
    expect(trade.status).toBe("pending_approval");
    const pending = await (await call(`/owner/v1/vaults/${v.id}/pending`, { token: alice.token })).json();
    const approvalId = pending.pending[0].approvalId as string;
    const d = await (await call(`/mock-outlayer/wallet/v1/approval/${approvalId}`)).json();
    expect(d.wallet_pubkey).toBe(prep.call.args.wallet_pubkey);
    expect(createHash("sha256").update(d.op_canonical).digest("hex")).toBe(d.request_hash);
    const vote = (who: typeof alice) => {
      const nonce = Buffer.alloc(32, 9);
      return call(`/mock-outlayer/wallet/v1/approve/${approvalId}`, { body: { signature: signNep413(who.key.privateKey, { message: `approve:${approvalId}:${d.wallet_pubkey}:${d.request_hash}`, nonce, recipient: "outlayer.near" }), public_key: who.key.publicKey, account_id: who.account, nonce: nonce.toString("base64") } });
    };
    expect((await vote(mallory)).status).toBe(403); // not this vault's approver
    expect((await vote(alice)).status).toBe(200);
    const act = await (await call(`/owner/v1/vaults/${v.id}/activity`, { token: alice.token })).json();
    expect(act.activity[0].decision.status).toBe("executed");
  });

  it("autonomous mode is the owner's choice: off by default, and when chosen only the approval exclusion changes", async () => {
    const { m, call } = boot();
    const a = await activeVault(m, call, "auto.near", true);
    expect(a.prep.policy.approval.excluded_types).toEqual(["confidential"]);
    expect(a.prep.summary.join(" ")).toMatch(/Autonomous/);
    expect((await (await call("/v1/trade", { token: a.agent, body: { side: "buy", asset: "SOL", amountUsd: 5 } })).json()).status).toBe("executed");
  });

  it("refuses to activate a wallet controlled by someone else, or holding a different policy than the one prepared", async () => {
    const { m, call } = boot();
    const alice = await signIn(m, call, "alice.near");
    const v = await (await call("/owner/v1/vaults", { token: alice.token, body: { acceptTerms: TERMS_VERSION } })).json();
    const prep = await (await call(`/owner/v1/vaults/${v.id}/custody-policy`, { token: alice.token, body: {} })).json();
    const key = m.tenants.key(v.id)!;
    // A weaker policy (Mallory whitelisted), signed for Alice and stored by Alice's wallet: activation names the difference.
    const weaker = { ...prep.policy, rules: { ...prep.policy.rules, addresses: { mode: "whitelist", list: ["alice.near", "mallory.near"] } } };
    const call2 = await m.provisioner.preparePolicyStore({ walletId: m.tenants.get(v.id)!.walletId, apiKey: key }, weaker, "alice.near");
    m.provisioner.storeWalletPolicy("alice.near", call2.args);
    expect(await (await call(`/owner/v1/vaults/${v.id}/activate`, { token: alice.token, body: {} })).json()).toEqual({ status: "setup", problems: ["The address whitelist differs."] });

    // A wallet whose policy someone else stored first is never used.
    const bob = await signIn(m, call, "bob.near");
    const vb = await (await call("/owner/v1/vaults", { token: bob.token, body: { acceptTerms: TERMS_VERSION } })).json();
    const pb = await (await call(`/owner/v1/vaults/${vb.id}/custody-policy`, { token: bob.token, body: {} })).json();
    const hijack = await m.provisioner.preparePolicyStore({ walletId: m.tenants.get(vb.id)!.walletId, apiKey: m.tenants.key(vb.id)! }, pb.policy, "mallory.near");
    m.provisioner.storeWalletPolicy("mallory.near", hijack.args);
    expect(await (await call(`/owner/v1/vaults/${vb.id}/activate`, { token: bob.token, body: {} })).json()).toMatchObject({ status: "setup", problems: [expect.stringMatching(/controlled by mallory\.near, not by you/)] });
    // And a frozen wallet does not activate either.
    const carol = await signIn(m, call, "carol.near");
    const vc = await (await call("/owner/v1/vaults", { token: carol.token, body: { acceptTerms: TERMS_VERSION } })).json();
    const pc = await (await call(`/owner/v1/vaults/${vc.id}/custody-policy`, { token: carol.token, body: {} })).json();
    await call("/mock-outlayer/chain/store_wallet_policy", { token: carol.token, body: { args: pc.call.args } });
    m.provisioner.freeze(pc.call.args.wallet_pubkey);
    expect(await (await call(`/owner/v1/vaults/${vc.id}/activate`, { token: carol.token, body: {} })).json()).toEqual({ status: "setup", problems: ["The wallet is frozen."] });
  });
});

describe("isolation between owners", () => {
  it("no owner route answers for another owner's vault: every :id route returns 404 with the other owner's session", async () => {
    const { m, call } = boot();
    const a = await activeVault(m, call, "alice.near");
    const b = await activeVault(m, call, "bob.near");
    const routes = (m.app.routes as { method: string; path: string }[]).filter((r) => r.path.startsWith("/owner/v1/vaults/:id") && r.method !== "ALL");
    expect(routes.length).toBeGreaterThanOrEqual(15);
    for (const r of routes) {
      const path = r.path.replace(":id", b.id).replace(":tid", "x").replace(":fid", "x");
      const res = await call(path, { token: a.token, method: r.method, body: r.method === "GET" || r.method === "DELETE" ? undefined : {} });
      expect([r.method, r.path, res.status]).toEqual([r.method, r.path, 404]);
    }
    // Bob's vault is untouched: not paused, his token still works.
    expect((await (await call(`/owner/v1/vaults/${b.id}`, { token: b.token })).json()).paused).toBe(false);
    expect((await call("/v1/policy", { token: b.agent })).status).toBe(200);
    // Kill switch pauses only the caller's vaults.
    await call("/owner/v1/pause-all", { token: a.token, body: {} });
    expect((await (await call(`/owner/v1/vaults/${b.id}`, { token: b.token })).json()).paused).toBe(false);
    // A's list never shows B's vault.
    expect((await (await call("/owner/v1/vaults", { token: a.token })).json()).vaults.map((v: { id: string }) => v.id)).toEqual([a.id]);
  });

  it("an agent token reaches only its own vault, and one owner cannot revoke another's tokens", async () => {
    const { m, call } = boot();
    const a = await activeVault(m, call, "alice.near", true);
    const b = await activeVault(m, call, "bob.near", true);
    await call("/v1/trade", { token: a.agent, body: { side: "buy", asset: "SOL", amountUsd: 5 } });
    const pa = await (await call("/v1/portfolio", { token: a.agent })).json();
    const pb = await (await call("/v1/portfolio", { token: b.agent })).json();
    expect(pa.holdings.map((h: { symbol: string }) => h.symbol).sort()).toEqual(["SOL", "USDC"]);
    expect(pb.holdings.map((h: { symbol: string }) => h.symbol)).toEqual(["USDC"]);
    expect((await (await call("/v1/activity", { token: b.agent })).json()).activity).toHaveLength(0);
    const bTokenId = (await (await call(`/owner/v1/vaults/${b.id}/tokens`, { token: b.token })).json()).tokens[0].id;
    expect((await call(`/owner/v1/vaults/${a.id}/tokens/${bTokenId}`, { token: a.token, method: "DELETE" })).status).toBe(404);
    expect((await call("/v1/policy", { token: b.agent })).status).toBe(200);
    expect((await call(`/owner/v1/vaults/${b.id}/tokens/${bTokenId}`, { token: b.token, method: "DELETE" })).status).toBe(200);
    expect((await call("/v1/policy", { token: b.agent })).status).toBe(401);
  });
});

describe("public-beta safeguards", () => {
  it("the operator switch pauses new vaults (and only new vaults), behind the admin token", async () => {
    const { m, call } = boot();
    const a = await activeVault(m, call, "alice.near", true);
    expect((await call("/admin/v1/signups", { body: { open: false }, headers: { "x-admin-token": "wrong" } })).status).toBe(401);
    expect(await (await call("/admin/v1/signups", { body: { open: false }, headers: { "x-admin-token": m.adminToken } })).json()).toEqual({ signupsOpen: false });
    expect((await (await call("/beta")).json()).signupsOpen).toBe(false);
    const bob = await signIn(m, call, "bob.near");
    const r = await call("/owner/v1/vaults", { token: bob.token, body: { acceptTerms: TERMS_VERSION } });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toMatch(/paused/);
    expect((await (await call("/v1/trade", { token: a.agent, body: { side: "buy", asset: "SOL", amountUsd: 5 } })).json()).status).toBe("executed");
    expect(m.provisioner.registrations).toBe(1);
  });

  it("deposit cap: funding past it is refused, and buys pause while a vault holds more", async () => {
    const { m, call } = boot();
    const a = await activeVault(m, call, "alice.near", true);
    const r = await call(`/owner/v1/vaults/${a.id}/funding`, { token: a.token, body: { amountUsd: 10 } });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/up to \$100 per vault.*add up to \$0/);
    m.deps.vaultCapUsd = (id) => (id === a.id ? 50 : undefined);
    const d = await (await call("/v1/trade", { token: a.agent, body: { side: "buy", asset: "SOL", amountUsd: 5 } })).json();
    expect(d).toMatchObject({ status: "blocked", code: "VAULT_CAP" });
    // The demo vault configured at startup has no beta cap.
    expect((await (await call("/v1/trade", { token: m.agentToken, body: { side: "buy", asset: "SOL", amountUsd: 5 } })).json()).status).toBe("executed");
  });

  it("rate limits: trades per agent per minute, and vault creation per account", async () => {
    const { m, call } = boot();
    const a = await activeVault(m, call, "alice.near", true);
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await call("/v1/trade", { token: a.agent, body: { side: "buy", asset: "SOL", amountUsd: 1 } })).status);
    expect(codes.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(codes[10]).toBe(429);
    const bob = await signIn(m, call, "bob.near");
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await call("/owner/v1/vaults", { token: bob.token, body: { acceptTerms: TERMS_VERSION } })).status);
    expect(statuses).toEqual([201, 409, 409, 409, 409, 429]);
  });

  it("a custody provider outage while creating leaves no half-made vault", async () => {
    const { m, call } = boot();
    m.provisioner.failRegister = true;
    const alice = await signIn(m, call, "alice.near");
    expect((await call("/owner/v1/vaults", { token: alice.token, body: { acceptTerms: TERMS_VERSION } })).status).toBe(502);
    expect(m.tenants.list()).toHaveLength(0);
  });
});

describe("persistence of self-serve vaults", () => {
  it("records, custody keys and token hashes survive a restart, each bound to its vault id", () => {
    const dir = mkdtempSync(join(tmpdir(), "norr-tenants-"));
    const cipher = DataCipher.random();
    const a = new FileTenantStore(dir, cipher);
    const rec = { id: "v_aaaaaaaaaaaa", owner: "alice.near", walletId: "w", walletAccount: "a".repeat(64), status: "active" as const, createdAt: "t", terms: { version: TERMS_VERSION, acceptedAt: "t" }, nonUsConfirmed: false };
    a.put(rec);
    a.setKey(rec.id, "wk_secret");
    a.put({ ...rec, id: "v_bbbbbbbbbbbb", owner: "bob.near" });
    a.setKey("v_bbbbbbbbbbbb", "wk_bob");
    const b = new FileTenantStore(dir, cipher);
    expect(b.get(rec.id)).toEqual(rec);
    expect(b.key(rec.id)).toBe("wk_secret");
    expect(readFileSync(join(dir, "tenants", `${rec.id}.key`), "utf8")).not.toContain("wk_secret");
    // Alice's key copied over Bob's does not decrypt as Bob's.
    writeFileSync(join(dir, "tenants", "v_bbbbbbbbbbbb.key"), readFileSync(join(dir, "tenants", `${rec.id}.key`)));
    expect(() => b.key("v_bbbbbbbbbbbb")).toThrow(/unreadable/);
    expect(b.get("../etc")).toBeUndefined();

    const t1 = new AgentTokens(new FileTokenPersistence(dir, cipher));
    const tok = t1.issue(rec.id, { label: "Claude" });
    const t2 = new AgentTokens(new FileTokenPersistence(dir, cipher));
    expect(t2.vaultFor(tok)).toBe(rec.id);
    expect(t2.list(rec.id)).toMatchObject([{ label: "Claude", kind: "token" }]);
    t2.revoke(rec.id);
    expect(new AgentTokens(new FileTokenPersistence(dir, cipher)).vaultFor(tok)).toBeUndefined();
  });

  it("restore puts every active vault back into service after a restart, and none in setup", async () => {
    const { m, call } = boot();
    const a = await activeVault(m, call, "alice.near");
    const bob = await signIn(m, call, "bob.near");
    await call("/owner/v1/vaults", { token: bob.token, body: { acceptTerms: TERMS_VERSION } }); // stays in setup
    const vaults = new MemoryVaultStore([]);
    const again = new Onboarding({ tenants: m.tenants, provisioner: m.provisioner, vaults, registry: m.deps.registry, cash: () => m.deps.quoteAsset, beta: m.beta, now: Date.now, custodyFor: () => m.rails.custody });
    expect(again.restore()).toBe(1);
    expect(vaults.list().map((v) => [v.id, v.owner])).toEqual([[a.id, "alice.near"]]);
    expect(again.restore()).toBe(0);
  });
});

describe("funding errors name the real cause (seen live 2026-11-05)", () => {
  it("1Click refusing the route, a failed balance read, and a bad refund address each say what happened", async () => {
    const { m, call } = boot();
    const a = await activeVault(m, call, "alice.near", true);
    m.deps.vaultCapUsd = () => undefined;
    const funder = m.deps.funder!;
    const fund = async () => (await call(`/owner/v1/vaults/${a.id}/funding`, { token: a.token, body: { amountUsd: 5, refundTo: "refund-wallet.near" } })).json();

    funder.requestDeposit = async () => { throw new IntentsApiError(400, "1Click deposit quote: Quoting for this pair is not available"); };
    expect((await fund()).error).toMatch(/1Click is not quoting deposits from USDC on NEAR into the vault right now \(it answered "Quoting for this pair is not available"\)\. This is on 1Click's side, not your vault or refund address/);

    funder.requestDeposit = async () => { throw new IntentsApiError(400, "1Click deposit quote: refundTo is not valid"); };
    expect((await fund()).error).toBe('1Click did not accept "refund-wallet.near" as a NEAR refund address. Check it and try again.');

    funder.requestDeposit = async () => { throw new IntentsApiError(503, "1Click deposit quote: upstream timeout"); };
    expect((await fund()).error).toBe('No deposit address: 1Click deposit quote failed on its side (HTTP 503: "upstream timeout"). Try again shortly.');

    const custody = m.vaults.get(a.id)!.custody;
    custody.confidentialHoldings = async () => { throw new IntentsApiError(401, "OutLayer confidential balance: invalid api key"); };
    expect((await fund()).error).toMatch(/^No address was requested: the vault's confidential balance could not be read first\. OutLayer confidential balance refused it \(HTTP 401\): "invalid api key"\.$/);
  });

  it("upstreamReason: unreachable, rate-limited, policy, server error, refusal", () => {
    expect(upstreamReason(new IntentsApiError(0, "NEAR RPC: fetch failed"), "x")).toBe("NEAR RPC: could not be reached (fetch failed). Try again shortly.");
    expect(upstreamReason(new IntentsApiError(429, "1Click: Too Many Requests"), "x")).toMatch(/^1Click is limiting requests/);
    expect(upstreamReason(new IntentsApiError(403, "OutLayer: Address 'x.near' is not in whitelist"), "x")).toBe(`The vault's custody policy refused this (the custody provider answered "Address 'x.near' is not in whitelist").`);
    expect(upstreamReason(new Error("boom"), "GoPlus")).toBe('GoPlus refused it: "boom".');
  });
});

describe("vault names", () => {
  it("named at creation, renamed later (in setup or active), shown in the list and on the consent screen; bad names refused", async () => {
    const { m, call } = boot();
    const s = await signIn(m, call, "alice.near");
    expect((await call("/owner/v1/vaults", { token: s.token, body: { acceptTerms: TERMS_VERSION, name: "<script>" } })).status).toBe(400);
    expect(m.provisioner.registrations).toBe(0); // refused before any wallet is made
    const v = await (await call("/owner/v1/vaults", { token: s.token, body: { acceptTerms: TERMS_VERSION, name: "  Claude's   NVDA fund " } })).json();
    expect(v.name).toBe("Claude's NVDA fund");
    expect(await (await call(`/owner/v1/vaults/${v.id}/name`, { token: s.token, method: "PUT", body: { name: "Agent fund" } })).json()).toEqual({ id: v.id, name: "Agent fund" });
    const prep = await (await call(`/owner/v1/vaults/${v.id}/custody-policy`, { token: s.token, body: {} })).json();
    await call("/mock-outlayer/chain/store_wallet_policy", { token: s.token, body: { args: prep.call.args } });
    await call(`/owner/v1/vaults/${v.id}/activate`, { token: s.token, body: {} });
    expect((await (await call(`/owner/v1/vaults/${v.id}`, { token: s.token })).json()).name).toBe("Agent fund");
    await call(`/owner/v1/vaults/${v.id}/name`, { token: s.token, method: "PUT", body: { name: "Main" } });
    expect((await (await call("/owner/v1/vaults", { token: s.token })).json()).vaults[0]).toMatchObject({ id: v.id, name: "Main", status: "active" });
    expect((await call(`/owner/v1/vaults/${v.id}/name`, { token: s.token, method: "PUT", body: { name: "x".repeat(41) } })).status).toBe(400);
  });
});

describe("direct NEAR deposit when 1Click cannot quote", () => {
  it("offers the direct deposit only then, and the owner-approved shield moves it into the confidential layer", async () => {
    const { m, call } = boot();
    const a = await activeVault(m, call, "alice.near"); // not autonomous: the shield waits for Alice
    m.deps.vaultCapUsd = () => undefined;
    const usdc = m.deps.quoteAsset.id;
    const vault = m.vaults.get(a.id)!;
    m.deps.funder!.requestDeposit = async () => { throw new IntentsApiError(400, "1Click deposit quote: Quoting for this pair is not available"); };
    const r = await (await call(`/owner/v1/vaults/${a.id}/funding`, { token: a.token, body: { amountUsd: 5, refundTo: "refund-wallet.near" } })).json();
    expect(r.error).toMatch(/deposit directly on NEAR instead \(public until you move it into the confidential layer\)/);
    expect(r.directDeposit).toMatchObject({
      contractId: usdc.replace(/^nep141:/, ""),
      methodName: "ft_transfer_call",
      args: { receiver_id: "intents.near", amount: "5000000", msg: vault.walletAccount },
      gas: "100000000000000",
      deposit: "1",
      recipient: vault.walletAccount,
    });
    expect(r.directDeposit.note).toMatch(/visible on chain until you move it into the confidential layer/);
    // From another chain the direct path is not offered (it only works for a NEAR token).
    const base = (await (await call("/owner/v1/funding/sources", { token: a.token })).json()).sources.find((s: { chain: string }) => s.chain === "base");
    expect((await (await call(`/owner/v1/vaults/${a.id}/funding`, { token: a.token, body: { amountUsd: 5, source: base.assetId, refundTo: "0x0000000000000000000000000000000000000001" } })).json()).directDeposit).toBeUndefined();

    expect((await call(`/owner/v1/vaults/${a.id}/shield`, { token: a.token, body: {} })).status).toBe(400); // nothing public yet
    const rails = m.tenantRails.get(a.id)!.rails;
    rails.creditPublic(usdc, "5000000"); // the direct deposit lands in the vault's public balance
    const before = BigInt((await vault.custody.confidentialHoldings())[usdc] ?? "0");
    const sh = await (await call(`/owner/v1/vaults/${a.id}/shield`, { token: a.token, body: {} })).json();
    expect(sh).toMatchObject({ status: "pending_approval", amountUsdc: 5 });
    expect((await call(`/owner/v1/vaults/${a.id}/shield`, { token: a.token, body: {} })).status).toBe(409);

    const list = await (await call(`/owner/v1/vaults/${a.id}/pending`, { token: a.token })).json();
    const item = list.pending.find((p: { kind: string }) => p.kind === "shield");
    expect(item).toMatchObject({ kind: "shield", sends: { amount: 5, symbol: "USDC" }, intended: { tokenIn: usdc, amountIn: "5000000", tokenOut: usdc } });
    expect(list.unknown).toEqual([]); // Norr asked for it, so it is not "unknown"
    const d = await (await call(`/mock-outlayer/wallet/v1/approval/${item.approvalId}`)).json();
    expect(JSON.parse(d.op_canonical)).toMatchObject({ flow: "shield", token: usdc, amount: "5000000" });
    const nonce = Buffer.alloc(32, 3);
    expect((await call(`/mock-outlayer/wallet/v1/approve/${item.approvalId}`, { body: { signature: signNep413(a.key.privateKey, { message: `approve:${item.approvalId}:${d.wallet_pubkey}:${d.request_hash}`, nonce, recipient: "outlayer.near" }), public_key: a.key.publicKey, account_id: "alice.near", nonce: nonce.toString("base64") } })).status).toBe(200);
    expect((await (await call(`/owner/v1/vaults/${a.id}/pending`, { token: a.token })).json()).pending).toHaveLength(0);
    expect(BigInt((await vault.custody.confidentialHoldings())[usdc]!) - before).toBe(5_000_000n);
    expect((await rails.balances.holdings(vault.walletAccount))[usdc]).toBeUndefined();
  });
});

describe("default assets fit the default trade limit", () => {
  it("a new vault's rules and custody policy leave out stocks whose minimum is above $10 (SPY), and list_assets flags them", async () => {
    const { m, call } = boot();
    const a = await activeVault(m, call, "alice.near", true);
    const spy = m.deps.registry.entries("equity").find((e) => e.ticker === "SPY")!;
    const nvda = m.deps.registry.entries("equity").find((e) => e.ticker === "NVDA")!;
    expect(a.prep.policy.rules.allowed_tokens).toContain(nvda.id);
    expect(a.prep.policy.rules.allowed_tokens).not.toContain(spy.id);
    const rules = await (await call("/v1/policy", { token: a.agent })).json();
    expect(rules.allowedEquities).toEqual(expect.arrayContaining(["NVDA", "TSLA", "QQQ"]));
    expect(rules.allowedEquities).not.toContain("SPY");
    const assets = await (await call("/v1/assets?class=equity", { token: a.agent })).json();
    expect(assets.equities.find((e: { ticker: string }) => e.ticker === "SPY")).toMatchObject({ minimumUsd: 26, aboveYourTradeLimit: true, note: "Its minimum order (about $26) is above this vault's largest trade ($10)." });
    expect(assets.equities.find((e: { ticker: string }) => e.ticker === "NVDA").aboveYourTradeLimit).toBeUndefined();
    expect(assets.equityMinimumNote).toMatch(/minimums vary with available liquidity/);
  });
});

describe("trading and checking by contract address", () => {
  it("a routable contract trades like any asset; an unroutable one gets a safety report and is never traded", async () => {
    const { m, call } = boot();
    const a = await activeVault(m, call, "alice.near", true);
    m.deps.vaultCapUsd = () => undefined;
    // USDC on Base is in the mock catalog with its contract.
    const byContract = await (await call("/v1/assets/check?asset=base:0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913", { token: a.agent })).json();
    expect(byContract).toMatchObject({ found: true, byContract: true, versions: [{ chain: "base", contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" }] });
    const bad = "base:0x0000000000000000000000000000000000000bad";
    const report = await (await call(`/v1/assets/check?asset=${bad}`, { token: a.agent })).json();
    expect(report).toMatchObject({ found: false, routable: false, contract: { chain: "base", address: "0x0000000000000000000000000000000000000bad" } });
    expect(report.message).toMatch(/is not available on NEAR Intents yet, so it can't be traded privately/);
    expect(report.safety.risk).toBeTruthy();
    expect((await (await call(`/v1/market?asset=${bad}`, { token: a.agent })).json()).routable).toBe(false);
    const t = await (await call("/v1/trade", { token: a.agent, body: { side: "buy", asset: bad, amountUsd: 5 } })).json();
    expect(t).toMatchObject({ status: "blocked", code: "UNKNOWN_ASSET" });
    expect(t.message).toMatch(/can't be traded privately/);
    // The owner's Check a token takes the same input.
    expect((await (await call(`/owner/v1/vaults/${a.id}/assets/check?asset=${bad}`, { token: a.token })).json()).routable).toBe(false);
  });
});


describe("autonomous mode: off by default, never a side effect, switchable by one owner signature (seen live 2026-11-05)", () => {
  it("the default policy has no approval exemption, and turning it on at setup needs an explicit confirmation", async () => {
    const { m, call } = boot();
    const s = await signIn(m, call, "alice.near");
    const v = await (await call("/owner/v1/vaults", { token: s.token, body: { acceptTerms: TERMS_VERSION } })).json();
    const dflt = await (await call(`/owner/v1/vaults/${v.id}/custody-policy`, { token: s.token, body: {} })).json();
    expect(dflt.policy.approval.excluded_types).toBeUndefined();
    expect(dflt.summary.join(" ")).toMatch(/waits for your approval/);
    // A bare autonomous: true (one stray tap, a script) is refused; nothing is prepared.
    const bare = await call(`/owner/v1/vaults/${v.id}/custody-policy`, { token: s.token, body: { autonomous: true } });
    expect(bare.status).toBe(400);
    expect((await bare.json()).error).toMatch(/Confirm that you want it on \(confirmAutonomous: true\)/);
    expect(m.tenants.get(v.id)!.custody!.autonomous).toBe(false);
    const on = await (await call(`/owner/v1/vaults/${v.id}/custody-policy`, { token: s.token, body: { autonomous: true, confirmAutonomous: true } })).json();
    expect(on.policy.approval.excluded_types).toEqual(["confidential"]);
  });

  it("the owner switches it on and off from Rules: one signature, only the exemption changes, and the vault follows", async () => {
    const { m, call } = boot();
    const a = await activeVault(m, call, "alice.near", true); // created autonomous, as the live vault was
    m.vaults.setPolicy(a.id, { ...m.vaults.get(a.id)!.policy, cooldownSec: 0 }); // two trades in a row below
    const trade = async () => (await (await call("/v1/trade", { token: a.agent, body: { side: "buy", asset: "SOL", amountUsd: 1.5 } })).json()).status;
    expect((await (await call(`/owner/v1/vaults/${a.id}`, { token: a.token })).json()).autonomous).toBe(true);
    expect(await trade()).toBe("executed"); // autonomous: no approval

    // Switching on again is a no-op; switching off needs no confirmation; nothing changes until the chain shows the new policy.
    expect((await call(`/owner/v1/vaults/${a.id}/custody-mode`, { token: a.token, body: { autonomous: true, confirmAutonomous: true } })).status).toBe(409);
    const off = await (await call(`/owner/v1/vaults/${a.id}/custody-mode`, { token: a.token, body: { autonomous: false } })).json();
    expect(off.summary.join(" ")).toMatch(/Autonomous mode OFF: every swap waits for your approval/);
    expect(off.policy.approval.excluded_types).toBeUndefined();
    // Only the exemption differs from the stored policy.
    const { approval: newApproval, ...restNew } = off.policy;
    const { approval: oldApproval, ...restOld } = a.prep.policy;
    expect(restNew).toEqual(restOld);
    expect({ ...oldApproval, excluded_types: undefined }).toEqual({ ...newApproval, excluded_types: undefined });
    // Only the storage difference is attached (the policy gets smaller, so just the margin).
    expect(BigInt(off.call.deposit)).toBeLessThanOrEqual(10n ** 21n);
    expect(await (await call(`/owner/v1/vaults/${a.id}/custody-mode/confirm`, { token: a.token, body: {} })).json()).toMatchObject({ status: "waiting" });
    expect((await (await call(`/owner/v1/vaults/${a.id}`, { token: a.token })).json()).autonomous).toBe(true); // unsigned: unchanged
    // Someone else's wallet cannot apply it.
    const mallory = await signIn(m, call, "mallory.near");
    expect((await call("/mock-outlayer/chain/store_wallet_policy", { token: mallory.token, body: { args: off.call.args } })).status).toBe(400);
    expect((await call("/mock-outlayer/chain/store_wallet_policy", { token: a.token, body: { args: off.call.args } })).status).toBe(200);
    expect(await (await call(`/owner/v1/vaults/${a.id}/custody-mode/confirm`, { token: a.token, body: {} })).json()).toEqual({ status: "applied", autonomous: false });
    expect((await (await call(`/owner/v1/vaults/${a.id}`, { token: a.token })).json()).autonomous).toBe(false);
    expect(await trade()).toBe("pending_approval"); // now every swap waits for Alice

    // Back on: refused without the confirmation, applied with it and the signature.
    const bare = await call(`/owner/v1/vaults/${a.id}/custody-mode`, { token: a.token, body: { autonomous: true } });
    expect(bare.status).toBe(400);
    const on = await (await call(`/owner/v1/vaults/${a.id}/custody-mode`, { token: a.token, body: { autonomous: true, confirmAutonomous: true } })).json();
    expect(on.summary.join(" ")).toMatch(/within the largest trade, the daily spending cap and the operations-per-hour limit/);
    await call("/mock-outlayer/chain/store_wallet_policy", { token: a.token, body: { args: on.call.args } });
    expect(await (await call(`/owner/v1/vaults/${a.id}/custody-mode/confirm`, { token: a.token, body: {} })).json()).toEqual({ status: "applied", autonomous: true });
  });

  it("another owner's vault answers 404 on both mode routes", async () => {
    const { m, call } = boot();
    const a = await activeVault(m, call, "alice.near");
    const b = await activeVault(m, call, "bob.near");
    for (const path of ["custody-mode", "custody-mode/confirm"]) {
      expect((await call(`/owner/v1/vaults/${b.id}/${path}`, { token: a.token, body: { autonomous: true, confirmAutonomous: true } })).status).toBe(404);
    }
  });
});

describe("withdraw from a self-serve vault", () => {
  it("goes to the owner through approval, and is refused while the vault is autonomous", async () => {
    const { m, call } = boot();
    const a = await activeVault(m, call, "alice.near");
    const w = await call(`/owner/v1/vaults/${a.id}/withdraw`, { token: a.token, body: { amount: "999999", dryRun: true } });
    expect(w.status).toBe(400); // more than the vault holds is explained, not sent
    expect((await w.json()).error).toMatch(/Insufficient balance/);
    expect(await (await call(`/owner/v1/vaults/${a.id}/withdraw`, { token: a.token, body: { amount: "1", dryRun: true } })).json()).toMatchObject({ plan: { destination: "alice.near", amount: "1" } });
    expect(await (await call(`/owner/v1/vaults/${a.id}/withdraw`, { token: a.token, body: { amount: "1" } })).json()).toMatchObject({ status: "pending_approval" });
    // Another account cannot see or use this vault's withdraw route.
    const bob = await signIn(m, call, "bob.near");
    expect((await call(`/owner/v1/vaults/${a.id}/withdraw`, { token: bob.token, body: { amount: "1" } })).status).toBe(404);

    const auto = await activeVault(m, call, "carol.near", true);
    const r = await call(`/owner/v1/vaults/${auto.id}/withdraw`, { token: auto.token, body: { amount: "1" } });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/autonomous mode/);
  });
});
