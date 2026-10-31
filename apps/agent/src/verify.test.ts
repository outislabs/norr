import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { describe, expect, it } from "vitest";
import { bytesToHex } from "@norr/shared";
import { Attestor, recoverSigner, replayEventLog } from "./verify";

const key = secp256k1.utils.randomPrivateKey();
const address = bytesToHex(keccak_256(secp256k1.getPublicKey(key, false).subarray(1)).subarray(12));
const sign = (message: string): string => {
  const body = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const digest = keccak_256(new Uint8Array([...prefix, ...body]));
  const s = secp256k1.sign(digest, key);
  return bytesToHex(new Uint8Array([...s.toCompactRawBytes(), s.recovery + 27]));
};

const x = { model: "m/x", requestHash: "aa".repeat(32), responseHash: "bb".repeat(32) };
const goodText = `${x.model}:${x.requestHash}:${x.responseHash}`;

/** An Attestor whose hardware evidence is fixed, so the tests exercise the signature logic alone. */
class Fixed extends Attestor {
  constructor(private readonly fixed: { kind: "gateway" | "provider_tee"; algo: string; address: string }[], f: (url: string) => Promise<Response>) {
    super({ apiKey: "k", fetch: (url) => f(url) });
  }
  override async preflight() {
    return { signers: this.fixed, checks: [] };
  }
}
const reply = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });
const sigBody = (over: Record<string, unknown> = {}) => ({ text: goodText, signature: sign(goodText), signing_address: `0x${address}`, signing_algo: "ecdsa", signature_kind: "provider_tee", ...over });
const vouched = [{ kind: "provider_tee" as const, algo: "ecdsa", address }];

describe("recoverSigner", () => {
  it("recovers the address that signed (EIP-191), with v as 27/28 or 0/1", () => {
    expect(recoverSigner("hello", sign("hello"))).toBe(address);
    const raw = sign("hello");
    expect(recoverSigner("hello", raw.slice(0, 128) + (raw.endsWith("1b") ? "00" : "01"))).toBe(address);
  });
  it("recovers a different address for a different message", () => {
    expect(recoverSigner("other", sign("hello"))).not.toBe(address);
  });
});

describe("replayEventLog", () => {
  it("rejects an event whose own digest is wrong", () => {
    const bad = [{ imr: 3, event_type: 1, event: "e", event_payload: "00", digest: "00".repeat(48) }];
    expect(() => replayEventLog(JSON.stringify(bad))).toThrow(/digest mismatch/);
  });
  it("replays a consistent log", () => {
    const d = createHash("sha384").update(Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.from(":e:"), Buffer.from("00", "hex")])).digest();
    const log = [{ imr: 3, event_type: 1, event: "e", event_payload: "00", digest: d.toString("hex") }];
    expect(replayEventLog(JSON.stringify(log))).toBe(createHash("sha384").update(Buffer.concat([Buffer.alloc(48), d])).digest("hex"));
  });
});

describe("Attestor.verifyCompletion", () => {
  it("attests a valid signature from a vouched signer", async () => {
    const v = await new Fixed(vouched, reply(sigBody())).verifyCompletion("id", x);
    expect(v.status).toBe("attested");
  });
  it("is unverified when the signed text is not our bytes", async () => {
    const v = await new Fixed(vouched, reply(sigBody({ text: `${x.model}:${"cc".repeat(32)}:${x.responseHash}` }))).verifyCompletion("id", x);
    expect(v.status).toBe("unverified");
    expect(v.checks.at(-1)?.detail).toMatch(/exact request and response/);
  });
  it("is unverified when the signature does not recover to the stated signer", async () => {
    const other = bytesToHex(new Uint8Array(20).fill(7));
    const v = await new Fixed(vouched, reply(sigBody({ signing_address: `0x${other}` }))).verifyCompletion("id", x);
    expect(v.status).toBe("unverified");
  });
  it("is unverified when no verified report carries the signer", async () => {
    const v = await new Fixed([], reply(sigBody())).verifyCompletion("id", x);
    expect(v.status).toBe("unverified");
    expect(v.checks.at(-1)?.id).toBe("signer");
  });
  it("does not accept a gateway-vouched key for a provider_tee signature", async () => {
    const v = await new Fixed([{ kind: "gateway", algo: "ecdsa", address }], reply(sigBody())).verifyCompletion("id", x);
    expect(v.status).toBe("unverified");
  });
  it("uses the two-hash text for gateway signatures", async () => {
    const t = `${x.requestHash}:${x.responseHash}`;
    const v = await new Fixed([{ kind: "gateway", algo: "ecdsa", address }], reply(sigBody({ text: t, signature: sign(t), signature_kind: "gateway" }))).verifyCompletion("id", x);
    expect(v.status).toBe("attested");
  });
  it("is unverified for an unknown signature kind, an error body, or a 500", async () => {
    expect((await new Fixed(vouched, reply(sigBody({ signature_kind: "mystery" }))).verifyCompletion("id", x)).status).toBe("unverified");
    expect((await new Fixed(vouched, reply({ error_code: 1, message: "gone" })).verifyCompletion("id", x)).status).toBe("unverified");
    expect((await new Fixed(vouched, reply({}, 500)).verifyCompletion("id", x)).status).toBe("unverified");
  });
});
