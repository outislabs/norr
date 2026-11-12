import { describe, expect, it } from "vitest";
import { base58Encode, bytesToBase64 } from "./nep413";
import { base58Decode, normalizeSignature } from "./signature";

const sig = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 0xff);

describe("wallet signatures come back in whichever text the wallet chose; the service takes standard base64 of 64 bytes", () => {
  it("accepts base64, URL-safe base64 and ed25519:<base58>, and returns the same standard base64", () => {
    const std = bytesToBase64(sig);
    expect(normalizeSignature(std)).toBe(std);
    expect(normalizeSignature(std.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""))).toBe(std);
    expect(normalizeSignature(`ed25519:${base58Encode(sig)}`)).toBe(std);
    expect(normalizeSignature(`  ${std}\n`)).toBe(std);
  });

  it("covers signatures with leading zero bytes (base58 keeps them as '1')", () => {
    const z = Uint8Array.from({ length: 64 }, (_, i) => (i < 3 ? 0 : i + 1));
    expect(normalizeSignature(`ed25519:${base58Encode(z)}`)).toBe(bytesToBase64(z));
  });

  it("refuses anything that is not 64 bytes, naming what it got", () => {
    expect(() => normalizeSignature(bytesToBase64(sig.slice(0, 63)))).toThrow("a signature of 63 bytes; an ed25519 signature is 64");
    expect(() => normalizeSignature(`ed25519:${base58Encode(new Uint8Array(65).fill(9))}`)).toThrow(/65 bytes/);
  });

  it("refuses text that is neither format", () => {
    for (const bad of ["ed25519:0OIl", "not a signature!", "ed25519:"]) expect(() => normalizeSignature(bad)).toThrow(/format Norr does not recognise|bytes/);
  });

  it("base58Decode round-trips, including empty and zero-only input", () => {
    for (const bytes of [[], [0], [0, 0, 1], [255, 255], Array.from({ length: 33 }, (_, i) => (i * 7) % 256)]) expect(Array.from(base58Decode(base58Encode(Uint8Array.from(bytes))))).toEqual(bytes);
  });
});
