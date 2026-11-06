import { checkAttestation, allPass } from "@norr/shared";
import { describe, expect, it } from "vitest";
import { fixture } from "../../../packages/shared/src/attestation.fixture";
import { rateLimiter, type Attestor } from "./attestation";
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
