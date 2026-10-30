/**
 * Opening the agent's sealed reasoning in the browser. The format matches apps/enclave/src/seal.ts:
 *
 *   owner box = { v: 1, k: "owner", epk, iv, ct }
 *   key       = HKDF-SHA256(ikm = X25519(ownerPrivate, epk), salt = epk || ownerPublic, info = "norr-seal-v1")
 *   plaintext = AES-256-GCM(key, iv, ct, aad = vault id)
 *
 * The owner's X25519 key is derived from a wallet signature over a fixed message, so it is the same every
 * time with the same wallet key (ed25519 signatures are deterministic) and never leaves the browser; only
 * its public half is sent to the service. WebCrypto only: no extra libraries.
 */
export const SEAL_INFO = "norr-seal-v1";
export const UNLOCK_RECIPIENT = "norr-seal";
export const UNLOCK_MESSAGE = "Norr: unlock my private activity reasoning.\nThis only derives a key in your browser. It does not move funds or give Norr any access to them.";
/** A fixed nonce on purpose: the signature must come out the same every time. */
export const UNLOCK_NONCE = new Uint8Array(32).fill(0x4e);

export interface OwnerBox { v: 1; k: "owner"; epk: string; iv: string; ct: string }
export interface ServiceBox { v: 1; k: "service"; iv: string; ct: string }
export type SealedReason = OwnerBox | ServiceBox;

export interface OwnerKey {
  /** 32 raw bytes of the X25519 private key, base64. Kept for the tab's session only. */
  secret: string;
  /** The X25519 public key, base64 (what the service seals to). */
  publicKey: string;
  privateKey: CryptoKey;
}

const enc = new TextEncoder();
/** TypeScript's DOM typing rejects plain Uint8Array for BufferSource; the values are ordinary byte arrays. */
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;
const subtle = () => globalThis.crypto.subtle;
const toB64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64urlToB64 = (s: string): string => s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
const PKCS8_X25519_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]);

/** Build the X25519 key pair from a 32-byte secret. */
export async function keyFromSecret(secretB64: string): Promise<OwnerKey> {
  const secret = fromB64(secretB64);
  if (secret.length !== 32) throw new Error("The unlock key is damaged.");
  const pkcs8 = new Uint8Array([...PKCS8_X25519_PREFIX, ...secret]);
  const extractable = await subtle().importKey("pkcs8", bs(pkcs8), { name: "X25519" }, true, ["deriveBits"]);
  const jwk = await subtle().exportKey("jwk", extractable);
  if (!jwk.x) throw new Error("Could not derive the public key.");
  const privateKey = await subtle().importKey("pkcs8", bs(pkcs8), { name: "X25519" }, false, ["deriveBits"]);
  return { secret: secretB64, publicKey: b64urlToB64(jwk.x), privateKey };
}

/** The owner's key from the wallet's signature over UNLOCK_MESSAGE (64 bytes for ed25519). */
export async function deriveOwnerKey(signature: Uint8Array, account: string): Promise<OwnerKey> {
  const ikm = await subtle().importKey("raw", bs(signature), "HKDF", false, ["deriveBits"]);
  const secret = new Uint8Array(await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: bs(enc.encode("norr-owner-key-v1")), info: bs(enc.encode(account)) }, ikm, 256));
  return keyFromSecret(toB64(secret));
}

/** Open an owner box. Throws if it was sealed to a different key, for a different vault, or has been altered. */
export async function openBox(box: OwnerBox, key: OwnerKey, vaultId: string): Promise<string> {
  const epk = fromB64(box.epk);
  const ephemeral = await subtle().importKey("raw", bs(epk), { name: "X25519" }, false, []);
  const shared = await subtle().deriveBits({ name: "X25519", public: ephemeral }, key.privateKey, 256);
  const hkdf = await subtle().importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const aes = await subtle().deriveKey({ name: "HKDF", hash: "SHA-256", salt: bs(new Uint8Array([...epk, ...fromB64(key.publicKey)])), info: bs(enc.encode(SEAL_INFO)) }, hkdf, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const plain = await subtle().decrypt({ name: "AES-GCM", iv: bs(fromB64(box.iv)), additionalData: bs(enc.encode(vaultId)) }, aes, bs(fromB64(box.ct)));
  return new TextDecoder().decode(plain);
}

export { fromB64 as base64Bytes, toB64 as bytesBase64 };
