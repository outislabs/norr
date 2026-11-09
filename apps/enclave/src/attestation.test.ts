import { checkAttestation, allPass } from "@norr/shared";
import { describe, expect, it } from "vitest";
import { fixture } from "../../../packages/shared/src/attestation.fixture";
import { DATA_KEY_PATH, keyFingerprint, rateLimiter, type Attestor } from "./attestation";
import { createMockEnclave } from "./mock-enclave";

const NONCE = "11".repeat(32);
/** A stand-in TEE: it answers like dstack would, with evidence built to the documented layout. */
const fakeTee = (calls: string[] = []): Attestor => ({
  async evidence(nonce) {
    calls.push(nonce);
    return fixture({ nonce }).evidence;
  },
  async info() {
    return { ...fixture().info, appId: "app1", instanceId: "inst1", composeHash: "ch" };
  },
});

describe("public attestation endpoints", () => {
  it("say plainly that there is no TEE when there is none", async () => {
    const m = createMockEnclave();
    for (const path of [`/attestation?nonce=${NONCE}`, "/info"]) {
      const r = await m.app.request(path);
      expect(r.status).toBe(503);
      expect(await r.json()).toMatchObject({ attested: false, error: expect.stringContaining("not running in a TEE") });
    }
  });

  it("return evidence for the caller's nonce, which the shared checks accept end to end", async () => {
    const calls: string[] = [];
    const m = createMockEnclave({ attestor: fakeTee(calls) });
    const ev = await (await m.app.request(`/attestation?nonce=${NONCE.toUpperCase()}`)).json();
    const info = await (await m.app.request("/info")).json();
    expect(calls).toEqual([NONCE]); // lower-cased before it reaches the TEE
    expect(ev).toMatchObject({ attested: true, nonce: NONCE });
    expect(info).toMatchObject({ attested: true, appId: "app1" });
    expect(allPass(await checkAttestation(NONCE, ev, info))).toBe(true);
    expect(allPass(await checkAttestation("22".repeat(32), ev, info))).toBe(false); // a different request cannot reuse it
  });

  it("answer any origin (they hold nothing secret) but only for GET", async () => {
    const m = createMockEnclave({ attestor: fakeTee() });
    const r = await m.app.request("/info", { headers: { origin: "https://anyone.example" } });
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    const pre = await m.app.request("/attestation", { method: "OPTIONS", headers: { origin: "https://x.example", "access-control-request-method": "POST" } });
    expect(pre.headers.get("access-control-allow-methods") ?? "").not.toContain("POST");
  });

  it("refuse a bad nonce before touching the TEE", async () => {
    const calls: string[] = [];
    const m = createMockEnclave({ attestor: fakeTee(calls) });
    for (const nonce of ["", "abc", "zz", "11".repeat(65), "not hex"]) expect((await m.app.request(`/attestation?nonce=${encodeURIComponent(nonce)}`)).status).toBe(400);
    expect((await m.app.request("/attestation")).status).toBe(400);
    expect(calls).toEqual([]);
    expect((await m.app.request(`/attestation?nonce=${"11".repeat(64)}`)).status).toBe(200); // 64 bytes is the limit
  }, 20_000); // builds a whole mock service: slow while the full suite runs in parallel

  it("rate-limit quotes for everyone together", async () => {
    const m = createMockEnclave({ attestor: fakeTee() });
    let last = 200;
    for (let i = 0; i < 25; i++) last = (await m.app.request(`/attestation?nonce=${NONCE}`)).status;
    expect(last).toBe(429);
  });

  it("do not pass TEE error details on", async () => {
    const broken: Attestor = { evidence: async () => { throw new Error("socket /var/run/dstack.sock refused"); }, info: async () => { throw new Error("internal detail"); } };
    const m = createMockEnclave({ attestor: broken });
    for (const path of [`/attestation?nonce=${NONCE}`, "/info"]) {
      const r = await m.app.request(path);
      expect(r.status).toBe(502);
      expect(await r.text()).not.toMatch(/socket|internal detail/);
    }
  });
});

describe("rateLimiter", () => {
  it("allows the limit within a window and recovers after it", () => {
    let t = 0;
    const ok = rateLimiter(2, 1000, () => t);
    expect([ok(), ok(), ok()]).toEqual([true, true, false]);
    t = 1001;
    expect(ok()).toBe(true);
  });
});


describe("the enclave-derived data key, step 1: only a fingerprint is reported (docs/OPERATOR-PRIVACY.md)", () => {
  const key = (b: number) => Uint8Array.from({ length: 32 }, () => b);

  it("a fingerprint is a short one-way hash with a fixed label: stable for a key, different for another, and not the key or its plain hash", () => {
    const f = keyFingerprint(key(7));
    expect(f).toMatch(/^[0-9a-f]{16}$/);
    expect(keyFingerprint(key(7))).toBe(f);
    expect(keyFingerprint(key(8))).not.toBe(f);
    expect(f).not.toBe(Buffer.from(key(7)).toString("hex").slice(0, 16));
    expect(f).not.toBe(require("node:crypto").createHash("sha256").update(key(7)).digest("hex").slice(0, 16)); // the label separates it from a plain hash
  });

  it("/info carries the derivation path and the fingerprint, the same on every call and after a restart with the same key", async () => {
    let derived = 0;
    const tee = (k: Uint8Array): Attestor => ({ ...fakeTee(), async keyFingerprint(path) { derived++; expect(path).toBe(DATA_KEY_PATH); return keyFingerprint(k); } });
    const boot1 = createMockEnclave({ attestor: tee(key(7)) });
    const a = await (await boot1.app.request("/info")).json();
    const b = await (await boot1.app.request("/info")).json();
    expect(a.dataKey).toEqual({ path: "norr/data-key/v1", fingerprint: keyFingerprint(key(7)) });
    expect(b.dataKey).toEqual(a.dataKey);
    expect(derived).toBe(1); // derived once per process, not on every public request
    // A restart or a code update on the same app: a new process derives the same key, so the same fingerprint.
    expect((await (await createMockEnclave({ attestor: tee(key(7)) }).app.request("/info")).json()).dataKey.fingerprint).toBe(a.dataKey.fingerprint);
    // A different app would derive a different key, and the fingerprint would show it before any data depended on it.
    expect((await (await createMockEnclave({ attestor: tee(key(9)) }).app.request("/info")).json()).dataKey.fingerprint).not.toBe(a.dataKey.fingerprint);
  });

  it("if the enclave cannot derive the key, /info still answers, with a null fingerprint and a plain note, and nothing about the error", async () => {
    const failing: Attestor = { ...fakeTee(), async keyFingerprint() { throw new Error("socket exploded: secret detail"); } };
    const r = await createMockEnclave({ attestor: failing }).app.request("/info");
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.dataKey).toEqual({ path: "norr/data-key/v1", fingerprint: null, note: "The TEE did not derive the key." });
    expect(JSON.stringify(body)).not.toContain("secret detail");
    // An attestor with no key derivation says so.
    expect((await (await createMockEnclave({ attestor: fakeTee() }).app.request("/info")).json()).dataKey).toMatchObject({ fingerprint: null, note: "This attestor cannot derive keys." });
  });
});
