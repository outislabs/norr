import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sealToOwner } from "../../../enclave/src/seal";
import { bytesBase64, deriveOwnerKey, keyFromSecret, openBox, type OwnerBox } from "./seal";

// The service seals with node:crypto; the browser opens with WebCrypto. These tests are the proof they agree.
const sig = (n: number) => Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + n) & 0xff);

describe("sealed reasoning: service seals, owner's browser opens", () => {
  it("round-trips, including unicode and long text", async () => {
    const key = await deriveOwnerKey(sig(1), "owner.near");
    const text = "Buy NVDA: earnings beat, guidance up. Né, 日本語 ✓ " + "x".repeat(5000);
    const box = sealToOwner(text, key.publicKey, "demo");
    expect(await openBox(box, key, "demo")).toBe(text);
  });

  it("the same wallet signature always gives the same key, a different signature or account a different one", async () => {
    const a = await deriveOwnerKey(sig(1), "owner.near");
    expect((await deriveOwnerKey(sig(1), "owner.near")).publicKey).toBe(a.publicKey);
    expect((await deriveOwnerKey(sig(2), "owner.near")).publicKey).not.toBe(a.publicKey);
    expect((await deriveOwnerKey(sig(1), "other.near")).publicKey).not.toBe(a.publicKey);
    expect((await keyFromSecret(a.secret)).publicKey).toBe(a.publicKey); // a cached secret restores the same key
  });

  it("ed25519 signatures are deterministic, which is what makes a signature a stable key source", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const msg = Buffer.from("fixed unlock message");
    expect(sign(null, msg, privateKey).equals(sign(null, msg, privateKey))).toBe(true);
  });

  it("only the right key opens it: not another owner, not another vault, not altered text", async () => {
    const owner = await deriveOwnerKey(sig(1), "owner.near");
    const other = await deriveOwnerKey(sig(2), "other.near");
    const box = sealToOwner("secret thesis", owner.publicKey, "demo");
    await expect(openBox(box, other, "demo")).rejects.toThrow();
    await expect(openBox(box, owner, "another-vault")).rejects.toThrow();
    const flipped = Buffer.from(box.ct, "base64");
    flipped[0]! ^= 1;
    await expect(openBox({ ...box, ct: flipped.toString("base64") } as OwnerBox, owner, "demo")).rejects.toThrow();
  });

  it("each seal uses a fresh ephemeral key and nonce, and the ciphertext does not contain the text", async () => {
    const key = await deriveOwnerKey(sig(1), "owner.near");
    const a = sealToOwner("same words", key.publicKey, "demo");
    const b = sealToOwner("same words", key.publicKey, "demo");
    expect(a.epk).not.toBe(b.epk);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
    expect(JSON.stringify(a)).not.toContain("same words");
    expect(bytesBase64(new Uint8Array(32))).toHaveLength(44);
  });

  it("the service refuses to seal to something that is not a 32-byte key", () => {
    expect(() => sealToOwner("x", Buffer.alloc(31).toString("base64"), "demo")).toThrow(/32-byte/);
  });
});
