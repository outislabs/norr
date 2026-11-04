/** Test helpers: an ed25519 NEAR key and a NEP-413 signature, as a NEAR wallet makes them. Used by tests only. */
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { nep413Hash } from "./nep413";

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

export function newKey(): { privateKey: KeyObject; publicKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { privateKey, publicKey: `ed25519:${base58Encode(Buffer.from(raw))}` };
}

export const signNep413 = (k: KeyObject, m: Parameters<typeof nep413Hash>[0]): string => sign(null, nep413Hash(m), k).toString("base64");
