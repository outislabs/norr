import { bytesToBase64 } from "./nep413";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 (the NEAR key and signature text encoding) to bytes. Throws on a character outside the alphabet. */
export function base58Decode(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const ch of text) {
    let carry = ALPHABET.indexOf(ch);
    if (carry < 0) throw new Error("not base58");
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of text) {
    if (ch !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

/**
 * Wallets return the NEP-413 signature as text, and NEAR Connect does not say which text. The service wants standard
 * base64 of the 64 signature bytes, so accept the three forms in use (base64, URL-safe base64, `ed25519:<base58>`) and
 * hand back base64. Anything that is not 64 bytes is refused here, with a message that names the problem, rather than
 * as a bare "invalid signature" from the service.
 */
export function normalizeSignature(signature: string): string {
  const s = signature.trim();
  let bytes: Uint8Array;
  try {
    if (s.startsWith("ed25519:")) bytes = base58Decode(s.slice("ed25519:".length));
    else {
      const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
      const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
      bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    }
  } catch {
    throw new Error("The wallet returned a signature in a format Norr does not recognise.");
  }
  if (bytes.length !== 64) throw new Error(`The wallet returned a signature of ${bytes.length} bytes; an ed25519 signature is 64.`);
  return bytesToBase64(bytes);
}
