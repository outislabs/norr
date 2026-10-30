import { createHash, createPublicKey, verify } from "node:crypto";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 (Bitcoin alphabet) decode, as used in NEAR public keys. Throws on an invalid character. */
export function base58Decode(s: string): Buffer {
  let n = 0n;
  for (const ch of s) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("invalid base58 character");
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

/** NEAR "ed25519:<base58>" to the raw 32-byte key. */
export function parsePublicKey(key: string): Buffer {
  const m = /^ed25519:(.+)$/.exec(key);
  if (!m?.[1]) throw new Error("only ed25519 keys are supported");
  const raw = base58Decode(m[1]);
  if (raw.length !== 32) throw new Error("ed25519 key must be 32 bytes");
  return raw;
}

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const borshString = (s: string) => {
  const body = Buffer.from(s, "utf8");
  return Buffer.concat([u32(body.length), body]);
};

/** NEP-413 tag: 2^31 + 413. */
export const NEP413_TAG = 2147484061;

export interface Nep413Message {
  message: string;
  /** 32 bytes. */
  nonce: Buffer;
  recipient: string;
  callbackUrl?: string;
}

/** sha256( borsh(u32 tag) ++ borsh(Payload{message, nonce, recipient, callbackUrl?}) ), the bytes a wallet signs. */
export function nep413Hash(m: Nep413Message): Buffer {
  if (m.nonce.length !== 32) throw new Error("nonce must be 32 bytes");
  const payload = Buffer.concat([
    borshString(m.message),
    m.nonce,
    borshString(m.recipient),
    m.callbackUrl === undefined ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), borshString(m.callbackUrl)]),
  ]);
  return createHash("sha256").update(Buffer.concat([u32(NEP413_TAG), payload])).digest();
}

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** True only if `signature` (base64) is a valid ed25519 signature by `publicKey` over the NEP-413 hash of `m`. Never throws. */
export function verifyNep413(m: Nep413Message, publicKey: string, signature: string): boolean {
  try {
    const sig = Buffer.from(signature, "base64");
    if (sig.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, parsePublicKey(publicKey)]), format: "der", type: "spki" });
    return verify(null, nep413Hash(m), key, sig);
  } catch {
    return false;
  }
}
