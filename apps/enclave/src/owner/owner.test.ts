import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMockEnclave, MOCK_OWNER } from "../mock-enclave";
import { deriveOwnerKey, openBox } from "../../../web/src/lib/seal";
import { OwnerAuth, RpcAccessKeyChecker, type AccessKeyChecker } from "./auth";
import { base58Decode, nep413Hash, NEP413_TAG, parsePublicKey, verifyNep413 } from "./nep413";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(buf: Buffer): string {
  let n = BigInt("0x" + (buf.toString("hex") || "0"));
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)]! + out;
    n /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
function newKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { privateKey, publicKey: `ed25519:${base58Encode(Buffer.from(raw))}` };
}
const signNep413 = (k: KeyObject, m: Parameters<typeof nep413Hash>[0]) => sign(null, nep413Hash(m), k).toString("base64");

describe("NEP-413 primitives", () => {
  it("decodes base58, including leading zeros and the example key from the spec", () => {
    expect(base58Decode("2").equals(Buffer.from([1]))).toBe(true);
    expect(base58Decode("112").equals(Buffer.from([0, 0, 1]))).toBe(true);
    expect(parsePublicKey("ed25519:6TupyNrcHGTt5XRLmHTc2KGaiSbjhQi1KHtCXTgbcr4Y")).toHaveLength(32);
    expect(() => base58Decode("0OIl")).toThrow();
    expect(() => parsePublicKey("secp256k1:abc")).toThrow();
  });

  it("hashes tag ++ borsh(payload): tag 2^31+413 little-endian, strings length-prefixed, callbackUrl as an option", () => {
    expect(NEP413_TAG).toBe(2 ** 31 + 413);
    expect(NEP413_TAG.toString(16)).toBe("8000019d");
    const nonce = Buffer.alloc(32, 7);
    const manual = createHash("sha256")
      .update(Buffer.concat([Buffer.from([0x9d, 0x01, 0x00, 0x80]), Buffer.from([2, 0, 0, 0]), Buffer.from("hi"), nonce, Buffer.from([1, 0, 0, 0]), Buffer.from("r"), Buffer.from([0])]))
      .digest();
    expect(nep413Hash({ message: "hi", nonce, recipient: "r" }).equals(manual)).toBe(true);
    expect(nep413Hash({ message: "hi", nonce, recipient: "r", callbackUrl: "x" }).equals(manual)).toBe(false);
    expect(() => nep413Hash({ message: "hi", nonce: Buffer.alloc(31), recipient: "r" })).toThrow();
  });

  it("verifies a real ed25519 signature and rejects every kind of tampering", () => {
    const { privateKey, publicKey } = newKey();
    const m = { message: "Sign in", nonce: Buffer.alloc(32, 1), recipient: "norr" };
    const sig = signNep413(privateKey, m);
    expect(verifyNep413(m, publicKey, sig)).toBe(true);
    expect(verifyNep413({ ...m, message: "Sign in!" }, publicKey, sig)).toBe(false);
    expect(verifyNep413({ ...m, recipient: "evil" }, publicKey, sig)).toBe(false);
    expect(verifyNep413({ ...m, nonce: Buffer.alloc(32, 2) }, publicKey, sig)).toBe(false);
    expect(verifyNep413({ ...m, callbackUrl: "https://x" }, publicKey, sig)).toBe(false);
    expect(verifyNep413(m, newKey().publicKey, sig)).toBe(false);
    expect(verifyNep413(m, publicKey, Buffer.alloc(64).toString("base64"))).toBe(false);
    expect(verifyNep413(m, publicKey, "not base64 at all")).toBe(false);
    expect(verifyNep413(m, "ed25519:zzzz", sig)).toBe(false);
  });

  it("verifies a signature made over a payload that included a callback URL", () => {
    const { privateKey, publicKey } = newKey();
    const m = { message: "m", nonce: Buffer.alloc(32, 3), recipient: "norr", callbackUrl: "https://app.example/cb" };
    expect(verifyNep413(m, publicKey, signNep413(privateKey, m))).toBe(true);
  });
});

describe("OwnerAuth", () => {
  const owner = "alice.near";
  async function setup(keys: AccessKeyChecker = { hasKey: async (a, k) => a === owner && k === key.publicKey }, t = { now: 1_000 }) {
    const auth = new OwnerAuth({ keys, now: () => t.now });
    const c = auth.challenge();
    const msg = { message: c.message, nonce: Buffer.from(c.nonce, "base64"), recipient: c.recipient };
    return { auth, c, t, signed: { accountId: owner, publicKey: key.publicKey, signature: signNep413(key.privateKey, msg), nonce: c.nonce } };
  }
  const key = newKey();

  it("logs in with a valid signature from a key the account owns, and the session works until it expires", async () => {
    const { auth, signed, t } = await setup();
    const s = await auth.login(signed);
    expect(s?.accountId).toBe(owner);
    expect(auth.session(s!.token)?.accountId).toBe(owner);
    t.now += 13 * 3_600_000;
    expect(auth.session(s!.token)).toBeNull();
  });

  it("a challenge works once only, even after a failed attempt", async () => {
    const { auth, signed } = await setup();
    expect(await auth.login({ ...signed, signature: Buffer.alloc(64).toString("base64") })).toBeNull();
    expect(await auth.login(signed)).toBeNull(); // the failed attempt used it up
    const again = await setup();
    expect(await again.auth.login(again.signed)).not.toBeNull();
    expect(await again.auth.login(again.signed)).toBeNull(); // replay
  });

  it("rejects an expired challenge, an unknown nonce, and a key that does not belong to the account", async () => {
    const expired = await setup();
    expired.t.now += 6 * 60_000;
    expect(await expired.auth.login(expired.signed)).toBeNull();
    const unknown = await setup();
    expect(await unknown.auth.login({ ...unknown.signed, nonce: Buffer.alloc(32, 9).toString("base64") })).toBeNull();
    const wrongOwner = await setup({ hasKey: async () => false });
    expect(await wrongOwner.auth.login(wrongOwner.signed)).toBeNull();
  });

  it("a signature over a different message does not log in (a phished signature for another site)", async () => {
    const auth = new OwnerAuth({ keys: { hasKey: async () => true }, now: () => 1 });
    const c = auth.challenge();
    const other = signNep413(key.privateKey, { message: "Some other site", nonce: Buffer.from(c.nonce, "base64"), recipient: c.recipient });
    expect(await auth.login({ accountId: owner, publicKey: key.publicKey, signature: other, nonce: c.nonce })).toBeNull();
  });

  it("logout ends the session", async () => {
    const { auth, signed } = await setup();
    const s = (await auth.login(signed))!;
    auth.logout(s.token);
    expect(auth.session(s.token)).toBeNull();
  });

  it("RpcAccessKeyChecker says yes only when the chain reports a permission, and no on any error", async () => {
    const mk = (r: () => Promise<Response>) => new RpcAccessKeyChecker("http://rpc", r);
    expect(await mk(async () => new Response(JSON.stringify({ result: { permission: "FullAccess" } }))).hasKey("a", "ed25519:x")).toBe(true);
    expect(await mk(async () => new Response(JSON.stringify({ error: { cause: { name: "UNKNOWN_ACCESS_KEY" } } }))).hasKey("a", "ed25519:x")).toBe(false);
    expect(await mk(async () => { throw new Error("down"); }).hasKey("a", "ed25519:x")).toBe(false);
  });
});

describe("owner routes", () => {
  const T0 = Date.UTC(2026, 10, 3, 12);
  async function boot() {
    const clock = { t: T0 };
    const m = createMockEnclave({ now: () => clock.t });
    m.deps.sleep = async (ms) => { clock.t += ms; };
    m.deps.settle = { waitMs: 0, intervalMs: 1 };
    const req = (path: string, init: { method?: string; token?: string; body?: unknown } = {}) =>
      m.app.request(path, { method: init.method ?? (init.body !== undefined ? "POST" : "GET"), headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), "content-type": "application/json" }, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
    const loginAs = async (account: string) => {
      const k = newKey();
      const c = await (await req("/owner/v1/challenge")).json();
      const signature = signNep413(k.privateKey, { message: c.message, nonce: Buffer.from(c.nonce, "base64"), recipient: c.recipient });
      const r = await req("/owner/v1/login", { body: { accountId: account, publicKey: k.publicKey, signature, nonce: c.nonce } });
      return { status: r.status, token: r.status === 200 ? (await r.json()).token : undefined };
    };
    const owner = await loginAs(MOCK_OWNER);
    return { m, req, loginAs, token: owner.token as string, clock };
  }

  it("signs in through the HTTP API with a real wallet-style signature", async () => {
    const { req, token } = await boot();
    const me = await (await req("/owner/v1/me", { token })).json();
    expect(me).toMatchObject({ accountId: MOCK_OWNER, vaults: 1, mock: true });
  });

  it("rejects bad logins with no detail, and every route needs a session", async () => {
    const { req } = await boot();
    const bad = await req("/owner/v1/login", { body: { accountId: "x.near", publicKey: "ed25519:abc", signature: "AAAA", nonce: "AAAA" } });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: "sign-in failed" });
    expect((await req("/owner/v1/login", { body: {} })).status).toBe(401);
    for (const path of ["/owner/v1/me", "/owner/v1/vaults", "/owner/v1/audit", "/owner/v1/verify", "/owner/v1/vaults/demo"]) {
      expect((await req(path)).status).toBe(401);
      expect((await req(path, { token: "norr_owner_forged" })).status).toBe(401);
    }
  });

  it("another account signs in fine but sees none of the vaults, and gets 404 on direct access", async () => {
    const { req, loginAs } = await boot();
    const other = await loginAs("mallory.near");
    expect(other.status).toBe(200);
    expect((await (await req("/owner/v1/vaults", { token: other.token })).json()).vaults).toEqual([]);
    for (const [method, path] of [["GET", "/owner/v1/vaults/demo"], ["GET", "/owner/v1/vaults/demo/activity"], ["POST", "/owner/v1/vaults/demo/pause"], ["POST", "/owner/v1/vaults/demo/tokens"], ["DELETE", "/owner/v1/vaults/demo/tokens"], ["GET", "/owner/v1/vaults/demo/pending"]] as const) {
      expect((await req(path, { method, token: other.token })).status).toBe(404);
    }
    expect((await req("/owner/v1/vaults/demo/policy", { method: "PUT", token: other.token, body: {} })).status).toBe(404);
  });

  it("agent tokens cannot use the owner API, and owner sessions cannot use the agent API", async () => {
    const { m, req, token } = await boot();
    expect((await req("/owner/v1/vaults", { token: m.agentToken })).status).toBe(401);
    expect((await req("/v1/policy", { token })).status).toBe(401);
  });

  it("shows the vault with its rules, state and a labelled portfolio", async () => {
    const { req, token } = await boot();
    const v = await (await req("/owner/v1/vaults/demo", { token })).json();
    expect(v.policy.privacy).toBe("prefer");
    expect(v.portfolio.holdings[0]).toMatchObject({ symbol: "USDC", layer: "confidential" });
    expect(v.state).toMatchObject({ spentTodayUsd: 0, lastTradeAt: null });
  });

  it("the owner edits the rules; invalid rules and a changed vault id are refused", async () => {
    const { m, req, token } = await boot();
    const cur = (await (await req("/owner/v1/vaults/demo", { token })).json()).policy;
    const ok = await req("/owner/v1/vaults/demo/policy", { method: "PUT", token, body: { ...cur, maxTradeUsd: 20, privacy: "require" } });
    expect(ok.status).toBe(200);
    expect(m.vaults.get("demo")!.policy).toMatchObject({ maxTradeUsd: 20, privacy: "require", vaultId: "demo" });
    for (const body of [{ ...cur, maxTradeUsd: -1 }, { ...cur, privacy: "sometimes" }, { ...cur, vaultId: "other" }, { maxTradeUsd: 5 }]) {
      expect((await req("/owner/v1/vaults/demo/policy", { method: "PUT", token, body })).status).toBe(400);
    }
    expect(m.vaults.get("demo")!.policy.maxTradeUsd).toBe(20); // refused edits changed nothing
    // The new rules apply to the agent straight away.
    const d = await (await m.app.request("/v1/trade", { method: "POST", headers: { authorization: `Bearer ${m.agentToken}`, "content-type": "application/json" }, body: JSON.stringify({ side: "buy", asset: "SOL", amountUsd: 30 }) })).json();
    expect(d).toMatchObject({ status: "blocked", code: "OVER_TRADE_LIMIT" });
  });

  it("the owner confirms non-US status in the rules, which is what unlocks equities", async () => {
    const { m, req, token } = await boot();
    const cur = (await (await req("/owner/v1/vaults/demo", { token })).json()).policy;
    await req("/owner/v1/vaults/demo/policy", { method: "PUT", token, body: { ...cur, nonUsConfirmed: false } });
    const trade = async () => (await m.app.request("/v1/trade", { method: "POST", headers: { authorization: `Bearer ${m.agentToken}`, "content-type": "application/json" }, body: JSON.stringify({ side: "buy", asset: "NVDA", amountUsd: 40 }) })).json();
    expect(await trade()).toMatchObject({ code: "INELIGIBLE" });
    await req("/owner/v1/vaults/demo/policy", { method: "PUT", token, body: { ...cur, nonUsConfirmed: true } });
    expect((await trade()).status).toBe("executed");
  });

  it("pause, resume and the kill switch work and are recorded", async () => {
    const { m, req, token } = await boot();
    await req("/owner/v1/vaults/demo/pause", { token, body: {} });
    expect(m.vaults.get("demo")!.policy.paused).toBe(true);
    await req("/owner/v1/vaults/demo/resume", { token, body: {} });
    expect(m.vaults.get("demo")!.policy.paused).toBe(false);
    const all = await (await req("/owner/v1/pause-all", { token, body: {} })).json();
    expect(all.paused).toEqual(["demo"]);
    expect(m.vaults.get("demo")!.policy.paused).toBe(true);
    const audit = (await (await req("/owner/v1/audit", { token })).json()).audit.map((a: { action: string }) => a.action);
    expect(audit).toEqual(expect.arrayContaining(["signed in", "paused", "resumed", "kill switch: paused all vaults"]));
  });

  it("the agent's reasoning reaches neither the agent nor the service's responses in the clear", async () => {
    const { m, req, token } = await boot();
    await m.app.request("/v1/trade", { method: "POST", headers: { authorization: `Bearer ${m.agentToken}`, "content-type": "application/json" }, body: JSON.stringify({ side: "buy", asset: "SOL", amountUsd: 5, reason: "OWNER-ONLY-THESIS" }) });
    const owner = await (await req("/owner/v1/vaults/demo/activity", { token })).text();
    expect(owner).not.toContain("OWNER-ONLY-THESIS");
    expect(owner).toContain("sealedReason");
    const agent = await (await m.app.request("/v1/activity", { headers: { authorization: `Bearer ${m.agentToken}` } })).text();
    expect(agent).not.toContain("OWNER-ONLY-THESIS");
  });

  it("issues and revokes agent tokens", async () => {
    const { m, req, token } = await boot();
    const issued = (await (await req("/owner/v1/vaults/demo/tokens", { token, body: {} })).json()).token as string;
    expect((await m.app.request("/v1/policy", { headers: { authorization: `Bearer ${issued}` } })).status).toBe(200);
    await req("/owner/v1/vaults/demo/tokens", { method: "DELETE", token });
    expect((await m.app.request("/v1/policy", { headers: { authorization: `Bearer ${issued}` } })).status).toBe(401);
    expect((await m.app.request("/v1/policy", { headers: { authorization: `Bearer ${m.agentToken}` } })).status).toBe(401);
  });

  it("lists what Norr asked for while a swap waits, so the owner can match it to the approval screen", async () => {
    const { m, req, token } = await boot();
    const vault = m.vaults.get("demo")!;
    vault.custody = { ...vault.custody, swap: async () => ({ state: "pending_approval", requestId: "r-9", requestHash: "abc123" }), status: async () => ({ state: "pending_approval", requestId: "r-9", requestHash: "abc123" }) };
    await m.app.request("/v1/trade", { method: "POST", headers: { authorization: `Bearer ${m.agentToken}`, "content-type": "application/json" }, body: JSON.stringify({ side: "buy", asset: "NVDA", amountUsd: 40 }) });
    const { pending } = await (await req("/owner/v1/vaults/demo/pending", { token })).json();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ requestId: "r-9", requestHash: "abc123", venue: "confidential", sends: { symbol: "USDC", amount: 40 }, receivesAtLeast: { symbol: "NVDAon" } });
    expect(pending[0].check).toContain("Approve only if");
  });

  it("the overview reads today's spend and loss from the vault's own day totals, not a copy only a trade refreshes", async () => {
    const { m, req, token } = await boot();
    // Totals written outside the trade pipeline (as the live runner does), so no refresh has run in this process.
    m.vaults.reserveSpend("demo", 6, T0);
    m.vaults.recordFill("demo", { assetId: "nvda", side: "buy", qty: 0.03, usd: 6 }, T0);
    m.vaults.recordFill("demo", { assetId: "nvda", side: "sell", qty: 0.03, usd: 5.93 }, T0);
    const one = await (await req("/owner/v1/vaults/demo", { token })).json();
    expect(one.state.spentTodayUsd).toBeCloseTo(6, 6);
    expect(one.state.realizedLossTodayUsd).toBeCloseTo(0.07, 6);
    const list = await (await req("/owner/v1/vaults", { token })).json();
    expect(list.vaults[0].state.spentTodayUsd).toBeCloseTo(6, 6);
  });

  it("activity shows what each trade really moved and the realized P&L of each sell", async () => {
    const { m, req, token, clock } = await boot();
    const trade = (body: unknown) => m.app.request("/v1/trade", { method: "POST", headers: { authorization: `Bearer ${m.agentToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await (await trade({ side: "buy", asset: "SOL", amountUsd: 20, reason: "r" })).json()).status).toBe("executed");
    clock.t += 60_000;
    expect((await (await trade({ side: "sell", asset: "SOL", amountUsd: 30, reason: "r" })).json()).status).toMatch(/executed|failed/);
    const { activity } = await (await req("/owner/v1/vaults/demo/activity", { token })).json();
    const sells = activity.filter((a: { side: string; executed: unknown }) => a.side === "sell" && a.executed);
    const buy = activity.find((a: { side: string }) => a.side === "buy");
    expect(buy.executed.usd).toBeCloseTo(20, 2); // the cash that left, not a size that was asked for
    expect(buy.executed.realizedUsd).toBeNull();
    for (const s of sells) expect(s.executed.realizedUsd).not.toBeNull();
  });

  it("private reasoning: the activity API returns it sealed; enrolling a key moves it to the owner, who alone can open it", async () => {
    const { m, req, token, loginAs } = await boot();
    const trade = (body: unknown) => m.app.request("/v1/trade", { method: "POST", headers: { authorization: `Bearer ${m.agentToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    await trade({ side: "buy", asset: "SOL", amountUsd: 5, reason: "SEALED-THESIS-123" });
    const before = await (await req("/owner/v1/vaults/demo/activity", { token })).text();
    expect(before).not.toContain("SEALED-THESIS-123"); // the service does not hand out plaintext, even to the owner
    expect(JSON.parse(before).activity[0].sealedReason.k).toBe("service");

    expect(await (await req("/owner/v1/seal-key", { token })).json()).toEqual({ publicKey: null });
    const owner = await deriveOwnerKey(Uint8Array.from({ length: 64 }, (_, i) => i), MOCK_OWNER);
    const put = await (await req("/owner/v1/seal-key", { token, method: "PUT", body: { publicKey: owner.publicKey } })).json();
    expect(put).toMatchObject({ publicKey: owner.publicKey, resealed: 1 });
    expect(await (await req("/owner/v1/seal-key", { token })).json()).toEqual({ publicKey: owner.publicKey });

    const after = (await (await req("/owner/v1/vaults/demo/activity", { token })).json()).activity[0].sealedReason;
    expect(after.k).toBe("owner");
    expect(await openBox(after, owner, "demo")).toBe("SEALED-THESIS-123");

    // New entries are sealed to the owner straight away.
    await trade({ side: "buy", asset: "SOL", amountUsd: 5, reason: "SECOND-THESIS" });
    const list = (await (await req("/owner/v1/vaults/demo/activity", { token })).json()).activity;
    expect(list.map((a: { sealedReason: { k: string } }) => a.sealedReason.k)).toEqual(["owner", "owner"]);

    // Bad keys are refused; an agent token cannot enroll one; another account has its own (empty) slot.
    for (const publicKey of ["", "short", "A".repeat(44), 5]) expect((await req("/owner/v1/seal-key", { token, method: "PUT", body: { publicKey } })).status).toBe(400);
    expect((await req("/owner/v1/seal-key", { token: m.agentToken, method: "PUT", body: { publicKey: owner.publicKey } })).status).toBe(401);
    const other = await loginAs("someone-else.near");
    expect(await (await req("/owner/v1/seal-key", { token: other.token })).json()).toEqual({ publicKey: null });
  });

  it("funding: the owner gets a deposit address from the custody provider, can watch it arrive, and no one else can", async () => {
    const { m, req, token, loginAs, clock } = await boot();
    const usdc = m.deps.quoteAsset.id;
    const before = (await m.deps.vaults.get("demo")!.custody.confidentialHoldings())[usdc] ?? "0";

    const offer = await (await req("/owner/v1/vaults/demo/funding", { token, body: { amountUsdc: 8 } })).json();
    expect(offer).toMatchObject({ amountUsdc: 8, asset: { symbol: "USDC", chain: "NEAR" } });
    expect(offer.address).toMatch(/^mock/);
    expect(Date.parse(offer.expiresAt) - clock.t).toBe(30 * 60_000);

    expect(await (await req(`/owner/v1/vaults/demo/funding/${offer.id}`, { token })).json()).toMatchObject({ state: "waiting", receivedUsdc: 0 });
    m.rails.creditConfidential(usdc, "8000000");
    const arrived = await (await req(`/owner/v1/vaults/demo/funding/${offer.id}`, { token })).json();
    expect(arrived).toMatchObject({ state: "arrived", receivedUsdc: 8, reportedBy: "custody provider" });
    expect(arrived.balanceUsdc).toBeCloseTo(Number(before) / 1e6 + 8, 6);

    // Someone else's session cannot see or poll it; an agent token cannot ask for one.
    const other = await loginAs("someone-else.near");
    expect((await req(`/owner/v1/vaults/demo/funding/${offer.id}`, { token: other.token })).status).toBe(404);
    expect((await req("/owner/v1/vaults/demo/funding", { token: other.token, body: { amountUsdc: 5 } })).status).toBe(404);
    expect((await req("/owner/v1/vaults/demo/funding", { token: m.agentToken, body: { amountUsdc: 5 } })).status).toBe(401);
    expect((await m.app.request("/v1/funding", { method: "POST", headers: { authorization: `Bearer ${m.agentToken}` } })).status).toBe(404);
  });

  it("funding: expires after the window if nothing arrives, bad amounts are refused, and open requests are limited", async () => {
    const { req, token, clock } = await boot();
    for (const amountUsdc of [0, 0.5, 5000, "5", null]) expect((await req("/owner/v1/vaults/demo/funding", { token, body: { amountUsdc } })).status).toBe(400);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await (await req("/owner/v1/vaults/demo/funding", { token, body: { amountUsdc: 5 } })).json()).id);
    expect((await req("/owner/v1/vaults/demo/funding", { token, body: { amountUsdc: 5 } })).status).toBe(429);
    clock.t += 31 * 60_000;
    expect((await (await req(`/owner/v1/vaults/demo/funding/${ids[0]}`, { token })).json()).state).toBe("expired");
    expect((await req("/owner/v1/vaults/demo/funding", { token, body: { amountUsdc: 5 } })).status).toBe(200);
  });

  it("funding: when the custody policy blocks the request, the owner is told why and what to change", async () => {
    const { m, req, token } = await boot();
    m.deps.vaults.get("demo")!.custody.requestConfidentialDeposit = async () => {
      throw new Error("OutLayer confidential deposit address: Transaction type 'call' is not allowed by policy");
    };
    const r = await req("/owner/v1/vaults/demo/funding", { token, body: { amountUsdc: 5 } });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/custody policy does not allow.*"call"/);
  });

  it("funding: an address that does not look like one is never shown", async () => {
    const { m, req, token } = await boot();
    const custody = m.deps.vaults.get("demo")!.custody;
    custody.requestConfidentialDeposit = async () => ({ intentId: "i", depositAddress: "send it to <script>", amount: "5000000", minAmountOut: "5000000" });
    const r = await req("/owner/v1/vaults/demo/funding", { token, body: { amountUsdc: 5 } });
    expect(r.status).toBe(502);
    expect(await r.text()).not.toContain("script");
  });

  it("the verify screen says honestly that there is no attestation yet", async () => {
    const { req, token } = await boot();
    const v = await (await req("/owner/v1/verify", { token })).json();
    expect(v).toMatchObject({ mode: "mock", attested: false });
    // The code version is reported (a git checkout here; without .git it is honestly "unknown").
    expect(v.source === "git" ? v.commit : null).toEqual(v.source === "git" ? expect.stringMatching(/^[0-9a-f]{40}$/) : null);
    expect(typeof v.dirty).toBe("boolean");
  });
});
