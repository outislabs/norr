/**
 * NEP-413 message signing in the browser, used for the mock-mode demo owner (a wallet does this itself
 * in the real flow). Must produce byte-for-byte the same hash the server verifies; a test cross-checks
 * it against the server's implementation.
 */

const te = new TextEncoder();
export const NEP413_TAG = 2147484061; // 2^31 + 413

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const u32le = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const borshString = (s: string): Uint8Array => {
  const body = te.encode(s);
  return concat(u32le(body.length), body);
};

export interface Nep413Message {
  message: string;
  nonce: Uint8Array; // 32 bytes
  recipient: string;
  callbackUrl?: string;
}

/** sha256( borsh(u32 tag) ++ borsh(Payload) ): the bytes that get signed. */
export async function nep413Hash(m: Nep413Message): Promise<Uint8Array> {
  if (m.nonce.length !== 32) throw new Error("nonce must be 32 bytes");
  const payload = concat(borshString(m.message), m.nonce, borshString(m.recipient), m.callbackUrl === undefined ? new Uint8Array([0]) : concat(new Uint8Array([1]), borshString(m.callbackUrl)));
  return new Uint8Array(await crypto.subtle.digest("SHA-256", concat(u32le(NEP413_TAG), payload) as unknown as BufferSource));
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)]! + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export const base64ToBytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
export const bytesToBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

export interface DemoKey {
  /** "ed25519:<base58>" */
  publicKey: string;
  /** Signs a NEP-413 message and returns the base64 signature. */
  sign(m: Nep413Message): Promise<string>;
}

/** A throwaway ed25519 key held only in memory. For mock mode, never for real funds. */
export async function generateDemoKey(): Promise<DemoKey> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" } as unknown as AlgorithmIdentifier, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    publicKey: `ed25519:${base58Encode(raw)}`,
    async sign(m) {
      const sig = await crypto.subtle.sign({ name: "Ed25519" } as unknown as AlgorithmIdentifier, pair.privateKey, (await nep413Hash(m)) as unknown as BufferSource);
      return bytesToBase64(new Uint8Array(sig));
    },
  };
}
